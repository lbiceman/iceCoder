# 双模 L2 流程图

> P2-3 交付物：一次 inject / 一轮 after-round / takeover 主路径的可视化说明。  
> 权威规格：[`双模方案2.md`](./双模方案2.md) V1.3.7；代码入口：[`src/harness/supervisor/`](../src/harness/supervisor/)。

---

## 1. 一次 inject 的完整路径

```mermaid
flowchart TD
  A[harness-tool-round / harness-resilience] -->|kind/content/ctx| B(SupervisorBridge.createCorrectionPort)
  B --> C{bridge.isActive?}
  C -->|off| D[MessageCorrectionPort<br>legacyShouldSuppress 兼容]
  C -->|on| E[MessageCorrectionPort<br>+boundary +budget]
  D --> Z((msgs.push))
  E --> F{RecoveryBoundary<br>mayInjectCorrection}
  F -->|reject| G[onBoundaryRejected<br>→ timeline failure:recovery_boundary_rejected:*]
  F -->|allow| H{budget.tryConsume?}
  H -->|reject| I[onBudgetRejected<br>→ timeline failure:correction_budget_exhausted:*]
  H -->|allow| Z
```

**要点：**

- off 模式：`createCorrectionPort` 不挂 boundary/budget，保留历史 W7 静默 drop。
- on 模式：boundary 在前、budget 在后；仅 `budgetCountable=true` 的 inject 消耗 I4 配额。
- timeline 的 `round` 来自 `ctx.round ?? bridge.currentRound`（P1-1）。

---

## 2. 一轮 after-round 决策路径

```mermaid
flowchart TD
  A[runHarnessToolRound 末段] --> B[bridge.observeAfterTools]
  B --> B1[PassiveObserver.observe]
  B --> B2[GoalDriftDetector.evaluate]
  A --> C[bridge.evaluateAfterRound]
  C --> C1[mergeSignals]
  C --> C2[buildEvaluateContext]
  C --> C3[recoverySupervisor.computeNext]
  C --> C4{shadow?}
  C4 -->|yes| C5[applyDecision 拦截<br>→ shadow_diagnostic timeline]
  C4 -->|no| C6[applyBudget<br>RecoveryBudgetManager]
  C6 --> C7{exhausted?}
  C7 -->|yes| C8[fail checkpoint<br>→ user_checkpoint stop]
  C7 -->|no| C9[recoverySupervisor.commit phase]
  C9 --> C10[dispatchSideEffects<br>applyTakeover / applyHandoff via CorrectionPort]
```

**要点：**

- `observeAfterTools` 只累积 signal + timeline，不推进 phase 机。
- `evaluateAfterRound` 是唯一 after-round 决策入口；shadow 段只记 diagnostic，不真正 takeover。
- `fail{checkpoint}` 经 Harness `loopController.stop('user_checkpoint')` 串联停止。

---

## 3. takeover 主路径（§10）

```mermaid
flowchart TD
  A[evaluateAfterRound → takeover] --> B[bridge.runRecoveryMainPath]
  B --> M5[M5 WorkspaceStateExtractor]
  M5 --> M6[M6 SnapshotConfidenceEvaluator]
  M6 --> Q1{confidence >= templateGraphMin?}
  Q1 -->|no| F[handleFallback → 二级强提示]
  Q1 -->|yes| M7[M7 RecoverySafetyChecker]
  M7 --> Q2{safety.recoverable?}
  Q2 -->|no| F
  Q2 -->|yes| M8[M8 RetrospectiveGraphBuilder]
  M8 --> Q3{build ok?}
  Q3 -->|no| F
  Q3 -->|yes| Q4{graphExecutor 提供?}
  Q4 -->|no| F
  Q4 -->|yes| R[一级模板图：GraphExecutor.replaceGraph + enterTakeover<br>→ timeline recover:template_graph:*]
  F --> S[CorrectionPort.inject 单条 System Recovery<br>→ timeline recover:strong_hint:*]
```

---

## 4. graph hint 收口（§14.0 / L2-7）

```mermaid
flowchart LR
  A[forced step warn / block<br>evaluateRound] --> B[bridge.composeGraphHint]
  B --> C[normalizeGraphHintInput]
  C --> D[decideGraphHintRouting]
  D -->|free| E[drop]
  D -->|forced| F[CorrectionPort.inject graph_hint]
  F --> G[timeline recover:graph_hint:*]
```

---

## 相关测试

| 项 | 测试文件 |
|----|----------|
| RecoveryBoundary 64 矩阵 | `test/harness/recovery-boundary.test.ts` |
| 6 场景 e2e | `test/e2e/dual-mode-scenarios.test.ts` |
| firstRoundGraph 集成 | `test/harness/execution-mode-harness.test.ts` |
