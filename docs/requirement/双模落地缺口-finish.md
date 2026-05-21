# 双模完整方案 — 落地缺口清单

> **依据规格：** [`双模方案2.md`](./双模方案2.md) V1.3.7（附录 A/B/C 冻结）  
> **实施计划：** [`任务执行文档.md`](./任务执行文档.md)、[`.cursor/plans/dual-mode-tasks_b2180989.plan.md`](../.cursor/plans/dual-mode-tasks_b2180989.plan.md)  
> **最后对照代码：** `src/harness/supervisor/`（13 个文件，含 L2-1 bridge / L2-2 passive-observer / L2-3 recovery-supervisor）、`test/harness/execution-mode-*.test.ts`

本文档单独列出：**完整双模方案**相对当前仓库还缺少的 **模块** 与 **功能**。  
README 中的「部分落地」即指：第一层（Execution Mode）已接通，第二层（Runtime Supervisor 接管内核）尚未实现。

**完成标准（本项目）：**

| 口径 | 含义 |
|------|------|
| **功能完备**（开发收口） | §3 模块 M1–M10 已实现并接入 Harness §4 所列行为；§6 步骤 1–8 完成。由开发对照本文档勾选即可。 |
| **规格验收**（可选、自行安排） | 附录 B 检查表、6 场景联调、token 对照等 — **不阻塞**宣称功能完备；验收由维护者自行执行。 |

---

## 1. 完整双模的两层定义

| 层级 | 规格章节 | 用户可见效果 | 当前状态 |
|------|----------|--------------|----------|
| **L1 · Execution Mode** | §2.8、§8.11–8.12、§14.4（evaluate 段） | `free` ↔ `forced`；pending steps / 多写 / checkpoint 恢复等触发强约束；ToolGate 在 forced 下按图合约阻断工具 | **已基本实现** |
| **L2 · Runtime Supervisor** | §8.2–8.10、§9、§14.0–14.1、附录 B「全量验收」 | 观察异常 → `takeover` → 模板图/强提示纠偏 → `handoff` → `cooldown`；shadow 只记不接管 | **已实现** |

```text
  用户任务
      │
      ▼
┌──────────────────────────────────────────┐
│ L2 RecoverySupervisor                    │  takeover / handoff / drift
│   PassiveObserver · GoalDriftDetector     │
│   RecoveryBudgetManager · EventTimeline   │
│   ┌──────────────────────────────────┐    │
│   │ RecoveryBoundary（§11 / §19.6）  │    │   phase × source × kind 单一硬门禁
│   │ composeGraphHint（§14.0）        │    │   graph_hint 收口 → CorrectionPort
│   └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
      │ 仅 L1 时：supervisorPhase ≈ 恒 free
      ▼
┌──────────────────────────────────────────┐
│ L1 ModeDecisionEngine                    │  free ↔ forced · ToolGate · I10 dwell
└──────────────────────────────────────────┘
      ▼
  Harness 主循环（工具 / 记忆 / TaskGraph）
```

---

## 2. 已有模块（对照，非缺口）

`src/harness/supervisor/` 当前文件与规格 §8 对应关系：

| 文件 | 规格模块 | 完成度 |
|------|----------|--------|
| `mode-controller.ts` | §8.1 ModeController | ✅ Global 策略、`ICE_SUPERVISOR_*` 仅此处解析（I6） |
| `supervisor-config.ts` | §15 配置合并 | ✅ 默认值 + 磁盘加载 + 失败降级 `off` |
| `mode-decision-engine.ts` | §8.11 ModeDecisionEngine | ✅ enter/exit forced、signal 优先级、I10、fail-safe |
| `task-risk-classifier.ts` | §8.12 TaskRiskClassifier | ✅ L0/L1/L2，无用户 goal 关键词 |
| `runtime-execution-state.ts` | 附录 A `RuntimeExecutionState` | ✅ 构造与字段派生 |
| `execution-mode-constraints.ts` | §14.4 apply 约束 | ✅ mode lock、branch/checkpoint forced 联动 |
| `tool-gate.ts` | §14.0 ToolGate | ✅ execute/skip/block；forced 下 step gate |
| `correction-port.ts` | §14.0 CorrectionPort | ✅ `MessageCorrectionPort` + L2-3 RecoverySupervisor.applyTakeover + L2-7 接入 RecoveryBoundary（boundary 拒绝写 timeline） |
| `forced-degraded.ts` | §2.8.11 / §19.7 | ✅ graph 失败仍 forced、tier 降级 |
| `graph-hint-routing.ts` | §15.3 graph hint 路由 | ✅ L2-7 `SupervisorRuntimeBridge.composeGraphHint` 收口：free→drop / forced→port + `recover:graph_hint:*` timeline |
| `recovery-boundary.ts` | §11 / §19.6 | ✅ L2-7 — phase × source × kind 单一硬门禁；`MessageCorrectionPort` 失败回 timeline `failure:recovery_boundary_rejected:*` |

