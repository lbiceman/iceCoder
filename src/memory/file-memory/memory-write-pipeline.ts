/**
 * 主代理 / 手动 / Web 写记忆文件的统一后处理：秘密扫描 + MEMORY.md 索引维护 + 写盘门控。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MEMORY_DIR, resolveUserMemoryDir } from './memory-config.js';
import { isWithinMemoryDir } from './memory-security.js';
import { scanForSecrets, redactSecrets } from './memory-secret-scanner.js';
import { upsertIndexRow, ensureMemoryIndexBootstrapped, removeIndexRows } from './memory-index-maintainer.js';
import { getScannerCache } from './memory-scanner-cache.js';
import type { MemoryHeader } from './types.js';

/**
 * 用户是否在本轮明确要求写入长期记忆（REQ-E6）。
 * 不用 EXTRACTION_SIGNAL_WORDS 全集——其中的「不要」「偏好」「不对」等会误放行。
 */
export function hasExplicitRememberWriteRequest(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  if (hasChineseExplicitRememberRequest(trimmed)) return true;
  return hasEnglishExplicitRememberRequest(trimmed);
}

function hasChineseExplicitRememberRequest(message: string): boolean {
  const lower = message.toLowerCase();
  for (const word of ['记住', '记下'] as const) {
    let idx = 0;
    while ((idx = lower.indexOf(word, idx)) !== -1) {
      const before = lower.slice(Math.max(0, idx - 24), idx);
      const after = lower.slice(idx + word.length, idx + word.length + 48);

      if (/(?:不要|别用|别|不用|禁止|never|don't|无需|勿|不应).{0,12}$/.test(before)) {
        idx += word.length;
        continue;
      }

      // 元说明：说「记住」、含「记住」—— 但「记住，Git commit…」是直接引语，应放行
      if (/[「『"'']$/.test(before)) {
        if (/^[,，]/.test(after) && /[^\s，,「」"'']{2,}/.test(after)) {
          return true;
        }
        if (/^[」』"']/.test(after) || /^[,，]?\s*[」』"']/.test(after)) {
          idx += word.length;
          continue;
        }
      }
      if (/(?:说|写|提|含|出现|包含)[「『"'']?$/.test(before.slice(-8))) {
        idx += word.length;
        continue;
      }
      return true;
    }
  }
  return false;
}

/** 英文 remember 须为祈使/请求语气，排除「remember 类指令」等验收/说明语境 */
function hasEnglishExplicitRememberRequest(message: string): boolean {
  const lower = message.toLowerCase();
  if (/\b(?:save this|keep in mind)\b/.test(lower)) return true;

  const rememberRe = /\bremember\b/gi;
  let match: RegExpExecArray | null;
  while ((match = rememberRe.exec(message)) !== null) {
    const before = lower.slice(Math.max(0, match.index - 28), match.index);
    const after = lower.slice(match.index + match[0].length, match.index + match[0].length + 28);

    if (/(?:don't|do not|never|without|not to|不使用|勿|不应|非|无)\s*$/.test(before)) continue;
    if (/(?:to ask you|when the user|explicitly asks|e\.g\.|for example|allowed when)\s*$/.test(before)) continue;

    // 元说明：remember 类/指令/信号、remember something (模板句)
    if (/^\s*(?:类|指令|信号|keyword|command|writes?|类指令|信号词)\b/.test(after)) continue;
    if (/^\s*something\b/.test(after)) continue;

    // 明确请求：remember, / remember this / remember to / remember my …
    if (/^\s*[,，]/.test(after)) return true;
    if (/^\s+(?:this|that|it|to|my|the|please|commit|git|what|how|when|if|all|always)\b/.test(after)) return true;
  }
  return false;
}

/**
 * E6 写盘授权：从候选用户消息中选取含 remember 信号的一条（优先本轮 trigger）。
 */
export function resolveMessageForRememberWriteGuard(candidates: readonly string[]): string {
  for (const msg of candidates) {
    const t = msg?.trim();
    if (t && hasExplicitRememberWriteRequest(t)) return t;
  }
  for (const msg of candidates) {
    const t = msg?.trim();
    if (t) return t;
  }
  return '';
}

export type AgentMemoryWriteGuardFn = () => string | null;

let agentMemoryWriteGuard: AgentMemoryWriteGuardFn | null = null;
const sessionRememberGuards = new Map<string, AgentMemoryWriteGuardFn>();

function sessionCapKey(sessionId: string): string {
  return sessionId.trim() || 'default';
}

function rememberGuardFor(sessionId?: string): AgentMemoryWriteGuardFn | null {
  if (sessionId?.trim()) {
    return sessionRememberGuards.get(sessionCapKey(sessionId)) ?? agentMemoryWriteGuard;
  }
  return agentMemoryWriteGuard;
}

/** Harness 生命周期内注册：未明确要求 remember 时拒绝主代理写长期记忆 */
export function registerAgentMemoryWriteGuard(
  guard: AgentMemoryWriteGuardFn | null,
  sessionId?: string,
): void {
  if (sessionId !== undefined) {
    const key = sessionCapKey(sessionId);
    if (guard) sessionRememberGuards.set(key, guard);
    else sessionRememberGuards.delete(key);
    return;
  }
  agentMemoryWriteGuard = guard;
}

/** 本会话已成功写入的长期记忆文件名（不含路径） */
export interface LongTermMemoryWriteCap {
  writtenBasenames: Set<string>;
}

let longTermMemoryWriteCap: LongTermMemoryWriteCap | null = null;

export function createLongTermMemoryWriteCap(): LongTermMemoryWriteCap {
  return { writtenBasenames: new Set() };
}

/** Harness 生命周期内注册：主代理写与 Extract 共用会话配额 */
export function registerLongTermMemoryWriteCap(cap: LongTermMemoryWriteCap | null): void {
  longTermMemoryWriteCap = cap;
}

export function getLongTermMemoryWriteCap(): LongTermMemoryWriteCap | null {
  return longTermMemoryWriteCap;
}

const sessionWriteCaps = new Map<string, LongTermMemoryWriteCap>();

/** 按 sessionId 复用配额（Web 每轮 new Harness，不能把 cap 建在实例上） */
export function getOrCreateSessionLongTermMemoryWriteCap(sessionId: string): LongTermMemoryWriteCap {
  const key = sessionCapKey(sessionId);
  let cap = sessionWriteCaps.get(key);
  if (!cap) {
    cap = createLongTermMemoryWriteCap();
    sessionWriteCaps.set(key, cap);
  }
  return cap;
}

export function resetSessionLongTermMemoryWriteCaps(sessionId?: string): void {
  if (sessionId !== undefined) {
    const key = sessionCapKey(sessionId);
    sessionWriteCaps.delete(key);
    sessionRememberGuards.delete(key);
  } else {
    sessionWriteCaps.clear();
    sessionRememberGuards.clear();
  }
}

function capForWrite(sessionId?: string): LongTermMemoryWriteCap | null {
  if (sessionId?.trim()) {
    return sessionWriteCaps.get(sessionCapKey(sessionId)) ?? longTermMemoryWriteCap;
  }
  return longTermMemoryWriteCap;
}

export function memoryWriteTopicKey(absolutePath: string): string {
  return path.basename(absolutePath).toLowerCase();
}

/**
 * 更新本会话已写过的同一文件不占第二次；新建不同文件名才拦截。
 * 未注册 cap（单测/无 Harness）时不拦截。
 */
export function assertLongTermMemoryWriteCapAllowed(
  absolutePath: string,
  sessionId?: string,
): string | null {
  const cap = capForWrite(sessionId);
  if (!cap) return null;
  const key = memoryWriteTopicKey(absolutePath);
  if (cap.writtenBasenames.has(key)) return null;
  if (cap.writtenBasenames.size === 0) return null;
  const existing = [...cap.writtenBasenames].join(', ');
  return `session_memory_write_cap: This session already wrote long-term memory (${existing}). Update that file instead of creating another. Use session-notes for additional notes.`;
}

export const SHELL_MEMORY_WRITE_TOPIC_KEY = '__shell_memory_write__';

/** 从 shell 命令里尽量抽出实际写入的记忆文件名 */
export function extractMemoryWriteBasenamesFromShellCommand(command: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?:memory-files|user-memory)[/\\]([^"'`\s)]+\.md)/gi,
    /(?:memory-files|user-memory)['"],\s*['"]([^"'`]+\.md)/gi,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(command)) !== null) {
      found.add(path.basename(match[1]).toLowerCase());
    }
  }
  return [...found];
}

/**
 * 前台 run_command 成功写长期记忆后计入会话配额（命令失败不占）。
 * 未注册 cap 时不新建，避免无 Harness 的单测被误伤。
 */
export function recordShellMemoryWriteSuccess(sessionId?: string, command?: string): void {
  const cap = capForWrite(sessionId);
  if (!cap) return;
  const names = command ? extractMemoryWriteBasenamesFromShellCommand(command) : [];
  if (names.length > 0) {
    for (const name of names) cap.writtenBasenames.add(name);
    return;
  }
  cap.writtenBasenames.add(SHELL_MEMORY_WRITE_TOPIC_KEY);
}

export function recordLongTermMemoryWriteSuccess(absolutePath: string, sessionId?: string): void {
  const cap = capForWrite(sessionId);
  if (!cap) return;
  if (!resolveMemoryRootForPath(absolutePath)) return;
  const filename = path.basename(absolutePath);
  if (filename === 'MEMORY.md' || !filename.endsWith('.md')) return;
  cap.writtenBasenames.add(memoryWriteTopicKey(absolutePath));
}

function memoryRoots(): string[] {
  return [
    path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR),
    path.resolve(resolveUserMemoryDir()),
  ];
}

const USER_MEMORY_PATH_ALIASES = /^(?:data\/)?user-memory(?:[/\\]|$)/i;
const PROJECT_MEMORY_PATH_ALIASES = /^(?:data\/)?memory-files(?:[/\\]|$)/i;

/**
 * 将 Agent 工具路径规范到 ICE 配置的记忆目录。
 * 例如 `user-memory/foo.md` → `{dataDir}/user-memory/foo.md`（而非仓库根 `user-memory/`）。
 */
export function canonicalizeMemoryToolPath(rawPath: string, workDir: string): string {
  const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workDir, rawPath);
  if (resolveMemoryRootForPath(abs)) return abs;

  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\/+/, '');

  if (USER_MEMORY_PATH_ALIASES.test(normalized)) {
    const rest = normalized.replace(/^data\/user-memory\/?|^user-memory\/?/i, '');
    const root = path.resolve(resolveUserMemoryDir());
    return rest ? path.join(root, ...rest.split('/').filter(Boolean)) : root;
  }

  if (PROJECT_MEMORY_PATH_ALIASES.test(normalized)) {
    const rest = normalized.replace(/^data\/memory-files\/?|^memory-files\/?/i, '');
    const root = path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR);
    return rest ? path.join(root, ...rest.split('/').filter(Boolean)) : root;
  }

  return abs;
}

/** 工具参数路径是否指向长期记忆（含别名路径） */
export function isMemoryToolPath(rawPath: string, workDir: string): boolean {
  return resolveMemoryRootForPath(canonicalizeMemoryToolPath(rawPath, workDir)) !== null;
}

function extractFrontmatterBlock(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? '';
}

/** 解析记忆 frontmatter 字段；兼容无空格、引号和缩进行 */
export function parseMemoryFrontmatterField(content: string, field: string): string {
  const block = extractFrontmatterBlock(content);
  const source = block || content;
  const re = new RegExp(`^\\s*${field}:\\s*(.*)$`, 'im');
  const match = source.match(re);
  if (!match) return '';
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/** frontmatter 中 type: user（含 type:user / type: "user"） */
export function isUserTypeMemoryMarkdown(content: string): boolean {
  return parseMemoryFrontmatterField(content, 'type').toLowerCase() === 'user';
}

function hasProjectMemoryTag(content: string): boolean {
  const tags = parseMemoryFrontmatterField(content, 'tags').toLowerCase();
  return /(^|[\s,])project:/.test(tags);
}

/**
 * user_guide / user-readme / user-auth-* 是文档或项目命名，不能单靠前缀塞进用户库。
 */
function isUserLibraryFilenameHeuristic(base: string): boolean {
  if (!/^user[-_].+\.md$/i.test(base)) return false;
  if (/^user[-_](guide|readme|auth)(?:[-_.]|$)/i.test(base)) return false;
  return true;
}

/**
 * type:user，或 user_/user- 前缀且非明确项目条，必须进 user-memory。
 * 明确 type: project/feedback/reference 或带 project: 标签的不迁。
 */
export function shouldForceUserMemoryLocation(absolutePath: string, markdownContent = ''): boolean {
  const type = parseMemoryFrontmatterField(markdownContent, 'type').toLowerCase();
  if (type === 'user') return true;
  if (type === 'project' || type === 'feedback' || type === 'reference') return false;
  const base = path.basename(absolutePath);
  if (!isUserLibraryFilenameHeuristic(base)) return false;
  if (hasProjectMemoryTag(markdownContent)) return false;
  return true;
}

const USER_TOPIC_CLUSTERS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'unity_editor_version', re: /ProjectVersion\.txt|EditorVersion/i },
  { id: 'temp_debug_cleanup', re: /debug-\*?\.mjs|零残留|临时文件/ },
  { id: 'git_commit', re: /commit message|git commit|记得\s*push/i },
  { id: 'ui_zh', re: /UI.{0,24}中文|面向玩家/ },
  { id: 'input_latency', re: /输入缓冲|立即响应/ },
  { id: 'shell_preference', re: /pwsh\.exe|必须使用\s*pwsh|powershell/i },
  { id: 'reply_zh', re: /回复.{0,8}中文|用中文回复|always reply in chinese/i },
];

/** 用户条一文一题：无关习惯不得写进同一文件 */
export function shouldRejectMixedTopicMemory(content: string, type?: string): string | null {
  const resolvedType = (type ?? parseMemoryFrontmatterField(content, 'type')).toLowerCase();
  if (resolvedType && resolvedType !== 'user') return null;
  const hits = USER_TOPIC_CLUSTERS.filter(cluster => cluster.re.test(content));
  if (hits.length >= 2) return 'mixed_user_topics';
  return null;
}

/**
 * type:user 记忆必须落在 user-memory 目录；若 Agent 误写 memory-files，自动改到 user-memory。
 */
export function enforceUserTypeMemoryLocation(absolutePath: string, markdownContent?: string): string {
  if (!shouldForceUserMemoryLocation(absolutePath, markdownContent ?? '')) {
    return absolutePath;
  }

  const userRoot = path.resolve(resolveUserMemoryDir());
  const projectRoot = path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR);
  const normalized = path.resolve(absolutePath);

  if (isWithinMemoryDir(normalized, userRoot)) return normalized;
  if (isWithinMemoryDir(normalized, projectRoot)) {
    const redirected = path.join(userRoot, path.basename(normalized));
    if (redirected !== normalized) {
      console.warn(
        `[memory-write] type:user must live under user-memory; redirecting ${path.basename(normalized)}`,
      );
    }
    return redirected;
  }
  return normalized;
}

/** 记忆写盘目标路径：别名归一化 + type:user 目录强制 */
export function resolveMemoryWritePath(
  rawPath: string,
  workDir: string,
  markdownContent?: string,
): string {
  const canonical = canonicalizeMemoryToolPath(rawPath, workDir);
  return enforceUserTypeMemoryLocation(canonical, markdownContent);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读/改已有记忆文件：canonical 缺失时，跟随 E6a 到 user-memory 同名文件。
 */
export async function resolveExistingMemoryToolPath(rawPath: string, workDir: string): Promise<string> {
  const canonical = canonicalizeMemoryToolPath(rawPath, workDir);
  if (await pathExists(canonical)) return canonical;

  const projectRoot = path.resolve(process.env.ICE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR);
  const userRoot = path.resolve(resolveUserMemoryDir());
  const normalized = path.resolve(canonical);
  if (isWithinMemoryDir(normalized, projectRoot)) {
    const userAlt = path.join(userRoot, path.basename(normalized));
    if (await pathExists(userAlt)) return userAlt;
  }
  return canonical;
}

/** shell 命令是否试图写长期记忆目录（含 seed 脚本等绕行） */
export function shellCommandTargetsMemoryWrite(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/\b(?:seed_memory|verify_memory_seed)\b/i.test(cmd)) return true;
  if (/(?:^|[\s"'`]|\\|\/)((?:data[\\/])?(?:memory-files|user-memory)(?:[\\/]|\.md))/i.test(cmd)) {
    if (/(?:>|>>|writefilesync|writefile|echo\s+.+\s+>|cp\s+|mv\s+|tee\s+|node\s+)/i.test(cmd)) return true;
    if (/\bnode\s+[^\s]*(?:seed|memory)[^\s]*/i.test(cmd)) return true;
  }
  return false;
}

/**
 * run_command 写记忆目录前的硬门控（REQ-E6 扩展，防脚本绕行 file-tools）。
 */
export function assertAgentMemoryShellCommandAllowed(
  command: string,
  sessionId?: string,
): string | null {
  if (!shellCommandTargetsMemoryWrite(command)) return null;
  const guard = rememberGuardFor(sessionId);
  if (!guard) {
    return 'remember_required: Long-term memory writes require the user to explicitly ask you to remember something in the current turn.';
  }
  const err = guard();
  if (err) {
    console.warn(`[memory-write] Blocked shell write to memory: ${err}`);
    return err;
  }
  const cap = capForWrite(sessionId);
  if (cap && cap.writtenBasenames.size > 0) {
    const capErr = `session_memory_write_cap: This session already wrote long-term memory. Use session-notes instead of shell writes.`;
    console.warn(`[memory-write] Blocked shell write to memory: ${capErr}`);
    return capErr;
  }
  return null;
}

/** 绝对路径若落在记忆目录内，返回该根目录；否则 null */
export function resolveMemoryRootForPath(absolutePath: string): string | null {
  const normalized = path.resolve(absolutePath);
  for (const root of memoryRoots()) {
    if (isWithinMemoryDir(normalized, root)) return root;
  }
  return null;
}

/**
 * 主代理 write/edit/append/patch 写记忆目录前的硬门控（REQ-E6 / E6a / 会话写配额）。
 * @returns 错误信息；null 表示允许
 */
export function assertAgentMemoryWriteAllowed(
  absolutePath: string,
  options?: { content?: string; sessionId?: string },
): string | null {
  if (!resolveMemoryRootForPath(absolutePath)) return null;
  const guard = rememberGuardFor(options?.sessionId);
  if (!guard) {
    return 'remember_required: Long-term memory writes require the user to explicitly ask you to remember something in the current turn.';
  }
  const err = guard();
  if (err) {
    console.warn(`[memory-write] Blocked write to ${path.basename(absolutePath)}: ${err}`);
    return err;
  }

  const content = options?.content;
  if (content && shouldForceUserMemoryLocation(absolutePath, content)) {
    const mixed = shouldRejectMixedTopicMemory(content, 'user');
    if (mixed) {
      const mixedErr = 'mixed_user_topics: Put each user habit in its own file; do not mix unrelated facts (e.g. cleanup policy + ProjectVersion).';
      console.warn(`[memory-write] Blocked write to ${path.basename(absolutePath)}: ${mixedErr}`);
      return mixedErr;
    }
  }

  const capErr = assertLongTermMemoryWriteCapAllowed(absolutePath, options?.sessionId);
  if (capErr) {
    console.warn(`[memory-write] Blocked write to ${path.basename(absolutePath)}: ${capErr}`);
    return capErr;
  }
  return null;
}

/** 写盘前秘密扫描（与 Extract 一致） */
export function sanitizeMemoryContentBeforeWrite(content: string): { content: string; redacted: boolean } {
  const secrets = scanForSecrets(content);
  if (secrets.length === 0) {
    return { content, redacted: false };
  }
  console.warn(
    `[memory-write] Secret detected (${secrets.map(s => s.label).join(', ')}). Redacting.`,
  );
  return { content: redactSecrets(content), redacted: true };
}

function parseFrontmatterField(content: string, field: string): string {
  return parseMemoryFrontmatterField(content, field);
}

export function formatMemoryWritePathNote(actualPath: string): string {
  if (!resolveMemoryRootForPath(actualPath)) return '';
  return `\n[memory-write] stored at ${actualPath}`;
}

/** type:user 从 memory-files 迁到 user-memory 后删除旧文件并清项目索引 */
export async function removeStaleMemoryFileIfMoved(fromPath: string, toPath: string): Promise<void> {
  if (path.resolve(fromPath) === path.resolve(toPath)) return;
  const oldRoot = resolveMemoryRootForPath(fromPath);
  if (!oldRoot) return;
  try {
    await fs.unlink(fromPath);
    console.warn(`[memory-write] Removed misplaced memory file: ${path.basename(fromPath)}`);
  } catch {
    /* already gone */
  }
  try {
    await removeIndexRows(oldRoot, [path.basename(fromPath)]);
    getScannerCache().invalidate(oldRoot);
  } catch {
    /* index may not exist */
  }
}

/** 记忆写盘完成后：sanitize 已在调用方完成；维护索引并计入会话配额 */
export async function afterSuccessfulMemoryMarkdownWrite(
  absolutePath: string,
  fileContent: string,
  sessionId?: string,
): Promise<void> {
  await afterMemoryMarkdownWritten(absolutePath, fileContent);
  recordLongTermMemoryWriteSuccess(absolutePath, sessionId);
}

/** 记忆 .md 写入完成后：bootstrap 索引 + upsert 行 */
export async function afterMemoryMarkdownWritten(absolutePath: string, fileContent: string): Promise<void> {
  const root = resolveMemoryRootForPath(absolutePath);
  if (!root) return;

  const filename = path.basename(absolutePath);
  if (filename === 'MEMORY.md' || !filename.endsWith('.md')) return;

  await ensureMemoryIndexBootstrapped(root);

  const description = parseFrontmatterField(fileContent, 'description')
    || parseFrontmatterField(fileContent, 'name')
    || filename.replace(/\.md$/i, '');
  const type = (parseFrontmatterField(fileContent, 'type') || 'project') as MemoryHeader['type'];

  await upsertIndexRow(root, { filename, description, type });
  getScannerCache().invalidate(root);
}

/** Harness 默认门控：当前用户消息须含 remember 类信号词 */
export function createRememberSignalWriteGuard(getUserMessage: () => string): AgentMemoryWriteGuardFn {
  return () => {
    const msg = getUserMessage().trim();
    if (!msg) {
      return 'remember_required: Long-term memory writes require the user to explicitly ask you to remember something in the current turn.';
    }
    if (hasExplicitRememberWriteRequest(msg)) return null;
    return 'remember_required: Long-term memory writes are only allowed when the user explicitly asks you to remember something (e.g. 记住 / remember). Use session-notes for task progress.';
  };
}
