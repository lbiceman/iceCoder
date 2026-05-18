Document the design for the new Execution Transparency Layer feature.

This document will serve as implementation spec before coding.

Requirements:

1. Create only the markdown file.
2. Do not modify existing code.
3. Do not generate implementation yet.
4. Analyze existing architecture before writing.
5. Base design on current Harness + WebSocket + frontend architecture.
6. Ensure compatibility with existing session snapshot and ice bean UI.
7. Prefer additive integration over refactor.
8. Keep document technical and implementation-oriented.
9. Use clear headings.
10. Include migration notes.

Document structure must contain:

# Execution Transparency Layer Design

## Goal

Explain why this feature exists:
- visible execution plan
- runtime transparency
- progress visibility
- task recovery UX

---

## Existing Architecture Analysis

Analyze current codebase first:

- harness runtime loop
- task state
- repo context
- websocket events
- session notes
- runtime snapshot
- public frontend
- ice bean bridge

Describe where integration points should be.

---

## Proposed Architecture

Describe new layer:

Execution Transparency Layer

Include:

- execution plan generator
- progress tracker
- websocket event stream
- frontend panel
- session resume UX

Must explain component boundaries.

---

## New Files

List proposed files.

Include purpose for each.

Use tree format.

---

## Data Model

Define interfaces:

ExecutionStep
ExecutionPlan
ExecutionPlanEvent

Use TypeScript code blocks.

---

## Runtime Flow

Describe:

task start
plan generate
tool execution
step transition
verification
completion
failure
resume

Use sequence diagram in markdown.

---

## Frontend Design

Describe:

panel placement
state rendering
event consumption
feature flag
fallback behavior

---

## Session Recovery

Explain:

how unfinished snapshot should restore
how plan should rehydrate
how UI should recover current step

---

## Ice Bean Integration

Describe:

state mapping
mood mapping
event bridge integration

No core canvas change.

---

## Feature Flag

Document:

ICE_ENABLE_EXECUTION_PLAN

Include disabled behavior.

---

## Testing Plan

List required tests:

runtime
websocket
frontend
resume

---

## Risks

List:

possible regressions
performance issues
event spam
sync mismatch
snapshot inconsistency

---

## Recommended Implementation Order

Must provide step-by-step rollout:

1. types
2. runtime
3. websocket
4. frontend
5. tests

---

Important:

Before writing the markdown, inspect existing source tree and existing relevant files.

Use actual project structure.

Do not hallucinate architecture.

Document should be practical enough that coding can start directly from it.


# Execution Transparency Layer Design

> 本文是「执行透明层」（Execution Transparency Layer，以下简称 **ETL**）的实施级设计稿。
>
> 它在不改动现有 Harness 主循环语义、不破坏 `session-notes` / checkpoint / 冰豆 UI 的前提下，
> 把模型「打算做什么 / 现在到第几步 / 已经做完 / 在哪里卡住」以**结构化的执行计划**形式
> 暴露给前端和会话恢复机制。
>
> 编码起点请直接看 §「Recommended Implementation Order」与 §「New Files」。

---

## Goal

iceCoder 目前的循环以 `Harness.run()` 为中心，
模型每轮做什么对用户来说基本是「黑盒」：只能看到
冰豆表情、工具调用日志和最终文字回复，而看不到「**这次任务一共几步、当前在第几步、下一步打算干嘛**」。

ETL 要解决四件事：

- **visible execution plan**：在任务首轮就把目标拆成一份显式步骤清单（`ExecutionStep[]`），让用户能预审计 AI 的工作路径。
- **runtime transparency**：每轮工具调用 / 阶段切换 / 验证状态变化，都对齐回 plan 上的某一 step，状态可观察（`pending → running → done | failed | skipped`）。
- **progress visibility**：前端有独立面板显示进度（X/N 步、当前 step、ETA hint），冰豆表情根据 plan 阶段做更细粒度的情绪映射。
- **task recovery UX**：进程崩溃 / 用户中断 / 跨设备恢复时，能从持久化 plan 直接续上「卡住的那一步」，不依赖人工再描述任务。

> 非目标：**不**改造主循环、不抢占 LLM 决策、不强制 plan 与实际 toolCall 严格对齐（plan 是引导而不是判决）。

---

## Existing Architecture Analysis

下面只列与 ETL 直接相关的文件与职责，避免凭空发明结构。

### Harness runtime loop

`src/harness/harness.ts` 的 `Harness.run()` 是 `while(true) + LoopState` 状态机：

