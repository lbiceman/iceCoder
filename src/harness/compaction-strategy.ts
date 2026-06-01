/**
 * 压缩策略辅助：会话笔记截断、压缩边界元数据、近两轮对话聚焦、微压缩工具白名单。
 */

import type { UnifiedMessage } from '../llm/types.js';

/** 硬压缩注入会话笔记的最大字符（防止摘要独占 post-compact 预算） */
export const MAX_SESSION_NOTES_COMPACT_CHARS = 120_000;

/** 微压缩（light）时，超过若干轮后可清空正文的工具（对齐 claude-code microcompact 思想） */
export const LIGHT_MICROCLEAR_TOOLS = new Set<string>([
  'search_codebase',
  'grep_file',
  'run_command',
  'web_search',
  'fetch_url',
  'list_drives',
  'browse_directory',
  'open_file',
  'delegate_to_subagent',
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

/** 不参与「真实用户轮次」计数的注入块 */
export function isSyntheticUserBlockContent(content: string): boolean {
  const c = content.trimStart();
  return (
    c.startsWith('<system-reminder>')
    || c.startsWith('<context-summary>')
    || c.startsWith('<compact_boundary')
    || c.startsWith('<recent-dialogue-focus')
    || c.startsWith('<runtime-recovery-context>')
    || c.startsWith('<recent-file-contents>')
    || c.startsWith('<system-context>')
    || c.startsWith('<resume-checkpoint>')
  );
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
    const tail =
      typeof msg.content === 'string' && msg.content.trim()
        ? ` ${msg.content.trim().slice(0, 200)}`
        : '';
    return `[assistant tool_calls: ${names}]${tail}`;
  }
  const t = typeof msg.content === 'string' ? msg.content.trim() : '';
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

/** 微压缩：清空过时工具正文（返回新消息数组） */
export function applyLightMicrocompactToolClear(
  messages: UnifiedMessage[],
  options: {
    /** 保留最近若干「含 toolCalls 的 assistant」轮次内的工具正文 */
    keepLastAssistantToolRounds: number;
    toolCallIdToName: Map<string, string>;
    msgAssistantRound: Map<number, number>;
    currentAssistantRound: number;
  },
): UnifiedMessage[] {
  const { keepLastAssistantToolRounds, toolCallIdToName, msgAssistantRound, currentAssistantRound } =
    options;

  return messages.map((msg, idx) => {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') return msg;
    const r = msgAssistantRound.get(idx) ?? 0;
    if (currentAssistantRound - r <= keepLastAssistantToolRounds) return msg;

    const toolName = msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined;
    if (!toolName || FILE_TOOLS_NEVER_MICROCLEAR.has(toolName)) return msg;
    if (!LIGHT_MICROCLEAR_TOOLS.has(toolName)) return msg;

    const len = msg.content.length;
    return {
      ...msg,
      content: `${OLD_TOOL_STUB} tool=${toolName} (~${len} chars removed)`,
    };
  });
}
