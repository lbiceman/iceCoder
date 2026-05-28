# nextWork.md

本文档记录 iceCoder 下一阶段应继续优化的工作。README 只描述当前架构和已完成能力；本文件用于拆解后续实现计划。

## 1. 压缩恢复强化（已完成核心能力）

### 目标

硬压缩后仍能稳定恢复当前任务，不靠自然语言历史猜测。

### 已完成

1. `ContextCompactor.buildRuntimeRecoveryContext(taskState, repoContext)` 已实现。
2. `Harness.maybeCompact()` 硬压缩后会重新注入结构化 Runtime State + Repo Context。
3. 已补回归测试，确认恢复消息包含当前目标、改动文件和验证命令。

### 后续增强

- 将 Runtime Recovery Context 同步写入 session notes，提升进程重启后的恢复能力。
- 增加压缩前后 token 统计。
- 将恢复上下文拆成更小的预算单元。

当前压缩后的消息顺序：

```text
system
context-summary/session-notes
runtime-recovery-context
recent messages
recovery prompt
```

### 验收标准

- 长会话压缩后仍保留当前任务目标。（已测）
- 长会话压缩后仍保留改动文件列表。（已测）
- 长会话压缩后仍保留下一步验证命令。（已测）
- 压缩后任务恢复成功率目标 `>95%`。（需正式 Eval Runner 量化）

---

## 2. Memory v2 结构化分级

### 目标

记忆只辅助当前任务，不抢占当前任务。

### 需要做什么

1. 给记忆增加层级字段：
   - `hard_rule`
   - `project_fact`
   - `preference`
   - `observation`
   - `session_state`
2. 增加 `evidenceStrength`：
   - `explicit`
   - `repeated`
   - `inferred`
   - `weak`
3. 召回阶段按任务类型过滤记忆。
4. 冲突记忆同轮只注入一侧。

### 如何做

- 扩展 memory frontmatter 或派生索引，不必一次性迁移旧文件。
- 在 `memory-recall.ts` 中加入 `filterByMemoryLevelForIntent()`。
- 在 `memory-llm-extractor.ts` 输出中增加层级推断。
- Dream 整合时合并同主题偏好，降低旧偏好置信度。

### 验收标准

- 旧偏好“不要改代码”不能阻止当前明确“请修改代码”。
- 同主题冲突记忆不会同轮同时注入。
- 执行型任务记忆注入 token 下降 `20-50%`。
- 噪声记忆新增下降 `30-60%`。

---

## 3. 正式 Agent Eval Runner

### 目标

用数据证明系统变强，而不是凭感觉调 prompt。

### 需要做什么

1. 把 `scripts/agent-eval.ts` 从指标骨架升级为可执行 runner。
2. 支持 mock LLM 和真实 LLM 两种模式。
3. 为每个 case 输出 pass/fail 和指标。
4. 支持 JSONL 历史记录，便于趋势对比。

### Eval Case

至少覆盖：

- 单文件修改
- 测试失败修复
- 多文件重构
- 工具失败恢复
- 长会话压缩恢复
- 记忆冲突场景
- 禁工具/评测模式一致性

### 指标

- `task_success_rate`
- `tool_call_rate`
- `first_tool_latency`
- `no_tool_final_rate`
- `verification_rate`
- `repeat_failure_rate`
- `memory_interference_rate`
- `tokens_per_successful_task`
- `compaction_saved_tokens`

### 验收标准

- `npm run eval:agent` 可执行并输出每个 case 的结果。
- P0 指标下降时能返回非 0 exit code。
- 每次 Harness/Prompt/Memory 改动都能跑 eval 对比。

---

## 4. Runtime Telemetry 落盘

### 目标

把运行时行为变成可观测数据。

### 已完成（初版）

1. `src/harness/runtime-telemetry.ts` 已实现，`Harness` 构造时启用。
2. JSONL 默认路径：`data/runtime/telemetry.jsonl`（或通过 `ICE_RUNTIME_DIR` 指定根目录下的 `telemetry.jsonl`）。
3. 事件类型包括：`round`、`tool`、`compaction`、`summary`（含部分 token 与验证相关字段）。

### 仍需加强

1. 权限裁决、验证状态等字段在事件中的覆盖度与一致性（与 Eval 指标对齐）。
2. **会话级与跨会话汇总**、CI 可读报告、简单看板或 `npm run` 汇总脚本。
3. 与 `scripts/agent-eval.ts` **real** 模式打通：用完整 case 跑 Harness 后自动解析 JSONL 判分。

### 验收标准

- 能统计 `no_tool_final_rate`。
- 能统计 `verification_rate`。
- 能统计 `tokens_per_successful_task`。
- 能统计 `compaction_saved_tokens`。

---

## 5. Tool Planner

### 目标

让工具选择更像软件工程流程，而不是完全靠模型自由发挥。

### 需要做什么

按 intent 给出推荐工具链：

| Intent | 推荐流程 |
|---|---|
| `debug` | read error -> search/read files -> edit -> run focused test |
| `edit` | inspect related files -> edit -> verify |
| `test` | run test -> inspect failure -> edit -> rerun |
| `refactor` | inspect references -> batch/patch edit -> run tests |
| `inspect` | search/read only |

### 如何做

- 新增 `src/harness/tool-planner.ts`。
- 在 no-tool recovery 和 verification gate 中引用 planner 建议。
- 不强制覆盖 LLM，只提供 Runtime Policy 提示。

### 验收标准

- 首轮工具命中率提升 `20-40%`。
- 无效探索工具调用下降 `20-30%`。
- 重复失败调用下降 `50%+`。

---

## 6. 正式发布前清理

