# iceCoder 双模自适应运行时监管系统（V1.3.7）

## 状态

工程实现规格版（Implementation Spec）· **实现决议与附录 A/B 已冻结**（2026-05）  
**V1.3.6（2026-05）：** 公理 **I10**、**§2.8.12 Forced minimum dwell**（task-bearing round 最小驻留）。  
**V1.3.7（2026-05）：** 删除竞品对比（原 §23）、时间排期（原 §21）、benchmark 外链章（原 §22）；验收与迁移保留于附录 B/C。

本版本在以下基础上演进：

- TaskGraph Planner V1（强规则图驱动）
- Adaptive Runtime Supervisor V1.2
- Selective Critical-Domain Supervision（选择性强规则）

核心升级：

> 从全局双模，升级为基于任务域与风险等级的选择性双模监管系统。

## 阅读指引

| 区块 | 章节 | 用途 |
|------|------|------|
| 背景与动机 | §1–§7 | 为什么做、总体架构；**§3.2 全局策略 vs 局部决策** |
| **架构公理（必读）** | **§2.6–§2.8** | 干预分层；Execution Mode；**I10 min dwell**；signal 优先级 / fail-safe |
| 概念模块 | §8（**§8.10 起为实现规范**） | 模块职责与接口名 |
| 行为与参数（**实现为准**） | §14–§19、附录 A | `ToolGate`、Harness 四钩子、状态机、互斥表 |
| **配置与环境变量（实现须写注释）** | **§15** | 环境变量、`supervisor-config.json` 全字段说明与示例 |
| 验收与迁移 | **附录 B、附录 C** | 门禁 / Execution Mode / 全量验收；Harness 接入清单 |
| 后续优化（非本规格） | [`运行时后续优化.md`](./运行时后续优化.md) | Benchmark、Learning、eval 扩展 |

> **冲突时以 §14–§19、附录 A/B/C 为准。** §6、§12 等早期数值若与 §17 不一致，**以 §17 参数矩阵为准**。

---

# 1. 系统概述

iceCoder 双模自适应运行时监管系统，是位于 Harness 主循环之上的运行时控制层。

其目标是：

在最大限度保留大模型自由执行能力的同时，为关键任务提供强规则兜底与异常恢复能力。

系统职责：

- 自由执行
- 异常观察
- 风险识别
- 系统接管
- 状态恢复
- 安全交还

本系统本质不是 planner，也不是 workflow。

而是：

> AI Agent 运行时监管内核（Runtime Supervisor）。

---

# 2. 核心设计哲学

---

## 2.1 信任优先

默认信任模型执行能力。

系统不主动限制模型。

仅在必要时介入。

---

## 2.2 关键任务监管

仅对高风险关键任务启用强规则。

非关键任务完全自由。

---

## 2.3 状态优先恢复

恢复逻辑必须基于当前工作区真实状态。

不得仅依赖执行轨迹。

---

## 2.4 成本有界

所有恢复流程必须受预算控制。

防止无限修复循环。

---

## 2.5 全程可观测

所有运行事件必须记录。

用于 benchmark 与调优（指标落盘与 Learning 见 [`运行时后续优化.md`](./运行时后续优化.md)）。

---

## 2.6 架构公理（实现不得违背）

> 引入 Supervisor **不能自动**消除「规则散、执行软」；下列公理为编码准绳，违背则视为未实现 V1.3.1。

| 公理 | 含义 |
|------|------|
| **I1 纠偏出口唯一** | 凡属「纠正执行策略」的 system/user 块，**仅**允许经 `CorrectionPort.inject()` 写入 `msgs`；禁止 `GraphExecutor` / Resilience / Harness 主循环直接 `msgs.push` 纠偏文案。 |
| **I2 门禁可执行** | `ToolGateDecision.block` 的工具 **不得**进入 `executeToolCalls`；`warn` 可执行并至多附带一条说明；`deny` 由 `PermissionManager` 在 Gate 之前处理。 |
| **I3 free 段默认无图** | `adaptive` 模式下，关键域 **自由段** 不得 `initGraph`（见 §17）；`evaluateRound` 不得向 `msgs` 注入。 |
| **I4 策略提示预算** | free 段若保留 `no_tool_execution_recovery` 等生命周期外提示，须计入 `CorrectionBudget`（建议每任务 **≤1** 次）；超出则只累积 `PassiveObserver` 信号，等待 `takeover`。 |
| **I5 模式切换唯一** | **`ExecutionMode`（Free / Forced）仅 `ModeDecisionEngine` 可切换**；`GraphExecutor` / `RecoverySupervisor` / `CheckpointEngine` / `StepGate` / `BranchBudget` / `ToolGate` / StopHook **只提交 `ModeSignal`**，禁止写 `LoopState.executionMode`。 |
| **I6 全局策略边界** | **环境变量 / config `mode` 仅决定「是否启用自动决策」及全局能力包（§3.2）**；**禁止**在业务模块内读取 `ICE_SUPERVISOR_*` 做局部任务判断。局部 Free/Forced、接管、L0–L2 **只读运行态 + `supervisor-config.json` 参数**。 |
| **I10 Forced 最小驻留** | **`executionMode=forced` 须至少完成 §2.8.12 所定义的 1 次（可配置）有效任务轮（task-bearing round）后，才允许退出为 free**；与 mode lock（§2.8.6）叠加。禁止 enter → 信号清空 → 次轮即 exit 的 forced 闪跳。 |

**禁止的实现形态（反例）：**

- `checkToolCall` 返回 `block` 后仍 `msgs.push` 且 **全量** `executeToolCalls` → 违反 **I2**（执行软）。
- 同时存在 Harness 连续失败 inject + Graph `evaluateRound` inject + Supervisor 接管块 → 违反 **I1**（规则散）。
- `adaptive` 关键域第 1 轮 `initGraph` 且未进入 `strict` → 违反 **I3**（与信任优先冲突）。
- `GraphExecutor` 内 `if (process.env.ICE_SUPERVISOR_MODE === 'strict')` 跳过 step gate → 违反 **I6**（env 参与局部判断）。
- forced 进入后 graph 变空、signal 清零，**次轮**即 `exit_forced` 且 **无 task-bearing round** → 违反 **I10**（forced 闪跳）。

---

## 2.7 干预分层（A / B / C）

从根避免 Harness 各处 `msgs.push` 混用，所有模块必须归入下列三类之一：

```text
┌─────────────────────────────────────────────────────────────┐
│ A. 生命周期门禁（LifecycleGate）— 始终允许，不教模型怎么改   │
│    permission deny/confirm 拒绝 / 熔断 / verification 挡 final │
│    → 不 inject 长策略文案；只挡状态转移或挡单次工具           │
├─────────────────────────────────────────────────────────────┤
│ B. 观测（Observe）— 只写 timeline / metrics，不写 msgs       │
│    PassiveObserver、branch budget 计数、evaluateRound(metrics)│
├─────────────────────────────────────────────────────────────┤
│ C. 纠偏（Correct）— 唯一可变 msgs 的策略来源                  │
│    free：默认禁止 C；Observer 累积 → takeover 时一次性 C      │
│    takeover：仅 RecoverySupervisor（经 CorrectionPort）         │
│    strict：Supervisor 编排 Graph hint，仍经 CorrectionPort 转发│
└─────────────────────────────────────────────────────────────┘
```

| 类型 | 示例 | 写 `msgs`？ |
|------|------|-------------|
| A | `Verification Gate` 挡 `final`、熔断 `circuit_breaker` | 仅短流程说明（非策略说教） |
| B | 重复失败计数、漂移分数、graph metrics | **否** |
| C | 接管块、`[System Recovery]`、strict 下图节点 hint | **是**（受 I1 约束） |

---

## 2.8 Execution Mode Boundary Contract（Free / Forced）

> **术语：** 本节 **Execution Free / Forced** 指 **Harness 执行边界**（`LoopState.executionMode`），与 §3 **`ICE_SUPERVISOR_MODE=off` 产品「自由」**、以及 `supervisorPhase=free` **自适应信任段** 不同。三者映射见 **§3.1**。

系统在同一任务内维持 **双模执行边界**：默认 **Execution Free Mode**；满足 **§2.8.5 进入规则** 时切入 **Execution Forced Mode**。切换 **仅** 由 **`ModeDecisionEngine`**（§8.11）裁决；**禁止**关键词、用户原文 regex、LLM 语义猜测作为切换依据（**运行状态驱动**）。

### 2.8.1 架构总览

```text
                    ┌──────────────────────────────────────┐
                    │         ModeDecisionEngine           │
                    │  (唯一 executionMode 切换入口 · I5)   │
                    └───────────────▲──────────────────────┘
                                    │ evaluate(signals, state)
        ┌───────────────────────────┼───────────────────────────┐
        │ submit ModeSignal only    │                           │
        ▼                           ▼                           ▼
 GraphExecutor              RecoverySupervisor           CheckpointEngine
 StepGate                   BranchBudgetTracker          ToolGate
 StopHook                   PassiveObserver (metrics)    TaskRiskClassifier
```

**与 Supervisor 层关系：**

| 层 | 字段 / 组件 | 职责 |
|----|-------------|------|
| 产品配置 | `ICE_SUPERVISOR_MODE` | `off` / `adaptive` / `strict`（§3） |
| 监管相位 | `supervisorPhase` | `free` / `takeover` / …（§18） |
| **执行边界** | **`executionMode`** | **`free` / `forced`（本节）** |

- `executionMode=forced` **不必然** `supervisorPhase=takeover`（例如 L2 结构性任务在 adaptive 自由段仍可为 Forced 以启用 step gate，尚未触发 §9 接管）。
- `supervisorPhase=takeover` **必须** `executionMode=forced`（接管段禁止 Execution Free）。

### 2.8.2 Execution Free Mode

**适用：** 纯观察与低风险行为（**TaskRiskClassifier L0/L1 默认段**，§2.8.4）。

**典型工具 / 行为（由运行态推导，非关键词表）：**

| 运行态条件 | 等价行为类 |
|------------|------------|
| 本轮 / 下轮计划工具 ⊆ 只读集 | read file、search、grep、architecture inspect、context analyze、dependency scan |
| 无 pending write、`writeTargetsThisRound=0` | runtime reasoning、解释、规划性只读 |

**特征（Forced 能力关闭）：**

| 能力 | Free 下 |
|------|---------|
| Step gate（图节点合约） | **不约束**（无 active graph 或未进入 Forced） |
| Checkpoint 强制点 | **不强制**（Lifecycle A 类仍可用） |
| Branch budget | **不启用** |
| Recovery 控制 inject | **不插入**（C 类仍受 §2.7 / CorrectionBudget） |
| 主循环 | **保持自由 tool 循环** |

### 2.8.3 Execution Forced Mode

**适用：** 高风险执行任务（**L2**，或 L1 升级后，§2.8.4–§2.8.5）。

**典型运行态（非关键词）：**

| 运行态 | 等价任务类 |
|--------|------------|
| `taskGraphActive && pendingSteps >= 1` | task graph execution |
| `writeTargetsThisRound > 0` 或 `multi_write` signal | feature implement、multi-file edit、structural patch |
| `checkpointResumed` | checkpoint resume、recovery continuation |
| `recoveryPending` | recovery continuation |
| `accumulatedDiffLines > threshold` | large scale modification |

**特征（Forced 能力开启）：**

| 能力 | Forced 下 |
|------|-----------|
| Step gate | **启用**（`GraphExecutor.checkToolCall` → ToolGate） |
| Checkpoint | **强制**（关键写前 / 图节点边界，经 CheckpointEngine 信号） |
| Branch budget | **启用** |
| Recovery | **启用**（RecoverySupervisor 可 orchestrate；C 类经 CorrectionPort） |
| Write sync | **显式**（写工具与 `RepoContext.filesChanged` 同步计数） |
| State control | **显式**（`LoopState.executionMode` + timeline 可验证） |

### 2.8.4 TaskRiskClassifier（风险分级 · 运行态）

> 实现：**§8.12**。按 **`RuntimeExecutionState`** 分类；**禁止**用用户 goal 关键词、`inferIntent()` 正则、LLM 分类作为 **Forced 切换** 依据（意图枚举仅可写 timeline 供人读）。

| 级别 | 名称 | Execution 默认 | 运行态判定（示例） |
|------|------|----------------|-------------------|
| **L0** | Observation | **永远 Free** | 计划工具 ⊆ `{read_file, grep, search, list, …}`；`writeTargets=0`；无 active graph |
| **L1** | Minor Edit | **Free**；失败后升级 Forced | `writeTargetsThisRound=1` 且 `accumulatedDiffLines ≤ threshold`；单文件 patch |
| **L2** | Structural Execution | **直接 Forced** | 满足 §2.8.5 任一条 |

**L1 → Forced 升级（运行态，非关键词）：** 上一轮 `tool_failure` signal；或同一文件第 2 次 write；或 `branch_switched`。

### 2.8.5 进入 / 退出规则

```ts
shouldEnterForcedMode(state: RuntimeExecutionState): boolean
```

**满足任一即进入 Forced**（`ModeDecisionEngine` 内实现；阈值见 **§15.6** / **附录 A**）：

| # | 条件 | 信号 / 状态源 |
|---|------|----------------|
| 1 | Task graph active | `task_graph_active` |
| 2 | Pending steps ≥ 2 | `pending_steps` |
| 3 | Write targets > 1 | `multi_write` |
| 4 | Branch switched 本轮 | `branch_switched` |
| 5 | Checkpoint resumed 本会话 | `checkpoint_resumed` |
| 6 | 上一轮工具失败 | `tool_failure` |
| 7 | Diff lines > threshold | `large_diff` |
| 8 | 显式实现态（**非关键词**） | `explicit_impl`：`TaskGraph` 存在 type=`implement` 的 **active/pending** 节点，或 checkpoint 恢复带出 **pending write steps** |

否则保持 **Execution Free**。

```ts
shouldExitForcedMode(state: RuntimeExecutionState): boolean
```