**Harness 接入：** `loadHarnessSupervisorRuntime`（`chat` / `run` / `chat-ws` / `remote-ws`）；`harness.ts` 内 `evaluateExecutionModeBeforeLlm`。

**测试：** `test/harness/execution-mode-acceptance.test.ts` 等覆盖 **L1 子集**（I5/I6/I10、signal 排序等），**不**覆盖 L2 全量。

---

## 3. 缺少的模块（须新建或整段实现）

以下模块在规格 §8 中有 **interface / 职责定义**，仓库中 **无对应实现类/文件**（截至本文档编写时）。

| # | 规格模块 | § | 建议落点 | 职责摘要 | 状态 |
|---|----------|---|----------|----------|------|
| M1 | **PassiveObserver** | §8.2 | `passive-observer.ts` | 每轮/每工具后观察：重复失败、无进展、文件循环等；free 段 **不** 反复 `msgs.push` 长策略，只累积 signal / timeline | ✅ L2-2 |
| M2 | **RecoverySupervisor** | §8.10 | `recovery-supervisor.ts` | 编排核心：`evaluate` → 是否 `takeover`；`applyTakeover` 经 CorrectionPort；handoff / cooldown；与 ModeDecisionEngine **只 submitSignal**（I5） | ✅ L2-3 |
| M3 | **GoalDriftDetector** | §8.3 | `goal-drift-detector.ts` | 对齐度 0~1；连续低于 `alignmentThreshold` 提交 `goal_drift` signal；V2 可选 LLM 灰区（`RiskEvaluator`） | ✅ L2-4 |
| M4 | **RiskEvaluator** | §8.x / 附录 A | `risk-evaluator.ts` | LLM 灰区对齐评估（`llmGrayZoneLow/High`）；与 M3 配合 | ❌ 缺失 |
| M5 | **WorkspaceStateExtractor** | §8.4 | `workspace-state-extractor.ts` | takeover 前扫描：文件/git/构建/诊断 → 接管用 snapshot | ✅ L2-5 |
| M6 | **SnapshotConfidenceEvaluator** | §8.5 | `snapshot-confidence-evaluator.ts` | 快照可信度；低于 `templateGraphMin` 禁止一级模板图 | ✅ L2-5 |
| M7 | **RecoverySafetyChecker** | §8.6 | `recovery-safety-checker.ts` | 关键文件/repo/分支/基线是否可恢复 | ✅ L2-5 |
| M8 | **RetrospectiveGraphBuilder** | §8.7 | `retrospective-graph-builder.ts` | 接管后生成恢复 TaskGraph（与现有 `task-graph-builder` 协作） | ✅ L2-5 |
| M9 | **RecoveryBudgetManager** | §8.8 | `recovery-budget-manager.ts` | 恢复轮数/token/重试上限；耗尽 → `user_checkpoint` | ✅ L2-4 |
| M10 | **EventTimeline** | §8.9 | `event-timeline.ts` | 写入 `data/runtime/supervisor-events.jsonl`；事件类型 switch/recover/handoff/drift/failure… | ✅ L2-1 |

**说明：** M5–M9 多为 **RecoverySupervisor.takeover 路径** 的子能力；可先实现 M2 骨架 + M10，再逐项补齐 M5–M9。

### 3.1 可选 / V2（规格标明非 V1 阻塞）

| 模块 | § | 说明 |
|------|---|------|
| TaskDomainClassifier | §8 早期 | 关键域判定已由 `shouldUseTaskGraph(intent)` + TaskDomainGate 部分覆盖 |
| Learning / Benchmark | [`运行时后续优化.md`](./运行时后续优化.md) | **不计入** V1.3.7 全量双模必选项 |

---

## 4. 缺少的功能（按行为分类）

### 4.1 监管相位（`supervisorPhase`）— L2 核心

`HarnessRunState.supervisorPhase` 字段已存在，但 **无代码驱动状态迁移**。

| 相位 | 规格 | 当前 |
|------|------|------|
| `free` | 默认；Observer 累积 | ✅ 恒态 |
| `takeover` | §9 三条件满足后进入；Forced 不可降至 Free | ❌ 从未进入 |
| `handoff_pending` | 稳定窗口后准备交还 | ❌ |
| `cooldown` | handoff 后 N 轮禁止二次接管（`handoffCooldownRounds`） | ❌ |

**依赖模块：** M1 PassiveObserver、M2 RecoverySupervisor、M10 EventTimeline。

---

### 4.2 接管（takeover）与纠偏（C 类）

