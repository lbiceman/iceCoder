import type { UnifiedMessage } from '../llm/types.js';

export interface AlsoNoteEntry {
  text: string;
  runId: number;
  messageId: string;
}

const pendingAlsoNotesBySession = new Map<string, AlsoNoteEntry[]>();
const activeAlsoRunIdBySession = new Map<string, number>();

export const PENDING_NOTE_USAGE_MESSAGE = '用法: /also <补充说明>';

function buildAlsoNoteUserMessage(text: string): UnifiedMessage {
  return {
    role: 'user',
    content: text.trim(),
    preserveOnCompaction: true,
    alsoNote: true,
  };
}

export function setActiveAlsoRun(sessionId: string, runId: number): void {
  activeAlsoRunIdBySession.set(sessionId, runId);
}

export function queueAlsoNote(sessionId: string, entry: AlsoNoteEntry): void {
  const list = pendingAlsoNotesBySession.get(sessionId) ?? [];
  list.push(entry);
  pendingAlsoNotesBySession.set(sessionId, list);
}

export function drainAlsoNotesForRun(sessionId: string, runId?: number): AlsoNoteEntry[] {
  const list = pendingAlsoNotesBySession.get(sessionId) ?? [];
  if (list.length === 0) return [];
  const kept: AlsoNoteEntry[] = [];
  const drained: AlsoNoteEntry[] = [];
  for (const entry of list) {
    if (runId != null && entry.runId !== runId) {
      kept.push(entry);
    } else {
      drained.push(entry);
    }
  }
  if (kept.length > 0) pendingAlsoNotesBySession.set(sessionId, kept);
  else pendingAlsoNotesBySession.delete(sessionId);
  return drained;
}

/** 将排队备注写入 canonical 消息列表，与主任务 user 消息同等对待。 */
export function appendQueuedAlsoNotesToMessages(
  messages: UnifiedMessage[],
  sessionId: string,
): AlsoNoteEntry[] {
  const runId = activeAlsoRunIdBySession.get(sessionId);
  const drained = drainAlsoNotesForRun(sessionId, runId);
  for (const entry of drained) {
    messages.push(buildAlsoNoteUserMessage(entry.text));
  }
  return drained;
}

export function clearPendingNoteForRun(sessionId: string, runId: number): void {
  const list = pendingAlsoNotesBySession.get(sessionId) ?? [];
  const kept = list.filter((entry) => entry.runId !== runId);
  if (kept.length > 0) pendingAlsoNotesBySession.set(sessionId, kept);
  else pendingAlsoNotesBySession.delete(sessionId);
  if (activeAlsoRunIdBySession.get(sessionId) === runId) {
    activeAlsoRunIdBySession.delete(sessionId);
  }
}

export function clearPendingNotesForSession(sessionId: string): void {
  pendingAlsoNotesBySession.delete(sessionId);
  activeAlsoRunIdBySession.delete(sessionId);
}

export function parseAlsoCommand(content: string): { matched: boolean; text: string } {
  const trimmed = content.trim();
  if (trimmed.startsWith('/also')) {
    return { matched: true, text: trimmed.slice('/also'.length).trim() };
  }
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (t.startsWith('/also')) {
      return { matched: true, text: t.slice('/also'.length).trim() };
    }
  }
  return { matched: false, text: '' };
}

export function parseNextCommand(content: string): { matched: boolean; text: string } {
  const trimmed = content.trim();
  if (trimmed.startsWith('/next')) {
    return { matched: true, text: trimmed.slice('/next'.length).trim() };
  }
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (t.startsWith('/next')) {
      return { matched: true, text: t.slice('/next'.length).trim() };
    }
  }
  return { matched: false, text: '' };
}

export type ShellCommandAction = 'enter' | 'exit';

export interface ParsedShellCommand {
  matched: boolean;
  action: ShellCommandAction | null;
  /** enter 时 `/shell` 后的提示词；模式切换本身不包含此文本 */
  prompt: string;
}

/** 剥离历史/文档中可能附带的 Shell Copilot 模式横幅，避免误当作用户提示词。 */
function stripShellCopilotModeBanner(text: string): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[Shell Copilot Mode]')) return '';
  const idx = trimmed.indexOf('\n[Shell Copilot Mode]');
  if (idx >= 0) return trimmed.slice(0, idx).trim();
  const idxInline = trimmed.indexOf('[Shell Copilot Mode]');
  if (idxInline === 0) return '';
  if (idxInline > 0) return trimmed.slice(0, idxInline).trim();
  return trimmed;
}

