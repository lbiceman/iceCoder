# Task Graph Planner 设计文档

> 基于实际仓库代码的架构设计。  
> 本阶段仅输出设计文档，不做代码实现。

---

## 1. 目标（Goal）

### 现状限制

当前 Harness（`src/harness/harness.ts`）的运行时能力已经很强：

- **Resilience v2**：CheckpointEngine（`src/harness/checkpoint-engine.ts`）、BranchBudgetTracker（`src/harness/branch-budget.ts`）、StepReview（`src/harness/step-review.ts`）三件套已在运行
- **ExecutionPlanTracker**（`src/harness/execution-plan-tracker.ts`）：提供执行透明度，生成 plan → 追踪 step → 发射事件
- **SubAgentRunner**（`src/harness/sub-agent-runner.ts`）：支撑 `delegate_to_subagent` 工具，做只读探索
- **Session memory**：`icecoder-runtime` + `icecoder-plan` fence 将运行时状态持久化到 session-notes.md

但核心问题依然存在：**Harness 循环仍是模型主导（model-led）**。每一轮由 LLM 自由决定做什么，没有预先规划的确定性执行图。

### 预期改进

| 维度 | 现状 | 目标 |
|---|---|---|
| 长任务成功率 | LLM 自由探索，可能反复绕圈 | 预设执行图，路径明确 |
| 重复循环 | 无结构化 fallback，靠注入 system message 纠正 | 图级 fallback 分支，自动切换 |
| 恢复能力 | 依赖 checkpoint 恢复后 LLM 重新理解上下文 | 图游标精确恢复，从断点继续 |
| Sub-agent 调度 | 依赖 LLM 判断何时委派 | 图节点类型 `delegate` 自动触发 |
| 执行可见性 | ExecutionPlanTracker（step 级） | TaskGraph（node + branch 级，更细粒度） |
| Checkpoint 持久化 | TaskState + RepoContext + BranchBudget | 额外持久化图状态 + 游标 + 节点历史 |
| UI 同步 | 面板跟随 phase 推进 | 面板直接映射 TaskNode，支持分支标记 |

---

## 2. 现有运行时分析（Existing Runtime Analysis）

基于对以下实际文件的检查：

```
src/harness/harness.ts          — 核心循环（~2463行）
src/harness/task-state.ts       — 任务状态账本
src/harness/repo-context.ts     — 仓库上下文账本
src/harness/execution-plan-tracker.ts — plan 追踪器
src/harness/execution-plan-generator.ts — plan 生成器（纯函数）
src/harness/checkpoint-engine.ts — v2 checkpoint 引擎
src/harness/checkpoint.ts       — v1 checkpoint 管理器
src/harness/step-review.ts      — 步骤回顾
src/harness/branch-budget.ts    — 分支预算追踪
src/harness/sub-agent-runner.ts — 子代理运行器
src/types/runtime-snapshot.ts   — 运行时快照类型
src/types/execution-plan.ts     — 执行计划类型
src/web/chat-ws.ts              — WebSocket 事件桥
src/public/js/chat-page.js      — 前端聊天页
src/public/js/chat-pet-bridge.js — 冰豆状态桥接
src/public/js/session-pet.js    — 冰豆 UI 组件
src/public/js/chat-execution-plan.js — 执行计划面板
src/memory/file-memory/session-memory.ts — 会话笔记
src/memory/file-memory/execution-plan-fence.ts — plan fence 读写
```

### 2.1 Harness 执行循环

```
Harness.run(userMessage)
  → while(true):
      1. 消息预处理（裁剪 + 压缩）
      2. 调用 LLM（chat / stream）
      3. 处理响应（工具调用 / 文本）
      4. TaskState.recordToolResult() → 更新 phase
      5. ExecutionPlanTracker.onPhaseAdvance() → 更新 plan step
      6. 检查 continue/stop 条件
      7. CheckpointEngine.save() — 周期性快照
      8. 注入 recovery signal（budget / review）
```

**关键发现**：整个循环不包含"预规划"阶段。模型收到 user message 后直接进入 LLM 调用，TaskState 是**事后**记录而非**事前**指引。

### 2.2 任务规划缺失点

| 位置 | 缺失 | 影响 |
|---|---|---|
| `harness.run()` 入口 | 无 graph 构建步骤 | 长任务无结构化分解 |
| `TaskState.recordToolResult()` | 仅记录文件变化，不对比预设节点 | 无法判断偏离程度 |
| `ExecutionPlanTracker.onPhaseAdvance()` | phase 推进靠 TaskState 被动触发 | 粒度太粗（仅 5 个 phase） |
| `CheckpointEngine.save()` | 不持久化图状态 | 恢复后无法从断点继续 |
| `BranchBudgetTracker` | 预算耗尽后仅发 signal | 无自动 fallback 分支切换 |
| `SubAgentRunner` | 依赖 LLM 决定何时调用 | 无预设委派节点 |

### 2.3 可复用的事件通道

| 通道 | 类型/机制 | 复用方式 |
|---|---|---|
| `HarnessStepEvent` | `src/harness/types.ts` | 新增 `task_graph_*` 事件类型 |
| `ExecutionPlanEvent` | `src/types/execution-plan.ts` | 并行发送；graph 变化时同步更新 plan |
| WebSocket `onStep` | `chat-page.js → onWsStep()` | TaskGraph 事件走同一条 WS 通道 |
| `ChatPetBridge.applyHarnessStepToPet` | `chat-pet-bridge.js` | 新增 graph node 状态 → 冰豆表情映射 |
| `ChatExecutionPlanBridge.handleStep` | `chat-execution-plan-bridge.js` | graph → plan projection 后走同一条渲染 |
| `CheckpointEngine.save()` trigger | `harness.ts` 多处 | 新增 `task_graph_checkpoint` trigger |
| session-notes `icecoder-runtime` fence | `session-memory.ts` | 新增 `icecoder-graph` fence 持久化 graph 快照 |

---

## 3. 建议架构（Proposed Architecture）

### 3.1 分层结构

```
                         ┌──────────────────┐
                         │   用户任务输入    │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │  TaskGraphBuilder │  ← 新层：规则驱动，无 LLM
                         │  (意图→图模板)   │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │    TaskGraph      │  ← 新层：图数据结构
                         │  (节点/边/分支)  │
                         └────────┬─────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
     ┌────────▼────────┐  ┌──────▼──────┐  ┌────────▼────────┐
     │ GraphExecutor   │  │ GraphReview │  │  Checkpoint     │
     │ (驱动Harness)   │  │ (节点审查)  │  │  Integration    │
     └────────┬────────┘  └──────┬──────┘  └────────┬────────┘
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  │
                         ┌────────▼─────────┐
                         │   Harness 循环    │  ← 现有层：图驱动执行
                         │ (被GraphExecutor │
                         │  推送当前节点)   │
                         └──────────────────┘
```

### 3.2 Harness 集成策略

**关键原则：TaskGraph 是 Harness 的可选增强，非替代。**

```
Harness.run(userMessage):
  1. 如果启用 TaskGraph && 新任务:
     graph = TaskGraphBuilder.build(goal, intent, repoContext)
     graph.status = 'running'
  
  2. while(true):  // 现有 Harness 循环
       currentNode = graph.cursor.nodeId → graph.nodes[currentNode]
       // 将当前节点注入 context（system reminder 形式）
       // 现有 Harness 逻辑不变
       
       每轮结束后:
         GraphReview.evaluate(currentNode, toolTraces)
         if needsFallback:
           graph.switchToFallbackBranch(reason)
           continue
         if nodeComplete:
           graph.completeCurrentNode()
           graph.advanceCursor()
           if no more nodes:
             break
  
  3. 结束: graph.status = 'done' | 'failed'
```

**向后兼容**：如果 TaskGraph 未启用，Harness 行为完全不变。

### 3.3 与 ExecutionPlanTracker 的关系

TaskGraph 和 ExecutionPlanTracker 并行运行，互不替代：

```
TaskGraph (新)                  ExecutionPlanTracker (现有)
├── 更细粒度节点 (8 种类型)     ├── 5 个 phase step
├── 支持分支和 fallback         ├── 线性执行
├── 图级游标                    ├── step 级状态机
└── 自动恢复分支切换            └── 被动跟随 TaskState.phase
```

映射关系：**TaskGraph → ExecutionPlan 投影**

当 TaskGraph 节点完成时，同步更新对应的 ExecutionStep：
- `inspect/search/read 节点 done` → `context step done`
- `edit 节点 done` → `editing step done`
- `verify 节点 done` → `verification step done`
- `summarize 节点 done` → `final step done`

事件流不变：继续发射 `execution_plan_init` / `execution_plan_update` / `execution_plan_clear`。

---

## 4. 核心概念（Core Concepts）

### 4.1 TaskNode（任务节点）

```typescript
interface TaskNode {
  id: string;                    // node-01, node-02, ...
  type: TaskNodeType;            // inspect | search | read | edit | verify | summarize | fallback | delegate
  title: string;                 // 中文短描述（≤40字）
  phase: TaskPhase;              // intent | context | editing | verification | final
  suggestedTools?: string[];     // 建议工具（提示用，非强制）
  requiresTool: boolean;         // 是否需要工具调用
  status: TaskNodeStatus;        // pending | running | done | failed | skipped
  startedAt?: number;
  endedAt?: number;
  error?: string;
  retryCount: number;            // 当前重试次数
  maxRetries: number;            // 默认 2
  evidence?: string;             // 关联证据（路径/命令）
  delegate?: {                   // 仅 delegate 类型
    task: string;
    tools: string[];
    maxRounds?: number;
  };
}
```

### 4.2 TaskEdge（任务边）

```typescript
interface TaskEdge {
  from: string;       // 源节点 ID
  to: string;         // 目标节点 ID
  type: 'normal' | 'fallback';  // 正常边 / 回退边
  condition?: string; // fallback 边的触发条件
}
```

### 4.3 ExecutionBranch（执行分支）

```typescript
interface ExecutionBranch {
  id: string;
  nodeIds: string[];      // 按执行顺序排列
  isFallback: boolean;
  triggerReason?: string; // 触发此分支的原因
}
```

### 4.4 FallbackBranch（后备分支）

```typescript
interface FallbackBranch {
  id: string;
  sourceBranchId: string;   // 原主分支
  failedNodeId: string;     // 失败的节点
  nodeIds: string[];        // 后备节点列表
  reason: FallbackReason;
  attemptCount: number;     // 已尝试次数
  maxAttempts: number;      // 默认 1
}

type FallbackReason =
  | 'retries_exceeded'   // 重试耗尽
  | 'repeated_failure'   // 重复失败
  | 'no_progress'        // 无进展
  | 'invalid_output'     // 无效输出
  | 'verify_fail';       // 验证失败
```

### 4.5 RecoverySignal（恢复信号）

```typescript
interface GraphRecoverySignal {
  source: 'branch_budget' | 'step_review' | 'node_failure' | 'verify_failure';
  nodeId: string;
  level: 'retry' | 'fallback' | 'abort';
  message: string;
  at: number;
}
```

### 4.6 ExecutionCursor（执行游标）

```typescript
interface ExecutionCursor {
  branchId: string;
  nodeId: string;
  nodeIndex: number;
  completedNodeIds: string[];
  skippedNodeIds: string[];
}
```

### 4.7 TaskGraph（任务图）

```typescript
interface TaskGraph {
  version: 1;
  graphId: string;
  goal: string;
  intent: TaskIntent;
  nodes: Record<string, TaskNode>;     // Map 形式便于 O(1) 查询
  edges: TaskEdge[];
  mainBranch: ExecutionBranch;
  fallbackBranches: FallbackBranch[];
  cursor: ExecutionCursor;
  status: 'ready' | 'running' | 'paused' | 'done' | 'failed';
  progress: number;                    // 0-100
  createdAt: number;
  updatedAt: number;
  nodeHistory: NodeHistoryEntry[];
  branchHistory: BranchHistoryEntry[];
}
```

---

## 5. 图生命周期（Graph Lifecycle）

```
  ┌──────────────┐
  │ 1. task 收到 │
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │ 2. intent 检测│  TaskState.inferIntent(goal) → TaskIntent
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │ 3. graph 构建 │  TaskGraphBuilder.build(goal, intent, repoContext)
  └──────┬───────┘    → 规则驱动，返回 TaskGraph
         │
  ┌──────▼───────┐
  │ 4. node 执行  │  ┌─────────────────────────────────────┐
  └──────┬───────┘  │ for each node in currentBranch:     │
         │           │   graph.startCurrentNode()          │
  ┌──────▼───────┐  │   → 注入 system reminder to Harness │
  │ 5. node 审查  │  │   → Harness 正常执行               │
  └──────┬───────┘  │   graph.completeCurrentNode()        │
         │           │   graph.advanceCursor()              │
  ┌──────▼───────┐  └─────────────────────────────────────┘
  │ 6. 分支切换   │  needsRecovery() ? switchToFallback()
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │ 7. checkpoint │  CheckpointEngine.save({ graphSnapshot })
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │ 8. 完成/失败  │  graph.status = 'done' | 'failed'
  └──────────────┘
```

### 序列图

```
User          Builder       TaskGraph      Executor      Harness       Review
 │               │              │              │             │            │
 │──task────────►│              │              │             │            │
 │               │──build()────►│              │             │            │
 │               │              │──execute()──►│             │            │
 │               │              │              │──runNode───►│            │
 │               │              │              │             │──LLM loop │
 │               │              │              │◄──result────│            │
 │               │              │              │───────────────────────►│
 │               │              │              │◄──review────│            │
 │               │              │◄──complete───│             │            │
 │               │              │──advance────►│             │            │
 │               │              │              │──runNode───►│            │
 │               │              │              │   ...       │            │
 │               │              │◄──done───────│             │            │
```

---

## 6. 节点类型（Node Types）

### 6.1 inspect — 只读探查
- **用途**：理解代码结构、导航仓库、形成认知
- **phase**: `intent` 或 `context`
- **requiresTool**: `true`（read_file, search_codebase, fs_operation）
- **完成条件**：读取了目标文件，掌握了结构

### 6.2 search — 搜索
- **用途**：查找文件、搜索内容、定位符号
- **phase**: `context`
- **requiresTool**: `true`（search_codebase）
- **完成条件**：找到了匹配结果

### 6.3 read — 读取
- **用途**：打开具体文件、获取代码内容
- **phase**: `context`
- **requiresTool**: `true`（read_file, open_file）
- **完成条件**：成功读取目标文件

### 6.4 edit — 编辑
- **用途**：写文件、修改代码
- **phase**: `editing`
- **requiresTool**: `true`（write_file, edit_file, batch_edit_file, patch_file）
- **完成条件**：文件变更成功
- **maxRetries**: 2

### 6.5 verify — 验证
- **用途**：运行测试、lint、tsc 检查
- **phase**: `verification`
- **requiresTool**: `true`（run_command）
- **完成条件**：命令成功执行
- **isVerification**: `true`
- **maxRetries**: 2

### 6.6 summarize — 总结
- **用途**：生成变更摘要
- **phase**: `final`
- **requiresTool**: `false`
- **完成条件**：模型输出总结文本

### 6.7 fallback — 回退
- **用途**：主路径失败后的替代策略
- **phase**: 跟随被替换的节点
- **requiresTool**: `true`
- **特点**：不参与主分支，仅在 branch switch 时激活
- **maxRetries**: 1