| 功能 | 规格 | 当前 |
|------|------|------|
| 连续工具失败 → takeover（非 free 段重复 inject） | §19.6、I4 | ✅ L2-6 `harness-tool-round` after-round 经 `bridge.evaluateAfterRound`；free 段 inject 全部走 `bridge.createCorrectionPort` 统一受 I4 约束 |
| `applyTakeover` 唯一经 **CorrectionPort** 写 `kind: takeover` | §14.0 | ✅ L2-3 `RecoverySupervisor.applyTakeover` |
| takeover 段 C 类 msgs **仅** `CorrectionSource.supervisor` | 附录 B 门禁 | ✅ L2-3/L2-5 bridge `dispatchSideEffects` + `runRecoveryMainPath` 经 CorrectionPort |
| 模板图 / 二级强提示（§19.2 一级/二级） | §8.7、§19.2 | ✅ L2-5 `runRecoveryMainPath`：M5→M6→M7→M8 + `GraphExecutor.replaceGraph` 走主路径，confidence/safety/builder 任一失败 → 二级 `[System Recovery]` 单条 inject |
| `CorrectionBudget`：free 段每任务 ≤1 次策略 inject | I4、`correctionBudget` | ✅ L2-6 `CorrectionBudgetTracker` + `bridge.createCorrectionPort`：phase=free / source=supervisor / kind∈{recovery,graph_hint} 计数，超限 drop 并写 `failure:correction_budget_exhausted` timeline |

---

### 4.3 交还（handoff）与冷却

| 功能 | 规格 | 当前 |
|------|------|------|
| 稳定窗口 + 无 recovery 信号 → handoff | §2.8.5、§9 | ✅ L2-3 `RecoverySupervisor.tickHandoffPending` + L2-6 `bridge.evaluateAfterRound` 主循环驱动 |
| handoff 后 `cooldown` 内不二次 takeover | `handoffCooldownRounds` | ✅ L2-3 `tickCooldown`；L2-6 接入 after-round 调用 |
| `supervisorPhase=takeover` 时禁止 executionMode 降 free | 附录 B | ✅ L2-7 — `RecoveryBoundary.takeover_phase_requires_supervisor_source` + `executionModeFloor=forced`（strict）；phase=takeover 时所有非 supervisor C 类 inject 被 boundary drop，ModeDecisionEngine 仍由 I5 单写 executionMode |

---

### 4.4 目标漂移与恢复预算

| 功能 | 规格 | 当前 |
|------|------|------|
| Goal drift 启发式 / LLM 灰区 | §8.3、`goalDrift` config | ⚠️ V1 启发式已落（M3 `goal-drift-detector.ts`）；M4 LLM 灰区未做 |
| `scopeCreepEnabled` / `userForceTakeoverEnabled` 等 trigger | `SupervisorTriggers` | ✅ L2-4 `bridge.submitManualTrigger` + observer toggle |
| 恢复预算耗尽 → `user_checkpoint` | §8.8、§13 | ✅ L2-6 `harness-tool-round` 接 `bridge.evaluateAfterRound`：fail{checkpoint} → `loopController.stop('user_checkpoint')` + `handleHarnessStop` 串联 |
| rollback 走 `confirm`；拒绝 → 人工级 | 附录 B 全量 | ❌ 未与 Supervisor 串联 |

---

### 4.5 Shadow 与 Strict 模式

| 功能 | 规格 | 当前 |
|------|------|------|
| `ICE_SUPERVISOR_SHADOW=1`：记「本会接管」，**phase 仍 free** | 附录 B 全量 | ✅ L2-3 `recordShadowWouldTakeover` + `applyDecision` 走 shadow_diagnostic timeline |
| `strict`：关键域第 1 轮 `task_graph_init` | 附录 B | ✅ L2-7 `bridge.shouldInitTaskGraphAtFirstRound`：strict→true / adaptive→false（§I3）/ off→fallback `shouldUseTaskGraph`；`harness-round-prep` 已经过 bridge |
| `strict`：graph hint **仅** CorrectionPort，禁止 GraphExecutor 直连 `msgs` | §14.0 | ✅ L2-7 `bridge.composeGraphHint` 收口：`harness-tool-round` 三处 inject（forced step warn / step block / evaluateRound）全部经此 → port，未活跃时回退仍走 routing + port，timeline 记 `recover:graph_hint:*` |
| `adaptive`：关键 intent 第 1 轮 **无** task_graph_init | 附录 B 门禁 | ✅ L2-7 `bridge.shouldInitTaskGraphAtFirstRound`：adaptive 关键 intent 一律 false（`adaptiveFree.firstRoundGraph=false`），由 RecoverySupervisor 接管后 `replaceGraph` 重建 |

---

### 4.6 EventTimeline 与持久化

