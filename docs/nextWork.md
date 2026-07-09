# nextWork.md

本文档记录 iceCoder 下一阶段应继续优化的工作。README 只描述当前架构和已完成能力；本文件用于拆解后续实现计划。

## 1. 压缩恢复强化 — 后续增强

### 目标

硬压缩后仍能稳定恢复当前任务，不靠自然语言历史猜测。

### 待做

- 将 Runtime Recovery Context 同步写入 session notes，提升进程重启后的恢复能力。
- 增加压缩前后 token 统计。
- 将恢复上下文拆成更小的预算单元。
- 压缩后任务恢复成功率目标 `>95%`（需正式 Eval Runner 量化）。

当前压缩后的消息顺序：

```text
system
context-summary/session-notes
runtime-recovery-context
recent messages
recovery prompt
```

---

## 2. Memory v2 — 后续增强（可选）

### 目标

记忆只辅助当前任务，不抢占当前任务。

### 待做

1. Dream 整合时合并同主题偏好、降低旧偏好置信度。
2. Eval 量化：执行型任务记忆注入 token 下降 `20-50%`、噪声记忆新增下降 `30-60%`。

---

## 3. Agent Eval Runner — 仍需加强

### 目标

用数据证明系统变强，而不是凭感觉调 prompt。

### 待做

1. 纳入统一 CI 入口（可选 `npm run eval:taskgraph` 与 `scripts/eval-runner.ts` 联动）。
2. 与 Runtime Telemetry 做跨次趋势对比看板或汇总脚本。
3. 扩展 case 覆盖面与模型批次固定策略（避免同次对比混模型）。

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

---

## 4. Runtime Telemetry 落盘

### 目标

把运行时行为变成可观测数据。

### 待做

1. 权限裁决、验证状态等字段在事件中的覆盖度与一致性（与 Eval 指标对齐）。
2. **会话级与跨会话汇总**、CI 可读报告、简单看板或 `npm run` 汇总脚本。
3. 与 `scripts/agent-eval.ts` **real** 模式打通跨会话汇总（Agent runner 已写沙箱 telemetry）。

### 验收标准

- 能统计 `no_tool_final_rate`。
- 能统计 `verification_rate`。
- 能统计 `tokens_per_successful_task`。
- 能统计 `compaction_saved_tokens`。

---

## 5. Tool Planner — 后续（可选）

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
