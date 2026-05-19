/**
 * TaskGraph Planner 共享类型定义。
 *
 * 覆盖设计文档 §4, §20.2, §21, §22, §25-§34 的全部核心类型。
 *
 * 依赖：仅 `./runtime-snapshot.js`（TaskIntent, TaskPhase）。
 * 不依赖任何 harness 文件。
 *
 * 设计文档：docs/任务图规划-设计文档.md
 */

import type { TaskIntent, TaskPhase } from './runtime-snapshot.js';

// ─── Schema Version ───

/** TaskGraph schema 版本号 */
export const TASK_GRAPH_SCHEMA_VERSION = 1 as const;

// ═══════════════════════════════════════════════
// §4 — Core Concepts
// ═══════════════════════════════════════════════

/** 节点执行类型 */
export type TaskNodeType =
  | 'inspect'     // 只读探查：理解代码、导航仓库
  | 'search'      // 搜索：查文件、搜内容
  | 'read'        // 读取：打开文件、获取内容
  | 'edit'        // 编辑：写文件、修改代码
  | 'verify'      // 验证：跑测试、lint、tsc
  | 'summarize'   // 总结：生成变更摘要
  | 'fallback'    // 回退：主路径失败后的替代策略
  | 'delegate';   // 委派：交给子代理处理

/** 节点运行时状态 */
export type TaskNodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

/** delegate 节点的委派配置 */
export interface TaskNodeDelegate {
  /** 委派任务描述 */
  task: string;
  /** 允许的工具白名单 */
  tools: string[];
  /** 最大轮次 */
  maxRounds?: number;
}

/** 任务图节点 */
export interface TaskNode {
  /** 图内唯一 ID，形如 node-01 */
  id: string;
  /** 节点类型 */
  type: TaskNodeType;
  /** 简短描述（中文，≤40 字） */
  title: string;
  /** 关联任务阶段 */
  phase: TaskPhase;
  /** 建议使用的工具名列表（可选） */
  suggestedTools?: string[];
  /** 是否需要工具调用 */
  requiresTool: boolean;
  /** 当前状态 */
  status: TaskNodeStatus;
  /** 进入 running 的时间戳 */
  startedAt?: number;
  /** 进入终态的时间戳 */
  endedAt?: number;
  /** 失败原因 */
  error?: string;
  /** 重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 关联证据（路径或命令） */
  evidence?: string;
  /** 委派配置（仅 delegate 类型有效） */
  delegate?: TaskNodeDelegate;
}

/** 任务边 */
export interface TaskEdge {
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  /** 边类型 */
  type: 'normal' | 'fallback';
  /** 触发条件描述（fallback 边时记录触发原因） */
  condition?: string;
}

/** 执行分支 */
export interface ExecutionBranch {
  /** 分支 ID */
  id: string;
  /** 分支中的节点 ID 列表（按执行顺序） */
  nodeIds: string[];
  /** 是否为后备分支 */
  isFallback: boolean;
  /** 触发此分支的原因 */
  triggerReason?: string;
}

/** 回退原因 */
export type FallbackReason =
  | 'retries_exceeded'
  | 'repeated_failure'
  | 'no_progress'
  | 'invalid_output'
  | 'verify_fail';

/** 后备分支 */
export interface FallbackBranch {
  /** 后备分支 ID */
  id: string;
  /** 主分支 ID（被替换的分支） */
  sourceBranchId: string;
  /** 原失败节点 ID */
  failedNodeId: string;
  /** 后备节点 ID 列表 */
  nodeIds: string[];
  /** 触发原因 */
  reason: FallbackReason;
  /** 已消耗的 fallback 次数 */
  attemptCount: number;
  /** 最大 fallback 次数 */
  maxAttempts: number;
}

/** 图级恢复信号 */
export interface GraphRecoverySignal {
  /** 信号来源 */
  source: 'branch_budget' | 'step_review' | 'node_failure' | 'verify_failure';
  /** 关联节点 ID */
  nodeId: string;
  /** 信号级别 */
  level: 'retry' | 'fallback' | 'abort';
  /** 简短描述 */
  message: string;
  /** 时间戳 */
  at: number;
}