| 功能 | 规格 | 当前 |
|------|------|------|
| 运行时事件 JSONL（switch / recover / handoff / drift / failure…） | §8.9 | ✅ L2-1 `EventTimeline` 落 JSONL + L2-6 `restoreRecentEvents` 把 tail 推回内存 |
| checkpoint 重启恢复 `supervisorPhase` + timeline | 附录 B 全量 | ✅ L2-6 / T08 `RuntimeSupervisorCheckpointState.{supervisorPhase, recoverySupervisorSnapshot, timelineTail, correctionBudgetUsed}` + `bridge.restoreFromCheckpoint` 推回 phase / 计数 / timeline，恢复时写 `failure:checkpoint_resumed` |
| Shadow 对照记录 | 附录 B | ✅ L2-8 自检：shadow 段 `applyDecision` 拦截 takeover/handoff/fail 决策、`recordShadowWouldTakeover` 写 `shadow_diagnostic`、free 段 supervisor 接管类 inject 被 `RecoveryBoundary` 拒；shadow 状态下 supervisorPhase 始终 free |

---

### 4.7 Harness 四钩子（§14.1）未收齐

| 钩子 | 规格职责 | 当前 |
|------|----------|------|
| before LLM | `ModeDecisionEngine.evaluate` | ✅ |
| before LLM | RecoverySupervisor（takeover 预判，若规格要求） | ⚠️ V1 不接（规格不强制）；L2-7 strict 首轮 graph 接入时再评估 |
| before tool call | `ToolGate.decide` | ✅ |
| after tool call | `PassiveObserver.observe` + 各模块 **仅** `submitSignal` | ✅ L2-2 Observer + L2-4 GoalDrift + L2-6 `bridge.evaluateAfterRound` 串联 |
| after round | `RecoverySupervisor.evaluate` + `recordTaskBearingRoundIfForced` | ✅ L2-6 `harness-tool-round` 调 `bridge.evaluateAfterRound`；I10 计数仍由 `recordTaskBearingRoundIfForced` 维持 |
| 禁止工具分支内 `if (repeatedFailures) msgs.push` | §14.0 | ✅ L2-6 free 段 inject 全部经 `bridge.createCorrectionPort`（挂 budget）；`harness-resilience` recovery 块在 supervisor 活跃时由 `supervisorObserverSuppressInject` 短路 |

---

### 4.8 信号与架构公理（部分未完成）

| 公理/要求 | 说明 | 当前 |
|-----------|------|------|
| **I5** | 仅 ModeDecisionEngine 写 `executionMode` | ✅ 测试 + constraints 收口 |
| **I6** | 业务不读 `ICE_SUPERVISOR_*` | ✅ 测试覆盖 |
| **I10** | forced min dwell（task-bearing round） | ✅ 引擎 + 测试 |
| **I4** | free 段 CorrectionBudget | ✅ L2-6 `CorrectionBudgetTracker` + `MessageCorrectionPort` 集成 + bridge `createCorrectionPort` 工厂 |
| **T09** | GraphExecutor / CheckpointEngine / StopHook **只** submitSignal | ✅ L2-6 全仓 grep 通过：`state.executionMode = …` 仅 `execution-mode-constraints.ts`（ModeDecisionEngine 应用层）；其余子模块均经 `submitModeSignal` |
| **enteredBy / primaryReasonHuman** 遥测 | §2.8.8 | ⚠️ 决策内有；**前端/JSONL 端到端** 未验收 |

---

## 5. 缺少的验收与工程化

### 5.1 附录 B 检查表（[`双模方案2.md`](./双模方案2.md) 附录 B）

| 子集 | 项数（约） | 代码/测试状态 |
|------|------------|----------------|
| 门禁子集 | 5 | ToolGate 有实现；**takeover 相关项无法测** |
| Execution Mode 子集 | 13 | **多数**有单测；文档 `[ ]` 未同步勾选 |
| **全量验收** | 10 | **均未**自动化 |

### 5.2 任务执行文档 — 6 场景联调（[`任务执行文档.md`](./任务执行文档.md)）

| 场景 | 期望 | 自动化 |
|------|------|--------|
| A 纯读取 | 必须 free | ❌ |
| B 小编辑 | 可 free | ❌ |
| C 新增模块 | 应 forced | ❌ |
| D 多文件重构 | 应 forced | ❌ |
| E checkpoint 恢复 | 必须 forced | ❌ |
| F graph 构建失败 | degraded forced | ❌ |

### 5.3 计划任务（T01–T13）与缺口映射

