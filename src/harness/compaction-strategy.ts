/**
 * 压缩策略辅助：会话笔记截断、压缩边界元数据、近两轮对话聚焦、微压缩工具白名单。
 */

import type { UnifiedMessage } from '../llm/types.js';
import { prepareAssistantContentForHistory } from './text-format-tool-call-parsers.js';
import { looksLikeFailedRunCommandOutput } from './failed-run-command.js';
import { isSystemInjectedUserContent } from './harness-message-utils.js';
import { normalizeToolPath, SPILL_ALWAYS_MIN_CHARS, spillReadHint } from './tool-result-budget.js';

/** 硬压缩注入会话笔记的最大字符（防止摘要独占 post-compact 预算） */
export const MAX_SESSION_NOTES_COMPACT_CHARS = 120_000;

/** 微压缩（light）时，超过若干轮后可清空正文的工具 */
export const LIGHT_MICROCLEAR_TOOLS = new Set<string>([
  'glob',
  'grep',
  'run_command',
  'web_search',
  'fetch_url',
  'list_drives',
  'browse_directory',
  'open_file',
  'parse_document',
  'fs_operation',
  'image_read',
  'doc_parse',
]);

/** 文件类工具结果不在 light 层清空（源码读写为编码 agent 核心上下文） */
export const FILE_TOOLS_NEVER_MICROCLEAR = new Set<string>([
  'read_file',
  'write_file',
  'edit_file',
  'append_file',
  'batch_edit_file',
  'patch_file',
  'diff_files',
]);

/** 压缩/摘要时保留完整 tool output（含 embedded unified diff，供 Web UI F5 还原） */
export const FILE_TOOLS_PRESERVE_FULL_OUTPUT = FILE_TOOLS_NEVER_MICROCLEAR;

const OLD_TOOL_STUB = '[Old tool result cleared for context]';

/** 硬压缩时必须保留在 recent 后缀的消息（C 类纠偏等） */
export function shouldPreserveMessageOnCompaction(msg: UnifiedMessage): boolean {
  return msg.preserveOnCompaction === true;
}

/** 不参与「真实用户轮次」计数的注入块。规则与 {@link isSystemInjectedUserContent} 相同。 */
export function isSyntheticUserBlockContent(content: string): boolean {
  return isSystemInjectedUserContent(content);
}

export function sessionNotesPathHint(sessionId?: string): string {
  return sessionId
    ? `data/sessions/${sessionId}.session-notes.md`
    : 'data/sessions/{sessionId}.session-notes.md';
}

export function truncateSessionNotesForCompact(
  sessionNotes: string,
  maxChars: number = MAX_SESSION_NOTES_COMPACT_CHARS,
  sessionId?: string,
): { text: string; truncated: boolean } {
  if (sessionNotes.length <= maxChars) {
    return { text: sessionNotes, truncated: false };
  }
  const notesPath = sessionNotesPathHint(sessionId);
  return {
    text:
      sessionNotes.slice(0, maxChars)
      + `\n\n...(session notes truncated for compaction, original ${sessionNotes.length} chars; see ${notesPath} for full file when applicable)`,
    truncated: true,
  };
}

export type CompactBoundaryMeta = {
  beforeTokens: number;
  afterTokens: number;
  beforeMessages: number;
  afterMessages: number;
};

/** A：压缩边界，便于观测与模型理解「摘要之后才是可信后缀」 */
export function buildCompactBoundaryContent(meta: CompactBoundaryMeta): string {
  return [
    '<compact_boundary>',
    'Context compaction occurred. Metadata:',
    `- pre_compact_estimated_tokens: ${meta.beforeTokens}`,
    `- post_compact_estimated_tokens: ${meta.afterTokens}`,
    `- pre_compact_messages: ${meta.beforeMessages}`,
    `- post_compact_messages: ${meta.afterMessages}`,
    '',
    'Model-facing policy: treat messages AFTER this block plus the following <recent-dialogue-focus> as the continuation anchor; older summarized content is background only.',
    '</compact_boundary>',
  ].join('\n');
}

function assistantExcerpt(msg: UnifiedMessage): string {
  if (msg.toolCalls?.length) {
    const names = msg.toolCalls.map(tc => tc.name).join(', ');
    const cleaned = prepareAssistantContentForHistory(
      typeof msg.content === 'string' ? msg.content : '',
    );
    const tail = cleaned ? ` ${cleaned.slice(0, 200)}` : '';
    return `[assistant tool_calls: ${names}]${tail}`;
  }
  const t = prepareAssistantContentForHistory(
    typeof msg.content === 'string' ? msg.content : '',
  );
  if (!t) return '[assistant empty]';
  return t.length > 2_500 ? `${t.slice(0, 2_500)}\n…(truncated)` : t;
}

