import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  PROJECT_CHECKPOINT_VERSION,
  cloneProjectCheckpointV3,
  isProjectCheckpointV3,
  type ProjectCheckpointV3,
} from '../types/runtime-checkpoint.js';
import { adaptLegacyCheckpoint } from './legacy-checkpoint-adapter.js';

export interface ProjectCheckpointStoreOptions {
  sessionDir: string;
  sessionId?: string;
  projectId?: string;
}

export interface ProjectCheckpointSaveOptions {
  /** Monotonic caller generation. An older generation is rejected before touching disk. */
  generation?: number;
}

export interface ProjectCheckpointSaveResult {
  checkpoint: ProjectCheckpointV3;
  generation: number;
  hash: string;
}

export class StaleCheckpointWriteError extends Error {
  readonly code = 'STALE_CHECKPOINT_WRITE';

  constructor(readonly generation: number, readonly currentGeneration: number) {
    super(`Stale checkpoint generation ${generation}; current generation is ${currentGeneration}`);
    this.name = 'StaleCheckpointWriteError';
  }
}

interface SessionWriteState {
  tail: Promise<void>;
  generation: number;
  latest: ProjectCheckpointV3 | null;
  persistBlocked: boolean;
}

export interface ProjectCheckpointRestoreOptions extends ProjectCheckpointSaveOptions {
  intentMessageId?: string;
}

const writeStates = new Map<string, SessionWriteState>();

function writeStateKey(sessionDir: string, sessionId: string): string {
  return path.resolve(path.join(sessionDir, `${sessionId}.checkpoint.json`)).toLowerCase();
}

/** 会话删除后释放进程内缓存的最新 checkpoint（含完整对话/工作区快照）；排队中的写入完成后再移除。 */
export function releaseProjectCheckpointWriteState(sessionDir: string, sessionId: string): void {
  const key = writeStateKey(sessionDir, sessionId);
  const state = writeStates.get(key);
  if (!state) return;
  const drain = (): void => {
    const tail = state.tail;
    void tail.then(() => {
      if (state.tail !== tail) return drain();
      if (writeStates.get(key) === state) writeStates.delete(key);
    });
  };
  drain();
}

export function hasProjectCheckpointWriteState(sessionDir: string, sessionId: string): boolean {
  return writeStates.has(writeStateKey(sessionDir, sessionId));
}

/**
 * The only durable writer for an active session checkpoint. Every save replaces the complete
 * aggregate; no state is merged from the current file.
 */
export class ProjectCheckpointStore {
  readonly checkpointPath: string;
  readonly legacyBackupPath: string;
  readonly recoveryDisplacedPath: string;
  readonly recoveryMarkerPath: string;
  readonly lockPath: string;
  readonly sessionId: string;
  readonly projectId: string;
  private readonly writeState: SessionWriteState;