| 任务 | 内容 | 状态 |
|------|------|------|
| T01–T02 | 类型、GlobalPolicy | ✅ |
| T03–T05 | RiskClassifier、ModeDecisionEngine、RuntimeState | ✅ |
| T06–T07 | Harness evaluate、I10 dwell | ✅ 主体 |
| T08 | checkpoint 持久化 execution mode | ✅ L2-6：`RuntimeSupervisorCheckpointState` 增加 supervisorPhase / recoverySupervisorSnapshot / timelineTail / correctionBudgetUsed；`bridge.restoreFromCheckpoint` 推回内部状态机 |
| T09 | 全模块 submitSignal | ✅ L2-6 收口（全仓 grep 验证） |
| T10–T12 | ToolGate、CorrectionPort、forced degraded | ✅ L2-6：free 段 inject 经 `bridge.createCorrectionPort` 统一带 budget；ToolGate / forced degraded 由 L2-3/L2-5 串联 |
| T13 | 附录 B 全量 regression | ❌ |
| **（规格外显）** | M1–M10 监管模块 | ❌ |

---

## 6. 建议实现顺序（补齐完整双模）

与附录 C 迁移计划一致，在 **不改动 L1 已冻结行为** 的前提下：

1. **M10 EventTimeline** + shadow 写入（支撑观测与验收）
2. **M1 PassiveObserver**（收口 free 段 inject，只产 signal/timeline）
3. **M2 RecoverySupervisor** 骨架：`evaluate` / `applyTakeover` / phase 状态机
4. **M9 RecoveryBudgetManager** + `user_checkpoint` 出口
5. **M3 GoalDriftDetector**（先 V1 启发式，再可选 M4 LLM）
6. **M5–M8** takeover 路径：Workspace 提取 → Confidence → Safety → RetrospectiveGraph
7. **T08/T09 收尾**：checkpoint 恢复 phase + 全模块只 submitSignal（无直写 executionMode）
8. **strict / CorrectionBudget** 与 GraphExecutor hint 完全经 CorrectionPort

（**功能完备即止**；以下为自行验收，非开发必做）

9. **T13 / 附录 B / 6 场景**：自动化测试与手工联调清单 — 维护者验收时选用

---

## 7. 与 README / 其它文档的关系

| 文档 | 用途 |
|------|------|
| **本文档** | 开发排期：缺什么模块、缺什么功能 |
| [`双模方案2.md`](./双模方案2.md) | 设计与接口 **权威来源** |
| [`任务执行文档.md`](./任务执行文档.md) | 分批实施与 Opus 审计提示词 |
| [`README.zh-CN.md`](../README.zh-CN.md) §3.6 | 用户向简述；可链接本文档 |

**何时可改称「双模功能完备」：** §3 的 M1–M10 均在 `src/harness/supervisor/`（或约定路径）有实现；§4 行为在代码路径上可触发（含 `takeover` / `handoff` / EventTimeline 写入）；Harness 四钩子按 §14.1 接通；`ICE_SUPERVISOR_MODE=off` 时无 Supervisor 额外 inject。

**何时可改称「双模规格验收通过」：** 由维护者自行对照附录 B + [`任务执行文档.md`](./任务执行文档.md) 6 场景 — **与功能完备独立**。

---

## 9. 实施前审阅（文档完整性）

### 9.1 结论：**可以开工**，建议按本节 checklist 执行

| 维度 | 评价 |
|------|------|
| **缺口范围（§3–§4）** | ✅ 与 [`双模方案2.md`](./双模方案2.md) §8、§9、§14 一致；M1–M10 覆盖 L2 主体 |
| **已有基线（§2）** | ✅ 避免重复做 T01–T07 / Batch 1–3 |
| **实现顺序（§6）** | ✅ 合理；与 §10 批次表一致即可 |
| **完成定义（文首 + §7）** | ✅ 功能完备 vs 验收已区分 |

### 9.2 实施前需知晓（原文档未写清）

1. **T01–T12 / 任务执行文档 Batch 1–5 已完成** — 新工作从 **§10 L2 批次** 开始，不要重做 ModeDecisionEngine / ToolGate。  
2. **M4 RiskEvaluator（LLM）为 V1 可选项** — 功能完备可先只做 M3 启发式；`llmGrayZoneLow/High` 后续再接 M4。  
3. **`recordTaskBearingRoundIfForced` 已有** — `execution-mode-constraints.ts`，`harness-tool-round.ts` 已调用；L2 只需保证 takeover 期间计数与 I10 仍一致。  
4. **必须迁移的旧路径** — `harness-resilience.ts` 内 `msgs.push` 恢复信号（约 127 行）须迁入 PassiveObserver + RecoverySupervisor，否则 I4/§19.6 不成立。  
5. **规格要求 bridge** — Harness 四钩子应只调 **`SupervisorRuntimeBridge`**（可新建 `supervisor-bridge.ts`），内部组合 M1/M2/M10，避免 `harness.ts` 再散落监管逻辑。  
6. **§9 接管三条件**（[`双模方案2.md`](./双模方案2.md) §9）— `evaluate` 仅在 **三者同时满足** 时 `takeover`：① 关键任务域（`shouldUseTaskGraph(intent)` 或 strict）；② 风险超阈（`TaskRiskClassifier` + `riskThreshold`）；③ 异常触发（`SupervisorTriggers`：重复失败 / 无进展 / 文件循环 / goal drift / scope creep / 用户强制）。  
7. **与 TaskGraph** — 不删除 TaskGraph；M8 与 `task-graph-builder.ts` / `GraphExecutor.replaceGraph` 协作（见 README §3.4）。