/** E：最近两轮左右的自然语言锚点（基于压缩前快照） */
export function buildRecentDialogueFocusContent(
  messages: UnifiedMessage[],
  maxUserTurns = 2,
  maxAssistantTurns = 2,
): string {
  const users: string[] = [];
  const assistants: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') {
      if (isSyntheticUserBlockContent(m.content)) continue;
      const raw = m.content.trim();
      if (!raw) continue;
      users.unshift(raw.length > 3_000 ? `${raw.slice(0, 3_000)}\n…(truncated)` : raw);
      if (users.length >= maxUserTurns) break;
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      assistants.unshift(assistantExcerpt(m));
      if (assistants.length >= maxAssistantTurns) break;
    }
  }

  const parts = [
    '<recent-dialogue-focus>',
    'The following excerpts are copied from IMMEDIATELY BEFORE compaction. They define current user intent and assistant state — prefer them over repetitive older tool output when interpreting the next step.',
    '',
    '## Recent user messages (oldest first among excerpt)',
    ...users.map((u, i) => `### User ${i + 1}\n${u}`),
    '',
    '## Recent assistant turns (oldest first among excerpt)',
    ...assistants.map((a, i) => `### Assistant ${i + 1}\n${a}`),
    '</recent-dialogue-focus>',
  ];

  return parts.join('\n');
}

/** 会改写文件内容、使之前读到的内容过时的工具 */
const FILE_MUTATING_TOOLS = new Set<string>([
  'write_file',
  'edit_file',
  'append_file',
  'batch_edit_file',
  'patch_file',
]);

function toolArgPath(args: Record<string, unknown> | undefined): string | undefined {
  const value = args?.path ?? args?.file_path ?? args?.filePath;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readLineSpan(msg: UnifiedMessage, args: Record<string, unknown> | undefined): [number, number] {
  const lines = msg.toolResultMeta?.lines;
  if (lines) return [lines.start, lines.end];
  const offset = typeof args?.offset === 'number' && args.offset > 0 ? args.offset : 1;
  const limit = typeof args?.limit === 'number' && args.limit > 0 ? args.limit : Infinity;
  return [offset, offset + limit - 1];
}

/**
 * 已被后来的读取（覆盖同一范围）或对同一文件的改写取代的 read_file 结果下标。
 * 只有这些旧读取会在微压缩中清理；未被取代的文件内容保留。
 */
function findSupersededReads(
  messages: UnifiedMessage[],
  toolCallIdToName: Map<string, string>,
  toolCallArgs: Map<string, Record<string, unknown>>,
): Set<number> {
  const reads: Array<{ idx: number; path: string; span: [number, number]; returnedLines: boolean }> = [];
  const writes: Array<{ idx: number; path: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || !msg.toolCallId) continue;
    const name = toolCallIdToName.get(msg.toolCallId);
    const args = toolCallArgs.get(msg.toolCallId);
    const rawPath = msg.toolResultMeta?.path ?? toolArgPath(args);
    if (!name || !rawPath) continue;
    const path = normalizeToolPath(rawPath);
    if (name === 'read_file') {
      // 有 meta 却没有 lines 的是失败读取（如范围超限被拒），不能取代旧读取；无 meta 的为历史消息
      const returnedLines = msg.toolResultMeta ? Boolean(msg.toolResultMeta.lines) : true;
      reads.push({ idx: i, path, span: readLineSpan(msg, args), returnedLines });
    } else if (FILE_MUTATING_TOOLS.has(name)) {
      writes.push({ idx: i, path });
    }
  }

  const superseded = new Set<number>();
  for (const read of reads) {
    const rewritten = writes.some(w => w.idx > read.idx && w.path === read.path);
    const reread = reads.some(r =>
      r.idx > read.idx
      && r.returnedLines
      && r.path === read.path
      && r.span[0] <= read.span[0]
      && r.span[1] >= read.span[1]);
    if (rewritten || reread) superseded.add(read.idx);
  }
  return superseded;
}

/** 发给模型的视图（封存优先） */
export function toolResultViewText(msg: UnifiedMessage): string {
  if (typeof msg.apiSealedContent === 'string') return msg.apiSealedContent;
  return typeof msg.content === 'string' ? msg.content : '';
}