1. 消息预处理（`maybeCompact`：微压缩 / 硬压缩）；
2. `upsertRuntimeContextMessage` 把 `[System Runtime State]` 注入给 LLM；
3. 若首轮且属于「可执行型」请求，调用 `buildToolPlan(...)`/`formatToolPlan(...)` 注入 `[Runtime Tool Planner]` 提示；
4. LLM 调用（流式或非流式）；
5. 无 toolCalls → 走完成 / max_output_tokens / 空响应恢复等分支；
6. 有 toolCalls → `executeToolCallsStreaming` 并行执行；
7. 调用 `saveTaskCheckpoint('running', ...)`；
8. `recordTool` / `recordRound` / `recordCompaction` / `recordSummary` 通过 `RuntimeTelemetry` 落盘 JSONL。

**ETL 切入点**：第 3 步现有的 `buildToolPlan` 输出本来就只是「提示给模型看」的字符串。ETL 把它升级为
**结构化对象 + 状态机**，并在 2、6、7 步附近补打 plan 更新事件。

### Task state

`src/harness/task-state.ts` + `src/types/runtime-snapshot.ts`：

```ts
TaskIntent  = 'question' | 'inspect' | 'edit' | 'debug' | 'test' | 'refactor' | 'docs'
TaskPhase   = 'intent' | 'context' | 'editing' | 'verification' | 'final'
TaskStateSnapshot = { goal, intent, phase, filesRead[], filesChanged[], commandsRun[],
                      verificationRequired, verificationStatus }
```

`TaskState.recordToolResult()` 在工具成功时推进 phase（context → editing → verification）。
`applySnapshot()` 已经支持从 session-notes 恢复。

**ETL 切入点**：ExecutionPlan 中每个 step 关联一个 `phase` 与可选 `intent`，
phase 变化时由 tracker 自动把当前 step 推进到 `running`/`done`。

### Repo context

`src/harness/repo-context.ts` 维护 `RepoContextSnapshot`（filesRead / filesChanged / commandsRun / testCommands / recentDiagnostics）。
**ETL 不修改它**，但 plan 的「证据栏」会引用它的 last entry。

### WebSocket events

- 服务端：`src/web/chat-ws.ts` 的 `handleChatMessage()` 通过 `sendJSON(ws, { type: 'step', step: event })` 把每一条 `HarnessStepEvent` 推到前端。
- 事件类型枚举在 `src/harness/types.ts → HarnessStepEvent.type`：
  `'thinking' | 'tool_call' | 'tool_result' | 'tool_denied' | 'tool_confirm' | 'tool_progress' | 'compaction' | 'final' | 'stream_delta' | 'tool_output' | 'memory_event'`。
- 前端：`src/public/js/chat-websocket.js` 路由 `step` → 业务模块，`chat-pet-bridge.js` 把 step 映射到冰豆表情。

**ETL 切入点**：往 union 增量加 `'execution_plan_init' | 'execution_plan_update'` 两个 type，不替换任何旧 type；
前端在 `chat-websocket.js` 的 `step` 分支自然收到，再让 `chat-execution-plan-bridge.js` 消费。

### Session notes / runtime snapshot

`src/memory/file-memory/session-memory.ts` 通过 `ICECODER_RUNTIME_FENCE_LANG = 'icecoder-runtime'`
在 `session-notes.md` 写入一个 fenced JSON（`PersistedRuntimeV1 = { version, task, repo }`），
`parsePersistedRuntime` 解析最后一个 fence。

`Harness.run()` 启动时（`existingMessages.length > 0` 分支）调用 `hydrateRuntimeFromSessionNotes` 从 session-notes 复原 TaskState / RepoContext。

**ETL 切入点**：再添一种 fence `icecoder-plan`（同 module、同写法），用版本字段独立演进；
新增 `parsePersistedPlan()` 并把 hydrate 流程并行扩到 plan。

### Checkpoint

`src/harness/checkpoint.ts` 的 `TaskCheckpointManager` 把 task / repo / loop / stopReason 写到
`data/sessions/{sessionId}.checkpoint.json`。`loadActive()` 会在新 run 启动时被读取并把 `<resume-checkpoint>`
作为 user message 重新喂给 LLM。

**ETL 切入点**：`TaskCheckpoint` 接口里追加 `plan?: ExecutionPlan` 字段（向后兼容：旧文件解析时 plan 为 undefined）。
`buildResumeMessage` 在 plan 存在时把当前 step 描述拼进去（不替换原 JSON）。

### Runtime telemetry

`src/harness/runtime-telemetry.ts` 已经在写 `round / tool / compaction / summary` 四种 JSONL 行。
ETL 新增第五种 `plan_event`（仅追加，不动旧事件结构），存到同一 `telemetry.jsonl`。

### Public frontend

`src/public/index.html` + `src/public/js/`（IIFE 模块，无打包步骤；Vite 仅用于 dev / build）。
关键文件：

| 文件 | 角色 |
|------|------|
| `chat-websocket.js` | 单一 WS 客户端，按 `data.type` 分发 |
| `chat-page.js` | 聊天主页面控制器 |
| `chat-ui.js` | 消息气泡 / 流式渲染 |
| `chat-pet-bridge.js` | Harness step → 冰豆表情/气泡 |
| `session-pet.js` | 冰豆 canvas 渲染 + 表情切换 |