- 将 `.gitattributes` 和行尾归一化单独提交。
- 检查所有新文件是否纳入 Git。
- 将 [`docs/PROJECT-GUIDE.md`](./PROJECT-GUIDE.md) / [`docs/项目介绍.md`](./项目介绍.md) 与真实测试数量同步（以 `npm test` 为准）。
- 运行：

```bash
npx tsc --noEmit
npm test
npm run eval:agent
git diff --check
```

---

## 7. L2 反构图对接主循环（`runRecoveryMainPath`）— **已完成（2026-05-28）**

### 背景（勿忘）

- **L2-5 已落地**：`SupervisorRuntimeBridge.runRecoveryMainPath()` 串联 M5→M6→M7→M8（`WorkspaceStateExtractor` → 置信度 → 安全检查 → `RetrospectiveGraphBuilder` → `GraphExecutor.replaceGraph`）。见 [`双模方案2-finish.md`](./requirement/双模方案2-finish.md) §10。
- **L2-6 主循环只接了一半**：`harness-tool-round.ts` 在工具轮末调用 `bridge.evaluateAfterRound()`；决策为 `takeover` 时仅 `applyTakeover` 注入 `[System Recovery]` 文案，**未**调用 `runRecoveryMainPath`。
- **全仓 `src/` 零调用**：`runRecoveryMainPath` 仅在 `test/harness/supervisor-bridge.test.ts` 等单测中使用。
- **影响**：adaptive 下 critical 任务即使进入 `supervisorPhase=takeover`，也**没有**反构图重建 TaskGraph，模型仍按旧上下文自由试；与规格 §10 不一致。
- **不触发 takeover 的任务**（如 `non_critical_docs`）与此无关；本条针对 **edit/debug/test/refactor** 等 critical 域。

### 目标

takeover 决策后，Harness 主循环自动走 §10 恢复主路径；成功则 `replaceGraph`，失败则 §19.2 二级强提示（不 silent fail）。

### 需要做什么

1. 在 `harness-tool-round.ts`（或独立 helper）中：当 `evaluateAfterRound` 返回 `decision.action === 'takeover'` 且 **非 shadow** 时，调用 `bridge.runRecoveryMainPath(...)`。
2. 封装 `RecoveryMainPathContext` 构建（从 `HarnessRunState` / `RepoContext` / `TaskState` / 本轮 signals 组装）：
   - `extractInput`（workspace 快照输入）
   - `confidenceInput`（`roundsSinceExtract`、`lastVerifyPassed`、`repoFilesChanged`）
   - `graphExecutor`、`correctionPort`、`messages`
   - `signals`（来自 `bridge.getAccumulatedDeviationSignals()` 或本轮 decision）
3. 处理与 `applyTakeover` 的 **inject 顺序**：先 takeover 块，再主路径；主路径成功不再重复长 recovery；失败时 §19.2 降级 inject 仅一条。
4. **shadow 模式**：只写 timeline / 诊断，不 `replaceGraph`、不额外写 msgs（与 L2-5 行为一致）。
5. 主路径 `tier=template_graph` 成功后，确认 `GraphExecutor` 与 forced ToolGate / `composeGraphHint` 行为一致。
6. 可选：takeover 后首轮 `task_graph_init` 类 WS 事件是否与 strict 对齐（前端 execution plan）。

### 建议触点

| 文件 | 变更要点 |
|------|----------|
| `src/harness/harness-tool-round.ts` | `evaluateAfterRound` 后判断 takeover → `runRecoveryMainPath` |
| `src/harness/supervisor/supervisor-bridge.ts` | 已有 API；必要时加 `buildRecoveryMainPathContext` 工厂 |
| `src/harness/supervisor/workspace-state-extractor.ts` | `extractInput` 字段对照 |
| `src/harness/task-graph-executor.ts` | `replaceGraph` / `enterTakeover` |
| `test/harness/supervisor-bridge.test.ts` | 已有单测；补 **Harness 集成** 用例（mock takeover → 断言 replaceGraph） |
| `docs/harness/Harness-L2与Gate工作逻辑.md` | §4.3 补充「主循环已接 / 未接」状态 |

### 验收标准

- critical 任务在 Web/adaptive 下 **人为堆信号触发 takeover** 后，timeline 出现 `recover` 且 `GraphExecutor.hasGraph()` 为 true（confidence/safety 通过时）。
- confidence 低于 `templateGraphMin` 或 safety 失败时：不 replaceGraph，但有 §19.2 二级 `[System Recovery]` inject（经 CorrectionPort）。
- `ICE_SUPERVISOR_SHADOW=1` 时不 replaceGraph、不改 phase 行为与现网一致。
- `npm test` 新增/扩展用例绿；`npx tsc --noEmit` 通过。
- 与 [`docs/requirement/L2测试过程.md`](./requirement/L2测试过程.md) 中「takeover Web 未验证」缺口可关闭一条手工场景。

### 参考

- 规格：[`双模方案2-finish.md`](./requirement/双模方案2-finish.md) §9（三条件）、§10（主路径）、§19.2（降级）
- 缺口/批次：[`双模落地缺口-finish.md`](./requirement/双模落地缺口-finish.md) L2-5 / L2-6
- 流程图：[`双模 L2 流程图-finish.md`](./requirement/双模%20L2%20流程图-finish.md) §3
- bridge 注释：`runRecoveryMainPath` — 「在 evaluateAfterRound 决策为 takeover 后，由 Harness 调用」

### 落地摘要

- `harness-tool-round.ts`：`evaluateAfterRound` 返回 `takeover` 后调用 `applyTakeoverRecoveryMainPath`。
- `harness-recovery-main-path.ts`：组装 M5 入参、`replaceGraph` / §19.2 降级、`task_graph_init` WS。
- 置信度门槛：`data/supervisor-config.json` → `snapshotConfidence.templateGraphMin`（默认 0.65，可调权重）。