**必须全部满足才可退出 Forced → Free**（且 **§2.8.6 mode lock** 已过期、**§2.8.12 forced min dwell** 已满足）：

| # | 条件 |
|---|------|
| 1 | `pendingSteps === 0` |
| 2 | 本轮无 write intent（`plannedWriteTargets=0`） |
| 3 | `stableRounds >= 2`（无 tool_failure / recovery / branch_switch） |
| 4 | 无 `recovery_pending` signal |
| 5 | `branchDebt === 0`（BranchBudget 无未清债务） |
| 6 | **`forcedTaskBearingRoundsSinceEntry >= forcedMinDwellRounds`**（**I10** · 默认 **≥1**） |

### 2.8.6 Mode lock（enter 后锁定）

Forced **进入**后：

- 设置 `executionModeLockRemaining = modeLockRounds`（默认 **2** rounds；**§15.5**）。
- 锁定期内 **`shouldExitForcedMode` 即使为 true 也不退出**。
- 防止 enter 后立即 exit；与 **§2.8.12 min dwell**、§12.3 handoff 冷却 **独立计数**。

### 2.8.12 Forced minimum dwell（最小驻留 · I10）

> **与 §2.8.6 区别：** mode lock = **时间轮次**防抖（enter 后 N 轮内不许 exit）；min dwell = **至少完成有效任务**才许 exit。二者 **同时**生效。

**公理（I10）：**

> `executionMode=forced` shall persist until at least one successful **task-bearing round** completes after entry（默认 `forcedMinDwellRounds=1`，可配置）。

**反例（须避免）：**

```text
round N:   enter forced（pending_steps）
round N+1: graph empty · signals clear · shouldExitForcedMode=true → exit  // ❌ 违反 I10
```

**Task-bearing round（有效任务轮）定义：**

自 forced 进入后，某 round **结束**时满足 **至少一条**（运行态判定，非关键词）：

| # | 条件 |
|---|------|
| a | 至少 **1** 次工具 **execute 成功**（非 ToolGate skip；非纯 Lifecycle deny） |
| b | TaskGraph **步骤推进**（节点 `pending→done` 或 `currentStep` 变化） |
| c | **写类**工具成功且 `RepoContext.filesChanged` 更新 |

**不计入 task-bearing：**

- 仅 LLM 回复、无 tool call 的 round
- 工具全 skip / block、无成功 execute
- graph 变空导致 signal 清零但 **无**上述 a/b/c

**实现字段（`LoopState` · §14.2）：**

| 字段 | 说明 |
|------|------|
| `forcedEntryRound` | 最近一次 free→forced 的 round；enter 时写入 |
| `forcedTaskBearingRoundsSinceEntry` | 自 entry 起累计 task-bearing round 数；**exit 时清零** |
| `forcedMinDwellSatisfied` | `forcedTaskBearingRoundsSinceEntry >= forcedMinDwellRounds`（可冗余缓存） |

**配置：** `executionMode.forcedMinDwellRounds`（默认 **1**，§15.5）。

**退出判定顺序（`ModeDecisionEngine`）：**

```text
1. executionMode !== forced → N/A
2. executionModeLockRemaining > 0 → deny exit
3. forcedTaskBearingRoundsSinceEntry < forcedMinDwellRounds → deny exit (I10)
4. §2.8.5 表 1–5 → all true 才 allow exit
```

### 2.8.7 ModeSignal 与模块边界

**唯一切换器：** `ModeDecisionEngine`（§8.11）。

**仅可 `submitSignal` 的模块：**

`GraphExecutor` · `RecoverySupervisor` · `CheckpointEngine` · `StepGate` · `BranchBudgetTracker` · `ToolGate` · StopHook

```ts
type ModeSignal =
  | 'task_graph_active'
  | 'pending_steps'
  | 'multi_write'
  | 'branch_switched'
  | 'checkpoint_resumed'
  | 'tool_failure'
  | 'recovery_pending'
  | 'large_diff'
  | 'explicit_impl';
```

**Learning 层：** 仅可产出 **阈值建议** 或 shadow 报表；**不得**成为 `executionMode` 主决策层（见 [`运行时后续优化.md`](./运行时后续优化.md) §4）。

### 2.8.8 Signal precedence（信号优先级）

当 **同一 round** 内多个 `ModeSignal` 同时满足 `shouldEnterForcedMode` 时，**进入 Forced 的判定为 OR（任一即可）**；**解释与遥测**须按下列优先级排序，避免「为什么这轮被切 forced？」无法回答。

| 优先级 | 信号 | 含义（调试摘要） |
|--------|------|------------------|
| **P0** | `checkpoint_resumed` | checkpoint 恢复后会话 |
| **P1** | `task_graph_active` | TaskGraph 已激活 |
| **P2** | `branch_switched` | 本轮发生分支切换 |
| **P3** | `pending_steps` | 待执行图步骤 ≥ 阈 |
| **P4** | `tool_failure` | 上一轮工具失败 |
| **P5** | `multi_write` | 多文件 / 多写目标 |
| **P6** | `large_diff` | 累计 diff 超阈 |
| **P7** | `explicit_impl` | 图上有 implement 类 active/pending 节点 |

**规则：**

- `enteredBy`（§2.8.9）= 本轮所有触发 enter 的信号，按 **P0→P7** 排序；**首位 = primaryReason**（写 timeline 一行摘要）。
- `recovery_pending` **不参与 enter 优先级**（仅阻塞 exit，§2.8.5）。
- 实现须提供 `sortSignalsByPrecedence(signals: ModeSignal[]): ModeSignal[]`（附录 A）。

**示例：**

```text
signals = [pending_steps, checkpoint_resumed]
enteredBy = [checkpoint_resumed, pending_steps]   // P0 在前
primaryReason = checkpoint_resumed
human: "forced because checkpoint_resumed + pending_steps"
```

### 2.8.9 Forced 来源遥测（`enteredBy`）

每次 **`executionMode` 从 free → forced**（含 fail-safe，§2.8.10）须写入可观测字段：

| 字段 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `enteredBy` | `LoopState` / checkpoint | `ModeSignal[]` | 按 §2.8.8 排序；持久化到 `RuntimeCheckpointV2` |
| `enteredByPrimary` | 同上 | `ModeSignal` | `enteredBy[0]` |
| `enteredAtRound` | 同上 | `number` | 进入 forced 的 round |

**Runtime telemetry（须实现）：**

- `HarnessStepEvent` 扩展：`execution_mode_enter` / `execution_mode_exit`
- 落盘：`data/runtime/telemetry.jsonl`（与现有 `runtime-telemetry.ts` 对齐）或 `supervisor-events.jsonl`

```ts
interface ExecutionModeTelemetryPayload {
  executionMode: 'free' | 'forced';
  enteredBy: ModeSignal[];       // 排序后全量
  enteredByPrimary?: ModeSignal;
  primaryReasonHuman: string;    // e.g. "forced because checkpoint_resumed + pending_steps"
  round: number;
  failSafe?: boolean;            // §2.8.10 引擎异常兜底
  degradedTier?: ForcedDegradedTier; // §2.8.11
}
```

**禁止：** 仅写 `executionMode=forced` 而不记录 `enteredBy`（附录 B 验收）。

### 2.8.10 Fail-safe（ModeDecisionEngine 异常）

执行系统 **出错时安全优先**：`ModeDecisionEngine.evaluate` **抛异常或未捕获错误** 时：

| 项 | 行为 |
|----|------|
| **fallback `executionMode`** | **`forced`**（**不是 free**） |
| `enteredBy` | `['engine_fail_safe']`（附录 A 扩展 `ModeSignal` 或专用 `failSafe: true` 标志） |
| 遥测 | `execution_mode_enter` + `failSafe: true` |
| 用户可见 | A 类短说明可选：「模式决策暂不可用，已启用安全执行边界」 |

**已在 forced：** 保持 forced，不降级为 free。

```ts
evaluate(ctx: ModeDecisionContext): ModeDecision {
  try {
    return this.evaluateOrThrow(ctx);
  } catch (err) {
    this.emitFailSafeTelemetry(ctx, err);
    return {
      action: 'enter_forced',
      reason: ['engine_fail_safe' as ModeSignal],
      enteredBy: ['engine_fail_safe' as ModeSignal],
      primaryReason: 'engine_fail_safe' as ModeSignal,
      lockRounds: ctx.config.modeLockRounds,
    };
  }
}
```

### 2.8.11 Forced Mode Degraded Execution（图失败不回落 Free）

在 **`executionMode=forced`** 下，若 **`RetrospectiveGraphBuilder` 失败**（或 graph 合约不可执行），**禁止**因 graph failure **自动切回 Execution Free**。

**降级梯（依次退化，保持 forced）：**

```text
graph（TaskGraph + StepGate + checkToolCall）
        │ builder / replaceGraph 失败
        ▼
stepQueue（无图线性步骤队列 + StepGate -lite）
        │ 队列不可构建 / 执行仍失败
        ▼
writeIntent（仅 write 目标显式约束 + ToolGate write 类）
        │ 预算耗尽
        ▼
§19.2 三级 · 人工（user_checkpoint）
```

| 层级 | `forcedDegradedTier` | 行为 |
|------|----------------------|------|
| **graph** | `'graph'` | 正常图驱动；§10 / §19.2 一级 |
| **stepQueue** | `'step_queue'` | `markGraphPaused`；内存步骤队列；**仍 forced** |
| **writeIntent** | `'write_intent'` | 仅约束写工具与路径；**仍 forced** |

**硬约束：**

- graph failure → **`executionMode` 保持 `forced`**；仅 **`forcedDegradedTier`** 下降。
- **`shouldExitForcedMode` 不因 degraded 自动为 true**（须满足 §2.8.5 退出条件 + 无 open recovery）。
- 与 §19.2 二级「强提示」一致：无图但 **forced + degraded**，非 free。

---

# 3. 运行模式

产品仅三档，对应 **`ICE_SUPERVISOR_MODE`**：`off`（自由）、`adaptive`（自适应，**默认**）、`strict`（严格）。不设第四档「监管模式」预设——接管后的收紧由 **自适应 + `supervisorPhase=takeover`** 表达，无需单独配置。

---

## 模式 A：自由模式（Free）— `ICE_SUPERVISOR_MODE=off`

纯模型执行；关闭 Supervisor（零观测开销），等同今日纯 Harness。

---

## 模式 B：自适应模式（Adaptive）— `ICE_SUPERVISOR_MODE=adaptive`（默认）

平时自由；关键域满足 §9 三条件时进入 **接管段**（`supervisorPhase=takeover`），参数见 §17 **adaptive·接管段** 列。

---

## 模式 C：严格模式（Strict）— `ICE_SUPERVISOR_MODE=strict`

关键域 **首轮即建图**，全程图驱动；兼容 TaskGraph Planner V1 强规则路径。

---

## 3.1 三层「模式」对照（避免混用）

| 名称 | 存储位置 | 枚举 | 决策者 |
|------|----------|------|--------|
| 产品监管模式 | env / config | `SupervisorMode`: `off` \| `adaptive` \| `strict` | `ModeController` |
| 监管运行时相位 | `LoopState.supervisorPhase` | `free` \| `takeover` \| `handoff_pending` \| `cooldown` | `RecoverySupervisor`（§9） |
| **执行边界模式** | **`LoopState.executionMode`** | **`free` \| `forced`** | **`ModeDecisionEngine`（§8.11 · I5）** |

**兼容映射（实现默认）：**

| `ICE_SUPERVISOR_MODE` | `supervisorPhase` | `executionMode` 下限 |
|-----------------------|-------------------|----------------------|
| `off` | — | 仅 **Execution Free**（无 Forced 切换，除非未来显式开启） |
| `adaptive` | `free` | Free；L2 / §2.8.5 → Forced |
| `adaptive` | `takeover` | **Forced**（强制） |
| `strict` | — | **Forced**（全程） |

---

## 3.2 Global Mode Policy（全局模式策略）

> **核心原则：** 环境变量 / 配置 **`mode` 字段只回答一个问题——「是否启用自动决策，以及启用哪一套全局能力包」**；**不参与**某一回合、某一工具、某一文件的局部任务判断。局部判断 **只** 由运行态 + `ModeDecisionEngine` / `TaskRiskClassifier` / `RecoverySupervisor` + JSON 阈值完成（**I6**）。

### 3.2.1 两层决策分离

```text
┌─────────────────────────────────────────────────────────────┐
│  Global Layer（部署态 · 启动时解析一次）                      │
│  ICE_SUPERVISOR_MODE / supervisor-config.mode               │
│  → ModeController.resolveGlobalPolicy()                     │
│  → GlobalModePolicy（能力开关 + 下限，非 per-task）          │
└───────────────────────────┬─────────────────────────────────┘
                            │ 只读 policy 引用
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Local Layer（运行态 · 每 round 评估）                        │
│  RuntimeExecutionState + ModeSignal + supervisor-config 阈值  │
│  → TaskRiskClassifier / ModeDecisionEngine / RecoverySupervisor│
│  → executionMode · supervisorPhase · takeover（per round）    │
└─────────────────────────────────────────────────────────────┘
```

| 层级 | 输入 | 输出 | 禁止 |
|------|------|------|------|
| **Global** | env、`mode`、`shadow` | `autoDecisionEnabled`、引擎是否挂载、能力 **floor** | 读 user goal、工具名列表做分类 |
| **Local** | 运行态、信号、JSON 阈 | `executionMode`、`supervisorPhase`、ToolGate 是否生效 | 读 `process.env.ICE_SUPERVISOR_*` |

### 3.2.2 环境变量 **只决定** 什么