**ETL 切入点**：新增 `chat-execution-plan.js`（UI 渲染）+ `chat-execution-plan-bridge.js`（事件桥），
在 `index.html` 追加 `<aside id="exec-plan-panel">` 容器与 `<script>` 引用。冰豆桥不变更接口，只在收到 plan 事件时
**额外调用** `setState()`。

### Ice bean bridge

`src/public/js/chat-pet-bridge.js` 的 `applyHarnessStepToPet(step, ...)` 是事件 → 表情的唯一入口。
当前已经覆盖 `thinking/tool_call/tool_result/tool_denied/tool_confirm/tool_progress/compaction/final/stream_delta/tool_output/memory_event`。

**ETL 切入点**：在同一 switch 增加两个 case：`execution_plan_init`（surprised / curious）、`execution_plan_update`
（按 step 状态映射 working / focused / happy / weary）。**不改任何已有 case**。

---

## Proposed Architecture

```
                 ┌────────────────────────────────────────────┐
                 │              Harness.run() loop            │
                 │                                            │
   userMessage ─▶│  ┌────────┐  ┌────────┐  ┌──────────────┐ │
                 │  │TaskStat│  │RepoCtx │  │ToolPlanner    │ │
                 │  └───┬────┘  └───┬────┘  └──────┬───────┘ │
                 │      │           │              │         │
                 │      ▼           ▼              ▼         │
                 │   ┌────────────────────────────────────┐  │
                 │   │      ExecutionPlanGenerator        │  │  ← NEW
                 │   │  (intent + taskState → Plan)       │  │
                 │   └─────────────┬──────────────────────┘  │
                 │                 │ ExecutionPlan           │
                 │                 ▼                         │
                 │   ┌────────────────────────────────────┐  │
                 │   │      ExecutionPlanTracker          │  │  ← NEW
                 │   │  (订阅 phase/tool/verification)    │  │
                 │   └────┬─────────────────┬─────────────┘  │
                 │        │                 │                │
                 │        ▼                 ▼                │
                 │  onStep(execution_plan_init/update)       │
                 └────────────┬────────────────────┬─────────┘
                              │                    │
                              ▼                    ▼
                     ┌──────────────┐      ┌────────────────┐
                     │RuntimeTelemetry│    │TaskCheckpoint   │
                     │ telemetry.jsonl│    │ +plan 字段      │
                     │ (plan_event)   │    │ session-notes:  │
                     └──────────────┘      │ icecoder-plan   │
                                           └────────┬───────┘
                              ▼
                     ┌──────────────────────────────┐
                     │ chat-ws.ts → ws.send(step)   │
                     └──────────────┬───────────────┘
                                    ▼
                     ┌─────────────────────────────────────────────┐
                     │ Frontend                                    │
                     │  chat-websocket.js (step router)            │
                     │   ├─▶ chat-execution-plan-bridge.js  NEW    │
                     │   │      └─▶ chat-execution-plan.js  NEW    │
                     │   │             └─ <aside #exec-plan-panel> │
                     │   └─▶ chat-pet-bridge.js (扩 2 个 case)     │
                     └─────────────────────────────────────────────┘
```

### Components & boundaries

| 组件 | 位置 | 唯一职责 | 不做的事 |
|------|------|----------|----------|
| **ExecutionPlanGenerator** | `src/harness/execution-plan-generator.ts` | 输入 `{ goal, intent, taskSnapshot }`，输出 **结构化的 `ExecutionPlan`**（步骤、依赖、初始状态全 `pending`） | 不接 LLM、不读盘、不发事件 |
| **ExecutionPlanTracker** | `src/harness/execution-plan-tracker.ts` | 在循环过程中接收 `phase/tool_result/verification` 信号，更新 step 状态 → 发出 `ExecutionPlanEvent` | 不重新生成 plan、不与 LLM 通信、不写文件 |
| **ExecutionPlanPersister** | `src/harness/execution-plan-tracker.ts`（同文件内 helper） | 把 plan 写入 checkpoint + session-notes fence | 不感知前端、不订阅 WS |
| **chat-execution-plan-bridge.js** | `src/public/js/` | 接收 `execution_plan_init/update` step，调用面板 API | 不直接操作 DOM 内部细节 |
| **chat-execution-plan.js** | `src/public/js/` | 渲染面板、暴露 `setPlan / patchStep / clear` | 不和 WS 直接耦合 |

**关键不变量**：

1. **加性而非替换**：ETL 不删除任何现有事件 / 文件 / 接口。
2. **可关停**：`ICE_ENABLE_EXECUTION_PLAN ≠ 1` 时，generator/tracker 不实例化，Harness 表现与今天 100% 一致。
3. **plan 仅是引导**：tracker 永远不会拒绝/取消模型实际想做的 tool call。

---

## New Files

