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
    const key = path.resolve(this.checkpointPath).toLowerCase();
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
        try {
          const parsed: unknown = JSON.parse(await fs.readFile(this.checkpointPath, 'utf-8'));
          if (isProjectCheckpointV3(parsed)) {
            const checkpoint = cloneProjectCheckpointV3(parsed);
            this.writeState.latest = cloneProjectCheckpointV3(checkpoint);
            this.writeState.generation = checkpoint.snapshotMeta.sequence ?? 0;
            return checkpoint;
          }
          // A native v3 file that fails the strict validator must not be
          // empty-adapted; callers would then persist a blank stand-in.
          if (isRecord(parsed) && parsed.version === PROJECT_CHECKPOINT_VERSION) {
            return null;
          }
          const checkpoint = adaptLegacyCheckpoint(parsed, {
            projectId: this.projectId,
            sessionId: this.sessionId,
          });
          this.writeState.latest = cloneProjectCheckpointV3(checkpoint);
          this.writeState.generation = checkpoint.snapshotMeta.sequence ?? 0;
          return checkpoint;
        } catch {
          return null;
        }
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
      await this.copyLegacyBackupOnce();
      return;
    }
    if (isProjectCheckpointV3(parsed)) return;
    await this.copyLegacyBackupOnce();
  }

  private async copyLegacyBackupOnce(): Promise<void> {
    try {
      await fs.copyFile(this.checkpointPath, this.legacyBackupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
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
   * errors, a fixed displaced file and marker make the two-rename transaction recoverable.
   * This is crash-recoverable, not an operating-system atomic replacement guarantee.
   */
  private async recoverableReplace(checkpoint: ProjectCheckpointV3): Promise<string> {
    const tmp = `${this.checkpointPath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
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
        await this.writeRecoveryMarker('prepared');
        try {
          await fs.rename(this.checkpointPath, this.recoveryDisplacedPath);
        } catch (moveError) {
          if (!isNodeError(moveError, 'ENOENT')) throw moveError;
        }
        await this.writeRecoveryMarker('displaced');
        try {
          await fs.rename(tmp, this.checkpointPath);
        } catch (replaceError) {
          if (await pathExists(this.recoveryDisplacedPath)) {
            await fs.rename(this.recoveryDisplacedPath, this.checkpointPath);
          }
          await fs.unlink(this.recoveryMarkerPath).catch(() => undefined);
          throw replaceError;
        }
        await this.writeRecoveryMarker('installed');
        await fs.unlink(this.recoveryDisplacedPath).catch(() => undefined);
        await fs.unlink(this.recoveryMarkerPath).catch(() => undefined);
      }
      return expectedHash;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  private async writeRecoveryMarker(phase: 'prepared' | 'displaced' | 'installed'): Promise<void> {
    await fs.writeFile(
      this.recoveryMarkerPath,
      JSON.stringify({ version: 1, phase, updatedAt: new Date().toISOString() }),
      'utf-8',
    );
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const handle = await acquireFileLock(this.lockPath);
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

async function acquireFileLock(lockPath: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      return handle;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (!isNodeError(statError, 'ENOENT')) throw statError;
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error(`Timed out acquiring checkpoint lock: ${lockPath}`);
}