### 9.3 文档仍可加强（不阻塞开工）

- 各模块 **单测文件命名** 可在实现时按 `test/harness/<module>.test.ts` 补齐，不必预先写死在本文档。  
- **前端** `task_graph_*` / execution mode 遥测展示 — 非功能完备硬要求，可后做。  
- **`LifecycleGate`** — 规格主循环示意有，仓库若无可先由 RecoverySupervisor.evaluate 覆盖 continue/stop。

---

## 10. L2 实施批次（建议 commit 粒度）

> 前置：**禁止**改动 L1 已冻结语义（I5/I6/I10、signal 优先级、off 回落）除非修 bug。每批后：`npx tsc --noEmit` + `npm test`。

| 批次 | 目标 | 主要交付 | 建议勾选 |
|------|------|----------|----------|
| **L2-1** | 可观测 | M10 `event-timeline.ts`；`SupervisorRuntimeBridge` 骨架；shadow 只写 timeline | ☑ |
| **L2-2** | 观察收口 | M1 `passive-observer.ts`；审计并收窄 `harness-resilience.ts` inject | ☑ |
| **L2-3** | 接管核心 | M2 `recovery-supervisor.ts`（evaluate/applyTakeover/applyHandoff）；`supervisorPhase` 状态机；CorrectionPort 驱动 `takeover` 块 | ☑ |
| **L2-4** | 预算与漂移 | M9 `recovery-budget-manager.ts`（`user_checkpoint`）；M3 `goal-drift-detector.ts`（V1 启发式）；消费 `SupervisorTriggers` | ☑ |
| **L2-5** | 恢复主路径 | M5→M6→M7→M8；`GraphExecutor.replaceGraph`；§10 主路径 vs §19.2 降级旁路 | ☑ |
| **L2-6** | 挂钩与持久化 | Harness §14.1 四钩子经 bridge；T08 phase/timeline checkpoint；T09 全模块 submitSignal；I4 CorrectionBudget | ☑ |
| **L2-7** | 模式与门禁 | strict 首轮 `task_graph_init`；`composeGraphHint` / graph-hint 全走 CorrectionPort；`RecoveryBoundary`（可并入 M2 或 `correction-port`） | ☑ |
| **L2-8** | 功能完备自检 | 对照 §11 DoD 逐项勾选；`ICE_SUPERVISOR_MODE=off` 回归 | ☑ |

---

## 11. 模块功能完备 DoD（开发自检）

实现后在本节打勾（**= 文首「功能完备」**）。

| 模块 | Definition of Done |
|------|-------------------|
| **M10** | 向 `eventTimeline.persistPath` 追加 JSONL；事件含 switch/recover/handoff/drift/failure；shadow 记 `shadow_diagnostic` 且不改 phase | ☑ L2-1 |
| **M1** | `observe()` 每工具轮后运行；产出 DeviationSignal / timeline；**不**在 free 段重复长策略 `msgs.push`（supervisor 活跃时） | ☑ |
| **M2** | `evaluate()` 实现 §9 三条件；`applyTakeover`/`applyHandoff`；phase：free→takeover→handoff_pending→handoff→cooldown；takeover 期间 **禁止** ModeDecisionEngine 将 executionMode 降 free | ☑ |
| **M3** | 连续 N 轮 alignment 低于 `alignmentThreshold` → submit `goal_drift`（或等价 signal） | ☑ |
| **M4** | （可选）灰区走 LLM；未做则 M3 启发式即可 | — |
| **M5–M8** | takeover 走 §10 主路径；失败走 §19.2 降级；confidence 低于 0.65 不走一级模板图 | ☑ |
| **M9** | 恢复轮数/token/重试达 §17 上限 → `SupervisorDecision.fail` / `user_checkpoint` | ☑ |
| **Bridge** | `harness.ts` / `harness-tool-round.ts` 仅通过 bridge 调 M1/M2/M10，无新增散落 `if (supervisor)` | ☑ L2-6 |
| **T08** | checkpoint `runtimeV2.supervisorState` 恢复 phase + 必要 timeline 指针；恢复时 submit `checkpoint_resumed` | ☑ L2-6 |
| **T09** | GraphExecutor、CheckpointEngine、StopHook、resilience **不**直写 `executionMode` | ☑ L2-6 |
| **I4** | free 段 `CorrectionBudget.freeSegmentMaxPerTask` 生效 | ☑ L2-6 |
| **RecoveryBoundary** | phase × source × kind 单一硬门禁；free→takeover 拒；takeover→非 supervisor 拒；handoff_pending/cooldown→非 supervisor recovery 拒；timeline `failure:recovery_boundary_rejected:*` | ☑ L2-7 |
| **composeGraphHint** | Harness/Graph evaluateRound / step warn / step block 三处 hint 唯一经 `bridge.composeGraphHint` → CorrectionPort；free 段 drop；timeline `recover:graph_hint:*` | ☑ L2-7 |
| **firstRoundGraph** | strict 关键域第 1 轮 `task_graph_init`；adaptive 关键 intent 跳过首轮 init（§I3）；off fallback `shouldUseTaskGraph` | ☑ L2-7 |
| **off** | `modeDecisionEngineEnabled=false` 时 bridge 早退；零 CorrectionPort takeover 块；shouldInitTaskGraphAtFirstRound 退回 `shouldUseTaskGraph` 兼容 | ☑ L2-8 |