| `ICE_SUPERVISOR_MODE` | `autoDecisionEnabled` | 挂载的自动决策链 | 全局能力包（floor，非 per-task） |
|-----------------------|----------------------|------------------|----------------------------------|
| `off` | **false** | **无**（无 Observer / 无 ModeDecisionEngine / 无 Supervisor 接管） | 等同纯 Harness；`executionMode` 恒 free |
| `adaptive` | **true** | Observer + ModeDecisionEngine + RecoverySupervisor | 默认 trust-first；允许局部 Free→Forced；允许 §9 takeover |
| `strict` | **true** | 同 adaptive + **strict 能力包** | `executionModeFloor=forced`；`firstRoundGraph=true`（§17）；**仍由引擎写入 state**，非 Harness 散落 `if strict` |

**`ICE_SUPERVISOR_SHADOW`：** 仅影响 Global 层「真接管是否生效」；**不改变** Local 层信号收集与 evaluate 逻辑（shadow 仍跑决策链，但不改 phase）。

**`ICE_SUPERVISOR_CONFIG_PATH`：** 仅指定 JSON 路径；阈值、触发项属 **Local 参数**，不是 env 本身。

### 3.2.3 环境变量 **不参与** 什么（局部任务判断）

下列 **禁止** 由 env 直接判定；须走 Local 层：

| 局部问题 | 正确决策者 | 错误做法（违反 I6） |
|----------|------------|---------------------|
| 本轮是否 Execution Forced？ | `ModeDecisionEngine` + §2.8.5 | `if (MODE===strict) forced=true` 写在 `harness.ts` 工具分支 |
| 是否 L0 只读 / L2 结构性？ | `TaskRiskClassifier` | 用 user message 关键词 + `MODE` 组合 |
| 是否 initGraph / replaceGraph？ | `GraphExecutor` + 运行态（graph active、§17 `firstRoundGraph`） | `strict` env 在 round 1 硬编码 `initGraph` 不看过图条件 |
| 是否 takeover？ | `RecoverySupervisor` + §9 | env 跳过风险/异常评估 |
| step gate 是否 block？ | `ToolGate` + `executionMode` | env 绕过 ToolGate |

### 3.2.4 `GlobalModePolicy`（`ModeController` 唯一产出）

启动 / 热加载时 **`ModeController.resolveGlobalPolicy()`** 解析 env + config **一次**，注入 `HarnessDeps.globalPolicy`；运行中模块 **只读** 该对象，**禁止**再读环境变量。

```ts
interface GlobalModePolicy {
  /** off → false；adaptive / strict → true */
  autoDecisionEnabled: boolean;
  supervisorMode: SupervisorMode;
  shadow: boolean;
  /** strict → forced；off → free；adaptive → free（局部可升 forced） */
  executionModeFloor: ExecutionMode;
  /** off → false */
  observerEnabled: boolean;
  modeDecisionEngineEnabled: boolean;
  recoverySupervisorEnabled: boolean;
  /** strict 能力包：§17 firstRoundGraph 等；由 config 填充，非 env 散落 */
  strictCapabilityBundle: boolean;
}
```

**`ModeDecisionEngine.evaluate` 伪代码（I6 合规）：**

```ts
if (!deps.globalPolicy.modeDecisionEngineEnabled) {
  return { action: 'keep', mode: 'free' };
}
// 局部：signals + state + config thresholds
const next = computeLocalDecision(state, signals, config);
// 全局 floor：strict 不允许低于 forced
return applyFloor(next, deps.globalPolicy.executionModeFloor);
```

### 3.2.5 与 §3.1 三层模式的关系

| §3.1 概念 | Global 层 | Local 层 |
|-----------|-----------|----------|
| `SupervisorMode`（off/adaptive/strict） | env → `GlobalModePolicy.supervisorMode` | 不 per-task 变化 |
| `supervisorPhase` | 仅决定 takeover **是否允许**（off 禁用） | `RecoverySupervisor` 每轮评估 |
| `executionMode` | `executionModeFloor`（strict 为 forced） | `ModeDecisionEngine` 每轮评估 |

**结果：** 部署时用 env 选「开不开自动决策、默认多严格」；运行时用状态选「这一回合要不要 Forced / 要不要接管」——**逻辑分离，系统干净**。

---

# 4. 关键任务域识别

> **边界说明：** 本节为 **产品 / 监管候选** 叙述（人读）。**Execution Free/Forced 切换不得依赖本节列表或关键词**；须用 **§2.8 + `TaskRiskClassifier`** 运行态（**I5**）。`TaskDomainClassifier`（§5）可写 timeline，**不得**直接写 `executionMode`。

---

仅以下任务进入监管候选。

---

## 4.1 高价值关键任务

包括：

- 新增功能
- 修复 bug
- 修改现有逻辑
- 重构
- 架构设计
- 数据迁移
- 部署改动
- 多模块联动变更

---

## 4.2 非关键任务

完全自由：

- 阅读代码
- 搜索
- 分析
- 解释
- 总结
- 文档编写
- 注释
- commit message

---

# 5. 任务分类层

运行前先分类。

---

## 流程

用户任务  
↓  
意图解析（**仅观测 / 域标签，不切换 executionMode**）  
↓  
`TaskRiskClassifier.classify(state)` → L0 / L1 / L2  
↓  
`ModeDecisionEngine.evaluate` → `executionMode`  
↓  
风险评估（§6，Supervisor 接管候选）  
↓  
模式决策（`ModeController` · `RecoverySupervisor`）  

---

## 接口

```ts
interface TaskDomainClassifier {
  /** 产品域标签；禁止用于 shouldEnterForcedMode */
  classify(goal: string): TaskDomain;
}

interface TaskRiskClassifier {
  /** 仅读 RuntimeExecutionState；禁止关键词 */
  classify(state: RuntimeExecutionState): TaskRiskLevel;
}

type TaskRiskLevel = 'L0_observation' | 'L1_minor_edit' | 'L2_structural';
```

V1 域标签可映射现有 `inferIntent()` + `shouldUseTaskGraph()`；**Forced 边界以 `TaskRiskClassifier` + §2.8.5 为准**。完整类型见 **附录 A**。

---

# 6. 风险评估层

即使是关键任务，也并非都需要接管。

必须评估风险。

---

## 风险因子

包含：

- 修改文件数量
- 依赖深度
- 模块影响范围
- 是否不可逆操作
- 编译影响范围
- 历史失败次数

---

## 风险评分

范围：

0~1

---

## 默认阈值

0.6（概念默认值）。

**实现：** 风险阈值按 `ICE_SUPERVISOR_MODE` 与阶段取值，见 **§17**（`adaptive` 自由段 0.6；`strict` 0.5）。`strict` 模式下条件二可忽略（关键域首轮已建图，见 §16.2）。

---

## 接口

```ts
interface RiskEvaluator {
  score(context: TaskContext): number;
}
```

（`TaskContext` 等类型见 **附录 A**。）

---

# 7. 总体架构

```text
用户任务
↓
任务分类器
↓
风险评估器
↓
模式控制器
├─ 自由运行
└─ 自适应运行
       ↓
运行时监管器
       ↓
稳定窗口
       ↓
安全交还
```

---

# 8. 核心模块

---

# 8.1 模式控制器（ModeController）

负责 **Global Mode Policy（§3.2）** 解析与只读下发；**不负责**局部 Free/Forced 或 takeover 判定（分属 `ModeDecisionEngine` / `RecoverySupervisor`）。

- **`resolveGlobalPolicy()`** → `GlobalModePolicy`（启动 / 热加载 **唯一**读取 `ICE_SUPERVISOR_*` 处之一）
- 向 `HarnessDeps` 注入 `globalPolicy`；业务模块 **禁止**读 env
- 提供 §17 参数、`supervisorPhase` 冷却计数（监管 **Local** 层状态机辅助）
- **禁止：** 在 `ModeController` 内根据 user goal / 工具名切换 `executionMode`

---

# 8.2 被动观察器（PassiveObserver）

后台采集异常信号。

不干预。

---

## 检测信号

- 连续失败
- 无推进
- 文件循环
- 分支膨胀
- 工具循环

---

## 接口

```ts
interface PassiveObserver {
  observe(round: RuntimeRound): DeviationSignal[];
}
```

---

# 8.3 目标漂移检测器（GoalDriftDetector）

> **实现以 §19.1 为准（V1 启发式合成信号）；本节描述 V2 目标（可选 LLM alignment）。**

检测语义偏移。

解决静默失败。

---

## 输入

- 用户目标
- 最近轮次行为
- 文件变更
- 当前输出

---

## 输出

alignment score

范围：

0~1

---

## 默认阈值

0.45

连续 2 轮低于阈值触发。

---

# 8.4 工作区状态提取器（WorkspaceStateExtractor）

接管前扫描当前工作区。

---

## 提取内容

---

### 文件状态

- 新增文件
- 修改文件
- 删除文件

---

### 构建状态

- 编译结果
- lint 状态
- test 状态

---

### 语义状态

V1：由 `RepoContext`、最近工具结果、诊断摘要拼接（**无 LLM**）。  
V2（可选）：轻量模型总结当前工程状态（`WorkspaceStateExtractor` 稳定后）。

---

# 8.5 状态可信度评估器（SnapshotConfidenceEvaluator）

判断 snapshot 是否可信。

---

## 输出

confidence

范围：

0~1

---

## 阈值

0.65 — 低于则禁止走 **§19.2 一级·模板图**（可仍走二级强提示）。

## V1 计算因子（启发式，加权求和 → 0~1）

| 因子 | 说明 | 方向 |
|------|------|------|
| Git 工作区 | 干净 / 仅预期文件变更 | 越高越可信 |
| Snapshot 年龄 | 提取后经过轮次越少越好 | 越久越低 |
| 验证结果 | 最近 N 轮内存在 passed 的 test/lint | 有则加分 |
| 与 RepoContext 一致 | `filesChanged` / `filesRead` 与快照文件列表一致 | 一致则加分 |
| 构建信号 | 最近 `run_command` 无连续失败 | 无失败加分 |

具体权重写入 `supervisor-config.json`；实现可参考 **附录 A** `SnapshotConfidenceInput`。

---

# 8.6 恢复安全检查器（RecoverySafetyChecker）

判断是否可恢复。

---

## 检查内容

- 关键文件丢失
- repo 状态损坏
- branch 异常
- 编译基线损坏

---

## 输出

recoverable

布尔值。

---

# 8.7 反向图构建器（RetrospectiveGraphBuilder）

生成恢复图。

---

## 输入

- goal
- snapshot
- signals

---

## 输出

TaskGraph

---

## 构建步骤

1. 已完成目标识别  
2. 失败区域识别  
3. 剩余路径推导  
4. 恢复图生成  
5. 后备分支插入  

---

# 8.8 恢复预算管理器（RecoveryBudgetManager）

限制恢复成本。

---

## 跟踪

- 恢复轮数
- token 消耗
- 重试次数
- 图深度

---

## 默认限制

---

### 最大恢复轮数 / token / 重试

**实现默认值见 §17**（`adaptive·接管段`：恢复轮 3、token 25%、重试 2；`strict`：恢复轮 5、token 30%）。

超过终止 → §19.2 三级或 §13。

---

# 8.9 事件时间线（EventTimeline）

必须实现。

---

## 记录事件

- switch
- recover
- rollback
- handoff
- failure
- drift
- timeout

---

## 结构

```ts
interface RuntimeEvent {
  ts: number;
  round: number;
  mode: string;
  event: string;
  reason: string;
}
```

---

# 8.10 恢复监管编排器（RecoverySupervisor）

**实现规范核心。** 编排 §8.1–§8.9，对外暴露单一入口；Harness 四钩子只调本模块（经 bridge）。

## 职责

- 每轮/每工具后：汇总 `PassiveObserver` → 结合 **`globalPolicy` + 运行态** 与 §9 三条件 → 输出 **`SupervisorDecision`**
- 触发接管：走 **§10 恢复主路径**（反构图成功）或落入 **§19.2 降级旁路**
- 接管期间：**唯一**向 `msgs` 注入纠偏类 system/user 块（与 §19.6 互斥表一致）
- 协调 `GraphExecutor`（`replaceGraph`、`setEvaluationMode`）、`RecoveryBudgetManager`、`StabilityWindow`

## 不负责

- 不替代 `GraphExecutor` 的节点合约执行（仍由 TaskGraph 负责）
- 不直接执行 rollback（经工具 + `confirm`，见 §19.5）
- **`RecoveryBoundary`**（原 §11 提及）职责并入本模块：**全相位**纠偏 inject 门禁（见 §19.6）

## RecoveryBoundary（纠偏写入门禁）

任何模块在向 `msgs` 写入 **C 类纠偏**（§2.7）前必须调用：

```ts
type CorrectionSource =
  | 'supervisor'
  | 'lifecycle'   // 仅 A 类短流程说明，非策略说教
  | 'memory'
  | 'compaction';

interface RecoveryBoundary {
  /** takeover 段仅 supervisor 可为 C 类；free 下受 CorrectionBudget 约束 */
  mayInjectCorrection(source: CorrectionSource, phase: SupervisorPhase): boolean;
}
```

实现建议在 debug 构建中对违规 `msgs.push` **assert**；发布构建记 `EventTimeline` 违规事件。

## 核心 API（附录 A 全文）

```ts
interface RecoverySupervisor {
  /** 每轮工具后或 before reply 调用 */
  evaluate(ctx: SupervisorEvaluateContext): Promise<SupervisorDecision>;
  /** 进入 takeover：写 timeline、经 CorrectionPort 注入接管块、换图或强提示 */
  applyTakeover(ctx: TakeoverContext): Promise<void>;
  /** 稳定窗口通过后交还 */
  applyHandoff(ctx: HandoffContext): Promise<void>;
}

type SupervisorDecision =
  | { action: 'continue' }
  | { action: 'takeover'; reason: string; signals: DeviationSignal[] }
  | { action: 'handoff_pending' }
  | { action: 'handoff' }
  | { action: 'fail'; kind: 'checkpoint' | 'rollback' };
```

## 与 ModeController 分工

| 组件 | 职责 |
|------|------|
| `ModeController` | **`resolveGlobalPolicy()`（§3.2 · 唯一读 env）**；§17 参数；`supervisorPhase` 冷却 |
| `RecoverySupervisor` | 根据观测与阈值调用 `evaluate`；驱动 §10 / §19.2 / §12；**仅 submit `ModeSignal`** |