### 6.8 delegate — 委派
- **用途**：交给 SubAgentRunner 做只读探索
- **phase**: `context`
- **requiresTool**: `true`（delegate_to_subagent）
- **delegate 配置**：task + tools + maxRounds
- **完成条件**：子代理返回结果

---

## 7. 构建规则（Planner Rules）

**原则：v1 版本不调用 LLM，完全规则驱动。**

### 7.1 意图 → 图模板映射

复用现有的 `TaskState.inferIntent(goal)`（`src/harness/task-state.ts`），映射到图模板：

#### `edit`（编辑/实现/修改）

```
[intent] 理解目标 → [context] 查阅相关内容 → [editing] 编写/修改代码 → [verify] 运行验证 → [final] 总结变更
```

节点序列：
- `node-01` (inspect): "理解目标" — 确认任务范围
- `node-02` (search/read): "查阅相关内容" — 理解现有代码
- `node-03` (edit): "编写或修改代码" — 文件变更
- `node-04` (verify): "运行验证命令" — 测试/lint/tsc
- `node-05` (summarize): "总结变更" — 输出摘要

Fallback:
- `node-03` 失败 → `node-fb1` (fallback): "尝试替代编辑方案"
- `node-04` 失败 → `node-fb2` (fallback): "修复验证错误"

#### `debug`（排查）

```
[intent] 明确问题 → [context] 查阅证据 → [editing] 最小修复 → [verify] 验证修复 → [final] 总结原因
```

Fallback: 修复失败 → 更深入的搜索路径

#### `test`（测试）

```
[intent] 明确范围 → [context] 运行并查看输出 → [editing] 调整代码/测试 → [verify] 验证通过 → [final] 总结
```

Fallback: 测试持续失败 → 简化测试范围

#### `refactor`（重构）

```
[intent] 明确范围 → [context] 查阅影响范围 → [editing] 应用重构 → [verify] 验证不变性 → [final] 总结
```

Fallback: 影响面过大 → 缩小重构范围

#### `inspect` / `question`（只读查阅/问答）

```
[context] 查阅相关代码 → [final] 总结发现
```

无 fallback（只读操作不需要回退）。

### 7.2 输入参数

```typescript
interface GraphBuildInput {
  goal: string;                      // 用户原始目标
  intent: TaskIntent;                // 意图
  repoContext: RepoContextSnapshot;  // 仓库上下文
  previousFailures?: string[];       // 之前的失败签名
  changedFiles?: string[];           // 已变更的文件
  verificationNeeded: boolean;       // 是否需要验证
  branchBudget?: BranchBudgetSnapshot; // 分支预算状态
}
```

### 7.3 构建算法

```
function buildGraph(input: GraphBuildInput): TaskGraph {
  1. 根据 intent 选择图模板（节点序列）
  2. 根据 repoContext 补充 evidence：
     - 如果 changedFiles 非空 → edit 节点 evidence = changedFiles[0]
     - 如果 testCommands 非空 → verify 节点 evidence = testCommands[0]
  3. 根据 previousFailures 调整 retryCount 和 maxRetries
  4. 根据 branchBudget 决定是否预建 fallback 分支
  5. 调用 createTaskGraph(opts) → TaskGraph
}
```

---

## 8. 图执行器（Graph Executor）

### 8.1 Harness 消费当前节点

GraphExecutor 不替代 Harness，而是在 Harness 循环前/间注入节点上下文：

```typescript
// Harness.run() 集成点
if (this.taskGraph && this.taskGraphEnabled) {
  const node = startCurrentNode(this.taskGraph);
  
  // 注入节点上下文到 system reminder
  messages.push({
    role: 'user',
    content: `[TaskGraph] Current step: ${node.title} (type=${node.type}, phase=${node.phase}). ${
      node.suggestedTools?.length 
        ? 'Suggested tools: ' + node.suggestedTools.join(', ') 
        : ''
    }`
  });
}
```

### 8.2 节点状态转换

```
pending ──► running ──► done
  │                      │
  │           ┌──────────┘
  │           ▼
  │         failed ──► (retry < maxRetries) → pending
  │           │
  │           └──────► (retry >= maxRetries) → fallback 分支
  │
  └──────► skipped（用户/模型显式跳过）
```

### 8.3 工具行为约束

节点类型影响 Harness 的 tool permission：

| 节点类型 | 允许的工具 | 阻止的工具 |
|---|---|---|
| inspect | read_file, search_codebase, fs_operation | write_file, edit_file, run_command |
| search | search_codebase, read_file | write_file, edit_file, run_command |
| read | read_file, open_file | write_file, edit_file, run_command |
| edit | write_file, edit_file, batch_edit_file, patch_file | — |
| verify | run_command | write_file, edit_file |
| summarize | 无工具调用 | 所有工具 |
| delegate | delegate_to_subagent | 所有其他工具 |

**实现方式**：GraphExecutor 在每轮开始前，通过 Harness 的 `permissionRules` 动态注入节点级权限。约束是**软性**的（system prompt 引导），不阻止 LLM 自由选择——与现有 tracker 的"不拒绝模型实际 toolCall"策略一致。

---

## 9. 恢复分支（Recovery Branching）

### 9.1 触发条件

| 条件 | 检测方式 | 动作 |
|---|---|---|
| 重试耗尽 | `node.retryCount >= node.maxRetries` | switchToFallback() |
| 重复失败 | BranchBudgetTracker 同签名连续失败 | switchToFallback() |
| 无进展 | StepReview 连续两轮 progressMade=false | switchToFallback() |
| 无效输出 | 验证节点输出不匹配预期 | switchToFallback() |
| 验证失败 | verify 节点 command 返回非零 | switchToFallback() |

### 9.2 Fallback 分支类型

```typescript
// 例：edit 节点失败后的 fallback
const editFallback: FallbackBranch = {
  sourceBranchId: 'branch-main-xxx',
  failedNodeId: 'node-03',
  nodeIds: ['node-fb1'],      // fallback 节点
  reason: 'repeated_failure',
  attemptCount: 0,
  maxAttempts: 1,
};

// fallback 节点定义
const fallbackNode: TaskNode = {
  id: 'node-fb1',
  type: 'fallback',
  title: '尝试替代编辑方案',
  // ... 建议使用不同的工具组合或更小范围的修改
};
```

### 9.3 分支切换流程

```
1. needsRecovery(graph) → GraphRecoverySignal (level: 'fallback')
2. switchToFallbackBranch(graph, signal.reason)
   → 查找第一个 attemptCount < maxAttempts 的 fallback
   → 更新 cursor 到 fallback 分支
   → 记录 branchHistory
3. Harness 下一轮注入 fallback 节点上下文
   → "[TaskGraph] Switched to fallback branch. Reason: repeated_failure. ..."
4. 如果所有 fallback 耗尽:
   → markGraphFailed(graph, 'All fallback branches exhausted')
```

---

## 10. Checkpoint 集成

### 10.1 与现有机制对齐

现有两套持久化机制：
- **v1**：`TaskCheckpointManager` (`src/harness/checkpoint.ts`) → `*.checkpoint.json`
- **v2**：`CheckpointEngine` (`src/harness/checkpoint-engine.ts`) → `runtimeV2` 字段附加到 v1 JSON

TaskGraph 持久化集成到 v2：

```typescript
// CombinedCheckpointFile 扩展
interface CombinedCheckpointFile extends TaskCheckpoint {
  runtimeV2?: RuntimeCheckpointV2;
  taskGraph?: TaskGraphSnapshot;  // ← 新增字段
}
```

### 10.2 TaskGraphSnapshot

```typescript
interface TaskGraphSnapshot {
  version: 1;
  graphId: string;
  goal: string;
  intent: TaskIntent;
  status: 'ready' | 'running' | 'paused' | 'done' | 'failed';
  progress: number;
  cursor: {
    branchId: string;
    nodeId: string;
    nodeIndex: number;
    completedNodeIds: string[];
    skippedNodeIds: string[];
  };
  nodes: Record<string, { status: TaskNodeStatus; retryCount: number; error?: string }>;
  nodeHistory: NodeHistoryEntry[];
  branchHistory: BranchHistoryEntry[];
  updatedAt: number;
}
```

### 10.3 持久化 Trigger

复用现有 `CheckpointSaveTrigger` 并扩展：

| Trigger | 来源 | TaskGraph 操作 |
|---|---|---|
| `step_completed` | 现有 | `toSnapshot(graph)` |
| `tool_failed` | 现有 | `toSnapshot(graph)` |
| `verification_*` | 现有 | `toSnapshot(graph)` |
| `task_graph_node_done` | **新增** | 节点完成后快照 |
| `task_graph_branch_switch` | **新增** | 分支切换后快照 |
| `task_graph_fallback_activated` | **新增** | fallback 激活后快照 |

### 10.4 向后兼容

- 旧 checkpoint 无 `taskGraph` 字段 → 恢复时跳过（不丢数据）
- `taskGraph` 字段为可选 → 现有所有 checkpoint 仍然有效
- TaskGraph 未启用时 → 不写入 `taskGraph` 字段

### 10.5 Session Notes 持久化

在 session-notes.md 中新增 `icecoder-graph` fence（与 `icecoder-runtime` / `icecoder-plan` 平行）：

````markdown
```icecoder-graph
{"version":1,"graphId":"...","status":"running","cursor":{...},"nodes":{...}}
```
````

解析方式与现有 `parsePersistedRuntime()` / `parsePersistedPlan()` 一致（取最后一个 fence）。

---

## 11. Sub-Agent 集成

### 11.1 委派节点

`type: 'delegate'` 的节点由 GraphExecutor **直接调用** `SubAgentRunner.run()`，不经过 LLM：

```typescript
async function executeDelegateNode(graph: TaskGraph, node: TaskNode): Promise<void> {
  const result = await subAgentRunner.run({
    task: node.delegate!.task,
    tools: node.delegate!.tools,
    maxRounds: node.delegate!.maxRounds,
  });
  
  // 结果作为工具输出注入 Harness 上下文
  // 格式与现有 delegate_to_subagent tool result 一致
  formatSubAgentResult(result);
}
```

### 11.2 典型委派场景

| 场景 | delegate 配置 |
|---|---|
| 仓库探索 | `{ task: "探索项目结构", tools: ["read_file","search_codebase","fs_operation"] }` |
| 依赖追踪 | `{ task: "追踪 import 依赖链", tools: ["read_file","search_codebase"] }` |
| 测试诊断 | `{ task: "分析失败测试原因", tools: ["read_file","search_codebase"] }` |
| 大范围搜索 | `{ task: "搜索所有相关引用", tools: ["search_codebase"] }` |

### 11.3 上下文隔离

委派节点的子代理拥有独立的消息循环。子代理结果通过 `formatSubAgentResult()` 合并回主 Harness 上下文。这与现有 `SubAgentRunner` 行为完全一致——GraphExecutor 只是将"何时调用"从 LLM 决策改为图预设。

---

## 12. 执行透明度集成（Execution Transparency Integration）

### 12.1 Graph → Plan 投影

TaskGraph 和 ExecutionPlanTracker 并行运行：

```
TaskGraph 节点                 →   ExecutionPlan step
─────────────────────────────────────────────────────
inspect/search/read (done)    →   context step (done)
edit (running)                 →   editing step (running)
edit (done)                    →   editing step (done)
verify (running)               →   verification step (running)
verify (done)                  →   verification step (done)
summarize (done)               →   final step (done)
fallback (running)             →   对应 phase step (running, 不改变 step 结构)
```

### 12.2 事件扩展

现有事件保持不变：
- `execution_plan_init` — plan 首次生成
- `execution_plan_update` — step 状态变更
- `execution_plan_clear` — 新任务清除旧 plan

新增事件（仅在 TaskGraph 启用时发射）：

```typescript
// 图初始化事件
interface TaskGraphInitEvent {
  type: 'task_graph_init';
  graphId: string;
  nodeCount: number;
  branchCount: number;
}

// 图节点状态变更
interface TaskGraphNodeEvent {
  type: 'task_graph_node';
  graphId: string;
  nodeId: string;
  status: TaskNodeStatus;
  progress: number;     // 图级进度
}

// 分支切换事件
interface TaskGraphBranchEvent {
  type: 'task_graph_branch';
  graphId: string;
  fromBranchId: string;
  toBranchId: string;
  reason: FallbackReason;
}

// 图完成/失败事件
interface TaskGraphDoneEvent {
  type: 'task_graph_done';
  graphId: string;
  status: 'done' | 'failed';
  nodeHistory: NodeHistoryEntry[];
}
```

这些新事件走现有 WebSocket `onStep` 通道（`HarnessStepEvent.type` 新增值），前端通过 `chat-page.js` 的 `onWsStep` 接收。

---

## 13. Web 执行面板集成

### 13.1 现有面板分析

**执行计划面板**：`src/public/js/chat-execution-plan.js`

- 渲染 `ExecutionPlan` 的 `steps[]` 为列表
- 每个 step 显示：标题 + 状态图标（pending/running/done/failed）
- 当前活动 step 高亮
- progress bar 显示整体进度
- 面板可折叠，`question` 意图自动隐藏

**冰豆状态桥接**：`src/public/js/chat-pet-bridge.js`

- `hasLiveExecutionPlan()` → 决定底部显示 step 摘要还是轮次
- `syncExecPlanFoot()` → 有 plan 时显示 "步骤 3/5 · 编写代码"，无 plan 时显示 "第 N 轮"
- `applyHarnessStepToPet()` → 根据 step type 切换冰豆表情

### 13.2 TaskGraph UI 映射

复用现有执行计划面板，扩展渲染：

```
┌─────────────────────────────────────────┐
│  📋 任务图              进度: 60% ████░░ │
├─────────────────────────────────────────┤
│  ✅ 理解目标                            │
│  ✅ 查阅相关内容                        │
│  🔄 编写或修改代码    ← 当前节点         │
│  ⬜ 运行验证命令                        │
│  ⬜ 总结变更                            │
├─────────────────────────────────────────┤
│  🔀 后备分支 (未激活)                    │
│    ⬜ 尝试替代编辑方案                   │
│    ⬜ 修复验证错误                       │
└─────────────────────────────────────────┘
```

### 13.3 前端事件处理

`chat-page.js` 的 `onWsStep` 新增处理：

```javascript
if (step.type === 'task_graph_init') {
  ChatExecutionPlan.renderGraph(step);     // 渲染图结构
}
if (step.type === 'task_graph_node') {
  ChatExecutionPlan.updateNode(step);      // 更新单个节点状态
}
if (step.type === 'task_graph_branch') {
  ChatExecutionPlan.highlightBranch(step); // 高亮分支切换
  Pet.setState('thinking');               // 冰豆表情切换
}
if (step.type === 'task_graph_done') {
  ChatExecutionPlan.markGraphDone(step);   // 标记完成
  Pet.setState('idle');                    // 冰豆回 idle
}
```

### 13.4 分支标记

```
✅ completed   — 已完成
🔄 running     — 执行中
⬜ pending     — 待执行
❌ failed      — 失败
⏭️ skipped     — 已跳过
🔀 fallback    — 后备分支（分支标记 + 缩进）
⚠️ resumed     — 从 checkpoint 恢复
```

---

## 14. 冰豆（Ice Bean）宠物系统集成

### 14.1 现有表情映射

`chat-pet-bridge.js` 已有一套完整的事件→表情映射：