/** 执行游标 */
export interface ExecutionCursor {
  /** 当前分支 ID */
  branchId: string;
  /** 当前节点 ID */
  nodeId: string;
  /** 当前节点在分支中的索引 */
  nodeIndex: number;
  /** 已完成的节点 ID 列表 */
  completedNodeIds: string[];
  /** 已跳过的节点 ID 列表 */
  skippedNodeIds: string[];
}

/** 节点执行历史记录 */
export interface NodeHistoryEntry {
  nodeId: string;
  status: 'done' | 'failed' | 'skipped';
  startedAt: number;
  endedAt: number;
  retries: number;
  error?: string;
}

/** 分支切换历史记录 */
export interface BranchHistoryEntry {
  branchId: string;
  reason: FallbackReason;
  at: number;
}

/** 任务图主结构 */
export interface TaskGraph {
  /** Schema 版本 */
  version: typeof TASK_GRAPH_SCHEMA_VERSION;
  /** 图 ID */
  graphId: string;
  /** 原始用户目标 */
  goal: string;
  /** 任务意图 */
  intent: TaskIntent;
  /** 所有节点（Map 形式便于查询） */
  nodes: Record<string, TaskNode>;
  /** 所有边 */
  edges: TaskEdge[];
  /** 主执行分支 */
  mainBranch: ExecutionBranch;
  /** 后备分支列表 */
  fallbackBranches: FallbackBranch[];
  /** 当前执行游标 */
  cursor: ExecutionCursor;
  /** 图状态 */
  status: 'ready' | 'running' | 'paused' | 'done' | 'failed';
  /** 整体进度百分比（0-100） */
  progress: number;
  /** 创建时间 */
  createdAt: number;
  /** 最近更新时间 */
  updatedAt: number;
  /** 节点执行历史 */
  nodeHistory: NodeHistoryEntry[];
  /** 分支切换历史 */
  branchHistory: BranchHistoryEntry[];
}

/** TaskGraph 持久化快照（精简版） */
export interface TaskGraphSnapshot {
  version: typeof TASK_GRAPH_SCHEMA_VERSION;
  graphId: string;
  goal: string;
  intent: TaskIntent;
  status: TaskGraph['status'];
  progress: number;
  cursor: {
    branchId: string;
    nodeId: string;
    nodeIndex: number;
    completedNodeIds: string[];
    skippedNodeIds: string[];
  };
  /** 保留节点状态（仅 status / retryCount / error，不含完整节点） */
  nodes: Record<string, { status: TaskNodeStatus; retryCount: number; error?: string }>;
  nodeHistory: NodeHistoryEntry[];
  branchHistory: BranchHistoryEntry[];
  updatedAt: number;
}

// ═══════════════════════════════════════════════
// §20 — Node Contract Layer
// ═══════════════════════════════════════════════

/** 输出信号类型 */
export type OutputSignal =
  | 'file_read'
  | 'file_written'
  | 'file_changed'
  | 'search_completed'
  | 'command_executed'
  | 'test_passed'
  | 'verification_done'
  | 'summary_generated'
  | 'delegate_done';

/** 完成条件 */
export interface CompletionCriteria {
  /** 需要的输出信号（至少 n 个满足） */
  requiredSignals: OutputSignal[];
  /** 最小工具调用次数（防止零工具就声称完成） */
  minToolCalls: number;
  /** 允许的最大轮次（超限 → 强制判定） */
  maxRounds: number;
  /** 是否允许模型显式声明 done（不依赖工具调用） */
  allowExplicitDone: boolean;
}

/** 偏离容忍度 */
export type DeviationTolerance = 'soft' | 'hard' | 'strict';

/** 节点守卫配置 */
export interface NodeGuardConfig {
  /** 连续无工具调用轮次上限 */
  maxIdleRounds: number;
  /** 单轮最大工具调用数 */
  maxToolsPerRound: number;
  /** 连续同工具调用上限（防止重复循环） */
  maxSameToolRepeat: number;
  /** 是否启用工具边界检查（拦截 forbiddenTools） */
  enforceToolBoundary: boolean;
  /** 偏离容忍度 */
  deviationTolerance: DeviationTolerance;
}