---

# 8.11 模式决策器（ModeDecisionEngine）

**实现规范。** 系统 **唯一** `executionMode` 切换入口（**I5**）。

## 职责

- 每轮 **Harness round 开始前**（§14.4）：收集各模块 `ModeSignal`，读取 `RuntimeExecutionState`
- 调用 `shouldEnterForcedMode` / `shouldExitForcedMode`（§2.8.5），应用 **mode lock**（§2.8.6）与 **forced min dwell**（§2.8.12 · **I10**）
- **`sortSignalsByPrecedence`**（§2.8.8）→ 写入 **`enteredBy` / telemetry**（§2.8.9）
- **`evaluate` fail-safe**（§2.8.10）：异常 → fallback **forced**
- 输出 `ModeDecision`；更新 `LoopState.executionMode`、`executionModeLockRemaining`
- 向 `GateContext` / 子系统注入 **mode constraints**；graph 失败时 **Degraded Execution**（§2.8.11 / §19.7）

## 不负责

- 不替代 `RecoverySupervisor` 的 `supervisorPhase` / takeover（监管层）
- 不解析用户自然语言；不调用 LLM 做模式分类
- 不直接 `msgs.push`（约束说明经 `CorrectionPort` 或 A 类 Lifecycle 短文案）

## 核心 API

```ts
interface ModeDecisionEngine {
  /** round 开始前调用；唯一可 mutate executionMode 的组件 */
  evaluate(ctx: ModeDecisionContext): ModeDecision;
  /** 各模块上报；append-only 本轮信号集 */
  submitSignal(source: ModeSignalSource, signal: ModeSignal, payload?: ModeSignalPayload): void;
}

type ModeSignalSource =
  | 'graph_executor'
  | 'recovery_supervisor'
  | 'checkpoint_engine'
  | 'step_gate'
  | 'branch_budget'
  | 'tool_gate'
  | 'stop_hook';

interface ModeDecisionContext {
  round: number;
  executionMode: ExecutionMode;
  executionModeLockRemaining: number;
  supervisorPhase: SupervisorPhase;
  supervisorMode: SupervisorMode;
  riskLevel: TaskRiskLevel;
  state: RuntimeExecutionState;
  signals: ModeSignal[];
}

type ModeDecision =
  | { action: 'keep'; mode: ExecutionMode }
  | { action: 'enter_forced'; reason: ModeSignal[]; lockRounds: number; enteredBy: ModeSignal[]; primaryReason: ModeSignal; failSafe?: boolean }
  | { action: 'exit_forced'; reason: string };

/** §2.8.8 */
function sortSignalsByPrecedence(signals: ModeSignal[]): ModeSignal[];

function formatForcedReasonHuman(enteredBy: ModeSignal[]): string;
// → "forced because checkpoint_resumed + pending_steps"
```

## 与 ModeController 分工

| 组件 | 职责 |
|------|------|
| `ModeController` | **`resolveGlobalPolicy()`（§3.2）**、§17 参数、`supervisorPhase` 冷却 |
| **`ModeDecisionEngine`** | **`executionMode` Free/Forced、mode lock、min dwell（I10）、Forced 能力开关** |
| `RecoverySupervisor` | takeover / handoff；forced 下可发 `recovery_pending` signal |

---

# 8.12 任务风险分类器（TaskRiskClassifier）

按 **§2.8.4** 对 `RuntimeExecutionState` 分级；**禁止关键词**。

```ts
interface RuntimeExecutionState {
  round: number;
  taskGraphActive: boolean;
  pendingStepCount: number;
  writeTargetsThisRound: number;
  plannedWriteTargets: number;
  accumulatedDiffLines: number;
  branchSwitchedThisRound: boolean;
  checkpointResumedThisSession: boolean;
  lastToolSuccess: boolean;
  recoveryPending: boolean;
  branchDebt: number;
  stableRounds: number;
  activeGraphHasImplementNode: boolean;
  readonlyToolNames: string[];
  plannedToolNames: string[];
  forcedEntryRound: number | null;
  forcedTaskBearingRoundsSinceEntry: number;
}

/** §2.8.12 · round 结束后由 Harness 调用 */
function recordTaskBearingRoundIfForced(state: LoopState, outcome: TaskBearingRoundOutcome): void;

interface TaskRiskClassifier {
  classify(state: RuntimeExecutionState): TaskRiskLevel;
}
```

**L0：** 计划工具 ⊆ 只读集且无 graph write 节点 → 永远 Free。  
**L2：** 满足 §2.8.5 任一条 → 分类为 L2（引擎应倾向 enter Forced）。  
**L1：** 其余；默认 Free，由 `tool_failure` 等 signal 升级。

---

# 9. 激活策略

只有全部满足才接管（**仅 `adaptive`**；`strict` 见 §16.2 首轮建图；参数见 §17）。

---

## 条件一

关键任务域。

---

## 条件二

风险超过阈值。

**阈值取值（§17）：**

| 模式 / 阶段 | 风险阈值 |
|-------------|----------|
| `adaptive` · 自由段 | 0.6 |
| `strict` | 0.5（条件二可忽略，首轮已建图） |
| `adaptive` · 接管段（`supervisorPhase=takeover`） | 不再重复评估风险（已接管） |

---

## 条件三

异常触发。

---

## 异常触发项

- 同工具失败 ≥ 2
- 连续无推进 ≥ 3
- 同文件循环 ≥ 4
- 目标漂移
- 范围膨胀
- 用户强制接管

---

# 10. 恢复主路径（反构图成功）

当 `RetrospectiveGraphBuilder` **成功**且 `SnapshotConfidence ≥ 0.65`、`RecoverySafetyChecker.ok` 时走本路径。**与 §19.2 降级旁路互斥**（失败时不要重复执行下列全流程）。

```text
观察（PassiveObserver）
↓
评估（RecoverySupervisor.evaluate → takeover）
↓
状态快照（WorkspaceStateExtractor → 写入 checkpoint）
↓
可信度判断（SnapshotConfidenceEvaluator）
↓
安全检查（RecoverySafetyChecker）
↓
构建恢复图（RetrospectiveGraphBuilder · 模板图）
↓
接管执行（GraphExecutor.replaceGraph + takeover phase）
```

---

# 11. 图驱动恢复

复用 V1 TaskGraph 栈（代码路径 `src/harness/task-graph*.ts`、`task-graph-review.ts`）：

---

## 原有组件（与代码一致）

- `GraphExecutor`
- `ContractValidator`
- `DeviationDetector`
- `EscalationManager`（文档旧称 EscalationPolicy）
- Fallback 分支机制：`switchToFallbackBranch` / `hasAvailableFallback`（非独立类名 BranchFallback）

---

## 新增编排

- **`RecoverySupervisor`** — 见 **§8.10**（含原「RecoveryBoundary」：接管期 inject 边界）

---

# 12. 安全交还机制

---

# 12.1 校准完成

不立即交还。

进入稳定窗口。

---

# 12.2 稳定窗口

观察轮数 **见 §17**（默认：`adaptive·接管段` 为 **3** 轮；`strict` 为 **2** 轮）。

---

## 条件

- 无新异常
- phase 正常推进
- alignment 正常

---

通过：

交还。

失败：

继续接管。

---

# 12.3 冷却期

交还后冷却轮数 **见 §17**（默认：`adaptive·接管段` **3** 轮；`strict` **2** 轮）。

防止频繁切换。

---

# 13. 失败处理

以下视为恢复失败：

---

- 预算超限
- 图死锁
- snapshot 无效
- 图恢复重复失败

---

## 处理方式

（细节见 **§19.2** 三级降级、**§19.5** rollback。）

---

### rollback

回滚分支 → **§19.5**（工具 + `confirm`）。

---

### user checkpoint

请求人工介入 → **§19.2 三级 · 人工**；`stopReason` 扩展为 `user_checkpoint`（附录 A）。

---

# 14. Harness 集成点

通过 **`RecoverySupervisor` 编排层** 接入 `src/harness/harness.ts`，避免在主循环内散落监管逻辑。建议新增 `src/harness/supervisor/` 包，Harness **仅**调用 bridge + 下文两端口。

## 14.0 执行端口（V1.3.1 必做）

> 从根落实 **I1 / I2**；`ToolGate` / `CorrectionPort` 落地前不得宣称「双模已落地」。

### CorrectionPort（纠偏写入口）

```ts
interface CorrectionBlock {
  kind: 'takeover' | 'recovery' | 'graph_hint' | 'shadow_diagnostic';
  content: string;
  /** 压缩时不可 snip（接管块等） */
  preserveOnCompaction?: boolean;
}

interface CorrectionPort {
  inject(block: CorrectionBlock, ctx: { phase: SupervisorPhase; source: CorrectionSource }): void;
}
```

- `RecoverySupervisor.applyTakeover` / 降级旁路 **唯一**调用 `CorrectionPort` 写 C 类内容。
- `GraphExecutor` **禁止**直接 `msgs.push`；产出 hint 后由 `Supervisor.composeGraphHint()` 转发。

### ToolGate（工具执行前唯一裁决）

```ts
type ToolGateAction = 'execute' | 'skip' | 'confirm';

interface ToolGateEntry {
  toolCallId: string;
  action: ToolGateAction;
  /** skip 时写入 tool result 或 user 说明，禁止静默丢弃 */
  message?: string;
}

interface ToolGatePlan {
  entries: ToolGateEntry[];
}

interface ToolGate {
  decide(calls: ToolCall[], ctx: GateContext): ToolGatePlan;
}

interface GateContext {
  phase: SupervisorPhase;
  mode: SupervisorMode;
  graphHints: Array<{ toolName: string; action: 'allow' | 'warn' | 'block'; message?: string }>;
}
```

**Harness 约束（冻结）：**

```text
禁止：checkToolCall → msgs.push → executeToolCallsStreaming(全部 calls)
必须：toolGate.decide → 仅 execute  plan 中标记为 execute 的调用
      skip 的调用须有 tool result（或等价 user 说明），模型可见
```

`GraphExecutor.checkToolCall` 仅向 `GateContext.graphHints` 贡献裁决输入，**不**写 `msgs`。

### 主循环形状（示意）

```text
while running:
  LifecycleGate.checkContinue()              // A
  prep = prepareHarnessRound(...)          // 现有
  modeDecision = modeDecisionEngine.evaluate(...)  // §14.4 · I5
  applyExecutionModeConstraints(modeDecision)      // step gate / branch budget 开关
  LLM(...)                                   // callHarnessLlm
  if toolCalls:
    plan = toolGate.decide(..., executionMode)     // I2 · Forced 下 graphHints 生效
    execute(plan.entries where execute)
    modules.submitSignal(...)                // 仅 signal，不改 mode
    passiveObserver.observe(...)             // B
    await recoverySupervisor.evaluate(...)
    recordTaskBearingRoundIfForced(state, roundOutcome)  // §2.8.12 · I10
  else:
    await recoverySupervisor.evaluateBeforeReply(...)
```

**禁止**在工具分支内散落 `if (repeatedFailures) msgs.push(...)` — 逻辑迁入 `PassiveObserver`，由 `evaluate` 触发 `takeover`。

## 14.1 钩子位置

| 钩子 | 插入时机（约） | 职责 |
|------|----------------|------|
| **before LLM（round）** | **`prepareHarnessRound` 之后、`callHarnessLlm` 之前** | **`ModeDecisionEngine.evaluate`**（§14.4） |
| before tool call | 工具执行前 | `ToolGate.decide`（`executionMode=forced` 时启用 graph 合约） |
| after tool call | 工具执行后 | `PassiveObserver.observe`；各模块 `submitSignal` |
| after round | 工具轮结束 | `RecoverySupervisor.evaluate`；`recordTaskBearingRoundIfForced`（**§2.8.12 · I10**）；`evaluateRound` 仅 metrics（§19.4） |
| before reply | 无 tool、即将结束 | 稳定窗口 / 交还；阻止过早 `model_done` |

## 14.2 `LoopState` 扩展字段（建议）

- `executionMode`: `free` \| `forced`（**§2.8**；**仅 `ModeDecisionEngine` 可写**）
- `executionModeLockRemaining`: number（**§2.8.6** enter 后锁定剩余轮数）
- `forcedEntryRound`: number \| null（**§2.8.12** 最近 free→forced 的 round）
- `forcedTaskBearingRoundsSinceEntry`: number（**§2.8.12 · I10** 有效任务轮计数）
- `forcedMinDwellSatisfied`: boolean（冗余：`>= forcedMinDwellRounds`）
- `executionModeEnteredBy`: `ModeSignal[]`（**§2.8.9**；最近一次 free→forced，按优先级排序）
- `executionModeEnteredByPrimary`: `ModeSignal`（`enteredBy[0]`）
- `executionModeEnteredAtRound`: `number`
- `forcedDegradedTier`: `'graph' \| 'step_queue' \| 'write_intent'`（**§2.8.11**；forced 下当前退化层）
- `lastModeDecision`: `ModeDecision`（可观测 / checkpoint）
- `pendingModeSignals`: `ModeSignal[]`（本轮收集，evaluate 后清空）
- `supervisorPhase`: `free` \| `takeover` \| `handoff_pending` \| `cooldown`
- `recoveryBudget`: `RecoveryBudgetManager`
- `stabilityWindow`: `StabilityWindowState`
- `eventTimeline`: `EventTimeline`
- `lastWorkspaceSnapshotRef`: **仅保存摘要**（路径、hash、关键字段）；**全量** `WorkspaceSnapshot` 写入 checkpoint / `CheckpointEngine`，**不常驻**完整对象于内存（避免 LoopState 膨胀）
- `alignmentHistory`: 最近 N 轮 V1 启发式 alignment 分数（GoalDrift）

## 14.3 持久化