```
src/
  types/
    execution-plan.ts                          # 共享数据模型（前后端 TS/JS 同名 type）
  harness/
    execution-plan-generator.ts                # 由 goal/intent/taskSnapshot 构建 plan
    execution-plan-tracker.ts                  # 运行时 plan 状态机 + 事件 + 持久化
  memory/
    file-memory/
      execution-plan-fence.ts                  # session-notes 中 `icecoder-plan` fence 读写
  public/
    js/
      chat-execution-plan.js                   # 前端面板渲染（无依赖）
      chat-execution-plan-bridge.js            # WS step → 面板 / 冰豆桥联
    css/
      chat-execution-plan.css                  # 面板样式（折叠卡片）
test/
  harness/
    execution-plan-generator.test.ts
    execution-plan-tracker.test.ts
    execution-plan-resume.test.ts
  memory/
    execution-plan-fence.test.ts
  web/
    execution-plan-ws.test.ts                  # WS 事件冒烟
docs/
  execution-transparency-layer.md              # 本文件
```

**为什么放这些位置**：
- `src/types/` 已有 `runtime-snapshot.ts` 作为 harness ↔ memory 共享数据约定，plan 类型放同处不引入循环依赖。
- 前端走 `src/public/js/` 与 `chat-pet-bridge.js`、`chat-websocket.js` 同级，保持「IIFE + window 全局」的现有约定。
- 测试目录沿用 `test/` 顶层（与 `vitest.config.ts` 现有约定一致）。

---

## Data Model

`src/types/execution-plan.ts`：

```ts
import type { TaskIntent, TaskPhase } from './runtime-snapshot.js';

/** Plan schema 版本号；与 PERSIST_RUNTIME_SCHEMA_VERSION 平行演进 */
export const PERSIST_PLAN_SCHEMA_VERSION = 1 as const;

export type ExecutionStepStatus =
  | 'pending'    // 未开始
  | 'running'    // 当前活动
  | 'done'       // 已完成
  | 'failed'     // 步骤期望的动作失败（如 verification 失败）
  | 'skipped';   // 用户/模型显式跳过 / 与新意图无关

export interface ExecutionStep {
  /** 稳定 ID（plan 内唯一）。形如 step-01、step-02 */
  id: string;
  /** 给用户看的一行短描述（中文，<= 40 字） */
  title: string;
  /** 关联到的任务阶段；用于 tracker 用 TaskPhase 推动 */
  phase: TaskPhase;
  /** 可选：建议的工具名（来源 INTENT_TOOL_SUGGESTIONS） */
  suggestedTools?: string[];
  /** 该 step 是否需要工具调用支撑（仅展示提示） */
  requiresTool: boolean;
  /** 是否对应「验证」步骤（影响完成阈值与表情映射） */
  isVerification?: boolean;
  /** 当前状态；初始为 'pending' */
  status: ExecutionStepStatus;
  /** 进入 running 的 epoch ms（tracker 写入） */
  startedAt?: number;
  /** 进入终态的 epoch ms */
  endedAt?: number;
  /** 失败原因（status === 'failed' 时填） */
  error?: string;
  /** 关联证据：来自 RepoContext / TaskState 的最近一条命中（路径或命令） */
  evidence?: string;
}

export interface ExecutionPlan {
  version: typeof PERSIST_PLAN_SCHEMA_VERSION;
  /** 与 Harness 同会话同任务的稳定 ID（首轮生成时定型） */
  planId: string;
  /** 原始用户目标，用于校验是否仍是同一任务（与 TaskState.goal 一致） */
  goal: string;
  /** 任务意图（与 TaskState.intent 一致） */
  intent: TaskIntent;
  steps: ExecutionStep[];
  /** 当前活动 step 的 id（恰有 0 或 1 个 running） */
  activeStepId?: string;
  /** 整体进度百分比（done / 总步数；skipped 也算分母） */
  progress: number;
  /** 计划生成 / 最近更新时间 */
  createdAt: number;
  updatedAt: number;
}

/** 推到前端的事件（叠加到 HarnessStepEvent.type union 上） */
export type ExecutionPlanEvent =
  | {
      type: 'execution_plan_init';
      plan: ExecutionPlan;
    }
  | {
      type: 'execution_plan_update';
      planId: string;
      /** 只 diff 改动的字段，减少带宽与渲染抖动 */
      patch: {
        activeStepId?: string;
        progress?: number;
        updatedAt: number;
        stepPatches: Array<Pick<ExecutionStep, 'id' | 'status'> & Partial<ExecutionStep>>;
      };
    };
```

**Harness 接入点**：往 `src/harness/types.ts` 的 `HarnessStepEvent.type` union 追加
`'execution_plan_init' | 'execution_plan_update'`，并把 `ExecutionPlanEvent` 的字段并入（保留可选）。

---

## Runtime Flow