/** 节点执行合约 */
export interface NodeContract {
  /** 合约 ID（与 nodeId 一致） */
  nodeId: string;
  /** 允许的工具名列表（白名单） */
  allowedTools: string[];
  /** 禁止的工具名列表（黑名单，优先级高于 allowedTools） */
  forbiddenTools: string[];
  /** 偏好工具名列表（软建议，LLM 优先考虑但不强制） */
  preferredTools?: string[];
  /** 要求的输出信号 */
  requiredOutputSignals: OutputSignal[];
  /** 节点完成条件 */
  completionCriteria: CompletionCriteria;
  /** 节点守卫配置 */
  nodeGuard: NodeGuardConfig;
  /** 当前合约版本 */
  version: number;
}

/** 合约违规 */
export interface ContractViolation {
  /** 违规类型 */
  type: 'forbidden_tool' | 'idle_round' | 'repeat_tool' | 'missing_signal' | 'round_exceeded';
  /** 违规详情 */
  detail: string;
  /** 严重程度 */
  severity: 'info' | 'warning' | 'error';
}

/** 合约检查结果 */
export interface ContractCheckResult {
  /** 是否通过 */
  passed: boolean;
  /** 违规列表 */
  violations: ContractViolation[];
  /** 建议动作 */
  action: 'allow' | 'warn' | 'block' | 'force_switch';
  /** 解释信息（注入 system message） */
  message?: string;
}

// ═══════════════════════════════════════════════
// §26 — Node Cost Budget
// ═══════════════════════════════════════════════

/** 节点成本预算 */
export interface NodeCostBudget {
  /** Token 预算上限（输入+输出） */
  maxTokens: number;
  /** 最大轮次 */
  maxRounds: number;
  /** 最大工具调用次数 */
  maxToolCalls: number;
  /** 单次工具调用最大输出字符数 */
  maxToolOutputChars: number;
  /** 最大耗时（毫秒） */
  maxDurationMs: number;
}

/** 节点成本追踪器（运行时累加） */
export interface NodeCostTracker {
  /** 已消耗 token */
  tokensUsed: number;
  /** 已消耗轮次 */
  roundsUsed: number;
  /** 已调用工具次数 */
  toolCallsUsed: number;
  /** 开始时间 */
  startedAt: number;
  /** 预算耗尽类型 */
  exhaustedBy?: 'tokens' | 'rounds' | 'tool_calls' | 'duration';
  /** 预算使用率 (0-1) */
  utilizationRate: number;
}

// ═══════════════════════════════════════════════
// §27 — Escalation Policy
// ═══════════════════════════════════════════════

/** 升级级别（0=观察, 1=软纠正, 2=硬纠正, 3=分支切换） */
export type EscalationLevel = 0 | 1 | 2 | 3;

/** 升级动作 */
export type EscalationAction =
  | { type: 'none' }
  | { type: 'inject_hint'; message: string }
  | { type: 'block_and_reset'; blockedTools: string[]; message: string }
  | { type: 'force_branch_switch'; reason: FallbackReason };

/** 升级阈值 */
export interface EscalationThreshold {
  level: EscalationLevel;
  /** 触发此级别的连续偏离轮次 */
  consecutiveDeviations: number;
  /** 允许的最大纠正尝试次数 */
  maxCorrectionAttempts: number;
  /** 升级动作 */
  action: EscalationAction;
}

/** 升级历史记录 */
export interface EscalationEntry {
  fromLevel: EscalationLevel;
  toLevel: EscalationLevel;
  reason: string;
  at: number;
  nodeId: string;
}

/** 升级策略 */
export interface EscalationPolicy {
  /** 每级升级的阈值 */
  thresholds: EscalationThreshold[];
  /** 当前升级级别 */
  currentLevel: EscalationLevel;
  /** 升级历史 */
  history: EscalationEntry[];
}

// ═══════════════════════════════════════════════
// §20.4 — Deviation Detector
// ═══════════════════════════════════════════════

/** 纠正动作 */
export type CorrectionAction =
  | { type: 'inject_hint'; message: string }
  | { type: 'block_tool'; toolName: string }
  | { type: 'reset_node'; nodeId: string }
  | { type: 'force_branch_switch'; reason: string };