- `RuntimeCheckpointV2` 扩展 `supervisorState`、`eventTimeline` 片段
- **`executionMode` / lock / dwell / `enteredBy` / `forcedDegradedTier` 须可恢复**（checkpoint resume 时 `CheckpointEngine` 提交 `checkpoint_resumed` signal）
- 可选：`data/runtime/supervisor-events.jsonl`（与记忆遥测并列）

## 14.4 ModeDecisionEngine Harness 接入（冻结）

**插入点（与当前代码对齐）：** `src/harness/harness.ts` 主循环内，`prepareHarnessRound` **之后**、`callHarnessLlm` **之前**（约 L285–L295）。

### 流程

```text
prepareHarnessRound
        ↓
collectModeSignals(state)     // 汇总 pendingModeSignals + RuntimeExecutionState
        ↓
TaskRiskClassifier.classify(state)
        ↓
ModeDecisionEngine.evaluate(ctx)
        ↓
emitExecutionModeTelemetry(decision)   // §2.8.9 · enteredBy / primaryReasonHuman
        ↓
applyExecutionModeConstraints(decision)
        ↓
callHarnessLlm
```

### 参考 patch（规格级 · 可直接实施）

```ts
// harness.ts — after prep, before callHarnessLlm
const prep = await prepareHarnessRound(deps, { ... });
if (prep.action === 'stop') return prep.result;

const modeCtx = buildModeDecisionContext(state, prep.round);
const modeDecision = deps.modeDecisionEngine.evaluate(modeCtx);
applyExecutionModeConstraints(state, modeDecision, deps);
emitExecutionModeTelemetry(deps, state, modeDecision); // → telemetry.jsonl / onStep

const llm = await callHarnessLlm(deps, {
  state,
  normalizedMsgs: prep.normalizedMsgs,
  ...
});
```

```ts
// execution-mode-constraints.ts（新文件 · supervisor/）
export function applyExecutionModeConstraints(
  state: LoopState,
  decision: ModeDecision,
  deps: HarnessDeps,
): void {
  const forced = state.executionMode === 'forced';
  deps.graphExecutor.setStepGateEnabled(forced);
  deps.branchBudget.setEnabled(forced);
  // CheckpointEngine：Forced 下写前检查点策略 ON
  deps.checkpointEngine.setForcedCheckpointPolicy(forced);
  // 约束注入：仅 A 类短说明或 CorrectionPort；禁止散落 msgs.push
}
```

**兼容：** `ICE_SUPERVISOR_MODE=off` 时 `ModeDecisionEngine` 可短路为 always-`free`（不启用 Forced 能力），行为等同今日 Harness。

**验收：** 见 **附录 B**「Execution Mode 子集」；**附录 C** 迁移步骤。

---

# 15. 配置项

> **实现要求：** 凡本节约定的环境变量与 `supervisor-config.json` 字段，在 `src/types/supervisor.ts`、`ModeController` 及配置加载处 **必须配有完整 JSDoc / 行内注释**。**环境变量语义以 §3.2 Global Mode Policy 为准**：env **只**控制自动决策开关与全局能力包；阈值与局部判断在 JSON + 运行态（**I6**）。

## 15.0 加载顺序与文件路径

| 优先级（高 → 低） | 来源 | 作用域 |
|-------------------|------|--------|
| 1 | 环境变量 `ICE_SUPERVISOR_*` | **Global only**（§3.2）；解析为 `GlobalModePolicy` |
| 2 | `ICE_SUPERVISOR_CONFIG_PATH` 指向的 JSON | Global `mode`/`shadow` + **Local 阈值** |
| 3 | 默认文件 | `{ICE_DATA_DIR}/supervisor-config.json` |
| 4 | 内置默认值 | §17 / §15 各表「默认」列 |

**热加载（可选）：** 变更 env / JSON 后 **重新** `resolveGlobalPolicy()`；**不得**在中途用新 env 值重判历史 round 的局部状态（除非显式 reset 任务）。

**遗留：** `ICE_TASK_GRAPH` 落地后 **不再读取**（**I6**：建图由运行态 + §17 决定，非独立 env）。

---

## 15.1 环境变量（完整注释）

| 变量名 | 类型 | 默认值 | 合法值 | 说明 |
|--------|------|--------|--------|------|
| **`ICE_SUPERVISOR_MODE`** | string | `adaptive` | `off` \| `adaptive` \| `strict` | **Global：是否启用自动决策 + 能力包（§3.2）。** `off`：`autoDecisionEnabled=false`，纯 Harness。`adaptive`：启用 Observer + ModeDecisionEngine + RecoverySupervisor；局部 Free/Forced 由运行态决定。`strict`：同上 + `executionModeFloor=forced` + strict 参数包（§17）；**仍不由 env 直接写每轮 state**。**禁止**业务模块读取本变量做局部判断（**I6**）。 |
| **`ICE_SUPERVISOR_SHADOW`** | boolean | `0`（关） | `1` / `true` / `0` / `false` | **Global：** 须 `MODE≠off`。决策链运行但 **禁止** 真实改 `supervisorPhase`；用于 benchmark（[`运行时后续优化.md`](./运行时后续优化.md)）。 |
| **`ICE_SUPERVISOR_CONFIG_PATH`** | path | （空） | 绝对或相对路径 | **Global 路径 + Local 阈值文件入口。** 指向 JSON；不携带 per-task 语义。 |
| **`ICE_TASK_GRAPH`** | string | — | 任意 | **已废弃（规划）。** Supervisor 落地后忽略；保留仅为旧脚本兼容，文档与代码须打 `@deprecated`。 |

**关联（非 Supervisor 专有，但评测常用）：**

| 变量名 | 说明 |
|--------|------|
| `ICE_EVAL_MODE=1` | 评测路径；常与 `ICE_SUPERVISOR_MODE=off` 或 `ICE_SUPERVISOR_SHADOW=1` 组合，避免改变生产对话行为。 |
| `ICE_DATA_DIR` | 决定默认 `supervisor-config.json` 与 `supervisor-events.jsonl` 落盘根目录。 |

**已移除（勿实现）：** `ICE_SUPERVISOR_MODE=supervised`。更早接管、更短恢复预算等请改 JSON 中 `params.adaptiveFree.riskThreshold` 等，或加载 §15.8 预设。

### 15.1.1 `ICE_SUPERVISOR_MODE` 取值摘要

| 值 | 产品名 | 行为摘要 |
|---|---|---|
| `off` | 自由 | 关闭 Supervisor；等同今日纯 Harness |
| `adaptive` | 自适应（**默认**） | `supervisorPhase=free` 直至 §9 三条件满足 → `takeover` |
| `strict` | 严格 | 关键域 **首轮即建图**，全程图驱动 |

---

## 15.2 `supervisor-config.json` 顶层结构

实现时 TypeScript 形状见 **附录 A** `SupervisorConfigFile`。下表为 JSON 键与注释（**实现须在 schema / 加载器中为每个键写注释**）。

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `mode` | string | 同 `ICE_SUPERVISOR_MODE` 或 `adaptive` | **Global：** 与 env 合并为 `GlobalModePolicy`；不参与 per-round 判断。 |
| `shadow` | boolean | `false` | 影子模式；可被 `ICE_SUPERVISOR_SHADOW` 覆盖。 |
| `params` | object | 见 §15.3 | §17 三列参数：`strict`、`adaptiveFree`、`adaptiveTakeover`。 |
| `triggers` | object | 见 §15.4 | §9 条件三：异常触发阈值（接管候选）。 |
| `goalDrift` | object | 见 §15.5 | §8.3 / §19.1 目标漂移 V1/V2。 |
| `snapshotConfidence` | object | 见 §15.5 | §8.5 快照可信度；模板图门槛 0.65。 |
| `correctionBudget` | object | 见 §15.5 | §2.6 **I4**：free 段 C 类 inject 次数上限。 |
| `riskEvaluator` | object | 见 §15.5 | §6 风险因子权重（可选；未配置则用内置启发式）。 |
| `eventTimeline` | object | 见 §15.5 | 事件时间线落盘（可选）。 |
| `executionMode` | object | 见 §15.5 | **§2.8** Free/Forced 阈值与 mode lock。 |

---

## 15.3 `params` — 模式参数（对应 §17）

`params.strict` / `params.adaptiveTakeover` 使用完整 **`ModeParams`**；`params.adaptiveFree` 仅含自由段所需字段。

| JSON 键（`ModeParams`） | 类型 | strict 默认 | adaptive·自由 | adaptive·接管 | 说明 |
|-------------------------|------|-------------|---------------|---------------|------|
| `firstRoundGraph` | boolean | `true` | `false` | `false` | 关键域是否在 **第 1 轮** 调用 `initGraph`。`strict` 为 `true`；`adaptive` 自由段必须为 `false`（**I3**）；接管后建图走 `replaceGraph`。 |
| `riskThreshold` | number 0~1 | `0.5` | `0.6` | — | 风险分 ≥ 此值且满足域+异常 → 进入接管候选。接管后不再用此阈评估。`strict` 下条件二可忽略（已首轮建图）。 |
| `maxRecoveryRounds` | integer ≥1 | `5` | — | `3` | 单次 takeover 内最多恢复轮数；耗尽 → §19.2 三级或 `user_checkpoint`。 |
| `recoveryTokenRatio` | number 0~1 | `0.30` | — | `0.25` | 恢复阶段允许消耗的 token 占任务总预算比例上限。 |
| `maxRecoveryRetries` | integer ≥0 | `2` | — | `2` | 同一路径/工具链上恢复重试次数上限（§8.8，与轮数并列计数）。 |
| `stabilityWindowRounds` | integer ≥1 | `2` | — | `3` | handoff 前须连续满足的「稳定」观察轮数（§12.2：无新异常、phase 推进、alignment 正常）。 |
| `handoffCooldownRounds` | integer ≥0 | `2` | — | `3` | 交还模型后禁止再次 takeover 的冷却轮数（§12.3）。 |
| `evaluateRoundMode` | string | `full` | `none` | `metrics_only` | `GraphExecutor.evaluateRound` 是否向 msgs 注入。`none`/`metrics_only` 落实 **I1**；strict 内部可 full，hint 须经 CorrectionPort。 |
| `checkToolCall` | boolean | `true` | `false` | `true` | 是否启用图合约检查并送入 **ToolGate**；free 段无图时为 `false`。 |

---

## 15.4 `triggers` — 异常触发（§9 条件三）

任一达到阈值且已满足「关键域 + 风险阈」时，产生 `DeviationSignal` 并可走 takeover。

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `toolRepeatFailMin` | integer | `2` | 同一工具（或同签名调用）连续失败 ≥ N 次 → `tool_repeat_fail`。 |
| `noProgressRoundsMin` | integer | `3` | `TaskState.phase` 或图节点连续 N 轮无推进 → `no_progress`。 |
| `fileLoopMin` | integer | `4` | 同一文件路径读/写循环 ≥ N 次 → `file_loop`。 |
| `goalDriftEnabled` | boolean | `true` | 是否启用目标漂移信号（细则见 `goalDrift`）。 |
| `scopeCreepEnabled` | boolean | `true` | 是否检测范围膨胀（修改/读取文件集远超 goal 隐含范围）→ `scope_creep`。 |
| `userForceTakeoverEnabled` | boolean | `true` | 是否响应用户显式「接管/按计划执行」类指令 → `user_force_takeover`。 |

---

## 15.5 其它 JSON 分组

### `goalDrift`（§8.3 / §19.1）

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `alignmentThreshold` | number | `0.45` | V1 对齐分 **低于** 此值视为漂移。 |
| `consecutiveRoundsBelow` | integer | `2` | 连续 N 轮低于 `alignmentThreshold` 才触发 `goal_drift` 信号。 |
| `llmGrayZoneLow` | number | `0.35` | V2 side call：分数 ∈ [low, high] 且已在关键域候选时调用 LLM 复核。 |
| `llmGrayZoneHigh` | number | `0.55` | 见上。 |
| `jaccardMinGoalOverlap` | number | （实现定义） | 用户 goal 与最近 assistant 输出的 bigram Jaccard 下限，低于则加分漂移。 |

### `snapshotConfidence`（§8.5）

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `templateGraphMin` | number | `0.65` | 低于此值 **禁止** §19.2 一级模板图；可走二级强提示。 |
| `weightGitClean` | number | （实现定义） | Git 工作区干净程度权重。 |
| `weightSnapshotAge` | number | （实现定义） | 快照越新越高；轮次越久越低。 |
| `weightVerifyPassed` | number | （实现定义） | 近期 test/lint 通过加分。 |
| `weightRepoContextMatch` | number | （实现定义） | 与 `RepoContext` 文件列表一致加分。 |
| `weightBuildSignal` | number | （实现定义） | 最近构建/命令无连续失败加分。 |

### `correctionBudget`（§2.6 I4）

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `freeSegmentMaxPerTask` | integer | `1` | `supervisorPhase=free` 时，经 `CorrectionPort` 的 C 类策略块（如 `no_tool_execution_recovery`）每任务最多几次；超出只累积 Observer 信号。 |
| `shadowDiagnosticMaxPerRound` | integer | `1` | shadow 模式下可选诊断块每轮上限。 |

### `riskEvaluator`（§6，可选）

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `weightFilesChanged` | number | （内置） | 修改文件数越多风险越高。 |
| `weightDependencyDepth` | number | （内置） | 依赖链深度。 |
| `weightModuleBlastRadius` | number | （内置） | 模块影响范围。 |
| `weightIrreversibleOps` | number | （内置） | 删除/迁移等不可逆操作。 |
| `weightCompileImpact` | number | （内置） | 编译/构建影响面。 |
| `weightRecentFailures` | number | （内置） | 历史失败次数（Harness 信号）。 |

### `eventTimeline`（§8.9 / §14.3）

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `enabled` | boolean | `true` | 是否写入时间线。 |
| `persistPath` | string | `data/runtime/supervisor-events.jsonl` | JSONL 路径；相对 `ICE_DATA_DIR` 或绝对路径。 |
| `maxEventsInCheckpoint` | integer | （实现定义） | 写入 `RuntimeCheckpointV2` 的最近事件条数上限。 |