---

## 12. Harness 建议触点（实现时对照）

| 文件 | L2 变更要点 |
|------|-------------|
| `src/harness/harness.ts` | bridge 调用；before-LLM 后可选 `recoverySupervisor.evaluateBeforeReply`；禁止新增监管散落逻辑 |
| `src/harness/harness-tool-round.ts` | after tools：`passiveObserver.observe` + `recoverySupervisor.evaluate`；已有 `recordTaskBearingRoundIfForced` 保持 |
| `src/harness/harness-round-prep.ts` | 向 bridge 提供 round / planned tools / graph 只读快照 |
| `src/harness/harness-resilience.ts` | **迁移** branch recover 的 `msgs.push` → signal + takeover 路径 |
| `src/harness/harness-checkpoint.ts` / `checkpoint-engine.ts` | T08 supervisorState 扩展；恢复只 submit signal |
| `src/harness/task-graph-executor.ts` | submitSignal；`replaceGraph`；strict 下首轮 init；hint 不直连 msgs |
| `src/harness/supervisor/supervisor-bridge.ts` | **新建** — 聚合 config、M1、M2、M10、GlobalPolicy |
| `src/types/runtime-checkpoint.ts` | `supervisorState` 增加 phase、timeline 游标等（向后兼容） |
| `src/types/supervisor.ts` | 按需补 `SupervisorEvaluateContext`、`TakeoverContext`、`SupervisorDecision` |
| `src/harness/types.ts` | `HarnessStepEvent` 可扩展 execution_mode / supervisor_phase（注意前端兼容） |

---

## 13. 规格章节速查（实现时打开）

| 主题 | 章节 |
|------|------|
| 公理 I4–I10、Execution Mode | §2.6–§2.8 |
| 接管三条件、异常触发项 | §9 |
| 恢复主路径 | §10 |
| Harness 四钩子、CorrectionPort、ToolGate | §14.0–§14.4 |
| 配置字段默认值 | §15、§17、`data/supervisor-config.example.json` |
| 类型与 API 签名 | 附录 A |
| 附录 C 文件级接入清单 | 附录 C.3 |

---