/**
 * 被清理的工具结果的占位：声明它不是工具输出，并给出唯一可靠的找回方式。
 * - read_file：按路径和行号重读（拿到的是文件当前内容）；
 * - 有落盘原文：给出路径和读取方式；
 * - 都没有：明确说原文没有保存，只能重新执行工具。
 */
export function buildClearedToolResultStub(input: {
  msg: UnifiedMessage;
  toolName: string;
  args?: Record<string, unknown>;
  /** 清理原因，接在工具名后面 */
  reason?: string;
}): string {
  const { msg, toolName, args, reason } = input;
  const meta = msg.toolResultMeta;
  const size = `~${toolResultViewText(msg).length} chars`;
  const why = reason ? ` ${reason}.` : '';
  if (toolName === 'read_file') {
    const path = meta?.path ?? toolArgPath(args) ?? '(unknown)';
    const lines = meta?.lines;
    const span = lines ? `lines ${lines.start}-${lines.end} of ${lines.total}` : 'lines as in the original call';
    const reread = lines
      ? `read_file path=${path} offset=${lines.start} limit=${lines.end - lines.start + 1}`
      : `read_file path=${path} (offset/limit)`;
    return `${OLD_TOOL_STUB} read_file path=${path} ${span} (${size}).${why} `
      + `This placeholder is NOT the file content. To see it again: ${reread} — `
      + 'this returns the file\'s CURRENT content, which may differ if the file changed since.';
  }
  const status = typeof msg.content === 'string' && /^(Tool execution error|工具执行错误|工具调用被拒绝)/.test(msg.content)
    ? 'failed'
    : 'succeeded';
  const head = `${OLD_TOOL_STUB} tool=${toolName} status=${status} (${size}).${why} This placeholder is NOT the tool output.`;
  if (meta?.spillPath) {
    return `${head} Full original output saved at: ${meta.spillPath} — read it with ${spillReadHint(meta.spillPath)}.`;
  }
  return `${head} The original output was not saved; re-run the tool if you need it.`;
}

/**
 * 微压缩：把过时工具结果换成占位（返回新消息数组）。
 *
 * 占位写进 apiSealedContent（apiSealedBy: 'pressureClear'），content 保留原结果，
 * 占位里写明找回方式（重读文件范围 / 落盘路径）。清掉的不会再展开。
 */
export function applyLightMicrocompactToolClear(
  messages: UnifiedMessage[],
  options: {
    /** 保留最近若干「含 toolCalls 的 assistant」轮次内的工具正文 */
    keepLastAssistantToolRounds: number;
    toolCallIdToName: Map<string, string>;
    msgAssistantRound: Map<number, number>;
    currentAssistantRound: number;
    /** toolCallId → 调用参数（识别被取代的 read_file 需要路径与范围） */
    toolCallArgs?: Map<string, Record<string, unknown>>;
  },
): UnifiedMessage[] {
  const { keepLastAssistantToolRounds, toolCallIdToName, msgAssistantRound, currentAssistantRound } =
    options;
  const toolCallArgs = options.toolCallArgs ?? new Map<string, Record<string, unknown>>();
  const supersededReads = findSupersededReads(messages, toolCallIdToName, toolCallArgs);

  return messages.map((msg, idx) => {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg;
    if (msg.apiSealedBy === 'pressureClear') return msg;
    const r = msgAssistantRound.get(idx) ?? 0;
    if (currentAssistantRound - r <= keepLastAssistantToolRounds) return msg;

    const toolName = msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined;
    if (!toolName) return msg;
    const args = msg.toolCallId ? toolCallArgs.get(msg.toolCallId) : undefined;

    let stub: string;
    if (toolName === 'read_file') {
      if (!supersededReads.has(idx)) return msg;
      stub = buildClearedToolResultStub({ msg, toolName, args, reason: 'Superseded by a later read or edit of this file' });
    } else {
      if (FILE_TOOLS_NEVER_MICROCLEAR.has(toolName)) return msg;
      if (!LIGHT_MICROCLEAR_TOOLS.has(toolName)) return msg;
      if (toolName === 'run_command' && looksLikeFailedRunCommandOutput(msg.content)) return msg;
      // 没落盘的短结果清掉就找不回，省下的也不多
      if (!msg.toolResultMeta?.spillPath && toolResultViewText(msg).length <= SPILL_ALWAYS_MIN_CHARS) return msg;
      stub = buildClearedToolResultStub({ msg, toolName, args });
    }
    if (stub.length >= toolResultViewText(msg).length) return msg;

    return {
      ...msg,
      apiSealedContent: stub,
      apiSealedBy: 'pressureClear' as const,
    };
  });
}