```text
sequenceDiagram
  participant U as User
  participant WS as chat-ws.ts
  participant H as Harness.run()
  participant G as ExecutionPlanGenerator
  participant T as ExecutionPlanTracker
  participant FE as Frontend (plan-bridge + pet)
  participant FS as Telemetry / Checkpoint / session-notes

  U->>WS: message "实现 X 功能"
  WS->>H: harness.run(...)
  H->>H: assembleInitialMessages
  Note over H: 首轮检测 isActionableToolRequest
  H->>G: build(goal, intent, taskSnapshot)
  G-->>H: ExecutionPlan(steps[0..N], 全 pending)
  H->>T: attach(plan)
  H-->>WS: step: execution_plan_init { plan }
  WS-->>FE: step
  FE->>FE: 面板渲染 N 步，冰豆 setState('surprised')
  H->>FS: writePlanFence(plan)

  loop 每轮
    H->>LLM: chat()
    alt 有 toolCalls
      H->>ToolExec: execute
      ToolExec-->>H: result
      H->>T: onToolResult(toolCall, result, taskSnapshot, repoSnapshot)
      T-->>H: step: execution_plan_update { patch }
      H-->>WS: forward step
      WS-->>FE: 面板更新当前 step → running/done
      FE->>FE: 冰豆 setState 按 step.status
      H->>FS: appendTelemetry { type: 'plan_event' }
      H->>FS: checkpoint.save({ plan: ... })
    else 无 toolCalls
      alt verification 阻塞
        H->>T: onVerificationRequired()
        T-->>H: step: execution_plan_update (verification → running)
      else 正常 final
        H->>T: onFinal(stopReason)
        T-->>H: step: execution_plan_update (所有未完成 → done/skipped)
      end
    end
  end

  alt stopReason === 'model_done'
    H->>FS: writePlanFence(plan, status: 'completed')
  else error / circuit_breaker / user_abort
    H->>FS: writePlanFence(plan)  // 保留未完成状态供下次恢复
  end
```

**关键转换规则**（tracker 内部）：

| 触发 | 当前活动 step | 动作 |
|------|---------------|------|
| `taskState.phase` 由 `intent` → `context` | 第一个 `phase === 'context'` step | `pending → running` |
| `tool_result(success)` 命中 step.suggestedTools 之一 | 该 step | 更新 `evidence`；若 phase 已切换则 `running → done` |
| `tool_result(failed)` 连续 ≥ 2 次同签名 | 该 step | `running → failed`，但 plan 不停 |
| `taskState.phase === 'verification'` | `isVerification` 的 step | `pending → running` |
| `verificationStatus === 'passed'` | 同上 | `running → done` |
| `stopReason === 'model_done'` 且仍有 pending | 余下 pending | 标记 `skipped` |
| `stopReason === 'user_abort' | 'circuit_breaker' | 'error'` | 当前 running | 保留 `running`（恢复时直接续） |

---

## Frontend Design

### Panel placement

- 桌面端：聊天主区右侧新增 `<aside id="exec-plan-panel">`，宽度 280px，可折叠（默认展开）；折叠后变成顶部一根 progress bar + 「N/M 步」按钮。
- 移动端：浮在输入框上方的卡片，默认折叠成「执行计划 3/5」一行，点击展开为底部 sheet。
- **不挤压**冰豆位置（冰豆是 fixed 定位的 canvas，独立 z-index）。

### State rendering

`chat-execution-plan.js` 暴露的 API（IIFE + `window.ChatExecutionPlan`，与现有 `ChatPetBridge` 同风格）：

```js
ChatExecutionPlan.setPlan(plan)           // 全量渲染
ChatExecutionPlan.applyPatch(patch)       // 差量更新（execution_plan_update）
ChatExecutionPlan.clear()                 // 任务完成或 ~clear 时清空
ChatExecutionPlan.setVisible(bool)        // 受 feature flag / 用户偏好控制
```

每个 step 卡片：

```
┌──────────────────────────────────────┐
│ ① 读取相关源文件        [running ●] │
│   工具：read_file, search_codebase    │
│   证据：src/harness/harness.ts        │
└──────────────────────────────────────┘
```

颜色与状态：
- `pending` 灰底；
- `running` 蓝色脉冲；
- `done` 绿色 + ✓；
- `failed` 红色 + ✗ + hover 显示 `error`；
- `skipped` 浅灰删除线。

### Event consumption

新增 `chat-execution-plan-bridge.js`：

```js
window.ChatWebSocket.on('step', function (e) {
  var step = e && e.step;
  if (!step) return;
  if (step.type === 'execution_plan_init') {
    ChatExecutionPlan.setPlan(step.plan);
    ChatPetBridge.applyHarnessStepToPet(step, /* isStreaming */ false, /* wsProcessing */ true);
  } else if (step.type === 'execution_plan_update') {
    ChatExecutionPlan.applyPatch(step.patch);
    ChatPetBridge.applyHarnessStepToPet(step, false, true);
  }
});
```

