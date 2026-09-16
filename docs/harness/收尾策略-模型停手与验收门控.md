# 收尾策略：模型停手与停时验收（D′）

> 日期：2026-09-16  
> 状态：**已落地**。旧 `CompletionGate` / `TaskAcceptanceTracker` / `harness-graph-stop` 已删除。  
> 相关：`Harness-L2与Gate工作逻辑.md`  
> 入口：`src/harness/harness-round-no-tools.ts`、`verification-plan.ts`、`verification-state.ts`、`harness-stop-verification.ts`

无工具 + 有正文 = 模型提出结束。运行时只因硬状态或过期验收延迟结束；验收命令走现有 `run_command` ToolGate，不另起子进程。

---

## 1. 现行无工具轮

`handleNoToolCalls` 顺序：

```
空响应 / 截断 / 正文嵌入工具 / 实现任务从未调工具 / 压缩失忆
  → 硬状态？（pending / 审批 / 用户拒绝 / 写失败 / 高风险缺回执）
        ├─ 是 → paused 或 failed
        └─ 否 → 问答 / inspect 且无用户验收句式 → completed
                  有工程修改且计划过期？
                    ├─ 无计划 → completed_unverified
                    ├─ 已 fresh → completed
                    └─ 经 ToolGate 执行 VerificationPlan
                          ├─ 全绿 → completed
                          ├─ 失败 → [System / Stop Verification]，只续一轮
                          │         再失败：user → failed
                          │                 runtime_default → completed_unverified
                          └─ 不可执行 → user → paused
                                        runtime_default → completed_unverified
```

`model_done` 是循环停止原因，**不等于** `completed`。UI 必须同时看 `stopReason` 和 `completionStatus`。

---

## 2. 验收计划从哪里来

`resolveVerificationPlan` 只生成**一个** `VerificationPlan`，优先级：

| 优先级 | 来源 | `source` | 再失败终态 |
|--------|------|----------|------------|
| 1 | 目标里的严格句式，例如「完成条件：必须运行 `…`」 | `user` | `failed` |
| 2 | 存在 `package.json#scripts.test` 时的安全默认 `npm test`（按 lockfile 选包管理器） | `runtime_default` | `completed_unverified` |
| — | 无可靠来源 | 不猜命令 | 有工程修改则 `completed_unverified` |

`source` 联合里仍有 `project`，只为读旧 checkpoint，新解析不会产出。

普通反引号（路径、`README.md`、`tenantId`、公式）**不会**变成 required。不要把全部 `package.json` scripts 或名字像 `test` / `build` 的脚本自动登记。本仓库的 `npm run build` 会跑 `bump-pack-version.mjs`，默认验收禁止走这类有副作用的命令。

```ts
interface VerificationPlan {
  id: string;
  source: 'user' | 'project' | 'runtime_default';
  commands: Array<{ command: string; required: boolean; timeoutMs: number }>;
  fingerprint: string;
}
```

`fingerprint` 由规范化命令、顺序和工作目录生成。计划一变，旧成功作废。

---

## 3. 新鲜度

不用 `Date.now()`。运行时维护：

```ts
interface VerificationFreshness {
  workspaceMutationVersion: number;
  verifiedMutationVersion: number | null;
  verifiedPlanFingerprint: string | null;
}
```

- 成功落地的工程修改使 `workspaceMutationVersion + 1`。
- 计划全绿时记录当时的版本和 fingerprint。
- 两者都对上才算 fresh，fresh 时停手不再跑命令、不再打 LLM。
- 验收命令自己改了工程文件 → 结果不能标 fresh。显式计划这种情况是 `paused`（`verification_unavailable`）；默认计划是 `completed_unverified`。
- checkpoint 必须保存这些字段，恢复时不得用文件数组长度或墙上时钟重建。

只读探测失败（错误的 `git diff`、列目录）不污染验收状态。

---

## 4. 终态

| `completionStatus` | 何时 |
|--------------------|------|
| `completed` | 无需验收，或计划 fresh 且全绿 |
| `completed_unverified` | 改过工程文件但没有可靠计划，或默认 `npm test` 续轮后仍失败 |
| `paused` | pending / 审批 / 用户拒绝 / 显式计划当前不可执行 |
| `failed` | 用户显式验收续轮后仍失败，或写操作失败不可接受 |
| `interrupted` | 资源上限、超时、用户中断 |

硬状态仍暂停：运行中操作、审批、用户拒绝、写失败、高风险缺回执。这些不走验收计划。

前置恢复（截断、空响应、嵌入工具、从未调工具、压缩失忆）在验收之前，**不**消费「只续一轮」预算。

