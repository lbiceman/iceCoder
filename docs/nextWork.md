# nextWork.md

本文档记录 iceCoder 下一阶段应继续优化的工作。README 只描述当前架构和已完成能力；本文件用于拆解后续实现计划。

已完成并从本文移除（对照代码 / README / PROJECT-GUIDE）：

- Runtime Recovery Context → `session-notes` 的 `icecoder-runtime` 快照与续聊 `hydrate` / `applySnapshot`
- 压缩前后 token 统计（`recordCompaction` → `beforeTokens` / `afterTokens` / `savedTokens`）
- Memory v2 主路径（分级 / 证据 / 冲突裁决）与 Tool Planner 主路径
- Memory v2 Dream 后置规则：同主题偏好合并、旧偏好 `confidence` 衰减
- Runtime Telemetry JSONL 落盘；Agent Eval real 模式可统计 `no_tool_final_rate` / `verification_rate` / `tokens_per_successful_task` / `compaction_saved_tokens`
- Runtime Telemetry 跨会话汇总脚本：`npm run telemetry:runtime`
- `.gitattributes` 已入库

---

## 1. 压缩恢复强化 — 后续增强

### 目标

硬压缩后仍能稳定恢复当前任务，不靠自然语言历史猜测。

### 待做

- 将恢复上下文拆成更小的预算单元（当前仍整段注入 `taskState` + `repoContext` JSON）。
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

1. Eval 量化：执行型任务记忆注入 token 下降 `20-50%`、噪声记忆新增下降 `30-60%`。

---

## 3. Runtime Telemetry — 汇总与可观测

### 目标

落盘已有；把运行时行为变成可汇总、可对照的数据。

### 待做

1. 权限裁决、验证状态等字段在事件中的覆盖度与一致性（与 Eval 指标对齐）。
2. 与 `scripts/agent-eval.ts` **real** 模式打通跨会话 / 跨 run 趋势汇总（单 case 沙箱指标已通；runtime 汇总脚本已可读 JSONL）。

---

## 4. Tool Planner — 后续（可选）

- 用 Eval 量化首轮工具命中率、无效探索下降幅度。

---

## 5. 正式发布前清理

- 检查所有新文件是否纳入 Git。
- 将 [`docs/PROJECT-GUIDE.md`](./PROJECT-GUIDE.md) / [`docs/项目介绍.md`](./项目介绍.md) 与真实测试数量同步（以 `npm test` 为准；文档基线约 221 文件 / 2000+ 用例，仓库现约 224 个 `*.test.ts`）。
- 运行：

```bash
npx tsc --noEmit
npm test
npm run eval:agent
git diff --check
```