| 事件 | 表情 |
|---|---|
| 流式输出 | `read` |
| 工具调用中 | `thinking` |
| 工具进度更新 | bubble text 更新 |
| 空闲 | `idle` |
| 有执行计划 | foot summary 显示步骤 |
| 第 N 轮 | foot summary 显示轮次 |

### 14.2 TaskGraph 表情扩展

新增表情状态（`session-pet.js` 已支持 20 种表情，无需新增绘制代码）：

| TaskGraph 事件 | 冰豆表情 | bubble 文本 |
|---|---|---|
| `task_graph_init` | `thinking` | "规划中…" |
| `task_graph_node` (running) | `thinking` | node.title |
| `task_graph_node` (done) | `idle` | "" |
| `task_graph_node` (failed) | `alert` | "节点失败" |
| `task_graph_branch` | `alert` | "切换策略…" |
| `task_graph_done` (done) | `happy` | "✅ 完成" |
| `task_graph_done` (failed) | `sad` | "任务失败" |

### 14.3 Foot Summary 增强

当有 TaskGraph 时，底部摘要格式：

```
"节点 3/5 · 编写代码"    ← 替代 "第 N 轮" / "步骤 3/5"
```

---

## 15. 会话恢复

### 15.1 Checkpoint 恢复

```
1. Harness 初始化时检查 checkpoint：
   if checkpoint.taskGraph:
     graph = createTaskGraph(originalGoal, originalIntent, originalNodes)
     applySnapshot(graph, checkpoint.taskGraph)
     // 游标恢复到断点
     // 节点状态恢复到断点
     // 注入 resume 提示："继续执行节点 node-03：编写或修改代码"

2. 如果图已完成 (status=done) 且不是当前任务：
   清除 checkpoint 中的 taskGraph
```

### 15.2 Session Notes 恢复

从 session-notes.md 解析 `icecoder-graph` fence：

```typescript
function parsePersistedTaskGraph(notes: string): TaskGraphSnapshot | null {
  // 与 parsePersistedPlan() 同模式：取最后一个 ```icecoder-graph 代码块
  // 校验 version / 字段完整性
}
```

---

## 16. 配置与开关

### 16.1 Feature Flag 模型

与现有 `isExecutionPlanEnabled()` / `isResilienceV2Enabled()` 保持一致：

```typescript
// src/harness/graph-config.ts
export function isTaskGraphEnabled(): boolean {
  // v1: 环境变量控制，默认关闭
  const env = process.env.ICE_TASK_GRAPH;
  if (env === '1' || env === 'true') return true;
  return false;
}
```

**默认关闭**：TaskGraph 在 v1 阶段是可选增强。Harness 检测到未启用时，行为完全不变。

### 16.2 启用条件

```
TaskGraph 启用条件：
1. ICE_TASK_GRAPH=1（环境变量）
2. 任务意图非 'question'（问答不需要图规划）
```

---

## 17. 新增文件

```
src/
├── types/
│   └── task-graph.ts              # TaskGraph 共享类型定义
├── harness/
│   ├── task-graph.ts              # 图数据结构 + 操作（create/advance/snapshot）
│   ├── task-graph-builder.ts      # 规则驱动构建器（intent → 图模板）
│   ├── task-graph-executor.ts     # 图执行器（与 Harness 集成点）
│   ├── task-graph-review.ts       # 节点审查（替代/增强现有 step-review）
│   └── task-graph-config.ts       # 配置与 feature flag

test/
└── task-graph.test.ts             # 测试
```

### 前端兼容性说明

**不需要新增前端文件**。现有文件足以支持：

| 文件 | 改动类型 |
|---|---|
| `chat-page.js` | 扩展 `onWsStep` 处理新事件类型 |
| `chat-execution-plan.js` | 扩展渲染逻辑支持分支标记 |
| `chat-execution-plan-bridge.js` | 扩展 handleStep 处理 graph 事件 |
| `chat-pet-bridge.js` | 扩展 `applyHarnessStepToPet` 映射新事件 |
| `session-pet.js` | 无需改动（现有 20 种表情已覆盖） |

**改动量预估**：每个前端文件增加 15-30 行，侵入性极低。

---

## 18. 开放问题

| 问题 | 说明 | 建议方向 |
|---|---|---|
| **图变异** | LLM 是否可以在执行中修改图（增删节点）？ | v1 不允许；v2 通过 recovery signal 触发图重规划 |
| **嵌套分支** | fallback 分支内部是否还可以有 fallback？ | v1 仅支持一级 fallback（单层线性后备） |
| **分支压缩** | 长任务多分支后如何压缩图状态？ | 与 context compaction 联动，完成不可逆节点后清理 |
| **图剪枝** | 已完成的节点是否可移除？ | nodeHistory 保留全量，图中节点不可移除（用于 checkpoint 校验） |
| **图回放** | 是否支持重新执行同一张图？ | v1 不支持；需要时重建新图 |
| **图可视化** | 是否在前端渲染 DAG 图？ | v1 仅列表形式，复用现有面板 |
| **冰豆状态覆盖** | graph 事件和 stream 事件冲突时优先级？ | graph 事件优先于 stream（任务级 > 轮次级） |
| **面板虚拟分支渲染** | fallback 分支在面板如何展示？ | 折叠在"后备分支"区域，仅激活时展开 |

---

## 19. 建议的下一步行动

### 最小可行集成（Smallest Viable Integration）

**第一阶段：类型 + 核心数据结构**

1. 创建 `src/types/task-graph.ts`（类型定义，约 180 行）
2. 创建 `src/harness/task-graph.ts`（图数据结构 + CRUD 操作，约 300 行）
3. 编写 `test/task-graph.test.ts`（覆盖 create/advance/complete/snapshot/fallback）
4. 验证：`npx vitest --run test/task-graph.test.ts` 全部通过

**第二阶段：Builder + Harness 集成点**

5. 创建 `src/harness/task-graph-builder.ts`（规则驱动构建，约 200 行）
6. 在 `harness.ts` 中增加集成点（约 50 行，feature flag 保护）
7. 验证：Harness 现有测试不受影响，TaskGraph 关闭时行为不变

**第三阶段：前端接续**

8. 扩展 `chat-page.js` 处理新事件（约 30 行）
9. 验证：手动测试 WebSocket 事件流

### 关键约束

- **必须保持现有 Harness 行为不变**：TaskGraph 关闭时零影响
- **图在 v1 中必须是可选**：通过 `ICE_TASK_GRAPH` 环境变量控制
- **不改变现有 checkpoint 格式**：`taskGraph` 字段为可选附加
- **不替代 ExecutionPlanTracker**：两者并行运行，图 → plan 投影

---

## 20. Node Contract Layer（节点约束层）

> **修正说明**：前文 §8.3 提到"工具行为约束"为软性 system prompt 引导。但实际运行中，仅靠 system reminder 注入节点信息（§8.1 的 `[TaskGraph] Current step: ...`）太过薄弱——LLM 可以完全忽略节点指示而调用不相关工具。Node Contract Layer 是对 §8.3 的强化设计，引入**硬约束 + 软引导**双层机制。

### 20.1 问题分析

当前 Harness 的工具权限系统（`PermissionManager`，`src/harness/permission.ts`）只做全局级 allow/confirm/deny 判定。StepGraph 需要一个**节点级**的动态权限层：

```
全局权限 (PermissionManager)     ← 静态："允许编辑 / 需要确认"
    ↓ 叠加
节点合约 (NodeContract)           ← 动态："当前节点只允许 read/search"
    ↓ 叠加
模型行为                           ← LLM 仍可调用任意工具（只是被拒绝/警告）
```

实际集成位置在 `harness.ts` 的工具调用前拦截点（约 L1100-L1150 区域，工具结果执行前）：

```typescript
// 现有逻辑（harness.ts 约 L1120）
for (const tc of toolCalls) {
  const perm = this.permissionManager.check(tc.name, tc.arguments);
  // ...
}

// 新增：NodeContract 检查（在 permission check 之后、执行之前）
if (this.taskGraph) {
  const contractResult = this.graphExecutor.checkContract(tc);
  if (!contractResult.allowed) {
    // 硬拒绝或软警告
  }
}
```

### 20.2 NodeContract 数据结构

```typescript
// ─── src/types/task-graph.ts 扩展 ───

/** 节点执行合约 */
export interface NodeContract {
  /** 合约 ID（nodeId 一致） */
  nodeId: string;
  /** 允许的工具名列表（白名单） */
  allowedTools: string[];
  /** 禁止的工具名列表（黑名单，优先级高于 allowedTools） */
  forbiddenTools: string[];
  /** 偏好工具名列表（软建议，LLM 优先考虑但不强制） */
  preferredTools?: string[];
  /** 要求的输出信号（如 'file_written' | 'test_passed' | 'search_completed'） */
  requiredOutputSignals: OutputSignal[];
  /** 节点完成条件 */
  completionCriteria: CompletionCriteria;
  /** 节点守卫配置 */
  nodeGuard: NodeGuardConfig;
  /** 当前合约版本 */
  version: number;
}

/** 输出信号类型 */
export type OutputSignal =
  | 'file_read'        // 成功读取了目标文件
  | 'file_written'     // 成功写入了目标文件
  | 'file_changed'     // 文件发生了变更
  | 'search_completed' // 搜索返回了结果
  | 'command_executed' // 命令执行成功
  | 'test_passed'      // 测试通过
  | 'verification_done'// 验证完成
  | 'summary_generated'// 总结已生成
  | 'delegate_done';   // 子代理完成

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
  /** 偏离容忍度：soft | hard | strict */
  deviationTolerance: DeviationTolerance;
}

export type DeviationTolerance = 'soft' | 'hard' | 'strict';
```

### 20.3 合约验证器（ContractValidator）

```typescript
// ─── src/harness/task-graph-review.ts 内 ───

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

export interface ContractViolation {
  /** 违规类型 */
  type: 'forbidden_tool' | 'idle_round' | 'repeat_tool' | 'missing_signal' | 'round_exceeded';
  /** 违规详情 */
  detail: string;
  /** 严重程度 */
  severity: 'info' | 'warning' | 'error';
}

export class ContractValidator {
  private contract: NodeContract;
  private currentRound: number = 0;
  private toolCallCount: number = 0;
  private sameToolStreak: Map<string, number> = new Map();
  private outputSignals: Set<OutputSignal> = new Set();
  private idleRounds: number = 0;

  constructor(contract: NodeContract) {
    this.contract = contract;
  }

  /** 工具调用前检查 */
  checkBeforeToolCall(toolName: string): ContractCheckResult {
    const violations: ContractViolation[] = [];

    // 1. 硬边界：forbiddenTools 直接拒绝
    if (this.contract.forbiddenTools.includes(toolName)) {
      return {
        passed: false,
        violations: [{ type: 'forbidden_tool', detail: `工具 ${toolName} 在当前节点被禁止`, severity: 'error' }],
        action: 'block',
        message: `[Contract] 当前节点 (${this.contract.nodeId}) 不允许使用 ${toolName}。允许的工具: ${this.contract.allowedTools.join(', ')}`,
      };
    }

    // 2. 白名单检查
    if (this.contract.allowedTools.length > 0 && !this.contract.allowedTools.includes(toolName)) {
      if (this.contract.nodeGuard.enforceToolBoundary) {
        return {
          passed: false,
          violations: [{ type: 'forbidden_tool', detail: `工具 ${toolName} 不在节点允许列表中`, severity: 'warning' }],
          action: this.contract.nodeGuard.deviationTolerance === 'strict' ? 'block' : 'warn',
          message: `[Contract] ${toolName} 不在当前节点建议工具中。建议使用: ${this.contract.allowedTools.join(', ')}。如需继续请忽略此提示。`,
        };
      }
    }

    // 3. 重复工具检查
    const streak = (this.sameToolStreak.get(toolName) ?? 0) + 1;
    this.sameToolStreak.set(toolName, streak);
    if (streak > this.contract.nodeGuard.maxSameToolRepeat) {
      violations.push({
        type: 'repeat_tool',
        detail: `工具 ${toolName} 已连续调用 ${streak} 次（上限 ${this.contract.nodeGuard.maxSameToolRepeat}）`,
        severity: 'warning',
      });
    }

    return {
      passed: violations.length === 0,
      violations,
      action: violations.length > 0 ? 'warn' : 'allow',
      message: violations.length > 0 ? `[Contract] 警告：${violations.map(v => v.detail).join('; ')}` : undefined,
    };
  }

  /** 工具调用后记录 */
  recordAfterToolCall(toolName: string, success: boolean, signal?: OutputSignal): void {
    this.toolCallCount++;
    if (signal) this.outputSignals.add(signal);
    if (!success) this.sameToolStreak.delete(toolName); // 失败不累积
  }

  /** 轮次结束后检查 */
  checkRoundEnd(toolCallsThisRound: number): ContractCheckResult {
    this.currentRound++;
    const violations: ContractViolation[] = [];

    // idle 检查
    if (toolCallsThisRound === 0) {
      this.idleRounds++;
      if (this.idleRounds > this.contract.nodeGuard.maxIdleRounds) {
        violations.push({
          type: 'idle_round',
          detail: `连续 ${this.idleRounds} 轮无工具调用（上限 ${this.contract.nodeGuard.maxIdleRounds}）`,
          severity: 'error',
        });
      }
    } else {
      this.idleRounds = 0;
    }

    // round 检查
    if (this.currentRound > this.contract.completionCriteria.maxRounds) {
      violations.push({
        type: 'round_exceeded',
        detail: `已达最大轮次 ${this.contract.completionCriteria.maxRounds}`,
        severity: 'error',
      });
    }

    return {
      passed: violations.length === 0,
      violations,
      action: violations.length > 0 ? 'force_switch' : 'allow',
      message: violations.length > 0 ? `[Contract] 节点守卫触发：${violations.map(v => v.detail).join('; ')}` : undefined,
    };
  }

  /** 判断节点是否完成 */
  checkCompletion(): { completed: boolean; reason?: string } {
    const { requiredSignals, minToolCalls } = this.contract.completionCriteria;

    if (this.toolCallCount < minToolCalls) {
      return { completed: false, reason: `工具调用次数不足（${this.toolCallCount}/${minToolCalls}）` };
    }

    const missing = requiredSignals.filter(s => !this.outputSignals.has(s));
    if (missing.length > 0) {
      return { completed: false, reason: `缺少输出信号: ${missing.join(', ')}` };
    }

    return { completed: true };
  }

  reset(newContract?: NodeContract): void {
    if (newContract) this.contract = newContract;
    this.currentRound = 0;
    this.toolCallCount = 0;
    this.sameToolStreak.clear();
    this.outputSignals.clear();
    this.idleRounds = 0;
  }
}
```

### 20.4 偏离检测器（DeviationDetector）

`DeviationDetector` 复用现有 `StepReview`（`src/harness/step-review.ts`）的启发式判断 + 可选 LLM 审查，但输入从全局 tool trace 缩小为**当前节点**的 tool trace：

```typescript
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

export type CorrectionAction =
  | { type: 'inject_hint'; message: string }        // 软纠正：注入提示
  | { type: 'block_tool'; toolName: string }          // 硬纠正：阻止特定工具
  | { type: 'reset_node'; nodeId: string }            // 硬纠正：重置当前节点
  | { type: 'force_branch_switch'; reason: string };  // 强制分支切换