### `executionMode`（§2.8 / §8.11）

| JSON 键 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `enabled` | boolean | `true` | `ICE_SUPERVISOR_MODE=off` 时可 false（始终 Execution Free）。 |
| `pendingStepsEnterThreshold` | integer | `2` | §2.8.5 #2：`pending_steps` 进入 Forced。 |
| `writeTargetsEnterThreshold` | integer | `1` | 超过此写目标数 → `multi_write`。 |
| `diffLinesEnterThreshold` | integer | `200` | `large_diff` 行数阈（累计 workspace diff）。 |
| `stableRoundsExitThreshold` | integer | `2` | §2.8.5 退出 Forced 所需稳定轮数。 |
| `modeLockRounds` | integer | `2` | §2.8.6 enter 后锁定轮数（时间防抖） |
| `forcedMinDwellRounds` | integer | `1` | **§2.8.12 · I10** 进入 forced 后至少完成的 task-bearing round 数，才允许 exit |
| `readonlyToolNames` | string[] | `read_file,grep,search,...` | L0 只读工具集（**工具名**，非用户关键词）。 |

---

## 15.6 带注释的配置示例（`supervisor-config.json`）

实现可提供 `data/supervisor-config.example.json`；内容须与本节一致。以下为 **JSONC** 示意（仓库内示例文件可用纯 JSON，注释写在相邻 `_comment` 键或本 spec）。

```jsonc
{
  // 运行模式：off | adaptive | strict；可被 ICE_SUPERVISOR_MODE 覆盖
  "mode": "adaptive",
  // 影子评测：true 时不改 supervisorPhase，只记 timeline
  "shadow": false,

  "params": {
    "strict": {
      "firstRoundGraph": true,
      "riskThreshold": 0.5,
      "maxRecoveryRounds": 5,
      "recoveryTokenRatio": 0.3,
      "maxRecoveryRetries": 2,
      "stabilityWindowRounds": 2,
      "handoffCooldownRounds": 2,
      "evaluateRoundMode": "full",
      "checkToolCall": true
    },
    "adaptiveFree": {
      "firstRoundGraph": false,
      "riskThreshold": 0.6
    },
    "adaptiveTakeover": {
      "firstRoundGraph": false,
      "riskThreshold": 0.6,
      "maxRecoveryRounds": 3,
      "recoveryTokenRatio": 0.25,
      "maxRecoveryRetries": 2,
      "stabilityWindowRounds": 3,
      "handoffCooldownRounds": 3,
      "evaluateRoundMode": "metrics_only",
      "checkToolCall": true
    }
  },

  "triggers": {
    "toolRepeatFailMin": 2,
    "noProgressRoundsMin": 3,
    "fileLoopMin": 4,
    "goalDriftEnabled": true,
    "scopeCreepEnabled": true,
    "userForceTakeoverEnabled": true
  },

  "goalDrift": {
    "alignmentThreshold": 0.45,
    "consecutiveRoundsBelow": 2,
    "llmGrayZoneLow": 0.35,
    "llmGrayZoneHigh": 0.55
  },

  "snapshotConfidence": {
    "templateGraphMin": 0.65
  },

  "correctionBudget": {
    "freeSegmentMaxPerTask": 1
  },

  "eventTimeline": {
    "enabled": true,
    "persistPath": "data/runtime/supervisor-events.jsonl"
  },

  "executionMode": {
    "enabled": true,
    "pendingStepsEnterThreshold": 2,
    "writeTargetsEnterThreshold": 1,
    "diffLinesEnterThreshold": 200,
    "stableRoundsExitThreshold": 2,
    "modeLockRounds": 2,
    "forcedMinDwellRounds": 1,
    "readonlyToolNames": ["read_file", "grep", "search", "list_dir"]
  }
}
```

---

## 15.7 推荐预设（非 `ICE_SUPERVISOR_MODE` 第四档）

通过 **`ICE_SUPERVISOR_CONFIG_PATH`** 或合并 `presets` 加载；**不新增**环境变量模式值。

| 预设名 | 用途 | 相对默认的调整 |
|--------|------|----------------|
| `aggressive-adaptive` | 更早接管、更短恢复（替代已删 supervised 模式） | `adaptiveFree.riskThreshold=0.4`；`adaptiveTakeover` 与 §17 接管段默认相同 |
| `lenient-adaptive` | 更少打扰 | `adaptiveFree.riskThreshold=0.7`；`triggers.*Min` 各 +1 |
| `strict-ci` | CI 自动修复 | `mode=strict`；`eventTimeline.enabled=true` |

实现可选：`data/supervisor-config.presets.json` 存上述片段，CLI `iceCoder supervisor --preset aggressive-adaptive` 合并后写回或仅内存生效。

---

## 15.8 Shadow 与 A/B

**前置：** `ICE_SUPERVISOR_MODE` 不得为 `off`。评测建议 `ICE_EVAL_MODE=1` + `off` 或 `shadow=1` + `adaptive`。

| 行为 | `shadow: true` | `shadow: false` |
|------|----------------|-----------------|
| `PassiveObserver` / `RiskEvaluator` | 正常运行 | 正常运行 |
| `RecoverySupervisor.evaluate` | **完整执行** | 完整执行 |
| `supervisorPhase` / 真实接管 | **禁止**改 phase | 按 decision 执行 |
| `EventTimeline` | **必须**含「本会接管」 | 正常写入 |
| 向 `msgs` inject | 仅可选 `shadow_diagnostic` | §16.1 / §19.6 |

---

# 16. 实现决议（冻结 baseline）

以下决议为编码前基线；变更需更新本节并注明版本。

| 决策 | 决议 | 理由 |
|------|------|------|
| 接管时是否清空对话？ | **保留历史 + 注入接管块** | 纠正不是重启；`TaskState` / `RepoContext` / checkpoint 依赖连续上下文 |
| strict vs adaptive | **同架构、不同参数** | 复用 `GraphExecutor` + `RecoverySupervisor`；仅阈值与「何时建图」不同 |
| GoalDrift | **V1 启发式 → V2 LLM** | 零成本覆盖大部分偏离；V2 仅灰区再调 LLM |
| 反构图失败降级 | **三级：模板图 → 强提示 → 人工** | 任何情况有明确兜底 |
| 评估去重 | **接管后 `evaluateRound` 仅记录 metrics** | Supervisor 链为唯一纠偏出口，避免双份 `inject_hint` |
| 纠偏与门禁 | **`CorrectionPort` + `ToolGate`（§14.0）** | 落实 I1/I2；Graph 不写 msgs；block = 不执行 |
| free 段 Harness 策略 inject | **迁入 Observer 或 CorrectionBudget≤1** | 避免 free 段规则散（§19.6） |
| rollback | **经工具调用 + `confirm` 权限** | 统一权限门禁，保护用户数据 |

### 16.1 接管块格式

使用固定结构化块（建议 fence 语言标签 `icecoder-supervisor-takeover`），**压缩时不可 snip**：

- 用户 `goal`
- 触发原因（异常信号摘要）
- `WorkspaceSnapshotRef` 摘要（非全量快照，见 §14.2）
- 当前 `supervisorPhase`、恢复图首节点 ID（若有）

### 16.2 strict 与 adaptive 的产品语义

| | strict | adaptive |
|---|--------|----------|
| 用户感知 | 全程有任务图路线 | 平时像 Copilot，卡住时系统接管（`takeover`） |
| 建图时机 | 关键域 **第 1 轮** `initGraph` | 自由段无图；**异常触发后** `replaceGraph` / 模板图 |
| 引擎 | 同一套 `GraphExecutor` + `RecoverySupervisor` | 同左 |

---

# 17. 模式参数矩阵

`strict` 与 `adaptive` **共用同一实现**；下表为三列默认参数（JSON 键与注释见 **§15.3**；类型见 **附录 A** `SupervisorConfigFile`）。

> **`adaptive·接管段`**：`ICE_SUPERVISOR_MODE=adaptive` 且 `supervisorPhase=takeover` 时使用本列。自由段参数勿用于接管后。

| 参数 | strict | adaptive·自由段 | **adaptive·接管段** |
|------|--------|-----------------|---------------------|
| 首轮是否建图（关键域） | 是 | 否 | 否（接管时 `replaceGraph`） |
| 风险阈值（进入接管候选） | 0.5 | 0.6 | —（已接管，不重复评估） |
| 最大恢复轮数 | 5 | — | **3** |
| 恢复 token 占总预算 | 30% | — | **25%** |
| 恢复重试次数（同路径） | 2 | — | **2** |
| 稳定窗口观察轮数 | 2 | — | **3** |
| handoff 后冷却轮数 | 2 | — | **3** |
| `evaluateRound` 注入纠偏 | 全程 `full` | 无图 / 仅记录 | **`metrics_only`** |
| `checkToolCall` | 全程 block/warn | 无图时不检查 | **block/warn** |

---

# 18. Supervisor 运行时状态机

```text
                    ┌─────────────┐
         启动 ──────►│    free     │◄────────────────┐
                    └──────┬──────┘                 │
                           │ §9 三条件满足            │ handoff 通过
                           ▼                         │ + 冷却结束
                    ┌─────────────┐                 │
                    │  takeover   │─────────────────┤
                    └──────┬──────┘                 │
                           │ 校准完成               │
                           ▼                         │
                    ┌─────────────┐    失败         │
                    │handoff_pending├──────────────►│ cooldown
                    └──────┬──────┘                 │
                           │ 稳定窗口 OK（轮数见 §17）│
                           └────────────────────────┘

失败出口：RecoveryBudget 耗尽 / safety 失败 → §19.2 三级 · 人工 或 §19.5 rollback
```

| 阶段 | 含义 |
|------|------|
| `free` | 模型主导；`PassiveObserver` 仅观测（或 shadow 只记日志） |
| `takeover` | 图驱动或 Supervisor 强提示主导；`evaluateRound` 不 inject |
| `handoff_pending` | 稳定窗口计数中，尚未交还 |
| `cooldown` | 交还后 N 轮内禁止再次接管 |

### 18.1 Execution Mode 状态机（Free / Forced）

与 §18 `supervisorPhase` **正交**；由 **`ModeDecisionEngine`** 驱动。

```text
                    ┌─────────────┐
         启动 ──────►│  exec_free  │◄────────────────────┐
                    └──────┬──────┘                      │
                           │ shouldEnterForcedMode        │
                           │ (§2.8.5 任一)                 │
                           ▼                              │
                    ┌─────────────┐   mode lock > 0       │
                    │ exec_forced │───────────────────────┤
                    └──────┬──────┘   lock>0 或 dwell 未满 │
                           │ lock=0 且 dwell≥min            │
                           │ 且 shouldExitForced (§2.8.5)     │
                           └──────────────────────────────┘

supervisorPhase=takeover  ──► 强制 exec_forced（不可 exit 至 free，直至 handoff 后另判）
ICE_SUPERVISOR_MODE=strict ──► 全程 exec_forced
```

| 迁移 | 条件 |
|------|------|
| free → forced | §2.8.5 任一 + `TaskRiskClassifier` L2（或 L1 升级 signal） |
| forced → free | §2.8.5 全部 + **lock=0** + **I10 dwell≥min** |
| 强制保持 forced | `supervisorPhase=takeover` 或 `strict` |

---

# 19. 关键机制细化

## 19.1 GoalDrift（V1 启发式）

> **边界：** 本节信号供 **`PassiveObserver` / Supervisor 接管候选** 使用；**不得**直接切换 `executionMode`（**I5**）。用户 goal 关键词 **禁止**作为 Forced 触发源。

V1 作为 `PassiveObserver` 上的合成信号，**不单独再开一套检测**，与现有 Harness 信号合并：

- 目标关键词 vs 本轮工具类型（长期只读/搜索 → 漂移）
- `filesChanged` 为空但 phase 已进入 editing
- 用户 goal 与最近 assistant 内容的 bigram Jaccard（可复用任务切换 Jaccard）
- 连续 N 轮 `TaskState.phase` 无推进

**V2 LLM：** 仅当 V1 分数处于灰区（建议 0.35–0.55）且已在监管候选域时触发 side call。

默认阈值：alignment **< 0.45** 连续 **2** 轮（V1 启发式分数；V2 见 §8.3）。

## 19.2 反构图失败：降级旁路（与 §10 区分）

**不重复执行 §10 全流程。** 仅在「需要接管但模板图不可信/构建失败」时进入。

```text
§10 恢复主路径（builder 成功）
        │
        ├─ 成功 → takeover 执行
        │
        └─ 失败 ↓
§19.2 三级降级
   1 模板图（重试 builder / 降置信要求）
   2 强提示（无图，Supervisor 单条 inject）
   3 人工（user_checkpoint）
```

| 级 | 条件 | 行为 |
|----|------|------|
| **1 模板图** | `SnapshotConfidence ≥ 0.65` 且 `RecoverySafetyChecker.ok` | `RetrospectiveGraphBuilder` 按 intent 模板建图，标记已完成节点 |
| **2 强提示** | 1 失败或预算内重试 | 不建图 / `markGraphPaused`；**`executionMode` 保持 forced**；`forcedDegradedTier` → `step_queue` 或 `write_intent`（§2.8.11）；**仅** `RecoverySupervisor` 注入 `[System Recovery]`；**禁止**因 graph 失败切回 free |
| **3 人工** | 2 仍失败或预算耗尽 | `stopReason: user_checkpoint`；`EventTimeline` 记 `failure`；UI 提示 |

### 模板图最小集（V1）

| intent | 来源 | 已完成节点判定 |
|--------|------|----------------|
| `debug` / `edit` / `test` / `refactor` | 复用 `buildGraph(goal, intent)`（`task-graph-builder.ts`） | `TaskState.filesChanged` 非空 → 对应 inspect 标 `done`；`verificationStatus=passed` → verify 标 `done` |
| fallback | 现有 `fallbackBranches` 机制 | 与 TaskGraph V1 一致 |