> 注意：`chat-websocket.js` 现有 `emit('step', { step: data.step })` **不需要改**。
> 上面这段订阅只是「在已有事件流上多挂一个 listener」。

### Feature flag

前端检测有两层：

1. WS `connected` 消息里携带 `features.executionPlan: true|false`（由服务端 env 决定）。
2. 用户偏好 `localStorage.ICE_PLAN_PANEL = '0'` 时强制隐藏。

flag 关闭时 `chat-execution-plan-bridge.js` 直接 `return`，不订阅；面板 DOM 也不挂载。

### Fallback behavior

- WS 断线 → 重连后从 `default.structured.json` 拉到最新 plan（通过新增 `GET /api/sessions/default/plan` REST 端点）。
- 收到 `execution_plan_update` 但本地无 plan（如先错过 init）→ 静默调 REST 全量同步，重试 1 次。
- 收到任何带 `planId` 与当前不符的 patch → 丢弃 + 触发同步。

---

## Session Recovery

复用现有的两条恢复链路，最小侵入：

### 1. Unfinished snapshot restore

`Harness.run()` 启动时已经有：

```ts
const activeCheckpoint = await this.checkpointManager?.loadActive();
if (activeCheckpoint) {
  messages.push(this.checkpointManager!.buildResumeMessage(activeCheckpoint));
}
```

ETL 在 `TaskCheckpoint` 接口里加可选 `plan` 字段。`buildResumeMessage` 在 plan 存在且 `activeStepId` 非空时，
**追加**一段：

```
[Plan Recovery] Previously you were at step "{activeStep.title}" (status=running).
Continue from this step. Do not regenerate the plan.
```

> 旧 checkpoint 文件（无 plan 字段）不受影响，行为与今天完全一致。

### 2. Plan rehydration from session-notes

`session-notes.md` 中追加一个独立 fence：

````markdown
```icecoder-plan
{ "version": 1, "planId": "...", "goal": "...", "steps": [...], "activeStepId": "step-03", ... }
```
````

新增模块 `src/memory/file-memory/execution-plan-fence.ts`：

```ts
export const ICECODER_PLAN_FENCE_LANG = 'icecoder-plan';
export function parsePersistedPlan(notes: string): ExecutionPlan | null { /* 类似 parsePersistedRuntime */ }
export function buildPlanFence(plan: ExecutionPlan): string { /* 类似 buildRuntimeFence */ }
```

在 `HarnessMemoryIntegration.hydrateRuntimeFromSessionNotes` 旁新增对称的
`hydratePlanFromSessionNotes(planTracker)`，仅当 feature flag 开时调用。

### 3. UI step recovery

前端在收到 `connected` 后立即拉一次 `GET /api/sessions/default/plan`（新增）。
若返回非空 plan：

- 渲染面板；
- 把 `activeStepId` 对应卡片设为 `running` 脉冲；
- 冰豆 setState 用 plan.intent → 决定 `focused / working / determined`。

---

## Ice Bean Integration

**绝对不动 `session-pet.js`**（核心 canvas 绘制逻辑保持原状）。
只在 `chat-pet-bridge.js` 的 `applyHarnessStepToPet` switch 中**新增**两个 case，
桥联通过 plan 事件携带的最小信息触发表情。

### State mapping (Harness phase / step status → pet state)

| 来源 | 条件 | 冰豆 state |
|------|------|------------|
| `execution_plan_init` | 首次注入 | `surprised`（已存在表情）→ 1.5s 后回到 `thinking` |
| `execution_plan_update` | `activeStep.phase === 'context'` 且 status=running | `read` |
| `execution_plan_update` | `activeStep.phase === 'editing'` 且 status=running | `working` |
| `execution_plan_update` | `activeStep.isVerification` 且 status=running | `focused` |
| `execution_plan_update` | step.status=done 且 progress < 100 | `playful` |
| `execution_plan_update` | step.status=failed | `weary` + 气泡显示 step.error |
| `execution_plan_update` | progress === 100 | `happy` |

### Mood mapping (intent → 气泡口吻)

`ChatExecutionPlanBridge` 在收到 init 时根据 `plan.intent` 决定首句气泡文案：

| intent | 气泡 |
|--------|------|
| edit | 「拆成 X 步搞定」 |
| debug | 「先复现，再修，再验」 |
| test | 「跑测试 → 看失败 → 调」 |
| refactor | 「先看引用，再批量改」 |
| inspect | 「读一下相关位置」 |
| docs | 「先看现状再写」 |
| question | （不展示面板） |

`question` 类不生成 plan（generator 直接返回 null），避免单 Q&A 干扰用户。

### Event bridge integration

`chat-pet-bridge.js` 末尾追加（**示意，不在本 PR 内实现**）：

