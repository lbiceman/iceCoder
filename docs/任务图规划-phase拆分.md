# TaskGraph Planner — 工程实施 Phase 拆分

> 基于 `docs/任务图规划-设计文档.md`（§1-§34）的严格执行拆分。  
> 本文件不是设计文档。不增加新章节、不优化架构、不提出新方案。  
> 仅做执行拆分，每个 Phase 可独立交给 Cursor Composer Max 执行。
> 1,2,3,4,6,8,5,7,9

---

# Phase 1 — Core Types Layer

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §4 | Core Concepts（TaskNode, TaskEdge, ExecutionBranch, FallbackBranch, RecoverySignal, ExecutionCursor, TaskGraph） |
| §4.7 | TaskGraph 主接口 |
| §4.5 | GraphRecoverySignal |
| §20.2 | NodeContract, OutputSignal, CompletionCriteria, NodeGuardConfig, DeviationTolerance |
| §25.3 | GraphSession, GraphSessionStatus |
| §26.2 | NodeCostBudget, NodeCostTracker |
| §27.3 | EscalationPolicy, EscalationLevel, EscalationThreshold, EscalationAction, EscalationEntry |
| §29.2 | RepoShape, RepoType |
| §30.2 | TaskComplexity, ComplexityLevel |
| §32.3 | GraphTemplate, TemplateCondition |
| §33.2 | FailureCategory, FailureSeverity, ClassifiedFailure, RecoveryAction |
| §34.2 | GraphDebugDump（部分：核心类型，不含 builder 逻辑） |

## 2. Goals

- `src/types/task-graph.ts` 包含全部 TaskGraph 系统所需的 TypeScript 类型定义
- `npx tsc --noEmit` 零错误
- 所有类型仅依赖 `src/types/runtime-snapshot.ts`（`TaskIntent`, `TaskPhase`），不依赖任何 harness 文件
- 所有 interface 有完整的 JSDoc 注释

## 3. Files To Modify