不在 V1 做全 LLM 重规划；仅允许 LLM 生成剩余步骤**标题**（可选，受 `RecoveryBudget` 约束）。

## 19.3 `GraphExecutor` 扩展（接管必备）

- `loadGraph` / `replaceGraph`：中途换图（takeover / 恢复）
- `setEvaluationMode('full' | 'metrics_only')`：接管后纠偏去重（§16 表）
- `enterTakeover` / `exitTakeover`：与 `supervisorPhase` 同步

## 19.4 评估去重与 Graph 输出边界

**GraphExecutor 永不直接向 `msgs` 写入纠偏内容（I1）。**

| 阶段 / 模式 | `evaluateRound` | `checkToolCall` | 面向模型的文案 |
|-------------|-----------------|-----------------|----------------|
| `off` | 今日行为 | 今日行为 | 分散在各模块（迁移前） |
| `adaptive` · free | **不调用** 或 metrics_only | **不检查**（无图） | 仅 A 类 + CorrectionBudget 内 C |
| `adaptive` · takeover | **metrics_only** | 产出 hint → **ToolGate** | **CorrectionPort** ← Supervisor |
| `strict` | metrics 或 internal full | → **ToolGate** 全程 | **CorrectionPort** ← Supervisor 转发 graph_hint |

- **`checkToolCall`：** 仅在 **`executionMode=forced`**（或 `supervisorPhase=takeover` / `strict`）时生效；返回结构供 `ToolGate` 消费。
- **strict 模式：** Graph 内部可 `full` 评估，但 hint **必须** `Supervisor.composeGraphHint()` → `CorrectionPort.inject`，不得绕过。

## 19.5 rollback

- 仅通过 **builtin 工具**（如 `run_command` / 专用 `rollback_workspace`）执行。
- 走 Harness **`confirm`** 权限；文案须包含将执行的命令与影响文件列表（来自 snapshot）。
- 用户拒绝 confirm → 进入 **三级降级 · 人工**，不静默失败。
- rollback 失败计入 `RecoveryBudgetManager`。

## 19.6 全相位互斥表（Resilience / Harness / Graph）

> **C 类纠偏**（§2.7）写 `msgs` 须过 `RecoveryBoundary.mayInjectCorrection` + `CorrectionPort`。  
> 本表为 **I1** 落地检查清单；`takeover` 列最严，`free` 列禁止策略说教堆叠。

| 信号源 | `off` | `free`（adaptive 自由段） | `takeover` | `strict` |
|--------|-------|---------------------------|------------|----------|
| `consecutiveToolFailures` 长文案 inject | 今日 | **关闭** → 仅 `Observer.addSignal` | **关闭** | **关闭** |
| `resilienceMaybeBranchRecover` inject | 今日 | **关闭**（budget 仍计数） | **关闭** | **关闭** |
| `resilienceMaybeReviewStep` inject | 今日 | **关闭**（结果进 timeline） | **关闭** | timeline only |
| `consecutiveReadOnlyRounds` 提示 | 今日 | **关闭** 或合并为 Observer 一条 | **关闭** | Observer |
| `no_tool_execution_recovery` | 今日 | **CorrectionBudget ≤1** 或迁 Observer | **关闭** | **关闭** |
| `formatToolPlan` / Tool Planner inject | 今日 | takeover 后或 strict 首轮；free 默认 **关闭** | Supervisor 块内 | 允许（经 CorrectionPort） |
| `GraphExecutor.evaluateRound` → msgs | 今日 | **禁止**（metrics only） | **禁止** | 经 Supervisor 转发 |
| `GraphExecutor.checkToolCall` | 今日 | **executionMode=free 时不检查** | → ToolGate | → ToolGate 全程 |
| **`LoopState.executionMode` 写入** | 任意模块 | **禁止（I5）** | **仅 ModeDecisionEngine** | 同左 |
| `RecoverySupervisor` / CorrectionPort | 无 | 无 C（除 Budget 内） | **唯一 C 源** | 编排 Graph + C |
| `Verification Gate` / 熔断 | 今日 | **A 类允许** | **A 类允许** | **A 类允许** |

**shadow 模式：** 与 `free` 相同，但可写可选 `shadow_diagnostic`（`CorrectionPort`，不计入 Budget）。

## 19.7 Forced Mode Degraded Execution（规格细化）

> 总则见 **§2.8.11**。本节与 §19.2 **共用**降级出口，但 **强制** execution 边界不回落 Free。

### 19.7.1 触发

- `RetrospectiveGraphBuilder.build()` 失败 / 超时
- `GraphExecutor.replaceGraph` 拒绝（合约 / 置信度）
- `SnapshotConfidence < templateGraphMin` 且仍需继续执行（非立即人工）

### 19.7.2 退化行为

| 从 → 到 | 动作 | `executionMode` |
|---------|------|-----------------|
| graph → stepQueue | 从 `TaskState` / snapshot 推导线性步骤队列；StepGate 检查步骤 ID | **forced** |
| stepQueue → writeIntent | 队列清空或不可执行；仅保留「允许写哪些路径」 | **forced** |
| writeIntent → 人工 | `RecoveryBudget` 耗尽 | **forced** 直至 `user_checkpoint` |

### 19.7.3 禁止

- graph failure → `executionMode = free`
- degraded 期间 `shouldExitForcedMode` 因「无图」单独为 true
- 静默丢失 `enteredBy` / `forcedDegradedTier`（须 telemetry）

---

# 20. 与现有代码的关系

| 已有模块 | 角色 |
|----------|------|
| `GraphExecutor` + `task-graph-builder` | strict 正向建图；模板恢复图可复用 builder |
| `DeviationDetector` / `EscalationManager` | takeover 段合约与升级；接管后 evaluate 仅 metrics |
| `BranchBudgetTracker` | 单策略重复预算；与 `RecoveryBudgetManager` 分工 |
| `StepReview` | 可作为 Observer 信号源；接管后避免重复 inject |
| `CheckpointEngine` v2 | 扩展 supervisor 字段与 EventTimeline |
| `shouldUseTaskGraph` / `inferIntent` | `TaskDomainClassifier` v1 基础（**不驱动 executionMode**） |
| **`ModeDecisionEngine`** | **§8.11 · §14.4**；Harness round 前 evaluate |
| **`TaskRiskClassifier`** | **§8.12 · §2.8.4**；L0/L1/L2 运行态分级 |

**相关文档：** 验收 **附录 B**；Execution Mode 迁移 **附录 C**；Benchmark / Learning（后续）[`运行时后续优化.md`](./运行时后续优化.md)。

---

# 附录 A：TypeScript 骨架（实现准绳）

以下为 `src/types/supervisor.ts` 目标形状；实现时可微调字段，**不得违背 §17 / §19 行为**。**配置字段的人类可读说明以 §15 为准**；代码中须为 §15 所列每个键写 JSDoc。

```ts
/** 与 TaskIntent 映射；§4 细粒度域可逐步扩展 */
export type TaskDomain =
  | 'critical_edit' | 'critical_debug' | 'critical_test' | 'critical_refactor'
  | 'critical_architecture' | 'critical_migration' | 'critical_deploy'
  | 'non_critical_read' | 'non_critical_explain' | 'non_critical_docs';

/** 与 ICE_SUPERVISOR_MODE 一致；由 ModeController 解析，业务模块只读 GlobalModePolicy */
export type SupervisorMode = 'off' | 'adaptive' | 'strict';

/** §3.2 Global Mode Policy — env/config 解析结果；非 per-task */
export interface GlobalModePolicy {
  autoDecisionEnabled: boolean;
  supervisorMode: SupervisorMode;
  shadow: boolean;
  executionModeFloor: ExecutionMode;
  observerEnabled: boolean;
  modeDecisionEngineEnabled: boolean;
  recoverySupervisorEnabled: boolean;
  strictCapabilityBundle: boolean;
}

export interface ModeController {
  resolveGlobalPolicy(): GlobalModePolicy;
  /** §17 参数；来自 config，非 env 散落读取 */
  getModeParams(): SupervisorParams;
}

/** 运行时相位，与配置 mode 无关；见 §18 */
export type SupervisorPhase = 'free' | 'takeover' | 'handoff_pending' | 'cooldown';

/** 磁盘配置根类型；字段注释规范见 §15.2–§15.6 */
export interface SupervisorConfigFile {
  /** 运行模式；可被环境变量 ICE_SUPERVISOR_MODE 覆盖 */
  mode: SupervisorMode;
  /** 影子评测：评估全跑但不改 supervisorPhase；可被 ICE_SUPERVISOR_SHADOW 覆盖 */
  shadow: boolean;
  /** §17 三列参数 */
  params: SupervisorParams;
  /** §9 条件三：异常触发阈值 */
  triggers: SupervisorTriggers;
  /** §8.3 / §19.1 目标漂移 */
  goalDrift: GoalDriftConfig;
  /** §8.5 快照可信度 */
  snapshotConfidence: SnapshotConfidenceConfig;
  /** §2.6 I4：free 段 C 类 inject 预算 */
  correctionBudget: CorrectionBudgetConfig;
  /** §6 风险因子权重（可选） */
  riskEvaluator?: RiskEvaluatorWeights;
  /** §8.9 事件时间线落盘（可选） */
  eventTimeline?: EventTimelineConfig;
  /** §2.8 / §8.11 Execution Free/Forced 阈值 */
  executionMode?: ExecutionModeConfig;
}

/** 合并环境变量后的有效配置（ModeController 输出） */
export type SupervisorConfig = SupervisorConfigFile;

export interface SupervisorParams {
  strict: ModeParams;
  /** adaptive 自由段：仅 riskThreshold + firstRoundGraph */
  adaptiveFree: Pick<ModeParams, 'riskThreshold' | 'firstRoundGraph'>;
  /** adaptive 接管段：supervisorPhase=takeover */
  adaptiveTakeover: ModeParams;
}

/** §15.3 / §17 单列参数；每个字段须在实现处写 JSDoc */
export interface ModeParams {
  /** 关键域第 1 轮是否 initGraph；adaptive 自由段必须为 false */
  firstRoundGraph: boolean;
  /** 风险分 [0,1] 接管候选阈；接管后不再评估 */
  riskThreshold: number;
  /** 单次 takeover 最大恢复轮数 */
  maxRecoveryRounds: number;
  /** 恢复 token 占任务总预算比例上限 [0,1] */
  recoveryTokenRatio: number;
  /** 同路径恢复重试上限（§8.8） */
  maxRecoveryRetries: number;
  /** handoff 前稳定观察轮数（§12.2） */
  stabilityWindowRounds: number;
  /** 交还后禁止再次接管的冷却轮数（§12.3） */
  handoffCooldownRounds: number;
  /** GraphExecutor.evaluateRound 是否注入 msgs */
  evaluateRoundMode: 'full' | 'metrics_only' | 'none';
  /** 是否 checkToolCall 并送入 ToolGate */
  checkToolCall: boolean;
}

/** §15.4 */
export interface SupervisorTriggers {
  toolRepeatFailMin: number;
  noProgressRoundsMin: number;
  fileLoopMin: number;
  goalDriftEnabled: boolean;
  scopeCreepEnabled: boolean;
  userForceTakeoverEnabled: boolean;
}

/** §15.5 goalDrift */
export interface GoalDriftConfig {
  alignmentThreshold: number;
  consecutiveRoundsBelow: number;
  llmGrayZoneLow: number;
  llmGrayZoneHigh: number;
  jaccardMinGoalOverlap?: number;
}

/** §15.5 snapshotConfidence */
export interface SnapshotConfidenceConfig {
  /** 低于则禁止 §19.2 一级模板图 */
  templateGraphMin: number;
  weightGitClean?: number;
  weightSnapshotAge?: number;
  weightVerifyPassed?: number;
  weightRepoContextMatch?: number;
  weightBuildSignal?: number;
}

/** §15.5 correctionBudget */
export interface CorrectionBudgetConfig {
  freeSegmentMaxPerTask: number;
  shadowDiagnosticMaxPerRound?: number;
}

/** §15.5 riskEvaluator */
export interface RiskEvaluatorWeights {
  weightFilesChanged?: number;
  weightDependencyDepth?: number;
  weightModuleBlastRadius?: number;
  weightIrreversibleOps?: number;
  weightCompileImpact?: number;
  weightRecentFailures?: number;
}

/** §15.5 eventTimeline */
export interface EventTimelineConfig {
  enabled: boolean;
  persistPath: string;
  maxEventsInCheckpoint?: number;
}

/** §15.5 executionMode */
export interface ExecutionModeConfig {
  enabled: boolean;
  pendingStepsEnterThreshold: number;
  writeTargetsEnterThreshold: number;
  diffLinesEnterThreshold: number;
  stableRoundsExitThreshold: number;
  modeLockRounds: number;
  /** §2.8.12 · I10 默认 1 */
  forcedMinDwellRounds: number;
  readonlyToolNames: string[];
}

/** §2.8 · 执行边界（非 SupervisorMode） */
export type ExecutionMode = 'free' | 'forced';

export type TaskRiskLevel = 'L0_observation' | 'L1_minor_edit' | 'L2_structural';

export type ModeSignal =
  | 'task_graph_active'
  | 'pending_steps'
  | 'multi_write'
  | 'branch_switched'
  | 'checkpoint_resumed'
  | 'tool_failure'
  | 'recovery_pending'
  | 'large_diff'
  | 'explicit_impl'
  | 'engine_fail_safe';  // §2.8.10 · 仅 fail-safe 路径

/** §2.8.8 · P0（index 0）→ P7 */
export const MODE_SIGNAL_PRECEDENCE: readonly ModeSignal[] = [
  'checkpoint_resumed',
  'task_graph_active',
  'branch_switched',
  'pending_steps',
  'tool_failure',
  'multi_write',
  'large_diff',
  'explicit_impl',
] as const;

export function sortSignalsByPrecedence(signals: ModeSignal[]): ModeSignal[];

export function formatForcedReasonHuman(enteredBy: ModeSignal[]): string;

/** §2.8.11 */
export type ForcedDegradedTier = 'graph' | 'step_queue' | 'write_intent';

/** §2.8.9 · runtime telemetry / HarnessStepEvent */
export interface ExecutionModeTelemetryPayload {
  executionMode: ExecutionMode;
  enteredBy: ModeSignal[];
  enteredByPrimary?: ModeSignal;
  primaryReasonHuman: string;
  round: number;
  failSafe?: boolean;
  degradedTier?: ForcedDegradedTier;
  forcedTaskBearingRoundsSinceEntry?: number;
  forcedMinDwellRounds?: number;
  exitDeniedReason?: 'mode_lock' | 'min_dwell' | 'exit_conditions';
}

export type ModeSignalSource =
  | 'graph_executor'
  | 'recovery_supervisor'
  | 'checkpoint_engine'
  | 'step_gate'
  | 'branch_budget'
  | 'tool_gate'
  | 'stop_hook';

export interface RuntimeExecutionState {
  round: number;
  taskGraphActive: boolean;
  pendingStepCount: number;
  writeTargetsThisRound: number;
  plannedWriteTargets: number;
  accumulatedDiffLines: number;
  branchSwitchedThisRound: boolean;
  checkpointResumedThisSession: boolean;
  lastToolSuccess: boolean;
  recoveryPending: boolean;
  branchDebt: number;
  stableRounds: number;
  activeGraphHasImplementNode: boolean;
  readonlyToolNames: string[];
  plannedToolNames: string[];
  forcedEntryRound: number | null;
  forcedTaskBearingRoundsSinceEntry: number;
}

/** §2.8.12 */
export function isTaskBearingRound(
  outcome: TaskBearingRoundOutcome,
): boolean;

export interface TaskBearingRoundOutcome {
  hadSuccessfulToolExecute: boolean;
  graphStepAdvanced: boolean;
  writeToolSucceededWithFileChange: boolean;
}

export interface ModeDecisionEngine {
  evaluate(ctx: ModeDecisionContext): ModeDecision;
  submitSignal(source: ModeSignalSource, signal: ModeSignal, payload?: Record<string, unknown>): void;
}

export interface TaskRiskClassifier {
  classify(state: RuntimeExecutionState): TaskRiskLevel;
}

export function shouldEnterForcedMode(
  state: RuntimeExecutionState,
  cfg: ExecutionModeConfig,
  signals: ModeSignal[],
): boolean;

export function shouldExitForcedMode(
  state: RuntimeExecutionState,
  cfg: ExecutionModeConfig,
  lockRemaining: number,
): boolean;
/** false 时 reason: 'mode_lock' | 'min_dwell' | 'exit_conditions' */

export interface ModeDecisionContext {
  round: number;
  executionMode: ExecutionMode;
  executionModeLockRemaining: number;
  supervisorPhase: SupervisorPhase;
  supervisorMode: SupervisorMode;
  riskLevel: TaskRiskLevel;
  state: RuntimeExecutionState;
  signals: ModeSignal[];
}

type ModeDecision =
  | { action: 'keep'; mode: ExecutionMode }
  | {
      action: 'enter_forced';
      reason: ModeSignal[];
      lockRounds: number;
      enteredBy: ModeSignal[];
      primaryReason: ModeSignal;
      failSafe?: boolean;
    }
  | { action: 'exit_forced'; reason: string };

export interface TaskContext {
  goal: string;
  intent: import('./runtime-snapshot.js').TaskIntent;
  domain: TaskDomain;
  filesChanged: string[];
  filesRead: string[];
  commandsRun: string[];
  recentFailureCount: number;
  branchBudgetTriggers: number;
}

export interface WorkspaceSnapshot {
  snapshotId: string;
  at: number;
  gitSummary: string;
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
  buildSummary?: string;
  testSummary?: string;
  lintSummary?: string;
  /** V2 可选 */
  semanticSummary?: string;
}

/** LoopState 仅持摘要 */
export interface WorkspaceSnapshotRef {
  snapshotId: string;
  checkpointPath?: string;
  summaryOneLine: string;
}

export type DeviationSignal =
  | { type: 'tool_repeat_fail'; count: number }
  | { type: 'no_progress'; rounds: number }
  | { type: 'file_loop'; path: string; count: number }
  | { type: 'goal_drift'; alignment: number }
  | { type: 'scope_creep' }
  | { type: 'user_force_takeover' };

export interface RuntimeRound {
  round: number;
  toolNames: string[];
  toolSuccess: boolean[];
  hadWriteTool: boolean;
}

export interface SupervisorEvaluateContext {
  phase: SupervisorPhase;
  mode: SupervisorMode;
  shadow: boolean;
  round: RuntimeRound;
  signals: DeviationSignal[];
  riskScore: number;
  task: TaskContext;
}

export type SupervisorDecision =
  | { action: 'continue' }
  | { action: 'takeover'; reason: string; signals: DeviationSignal[] }
  | { action: 'handoff_pending' }
  | { action: 'handoff' }
  | { action: 'fail'; kind: 'checkpoint' | 'rollback' };

export interface SnapshotConfidenceInput {
  snapshot: WorkspaceSnapshot;
  repoFilesChanged: string[];
  roundsSinceExtract: number;
  lastVerifyPassed: boolean;
}

/** HarnessStepEvent 扩展 payload 示例 */
export interface SupervisorStepPayload {
  phase: SupervisorPhase;
  reason?: string;
  shadowWouldTakeover?: boolean;
}

/** §2.8.9 · step: execution_mode_enter | execution_mode_exit */
export type ExecutionModeStepPayload = ExecutionModeTelemetryPayload;

/** §14.0 — 纠偏写入口 */
export type CorrectionSource =
  | 'supervisor'
  | 'lifecycle'
  | 'memory'
  | 'compaction';

export interface CorrectionBlock {
  kind: 'takeover' | 'recovery' | 'graph_hint' | 'shadow_diagnostic';
  content: string;
  preserveOnCompaction?: boolean;
}

export interface CorrectionPort {
  inject(block: CorrectionBlock, ctx: { phase: SupervisorPhase; source: CorrectionSource }): void;
}

/** §14.0 — 工具执行门禁 */
export type ToolGateAction = 'execute' | 'skip' | 'confirm';

export interface ToolGateEntry {
  toolCallId: string;
  action: ToolGateAction;
  message?: string;
}

export interface ToolGatePlan {
  entries: ToolGateEntry[];
}

export interface ToolGate {
  decide(calls: import('../llm/types.js').ToolCall[], ctx: GateContext): ToolGatePlan;
}

export interface GateContext {
  phase: SupervisorPhase;
  mode: SupervisorMode;
  /** §2.8 · Forced 下 step gate / graphHints 生效 */
  executionMode: ExecutionMode;
  graphHints: Array<{ toolName: string; action: 'allow' | 'warn' | 'block'; message?: string }>;
}
```

