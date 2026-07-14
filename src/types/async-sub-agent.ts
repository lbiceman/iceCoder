/**
 * Async Sub-Agent shared type definitions.
 *
 * This module is intentionally type-only and must not depend on harness
 * runtime modules. Runtime scheduling, persistence, and prompt wiring are
 * implemented in later phases.
 *
 * Design source: docs/requirement/sub-agent-sync.md
 * Task split: docs/requirement/异步子代理-phase拆分.md
 */

import type { TaskIntent, TaskPhase } from './runtime-snapshot.js';

/** Schema version for persisted async sub-agent task and artifact metadata. */
export const ASYNC_SUB_AGENT_SCHEMA_VERSION = 1 as const;

/** Supported read-only analysis agent roles. */
export type SubAgentKind =
  | 'explorer'
  | 'search'
  | 'review'
  | 'dependency'
  | 'test_analysis';

/** Lifecycle status for an async analysis task. */
export type AsyncSubAgentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

/** Stable terminal statuses for async analysis tasks. */
export type AsyncSubAgentTerminalStatus = Extract<
  AsyncSubAgentStatus,
  'completed' | 'failed' | 'timeout' | 'cancelled'
>;

/** Shared workspace layout relative to a session directory. */
export interface SubAgentWorkspaceLayout {
  /** Markdown summaries visible to the main agent. */
  analysisDir: string;
  /** Task metadata, queue state, and lifecycle records. */
  subtasksDir: string;
  /** Optional structured outputs and sidecar metadata. */
  artifactsDir: string;
}

/** Default relative directories for the session-level analysis workspace. */
export const DEFAULT_SUB_AGENT_WORKSPACE_LAYOUT: SubAgentWorkspaceLayout = {
  analysisDir: 'analysis',
  subtasksDir: 'subtasks',
  artifactsDir: 'artifacts',
};

/** Read-only capabilities available to async sub-agents. */
export type SubAgentAllowedCapability =
  | 'read'
  | 'search'
  | 'grep'
  | 'tree'
  | 'summary';

/** Capabilities that remain reserved to the main agent. */
export type SubAgentForbiddenCapability =
  | 'edit'
  | 'delete'
  | 'git'
  | 'terminal'
  | 'commit';

/** Permission declaration for the read-only sub-agent sandbox. */
export interface SubAgentPermissions {
  /** Capabilities exposed to the sub-agent. */
  allowed: SubAgentAllowedCapability[];
  /** Capabilities explicitly denied even if the main runtime supports them. */
  forbidden: SubAgentForbiddenCapability[];
}

/** Default permissions aligned with the existing read-only sub-agent runner. */
export const DEFAULT_SUB_AGENT_PERMISSIONS: SubAgentPermissions = {
  allowed: ['read', 'search', 'grep', 'tree', 'summary'],
  forbidden: ['edit', 'delete', 'git', 'terminal', 'commit'],
};

/** Scope used by the supervisor to dedupe and route analysis tasks. */
export interface AnalysisScope {
  /** Workspace-relative paths that bound the analysis, if known. */
  paths?: string[];
  /** Keywords, symbols, or feature names that identify the target area. */
  keywords?: string[];
  /** Optional stable hash for dedupe across equivalent requests. */
  scopeHash?: string;
}

/** Input accepted by the Analysis Supervisor when requesting background work. */
export interface RequestAnalysisInput {
  /** Session that owns the analysis workspace. */
  sessionId: string;
  /** Read-only sub-agent role to use. */
  kind: SubAgentKind;
  /** Detailed analysis prompt for the sub-agent. */
  prompt: string;
  /** Optional context injected into the sub-agent user message. */
  context?: string;
  /** Optional scope used for dedupe and key-decision waiting. */
  scope?: AnalysisScope;
  /** Current main-agent intent when the request is created. */
  intent?: TaskIntent;
  /** Current main-agent phase when the request is created. */
  phase?: TaskPhase;
  /** Source of the request for telemetry and debugging. */
  requestedBy?: 'main_agent' | 'supervisor' | 'system';
  /** Wall-clock request time; defaults to Date.now() in runtime code. */
  requestedAt?: number;
}

/** Immediate, non-blocking response returned to the main agent. */
export interface RequestAnalysisResult {
  /** Created or reused task id. */
  taskId: string;
  /** Whether this call created a new background task or reused an existing one. */
  submitted: boolean;
  /** Current task status at return time. */
  status: AsyncSubAgentStatus;
  /** Human-readable note safe to show in a tool result. */
  message?: string;
}