/** 偏离检测结果 */
export interface DeviationResult {
  /** 是否偏离 */
  deviated: boolean;
  /** 偏离类型 */
  type: 'tool_mismatch' | 'phase_mismatch' | 'scope_creep' | 'output_drift' | 'none';
  /** 严重程度 */
  severity: 'soft' | 'hard' | 'critical';
  /** 建议纠正动作 */
  correction: CorrectionAction;
  /** 偏离描述 */
  description: string;
}

// ═══════════════════════════════════════════════
// §29 — Repo Shape Discovery
// ═══════════════════════════════════════════════

/** 仓库类型 */
export type RepoType =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'cli_tool'
  | 'library'
  | 'unknown';

/** 仓库形态描述 */
export interface RepoShape {
  /** 仓库类型 */
  type: RepoType;
  /** 包管理器 */
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'none';
  /** 是否 monorepo */
  isMonorepo: boolean;
  /** 顶层目录结构特征 */
  topLevelDirs: string[];
  /** 测试框架 */
  testFramework: 'vitest' | 'jest' | 'mocha' | 'none';
  /** 类型系统 */
  typeSystem: 'typescript' | 'javascript' | 'mixed';
  /** Lint 工具 */
  lintTool: 'eslint' | 'biome' | 'none';
  /** 构建工具 */
  buildTool: 'tsc' | 'vite' | 'webpack' | 'none';
  /** 文件总数（估算） */
  estimatedFileCount: number;
  /** 最近变更的文件数 */
  recentChangeCount: number;
}

// ═══════════════════════════════════════════════
// §30 — Task Complexity Estimator
// ═══════════════════════════════════════════════

/** 复杂度等级 */
export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'hard';

/** 任务复杂度评估 */
export interface TaskComplexity {
  /** 复杂度等级 */
  level: ComplexityLevel;
  /** 综合评分 (0-100) */
  score: number;
  /** 各维度得分 */
  dimensions: {
    /** 目标文本长度指示的复杂度 (0-40) */
    goalComplexity: number;
    /** 仓库规模指示的复杂度 (0-30) */
    repoComplexity: number;
    /** 涉及文件数指示的复杂度 (0-30) */
    fileScopeComplexity: number;
  };
  /** 估算的节点数 */
  estimatedNodeCount: number;
  /** 建议的 maxRetries */
  suggestedMaxRetries: number;
  /** 是否需要 delegate 节点 */
  needsDelegate: boolean;
  /** 建议的 fallback 分支数 */
  suggestedFallbackCount: number;
}

// ═══════════════════════════════════════════════
// §32 — Graph Template Ranking
// ═══════════════════════════════════════════════

/** 模板适用条件 */
export interface TemplateCondition {
  field: 'complexity' | 'repoType' | 'testFramework' | 'fileCount';
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'in';
  value: string | number | string[];
}

/** 图模板 */
export interface GraphTemplate {
  /** 模板 ID */
  id: string;
  /** 适用意图 */
  intent: TaskIntent;
  /** 模板名称 */
  name: string;
  /** 节点类型序列 */
  nodeTypes: TaskNodeType[];
  /** 适用条件 */
  conditions: TemplateCondition[];
  /** 历史评分（运行时更新） */
  historicalScore: number;
  /** 使用次数 */
  usageCount: number;
  /** 最近一次使用的 graphId */
  lastUsedGraphId?: string;
}

// ═══════════════════════════════════════════════
// §33 — Failure Taxonomy
// ═══════════════════════════════════════════════

/** 失败大类 */
export type FailureCategory =
  | 'tool_error'
  | 'verification_fail'
  | 'context_missing'
  | 'contract_violation'
  | 'repo_mismatch'
  | 'permission_denied'
  | 'hallucinated_path'
  | 'branch_exhausted'
  | 'model_breakdown'
  | 'timeout'
  | 'token_exhausted';

/** 失败严重程度 */
export type FailureSeverity = 'recoverable' | 'degraded' | 'fatal';

/** 恢复动作 */
export type RecoveryAction =
  | { strategy: 'retry'; maxAttempts: number; backoffMs?: number }
  | { strategy: 'retry_with_hint'; hint: string }
  | { strategy: 'alternative_tool'; suggestedTools: string[] }
  | { strategy: 'narrow_scope'; message: string }
  | { strategy: 'expand_context'; method: 'sub_agent' | 'search' | 'read_more' }
  | { strategy: 'skip_node'; reason: string }
  | { strategy: 'switch_branch'; reason: FallbackReason }
  | { strategy: 'ask_user'; question: string }
  | { strategy: 'abort'; reason: string };