export class DeviationDetector {
  private readonly contract: NodeContract;
  private readonly stepReviewContext: StepReviewContext; // 复用现有 ReviewToolTrace[]

  detect(toolCalls: ToolCall[], taskState: TaskStateSnapshot): DeviationResult {
    // 1. 工具匹配检查：当前调用的工具是否与 allowedTools 交集为空
    const calledTools = new Set(toolCalls.map(tc => tc.name));
    const allowedSet = new Set(this.contract.allowedTools);
    const overlap = [...calledTools].filter(t => allowedSet.has(t));

    if (overlap.length === 0 && this.contract.allowedTools.length > 0) {
      return {
        deviated: true,
        type: 'tool_mismatch',
        severity: 'hard',
        correction: {
          type: 'inject_hint',
          message: `[Contract] 当前节点需要以下工具之一: ${this.contract.allowedTools.join(', ')}。请聚焦当前步骤。`,
        },
        description: `调用了 ${[...calledTools].join(', ')}，但节点要求 ${this.contract.allowedTools.join(', ')}`,
      };
    }

    // 2. Phase 匹配检查：ToolCall 的 phase 是否与节点 phase 一致
    const nodePhase = /* 从 contract 关联的 node 获取 */ 'editing';
    const calledPhase = inferPhaseFromTools(toolCalls);
    if (calledPhase !== nodePhase && calledPhase !== 'intent') {
      return {
        deviated: true,
        type: 'phase_mismatch',
        severity: 'soft',
        correction: {
          type: 'inject_hint',
          message: `[Contract] 当前阶段为「${nodePhase}」，但你的操作看起来属于「${calledPhase}」。请先完成当前步骤。`,
        },
        description: `Phase 不匹配: node=${nodePhase}, actual=${calledPhase}`,
      };
    }

    // 3. 范围蔓延检查：如果本轮只读操作数远超节点预期
    // （例如 edit 节点却有 5+ 次 read）
    if (this.contract.allowedTools.includes('write_file') && toolCalls.every(tc => tc.name.startsWith('read') || tc.name === 'search_codebase')) {
      if (toolCalls.length > this.contract.nodeGuard.maxSameToolRepeat) {
        return {
          deviated: true,
          type: 'scope_creep',
          severity: 'soft',
          correction: {
            type: 'inject_hint',
            message: `[Contract] 已读取足够上下文。当前节点需要开始编辑操作。请调用 write_file 或 edit_file。`,
          },
          description: `edit 节点只读轮次过多 (${toolCalls.length})`,
        };
      }
    }

    return { deviated: false, type: 'none', severity: 'soft', correction: { type: 'inject_hint', message: '' }, description: '' };
  }
}

function inferPhaseFromTools(toolCalls: ToolCall[]): TaskPhase {
  const names = toolCalls.map(tc => tc.name);
  if (names.some(n => n === 'write_file' || n === 'edit_file' || n === 'patch_file')) return 'editing';
  if (names.some(n => n === 'run_command')) return 'verification';
  return 'context';
}
```

### 20.5 完整状态流：Node Contract 在 Harness 循环中的生命周期

```
Harness 每轮迭代:

1. 获取当前 TaskNode
   ↓
2. 创建/恢复 ContractValidator  ← 每个节点一个实例
   ↓
3. LLM 调用前: 注入 contract 上下文到 system reminder
   "[Contract] 节点: ${node.title}
    允许工具: ${allowedTools.join(', ')}
    完成条件: ${completionCriteria}"
   ↓
4. LLM 返回 → 解析 toolCalls
   ↓
5. for each toolCall:
   ├─ contractValidator.checkBeforeToolCall(toolName)
   │  ├─ action=allow  → 正常执行
   │  ├─ action=warn   → 执行 + 注入警告到下一轮
   │  ├─ action=block  → 返回 tool_result: { error: contractMessage }
   │  └─ action=force_switch → 跳过执行 → 触发 fallback
   │
   ├─ 执行工具 (如果未被 block)
   └─ contractValidator.recordAfterToolCall(toolName, success, detectSignal())
   ↓
6. DeviationDetector.detect(toolCalls, taskStateSnapshot)
   ├─ severity=soft → 下一轮注入 hint
   ├─ severity=hard → 阻止违规工具 + 注入 hint
   └─ severity=critical → switchToFallbackBranch()
   ↓
7. contractValidator.checkRoundEnd(toolCountThisRound)
   ├─ idle_round 超限 → 强制推进或 fallback
   └─ round_exceeded → force_switch
   ↓
8. contractValidator.checkCompletion()
   ├─ completed=true → completeCurrentNode() → advanceCursor()
   └─ completed=false → continue loop
```

### 20.6 与现有系统的接入点

| 现有系统 | 接入方式 | 文件 |
|---|---|---|
| **PermissionManager** | NodeContract 在 PermissionManager 之后生效（双层过滤）。forbiddenTools 硬拒绝不经过确认对话框。 | `src/harness/permission.ts` |
| **TaskState** | `TaskState.recordToolResult()` 照常运行；ContractValidator 额外记录 `outputSignals`。两者并行不冲突。 | `src/harness/task-state.ts` |
| **StepReview** | `DeviationDetector` 直接复用 `reviewStep()` 的 `ReviewToolTrace[]` 和 `heuristicReview()`。StepReview 判断"是否有进展"，DeviationDetector 判断"是否偏离节点"。 | `src/harness/step-review.ts` |
| **BranchBudgetTracker** | `NodeGuardConfig.maxSameToolRepeat` 与 `BranchBudgetTracker` 互补：前者关注**节点内**连续重复，后者关注**跨节点**累计预算。两者同时触发时取更严格的。 | `src/harness/branch-budget.ts` |
| **Resilience v2** | `contractValidator.checkRoundEnd()` 触发的 `force_switch` 与 `BranchBudgetTracker.shouldBranchRecover()` 触发的 recovery signal 可以合并处理：优先 force_switch（更具体），其次 budget recovery。 | `src/harness/checkpoint-engine.ts` |

---

## 21. Graph Evaluation Metrics（图执行评分系统）

### 21.1 设计目标

图评分系统为两个场景服务：
1. **Adaptive Planner (v2)**：基于历史指标优化图模板选择
2. **Eval Runner**：量化每次任务执行的质量

### 21.2 Node 级别指标

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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

/** 计算节点评分 */
export function calcNodeScore(metrics: NodeMetrics): number {
  let score = 0;
  // 成功完成 +40
  if (metrics.success) score += 40;
  // 无重试 +20
  if (metrics.retries === 0) score += 20;
  else score += Math.max(0, 20 - metrics.retries * 8);
  // 信号完成率 × 20
  score += Math.round(metrics.signalCompletionRate * 20);
  // 输出质量 × 0.2
  score += Math.round(metrics.outputQuality * 0.2);
  // 无空转 +10
  if (metrics.idleRounds === 0) score += 10;
  return Math.min(100, score);
}
```

### 21.3 Branch 级别指标

```typescript
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

export function calcBranchEfficiency(metrics: BranchMetrics): number {
  const total = metrics.nodeCount;
  if (total === 0) return 0;
  return Math.round((metrics.avgNodeScore / 100) * (1 - metrics.branchDeadRatio) * 100);
}
```

### 21.4 Graph 级别指标

```typescript
export interface GraphMetrics {
  graphId: string;
  goal: string;
  intent: TaskIntent;
  /** 图完成评分（0-100） */
  completionScore: number;
  /** 确定性比率（按计划完成的比例 vs 走 fallback 的比例） */
  deterministicRatio: number;           // 1.0 = 完全按主分支完成
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
  /** 时间戳 */
  evaluatedAt: number;
}

export function calcSuccessConfidence(metrics: GraphMetrics): number {
  const weights = {
    completionScore: 0.30,
    deterministicRatio: 0.25,
    recoverySuccessRate: 0.15,
    branchEfficiency: 0.20,
    wastedStepsPenalty: 0.10,
  };

  const avgBranchEff = metrics.branchMetrics.length > 0
    ? metrics.branchMetrics.reduce((s, b) => s + b.branchEfficiency, 0) / metrics.branchMetrics.length
    : 0;

  const wastedPenalty = metrics.wastedSteps > 0
    ? Math.max(0, 1 - metrics.wastedSteps / (metrics.wastedSteps + metrics.nodeMetrics.filter(n => n.success).length))
    : 1;

  return (
    (metrics.completionScore / 100) * weights.completionScore +
    metrics.deterministicRatio * weights.deterministicRatio +
    metrics.recoverySuccessRate * weights.recoverySuccessRate +
    (avgBranchEff / 100) * weights.branchEfficiency +
    wastedPenalty * weights.wastedStepsPenalty
  );
}
```

### 21.5 与现有系统的整合

| 现有系统 | 整合方式 |
|---|---|
| **ExecutionPlanTracker** | `GraphMetrics` 在 `markGraphDone()` 时计算。数据来源：`nodeHistory`（节点状态）、`branchHistory`（分支切换）、`TaskStateSnapshot`（phase 信息）。不依赖 ExecutionPlanTracker 内部状态。 |
| **RuntimeSnapshot** | `NodeMetrics.toolDistribution` 从 `TaskStateSnapshot.commandsRun` + `filesRead` + `filesChanged` 聚合。`verificationScore` 从 `VerificationStatus` 推导（passed=100, failed=0, required=50）。 |
| **CheckpointEngine** | `GraphMetrics` 作为 `CombinedCheckpointFile` 的新增可选字段持久化：`graphMetrics?: GraphMetrics`。每次 `markGraphDone()` 后写入。`CheckpointSaveTrigger` 新增 `graph_evaluated`。 |
| **Session Notes** | `GraphMetrics` 序列化为 `icecoder-metrics` fence（与 `icecoder-runtime` / `icecoder-plan` / `icecoder-graph` 平行）：<br>```` ```icecoder-metrics `` `` ``` ```` `` `` ` `` ` `` ` `` ` `` ` `` ` `` ` ` `` `` `` |

### 21.6 指标持久化

```
持久化时机:
  markGraphDone()   → full GraphMetrics snapshot
  node complete      → partial NodeMetrics (增量写入)
  branch switch      → partial BranchMetrics

持久化位置:
  1. CombinedCheckpointFile.graphMetrics   (JSON, 与 v1/v2 checkpoint 共存)
  2. session-notes.md → ```icecoder-metrics  (fenced JSON)

恢复时:
  applySnapshot() 恢复 graphMetrics → 后续执行仅累加差值
  (不覆盖已有指标，避免重复计数)
```

### 21.7 驱动 Adaptive Planning (v2 展望)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ GraphMetrics │────▶│ MetricStore   │────▶│ Adaptive    │
│ (每次执行)   │     │ (历史指标库)  │     │ Planner     │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                  为相同 intent 的任务选择:       │
                  - 最成功的图模板               │
                  - 合理的 fallback 配置         │
                  - 优化的 maxRetries            │
                                                ▼
                                         TaskGraph (优化后)
```

**当前阶段**：仅计算和持久化指标。Adaptive Planner 是 v2 功能——但指标数据结构从 v1 就位，确保后续无缝衔接。

---

## 22. Graph Replay System（图回放系统）

### 22.1 设计目标

回放系统用于：
- **调试**：复现失败的执行路径
- **评估**：为 Eval Runner 提供标准化输入
- **分析**：对比不同策略的执行效果

### 22.2 Replay 数据源

基于现有系统构建 replay 轨迹，不引入新的数据采集：

| 数据源 | 文件 | 提供内容 |
|---|---|---|
| **Session checkpoint** | `*.checkpoint.json` | 任务目标、TaskState、LoopState、stopReason |
| **Runtime v2 checkpoint** | `runtimeV2` 字段 | 工具历史、失败历史、recovery signal、分支预算 |
| **Session notes** | `session-notes.md` | `icecoder-runtime` + `icecoder-plan` + `icecoder-graph` fence |
| **Execution events** | `ExecutionPlanTracker` 事件流 | step 状态转换时间线 |
| **TaskState history** | `TaskStateSnapshot` (checkpoint) | phase 推进、文件读写记录、命令执行记录 |

### 22.3 Replay Trace 数据结构

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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

export type ReplayType =
  | 'full'             // 完整图回放
  | 'node'             // 单节点回放
  | 'branch'           // 单分支回放
  | 'checkpoint'       // 从断点回放
  | 'sub_agent'        // 子代理回放
  | 'tool'             // 单工具回放
  | 'failure';         // 故障回放

/** 节点回放 */
export interface NodeReplay {
  nodeId: string;
  nodeType: TaskNodeType;
  status: 'done' | 'failed' | 'skipped';
  startedAt: number;
  endedAt: number;
  roundsUsed: number;
  toolCallsInNode: string[];   // tool replay IDs
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
  nodeId: string;  // 所属节点
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
  status: TaskCheckpointStatus;
  graphSnapshot: TaskGraphSnapshot;
  loopState: { currentRound: number; totalToolCalls: number };
  savedAt: number;
}
```

### 22.4 Replay 构建流程

```
构建 ReplayTrace:

1. 从 CombinedCheckpointFile 加载:
   ├─ taskState → 确定 goal / intent
   ├─ runtimeV2.recentTools → ToolReplay[] (前 20 条)
   ├─ runtimeV2.recentFailures → FailureReplay[]
   ├─ taskGraph.nodes → NodeReplay[]
   └─ taskGraph.branchHistory → BranchReplay[]

2. 从 session-notes.md 解析:
   ├─ icecoder-plan fence → ExecutionPlan (step 时间线)
   └─ icecoder-graph fence → TaskGraphSnapshot (cursor 路径)

3. 构造时间线:
   ToolReplay 按 calledAt 排序 → 分配到所在 nodeId
   NodeReplay 按 startedAt 排序 → 分配到所在 branchId
   BranchReplay 按 enteredAt 排序 → 主分支 → fallback 分支链

4. 输出 ReplayTrace → 序列化为 ```icecoder-replay fence
```

### 22.5 Replay 序列图

```
EvalRunner / CLI         ReplayBuilder          Checkpoint             SessionNotes
     │                       │                      │                      │
     │──replay(graphId)─────►│                      │                      │
     │                       │──load()─────────────►│                      │
     │                       │◄──TaskCheckpoint─────│                      │
     │                       │──parse()──────────────────────────────────►│
     │                       │◄──GraphSnapshot + Plan─────────────────────│
     │                       │                      │                      │
     │                       │──buildTimeline()──┐  │                      │
     │                       │     ├─ NodeReplay[]│  │                      │
     │                       │     ├─ ToolReplay[]│  │                      │
     │                       │     ├─ BranchReplay│  │                      │
     │                       │     └─ FailureReplay                      │
     │                       │◄──────────────────┘  │                      │
     │                       │                      │                      │
     │◄──ReplayTrace─────────│                      │                      │
     │                       │                      │                      │
     │──render / eval───────►│                      │                      │
```

### 22.6 与 Eval Runner 对接

ReplayTrace 是 Eval Runner 的**标准化输入**：

```typescript
// Eval Runner 消费 replay
interface EvalInput {
  replay: ReplayTrace;
  metrics: GraphMetrics;      // 来自 §21
  expectedOutcome: {
    successExpected: boolean;
    minCompletionScore?: number;
    maxWastedSteps?: number;
  };
}

interface EvalOutput {
  passed: boolean;
  score: number;
  breakdown: {
    replayFidelity: number;    // replay 数据完整性
    metricAlignment: number;   // 指标与预期的对齐度
    recoveryQuality: number;   // fallback 效果
  };
}
```