## 14. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-05-21 | 初版：对照 V1.3.7 与 `src/harness/supervisor/` 十文件现状 |
| 2026-05-21 | 区分「功能完备」与「规格验收」；验收由维护者自行安排 |
| 2026-05-21 | 新增 §9–§13：实施审阅、L2 批次、DoD、Harness 触点、规格速查 |
| 2026-05-21 | L2-3 接管核心落地：M2 `recovery-supervisor.ts`、`SupervisorRuntimeBridge.evaluateAfterRound` 驱动 free→takeover→handoff_pending→handoff→cooldown，shadow 不变 phase；新增 12 用例（recovery-supervisor.test.ts + bridge 集成），全套 961 用例绿 |
| 2026-05-21 | L2-4 预算与漂移落地：M9 `recovery-budget-manager.ts`（轮数/token/重试三维预算，耗尽返回 `fail{checkpoint}` + timeline `failure:budget_exhausted:*`）；M3 `goal-drift-detector.ts`（V1 启发式 alignment，连续 N 轮 < `alignmentThreshold` 产 `goal_drift`）；`PassiveObserver.pushSignal` + `bridge.submitManualTrigger` 收口 `scope_creep`/`user_force_takeover` 并尊重 `SupervisorTriggers` toggle；新增 34 用例（recovery-budget-manager / goal-drift-detector / bridge L2-4），全套 995 用例绿 |
| 2026-05-21 | L2-5 恢复主路径落地：M5 `workspace-state-extractor.ts`（RepoContext/TaskState → WorkspaceSnapshot，纯启发式无 LLM）；M6 `snapshot-confidence-evaluator.ts`（5 因子加权求和 + 归一化权重 + `templateGraphMin` 阈值）；M7 `recovery-safety-checker.ts`（关键文件/repo/branch/编译基线四维检查 + `humanReason` 摘要）；M8 `retrospective-graph-builder.ts`（复用 `buildGraph` 按 intent 走模板图 + snapshot 证据自动标记 `inspect`/`search`/`verify` 节点 done + 推进 cursor）；`GraphExecutor` 新增 `replaceGraph`/`setEvaluationMode`/`enterTakeover`/`exitTakeover`，接管段 `evaluateRound` 强制 metrics_only（§19.3）；`SupervisorRuntimeBridge.runRecoveryMainPath` 串联 §10 主路径与 §19.2 二级强提示（confidence/safety/builder 任一失败 → 经 CorrectionPort 注入单条 `[System Recovery]` 块，仍保持 forced）；shadow 段不调用 `replaceGraph` 也不写 msgs；新增 36 用例（workspace-state-extractor / snapshot-confidence-evaluator / recovery-safety-checker / retrospective-graph-builder / GraphExecutor L2-5 / bridge L2-5），全套 1031 用例绿 |
| 2026-05-21 | L2-6 挂钩与持久化落地：① §14.1 after-round 钩子接 `bridge.evaluateAfterRound`（`harness-tool-round`），fail{checkpoint} 经 `loopController.stop('user_checkpoint')` 串联 `handleHarnessStop`；② T08 持久化：`RuntimeSupervisorCheckpointState` 新增 `supervisorPhase` / `recoverySupervisorSnapshot` / `timelineTail` / `correctionBudgetUsed`，`bridge.snapshotForCheckpoint` + `restoreFromCheckpoint` round-trip，`harness-resilience.buildSupervisorCheckpointState` 合并 bridge snapshot，restore 时写 `failure:checkpoint_resumed` timeline 标记；③ T09 收尾：grep 全仓确认仅 `execution-mode-constraints.ts` 写 `executionMode`；④ I4 `CorrectionBudgetTracker`（新建 `correction-budget.ts`）+ `MessageCorrectionPort` 集成 + `bridge.createCorrectionPort` 工厂（free 段 supervisor recovery/graph_hint 超 `freeSegmentMaxPerTask` 即 drop + `failure:correction_budget_exhausted` timeline）；⑤ `bridge.resetForNewTask` 在 Harness `run()` 入口复位 observer/drift/budget/RecoverySupervisor phase；新增 17 用例（correction-budget 8 + supervisor-bridge L2-6 hooks/checkpoint/budget 9），全套 1048 用例绿 |
| 2026-05-21 | L2-7 模式与门禁落地：① M11 `RecoveryBoundary`（新建 `recovery-boundary.ts`）— phase × source × kind 单一硬门禁，三类拒绝原因 `free_phase_rejects_takeover_block` / `takeover_phase_requires_supervisor_source` / `handoff_phase_rejects_non_supervisor_recovery`；② `MessageCorrectionPort` 新增 `recoveryBoundary` + `onBoundaryRejected` 选项，boundary 拒在前于 budget；`bridge.createCorrectionPort` 失败回 timeline `failure:recovery_boundary_rejected:*`；③ `bridge.composeGraphHint` 收口 `harness-tool-round` 三处 graph_hint inject（forced step warn / forced step block / evaluateRound force_switch），free 段统一 drop，forced 段经 port + timeline `recover:graph_hint:*`；④ `bridge.shouldInitTaskGraphAtFirstRound`：strict→strict.firstRoundGraph、adaptive→adaptiveFree.firstRoundGraph（默认 false 兑现 §I3）、off→`shouldUseTaskGraph` 兜底；`harness-round-prep` 在 bridge 注入时改走 bridge 判定；⑤ off 模式回归：harness/execution-mode-harness/execution-mode-acceptance 88 用例 ICE_SUPERVISOR_MODE=off 全绿；新增 20 用例（recovery-boundary 12 + supervisor-bridge L2-7 8），全套 1068 用例绿 |
| 2026-05-21 | L2-8 功能完备自检：① 对照 §11 DoD 逐项确认 M1/M2/M3/M5-M8/M9/M10/Bridge/T08/T09/I4/RecoveryBoundary/composeGraphHint/firstRoundGraph/off 全部 ☑；② `ICE_SUPERVISOR_MODE=off` 跑 harness/execution-mode-harness/execution-mode-acceptance 共 88 用例零回归；③ 全测试套件 85 文件 1068 用例绿，`npx tsc --noEmit` 0 error；④ 文首「功能完备」DoD 收口 |