/** 分类后的失败记录 */
export interface ClassifiedFailure {
  /** 唯一 ID */
  failureId: string;
  /** 失败大类 */
  category: FailureCategory;
  /** 子类型（细化） */
  subType: string;
  /** 严重程度 */
  severity: FailureSeverity;
  /** 关联节点 ID */
  nodeId: string;
  /** 关联工具调用（如有） */
  toolName?: string;
  /** 工具参数签名（截断） */
  toolSignature?: string;
  /** 原始错误信息（截断 300 字符） */
  rawError: string;
  /** 分类后的建议恢复动作 */
  suggestedRecovery: RecoveryAction;
  /** 时间戳 */
  at: number;
}

// ═══════════════════════════════════════════════
// §21 — Graph Evaluation Metrics
// ═══════════════════════════════════════════════

/** 节点指标 */
export interface NodeMetrics {
  nodeId: string;
  nodeType: TaskNodeType;
  /** 执行耗时（ms） */
  duration: number;
  /** 重试次数 */
  retries: number;
  /** 工具调用总次数 */
  toolCount: number;
  /** 各工具调用次数分布 */
  toolDistribution: Record<string, number>;
  /** 输出质量评分（0-100，由信号完成度推算） */
  outputQuality: number;
  /** 验证评分（verify 节点专用，0-100） */
  verificationScore?: number;
  /** 是否成功 */
  success: boolean;
  /** 失败原因（如果有） */
  failureReason?: string;
  /** 信号完成率（requiredSignals 中完成的比例，0-1） */
  signalCompletionRate: number;
  /** 空转轮次（无工具调用） */
  idleRounds: number;
}

/** 分支指标 */
export interface BranchMetrics {
  branchId: string;
  /** 是否为后备分支 */
  isFallback: boolean;
  /** 包含的节点数 */
  nodeCount: number;
  /** Fallback 触发率（后备分支被激活的比例） */
  fallbackRate: number;
  /** 分支效率（成功节点数 / 总节点数） */
  branchEfficiency: number;
  /** 恢复成本（fallback 分支额外消耗的轮次） */
  recoveryCost: number;
  /** 分支死亡比（耗尽所有 fallback 的分支比例） */
  branchDeadRatio: number;
  /** 分支内节点平均评分 */
  avgNodeScore: number;
  /** 分支总耗时 */
  totalDuration: number;
}

/** 图级指标 */
export interface GraphMetrics {
  graphId: string;
  goal: string;
  intent: TaskIntent;
  /** 图完成评分（0-100） */
  completionScore: number;
  /** 确定性比率（按计划完成的比例 vs 走 fallback 的比例） */
  deterministicRatio: number;
  /** 恢复成功率（fallback 分支最终成功的比例） */
  recoverySuccessRate: number;
  /** 浪费步骤数（失败 + 跳过的节点） */
  wastedSteps: number;
  /** 成功置信度（综合考虑所有指标的 0-1 值） */
  successConfidence: number;
  /** 节点指标列表 */
  nodeMetrics: NodeMetrics[];
  /** 分支指标 */
  branchMetrics: BranchMetrics[];
  /** 总耗时 */
  totalDuration: number;
  /** 总轮次 */
  totalRounds: number;
  /** 总工具调用 */
  totalToolCalls: number;
  /** 评估时间戳 */
  evaluatedAt: number;
}

// ─── 评分函数签名（实现在 Phase 8） ───

/** 计算节点评分（0-100） */
export declare function calcNodeScore(metrics: NodeMetrics): number;

/** 计算分支效率（0-100） */
export declare function calcBranchEfficiency(metrics: BranchMetrics): number;

/** 计算成功置信度（0-1） */
export declare function calcSuccessConfidence(metrics: GraphMetrics): number;

// ═══════════════════════════════════════════════
// §22 — Graph Replay System
// ═══════════════════════════════════════════════

