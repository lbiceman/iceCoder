/**
 * Harness 运行时快照的共享数据结构。
 *
 * 供 TaskState / RepoContext 与 session-memory（持久化解析）共用，避免 memory ↔ harness 循环依赖。
 */

export type TaskIntent = 'question' | 'inspect' | 'edit' | 'debug' | 'test' | 'refactor' | 'docs';

export type TaskPhase = 'intent' | 'context' | 'editing' | 'verification' | 'final';

export type VerificationStatus = 'not_required' | 'required' | 'passed' | 'failed';

/** 与 TaskState.snapshot() 形状一致 */
export interface TaskStateSnapshot {
  goal: string;
  intent: TaskIntent;
  phase: TaskPhase;
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  verificationRequired: boolean;
  verificationStatus: VerificationStatus;
}

/** 与 RepoContext.snapshot() 形状一致 */
export interface RepoContextSnapshot {
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  testCommands: string[];
  recentDiagnostics: string[];
}

/** session-notes 中 icecoder-runtime 代码块内的 JSON schema 版本 */
export const PERSIST_RUNTIME_SCHEMA_VERSION = 1 as const;

/** 持久化到会话笔记的运行时载荷（版本化以便未来迁移） */
export interface PersistedRuntimeV1 {
  version: typeof PERSIST_RUNTIME_SCHEMA_VERSION;
  task: TaskStateSnapshot;
  repo: RepoContextSnapshot;
}