`StopReason` 扩展：`user_checkpoint`。

---

# 附录 C：Execution Mode 迁移与兼容

## C.1 Compatibility notes（保持现有实现可用）

| 场景 | 行为 |
|------|------|
| `ICE_SUPERVISOR_MODE=off` | `autoDecisionEnabled=false` → 始终 **exec_free**；与 **今日 Harness 二进制兼容** |
| 未部署自动决策链（迁移前） | 默认 `GlobalModePolicy` 等价 off；**不回归** |
| `inferIntent` / 任务图首轮建图 | **不改变**现有 intent 门控；Forced 由 **运行态** 叠加，不替换 `shouldUseTaskGraph` |
| `supervisorPhase=takeover` | **强制** `executionMode=forced`；与 §18 一致 |
| Learning 层 | 仅只读 timeline / 建议阈值；**禁止**写 `executionMode`（§2.8.7） |

## C.2 Migration plan（推荐顺序）

| 步骤 | 内容 | 验收 |
|------|------|------|
| 1 | 附录 A 类型落盘 + `executionMode` config 默认值 | 编译通过 |
| 2 | `TaskRiskClassifier` 纯函数 + 单元测试（**无关键词 fixture**） | L0/L1/L2 用工具计划态断言 |
| 3 | `ModeDecisionEngine` + mode lock + **precedence / enteredBy telemetry** | enter/exit + 多 signal 排序 + fail-safe 测试 |
| 4 | `harness.ts` 插入点（§14.4）+ `applyExecutionModeConstraints` | 附录 B Execution 子集 |
| 5 | 各模块改 `submitSignal`；删除任何直接写 `executionMode` | grep 零违规 |
| 6 | ToolGate 与 Forced 联调 | block 在 forced 生效、free 不检查 |

## C.3 Harness 接入清单（文件级）

| 文件 | 变更 |
|------|------|
| `src/harness/harness.ts` | `prep` 与 `callHarnessLlm` 之间调用 `modeDecisionEngine.evaluate` |
| `src/harness/harness-round-prep.ts` | 填充 `RuntimeExecutionState` 部分字段（round、planned tools） |
| `src/harness/supervisor/mode-decision-engine.ts` | **新建** |
| `src/harness/supervisor/task-risk-classifier.ts` | **新建** |
| `src/harness/supervisor/execution-mode-constraints.ts` | **新建** |
| `src/harness/task-graph-executor.ts` | `submitSignal('task_graph_active' \| 'pending_steps' \| 'explicit_impl')` |
| `src/harness/supervisor/tool-gate.ts` | 读 `GateContext.executionMode` |

## C.4 禁止项（code review 检查）

- 用 user message / `inferIntent` / 中文动词表调用 `shouldEnterForcedMode`
- 在 `GraphExecutor`、`RecoverySupervisor` 内 `state.executionMode = 'forced'`
- **Harness / GraphExecutor / ToolGate 内读取 `process.env.ICE_SUPERVISOR_*`（I6）**
- Learning / eval 脚本运行时修改 `executionMode`
- Forced 退出忽略 `modeLockRounds`
- forced 退出忽略 **I10 min dwell**（`forcedMinDwellRounds`）
- graph / builder 失败时 **`executionMode = free`**
- enter forced 不写 `enteredBy` telemetry

---

# 附录 B：验收检查表

**门禁子集**（`ToolGate` / `CorrectionPort` 落地后必过）与 **Execution Mode 子集**（`ModeDecisionEngine` 落地后必过）可独立勾选；**全量验收**覆盖端到端 takeover / handoff。

### 门禁子集

- [ ] `ToolGate`：`checkToolCall` / 合约为 `block` 时，对应 `toolCallId` **未**进入 `executeToolCalls`
- [ ] `skip` 的调用在 `msgs` 中有可见 tool result 或 user 说明（非静默丢弃）
- [ ] `adaptive` + 关键 intent：第 1 轮 **无** `task_graph_init`（`strict` 除外）
- [ ] takeover 段：自动化统计 C 类 `msgs` 来源 tag，**仅** `CorrectionSource.supervisor`
- [ ] free 段：连续 3 轮工具失败 **无** 第 2/3 条长 System 策略 inject（仅 timeline 信号）；shadow 可记「本会 takeover」

### Execution Mode 子集

- [ ] 仅 `ModeDecisionEngine` 可写 `LoopState.executionMode`（**I5**）
- [ ] L0（只读计划工具）：**不**进入 Forced；**不**启用 step gate
- [ ] `pendingStepCount >= 2` → Forced；`GraphExecutor.checkToolCall` 经 ToolGate 生效
- [ ] Forced 进入后 **mode lock 2 轮**内：`shouldExitForcedMode=true` 仍保持 Forced
- [ ] **I10 min dwell：** enter forced 后 signal 清空、**无** task-bearing round → **不得** exit（防闪跳）
- [ ] 至少 **1** 次 task-bearing round（工具 execute 成功 / 图步骤推进 / 写成功）后，才允许满足 §2.8.5 时 exit
- [ ] `supervisorPhase=takeover` 时：Forced 不可降至 Free，直至 handoff 完成
- [ ] **无** user goal 关键词 / `inferIntent` 直接触发 Forced 的代码路径
- [ ] **无** 业务模块直接读 `ICE_SUPERVISOR_*` / `process.env.ICE_SUPERVISOR_*`（**I6**；仅 `ModeController.resolveGlobalPolicy`）
- [ ] free→forced 时 telemetry / `LoopState` 含 **`enteredBy`**（按 §2.8.8 排序）与 **`primaryReasonHuman`**
- [ ] 多 signal 同时触发：首位为 P0（如 `checkpoint_resumed` 优于 `pending_steps`）
- [ ] `ModeDecisionEngine.evaluate` 抛错 → **forced** + `failSafe: true`（§2.8.10，**非 free**）
- [ ] `RetrospectiveGraphBuilder` 失败 → **`executionMode` 仍 forced**；`forcedDegradedTier` 下降（§2.8.11 / §19.7）

### 全量验收

- [ ] `ICE_SUPERVISOR_MODE=off` 与今日 Harness 行为一致（无额外 inject）
- [ ] `ICE_SUPERVISOR_SHADOW=1` + `adaptive`：timeline 有「本会接管」记录，**`supervisorPhase` 始终 free**
- [ ] `strict` + 关键域：第 1 轮 `task_graph_init`；graph hint **经 CorrectionPort**，不直连 `msgs`
- [ ] `adaptive`：模拟连续失败 / 漂移 → `takeover`（`supervisorPhase`）→ 模板图或二级强提示
- [ ] 接管后无 `consecutiveToolFailures` / branch recover 重复 inject（§19.6 全表）
- [ ] 稳定窗口满足后 `handoff` → `cooldown` 内不二次接管
- [ ] 恢复预算耗尽 → `user_checkpoint`，EventTimeline 含 `failure`
- [ ] rollback 走 `confirm`；拒绝 → 人工级
- [ ] checkpoint 重启后 `supervisorPhase` / `eventTimeline` 可恢复
- [ ] 无异常任务 token 开销较 baseline **< +5%**（shadow 对照）

> **Benchmark / Learning（可选）：** 见 [`运行时后续优化.md`](./运行时后续优化.md)；**不计入本规格全量验收**。

---