---

## 23. Integration With Eval Runner（与评估运行器集成）

### 23.1 架构定位

```
┌──────────────────────────────────────────────┐
│                  Eval Runner                  │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Benchmark │  │ Replay   │  │ Score Calc │  │
│  │ Loader    │  │ Engine   │  │             │  │
│  └─────┬─────┘  └────┬─────┘  └──────┬─────┘  │
│        │             │               │        │
└────────┼─────────────┼───────────────┼────────┘
         │             │               │
         ▼             ▼               ▼
┌──────────────────────────────────────────────┐
│              TaskGraph (执行层)               │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Builder  │  │ Executor │  │  Metrics   │  │
│  └──────────┘  └──────────┘  └────────────┘  │
└──────────────────────────────────────────────┘
```

**Graph 是执行层**：负责规划、执行、记录。  
**Eval Runner 是评估层**：负责回放、评分、对比。

### 23.2 Eval Runner 读取的数据

| 数据 | 来源 | 用途 |
|---|---|---|
| `GraphMetrics` | `CombinedCheckpointFile.graphMetrics` | 整体评分 |
| `ReplayTrace` | `ReplayBuilder.build(graphId)` | 步骤级分析 |
| `NodeMetrics[]` | `GraphMetrics.nodeMetrics` | 节点粒度评估 |
| `BranchMetrics[]` | `GraphMetrics.branchMetrics` | 分支策略评估 |
| `VerificationStatus` | `TaskStateSnapshot.verificationStatus` | 验证结果 |

### 23.3 Benchmark 支持

```typescript
// Eval Runner 的 benchmark 定义
interface EvalBenchmark {
  name: string;
  description: string;
  /** 测试用例列表 */
  cases: EvalCase[];
  /** 通过阈值 */
  threshold: {
    minCompletionScore: number;
    maxWastedSteps: number;
    minRecoverySuccessRate: number;
  };
}

interface EvalCase {
  id: string;
  goal: string;              // 任务目标（模拟用户输入）
  intent: TaskIntent;
  /** 期望的节点序列 */
  expectedNodeTypes: TaskNodeType[];
  /** 期望成功 */
  expectSuccess: boolean;
  /** 允许的最大重试次数 */
  maxRetriesAllowed: number;
  /** 期望的验证命令 */
  expectedVerification?: string;
}
```

### 23.4 完整运行流程

```
Eval Runner 执行一次 benchmark case:

1. LOAD
   ├─ 读取 EvalBenchmark.cases[i]
   └─ 构造 HarnessConfig (goal + intent)

2. PLAN
   ├─ TaskGraphBuilder.build(goal, intent, repoContext)
   └─ 生成 TaskGraph

3. EXECUTE
   ├─ GraphExecutor.run(graph) → 驱动 Harness 循环
   ├─ 每轮: ContractValidator.checkBeforeToolCall → DeviationDetector.detect
   ├─ 完成: markGraphDone() → calcNodeScore → GraphMetrics
   └─ 持久化: checkpoint + session-notes

4. REPLAY
   ├─ ReplayBuilder.build(graphId) → ReplayTrace
   └─ 验证 replay 与原始执行一致（完整性检查）

5. EVALUATE
   ├─ 对比 expectedNodeTypes vs actual nodeTypes
   ├─ 对比 expectSuccess vs actual success
   ├─ 计算:
   │   ├─ completionScore   ≥ threshold.minCompletionScore?
   │   ├─ wastedSteps       ≤ threshold.maxWastedSteps?
   │   └─ recoverySuccessRate ≥ threshold.minRecoverySuccessRate?
   └─ 输出: EvalOutput { passed, score, breakdown }

6. REPORT
   ├─ 汇总所有 cases 的通过率
   ├─ 输出每个 case 的详细 breakdown
   └─ 生成 markdown/json 报告
```

### 23.5 Eval Runner 命令行接口（设计）

```bash
# 运行单个 benchmark
npx tsx scripts/eval-runner.ts --benchmark edit-tasks

# 运行全部 benchmark
npx tsx scripts/eval-runner.ts --all

# 仅回放不执行（从已有 checkpoint 加载）
npx tsx scripts/eval-runner.ts --replay <graphId>

# 输出 JSON 报告
npx tsx scripts/eval-runner.ts --format json --output eval-report.json
```

---

## 24. Updated Implementation Order（更新的实现顺序）

基于对全部实际代码的深入分析，重新编排实现优先级。每个 Phase 基于真实文件依赖关系排序。

### Phase A: 类型定义（零风险，全部新文件）

| 任务 | 文件 | 风险 | 复杂度 | 预期收益 |
|---|---|---|---|---|
| TaskGraph 核心类型定义 | `src/types/task-graph.ts` | 低 | 低 | 奠定全部后续工作的类型基础 |
| 测试：类型编译通过 | `npx tsc --noEmit` | — | — | — |

**实际依赖**：`src/types/runtime-snapshot.ts`（复用 `TaskIntent`, `TaskPhase`）  
**不依赖**：任何 harness 文件

### Phase B: 图数据结构 + 核心操作（低风险，新文件）

| 任务 | 文件 | 风险 | 复杂度 | 预期收益 |
|---|---|---|---|---|
| TaskGraph CRUD：create / advanceCursor / completeCurrentNode / toSnapshot / applySnapshot | `src/harness/task-graph.ts` | 低 | 中 | 图执行的基础设施 |
| 节点状态机 + 游标操作 + 分支切换 | 同上 | 低 | 中 | fallback 机制的基础 |
| 单元测试：create → advance → complete 全流程 | `test/task-graph.test.ts` | — | — | — |

**实际依赖**：`src/types/task-graph.ts`、`src/types/runtime-snapshot.ts`  
**不依赖**：任何现有 harness 逻辑改动

### Phase C: Builder + Contract（中等风险，新文件 + harness.ts 轻微改动）

| 任务 | 文件 | 风险 | 复杂度 | 预期收益 |
|---|---|---|---|---|
| 规则驱动 Builder（intent → 图模板） | `src/harness/task-graph-builder.ts` | 中 | 中 | 自动图生成，消除人工配置 |
| Node Contract 类型 + ContractValidator | `src/types/task-graph.ts` 扩展 + `src/harness/task-graph-review.ts` | 中 | 高 | **执行稳定性核心** |
| DeviationDetector（复用 StepReview） | `src/harness/task-graph-review.ts` | 中 | 中 | 偏离检测，减少无效循环 |
| Harness 集成：feature flag + 合约检查点 | `src/harness/harness.ts`（约 60 行新增） | 中 | 中 | 图模式激活 |
| 配置模块 | `src/harness/task-graph-config.ts` | 低 | 低 | `ICE_TASK_GRAPH` 环境变量 |

**实际依赖**：`Phase B`、`src/harness/step-review.ts`（复用 `heuristicReview`）、`src/harness/branch-budget.ts`（复用 `shouldBranchRecover`）  
**Harness 改动点**（精确位置）：
- `harness.ts` L385-L410（构造函数：注入 `GraphExecutor`）
- `harness.ts` L690-L720（任务切换检测后：初始化/重置 TaskGraph）
- `harness.ts` L1100-L1150（工具调用执行前：`ContractValidator.checkBeforeToolCall`）

### Phase D: 持久化 + Checkpoint 集成（低风险，扩展现有文件）

| 任务 | 文件 | 风险 | 复杂度 | 预期收益 |
|---|---|---|---|---|
| GraphSnapshot 序列化到 checkpoint | `src/harness/checkpoint-engine.ts`（新增 `taskGraph` 字段） | 低 | 低 | 断点恢复 |
| Session notes `icecoder-graph` fence | `src/memory/file-memory/session-memory.ts`（新增 fence 类型） | 低 | 低 | 跨会话恢复 |
| GraphMetrics 计算 + 持久化 | `src/harness/task-graph.ts` 扩展 + checkpoint | 低 | 中 | 评分数据基础 |
| `icecoder-metrics` fence | 同上 session-memory.ts | 低 | 低 | 历史指标积累 |

**实际依赖**：`Phase C`、`src/harness/checkpoint-engine.ts`（`CombinedCheckpointFile` 已有扩展机制）  
**不引入破坏性改动**：所有新增字段都是可选的（`taskGraph?`, `graphMetrics?`）

### Phase E: 前端接续（低风险，仅扩展现有 JS 文件）

| 任务 | 文件 | 风险 | 复杂度 | 预期收益 |
|---|---|---|---|---|
| 新增 `task_graph_*` 事件处理 | `chat-page.js`（`onWsStep` 新增 ~25 行） | 低 | 低 | 面板实时更新 |
| 面板渲染扩展（分支标记） | `chat-execution-plan.js`（`renderStepNode` 新增分支样式） | 低 | 低 | 分支可视化 |
| Bridge 接入新事件 | `chat-execution-plan-bridge.js`（`handleStep` 新增 ~15 行） | 低 | 低 | 事件路由 |
| 冰豆表情映射扩展 | `chat-pet-bridge.js`（`applyHarnessStepToPet` 新增映射） | 低 | 低 | 表情反馈 |

**实际依赖**：`Phase D`（需要 WebSocket 发射新事件类型）  
**前端文件改动量**：总计约 80 行，分散在 4 个已有文件中  
**不新增前端文件**：完全复用现有渲染管线

### Phase F: Eval Runner + Replay（中等风险，新文件）

| 任务 | 文件 | 风险 | 复杂度 | 预期收益 |
|---|---|---|---|---|
| ReplayTrace 类型 + ReplayBuilder | `src/harness/task-graph-replay.ts` | 低 | 中 | 调试 + 评估基础设施 |
| EvalRunner 框架 | `scripts/eval-runner.ts` | 中 | 中 | Benchmark 自动化 |
| GraphMetrics → MetricStore | `src/harness/task-graph-metrics.ts` | 低 | 中 | 历史指标聚合 |

**实际依赖**：`Phase D`（依赖 `GraphMetrics` + `ReplayTrace` 数据）

### 总结表

| Phase | 新增文件 | 修改文件 | 风险 | 总行数估计 | 可独立验证 |
|---|---|---|---|---|---|
| A | 1 | 0 | 低 | ~200 | `npx tsc --noEmit` |
| B | 1 + 1 test | 0 | 低 | ~350 + ~200 | `npx vitest --run` |
| C | 3 | 1 (harness.ts) | 中 | ~500 + ~60 | 单元测试 + 手动集成测试 |
| D | 0 | 2 | 低 | ~150 | checkpoint 兼容性测试 |
| E | 0 | 4 | 低 | ~80 | 手动 WebSocket 测试 |
| F | 2 | 0 | 中 | ~400 | `npx tsx scripts/eval-runner.ts` |
| **总计** | **7** | **7** | — | **~1940** | — |

### 回滚策略

每个 Phase 通过一个 feature flag 控制：
- **Phase A-C**：`ICE_TASK_GRAPH=1` 环境变量。关闭时 Harness 零影响。
- **Phase D**：checkpoint 字段为可选 `?`，旧 checkpoint 完全兼容。
- **Phase E**：前端通过 `executionPlan` feature flag（已有）控制面板显示。新事件类型未启用时走现有渲染。
- **Phase F**：Eval Runner 为独立 CLI 脚本，不影响主进程。

---

## 25. Graph Session Boundary（图会话边界）

### 25.1 问题分析

当前 Harness 的任务生命周期由 `TaskCheckpointManager`（`src/harness/checkpoint.ts`）的 `status` 字段管理：`running → paused → completed / failed / aborted`。但 TaskGraph 引入后，一个 Harness 会话可能包含**多张图**（用户连续发多个任务），需要一个明确的边界定义：

- 何时创建新图 vs 复用旧图？
- 图何时算"完成"——用户说 "OK" 之后是否立即关闭？
- 图未完成时用户切新任务，旧图是 pause 还是 discard？
- 图与 `TaskCheckpoint` 的 session 边界如何对齐？

### 25.2 会话边界模型

```
Harness Session（一次 WebSocket 连接或 CLI 进程）
├── Task 1 (goal: "修复登录bug")
│   └── TaskGraph A: graphId=g1
│       ├── ready → running → done
│       └── checkpoint: taskId=t1 (g1 关联到 t1)
│
├── Task 2 (goal: "添加单元测试")     ← 用户发新任务
│   └── TaskGraph B: graphId=g2      ← 新图
│       └── checkpoint: taskId=t2
│
└── Task 3 (goal: "重构")
    └── TaskGraph C: graphId=g3
```

**规则**：
- **1 task = 1 graph**：每次 `Harness.run(userMessage)` 若检测到任务切换（现有 `bigramJaccard` 检测，`harness.ts` L700-L710），创建新图。
- **1 graph = 1 checkpoint**：`TaskCheckpoint.taskId` 与 `TaskGraph.graphId` ——对应，跨会话恢复时按 taskId 匹配。

### 25.3 数据结构

```typescript
// ─── src/types/task-graph.ts 扩展 ───

/** 图会话边界状态 */
export type GraphSessionStatus =
  | 'active'       // 当前活跃图（Harness 正在执行）
  | 'paused'       // 用户中断，可恢复
  | 'completed'    // 任务成功完成
  | 'failed'       // 任务失败（含 fallback 耗尽）
  | 'discarded'    // 用户显式放弃（发新任务覆盖）
  | 'orphaned';    // 旧 checkpoint 存在但无活跃会话

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
```

### 25.4 生命周期状态流

```
用户发任务
    │
    ▼
[任务切换检测] ──否──▶ 继续当前图 (复用 active graph)
    │
   是
    │
    ▼
[旧图处理]
 ├─ active.status = 'completed'  (如果 done)
 ├─ active.status = 'failed'     (如果 failed)
 ├─ active.status = 'paused'     (如果 running 但未完成)
 └─ 写入旧图最终 checkpoint
    │
    ▼
[新图创建]
 graphId = randomUUID()
 taskId = createTaskId(goal)
 graph.status = 'active'
 sessionIndex++
    │
    ▼
[Harness 循环执行]
    │
    ├─ 用户 abort → graph.status = 'paused'
    │                (可恢复：下次 run() 检测到同 goal → applySnapshot)
    │
    ├─ 任务完成   → graph.status = 'completed'
    │                markGraphDone()
    │
    └─ 全部失败   → graph.status = 'failed'
                     markGraphFailed()
```

### 25.5 跨会话恢复

```
Harness 启动 → 加载 active checkpoint:
  ├─ checkpoint.status = 'running' | 'paused'
  │  └─ 恢复 TaskGraph:
  │     ├─ 从 CombinedCheckpointFile.taskGraph 读取 snapshot
  │     ├─ 从 session-notes.md 读取 icecoder-graph fence (更新版本)
  │     ├─ 重建 TaskGraph (原 intent + 原 nodes)
  │     ├─ applySnapshot(graph, snapshot)
  │     └─ 注入 resume 提示 → 继续执行
  │
  └─ checkpoint.status = 'completed' | 'failed' | null
     └─ 不恢复，等待新任务
```

### 25.6 与现有代码集成点

