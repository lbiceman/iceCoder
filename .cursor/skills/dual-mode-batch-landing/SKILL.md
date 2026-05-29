---
name: 双模 L2 批次收口落地
description: |
  本项目「双模方案 V1.3.7」L1（Execution Mode）/ L2（Runtime Supervisor）的批次收口约定。
  触发词：双模、supervisor、ExecutionMode、RecoverySupervisor、PassiveObserver、CorrectionPort、
  RecoveryBoundary、composeGraphHint、firstRoundGraph、ICE_SUPERVISOR_MODE、L2-1 ~ L2-8、
  双模落地缺口、双模方案2、附录 B、I1/I3/I4/I5/I6/I10、shadow 模式。
---

# 双模 L2 批次收口落地（SKILL）

## 触发场景

修改 `src/harness/supervisor/`、`src/harness/harness-tool-round.ts`、`src/harness/harness-round-prep.ts`、`src/harness/harness-resilience.ts`、`src/types/supervisor.ts`、`src/types/runtime-checkpoint.ts`，或问到「双模 / L2 / 接管 / RecoveryBoundary / composeGraphHint」时使用。

## 关键文件

| 路径 | 角色 |
|------|------|
| [`docs/双模方案2.md`](../../../docs/双模方案2.md) | 设计与接口**权威来源**（V1.3.7 冻结） |
| [`docs/双模落地缺口.md`](../../../docs/双模落地缺口.md) | 开发排期 / 缺口对照 / §10 批次表 / §11 DoD |
| [`docs/任务执行文档.md`](../../../docs/任务执行文档.md) | Batch 1–6 历史 / 6 场景验收 prompt |
| [`docs/双模 L2 审计与优化清单.md`](../../../docs/双模%20L2%20审计与优化清单.md) | L2-8 后审计：P0/P1/P2/P3 优化项 + 文件设计 + 代码骨架 |
| [`docs/环境变量.md`](../../../docs/环境变量.md) | `ICE_SUPERVISOR_*` 等 env 用途与合法取值 |
| [`docs/test.md`](../../../docs/test.md) | 双模完整测试手册（6 场景 + 附录 B + 自动化命令） |

## 公理（任何修改都不得违反）

| 公理 | 含义 |
|------|------|
| **I1** | C 类纠偏写 `msgs` 必须过 `RecoveryBoundary.mayInjectCorrection` + `CorrectionPort`，禁止旁路 `msgs.push` |
| **I3** | `adaptive` 关键 intent 第 1 轮**不** init TaskGraph（由 RecoverySupervisor 接管后 replaceGraph 重建）；strict 才 init |
| **I4** | free 段 supervisor 的 recovery/graph_hint 受 `CorrectionBudget.freeSegmentMaxPerTask` 约束 |
| **I5** | 仅 `execution-mode-constraints.ts` 写 `state.executionMode`；其它模块只 `submitModeSignal` |
| **I6** | `ICE_SUPERVISOR_*` env 仅在 `mode-controller.ts` 解析；业务模块不读 |
| **I10** | forced 退出前必须达到 `forcedMinDwellRounds` 个 task-bearing round |
| **T09** | GraphExecutor / CheckpointEngine / StopHook / resilience 都**只** submitSignal |

## 已落地批次速查

| 批次 | 关键产出 | 主要文件 |
|------|----------|----------|
| L2-1 | EventTimeline + bridge 骨架 + shadow 写 timeline | `event-timeline.ts` / `supervisor-bridge.ts` |
| L2-2 | PassiveObserver 收口 free 段 inject | `passive-observer.ts` / `harness-resilience.ts` 改造 |
| L2-3 | RecoverySupervisor evaluate/applyTakeover/applyHandoff + phase 状态机 | `recovery-supervisor.ts` |
| L2-4 | RecoveryBudgetManager + GoalDriftDetector + 手动触发 trigger | `recovery-budget-manager.ts` / `goal-drift-detector.ts` |
| L2-5 | §10 主路径 M5→M6→M7→M8 + GraphExecutor.replaceGraph + §19.2 二级强提示 | `workspace-state-extractor.ts` / `snapshot-confidence-evaluator.ts` / `recovery-safety-checker.ts` / `retrospective-graph-builder.ts` |
| L2-6 | §14.1 四钩子接入 + T08 checkpoint round-trip + T09 收口 + I4 CorrectionBudget | `correction-budget.ts` / `harness-tool-round.ts` / `harness.ts` |
| L2-7 | RecoveryBoundary + composeGraphHint + shouldInitTaskGraphAtFirstRound | `recovery-boundary.ts` / bridge 扩展 / `harness-round-prep.ts` |
| L2-8 | §11 DoD 全勾选 + off 回归 + 修订记录 | 缺口文档 |
| P0-2 | RecoveryBoundary 独占 phase×source×kind；CorrectionBudget 只计数 | `recovery-boundary.ts` / `correction-budget.ts` |
| P1 | round 落账 / composeGraphHint discriminated union / supervisorPhase 必填 / 缺口 §1 ASCII | `mode-gating.ts` / `supervisor-bridge.ts` / `harness-run-state.ts` |

