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

## 2. Memory v2 结构化分级（部分已完成）

### 目标

记忆只辅助当前任务，不抢占当前任务。

### 已完成（2026-05）

1. 记忆层级字段 `memoryLevel` / `level`：`hard_rule`、`project_fact`、`preference`、`observation`、`session_state` 等已在 extract / recall / eviction 管线使用。
2. `evidenceStrength`（`explicit` / `repeated` / `inferred` / `weak`）已写入 frontmatter 并参与召回排序。
3. 召回阶段按 intent 过滤（`memory-recall.ts`）。
4. Web 记忆图谱页（`#/memory`）+ 顶栏「记忆」入口。

### 仍需加强

1. 冲突记忆同轮只注入一侧的策略与自动化测试。
2. Dream 整合时合并同主题偏好、降低旧偏好置信度。
3. Eval 量化：执行型任务 token 下降、噪声记忆新增下降等指标。

### 验收标准

- 旧偏好「不要改代码」不能阻止当前明确「请修改代码」。（部分场景已覆盖，需 Eval 固化）
- 同主题冲突记忆不会同轮同时注入。
- 执行型任务记忆注入 token 下降 `20-50%`。
- 噪声记忆新增下降 `30-60%`。

---

## 3. 正式 Agent Eval Runner（核心能力已完成）

### 目标

用数据证明系统变强，而不是凭感觉调 prompt。

### 已完成（2026-07）

1. `scripts/agent-eval-cases.ts` — 7 个固定 case（prompt、初始文件、断言、验证命令、记忆夹具）。
2. `scripts/agent-eval-runner.ts` — 临时沙箱、`initializeToolSystem`、`Harness.run`、规则判分、telemetry 读取。
3. `scripts/agent-eval.ts` — 默认 **real** 驱动 Harness；`--mode=mock` 无 API 烟测；`--case` / `--format` / `--keep-workspaces`。
4. JSONL 历史：`data/eval/agent-eval-history.jsonl`；失败或 P0 指标退化时非 0 exit code。

### 仍需加强

1. 纳入统一 CI 入口（可选 `npm run eval:taskgraph` 与 `scripts/eval-runner.ts` 联动）。
2. 与 Runtime Telemetry 做跨次趋势对比看板或汇总脚本。
3. 扩展 case 覆盖面与模型批次固定策略（避免同次对比混模型）。

### Eval Case（已覆盖）

- 单文件修改 — `single-file-edit`
- 测试失败修复 — `test-failure-fix`
- 多文件重构 — `multi-file-refactor`
- 工具失败恢复 — `tool-failure-recovery`
- 长会话压缩恢复 — `compression-recovery`
- 记忆冲突场景 — `memory-conflict`
- 禁工具/评测模式一致性 — `eval-mode-tools-disabled`

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

- `npm run eval:agent` 真实模式对每个 case 输出 pass/fail。（已测）
- P0 指标下降时能返回非 0 exit code。（已测）
- 每次 Harness/Prompt/Memory 改动都能跑 eval 对比。（可用；建议接 CI）

---

## 4. Runtime Telemetry 落盘

### 目标

把运行时行为变成可观测数据。

### 已完成（初版）

1. `src/harness/runtime-telemetry.ts` 已实现，`Harness` 构造时启用。
2. JSONL 默认路径：`data/runtime/telemetry.jsonl`（或通过 `ICE_RUNTIME_DIR` 指定根目录下的 `telemetry.jsonl`）。
3. 事件类型包括：`round`、`tool`、`compaction`、`summary`（含部分 token 与验证相关字段）。
4. 部分 execution_mode 事件经 `GET /api/supervisor/events` 可读。

### 仍需加强

1. 权限裁决、验证状态等字段在事件中的覆盖度与一致性（与 Eval 指标对齐）。
2. **会话级与跨会话汇总**、CI 可读报告、简单看板或 `npm run` 汇总脚本。
3. 与 `scripts/agent-eval.ts` **real** 模式打通：用完整 case 跑 Harness 后自动解析沙箱内 telemetry 判分。（Agent runner 已写沙箱 telemetry；跨会话汇总仍待加强）

### 验收标准

- 能统计 `no_tool_final_rate`。
- 能统计 `verification_rate`。
- 能统计 `tokens_per_successful_task`。
- 能统计 `compaction_saved_tokens`。

---

## 5. Tool Planner（已完成）

### 目标

让工具选择更像软件工程流程，而不是完全靠模型自由发挥。

### 已完成（2026-05）

- `src/harness/tool-planner.ts` 已接入 `harness-round-prep.ts` 与 `harness-round-no-tools.ts`。
- 按 intent 注入推荐工具链提示（debug / edit / test / refactor / inspect），不强制覆盖 LLM。

### 后续（可选）

- 用 Eval 量化首轮工具命中率、无效探索下降幅度。

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

## 7. L2 反构图对接主循环 — **已完成（2026-05-28）**

### 已完成

- `harness-tool-round.ts` / `harness-supervisor-round.ts`：`evaluateAfterRound` 返回 `takeover` 后调用 `applyTakeoverRecoveryMainPath`。
- `harness-recovery-main-path.ts`：M5→M8 主路径、`replaceGraph` / §19.2 降级、`task_graph_init` WS。
- 置信度门槛：`snapshotConfidence.templateGraphMin`（默认 0.65）。
- shadow：`ICE_SUPERVISOR_SHADOW` 或 `supervisor-config.json` 的 `shadow` 字段（`off` 模式下强制 false）。

### 参考

- 规格：[`双模方案2-finish.md`](./requirement/双模方案2-finish.md) §9、§10、§19.2
- 流程：[`双模 L2 流程图-finish.md`](./requirement/双模%20L2%20流程图-finish.md) §3

---

## 8. Web 后台任务进度 chip — **已接入**

### 已完成

- `chat-ws.ts`：`BgTaskPusher` + `rebindBgTaskPusher(sessionId)`（切换会话 / 每轮消息前绑定）。
- `run_command` 按 `sessionId` 隔离 `BackgroundTaskManager`（`resolveWorkspaceToolContext` 传入 session）。
- 聊天消息区底部 `.bg-status-container` 显示 running / 终态 chip（`bg_task_update`）。