| 集成点 | 位置 | 改动 |
|---|---|---|
| 任务切换检测 | `harness.ts` L700-L710 (`bigramJaccard`) | 切换时调用 `boundaryManager.onTaskSwitch()` |
| 用户 abort | `harness.ts` L724-L726 (`isAborted()`) | abort 时 `graph.status = 'paused'` |
| stop hook | `harness.ts` `handleStop()` | 根据 `stopReason` 设置 `graph.status` |
| Checkpoint save | `checkpoint-engine.ts` `save()` | 保存 `graphSession` 状态 |
| Session notes | `session-memory.ts` | 新增 `graphSession` 元数据 |

### 25.7 v1/v2 建议

- **v1**：仅实现 `active/paused/completed/failed` 四种状态。`orphaned` / `discarded` 暂不需要。
- **v2**：引入 session 清理策略（超过 N 天的 `completed` / `failed` graph 自动清理 checkpoint）。

---

## 26. Node Cost Budget（节点成本预算）

### 26.1 问题分析

`BranchBudgetTracker`（`src/harness/branch-budget.ts`）追踪的是**跨节点**累积：
- 同一文件编辑次数超限（`fileEditMax=3`）
- 同一命令重试超限（`commandRetryMax=2`）
- 同一错误重复超限（`errorRepeatMax=3`）

但缺少**节点内**的成本预算——一个 `edit` 节点应该花多少 token、多少轮次、多少工具调用？缺少节点级预算会导致：
- LLM 在单个节点上消耗过多资源
- 无法判断节点是否"卡住"
- 无法做成本感知的 fallback 决策

### 26.2 数据结构

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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
```

### 26.3 按节点类型的默认预算

基于对现有 Harness 行为的分析（`LoopControlConfig` 默认 `maxRounds=50`，`MAX_CONSECUTIVE_TOOL_FAILURES=3`），设定节点级预算：

| 节点类型 | maxTokens | maxRounds | maxToolCalls | maxDurationMs | 理由 |
|---|---|---|---|---|---|
| `inspect` | 8,000 | 5 | 8 | 60,000 | 只读探查，应快速完成 |
| `search` | 6,000 | 4 | 6 | 45,000 | 搜索范围可控 |
| `read` | 4,000 | 3 | 5 | 30,000 | 单文件读取 |
| `edit` | 16,000 | 8 | 12 | 120,000 | 编辑是核心操作 |
| `verify` | 8,000 | 5 | 8 | 90,000 | 含测试执行时间 |
| `summarize` | 3,000 | 2 | 0 | 20,000 | 纯文本输出 |
| `fallback` | 8,000 | 4 | 6 | 60,000 | 简化策略，预算收紧 |
| `delegate` | — | — | — | — | 由 SubAgent 自身预算控制 |

### 26.4 CostTracker 在 Harness 循环中的状态流

```
节点开始 (startCurrentNode):
  costTracker = new NodeCostTracker(budget)
  costTracker.startedAt = Date.now()
    │
    ▼
每轮 LLM 调用后:
  costTracker.tokensUsed += response.usage.totalTokens
  costTracker.roundsUsed++
    │
  ├─ tokensUsed > budget.maxTokens   → exhaustedBy='tokens'
  ├─ roundsUsed > budget.maxRounds    → exhaustedBy='rounds'
  ├─ toolCallsUsed > budget.maxToolCalls → exhaustedBy='tool_calls'
  └─ (Date.now() - startedAt) > maxDurationMs → exhaustedBy='duration'
    │
    ▼
预算耗尽:
  costTracker.utilizationRate = calcUtilization()
    │
  ├─ 节点有进展 (StepReview.progressMade=true)
  │  └─ 允许超标 20%（softBudget 模式）
  │
  └─ 节点无进展
     └─ 强制 completeCurrentNode(graph, '预算耗尽: ' + exhaustedBy)
        → 触发 needsRecovery() → fallback branch
```

### 26.5 与现有代码集成点

| 集成点 | 文件 | 方式 |
|---|---|---|
| `LoopControlConfig.tokenBudget` | `harness.ts` L385-L410 | NodeCostBudget 是 LoopControlConfig 的**每节点子集**——图模式下用节点预算替代全局 tokenBudget |
| `BranchBudgetTracker` | `branch-budget.ts` | 互补：BranchBudget 是跨节点累加，NodeCostBudget 是节点内预算。两者同时监控 |
| `ContextCompactor` | `context-compactor.ts` | 节点 token 预算接近上限时，优先触发 compaction 而非直接 abort |
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | `harness.ts` L59 | 保持在节点级预算内（maxToolCalls 纳入此限制） |

### 26.6 v1/v2 建议

- **v1**：固定预算表（上表硬编码），不动态调整。
- **v2**：根据 `GraphMetrics` 历史数据动态调整：成功率高的节点类型放宽预算，频繁超预算的节点类型收紧。

---

## 27. Escalation Policy（升级策略）

### 27.1 问题分析

当前 Harness 的纠正手段是**扁平的**：

```
system message 注入 → stop_hook 干预 → circuit_breaker 熔断
```

缺少**递进式**升级——软纠正失败后自动升级到硬纠正，再失败升级到分支切换。所有干预在同一层级，导致：
- 轻微偏离被过度反应
- 严重偏离纠正不够及时
- 无自动化升级决策

### 27.2 四级升级模型

```
Level 0: 观察 (Observe)
  └─ 不干预，仅记录偏离
     └─ 触发条件: DeviationDetector.detect() → severity='soft'

Level 1: 软纠正 (Soft Correct)
  └─ 注入 system reminder (现有机制)
     └─ 触发条件: 连续 2 轮 severity='soft'
       或 1 次 severity='hard'

Level 2: 硬纠正 (Hard Correct)
  └─ 阻止违规工具 + 强制重置节点状态
     └─ 触发条件: 软纠正后仍偏离
       或 severity='critical'

Level 3: 分支切换 (Branch Switch)
  └─ switchToFallbackBranch()
     └─ 触发条件: 硬纠正后仍偏离
       或 budget 耗尽
```

### 27.3 数据结构

```typescript
// ─── src/types/task-graph.ts 扩展 ───

export interface EscalationPolicy {
  /** 每级升级的阈值 */
  thresholds: EscalationThreshold[];
  /** 当前升级级别 */
  currentLevel: EscalationLevel;
  /** 升级历史 */
  history: EscalationEntry[];
}

export type EscalationLevel = 0 | 1 | 2 | 3;

export interface EscalationThreshold {
  level: EscalationLevel;
  /** 触发此级别的连续偏离轮次 */
  consecutiveDeviations: number;
  /** 允许的最大纠正尝试次数 */
  maxCorrectionAttempts: number;
  /** 升级动作 */
  action: EscalationAction;
}

export type EscalationAction =
  | { type: 'none' }
  | { type: 'inject_hint'; message: string }
  | { type: 'block_and_reset'; blockedTools: string[]; message: string }
  | { type: 'force_branch_switch'; reason: FallbackReason };

export interface EscalationEntry {
  fromLevel: EscalationLevel;
  toLevel: EscalationLevel;
  reason: string;
  at: number;
  nodeId: string;
}
```

### 27.4 升级状态流

```
每轮 Harness 执行后:

DeviationDetector.detect()
    │
    ├─ severity='none' → escalation.currentLevel = 0, 重置计数器
    │
    ├─ severity='soft'
    │  └─ deviationCounter++
    │     ├─ counter < thresholds[1].consecutiveDeviations → Level 0 (观察)
    │     └─ counter >= thresholds[1].consecutiveDeviations → Level 1 (软纠正)
    │
    ├─ severity='hard'
    │  └─ 直接进入 Level 1，若已是 Level 1 → Level 2 (硬纠正)
    │
    └─ severity='critical'
       └─ 直接进入 Level 2，若已是 Level 2 → Level 3 (分支切换)

Level 1 纠正后:
  └─ 下一轮仍偏离 → Level 2
  └─ 下一轮正常   → Level 0 (降级)

Level 2 纠正后:
  └─ 下一轮仍偏离 → Level 3
  └─ 下一轮正常   → Level 1 (部分降级)

Level 3:
  └─ switchToFallbackBranch() → 新分支重置为 Level 0
  └─ 无可用 fallback → markGraphFailed()
```

### 27.5 默认阈值配置

```typescript
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  thresholds: [
    { level: 0, consecutiveDeviations: 1, maxCorrectionAttempts: 99, action: { type: 'none' } },
    { level: 1, consecutiveDeviations: 2, maxCorrectionAttempts: 2, action: { type: 'inject_hint', message: '' } },
    { level: 2, consecutiveDeviations: 1, maxCorrectionAttempts: 1, action: { type: 'block_and_reset', blockedTools: [], message: '' } },
    { level: 3, consecutiveDeviations: 1, maxCorrectionAttempts: 1, action: { type: 'force_branch_switch', reason: 'repeated_failure' } },
  ],
  currentLevel: 0,
  history: [],
};
```

### 27.6 与现有代码集成点

| 集成点 | 位置 | 方式 |
|---|---|---|
| `StopHookManager` | `harness.ts` → `stop-hooks.ts` | EscalationPolicy 替代 `stopHookContinuationCount` 的简单计数。Level 1-2 走 `inject_hint`（替代 stop_hook），Level 3 走 `force_branch_switch`（替代 circuit_breaker）。 |
| `DeviationDetector` | `task-graph-review.ts`（新增） | `escalationPolicy.evaluate(deviationResult)` — DeviationDetector 输出严重级别，EscalationPolicy 决定动作。 |
| `BranchBudgetTracker.shouldBranchRecover()` | `branch-budget.ts` | Escalation Level 3 触发时与 `shouldBranchRecover()` 合并：任一方建议 switch 即执行。 |

### 27.7 v1/v2 建议

- **v1**：使用上述固定阈值。4 级硬编码，不动态调整。
- **v2**：根据 `GraphMetrics.recoverySuccessRate` 调整阈值——恢复成功率低的 intent 降低升级门槛（更快切换）。

---

## 28. Graph Compaction（图压缩）

### 28.1 问题分析

长任务中，TaskGraph 的累积状态（`nodeHistory`、`branchHistory`、`nodes` 中的 `error` 字段）持续增长，占用 checkpoint JSON 体积。需要一种压缩机制：
- 已完成且不可逆的节点 → 精简为摘要
- 已失效的 fallback 分支 → 移除或标记
- 节点状态的冗余字段 → 只保留恢复必需的最小集

这与现有的 `ContextCompactor`（`src/harness/context-compactor.ts`）是正交的——前者压缩 LLM 上下文消息，后者压缩图结构数据。

### 28.2 压缩策略

```typescript
// ─── src/harness/task-graph.ts 扩展 ───

export interface GraphCompactionConfig {
  /** 触发压缩的 nodeHistory 条数阈值 */
  maxNodeHistoryEntries: number;
  /** 触发压缩的 branchHistory 条数阈值 */
  maxBranchHistoryEntries: number;
  /** 是否压缩已完成节点的详细 error 字段 */
  compactErrors: boolean;
  /** 是否移除已耗尽的 fallback 分支 */
  pruneDeadFallbacks: boolean;
}

export const DEFAULT_GRAPH_COMPACTION: GraphCompactionConfig = {
  maxNodeHistoryEntries: 50,
  maxBranchHistoryEntries: 20,
  compactErrors: true,
  pruneDeadFallbacks: true,
};
```

### 28.3 压缩算法

```
function compactGraph(graph: TaskGraph): TaskGraphSnapshot {
  1. nodeHistory 压缩:
     ├─ 保留最近 N 条完整记录（用于 step-review 上下文）
     ├─ 更早的记录合并为摘要: { count, types, avgRetries, avgDuration }
     └─ 保留所有 'failed' 记录的 error（最多 200 字符）

  2. branchHistory 压缩:
     ├─ 保留最近 M 条完整记录
     └─ 更早的合并为摘要: { totalFallbacks, reasons }

  3. nodes 字段压缩:
     ├─ done 节点: 保留 { status, retryCount }，丢弃 error/evidence
     ├─ skipped 节点: 保留 { status }，丢弃 error
     ├─ failed 节点: 保留 { status, retryCount, error(截断) }
     └─ pending/running 节点: 完整保留

  4. fallbackBranches 剪枝:
     └─ attemptCount >= maxAttempts → 移除（保留 record 在 branchHistory）

  5. 输出 TaskGraphSnapshot（而非完整 TaskGraph）
}
```

### 28.4 触发时机

| 触发条件 | 动作 |
|---|---|
| `nodeHistory.length > maxNodeHistoryEntries` | 自动触发压缩 |
| `branchHistory.length > maxBranchHistoryEntries` | 自动触发压缩 |
| checkpoint save | save 前执行压缩（不改变内存中的完整图） |
| 任务完成 (`markGraphDone`) | 最终一次压缩，最小化持久化体积 |

### 28.5 与现有 ContextCompactor 的协同

```
┌──────────────────────┐     ┌──────────────────────┐
│  ContextCompactor     │     │  GraphCompaction       │
│  (harness.ts L850+)   │     │  (新增)                │
├──────────────────────┤     ├──────────────────────┤
│ 压缩: UnifiedMessage[] │     │ 压缩: TaskGraph/data   │
│ 触发: token 阈值       │     │ 触发: history 条数     │
│ 效果: 减少 LLM 上下文  │     │ 效果: 减少 checkpoint  │
└──────────────────────┘     └──────────────────────┘
         │                            │
         └──────────┬─────────────────┘
                    ▼
          长任务内存 & 磁盘占用同时降低
```

两者互补且独立：ContextCompactor 保证 LLM 上下文不超限，GraphCompaction 保证 checkpoint JSON 不膨胀。

### 28.6 v1/v2 建议

- **v1**：仅实现 `nodeHistory` 截断（保留最近 50 条）。`pruneDeadFallbacks` 和 `compactErrors` 延后。
- **v2**：完整实现 + 可配置阈值（`ICE_GRAPH_COMPACT_MAX_HISTORY`）。

---

## 29. Repo Shape Discovery（仓库形态发现）

### 29.1 问题分析

当前 `TaskGraphBuilder`（§7）仅根据 `intent` 选择图模板，不感知仓库的实际结构。这导致：
- 大型 monorepo 和小型单包项目用同一套模板
- 不区分前端/后端/全栈项目
- 不考虑是否有现成测试基础设施
- 无法预判需要的工具组合

需要在图构建前加入一个**轻量仓库形态发现**步骤。

### 29.2 发现维度

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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

export type RepoType =
  | 'frontend'       // 纯前端项目
  | 'backend'        // 纯后端项目
  | 'fullstack'      // 前后端混合
  | 'cli_tool'       // CLI 工具
  | 'library'        // npm 库
  | 'unknown';       // 无法判断
```

### 29.3 发现流程

```
RepoShapeDiscovery.discover(workspaceRoot):
  1. 读取 package.json
     ├─ scripts.test → 推断 testFramework
     ├─ devDependencies → 推断 typeSystem/lintTool/buildTool
     └─ workspaces[] → isMonorepo

  2. 列出顶层目录
     ├─ src/ → 有源码
     ├─ test/ | __tests__/ → 有测试
     ├─ packages/ → monorepo
     └─ ...

  3. 检测配置文件
     ├─ tsconfig.json → typeScript
     ├─ vite.config.* → buildTool=vite
     ├─ .eslintrc.* → lintTool=eslint
     └─ ...

  4. 估算规模
     └─ 快速遍历 src/ 统计 .ts/.js 文件数 → estimatedFileCount

  5. 输出 RepoShape
```

### 29.4 与 SubAgentRunner 的关系