/** Persisted async analysis task metadata. */
export interface AsyncSubAgentTask {
  /** Schema version for future migrations. */
  version: typeof ASYNC_SUB_AGENT_SCHEMA_VERSION;
  /** Runtime-unique task id. */
  taskId: string;
  /** Owning session id. */
  sessionId: string;
  /** Read-only analysis role. */
  kind: SubAgentKind;
  /** Prompt sent to the sub-agent. */
  prompt: string;
  /** Optional context sent alongside the prompt. */
  context?: string;
  /** Optional scope used by the supervisor. */
  scope?: AnalysisScope;
  /** Current lifecycle status. */
  status: AsyncSubAgentStatus;
  /** Analysis Markdown path relative to the session analysis workspace. */
  artifactPath?: string;
  /** Workspace-relative files read by the sub-agent. */
  filesRead: string[];
  /** Number of sub-agent tool calls, if available. */
  toolCallCount?: number;
  /** Number of sub-agent reasoning/tool rounds, if available. */
  roundsUsed?: number;
  /** Token usage reported by the sub-agent runner, if available. */
  tokensUsed?: number;
  /** Wall-clock creation time. */
  createdAt: number;
  /** Wall-clock start time. */
  startedAt?: number;
  /** Wall-clock terminal time. */
  finishedAt?: number;
  /** Runtime error, timeout message, or cancellation reason. */
  error?: string;
}

/** Markdown artifact metadata written after a sub-agent completes. */
export interface AnalysisArtifact {
  /** Schema version for future migrations. */
  version: typeof ASYNC_SUB_AGENT_SCHEMA_VERSION;
  /** Artifact id; stable within a session. */
  id: string;
  /** Source analysis kind. */
  kind: SubAgentKind;
  /** Source async task id. */
  taskId: string;
  /** Owning session id. */
  sessionId: string;
  /** Markdown path relative to the session analysis workspace. */
  relativePath: string;
  /** Concise summary intended for main-agent prompt injection. */
  summary: string;
  /** Workspace-relative files read by the sub-agent. */
  filesRead: string[];
  /** Optional structured output generated from the Markdown summary. */
  output?: SubAgentOutput;
  /** Current source task status when the artifact was written. */
  status: AsyncSubAgentStatus;
  /** Wall-clock artifact creation time. */
  createdAt: number;
  /** Wall-clock time when the main agent consumed this artifact. */
  consumedAt?: number;
}

/** Payload carried by the AnalysisReady event. */
export interface AnalysisReadyEvent {
  /** Event type mirrored in SupervisorTimelineEventType. */
  event: 'analysis_ready';
  /** Owning session id. */
  sessionId: string;
  /** Completed task id. */
  taskId: string;
  /** Source analysis kind. */
  kind: SubAgentKind;
  /** Markdown artifact path relative to the session analysis workspace. */
  artifactPath: string;
  /** Short summary preview for prompt injection or UI notifications. */
  summaryPreview: string;
  /** Workspace-relative files read by the sub-agent. */
  filesRead: string[];
  /** Wall-clock event time. */
  createdAt: number;
}

/** Explorer output: project/module understanding. */
export interface ExplorerOutput {
  modules: string[];
  directories: string[];
  entrypoints: string[];
  dependencies: string[];
  callRelations: string[];
}

/** Search output: precise matches and references. */
export interface SearchOutput {
  files: string[];
  functions: string[];
  references: string[];
  keywords: string[];
}

/** Review output: risk-oriented code analysis. */
export interface ReviewOutput {
  risks: string[];
  suggestions: string[];
  possibleImpacts: string[];
}

/** Dependency output: imports and dependency graph hints. */
export interface DependencyOutput {
  imports: string[];
  callChains: string[];
  circularDependencies: string[];
}

/** Test-analysis output: coverage, failure, and test entry hints. */
export interface TestAnalysisOutput {
  coverage: string[];
  failureReasons: string[];
  testEntrypoints: string[];
}

/** Structured output union keyed by sub-agent kind. */
export type SubAgentOutput =
  | { kind: 'explorer'; data: ExplorerOutput }
  | { kind: 'search'; data: SearchOutput }
  | { kind: 'review'; data: ReviewOutput }
  | { kind: 'dependency'; data: DependencyOutput }
  | { kind: 'test_analysis'; data: TestAnalysisOutput };

/** Timeline payload for analysis request/start/update/finish events. */
export interface AnalysisTimelinePayload {
  sessionId: string;
  taskId: string;
  kind: SubAgentKind;
  status?: AsyncSubAgentStatus;
  artifactPath?: string;
  filesRead?: string[];
  error?: string;
}