  constructor(options: ProjectCheckpointStoreOptions) {
    this.sessionId = options.sessionId ?? 'default';
    this.projectId = options.projectId ?? path.resolve(options.sessionDir);
    this.checkpointPath = path.join(options.sessionDir, `${this.sessionId}.checkpoint.json`);
    this.legacyBackupPath = `${this.checkpointPath}.legacy.backup.json`;
    this.recoveryDisplacedPath = `${this.checkpointPath}.replace`;
    this.recoveryMarkerPath = `${this.checkpointPath}.replace.json`;
    this.lockPath = `${this.checkpointPath}.lock`;
    const key = writeStateKey(options.sessionDir, this.sessionId);
    let state = writeStates.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), generation: 0, latest: null, persistBlocked: false };
      writeStates.set(key, state);
    }
    this.writeState = state;
  }

  async load(): Promise<ProjectCheckpointV3 | null> {
    return this.enqueue(async () => {
      try {
        await fs.access(path.dirname(this.checkpointPath));
      } catch {
        return null;
      }
      return this.withFileLock(async () => {
        await this.recoverInterruptedReplace();
        let raw: string;
        try {
          raw = await fs.readFile(this.checkpointPath, 'utf-8');
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) {
            console.warn(`[checkpoint] 读取 ${this.checkpointPath} 失败:`, errorMessage(error));
          }
          return null;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          await this.quarantineUnreadable('corrupt JSON', error);
          return null;
        }
        if (isProjectCheckpointV3(parsed)) {
          const checkpoint = cloneProjectCheckpointV3(parsed);
          this.writeState.latest = cloneProjectCheckpointV3(checkpoint);
          this.writeState.generation = checkpoint.snapshotMeta.sequence ?? 0;
          return checkpoint;
        }
        // A native v3 file that fails the strict validator must not be
        // empty-adapted; callers would then persist a blank stand-in.
        if (isRecord(parsed) && parsed.version === PROJECT_CHECKPOINT_VERSION) {
          await this.quarantineUnreadable('v3 schema validation failed');
          return null;
        }
        let checkpoint: ProjectCheckpointV3;
        try {
          checkpoint = adaptLegacyCheckpoint(parsed, {
            projectId: this.projectId,
            sessionId: this.sessionId,
          });
        } catch (error) {
          await this.quarantineUnreadable('legacy adaptation failed', error);
          return null;
        }
        this.writeState.latest = cloneProjectCheckpointV3(checkpoint);
        this.writeState.generation = checkpoint.snapshotMeta.sequence ?? 0;
        return checkpoint;
      });
    });
  }

  async save(
    checkpoint: ProjectCheckpointV3,
    options: ProjectCheckpointSaveOptions = {},
  ): Promise<ProjectCheckpointSaveResult> {
    return this.persist(checkpoint, options, false);
  }

  /** Skip durable writes while a tool batch is still executing. */
  setPersistBlocked(blocked: boolean): void {
    this.writeState.persistBlocked = blocked;
  }

  isPersistBlocked(): boolean {
    return this.writeState.persistBlocked;
  }

  private async persist(
    checkpoint: ProjectCheckpointV3,
    options: ProjectCheckpointSaveOptions,
    restoreOverride: boolean,
  ): Promise<ProjectCheckpointSaveResult> {
    const requestedGeneration = options.generation;
    if (
      requestedGeneration !== undefined
      && (!Number.isSafeInteger(requestedGeneration) || requestedGeneration < 0)
    ) {
      throw new TypeError('Checkpoint generation must be a non-negative safe integer');
    }

    const snapshot = cloneProjectCheckpointV3(checkpoint);
    const expectedParent = snapshot.snapshotMeta.sequence ?? 0;
    if (snapshot.identity.sessionId !== this.sessionId) {
      throw new TypeError(`Checkpoint sessionId ${snapshot.identity.sessionId} does not match ${this.sessionId}`);
    }

    return this.enqueue(async () => {
      if (this.writeState.persistBlocked && !restoreOverride) {
        return {
          checkpoint: cloneProjectCheckpointV3(snapshot),
          generation: this.writeState.generation,
          hash: sha256(`${JSON.stringify(snapshot)}\n`),
        };
      }
      await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });
      return this.withFileLock(async () => {
        await this.recoverInterruptedReplace();
        const durable = await this.readDurableV3();
        const durableGeneration = durable?.snapshotMeta.sequence ?? 0;
        this.writeState.generation = durableGeneration;
        this.writeState.latest = durable ? cloneProjectCheckpointV3(durable) : null;

        const generation = requestedGeneration ?? durableGeneration + 1;
        if (requestedGeneration !== undefined) {
          if (generation <= durableGeneration) {
            throw new StaleCheckpointWriteError(generation, durableGeneration);
          }
        } else if (!restoreOverride && expectedParent !== durableGeneration) {
          throw new StaleCheckpointWriteError(expectedParent, durableGeneration);
        }

        snapshot.snapshotMeta.parentGeneration = durableGeneration;
        snapshot.snapshotMeta.sequence = generation;
        await this.backupLegacyOnce();
        const hash = await this.recoverableReplace(snapshot);
        this.writeState.generation = generation;
        this.writeState.latest = cloneProjectCheckpointV3(snapshot);
        return { checkpoint: cloneProjectCheckpointV3(snapshot), generation, hash };
      });
    });
  }

  latest(): ProjectCheckpointV3 | null {
    return this.writeState.latest ? cloneProjectCheckpointV3(this.writeState.latest) : null;
  }

  async hasDurableFile(): Promise<boolean> {
    return pathExists(this.checkpointPath);
  }

  /**
   * 删除活动 checkpoint 文件并清空进程内缓存。排在已入队写入之后执行，
   * 否则缓存里的旧 aggregate 会在下一次 save 时被写回。
   */
  async clear(): Promise<void> {
    await this.enqueue(async () => {
      this.discardCachedLatest();
      try {
        await fs.access(path.dirname(this.checkpointPath));
      } catch {
        return;
      }
      await this.withFileLock(async () => {
        await fs.unlink(this.checkpointPath).catch(() => undefined);
      });
    });
  }

  /** Transaction rollback hook when the active checkpoint did not exist before restore. */
  discardCachedLatest(): void {
    this.writeState.latest = null;
    this.writeState.generation = 0;
  }

  async restore(
    checkpoint: ProjectCheckpointV3,
    options: ProjectCheckpointRestoreOptions = {},
  ): Promise<ProjectCheckpointSaveResult> {
    const snapshot = cloneProjectCheckpointV3(checkpoint);
    snapshot.identity.sessionId = this.sessionId;
    snapshot.identity.projectId = this.projectId;
    if (options.intentMessageId) {
      snapshot.extensions = {
        ...snapshot.extensions,
        restoredFromIntentMessageId: options.intentMessageId,
      };
    }
    return this.persist(snapshot, options, true);
  }

  async restoreFromIntent(
    archive: unknown,
    options: ProjectCheckpointSaveOptions = {},
  ): Promise<ProjectCheckpointSaveResult> {
    const record = archive !== null && typeof archive === 'object'
      ? archive as Record<string, unknown>
      : {};
    const candidate = record.projectCheckpoint;
    const checkpoint = isProjectCheckpointV3(candidate)
      ? cloneProjectCheckpointV3(candidate)
      : adaptLegacyCheckpoint(archive, {
        projectId: this.projectId,
        sessionId: this.sessionId,
      });
    const intentMessageId = typeof record.messageId === 'string' && record.messageId.length > 0
      ? record.messageId
      : undefined;
    return this.restore(checkpoint, { ...options, intentMessageId });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeState.tail.then(operation, operation);
    this.writeState.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async backupLegacyOnce(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.checkpointPath, 'utf-8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.backupUnreadableBeforeReplace('corrupt JSON');
      return;
    }
    if (isProjectCheckpointV3(parsed)) return;
    if (isRecord(parsed) && parsed.version === PROJECT_CHECKPOINT_VERSION) {
      await this.backupUnreadableBeforeReplace('v3 schema validation failed');
      return;
    }
    await this.copyLegacyBackupOnce();
  }

  /** legacy backup 只保留第一份；之后的坏文件各留一份 `.corrupt.<ts>`，不能被直接覆盖掉。 */
  private async backupUnreadableBeforeReplace(reason: string): Promise<void> {
    let target = this.legacyBackupPath;
    if (!await this.copyLegacyBackupOnce()) {
      target = this.corruptCopyPath();
      await fs.copyFile(this.checkpointPath, target, constants.COPYFILE_EXCL);
    }
    console.warn(`[checkpoint] ${this.checkpointPath} 不可读（${reason}），覆盖前已另存为 ${target}`);
  }

  /** load 遇到不可读文件时移走原文件，调用方按「无 checkpoint」继续，原内容留在 `.corrupt.<ts>`。 */
  private async quarantineUnreadable(reason: string, error?: unknown): Promise<void> {
    const target = this.corruptCopyPath();
    const detail = error === undefined ? reason : `${reason}: ${errorMessage(error)}`;
    try {
      await fs.rename(this.checkpointPath, target);
      console.warn(`[checkpoint] ${this.checkpointPath} 不可读（${detail}），已移至 ${target}`);
    } catch (renameError) {
      console.warn(
        `[checkpoint] ${this.checkpointPath} 不可读（${detail}），且无法移走:`,
        errorMessage(renameError),
      );
    }
  }

  private corruptCopyPath(): string {
    return `${this.checkpointPath}.corrupt.${Date.now()}`;
  }

  private async copyLegacyBackupOnce(): Promise<boolean> {
    try {
      await fs.copyFile(this.checkpointPath, this.legacyBackupPath, constants.COPYFILE_EXCL);
      return true;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      return false;
    }
  }

  private async readDurableV3(): Promise<ProjectCheckpointV3 | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.checkpointPath, 'utf-8'));
      return isProjectCheckpointV3(parsed) ? cloneProjectCheckpointV3(parsed) : null;
    } catch {
      return null;
    }
  }

  private async recoverInterruptedReplace(): Promise<void> {
    const mainExists = await pathExists(this.checkpointPath);
    const displacedExists = await pathExists(this.recoveryDisplacedPath);
    if (!mainExists && displacedExists) {
      await fs.rename(this.recoveryDisplacedPath, this.checkpointPath);
    } else if (mainExists && displacedExists) {
      await fs.unlink(this.recoveryDisplacedPath);
    }
    await fs.unlink(this.recoveryMarkerPath).catch(() => undefined);
  }

  /**
   * Uses rename directly where the platform supports replacement. On Windows replacement
   * errors, a fixed displaced file makes the two-rename transaction recoverable.
   * Recovery looks at whether that file exists, not a phase marker.
   * This is crash-recoverable, not an operating-system atomic replacement guarantee.
   */
  private async recoverableReplace(checkpoint: ProjectCheckpointV3): Promise<string> {
    const tmp = `${this.checkpointPath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(checkpoint)}\n`;
    const expectedHash = sha256(serialized);
    try {
      await fs.writeFile(tmp, serialized, { encoding: 'utf-8', flag: 'wx' });
      const verifiedRaw = await fs.readFile(tmp, 'utf-8');
      const verified: unknown = JSON.parse(verifiedRaw);
      if (!isProjectCheckpointV3(verified) || sha256(verifiedRaw) !== expectedHash) {
        throw new Error('Temporary checkpoint verification failed');
      }
      try {
        await fs.rename(tmp, this.checkpointPath);
      } catch (error) {
        if (!isWindowsReplaceError(error)) throw error;
        try {
          await fs.rename(this.checkpointPath, this.recoveryDisplacedPath);
        } catch (moveError) {
          if (!isNodeError(moveError, 'ENOENT')) throw moveError;
        }
        try {
          await fs.rename(tmp, this.checkpointPath);
        } catch (replaceError) {
          if (await pathExists(this.recoveryDisplacedPath)) {
            await fs.rename(this.recoveryDisplacedPath, this.checkpointPath);
          }
          throw replaceError;
        }
        await fs.unlink(this.recoveryDisplacedPath).catch(() => undefined);
        await fs.unlink(this.recoveryMarkerPath).catch(() => undefined);
      }
      return expectedHash;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const handle = await acquireFileLock(this.lockPath);
    const heartbeat = startLockHeartbeat(this.lockPath);
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await handle.close().catch(() => undefined);
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isWindowsReplaceError(error: unknown): boolean {
  return isNodeError(error, 'EEXIST')
    || isNodeError(error, 'EPERM')
    || isNodeError(error, 'ENOTEMPTY');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const LOCK_RETRY_LIMIT = 200;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;

async function acquireFileLock(lockPath: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      return handle;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const state = await inspectHeldLock(lockPath);
      if (state === 'gone') continue;
      if (state === 'abandoned') {
        try {
          await fs.unlink(lockPath);
        } catch (unlinkError) {
          if (!isNodeError(unlinkError, 'ENOENT')) throw unlinkError;
        }
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error(`Timed out acquiring checkpoint lock: ${lockPath}`);
}

/** 持有者在锁期间每 LOCK_HEARTBEAT_MS 刷新 mtime，长操作不会被他人当作过期锁删掉。 */
function startLockHeartbeat(lockPath: string): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = new Date();
    void fs.utimes(lockPath, now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return timer;
}

/**
 * 持有进程已退出 → 立即可回收；心跳停了 LOCK_STALE_MS 也回收（PID 可能已被系统复用）。
 * 其余情况视为仍被持有。
 */
async function inspectHeldLock(lockPath: string): Promise<'gone' | 'abandoned' | 'held'> {
  let mtimeMs: number;
  let raw: string;
  try {
    mtimeMs = (await fs.stat(lockPath)).mtimeMs;
    raw = await fs.readFile(lockPath, 'utf-8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'gone';
    throw error;
  }
  if (Date.now() - mtimeMs > LOCK_STALE_MS) return 'abandoned';
  const pid = lockOwnerPid(raw);
  if (pid !== undefined && pid !== process.pid && !isProcessAlive(pid)) return 'abandoned';
  return 'held';
}

function lockOwnerPid(raw: string): number | undefined {
  try {
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}
