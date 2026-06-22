/**
 * Intent Checkpoint — 每条 User Message 对应的 Runtime 快照。
 *
 * 由 RuntimeRestoreCoordinator 统一读写；Restore 通过稳定 messageId 定位。
 */

import type { UnifiedMessage } from '../llm/types.js';
import type { SessionWorkspaceState } from '../harness/workspace-lock.js';
import type { CombinedCheckpointFile } from '../harness/checkpoint-engine.js';

export const INTENT_CHECKPOINT_VERSION = 1 as const;

/** 单轮 AI 回复的 token 消耗（用户消息 → agent 回复） */
export interface TurnTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** UI 层会话消息（data/sessions/{id}.json） */
export interface UiChatMessage {
  role: string;
  content?: string;
  id?: string;
  parentId?: string;
  toolName?: string;
  detail?: string;
  status?: string;
  toolCallId?: string;
  images?: string[];
  sentAt?: number;
  completedAt?: number;
  diffSource?: string;
  /** 本轮 agent 回复累计 token（刷新后仍可见） */
  turnTokenUsage?: TurnTokenUsage;
}

/** 单条 Intent Checkpoint 归档 */
export interface IntentCheckpointArchive {
  version: typeof INTENT_CHECKPOINT_VERSION;
  messageId: string;
  sessionId: string;
  createdAt: string;
  /** 用户消息时间戳（UI sentAt） */
  userMessageTime: number | null;
  combinedCheckpoint: CombinedCheckpointFile | null;
  workspace: SessionWorkspaceState;
  workspaceRoot: string;
  /** 工作区相对路径（POSIX）→ 文件内容；null 表示该路径当时不存在 */
  workspaceFiles: Record<string, string | null>;
  /** 当时已跟踪的全部路径（用于后续 restore 时清理新增文件） */
  trackedPaths: string[];
  structuredMessages: UnifiedMessage[];
  uiMessages: UiChatMessage[];
  /** 捕获时的 session-notes 全文（Restore 时写回） */
  sessionNotesContent?: string | null;
  /** 捕获时的 tool-trace-diffs 索引 JSON 字符串 */
  toolTraceDiffsRaw?: string | null;
}

export interface CheckpointIndexEntry {
  messageId: string;
  archiveFileName: string;
  createdAt: string;
  userMessageTime: number | null;
}

export interface CheckpointIndexFile {
  version: 1;
  /** CheckpointEngine 当前 cursor（最近 Intent 的 messageId） */
  cursorMessageId: string | null;
  entries: CheckpointIndexEntry[];
  /** 会话级累积 touched 路径（POSIX），用于 workspace 快照补全 */
  sessionTouchedPaths?: string[];
}

export function emptyCheckpointIndex(): CheckpointIndexFile {
  return { version: 1, cursorMessageId: null, entries: [] };
}
