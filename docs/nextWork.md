# nextWork.md

本文档记录 iceCoder 下一阶段应继续优化的工作。README 只描述当前架构和已完成能力；本文件用于拆解后续实现计划。

已完成并从本文移除（对照代码 / README / PROJECT-GUIDE）：

- Runtime Recovery Context → `session-notes` 的 `icecoder-runtime` 快照与续聊 `hydrate` / `applySnapshot`
- 压缩前后 token 统计（`recordCompaction` → `beforeTokens` / `afterTokens` / `savedTokens`）
- Memory v2 主路径（分级 / 证据 / 冲突裁决）与 Tool Planner 主路径
- Memory v2 Dream 后置规则：同主题偏好合并、旧偏好 `confidence` 衰减；Eval 量化目标（注入 token / 噪声记忆）按已落地能力关闭
- Runtime Telemetry JSONL 落盘；Agent Eval real 模式可统计 `no_tool_final_rate` / `verification_rate` / `tokens_per_successful_task` / `compaction_saved_tokens`
- Runtime Telemetry 跨会话汇总脚本：`npm run telemetry:runtime`；字段覆盖与跨 run 趋势按已落地能力关闭
- Tool Planner Eval 量化（可选）— **不做**
- `.gitattributes` 已入库
- 压缩恢复上下文预算化：`Runtime Recovery Context` 已拆成目标 / 阶段 / 验证 / 变更文件 / 命令 / 诊断等优先级单元，紧预算下优先裁剪低价值列表
- 压缩恢复 Eval 量化：Agent Eval 新增 `compaction_recovery_success_rate`，`compression-recovery` 要求真实硬压缩、压缩后工具进展、最终断言与验证通过；含压缩 case 时 `<0.95` 返回非 0

---

## 1. 正式发布前清理

- 检查所有新文件是否纳入 Git。
- 将 [`docs/PROJECT-GUIDE.md`](./PROJECT-GUIDE.md) / [`docs/项目介绍.md`](./项目介绍.md) 与真实测试数量同步（以 `npm test` 为准；文档基线约 221 文件 / 2000+ 用例，仓库现约 224 个 `*.test.ts`）。
- 运行：

```bash
npx tsc --noEmit
npm test
npm run eval:agent
git diff --check
```