/**
 * 识别 `/shell`（可带尾随提示词）与旧 `/shell exit`。
 * - `/shell` / `/shell <prompt>` → enter；prompt 与模式指令分离
 * - `/shell exit` → exit（仅拒绝提示，不改变模式）
 * - `/shell exit foo` → 不匹配
 */
export function parseShellCommand(content: string): ParsedShellCommand {
  const trimmed = content.trim();
  if (!trimmed) return { matched: false, action: null, prompt: '' };

  const lines = trimmed.split(/\r?\n/);
  let shellLineIndex = -1;
  let shellLine = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? '';
    if (t === '/shell' || t === '/shell exit' || t.startsWith('/shell ')) {
      shellLineIndex = i;
      shellLine = t;
      break;
    }
  }
  if (shellLineIndex < 0) return { matched: false, action: null, prompt: '' };

  if (shellLine === '/shell exit') {
    return { matched: true, action: 'exit', prompt: '' };
  }

  const after = shellLine.slice('/shell'.length).trim();
  if (after === 'exit' || after.startsWith('exit ')) {
    return { matched: false, action: null, prompt: '' };
  }

  const promptParts: string[] = [];
  if (after) promptParts.push(after);
  const rest = stripShellCopilotModeBanner(lines.slice(shellLineIndex + 1).join('\n'));
  if (rest) promptParts.push(rest);

  return {
    matched: true,
    action: 'enter',
    prompt: promptParts.join('\n').trim(),
  };
}

export type PlanCommandAction = 'enter' | 'exit';

export interface ParsedPlanCommand {
  matched: boolean;
  action: PlanCommandAction | null;
  /** enter 时 `/plan` 后的提示词；模式切换本身不包含此文本 */
  prompt: string;
}

function isSlashCommandLine(trimmed: string): boolean {
  return /^\/[a-z]+(?:\s|$)/i.test(trimmed) && !trimmed.slice(1).includes('/');
}

function isPlanCommandMetaLine(trimmed: string): boolean {
  if (!trimmed) return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => /^#[^\s#]+\.md$/i.test(token))) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !isSlashCommandLine(trimmed)) {
    return true;
  }
  return false;
}

function isPlanCommandLine(trimmed: string): boolean {
  return trimmed === '/plan' || trimmed === '/plan exit' || trimmed.startsWith('/plan ');
}

/**
 * 只把「开头元数据之后的第一条内容」当成 /plan。
 * 正文中间提到 `/plan` 不进入规划模式，避免打断普通实现任务。
 */
function findLeadingPlanCommand(content: string): { lineIndex: number; line: string } | null {
  const lines = content.trim().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? '';
    if (isPlanCommandMetaLine(t)) continue;
    if (isPlanCommandLine(t)) return { lineIndex: i, line: t };
    return null;
  }
  return null;
}

/**
 * 识别 `/plan`（可带尾随提示词）与 `/plan exit`。
 * - `/plan` / `/plan <prompt>` → enter；prompt 与模式指令分离
 * - `/plan exit` → exit
 * - `/plan exit foo` → 不匹配
 * - 正文中间的 `/plan` 不匹配
 */
export function parsePlanCommand(content: string): ParsedPlanCommand {
  const trimmed = content.trim();
  if (!trimmed) return { matched: false, action: null, prompt: '' };

  const found = findLeadingPlanCommand(trimmed);
  if (!found) return { matched: false, action: null, prompt: '' };
  const { lineIndex: planLineIndex, line: planLine } = found;
  const lines = trimmed.split(/\r?\n/);

  if (planLine === '/plan exit') {
    return { matched: true, action: 'exit', prompt: '' };
  }

  const after = planLine.slice('/plan'.length).trim();
  if (after === 'exit' || after.startsWith('exit ')) {
    return { matched: false, action: null, prompt: '' };
  }

  const promptParts: string[] = [];
  if (after) promptParts.push(after);
  const rest = lines.slice(planLineIndex + 1).join('\n').trim();
  if (rest) promptParts.push(rest);

  return {
    matched: true,
    action: 'enter',
    prompt: promptParts.join('\n').trim(),
  };
}

export function resetPendingNotesForTests(): void {
  pendingAlsoNotesBySession.clear();
  activeAlsoRunIdBySession.clear();
}
