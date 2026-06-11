/**
 * 主代理 / 手动 / Web 写记忆文件的统一后处理：秘密扫描 + MEMORY.md 索引维护 + 写盘门控。
 */

import path from 'node:path';
import { DEFAULT_MEMORY_DIR, resolveUserMemoryDir } from './memory-config.js';
import { isWithinMemoryDir } from './memory-security.js';
import { scanForSecrets, redactSecrets } from './memory-secret-scanner.js';
import { upsertIndexRow, ensureMemoryIndexBootstrapped } from './memory-index-maintainer.js';
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

/** Harness 生命周期内注册：未明确要求 remember 时拒绝主代理写长期记忆 */
export function registerAgentMemoryWriteGuard(guard: AgentMemoryWriteGuardFn | null): void {
  agentMemoryWriteGuard = guard;
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

/** frontmatter 中 type: user */
export function isUserTypeMemoryMarkdown(content: string): boolean {
  return parseFrontmatterField(content, 'type').toLowerCase() === 'user';
}

/**
 * type:user 记忆必须落在 user-memory 目录；若 Agent 误写 memory-files，自动改到 user-memory。
 */
export function enforceUserTypeMemoryLocation(absolutePath: string, markdownContent?: string): string {
  if (!markdownContent || !isUserTypeMemoryMarkdown(markdownContent)) {
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
export function assertAgentMemoryShellCommandAllowed(command: string): string | null {
  if (!shellCommandTargetsMemoryWrite(command)) return null;
  if (!agentMemoryWriteGuard) {
    return 'remember_required: Long-term memory writes require the user to explicitly ask you to remember something in the current turn.';
  }
  const err = agentMemoryWriteGuard();
  if (err) {
    console.warn(`[memory-write] Blocked shell write to memory: ${err}`);
  }
  return err;
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
 * 主代理 write/edit/append 写记忆目录前的硬门控（REQ-E6）。
 * @returns 错误信息；null 表示允许
 */
export function assertAgentMemoryWriteAllowed(absolutePath: string): string | null {
  if (!resolveMemoryRootForPath(absolutePath)) return null;
  if (!agentMemoryWriteGuard) {
    return 'remember_required: Long-term memory writes require the user to explicitly ask you to remember something in the current turn.';
  }
  const err = agentMemoryWriteGuard();
  if (err) {
    console.warn(`[memory-write] Blocked write to ${path.basename(absolutePath)}: ${err}`);
  }
  return err;
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
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'im');
  const m = content.match(re);
  return m?.[1]?.trim() ?? '';
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