/** 回放类型 */
export type ReplayType =
  | 'full'
  | 'node'
  | 'branch'
  | 'checkpoint'
  | 'sub_agent'
  | 'tool'
  | 'failure';

/** 节点回放 */
export interface NodeReplay {
  nodeId: string;
  nodeType: TaskNodeType;
  status: 'done' | 'failed' | 'skipped';
  startedAt: number;
  endedAt: number;
  roundsUsed: number;
  /** 关联的 tool replay IDs */
  toolCallsInNode: string[];
  contractResult?: ContractCheckResult;
  deviationEvents: DeviationResult[];
}

/** 分支回放 */
export interface BranchReplay {
  branchId: string;
  isFallback: boolean;
  triggerReason?: FallbackReason;
  nodeReplayIds: string[];
  enteredAt: number;
  exitedAt?: number;
}

/** 工具回放 */
export interface ToolReplay {
  replayId: string;
  toolName: string;
  /** 简化的参数签名 */
  argsSignature: string;
  success: boolean;
  /** 输出截断（前 500 字符） */
  outputDigest?: string;
  /** 错误信息 */
  error?: string;
  duration: number;
  calledAt: number;
  /** 所属节点 */
  nodeId: string;
}

/** 故障回放 */
export interface FailureReplay {
  replayId: string;
  failureType: 'tool_error' | 'verification_fail' | 'contract_violation' | 'budget_exceeded';
  nodeId: string;
  toolReplayId?: string;
  errorMessage: string;
  recoveryAction: 'retry' | 'fallback' | 'abort';
  recoveredSuccessfully: boolean;
  at: number;
}

/** 子代理回放 */
export interface SubAgentReplay {
  replayId: string;
  delegateNodeId: string;
  task: string;
  roundsUsed: number;
  tokensUsed: number;
  filesRead: string[];
  status: 'completed' | 'max_rounds' | 'timeout' | 'error';
  summary: string;
  calledAt: number;
  endedAt: number;
}

/** checkpoint 断点回放 */
export interface CheckpointReplay {
  checkpointPath: string;
  status: string;
  graphSnapshot: TaskGraphSnapshot;
  loopState: { currentRound: number; totalToolCalls: number };
  savedAt: number;
}

/** 回放轨迹 */
export interface ReplayTrace {
  /** 回放 ID */
  replayId: string;
  /** 关联的 graphId */
  graphId: string;
  /** 回放类型 */
  replayType: ReplayType;
  /** 节点回放列表 */
  nodeReplays: NodeReplay[];
  /** 分支回放列表 */
  branchReplays: BranchReplay[];
  /** 工具回放列表（完整时间线） */
  toolReplays: ToolReplay[];
  /** 故障回放列表 */
  failureReplays: FailureReplay[];
  /** 子代理回放列表 */
  subAgentReplays: SubAgentReplay[];
  /** checkpoint 断点列表 */
  checkpointSnapshots: CheckpointReplay[];
  /** 回放起始时间 */
  startedAt: number;
  /** 回放结束时间 */
  endedAt: number;
}

// ═══════════════════════════════════════════════
// §34 — Graph Debug Dump
// ═══════════════════════════════════════════════

/** 图调试转储 */
export interface GraphDebugDump {
  /** 转储元数据 */
  meta: {
    graphId: string;
    dumpId: string;
    generatedAt: number;
    dumpVersion: 1;
    taskGoal: string;
    taskIntent: TaskIntent;
    finalStatus: 'done' | 'failed' | 'paused';
  };

  /** 图结构（完整节点 + 边 + 分支） */
  graph: {
    nodes: Record<string, TaskNode>;
    edges: TaskEdge[];
    mainBranch: ExecutionBranch;
    fallbackBranches: FallbackBranch[];
    cursor: ExecutionCursor;
  };

  /** 分支路径（执行轨迹） */
  branchPath: {
    branchesTaken: Array<{
      branchId: string;
      enteredAt: number;
      exitedAt?: number;
      isFallback: boolean;
      reason?: string;
    }>;
    finalBranchId: string;
  };

  /** 工具调用追踪（完整时间线） */
  toolTrace: Array<{
    callIndex: number;
    toolName: string;
    argsSignature: string;
    success: boolean;
    outputDigest?: string;
    errorDigest?: string;
    durationMs: number;
    nodeId: string;
    roundNumber: number;
    timestamp: number;
  }>;