```js
case 'execution_plan_init':
  sessionPet.setState('surprised');
  bubble('已生成执行计划');
  break;
case 'execution_plan_update':
  // 由 chat-execution-plan-bridge.js 决定表情，仅设置气泡
  if (step.bubble) bubble(step.bubble);
  break;
```

> **No core canvas change**：`session-pet.js` 的渲染逻辑、表情枚举、眨眼调度、token ring 等一律不动。

---

## Feature Flag

### `ICE_ENABLE_EXECUTION_PLAN`

| 值 | 行为 |
|----|------|
| 未设置 / `0` / `false` / 空 | **完全关闭**。Harness 不实例化 generator/tracker；不发 `execution_plan_*` 事件；不写 `icecoder-plan` fence；不在 checkpoint 写 `plan` 字段；前端 `features.executionPlan = false`，面板与桥不挂载。 |
| `1` / `true` | 完整启用。 |

读取入口（沿用 `src/harness/token-budget-config.ts` 同样的小函数模式）：

```ts
// src/harness/execution-plan-config.ts (新增，与 token-budget-config.ts 并列)
export function isExecutionPlanEnabled(): boolean {
  const v = process.env.ICE_ENABLE_EXECUTION_PLAN?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
```

`chat-ws.ts` 在 `connected` 消息体内追加：

```ts
sendJSON(ws, {
  type: 'connected',
  ...,
  features: { executionPlan: isExecutionPlanEnabled() },
});
```

### 关闭状态下的兼容承诺

- 所有现有 WS 事件、HarnessStepEvent type、checkpoint 字段、session-notes 内容**逐字节**等价于当前实现。
- 单测覆盖：在 flag off 下重放一段历史会话，断言 `result.messages` 与 baseline 完全一致。

---

## Testing Plan

### Runtime（`test/harness/*.test.ts`，vitest）

1. `execution-plan-generator.test.ts`
   - intent=`edit` → 至少含 context / editing / verification 三类 step。
   - intent=`question` → 返回 `null`，不生成 plan。
   - 已存在 verificationStatus=`passed` 的 snapshot → 不再追加 verification step。
2. `execution-plan-tracker.test.ts`
   - 模拟 phase transition `intent → context → editing → verification`，断言 active step 顺次推进。
   - 失败 tool 连续 ≥ 2 次同签名 → 当前 step `failed`，progress 不回退。
   - `stopReason='model_done'` → 余下 pending 全部标记 `skipped`，progress=100。
3. `execution-plan-resume.test.ts`
   - 写出含 `plan` 的 checkpoint + `icecoder-plan` fence → 重新 `Harness.run()` → `<resume-checkpoint>` 包含 "Continue from this step"，前端事件 sequence 以 `execution_plan_init` 开头。
4. `execution-plan-fence.test.ts`
   - round-trip：`buildPlanFence → parsePersistedPlan` 等价；版本不匹配返回 `null`；多 fence 取最后一个。

### WebSocket（`test/web/execution-plan-ws.test.ts`）

5. 建立 WS → 发首条 message → 断言收到顺序：
   `step.execution_plan_init` → ≥1 个 `step.tool_call` → ≥1 个 `step.execution_plan_update` → `step.final`。
6. `ICE_ENABLE_EXECUTION_PLAN=0` 重跑 → 不出现任何 `execution_plan_*`。

### Frontend（手工 + Playwright 烟雾，可选）

7. 收到 init → 面板渲染对应步数；
8. 收到 update patch → 仅匹配 step 被改色，其他无重渲染（DOM diff 验证）；
9. 断线 → 重连后 REST 拉取 plan → 面板恢复；
10. flag off → 面板 DOM 完全不挂载。

### Resume（端到端）

11. 启动一个 `edit` 任务 → 第 2 轮 `kill -9` → 重启服务 → 同会话首轮 LLM 提示中包含「Continue from step …」。
12. session-notes 中只有 `icecoder-runtime` fence、缺 `icecoder-plan` → 行为退化为「按当前 phase 重建空 plan」，不崩。

---

## Risks

1. **回归风险**
   - 加事件 type 时若忘记标记可选字段，旧前端解析 step 会拿到 `undefined.plan` → **缓解**：所有 plan 字段以可选形式叠加，前端 switch default 路径已存在；feature flag 默认关闭。
   - checkpoint 文件加新字段会被旧版本忽略 → **缓解**：JSON 解析对未知字段是宽容的，且 plan 是可选。

2. **性能问题**
   - 每轮 `execution_plan_update` 默认会触发前端面板 patch 与一次 telemetry append。
   - **缓解**：tracker 内合并同一 step 状态相同的连续 patch（debounce 50ms）；telemetry 已是异步 fire-and-forget。

3. **事件泛滥（event spam）**
   - tool_progress / tool_result 高频时若每个都触发 plan_update，会冲到前端几十次/秒。
   - **缓解**：tracker 仅在 **step 状态真的变化** 或 **active step 切换** 时发 patch；纯进度文本不发 plan_update（仍走 `tool_progress`）。