无。

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/types/task-graph.ts` | 全部 TaskGraph 类型定义（~400 行） |

## 5. Task Checklist

- [ ] 创建 `src/types/task-graph.ts`
- [ ] 定义 `TaskNodeType` + `TaskNodeStatus` + `TaskNode` + `TaskNodeDelegate`
- [ ] 定义 `TaskEdge`
- [ ] 定义 `ExecutionBranch` + `FallbackBranch` + `FallbackReason`
- [ ] 定义 `GraphRecoverySignal`
- [ ] 定义 `ExecutionCursor`
- [ ] 定义 `TaskGraph` 主接口 + `TaskGraphSnapshot`
- [ ] 定义 `NodeHistoryEntry` + `BranchHistoryEntry`
- [ ] 定义 `NodeContract` + `OutputSignal` + `CompletionCriteria` + `NodeGuardConfig` + `DeviationTolerance`
- [ ] 定义 `ContractCheckResult` + `ContractViolation`
- [ ] 定义 `NodeCostBudget` + `NodeCostTracker`
- [ ] 定义 `EscalationPolicy` + `EscalationLevel` + `EscalationThreshold` + `EscalationAction` + `EscalationEntry`
- [ ] 定义 `DeviationResult` + `CorrectionAction`
- [ ] 定义 `RepoShape` + `RepoType`
- [ ] 定义 `TaskComplexity` + `ComplexityLevel`
- [ ] 定义 `GraphTemplate` + `TemplateCondition`
- [ ] 定义 `FailureCategory` + `FailureSeverity` + `ClassifiedFailure` + `RecoveryAction`
- [ ] 定义 `GraphMetrics` + `NodeMetrics` + `BranchMetrics` + 评分函数签名
- [ ] 定义 `ReplayTrace` + `NodeReplay` + `BranchReplay` + `ToolReplay` + `FailureReplay` + `SubAgentReplay` + `CheckpointReplay`
- [ ] 定义 `GraphDebugDump`
- [ ] 定义 `GraphSession` + `GraphSessionStatus`
- [ ] 定义 `PreflightResult` + `PreflightIssue` + `PreflightSuggestion`
- [ ] 运行 `npx tsc --noEmit` 验证

## 6. Validation

```bash
npx tsc --noEmit
```

人工验证项：
- 检查所有 import 仅来自 `./runtime-snapshot.js`
- 确认无循环依赖（task-graph.ts 不 import 任何 harness/* 文件）

## 7. Rollback

```bash
git checkout -- src/types/task-graph.ts   # 如果文件已存在
rm src/types/task-graph.ts                 # 如果文件是新创建的
```

Phase 1 不修改任何现有文件，回滚 = 删除新文件。

## 8. Dependency

无。本 Phase 是全部后续 Phase 的类型基础。

## 9. Forbidden Changes

- 不允许修改 `src/types/runtime-snapshot.ts`
- 不允许修改 `src/types/execution-plan.ts`
- 不允许修改 `src/types/runtime-checkpoint.ts`
- 不允许创建除 `src/types/task-graph.ts` 之外的任何文件
- 不允许 import 任何 `src/harness/*` 文件

## 10. Cursor Execution Notes

- **优先顺序**：从 TaskNode → TaskGraph → 子类型（Contract, Metrics, Replay）自顶向下
- **文件修改顺序**：仅创建 1 个文件
- **最大建议修改文件数**：1
- **中间验证节点**：每写完 3-4 个 interface 跑一次 `npx tsc --noEmit`
- `GraphMetrics` 中的 `calcNodeScore()` / `calcBranchEfficiency()` / `calcSuccessConfidence()` 只定义签名，不实现函数体（实现放在 Phase 8）

---

# Phase 2 — Graph Runtime Core

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §5 | Graph Lifecycle（create/start/advance/complete/skip/markDone/markFailed） |
| §8 | Graph Executor（节点状态转换：pending→running→done/failed/skipped） |
| §8.2 | 节点状态机 |
| §9 | Recovery Branching（switchToFallbackBranch, hasAvailableFallback） |
| §9.3 | 分支切换流程 |
| §25 | Graph Session Boundary（GraphSession 生命周期） |
| §28 | Graph Compaction（compactGraph 算法） |

## 2. Goals

- `src/harness/task-graph.ts` 提供完整的图 CRUD + 游标 + 分支 + 快照 + 压缩操作
- 纯函数/纯数据结构，不依赖 LLM、不依赖 Harness 内部状态
- 单元测试覆盖核心路径

## 3. Files To Modify

无。

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/harness/task-graph.ts` | 图核心操作（~400 行） |
| `test/task-graph.test.ts` | 单元测试（~250 行） |

## 5. Task Checklist

- [ ] 创建 `src/harness/task-graph.ts`
- [ ] 实现 `createTaskGraph(opts)` — 构建完整 TaskGraph
- [ ] 实现节点查询：`getCurrentNode`, `getNode`, `getCurrentBranchNodes`, `getMainBranchNodes`, `getFallbackBranchNodes`, `findNodesByType`, `hasPendingNodes`
- [ ] 实现游标操作：`advanceCursor`, `startCurrentNode`, `completeCurrentNode`, `skipCurrentNode`, `incrementRetry`
- [ ] 实现分支操作：`switchToFallbackBranch`, `hasAvailableFallback`, `getCurrentBranchId`
- [ ] 实现状态操作：`markGraphDone`, `markGraphFailed`, `markGraphPaused`
- [ ] 实现快照：`toSnapshot`, `applySnapshot`
- [ ] 实现恢复信号：`needsRecovery`
- [ ] 实现图压缩：`compactGraph(graph, config)`
- [ ] 实现 `GraphSession` 管理：`createGraphSession`, `transitionSession`, `findActiveSession`
- [ ] 实现内部辅助函数：`nodesToMap`, `buildDefaultEdges`, `recalcProgress`
- [ ] 创建 `test/task-graph.test.ts`
- [ ] 测试 `createTaskGraph` + 节点查询
- [ ] 测试 `startCurrentNode` → `completeCurrentNode` → `advanceCursor` 全流程
- [ ] 测试 `skipCurrentNode`
- [ ] 测试 `switchToFallbackBranch` + fallback 耗尽
- [ ] 测试 `toSnapshot` + `applySnapshot` 往返
- [ ] 测试 `compactGraph` 截断 nodeHistory
- [ ] 测试 `needsRecovery` 信号生成
- [ ] 运行 `npx vitest --run test/task-graph.test.ts`

## 6. Validation

```bash
npx tsc --noEmit
npx vitest --run test/task-graph.test.ts
```

## 7. Rollback

```bash
rm src/harness/task-graph.ts
rm test/task-graph.test.ts
```

## 8. Dependency

- **Phase 1 必须完成**（依赖 `src/types/task-graph.ts` 的全部类型）

## 9. Forbidden Changes

- 不允许修改 `src/harness/harness.ts`（Harness 集成在 Phase 5）
- 不允许修改 `src/harness/checkpoint*.ts`
- 不允许修改任何现有 harness 文件
- 不允许 import `ChatFunction` 或任何 LLM 类型

## 10. Cursor Execution Notes

- **优先顺序**：createTaskGraph → 节点查询 → 游标 → 分支 → 快照 → 压缩 → GraphSession
- **文件修改顺序**：先 `task-graph.ts`，测试驱动验证，再写 `test/task-graph.test.ts`
- **最大建议修改文件数**：2
- **中间验证节点**：每实现一个操作组（游标/分支/快照）跑一次 `npx tsc --noEmit`
- `startCurrentNode` → `completeCurrentNode` → `advanceCursor` 是最核心路径，必须优先保证正确

---

# Phase 3 — Graph Builder

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §7 | Planner Rules（intent → 图模板映射，规则驱动） |
| §7.1 | edit/debug/test/refactor/inspect 五种意图模板 |
| §7.2 | GraphBuildInput 输入参数 |
| §7.3 | buildGraph 算法 |
| §29 | Repo Shape Discovery |
| §29.3 | discover() 流程（读 package.json + 目录检测） |
| §30 | Task Complexity Estimator |
| §30.3 | estimateComplexity() 启发式算法 |
| §31 | Preflight Scan Phase |
| §31.3 | PreflightScanner.scan() 路径提取 + 符号搜索 |
| §32 | Graph Template Ranking |
| §32.4 | rankTemplates() 排序算法 |

## 3. Files To Modify

无。

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/harness/task-graph-builder.ts` | Builder + RepoShape + Complexity + Preflight + TemplateRanking（~450 行） |
| `test/task-graph-builder.test.ts` | 单元测试（~300 行） |

## 5. Task Checklist

- [ ] 创建 `src/harness/task-graph-builder.ts`
- [ ] 实现 `RepoShapeDiscovery.discover(workspaceRoot)` — 读 package.json + 检测 tsconfig/eslint/vitest
- [ ] 实现 `TaskComplexityEstimator.estimate(goal, repoShape?, changedFiles?)` — 纯启发式评分
- [ ] 实现 `PreflightScanner.scan(goal, repoShape, workspaceRoot)` — 路径提取 + fs.existsSync
- [ ] 实现 intent→template 映射（edit/debug/test/refactor/inspect 五种默认模板）
- [ ] 实现 `TemplateRanker.rank(intent, complexity, repoShape)` — 基于 conditions 筛选 + historicalScore 排序
- [ ] 实现 `GraphBuilder.build(input: GraphBuildInput)` — 组合上述模块
- [ ] 实现默认 GraphBuildInput 构造（从 goal + intent + repoContext 提取）
- [ ] 创建 `test/task-graph-builder.test.ts`
- [ ] 测试 edit 意图 → 5 节点模板
- [ ] 测试 debug 意图 → 5 节点模板
- [ ] 测试 inspect 意图 → 简化模板
- [ ] 测试 complexity='trivial' → 精简模板
- [ ] 测试 complexity='hard' → 含 delegate + 多 fallback
- [ ] 测试 RepoShapeDiscovery（mock package.json）
- [ ] 测试 PreflightScanner 路径存在/不存在
- [ ] 测试 TemplateRanker 不同条件的排序结果
- [ ] 运行 `npx vitest --run test/task-graph-builder.test.ts`

## 6. Validation

```bash
npx tsc --noEmit
npx vitest --run test/task-graph-builder.test.ts
```

## 7. Rollback

```bash
rm src/harness/task-graph-builder.ts
rm test/task-graph-builder.test.ts
```

## 8. Dependency

- **Phase 1 必须完成**（类型）
- **Phase 2 必须完成**（`createTaskGraph` 函数）

## 9. Forbidden Changes

- 不允许修改 `src/harness/task-state.ts`（复用 `inferIntent`，不修改它）
- 不允许修改 `src/harness/repo-context.ts`
- 不允许引入 LLM 调用（v1 纯规则驱动）

## 10. Cursor Execution Notes

- **优先顺序**：RepoShape → Complexity → Preflight → Template → Builder
- **文件修改顺序**：先 `task-graph-builder.ts`，再 `test/`
- **最大建议修改文件数**：2
- **中间验证节点**：每实现一个子模块跑一次 `npx tsc --noEmit`
- `PreflightScanner.scan()` 的 `fs.existsSync` 在测试时用 mock 文件系统或 temp 目录

---

# Phase 4 — Node Contract Layer

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §20 | Node Contract Layer（ContractValidator, DeviationDetector, nodeLock） |
| §20.3 | ContractValidator（checkBeforeToolCall, recordAfterToolCall, checkRoundEnd, checkCompletion） |
| §20.4 | DeviationDetector（detect, 复用 StepReview） |
| §20.5 | 完整状态流（Harness 循环中 contract 的生命周期） |
| §26 | Node Cost Budget（NodeCostTracker 运行时累加） |
| §26.4 | CostTracker 状态流 |
| §27 | Escalation Policy（四级升级） |
| §27.4 | 升级状态流 |
| §33 | Failure Taxonomy（classifyFailure 规则引擎） |
| §33.3 | 11 种失败分类规则 |
| §33.5 | EscalationPolicy × FailureTaxonomy 衔接 |

## 3. Files To Modify

无（本 Phase 是独立模块，Harness 接入在 Phase 5）。

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/harness/task-graph-review.ts` | ContractValidator + DeviationDetector + FailureClassifier + 内置 EscalationPolicy（~500 行） |
| `test/task-graph-review.test.ts` | 单元测试（~350 行） |

## 5. Task Checklist

- [ ] 创建 `src/harness/task-graph-review.ts`
- [ ] 实现 `ContractValidator` 类
- [ ] 实现 `checkBeforeToolCall(toolName)` — 返回 ContractCheckResult
- [ ] 实现 `recordAfterToolCall(toolName, success, signal?)`
- [ ] 实现 `checkRoundEnd(toolCallsThisRound)` — idle/round 检查
- [ ] 实现 `checkCompletion()` — 信号 + 工具调用次数判定
- [ ] 实现 `DeviationDetector` 类
- [ ] 实现 `detect(toolCalls, taskState)` — 工具/phase/scope 偏离检测
- [ ] 实现 `FailureClassifier.classify(error, toolName?, context?)` — 11 种分类规则
- [ ] 实现默认 `EscalationPolicy`（四级阈值 + 升级/降级逻辑）
- [ ] 实现 `NodeCostTracker` 类（tokens/rounds/toolCalls/duration 计数）
- [ ] 创建 `test/task-graph-review.test.ts`
- [ ] 测试 ContractValidator: allowedTools 通过
- [ ] 测试 ContractValidator: forbiddenTools 拒绝
- [ ] 测试 ContractValidator: idle 超限
- [ ] 测试 ContractValidator: maxRounds 超限
- [ ] 测试 DeviationDetector: tool_mismatch 检测
- [ ] 测试 DeviationDetector: phase_mismatch 检测
- [ ] 测试 DeviationDetector: scope_creep 检测
- [ ] 测试 FailureClassifier: tool_error/file_not_found
- [ ] 测试 FailureClassifier: verification_fail/test_failed
- [ ] 测试 FailureClassifier: hallucinated_path
- [ ] 测试 FailureClassifier: branch_exhausted → fatal
- [ ] 测试 EscalationPolicy: 软纠正 → 硬纠正 → 分支切换升级流程
- [ ] 测试 NodeCostTracker: 预算耗尽检测
- [ ] 运行 `npx vitest --run test/task-graph-review.test.ts`

## 6. Validation

```bash
npx tsc --noEmit
npx vitest --run test/task-graph-review.test.ts
```

## 7. Rollback

```bash
rm src/harness/task-graph-review.ts
rm test/task-graph-review.test.ts
```

## 8. Dependency

- **Phase 1 必须完成**（类型）
- **Phase 2 必须完成**（TaskGraph 操作，供 ContractValidator 读取节点状态）

## 9. Forbidden Changes

- 不允许修改 `src/harness/step-review.ts`（复用其 `ReviewToolTrace`，不修改其内部逻辑）
- 不允许修改 `src/harness/branch-budget.ts`
- 不允许修改 `src/harness/harness.ts`（接入在 Phase 5）
- 不允许引入实际 LLM 调用

## 10. Cursor Execution Notes

- **优先顺序**：ContractValidator → DeviationDetector → FailureClassifier → EscalationPolicy → NodeCostTracker
- **文件修改顺序**：先 `task-graph-review.ts`（全部实现放在一个文件），再 `test/`
- **最大建议修改文件数**：2
- **中间验证节点**：每个类实现完跑一次 `npx tsc --noEmit`
- `classifyFailure` 的 11 种规则建议先用 table-driven 方式实现（一个规则数组 + 循环匹配），便于后续扩展
- `DeviationDetector.detect()` 需要 `TaskStateSnapshot` 参数，测试时手动构造 snapshot

---

# Phase 5 — Harness Integration

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §3 | Proposed Architecture（TaskGraph 在 Harness 中的位置） |
| §3.2 | Harness 集成策略（可选增强，非替代） |
| §3.3 | 与 ExecutionPlanTracker 的并行关系 |
| §8.1 | Harness 消费当前节点（注入 system reminder） |
| §8.3 | 工具行为约束（节点类型 → 允许/阻止的工具） |
| §20.5 | Node Contract 在 Harness 循环中的完整状态流 |
| §20.6 | 与 PermissionManager / TaskState / StepReview / BranchBudget 的接入点 |
| §16 | 配置与开关（ICE_TASK_GRAPH 环境变量） |

## 3. Files To Modify

| 路径 | 改动描述 |
|---|---|
| `src/harness/harness.ts` | ~80 行新增：构造函数注入 GraphExecutor、任务切换时初始化/重置 TaskGraph、工具调用前 contract 检查、节点完成后 advance cursor |
| `src/harness/index.ts` | 新增导出：`TaskGraph`, `GraphExecutor`, `TaskGraphBuilder` 相关 |

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/harness/task-graph-executor.ts` | GraphExecutor 类（~150 行） |
| `src/harness/task-graph-config.ts` | `isTaskGraphEnabled()` + 环境变量读取（~20 行） |
| `test/task-graph-executor.test.ts` | 集成测试（~200 行） |

## 5. Task Checklist

- [ ] 创建 `src/harness/task-graph-config.ts`
- [ ] 实现 `isTaskGraphEnabled()` — 读 `ICE_TASK_GRAPH` 环境变量
- [ ] 创建 `src/harness/task-graph-executor.ts`
- [ ] 实现 `GraphExecutor` 类：持有 TaskGraph + ContractValidator + DeviationDetector + EscalationPolicy
- [ ] 实现 `initGraph(goal, intent, repoContext)` — 调用 Builder → 创建 graph
- [ ] 实现 `getCurrentNodeContext()` — 返回注入 Harness 的 system reminder 文本
- [ ] 实现 `checkToolCall(toolName)` — 委托 ContractValidator + DeviationDetector
- [ ] 实现 `recordToolResult(toolName, success, signal?)` — 委托 ContractValidator
- [ ] 实现 `evaluateRound(toolCallsThisRound)` — 委托 EscalationPolicy + ContractValidator
- [ ] 实现 `advanceOrComplete()` — 节点完成 → advance / markDone
- [ ] 修改 `src/harness/harness.ts`
- [ ] 构造函数：注入 `GraphExecutor`（可选，根据 feature flag）
- [ ] 任务切换检测后（L690-L720）：调用 `graphExecutor.initGraph()` 或 `graphExecutor.resetGraph()`
- [ ] LLM 调用前：调用 `graphExecutor.getCurrentNodeContext()` → 注入到 messages
- [ ] 工具调用执行前（L1100-L1150）：调用 `graphExecutor.checkToolCall(tc.name)` → 决定 allow/warn/block
- [ ] 工具调用执行后：调用 `graphExecutor.recordToolResult(tc.name, success, detectSignal())`
- [ ] 每轮结束：调用 `graphExecutor.evaluateRound(toolCallsThisRound)` → 处理 escalation
- [ ] 循环 break 前：调用 `graphExecutor.advanceOrComplete()`
- [ ] 修改 `src/harness/index.ts`：新增导出
- [ ] 创建 `test/task-graph-executor.test.ts`（mock Harness 环境）
- [ ] 运行 `npx vitest --run test/task-graph-executor.test.ts`
- [ ] 手动测试：`ICE_TASK_GRAPH=1 npm run dev` 验证现有功能不受影响

## 6. Validation

```bash
npx tsc --noEmit
npx vitest --run test/task-graph-executor.test.ts

# 回归测试：确保 ICE_TASK_GRAPH 未设置时 Harness 行为不变
npx vitest --run                          # 全部已有测试通过
```

人工验证项：
- `ICE_TASK_GRAPH=0`（或不设置）时，Harness 行为与 Phase 5 前完全一致
- `ICE_TASK_GRAPH=1` 时，system reminder 中包含当前节点信息

## 7. Rollback

```bash
# 恢复 harness.ts 和 index.ts
git checkout -- src/harness/harness.ts src/harness/index.ts

# 删除新建文件
rm src/harness/task-graph-executor.ts
rm src/harness/task-graph-config.ts
rm test/task-graph-executor.test.ts
```

## 8. Dependency

- **Phase 1-4 必须全部完成**

## 9. Forbidden Changes

- 不允许改变 Harness 循环的现有 stop 条件
- 不允许修改 `PermissionManager` 的全局权限逻辑
- 不允许修改 `StreamingToolExecutor` 的行为
- 不允许修改 `ContextCompactor` / `LoopController` / `StopHookManager`
- 不允许修改前端文件
- 不允许修改 checkpoint 文件

## 10. Cursor Execution Notes

- **优先顺序**：config → executor → harness.ts 集成点（按行号顺序）
- **文件修改顺序**：先创建 `task-graph-config.ts` → `task-graph-executor.ts` → 改 `harness.ts` → 改 `index.ts` → 最后写测试
- **最大建议修改文件数**：5（2 个新文件 + 2 个修改 + 1 个测试）
- **关键风险点**：`harness.ts` 的工具调用循环（L1100-L1150 区域）是性能热点，contract 检查必须 O(1)，不能引入 I/O
- 所有 GraphExecutor 方法调用必须包在 `if (this.graphExecutor)` 判断中（feature flag 关闭时为 null）
- 不要改变 `harness.ts` 中现有变量的命名和结构
- **中间验证节点**：每修改 `harness.ts` 的一个集成点跑一次 `npx tsc --noEmit`

---

# Phase 6 — Persistence Layer

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §10 | Checkpoint Integration（CombinedCheckpointFile 新增 taskGraph 字段） |
| §10.2 | TaskGraphSnapshot 持久化格式 |
| §10.3 | 持久化 Trigger（task_graph_node_done, task_graph_branch_switch 等） |
| §10.4 | 向后兼容（taskGraph 字段为可选） |
| §10.5 | Session Notes fence（icecoder-graph, icecoder-metrics, icecoder-debug） |
| §15 | Session Recovery（从 checkpoint 恢复 TaskGraph） |
| §15.1 | Checkpoint 恢复流程 |
| §15.2 | Session Notes 恢复（parsePersistedTaskGraph） |
| §21.6 | GraphMetrics 持久化 |
| §25 | Graph Session Boundary 持久化 |
| §34.3-34.4 | GraphDebugDump 生成时机与文件写入 |

## 3. Files To Modify

| 路径 | 改动描述 |
|---|---|
| `src/harness/checkpoint-engine.ts` | `CombinedCheckpointFile` 新增可选字段 `taskGraph?: TaskGraphSnapshot`, `graphMetrics?: GraphMetrics`, `graphSession?: GraphSession`；`save()` 时写入这些字段 |
| `src/memory/file-memory/session-memory.ts` | 新增 `icecoder-graph` / `icecoder-metrics` / `icecoder-debug` fence 读写函数（复制现有 `icecoder-plan` fence 模式） |

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/harness/task-graph-persistence.ts` | 持久化辅助函数：`buildGraphFence`, `parseGraphFence`, `buildMetricsFence`, `parseMetricsFence`, `buildDebugFence`（~150 行） |
| `test/task-graph-persistence.test.ts` | 持久化测试（~200 行） |

## 5. Task Checklist

- [ ] 创建 `src/harness/task-graph-persistence.ts`
- [ ] 实现 `serializeGraphSnapshot(snapshot)` → JSON string
- [ ] 实现 `parsePersistedGraph(notes: string)` → TaskGraphSnapshot | null
- [ ] 实现 `buildGraphFence(graph)` → fenced markdown string
- [ ] 实现 `buildMetricsFence(metrics)` → fenced markdown string
- [ ] 实现 `buildDebugFence(dump)` → fenced markdown string
- [ ] 实现 `parsePersistedMetrics(notes)` → GraphMetrics | null
- [ ] 实现 `parsePersistedDebug(notes)` → GraphDebugDump | null
- [ ] 修改 `src/harness/checkpoint-engine.ts`
- [ ] `CombinedCheckpointFile` 接口新增：`taskGraph?: TaskGraphSnapshot`, `graphMetrics?: GraphMetrics`, `graphSession?: GraphSession`
- [ ] `CheckpointSaveInput` 新增：`taskGraphSnapshot?`, `graphMetrics?`, `graphSession?`
- [ ] `save()` 方法：将新增字段写入 combined JSON
- [ ] `loadV2()` 方法：返回新增字段（如果存在）
- [ ] 修改 `src/memory/file-memory/session-memory.ts`
- [ ] 新增 `ICECODER_GRAPH_FENCE_LANG = 'icecoder-graph'`
- [ ] 新增 `ICECODER_METRICS_FENCE_LANG = 'icecoder-metrics'`
- [ ] 新增 `ICECODER_DEBUG_FENCE_LANG = 'icecoder-debug'`
- [ ] 新增 `writeGraphFence()`, `writeMetricsFence()`, `writeDebugFence()` 函数（复制 `buildPlanFence` 模式）
- [ ] 导出新 fence 常量供外部使用
- [ ] 创建 `test/task-graph-persistence.test.ts`
- [ ] 测试 `toSnapshot` → `serializeGraphSnapshot` → `parsePersistedGraph` 往返
- [ ] 测试旧 checkpoint JSON（无 taskGraph 字段）加载不报错
- [ ] 测试 fence 解析（取最后一个 `icecoder-graph` block）
- [ ] 测试无效 JSON → 返回 null
- [ ] 测试版本不匹配 → 返回 null
- [ ] 运行 `npx vitest --run test/task-graph-persistence.test.ts`

## 6. Validation

```bash
npx tsc --noEmit
npx vitest --run test/task-graph-persistence.test.ts

# 回归：现有 checkpoint 兼容性
npx vitest --run                          # 全部已有测试通过
```

人工验证项：
- 使用已有的 session checkpoint JSON 文件，确认加载不报错
- 手动创建 `icecoder-graph` fence，确认解析正确

## 7. Rollback

```bash
git checkout -- src/harness/checkpoint-engine.ts src/memory/file-memory/session-memory.ts
rm src/harness/task-graph-persistence.ts
rm test/task-graph-persistence.test.ts
```

## 8. Dependency

- **Phase 1-2 必须完成**（类型 + 快照操作）
- **Phase 5 不强制**，但建议 Phase 5 先完成以便 end-to-end 验证

## 9. Forbidden Changes

- 不允许修改 `TaskCheckpointManager`（v1 checkpoint 格式）
- 不允许修改 `runtimeV2` 字段的现有结构
- 不允许删除或重命名现有的 fence 类型（`icecoder-runtime`, `icecoder-plan`）
- 不允许修改前端文件

## 10. Cursor Execution Notes

- **优先顺序**：persistence 辅助函数 → checkpoint-engine 扩展 → session-memory fence → 测试
- **文件修改顺序**：先创建 `task-graph-persistence.ts` → 改 `checkpoint-engine.ts` → 改 `session-memory.ts` → 测试
- **最大建议修改文件数**：4（1 新 + 2 修改 + 1 测试）
- **关键风险点**：`CombinedCheckpointFile` 新增字段必须是可选的（`?`），确保向后兼容
- `session-memory.ts` 的 fence 读写函数直接复制现有 `buildPlanFence` / `parsePersistedPlan` 的实现模式，最小改动

---

# Phase 7 — Frontend Projection

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §12 | Execution Transparency Integration（graph → plan 投影） |
| §12.2 | 新增事件类型（task_graph_init/node/branch/done） |
| §13 | Web Execution Panel Integration（面板渲染扩展） |
| §13.2 | TaskGraph UI 映射到现有面板 |
| §13.3 | 前端事件处理（chat-page.js onWsStep 扩展） |
| §13.4 | 分支标记（✅🔄⬜❌⏭️🔀⚠️） |
| §14 | Ice Bean Pet 系统集成 |
| §14.2 | 冰豆表情扩展映射 |

## 3. Files To Modify

| 路径 | 改动描述 |
|---|---|
| `src/public/js/chat-page.js` | `onWsStep` 新增 ~25 行处理 `task_graph_*` 事件 |
| `src/public/js/chat-execution-plan.js` | `renderStepNode` 新增分支标记样式 ~20 行 |
| `src/public/js/chat-execution-plan-bridge.js` | `handleStep` 新增 ~15 行 graph 事件路由 |
| `src/public/js/chat-pet-bridge.js` | `applyHarnessStepToPet` 新增 graph 事件 → 表情映射 ~15 行 |

## 4. Files To Create

无。

## 5. Task Checklist

- [ ] 修改 `chat-page.js`
- [ ] `onWsStep` 新增 `case 'task_graph_init'` → 调用 `ChatExecutionPlanBridge.handleGraphInit(step)`
- [ ] `onWsStep` 新增 `case 'task_graph_node'` → 更新面板节点状态
- [ ] `onWsStep` 新增 `case 'task_graph_branch'` → 面板高亮分支切换 + 冰豆表情
- [ ] `onWsStep` 新增 `case 'task_graph_done'` → 面板标记完成 + 冰豆回 idle
- [ ] 修改 `chat-execution-plan-bridge.js`
- [ ] 新增 `handleGraphInit(step)` — 调用 `ChatExecutionPlan.renderGraph(step)`
- [ ] 新增 `handleGraphNode(step)` — 调用 `ChatExecutionPlan.updateNode(step)`
- [ ] 新增 `handleGraphBranch(step)` — 调用 `ChatExecutionPlan.highlightBranch(step)`
- [ ] 修改 `chat-execution-plan.js`
- [ ] `renderStepNode` 新增 `data-branch` 属性（区分主分支/fallback 分支）
- [ ] 新增分支标记 CSS 类：`exec-plan-step--fallback`, `exec-plan-step--resumed`
- [ ] 新增状态图标映射：✅ done, 🔄 running, ⬜ pending, ❌ failed, ⏭️ skipped, 🔀 fallback
- [ ] 修改 `chat-pet-bridge.js`
- [ ] `applyHarnessStepToPet` 新增 graph 事件映射：`task_graph_init`→thinking, `task_graph_node(running)`→thinking, `task_graph_node(failed)`→alert, `task_graph_branch`→alert, `task_graph_done(done)`→happy, `task_graph_done(failed)`→sad
- [ ] 手动测试：启动 `npm run dev` + `ICE_TASK_GRAPH=1`，发任务观察面板和冰豆

## 6. Validation

```bash
npx tsc --noEmit       # 前端 JS 不涉及 TS 编译
```

人工验证项：
- 面板正确显示 TaskGraph 节点列表（而非 ExecutionPlan steps）
- 当前节点高亮
- 分支切换后面板更新分支标记
- 冰豆表情随节点状态变化
- `ICE_TASK_GRAPH=0` 时面板回退到现有 ExecutionPlan 渲染

## 7. Rollback

```bash
git checkout -- src/public/js/chat-page.js
git checkout -- src/public/js/chat-execution-plan.js
git checkout -- src/public/js/chat-execution-plan-bridge.js
git checkout -- src/public/js/chat-pet-bridge.js
```

## 8. Dependency

- **Phase 5 必须完成**（Harness 发射 `task_graph_*` WebSocket 事件）
- **Phase 6 不强制**，但建议 Phase 6 先完成以便完整 end-to-end

## 9. Forbidden Changes

- 不允许新增前端文件
- 不允许修改 `session-pet.js`（冰豆 20 种表情已覆盖，无需新增绘制逻辑）
- 不允许修改 `main.js`
- 不允许改变现有 ExecutionPlan 面板的渲染逻辑（仅在 TaskGraph 事件进入时走新路径）
- 不允许删除现有事件处理

## 10. Cursor Execution Notes

- **优先顺序**：bridge → panel 渲染 → chat-page 事件 → pet 映射
- **文件修改顺序**：`chat-execution-plan-bridge.js` → `chat-execution-plan.js` → `chat-page.js` → `chat-pet-bridge.js`
- **最大建议修改文件数**：4（全部是修改现有文件）
- **改动量预估**：总计 ~75 行，分散在 4 个文件中
- 所有新事件处理必须先检查 `step.type` 再执行，避免未定义事件导致 JS 错误
- 面板渲染扩展通过 CSS class 控制分支样式，不改变现有 DOM 结构

---

# Phase 8 — Metrics + Replay

## 1. Scope

覆盖设计章节：

| 章节 | 内容 |
|---|---|
| §21 | Graph Evaluation Metrics |
| §21.2 | NodeMetrics + calcNodeScore |
| §21.3 | BranchMetrics + calcBranchEfficiency |
| §21.4 | GraphMetrics + calcSuccessConfidence |
| §21.5 | 与 ExecutionPlanTracker / RuntimeSnapshot / CheckpointEngine 整合 |
| §22 | Graph Replay System |
| §22.3 | ReplayTrace + 子类型 |
| §22.4 | Replay 构建流程 |
| §22.6 | 与 Eval Runner 对接 |
| §23 | Integration With Eval Runner |
| §23.3 | EvalBenchmark + EvalCase |
| §23.4 | 完整运行流程 |
| §23.5 | 命令行接口设计 |

## 3. Files To Modify

无。

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/harness/task-graph-metrics.ts` | 指标计算 + Replay 构建（~300 行） |
| `scripts/eval-runner.ts` | Eval Runner CLI 脚本（~200 行） |
| `test/task-graph-metrics.test.ts` | 指标 + 回放测试（~300 行） |

## 5. Task Checklist

- [ ] 创建 `src/harness/task-graph-metrics.ts`
- [ ] 实现 `calcNodeScore(metrics: NodeMetrics): number`
- [ ] 实现 `calcBranchEfficiency(metrics: BranchMetrics): number`
- [ ] 实现 `calcSuccessConfidence(metrics: GraphMetrics): number`
- [ ] 实现 `buildGraphMetrics(graph, nodeHistory, branchHistory, toolTrace): GraphMetrics`
- [ ] 实现 `ReplayBuilder.build(graphId, checkpoint, sessionNotes): ReplayTrace`
- [ ] 实现 `ReplayBuilder.buildToolTrace(runtimeV2): ToolReplay[]`
- [ ] 实现 `ReplayBuilder.buildFailureTrace(runtimeV2): FailureReplay[]`
- [ ] 实现 `ReplayBuilder.buildNodeReplays(graph, toolTrace): NodeReplay[]`
- [ ] 创建 `scripts/eval-runner.ts`
- [ ] 实现 CLI 参数解析：`--benchmark`, `--all`, `--replay`, `--format`, `--output`
- [ ] 实现 `loadBenchmark(name): EvalBenchmark`
- [ ] 实现 `runCase(evalCase): EvalOutput`
- [ ] 实现 `runReplay(graphId): EvalOutput`
- [ ] 实现 `generateReport(results): string` (markdown + json)
- [ ] 创建 `test/task-graph-metrics.test.ts`
- [ ] 测试 `calcNodeScore` 各场景（成功/重试/失败）
- [ ] 测试 `calcSuccessConfidence` 加权计算
- [ ] 测试 `ReplayBuilder.build` 完整流程（mock checkpoint + session notes）
- [ ] 测试 ReplayTrace 与原始 GraphMetrics 数据一致性
- [ ] 运行 `npx vitest --run test/task-graph-metrics.test.ts`
- [ ] 手动测试：`npx tsx scripts/eval-runner.ts --replay <test-graph-id>`

## 6. Validation

```bash
npx tsc --noEmit
npx vitest --run test/task-graph-metrics.test.ts
npx tsx scripts/eval-runner.ts --help     # 确认 CLI 可执行
```

## 7. Rollback

```bash
rm src/harness/task-graph-metrics.ts
rm scripts/eval-runner.ts
rm test/task-graph-metrics.test.ts
```

## 8. Dependency

- **Phase 1-2 必须完成**（类型 + TaskGraph 操作）
- **Phase 6 建议完成**（需要从 checkpoint + session notes 读取数据来构建 ReplayTrace）

## 9. Forbidden Changes

- 不允许修改 `scripts/agent-eval.ts`（现有 eval 脚本）
- 不允许修改 `package.json` 的 scripts
- 不允许修改任何 harness 核心文件

## 10. Cursor Execution Notes

- **优先顺序**：calcNodeScore → calcBranchEfficiency → calcSuccessConfidence → buildGraphMetrics → ReplayBuilder → eval-runner
- **文件修改顺序**：`task-graph-metrics.ts` → `test/task-graph-metrics.test.ts` → `eval-runner.ts`
- **最大建议修改文件数**：3
- `ReplayBuilder` 需要 mock `CombinedCheckpointFile` 和 session-notes 内容进行测试
- `eval-runner.ts` 作为独立 CLI 脚本，使用 `tsx` 执行，不需要 tsc 编译

---

# Phase 9 — Hardening

## 1. Scope

覆盖设计章节（全部兜底 + 边界条件）：

| 章节 | 内容 |
|---|---|
| §33 | Failure Taxonomy（classifyFailure 边界情况 + 与 EscalationPolicy 联调） |
| §34 | Graph Debug Dump（generate 时机 + 完整 JSON 输出验证） |
| §24 | Updated Implementation Order（按实际执行结果调整） |
| 全文档 | 边界条件：空 goal、未知 intent、checkpoint 损坏、fence 解析失败、并发任务切换、超大 nodeHistory、token 归零 |
| 全文档 | 性能：contract 检查 O(1)、compaction 不阻塞主循环、debug dump 异步写入 |

## 3. Files To Modify

| 路径 | 改动描述 |
|---|---|
| `src/harness/task-graph.ts` | 边界条件加固（空节点/空分支/无效 cursor） |
| `src/harness/task-graph-builder.ts` | 未知 intent 回退到 inspect 模板 |
| `src/harness/task-graph-review.ts` | classifyFailure 未知错误兜底 |
| `src/harness/task-graph-executor.ts` | contract 检查 O(1) 性能审计 |
| `src/harness/task-graph-persistence.ts` | 损坏 JSON / 版本不匹配 / 空 fence 兜底 |

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `test/task-graph-edge-cases.test.ts` | 边界条件测试（~250 行） |
| `docs/任务图规划-实施总结.md` | 实施完成后的总结文档 |

## 5. Task Checklist

- [ ] 边界条件加固
- [ ] `task-graph.ts`: `getCurrentNode` 在 cursor.nodeId 不存在时返回 undefined
- [ ] `task-graph.ts`: `advanceCursor` 在分支无更多节点时返回 undefined
- [ ] `task-graph.ts`: `switchToFallbackBranch` 在无可用 fallback 时返回 null
- [ ] `task-graph.ts`: `toSnapshot` 处理空 nodes
- [ ] `task-graph.ts`: `applySnapshot` 处理旧版本快照
- [ ] `task-graph-builder.ts`: 未知 intent → 回退到 `inspect` 模板
- [ ] `task-graph-review.ts`: `classifyFailure` 空 error → 返回 'unknown' 分类
- [ ] `task-graph-review.ts`: `classifyFailure` 超长 error → 截断后仍然匹配
- [ ] `task-graph-executor.ts`: contract 检查路径确认为 O(1)（无循环内 I/O）
- [ ] `task-graph-persistence.ts`: `parsePersistedGraph` 处理损坏 JSON → 返回 null
- [ ] `task-graph-persistence.ts`: `parsePersistedGraph` 处理空 fence → 返回 null
- [ ] 性能审计
- [ ] contract 检查：Map/Set 查找确认 O(1)
- [ ] debug dump 生成：确认异步写入（`fs.promises.writeFile`，不阻塞主循环）
- [ ] compaction：确认只在 checkpoint save 前执行，不阻塞 Harness 循环
- [ ] 创建 `test/task-graph-edge-cases.test.ts`
- [ ] 测试空 goal → builder 不崩溃
- [ ] 测试空 nodes → `createTaskGraph` 返回空图
- [ ] 测试损坏 checkpoint → `parsePersistedGraph` 返回 null
- [ ] 测试超大 nodeHistory（1000 条）→ compaction 截断
- [ ] 测试并发任务切换（快速连续调用 `initGraph`）
- [ ] 测试所有 intent 模板生成（覆盖率）
- [ ] 测试 `classifyFailure` 对所有 11 种分类的覆盖
- [ ] 运行全部测试：`npx vitest --run`
- [ ] 运行 `npx tsc --noEmit`
- [ ] 编写 `docs/任务图规划-实施总结.md`（实际文件清单 + 测试结果 + 已知局限）

## 6. Validation

```bash
npx tsc --noEmit
npx vitest --run                         # 全部测试通过（含新增）
npx vitest --run --coverage              # (如果已配置) 确认覆盖率
```

人工验证项：
- `ICE_TASK_GRAPH=1 npm run dev` 稳定性测试（运行 10 个不同任务不崩溃）
- 检查 `graph-debug-xxx.json` 生成正确
- 检查 session-notes.md 中 fence block 完整

## 7. Rollback

Phase 9 是加固层，修改分布在前 8 个 Phase 的文件中。回滚策略：

```bash
# 回滚所有 Phase 的文件（按需）
git checkout -- src/harness/task-graph.ts
git checkout -- src/harness/task-graph-builder.ts
git checkout -- src/harness/task-graph-review.ts
git checkout -- src/harness/task-graph-executor.ts
git checkout -- src/harness/task-graph-persistence.ts
git checkout -- src/harness/harness.ts
git checkout -- src/harness/index.ts
git checkout -- src/harness/checkpoint-engine.ts
git checkout -- src/memory/file-memory/session-memory.ts

# 删除新增文件
rm src/types/task-graph.ts
rm src/harness/task-graph.ts
rm src/harness/task-graph-builder.ts
rm src/harness/task-graph-review.ts
rm src/harness/task-graph-executor.ts
rm src/harness/task-graph-config.ts
rm src/harness/task-graph-persistence.ts
rm src/harness/task-graph-metrics.ts
rm scripts/eval-runner.ts
rm test/task-graph*.test.ts
rm docs/任务图规划-实施总结.md
```

## 8. Dependency

- **Phase 1-8 必须全部完成**

## 9. Forbidden Changes

- 不允许引入新的外部依赖（npm packages）
- 不允许改变任何已有 API 的签名（仅加固内部实现）
- 不允许新增章节到设计文档

## 10. Cursor Execution Notes

- **优先顺序**：边界条件 → 性能审计 → 全部测试通过 → 总结文档
- **文件修改顺序**：按文件列表逐个加固，每改一个跑一次相关测试
- **最大建议修改文件数**：5（修改）+ 2（新增）
- **关键原则**：加固不改行为。所有现有测试必须仍然通过。
- 边界条件测试应该覆盖每个模块的"输入为空/无效/超限"三种情况