  /** 偏离事件 */
  deviations: Array<{
    at: number;
    nodeId: string;
    deviationType: DeviationResult['type'];
    severity: DeviationResult['severity'];
    correction: CorrectionAction;
    escalationLevel: EscalationLevel;
  }>;

  /** Recovery 信号 */
  recoverySignals: Array<{
    at: number;
    nodeId: string;
    source: GraphRecoverySignal['source'];
    level: GraphRecoverySignal['level'];
    message: string;
    actionTaken: 'retry' | 'fallback' | 'abort' | 'ignored';
  }>;

  /** 失败分类 */
  classifiedFailures: Array<{
    failureId: string;
    category: FailureCategory;
    subType: string;
    severity: FailureSeverity;
    nodeId: string;
    suggestedRecovery: RecoveryAction;
    actualRecovery: string;
    recovered: boolean;
  }>;

  /** 合约违规 */
  contractViolations: Array<{
    nodeId: string;
    violationType: ContractViolation['type'];
    detail: string;
    roundNumber: number;
    resolved: boolean;
  }>;

  /** 指标快照 */
  metrics: GraphMetrics;

  /** 节点成本消耗 */
  nodeCosts: Record<string, {
    budget: NodeCostBudget;
    actual: { tokensUsed: number; roundsUsed: number; toolCallsUsed: number; durationMs: number };
    utilizationRate: number;
    exhausted: boolean;
    exhaustedBy?: string;
  }>;

  /** 升级历史 */
  escalationHistory: EscalationEntry[];

  /** Harness 循环摘要 */
  harnessSummary: {
    totalRounds: number;
    totalToolCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    stopReason: string;
    compactionCount: number;
  };
}

// ═══════════════════════════════════════════════
// §25 — Graph Session Boundary
// ═══════════════════════════════════════════════

/** 图会话状态 */
export type GraphSessionStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'discarded'
  | 'orphaned';

/** 图会话 */
export interface GraphSession {
  /** 关联的 graphId */
  graphId: string;
  /** 关联的 checkpoint taskId */
  taskId: string;
  /** 会话状态 */
  status: GraphSessionStatus;
  /** 用户原始目标 */
  goal: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间（用于 session 清理） */
  lastActiveAt: number;
  /** 在 Harness 会话中的序号（第几个任务） */
  sessionIndex: number;
}

// ═══════════════════════════════════════════════
// §31 — Preflight Scan Phase
// ═══════════════════════════════════════════════

/** 预检问题 */
export interface PreflightIssue {
  severity: 'warning' | 'error';
  type: 'file_not_found' | 'symbol_not_found' | 'ambiguous_reference' | 'missing_dependency';
  description: string;
  /** 关联的用户原始文本片段 */
  userText?: string;
}

/** 预检建议 */
export interface PreflightSuggestion {
  type: 'correct_path' | 'narrow_scope' | 'add_context' | 'split_task';
  message: string;
  /** 建议的新路径（correct_path 类型） */
  suggestedPath?: string;
}

/** 预检结果 */
export interface PreflightResult {
  /** 是否通过预检 */
  passed: boolean;
  /** 发现的问题 */
  issues: PreflightIssue[];
  /** 发现的相关文件（用于增强 context 节点） */
  discoveredFiles: string[];
  /** 发现的相关符号 */
  discoveredSymbols: string[];
  /** 建议调整 */
  suggestions: PreflightSuggestion[];
  /** 扫描耗时 */
  durationMs: number;
}

// ═══════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════

/** 空 TaskGraphSnapshot（用于初始化） */
export function emptyTaskGraphSnapshot(): TaskGraphSnapshot {
  return {
    version: TASK_GRAPH_SCHEMA_VERSION,
    graphId: '',
    goal: '',
    intent: 'question',
    status: 'ready',
    progress: 0,
    cursor: {
      branchId: '',
      nodeId: '',
      nodeIndex: 0,
      completedNodeIds: [],
      skippedNodeIds: [],
    },
    nodes: {},
    nodeHistory: [],
    branchHistory: [],
    updatedAt: 0,
  };
}