4. **Plan 与实际 toolCall 错位（sync mismatch）**
   - 模型可能选用不在 `suggestedTools` 内的工具。
   - **缓解**：tracker 用 `phase` 而非工具名做主驱动；`suggestedTools` 仅用作 evidence 填充与 UI 高亮，不做 step 推进决策。

5. **快照不一致（snapshot inconsistency）**
   - checkpoint 与 session-notes 各自存了一份 plan，可能在崩溃中产生两份不同状态的 plan。
   - **缓解**：checkpoint 是单调写入（`.tmp` + rename，已有），ETL 在每个保存点**先写 checkpoint，再写 session-notes**；恢复时以 checkpoint 为主，fence 为辅；`planId` 不一致时丢弃 fence。

6. **多任务串扰**
   - 同会话短时间内发起两条不相关消息（已有任务切换检测）→ 旧 plan 不该挂尸。
   - **缓解**：检测到 `taskSwitchInjected` 时 tracker 调用 `clearPlan()` 并推 `execution_plan_init`（新 plan）。

7. **测试桩与真实 LLM 偏差**
   - Tracker 单测靠注入合成 `phase` 事件；真实运行可能 phase 跳跃（context 直接到 editing）。
   - **缓解**：tracker 对「跳级」做容错——遇到目标 phase 时把所有未到达的前置 step 自动 `done`。

---

## Recommended Implementation Order

按从内到外、可逐 PR 合入的顺序：

### 1. types（无运行时影响）

- 新增 `src/types/execution-plan.ts`。
- 在 `src/harness/types.ts` 的 `HarnessStepEvent.type` union 追加 `'execution_plan_init' | 'execution_plan_update'`，并把可选字段 `plan?` `patch?` `planId?` 加上。
- 写 `execution-plan-fence.test.ts` 与 `execution-plan-generator.test.ts` 的骨架（红）。

### 2. runtime

- 新增 `src/harness/execution-plan-config.ts`（feature flag）。
- 新增 `src/harness/execution-plan-generator.ts`（纯函数）。
- 新增 `src/harness/execution-plan-tracker.ts`（含持久化 helper）。
- 在 `Harness` 构造时按 flag 实例化 tracker；在循环关键点（首轮 plan 生成、phase 切换、tool_result、verification、final/abort）调用 tracker。
- 扩 `TaskCheckpoint` 接口加 `plan?`；`buildResumeMessage` 在 plan 存在时追加恢复提示行。
- 新增 `src/memory/file-memory/execution-plan-fence.ts` 并接入 `HarnessMemoryIntegration`。
- 跑通 §Testing Plan 中 1–4。

### 3. websocket

- 在 `chat-ws.ts` 的 `connected` 消息中加 `features.executionPlan`。
- 把 tracker 发出的 `ExecutionPlanEvent` 透传到 `onStep`（无需新 WS type，复用 `step` 通道）。
- 新增 `GET /api/sessions/:id/plan` REST 端点（读取 checkpoint.plan）。
- 跑通 §Testing Plan 中 5、6。

### 4. frontend

- 新增 `src/public/js/chat-execution-plan.js` + `chat-execution-plan-bridge.js` + `src/public/css/chat-execution-plan.css`。
- `index.html` 追加 `<aside>` 与 `<script>` / `<link>`。
- `chat-pet-bridge.js` 新增两个 switch case（不动其他 case）。
- 联调 §Testing Plan 中 7–10。

### 5. tests

- 补全端到端恢复用例 11、12。
- 在 CI 中加一个 `ICE_ENABLE_EXECUTION_PLAN=0` 的回归矩阵跑全套现有测试，确认零回归。
- 在 `docs/` 增加一段 README 链接（不在本设计范围内）。

---

## Migration Notes

> 本节面向后续维护者，说明 ETL 启用后需要关心的兼容性细节。

- **现有 `session-notes.md` 不需要迁移**：缺 `icecoder-plan` fence 时 ETL 会按 phase 自动重建一份空 plan，旧文件零改动。
- **现有 `checkpoint.json` 不需要迁移**：解析时 `plan` 为 undefined，行为等价于 ETL 关闭。
- **现有前端缓存**（`localStorage`）不需要清理；面板新挂载的 DOM 节点用独立 id，不与旧选择器冲突。
- **回滚**：把 `ICE_ENABLE_EXECUTION_PLAN` 调回 `0` 即可，磁盘上残留的 plan fence / plan 字段不会被任何旧代码路径读取。
- **未来扩展**（不在本期范围）：
  - 用户在面板上手动「跳过 / 重排 step」→ 通过 WS 反向消息驱动 tracker。
  - LLM 主动建议 plan 变更（新 toolCall: `propose_plan_change`）。
  - 多任务并行 plan 列表（当前只支持单 plan）。
