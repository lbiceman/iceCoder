# Harness 拆分回归测试指南

本文档说明 `src/harness/harness.ts` 拆分为多模块后的验证流程，包含自动化测试、手动冒烟与类型缺陷 E2E 场景。

## 拆分范围

主循环仍由 `Harness` 类与 `run()` 对外暴露；逻辑已迁移至 `harness-*.ts` 子模块（**未修改** `harness-memory.ts`）。

## 一、自动化测试

在项目根目录 `d:\work\self\iceCoder` 执行：

```bash
npm run build:server
```

编译通过后再跑 Harness 相关单测：

```bash
npx vitest --run test/harness/harness.test.ts test/harness/checkpoint-engine.test.ts test/harness/casual-mode.test.ts test/harness/infer-intent.test.ts
```

### 预期

- `build:server` 无 TypeScript 错误。
- 上述 vitest 用例全部通过。
- 特别关注：
  - `修改代码后未验证时会阻止直接完成并要求验证`
  - `修改代码后已运行验证命令时允许完成`
  - 工具失败、熔断、压缩、checkpoint、casual 模式相关用例。

### 全量 harness 目录

```bash
npx vitest --run test/harness/
```

### 预期（全量）

- **18** 个测试文件、**148+** 用例全部通过（无失败 suite）。
- Phase 11 已删除 `execution-plan-*` / `session-plan-hydrate` 实现，对应遗留测试已移除；勿再引用已删模块。

> PowerShell 中请直接粘贴命令，不要带 Markdown 的 \`\`\` 围栏，否则会报 `` `px `` 无法识别。

## 二、手动冒烟（CLI / 服务）

1. 启动 iceCoder 服务（按项目 README 的 dev 命令）。
2. 发起一条**需要读文件**的简单任务（如「读取 README 第一段」），确认：
   - SSE 有 `stream_delta` / `tool_call` / `tool_result` / `final`。
   - 最终 `stopReason` 为 `model_done`。
3. 发起一条**需要改文件 + 运行命令**的任务（如「在临时文件写入 hello 并 cat」），确认：
   - 工具链正常；
   - 修改后若未跑验证，会出现验证拦截提示（与 `TaskState.shouldBlockFinalForVerification` 一致）。
4. 用户中断（Abort）：确认 `stopReason` 为 `user_abort`，且每个 `tool_use` 有对应 `tool_result`（无 API 400）。
5. 长对话（可选）：消息数超过压缩阈值时，观察日志 `[harness] 微压缩` 或硬压缩 `compaction` 事件，任务仍可继续。

## 三、类型缺陷 E2E 场景（回归）

历史上曾出现：**模型在 `edit_file` 后未调用 `run_command` 即声称完成**，Harness 应注入验证提示并 `continue`，而非直接 `model_done`。

### 步骤

1. 使用含 `edit_file` 与 `run_command` 的工具集。
2. 用户消息：`修复失败用例`（或同等可执行工程诉求）。
3. Mock / 真实模型行为：
   - 第一轮：`edit_file` 成功；
   - 第二轮：仅文本「已修复」，**无** `run_command`。
4. 期望：
   - 对话中出现 `changed files but has not verified` 类系统提示；
   - 第三轮模型调用 `run_command` 后才能正常结束。
5. 对照用例：同一任务在 `edit_file` 后**立即** `run_command`，应**不**出现上述拦截提示。

自动化对应用例见 `test/harness/harness.test.ts` 中上述两个 `it(...)`；`chatFn` 队列需包含 `stepReviewLlmStub()`，避免 resilience step-review 消耗主 mock。

## 四、文件清单（拆分后）

| 文件 | 职责 |
|------|------|
| `harness.ts` | `Harness` 类、`run()` 编排 |
| `harness-run-state.ts` | `HarnessRunState`、`Transition` |
| `harness-constants.ts` | `MAX_*`、预算与压缩常量 |
| `harness-message-utils.ts` | 消息/Jaccard/可执行性判断 |
| `harness-message-budget.ts` | 工具结果与子代理裁剪 |
| `harness-llm-log.ts` | LLM 日志字段、可重试错误、工具 UI 提示 |
| `harness-step-context.ts` | step-review 上下文收集 |
| `harness-permission-runtime.ts` | 权限与重复失败签名 |
| `harness-runtime-inject.ts` | Runtime State 注入 |
| `harness-checkpoint.ts` | v1 checkpoint 与 telemetry |
| `harness-resilience.ts` | Resilience v2 |
| `harness-compaction.ts` | `maybeCompact` |
| `harness-stop-handler.ts` | 循环停止与总结 |
| `harness-tool-executor.ts` | 流式工具执行 |
| `harness-round-prep.ts` | 轮次预处理 |
| `harness-llm-call.ts` | LLM 调用与重试 |
| `harness-round-no-tools.ts` | 无工具响应分支 |
| `harness-tool-round.ts` | 工具轮完整流程 |

## 五、失败排查

| 现象 | 可能原因 |
|------|----------|
| vitest 报 `chatFn` 调用次数不符 | 队列缺少 `stepReviewLlmStub()` |
| 编译找不到模块 | 路径或 `build:server` 未跑 |
| 验证拦截未触发 | `run_command` 不在 tools 或 casual 模式跳过 |
| checkpoint 竞态 | `enqueueCheckpointPersist` 未串行（应经 `Harness` 包装） |

---

完成以上三步且无回归后，可认为 Harness 拆分验收通过。