---

## 5. 源码

| 文件 | 职责 |
|------|------|
| `harness-round-no-tools.ts` | 无工具收尾主路径 |
| `verification-plan.ts` | 解析用户句式 / 默认 `npm test` |
| `verification-state.ts` | mutation version、freshness、续轮计数 |
| `harness-stop-verification.ts` | 顺序执行计划，看 exit code |
| `harness-verification-tool-adapter.ts` | 把停时命令送进同一条 ToolGate |
| `completion-state.ts` | 硬状态与终态枚举 |
| `src/prompts/sections.ts` | 提示词看 `[System / Stop Verification]`，不再提 Completion Gate |

旧清单模块已删除：`completion-gate.ts`、`task-acceptance-tracker.ts`、`completion-context.ts`、`harness-graph-stop.ts`。checkpoint 里的 `acceptanceGate` / `completionGateContinuationCount` 只给旧快照兼容，不能否决 `model_done`。

---

## 6. 回归与 eval

定向：

```bash
npx vitest --run test/harness/harness-stop-loop.test.ts test/eval/agent-eval-sandbox.test.ts
npm run eval:agent -- --mode=local
```

`--mode=local` 只跑带 `scriptedTurns` 的用例：隔离临时目录 + 真实工具 + 真实 `npm test`，用磁盘内容和 exit code 判定。`--mode=mock` 不得给这些用例发假通过分。

本地改文件至少覆盖：改已有文件、新建文件、测后再改、无计划、默认/显式失败、双命令、用户命令覆盖默认测试、验收脚本自己改工作区、只读。定义在 `scripts/agent-eval-cases.ts`。

不要跑 `npm run build` 当验收（会 bump 版本）。

---

## 7. 竞品对照

| | 默认何时结束 | 谁保证「测过了」 | 硬拦 |
|--|--------------|------------------|------|
| Codex | 无 tool call | 模型自己跑 | 沙箱 / 审批 / 用户中断 |
| OpenCode | finish ≠ tool-calls 且无 tool part | 模型自己跑 | 同上 |
| Claude Code | 无工具 | 默认无；可选 Stop hook 跑脚本 | hook 最多顶有限次 |
| iceCoder 现在 | 无工具即提出结束；D′ 只在过期验收或硬状态时延迟 | 严格用户句式 / 安全 `package.json#scripts.test` | 硬状态；显式失败 → `failed`；默认失败 → `completed_unverified` |

循环对齐 Codex / OpenCode。质量闸对齐 Claude Code Stop hook 的内核，但是内置、只续一次、走 ToolGate。

不采用：再叫一轮 LLM 当法官；`submit` / `attempt_completion` 作为主路径；从 goal 里所有反引号编译 required 清单。

---

## 8. 明确不做什么

- 不要为了收尾再打一轮「是否结束」的 LLM。
- 不要恢复 `CompletionGate` / `TaskAcceptanceTracker`。
- 不要在收尾路径直接 spawn，或绕过 ToolGate / 审批。
- 不要按时间戳判断验证是否覆盖最后一次修改。
- 不要把「不再续跑」写成 `completed`。
- 不要自动执行 `build` / migration / snapshot。
- 不要用 `git diff`、列目录、`node -e` 代替验收命令。

---

## 9. 历史：fusion-06 为什么会空转

任务 `debug-saas-order-supply-approval-fusion-06`（`mimo-v2.5`，`reasoning=high`）：

| 轮次 | 发生了什么 |
|------|------------|
| 16 | 一长串 test/build 命令成功 |
| 17 | 再跑 `npm ci`（成功） |
| 18 | `git diff --name-only -- test/` 失败（exit 129） |
| 19 | 模型给出总结，不再调工具（想停） |
| 20 | 当时的 Completion Gate 注入续跑；模型写 `node -e`，被 Windows 内联脚本规则拦住 |
| 21 | 再 `npm ci` |
| 22 | 约 8.2 万 token 空转，用户中断 |

拦住它的是被 prompt 反引号污染的必过清单，外加 `git diff -- test/` 子串误伤。第 19 轮模型判断是对的。

当时路径：`TaskAcceptanceTracker` 从 goal 编译命令 → `CompletionGate.evaluate` 否决 `model_done` → 注入 `[System / Completion Gate]`。同一阻塞签名只续一次，后面空转是模型被脏清单带走，不是门控死循环。

中间还修过解析（只认 runner、链式 `&&`、精确匹配），**主循环在 D′ 落地前仍是门控否决停手**。那一阶段的说明见已过时的 `docs/验收门控深度分析.md`。