发现阶段**不使用 SubAgentRunner**（不需要 LLM）。发现是纯文件系统操作：
- `fs.readFile(package.json)` → 解析 JSON
- `fs.readdir(root)` → 顶层目录列表
- `fs.stat(tsconfigPath)` → 配置文件检测
- `fs.readdir(src, { recursive: true })` → 文件计数（限制深度=3，超时 2s）

全部在 `RepoContext`（`src/harness/repo-context.ts`）初始化阶段完成，约 50ms 开销。

### 29.5 RepoShape 如何影响图模板

```
TaskGraphBuilder.build(goal, intent, repoShape):
  1. 选择基础模板（§7.1 intent → template）
  2. 根据 repoShape 调整:
     ├─ typeSystem='typescript' → verify 节点 suggestedTools 加 'tsc --noEmit'
     ├─ testFramework='vitest'  → verify 节点 evidence = 'npx vitest --run'
     ├─ lintTool='eslint'       → verify 节点增加 lint 子步骤
     ├─ isMonorepo=true         → search 节点增加 'cd packages/*' 范围
     └─ estimatedFileCount>500  → delegate 节点（大仓库用子代理探索）
  3. 输出 TaskGraph
```

### 29.6 与现有代码集成点

| 集成点 | 位置 | 方式 |
|---|---|---|
| `RepoContext` | `src/harness/repo-context.ts` | `RepoContext` 初始化时调用 `RepoShapeDiscovery.discover(cwd)`。`RepoShape` 作为 `RepoContext` 的新增字段 |
| `PackageJsonTestFacts` | `session-memory.ts` | 已有 `resolvePackageJsonTestFacts()`，`RepoShapeDiscovery` 复用其逻辑并扩展 |
| `ExecutionPlanGenerator` | `execution-plan-generator.ts` | plan 生成时注入 `repoShape.testFramework` 到 verify step |

### 29.7 v1/v2 建议

- **v1**：仅读取 `package.json`（scripts.test + devDependencies）+ tsconfig 检测。~30 行代码。
- **v2**：完整文件系统扫描 + 缓存结果（避免每次图构建重复扫描）。

---

## 30. Task Complexity Estimator（任务复杂度估算器）

### 30.1 问题分析

当前所有 `edit` 意图使用同一套图模板（5 个节点），但"修复一个拼写错误"和"实现用户认证系统"的复杂度天差地别。需要一种轻量估算器，在构建图时调整：
- 节点数量
- 最大重试次数
- 是否需要 delegate 节点
- Fallback 分支数量

### 30.2 估算维度

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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

export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'hard';
```

### 30.3 估算算法（纯启发式，零 LLM 成本）

```
function estimateComplexity(goal, repoShape, changedFiles): TaskComplexity {
  // 1. Goal 复杂度 (0-40)
  const goalLen = goal.length;
  const goalWords = goal.split(/\s+/).length;
  const hasMultipleSteps = /并且|同时|然后|接着|之后|以及/.test(goal);
  const hasDeepChange = /重构|迁移|重写|架构|系统/.test(goal);
  
  let goalScore = Math.min(40,
    (goalLen > 30 ? 10 : goalLen / 3) +           // 长度因素
    (goalWords > 10 ? 15 : goalWords * 1.5) +     // 词汇因素
    (hasMultipleSteps ? 8 : 0) +                  // 多步骤
    (hasDeepChange ? 7 : 0)                       // 深度变更
  );

  // 2. Repo 复杂度 (0-30)
  let repoScore = Math.min(30,
    (repoShape.isMonorepo ? 10 : 0) +             // monorepo 更复杂
    (repoShape.estimatedFileCount > 500 ? 10 :    // 大仓库
     repoShape.estimatedFileCount > 100 ? 5 : 0) +
    (repoShape.type === 'fullstack' ? 10 :        // 全栈项目
     repoShape.type === 'backend' ? 6 : 0)
  );

  // 3. 文件范围复杂度 (0-30)
  let fileScore = Math.min(30, (changedFiles?.length ?? 0) * 6);

  // 综合
  const totalScore = Math.min(100, goalScore + repoScore + fileScore);

  // 映射到等级
  const level: ComplexityLevel =
    totalScore <= 15 ? 'trivial' :
    totalScore <= 30 ? 'simple' :
    totalScore <= 55 ? 'moderate' :
    totalScore <= 75 ? 'complex' : 'hard';

  return {
    level,
    score: totalScore,
    dimensions: { goalComplexity: goalScore, repoComplexity: repoScore, fileScopeComplexity: fileScore },
    estimatedNodeCount: level === 'trivial' ? 3 : level === 'simple' ? 4 : level === 'moderate' ? 5 : level === 'complex' ? 6 : 8,
    suggestedMaxRetries: level === 'trivial' ? 1 : level === 'simple' ? 1 : level === 'moderate' ? 2 : level === 'complex' ? 2 : 3,
    needsDelegate: level === 'complex' || level === 'hard',
    suggestedFallbackCount: level === 'trivial' ? 0 : level === 'simple' ? 0 : level === 'moderate' ? 1 : level === 'complex' ? 2 : 3,
  };
}
```

### 30.4 复杂度如何影响图构建

```
TaskGraphBuilder.build(goal, intent, repoShape, complexity):
  1. 选择基础模板
  2. complexity='trivial':
     └─ 减少节点（跳过 inspect 和 summarize，直接 edit → verify）
     └─ 无 fallback 分支
  3. complexity='simple':
     └─ 标准模板，1 个 fallback
  4. complexity='moderate':
     └─ 标准模板，1 个 fallback，verify 增加 lint 子步骤
  5. complexity='complex':
     └─ 增加 delegate 节点（仓库探索），2 个 fallback
  6. complexity='hard':
     └─ 增加多个 delegate（分段探索），3 个 fallback
     └─ 增加中间 verify（编辑后立即验证，而非最后统一验证）
```

### 30.5 与现有代码集成点

| 集成点 | 位置 | 方式 |
|---|---|---|
| `TaskState.inferIntent()` | `task-state.ts` | 紧接 `inferIntent` 之后调用 `estimateComplexity()`。两者都是纯函数，不依赖 LLM。 |
| `RepoContext` | `repo-context.ts` | `RepoContext` 初始化后提供 `repoShape` 给 estimator。 |
| `TaskGraphBuilder` | `task-graph-builder.ts`（新增） | `build()` 接收 `complexity` 参数调整模板。 |

### 30.6 v1/v2 建议

- **v1**：纯文本启发式（仅 goal 文本分析，不需要 `repoShape`）。~60 行代码。
- **v2**：加入 `repoShape` 和 `changedFiles` 维度 + 历史 `GraphMetrics` 反馈调整（上一次同类型任务复杂度过高 → 本次自动上调一级）。

---

## 31. Preflight Scan Phase（预检扫描阶段）

### 31.1 问题分析

当前流程：`用户输入 → inferIntent → buildGraph → execute`。缺少一个**预检扫描**阶段来验证：
- 用户引用的文件路径是否真实存在
- 提到的函数/类名能否在代码库中找到
- 目标是否有明确的入口点
- 是否有明显的前置条件不满足

预检扫描可以在图构建前捕获明显的问题，避免执行到一半才发现文件不存在。

### 31.2 预检内容

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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

export interface PreflightIssue {
  severity: 'warning' | 'error';
  type: 'file_not_found' | 'symbol_not_found' | 'ambiguous_reference' | 'missing_dependency';
  description: string;
  /** 关联的用户原始文本片段 */
  userText?: string;
}

export interface PreflightSuggestion {
  type: 'correct_path' | 'narrow_scope' | 'add_context' | 'split_task';
  message: string;
  /** 建议的新路径（correct_path 类型） */
  suggestedPath?: string;
}
```

### 31.3 预检流程

```
PreflightScanner.scan(goal, repoShape, workspaceRoot):
  ── 总超时: 3 秒，超时则跳过 (passed=true, issues=[])
  
  1. 路径提取:
     ├─ 正则匹配 goal 中的文件路径 (如 `src/harness/task-graph.ts`)
     ├─ fs.existsSync(path) → 不存在 → issue: file_not_found
     └─ 存在 → discoveredFiles.push(path)
  
  2. 符号搜索 (如果 goal 包含明显函数/类名):
     ├─ 正则匹配大写开头词 (如 UserService) 或 驼峰函数名
     ├─ search_codebase(symbol) → 快速 grep (限制 2 个结果)
     ├─ 无结果 → issue: symbol_not_found
     └─ 有结果 → discoveredSymbols.push(symbol) + discoveredFiles.push(匹配文件)
  
  3. 歧义检测:
     ├─ 同一符号在 3+ 文件中出现 → issue: ambiguous_reference
     └─ 建议: "目标符号在 N 个文件中定义，请指定具体文件"
  
  4. 依赖检测:
     └─ goal 提到 "测试" 但 repoShape.testFramework='none'
        → suggestion: add_context ("项目未检测到测试框架，请确认验证方式")
  
  5. 输出 PreflightResult
```

### 31.4 生命周期（在 TaskGraph 构建前）

```
用户输入 goal
    │
    ▼
[inferIntent]                  ← 现有 (task-state.ts)
    │
    ▼
[PreflightScanner.scan]        ← 新增 (耗时 ≤ 3s)
    │
    ├─ issues.length > 0
    │  └─ 注入到 system context:
    │     "[Preflight] 发现以下问题:
    │      - 文件 src/harness/task-graph.ts 不存在
    │      - 符号 UserService 在 5 个文件中定义"
    │     → 让 LLM 在第一轮就意识到问题
    │
    └─ discoveredFiles.length > 0
       └─ 增强 context 节点 evidence:
          node.evidence = discoveredFiles[0]
    │
    ▼
[estimateComplexity]           ← §30
    │
    ▼
[TaskGraphBuilder.build]       ← §7
```

### 31.5 与现有代码集成点

| 集成点 | 位置 | 方式 |
|---|---|---|
| `RepoContext` | `repo-context.ts` | `discoveredFiles` 追加到 `RepoContext.filesRead`（不重复） |
| `TaskState` | `task-state.ts` | 预检发现的文件路径在 `TaskState` 初始化时就标记为 `filesRead` |
| `ExecutionPlanGenerator` | `execution-plan-generator.ts` | context step 的 `evidence` 字段使用预检发现的首个文件路径 |

### 31.6 v1/v2 建议

- **v1**：仅路径提取（正则 + `fs.existsSync`），无符号搜索。~40 行代码，< 50ms 开销。
- **v2**：符号搜索 + 歧义检测 + 依赖检测。需要 grep 文件系统，O(文件数) 开销。建议用 SubAgentRunner 异步执行，不阻塞图构建。

---

## 32. Graph Template Ranking（图模板排序）

### 32.1 问题分析

§7.1 定义了 intent → 固定模板的映射（如 `edit` 总是 5 个固定节点）。但实际运行中，某些变体可能更优：
- 简单 edit → 跳过 context 节点更快
- 有现成测试的 edit → verify 节点更可靠
- 大仓库 edit → delegate 节点更高效

需要一个模板排序/选择机制，基于历史 `GraphMetrics` 为当前任务选择最佳模板变体。

### 32.2 模板定义

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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

export interface TemplateCondition {
  field: 'complexity' | 'repoType' | 'testFramework' | 'fileCount';
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'in';
  value: string | number | string[];
}
```

### 32.3 edit 意图的模板排名示例

```
intent='edit' 的候选模板 (按 historicalScore 降序):

1. "标准编辑" (historicalScore=0.82, usageCount=45)
   节点: [inspect, search, edit, verify, summarize]
   条件: complexity∈[moderate], repoType≠'unknown'
   
2. "快速修复" (historicalScore=0.91, usageCount=32)
   节点: [inspect, edit, verify, summarize]
   条件: complexity∈[trivial, simple]
   
3. "大仓编辑" (historicalScore=0.74, usageCount=18)
   节点: [delegate, inspect, edit, verify, verify, summarize]
   条件: fileCount>500
   
4. "无测试编辑" (historicalScore=0.65, usageCount=12)
   节点: [inspect, search, edit, summarize]  ← 无 verify
   条件: testFramework='none'
   
5. "重构编辑" (historicalScore=0.78, usageCount=8)
   节点: [inspect, search, read, edit, verify, verify, summarize]  ← 双 verify
   条件: complexity∈[complex, hard]
```

### 32.4 排序算法

```
function rankTemplates(intent, complexity, repoShape): GraphTemplate[] {
  1. 筛选: 所有 intent 匹配的模板
  2. 条件过滤: 排除不满足 conditions 的模板
     ├─ 始终保留至少 1 个模板（最通用的那个，无条件限制）
     └─ 如果全部排除 → 回退到默认模板
  3. 排序 (加权):
     score = historicalScore * 0.6
           + (usageCount / maxUsageCount) * 0.2      // 使用频次
           + conditionMatchBonus * 0.2               // 条件匹配度
  4. 返回排序列表，取 top 1
}
```

### 32.5 historicalScore 更新

```
每次 markGraphDone() 后:
  1. 从 GraphMetrics 获取 completionScore
  2. 更新对应模板:
     template.historicalScore = 
       template.historicalScore * 0.7 +    // 历史权重 70%
       completionScore / 100 * 0.3          // 最新表现 30%
     template.usageCount++
     template.lastUsedGraphId = graphId
  3. 持久化: 模板排名写入 `icecoder-templates` fence
```

### 32.6 模板持久化

```markdown
```icecoder-templates
[
  {"id":"tpl-edit-standard","intent":"edit","nodeTypes":["inspect","search","edit","verify","summarize"],"historicalScore":0.82,"usageCount":45},
  {"id":"tpl-edit-quickfix","intent":"edit","nodeTypes":["inspect","edit","verify","summarize"],"historicalScore":0.91,"usageCount":32}
]
```
```

与 session-notes.md 中的其他 fence（`icecoder-runtime` / `icecoder-plan` / `icecoder-graph` / `icecoder-metrics`）平行存储。

### 32.7 与现有代码集成点

| 集成点 | 位置 | 方式 |
|---|---|---|
| `TaskGraphBuilder` | `task-graph-builder.ts` | `build()` 调用 `rankTemplates()` 选择模板，替代硬编码的 intent→template 映射 |
| `GraphMetrics` | `task-graph.ts` (§21) | `markGraphDone()` 后触发 `template.historicalScore` 更新 |
| `SessionMemory` | `session-memory.ts` | 新增 `icecoder-templates` fence 读写（复制 `icecoder-plan` fence 的模式） |

### 32.8 v1/v2 建议

- **v1**：静态模板排名（手写 `historicalScore` 初始值，不动态更新）。`rankTemplates()` 退化为简单的条件匹配。~30 行代码。
- **v2**：动态排名 + 自动学习。模板可被用户自定义（通过配置文件添加/禁用模板变体）。

---

## 33. Failure Taxonomy（失败分类系统）

### 33.1 问题分析

当前 Harness 的失败处理是**粗粒度的**：

- `BranchBudgetTracker`（`src/harness/branch-budget.ts`）只记录同签名失败计数，不做语义分类
- `CheckpointEngine` 的 `FailureHistoryEntry`（`src/types/runtime-checkpoint.ts` L32-L41）只存 `signature` + `count` + `lastError`
- `StepReview`（`src/harness/step-review.ts`）关注"是否有进展"但不分类失败原因

这导致 recovery 策略只能做笼统的 "retry or fallback" 二选一，无法针对**具体失败类型**选择最优恢复路径。

### 33.2 失败分类体系

```typescript
// ─── src/types/task-graph.ts 扩展 ───