## P1 收口约定（审计清单 §2.3–§2.6）

- **`createCorrectionPort(msgs, round?)`**：bridge 维护 `currentRound`；budget/boundary 失败 timeline 用 `ctx.round ?? currentRound`，禁止 `round: -1`。
- **`composeGraphHint`**：入参为 `ComposeGraphHintArgs` + discriminated union `GraphHintInput`（`evaluate_round` | `forced_step`）；实现集中在 `mode-gating.ts` 的 `runComposeGraphHint`。
- **`HarnessRunState.supervisorPhase`**：必填；子模块直接读，不写 `?? 'free'`。
- **缺口文档 §1 ASCII**：须含 RecoveryBoundary + composeGraphHint 子框。

## P2 测试收口（审计清单 §2.7–§2.10）

| 项 | 文件 |
|----|------|
| P2-1 RecoveryBoundary 4×4×4 矩阵（64 用例） | `test/harness/recovery-boundary.test.ts` |
| P2-2 任务执行文档 6 场景 e2e | `test/e2e/dual-mode-scenarios.test.ts` + `_fixtures/dual-mode-mocks.ts` |
| P2-3 L2 流程图 | `docs/双模 L2 流程图.md` |
| P2-4 firstRoundGraph 集成 | `test/harness/execution-mode-harness.test.ts` + `test/harness/harness-round-prep-first-graph.test.ts` |

e2e fixture 必须注入 `supervisorBridge: createSupervisorRuntimeBridge(...)`，否则 adaptive §I3 门禁不生效。

## P3-2 / P3-5 使用约定

- **P3-2 实时 UI**：WebSocket `execution_mode_enter/exit` → `ChatExecutionPlan.applyExecutionModeEvent`；冰豆 `#status-turn` 显示 `forced · <主信号>`，hover/点击 popover 看 `primaryReasonHuman` + 信号列表。
- **P3-5 历史报告**：聊天输入 `~supervisor`（同 `~telemetry` 模式）；API `GET /api/supervisor/events?days=7&event=recover&limit=10`；JSON 加 `format=json`。

## 实施步骤（新增/修改 L2 时遵循）

1. **先读规格**：对照 [`双模方案2.md`](../../../docs/双模方案2.md) 找到对应 § 节；
2. **再读缺口文档**：确认所在批次 / DoD 项；
3. **改代码**：
   - 信号只 `submitModeSignal`（I5/T09），不直写 `executionMode`；
   - C 类 inject 必经 `bridge.createCorrectionPort` → 自动挂 boundary + budget；
   - graph hint 必经 `bridge.composeGraphHint`，禁止直接 `port.inject({ kind: 'graph_hint', ... })`；
   - off 模式分支必须保留（`bridge.isActive()===false` 早退，行为与旧 Harness 一致）。
4. **测试**：每改一处必须能找到对应 `test/harness/*.test.ts`；
5. **跑回归**：
   - `npx tsc --noEmit`
   - `npm test`
   - **`ICE_SUPERVISOR_MODE=off` 跑 harness/execution-mode-harness/execution-mode-acceptance 三套**（off 兼容验收）。
6. **更新文档**：
   - 缺口文档 §2 / §3 / §4 / §10 批次表 / §11 DoD / §14 修订记录；
   - 审计清单 §1（如发现新不合理点） / §5 修订记录。

## 反模式（必须避免）

- ❌ 在 `harness-tool-round.ts` / `harness-resilience.ts` 直接 `msgs.push({ role: 'user', content: '[System] ...' })`：违反 I1 / §19.6，必须经 CorrectionPort。
- ❌ 在子模块（GraphExecutor / CheckpointEngine / StopHook / resilience）写 `state.executionMode = 'forced'`：违反 I5 / T09，应 submitModeSignal。
- ❌ 读 `process.env.ICE_SUPERVISOR_MODE`：已废弃；档位在 `config.json` 的 `supervisorMode`，业务模块从 `globalPolicy.supervisorMode` 读。
- ❌ 在 `adaptive` 关键 intent 上首轮 `initGraph`：违反 I3，应经 `bridge.shouldInitTaskGraphAtFirstRound(intent)` 门禁。
- ❌ 在 `MessageCorrectionPort` 外另起 port 写 takeover/recovery：绕过 boundary + budget，违反 I1 / I4。

## 写后读 Gate 豁免（verification）

- 实现：`src/harness/document-deliverable.ts` + `verification-exempt-config.ts`；Harness `run()` 按工作区加载。
- **内置**：`.tmp/.bak` 后缀、`tmp/`/`temp/` 相对目录、**任意父级目录段以 `.` 开头**（如 `.scratch/`、`.cache/`）；`scripts/` 等普通目录**不**豁免。
- **项目自定义**：`data/config.json` 或工作区 `.icecoder.json` / `icecoder.json` 的 `verificationExemptDirs`（非点开头的目录前缀，如 `tmp/agent`）；可选 env `ICE_VERIFICATION_EXEMPT_DIRS`。
- 仍记入 `filesChanged` 审计，但不要求 `file_info` 写后确认。

## 敏感信息

本 skill 不含任何凭据 / token / 内部 URL；所有路径都是仓库内相对路径。