/** 失败大类 */
export type FailureCategory =
  | 'tool_error'          // 工具执行报错
  | 'verification_fail'   // 验证未通过
  | 'context_missing'     // 缺少上下文信息
  | 'contract_violation'  // 违反节点合约
  | 'repo_mismatch'       // 仓库结构与预期不符
  | 'permission_denied'   // 权限不足
  | 'hallucinated_path'   // LLM 虚构了不存在的文件路径
  | 'branch_exhausted'    // 所有分支耗尽
  | 'model_breakdown'     // 模型完全偏离任务
  | 'timeout'             // 超时
  | 'token_exhausted';    // Token 预算耗尽

/** 失败严重程度 */
export type FailureSeverity = 'recoverable' | 'degraded' | 'fatal';

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
```

### 33.3 分类规则（确定性，零 LLM 成本）

```typescript
// ─── src/harness/task-graph-review.ts 内 ───

function classifyFailure(
  error: string,
  toolName?: string,
  context?: { taskState: TaskStateSnapshot; repoShape?: RepoShape }
): ClassifiedFailure {
  const normalized = error.toLowerCase().trim();

  // ── 1. tool_error ──
  if (toolName && normalized.includes('enoent')) {
    return {
      category: 'tool_error',
      subType: 'file_not_found',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'retry_with_hint', hint: '文件不存在。请使用 search_codebase 查找正确的文件路径。' },
    };
  }
  if (toolName && /eacces|eperm|access denied/i.test(normalized)) {
    return {
      category: 'permission_denied',
      subType: 'file_permission',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'alternative_tool', suggestedTools: ['read_file', 'search_codebase'] },
    };
  }
  if (toolName && /syntax.error|unexpected.token|parse.error/i.test(normalized)) {
    return {
      category: 'tool_error',
      subType: 'syntax_error',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'retry', maxAttempts: 2 },
    };
  }

  // ── 2. verification_fail ──
  if (/test.*fail|assertion.*fail|expect.*not|snapshot.*differ/i.test(normalized)) {
    return {
      category: 'verification_fail',
      subType: 'test_failed',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'narrow_scope', message: '测试失败。请检查失败的测试用例输出，定位具体断言。' },
    };
  }
  if (/tsc.*error|type.*error|cannot.find.module/i.test(normalized)) {
    return {
      category: 'verification_fail',
      subType: 'type_error',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'retry_with_hint', hint: '类型错误。请根据 tsc 输出修复类型不匹配。' },
    };
  }
  if (/lint.*error|eslint|prettier/i.test(normalized)) {
    return {
      category: 'verification_fail',
      subType: 'lint_error',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'retry', maxAttempts: 1 },
    };
  }

  // ── 3. context_missing ──
  if (/cannot.*find|cannot.*locate|unable.*read|does not exist/i.test(normalized)) {
    // 区分：是工具报错还是 LLM 虚构路径
    if (context?.taskState.filesRead.length === 0) {
      return {
        category: 'context_missing',
        subType: 'insufficient_exploration',
        severity: 'recoverable',
        suggestedRecovery: { strategy: 'expand_context', method: 'sub_agent' },
      };
    }
  }

  // ── 4. contract_violation ──
  if (/contract.*violat|forbidden.*tool|not.in.allowed/i.test(normalized)) {
    return {
      category: 'contract_violation',
      subType: 'forbidden_tool_call',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'retry_with_hint', hint: '请使用当前节点允许的工具。' },
    };
  }

  // ── 5. repo_mismatch ──
  if (/package.json.*not.found|tsconfig.*not.found|no.such.project/i.test(normalized)) {
    return {
      category: 'repo_mismatch',
      subType: 'expected_config_missing',
      severity: 'degraded',
      suggestedRecovery: { strategy: 'skip_node', reason: '项目配置文件不存在，跳过依赖该配置的步骤。' },
    };
  }

  // ── 6. hallucinated_path ──
  // 通过对比 toolSignature 中的路径是否匹配 RepoContext.filesRead 来判断
  if (toolName === 'read_file' && context?.taskState.filesRead.length > 0) {
    // 如果错误消息表明"文件不存在"且工具参数中的路径不在 filesRead 中
    if (/enoent|not.found/i.test(normalized)) {
      return {
        category: 'hallucinated_path',
        subType: 'file_not_found',
        severity: 'recoverable',
        suggestedRecovery: { strategy: 'expand_context', method: 'search' },
      };
    }
  }

  // ── 7. branch_exhausted ──
  if (/all.*fallback.*exhausted|no.*more.*branch|circuit.*breaker/i.test(normalized)) {
    return {
      category: 'branch_exhausted',
      subType: 'no_fallback_remaining',
      severity: 'fatal',
      suggestedRecovery: { strategy: 'ask_user', question: '所有策略均已尝试但未成功。是否需要调整方案？' },
    };
  }

  // ── 8. model_breakdown ──
  if (/task.*unrelated|out.of.scope|irrelevant/i.test(normalized)) {
    return {
      category: 'model_breakdown',
      subType: 'task_derailment',
      severity: 'degraded',
      suggestedRecovery: { strategy: 'retry_with_hint', hint: '请重新聚焦原始任务。忽略不相关的内容。' },
    };
  }

  // ── 9. timeout ──
  if (/timeout|timed.out|deadline.exceeded/i.test(normalized)) {
    return {
      category: 'timeout',
      subType: 'operation_timeout',
      severity: 'recoverable',
      suggestedRecovery: { strategy: 'narrow_scope', message: '操作超时。请缩小范围或分步执行。' },
    };
  }

  // ── 10. token_exhausted ──
  if (/token.*limit|context.*length|max.*token/i.test(normalized)) {
    return {
      category: 'token_exhausted',
      subType: 'context_limit',
      severity: 'degraded',
      suggestedRecovery: { strategy: 'narrow_scope', message: '上下文过长。请精简操作范围。' },
    };
  }

  // ── Fallback: 未知错误 ──
  return {
    category: 'tool_error',
    subType: 'unknown',
    severity: 'recoverable',
    suggestedRecovery: { strategy: 'retry', maxAttempts: 1 },
  };
}
```

### 33.4 分类 → Recovery 映射表

| Failure Category | Severity | Default Recovery Strategy |
|---|---|---|
| `tool_error` (syntax) | recoverable | `retry` (max 2) |
| `tool_error` (file_not_found) | recoverable | `retry_with_hint` (search first) |
| `verification_fail` (test) | recoverable | `narrow_scope` (检查输出) |
| `verification_fail` (type) | recoverable | `retry_with_hint` (读 tsc 输出) |
| `context_missing` | recoverable | `expand_context` (sub_agent) |
| `contract_violation` | recoverable | `retry_with_hint` (allowed tools) |
| `repo_mismatch` | degraded | `skip_node` |
| `permission_denied` | recoverable | `alternative_tool` |
| `hallucinated_path` | recoverable | `expand_context` (search) |
| `branch_exhausted` | fatal | `ask_user` |
| `model_breakdown` | degraded | `retry_with_hint` |
| `timeout` | recoverable | `narrow_scope` |
| `token_exhausted` | degraded | `narrow_scope` |

### 33.5 在 EscalationPolicy 中的集成

`FailureTaxonomy` 与 `EscalationPolicy`（§27）上下衔接：

```
EscalationPolicy 触发 → 检查 FailureTaxonomy:
  ├─ severity='recoverable' → 允许 escalation 正常上升
  ├─ severity='degraded'    → 跳过 Level 1，直接到 Level 2 (硬纠正)
  └─ severity='fatal'       → 跳过 Level 1-2，直接到 Level 3 (分支切换或 abort)
```

这使得 recovery 不再是盲目的 "全部重试或全部 fallback"，而是**按失败类型定制响应**。

### 33.6 与现有代码集成点

| 集成点 | 位置 | 方式 |
|---|---|---|
| `CheckpointEngine.save()` | `checkpoint-engine.ts` | `FailureHistoryEntry` 追加 `category` 字段（可选，向后兼容）。`appendFailure` 现在传入 `ClassifiedFailure`。 |
| `BranchBudgetTracker` | `branch-budget.ts` | `recordError()` 的参数从 `signature: string` 扩展为 `{ signature, category }`。同 category 失败可共享预算（如所有 `hallucinated_path` 共用上限）。 |
| `StepReview` | `step-review.ts` | `heuristicReview()` 读取 `ClassifiedFailure.category` 做更精准的判断。例如连续 3 次 `hallucinated_path` → 立即建议 fallback。 |
| `DeviationDetector` | `task-graph-review.ts`（§20） | 接收 `ClassifiedFailure` 作为输入，`detect()` 的第二参数。 |

### 33.7 v1/v2 建议

- **v1**：实现上述 11 种分类的规则引擎（纯文本匹配）。~120 行代码。`FailureHistoryEntry` 保留原样，分类结果仅在内存使用。
- **v2**：分类持久化到 checkpoint `runtimeV2.recentFailures[].category`。引入少量 LLM 辅助分类（仅在规则无法匹配时，max 1 次轻量调用）。

---

## 34. Graph Debug Dump（图调试转储）

### 34.1 问题分析

当前调试 TaskGraph 执行问题需要手动检查多个数据源：
- `*.checkpoint.json` → 运行时状态
- `session-notes.md` → fence 中的 plan/graph/metrics
- 多个 JSON 块分散，不成体系

需要一个**一次性的完整转储**——图执行结束后自动生成 `graph-debug.json`，包含所有调试所需信息，可直接用于：
- 人工排查
- 自动分析脚本
- CI 中的回归检查
- Eval Runner 的 gold set 生成

### 34.2 GraphDebugDump 数据结构

```typescript
// ─── src/types/task-graph.ts 扩展 ───

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
    nodes: Record<string, TaskNode>;          // 完整节点（含 status/retry/error）
    edges: TaskEdge[];
    mainBranch: ExecutionBranch;
    fallbackBranches: FallbackBranch[];
    cursor: ExecutionCursor;                  // 最终游标位置
  };

  /** 分支路径（执行轨迹） */
  branchPath: {
    /** 实际走过的分支序列 */
    branchesTaken: Array<{
      branchId: string;
      enteredAt: number;
      exitedAt?: number;
      isFallback: boolean;
      reason?: string;
    }>;
    /** 最终所在分支 */
    finalBranchId: string;
  };

  /** 工具调用追踪（完整时间线） */
  toolTrace: Array<{
    callIndex: number;
    toolName: string;
    argsSignature: string;
    success: boolean;
    outputDigest?: string;        // 前 300 字符
    errorDigest?: string;         // 前 300 字符
    durationMs: number;
    nodeId: string;               // 在哪个节点下调用的
    roundNumber: number;          // 在 Harness 第几轮
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
    actualRecovery: string;       // "retry" | "fallback" | "abort"
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
```

### 34.3 生成时机

```
markGraphDone() 或 markGraphFailed() 后:

1. 收集所有运行时数据:
   ├─ TaskGraph 完整状态 (nodes + edges + branches + cursor)
   ├─ nodeHistory → 节点执行统计
   ├─ branchHistory → 分支切换轨迹
   ├─ CheckpointEngine.runtimeV2.recentTools → toolTrace
   ├─ CheckpointEngine.runtimeV2.recentFailures → classifiedFailures
   ├─ ContractValidator 实例状态 → contractViolations
   ├─ DeviationDetector 历史 → deviations
   ├─ EscalationPolicy 历史 → escalationHistory
   ├─ GraphMetrics → metrics (已计算)
   ├─ NodeCostTracker[] → nodeCosts
   └─ Harness LoopState → harnessSummary

2. 组装 GraphDebugDump

3. 写入文件:
   sessionDir/graph-debug-{graphId}.json

4. 也写入 session-notes.md (可选，通过 fence):
   ```icecoder-debug
   { ... JSON ... }
   ```
```

### 34.4 生命周期

```
TaskGraph 执行
    │
    ▼
markGraphDone() / markGraphFailed()
    │
    ▼
GraphDebugDump.generate(graph, checkpointEngine, contractValidator, deviationHistory, escalationHistory)
    │
    ▼
写入磁盘:
  ├─ sessionDir/graph-debug-{graphId}.json     (主转储)
  └─ session-notes.md → ```icecoder-debug       (可选，便于跨会话查看)
    │
    ▼
可选: 上传到 Eval Runner 的 artifact store (v2)
```

### 34.5 Debug Dump 的使用场景

| 场景 | 如何使用 |
|---|---|
| **手动调试** | 打开 `graph-debug-xxx.json`，搜索 `"category":"hallucinated_path"` 快速定位虚构路径问题 |
| **CI 回归** | `jq '.classifiedFailures | length' graph-debug-xxx.json` → 预期为 0 |
| **Eval Runner** | 加载 `GraphDebugDump` 与 gold set 对比，计算 precision/recall |
| **性能分析** | `jq '.nodeCosts["node-03"].actual'` → 查看 edit 节点实际消耗 |
| **合约审计** | `jq '.contractViolations'` → 列出所有违规，看是否需要调整合约配置 |
| **恢复分析** | `jq '.recoverySignals | map(select(.actionTaken=="fallback"))'` → 统计 fallback 频率 |

### 34.6 与现有持久化机制的关系

```
持久化层次:

sessionDir/:
├── default.checkpoint.json          ← TaskCheckpointManager (v1, 周期性)
│   ├── ...v1 fields...
│   ├── runtimeV2                    ← CheckpointEngine (v2, 周期性)
│   └── taskGraph?                   ← TaskGraph persistence (Phase D)
│
├── graph-debug-{graphId}.json       ← GraphDebugDump (新增, 图结束时一次性)
│
session-notes.md (session-memory.ts):
├── ```icecoder-runtime              ← 周期性
├── ```icecoder-plan                  ← 周期性
├── ```icecoder-graph                 ← 周期性
├── ```icecoder-metrics               ← 图结束时
├── ```icecoder-templates             ← 图结束时
└── ```icecoder-debug                 ← 图结束时
```

**区别**：checkpoint 是**增量快照**（用于恢复），debug dump 是**完整报告**（用于分析）。debug dump 的体积更大（~50KB-200KB），仅在执行结束时生成一次。

### 34.7 与现有代码集成点

| 集成点 | 位置 | 方式 |
|---|---|---|
| `markGraphDone()` | `task-graph.ts` | 末尾调用 `GraphDebugDump.generate()` |
| `markGraphFailed()` | `task-graph.ts` | 同上 |
| `CheckpointEngine` | `checkpoint-engine.ts` | 传入 `runtimeV2` 快照给 dump generator |
| `CombinedCheckpointFile` | `checkpoint-engine.ts` | 新增可选字段 `debugDumpPath?: string`（指向 `graph-debug-xxx.json` 的路径） |
| `SessionMemory` | `session-memory.ts` | 新增 `icecoder-debug` fence 类型 |

### 34.8 v1/v2 建议

- **v1**：仅生成 JSON 文件到 `sessionDir/`，不写 session-notes fence。~80 行代码。`deviationHistory` 和 `escalationHistory` 需要内存中维护（在 GraphExecutor 内部）。
- **v2**：`icecoder-debug` fence 写入 session-notes + 上传到 artifact store + `GraphDebugDump` 二进制压缩（gzip）以减少体积。
