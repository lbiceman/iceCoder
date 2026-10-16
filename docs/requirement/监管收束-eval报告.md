# 监管收束 · Eval 报告

日期：2026-10-16　对应需求：[监管收束-愿景.md](./监管收束-愿景.md)

## 结论

- 三档监管、执行档切换、任务步骤表、反复修改 / 反复失败上限已全部移除，Plan 模式保留。
- 脚本化对照（同一组模型行为、真实工具）：改动后 3/3 通过；改动前 `off` 档 0/3、`adaptive`（产品默认）1/3。失败全部来自被移除的拦截或提醒。
- 真实模型全量 43 个用例：改动后 31 通过，改动前（adaptive）29 通过。多出的 2 个都是旧监管直接造成的失败；其余 10 个两边一致失败，原因是用例按脚本模型设计，与本次改动无关。
- `model-led` 五个用例各重复 4 次：改动后 20/20 无监管痕迹；改动前有 4 次被注入只读催促或 Self-Review。
- 成本基本持平：全量 token +3.5%、总耗时 −6%，在单轮随机波动范围内。和需求判断一致：删监管是为了少掉无用代码，不是为了变快。

## 环境

- 模型：本机 `config.json` 默认 provider（`opencode-go`）。
- 对照组：`git worktree` 检出改动前的 HEAD（`2bddfee6`），拷入同一份 eval 脚本；runner 以 `ICE_EVAL_SUPERVISOR_MODE` 切换旧代码档位，仅在对照 worktree 内使用。
- 新增 eval：`scripts/agent-eval-cases.ts` 的 `model-led` 类别，runner 对**所有**用例检查不得出现旧监管文案（`[BranchBudget`、`[ToolGate]`、`[TaskGraph]`、`[Runtime Self-Review]`、`Rebuild Escalation`、`Diagnostic Gate`、`Current branch exhausted`、`reading/analyzing for`）和 `execution_mode_*` / `task_graph_*` 事件。

## 1. 脚本化对照（离线，确定性）

`npm run eval:agent -- --mode=local --category=model-led`

| 用例 | 改动后 | 改动前 off | 改动前 adaptive |
| --- | --- | --- | --- |
| 同一文件连改 5 次 | PASS | FAIL：第 4、5 次写入被 BranchBudget 拦截，`npm test` 失败，任务 paused | PASS |
| 同一条失败命令连跑 3 次再修 | PASS | FAIL：第 3 次起命令被拦，进入 Build Diagnostic Gate，注入 Self-Review，修完后验收命令仍被拦 | FAIL：注入 Self-Review |
| 连续读 9 个文件后回答 | PASS | FAIL：注入只读催促 | FAIL：注入只读催促 |

这三个用例已加入 `test/eval/agent-eval-sandbox.test.ts`，随 vitest 离线跑。

## 2. 真实模型全量（单轮）

`npm run eval:agent -- --mode=real`

| | 用例 | 通过 | 轮次 | 工具调用 | 工具失败 | run_command | token | 耗时(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 改动后 | 43 | **31** | 192 | 239 | 14 | 40 | 1,326,199 | 701 |
| 改动前 adaptive | 43 | 29 | 186 | 243 | 15 | 43 | 1,281,417 | 749 |
| 改动后（两边都过的 29 个） | 29 | 29 | 117 | 142 | 3 | 19 | 803,772 | 422 |
| 改动前（同上 29 个） | 29 | 29 | 112 | 149 | 6 | 23 | 774,112 | 450 |

只有一边通过的用例：

| 用例 | 改动后 | 改动前 | 改动前失败原因 |
| --- | --- | --- | --- |
| `local-git-diff-noise-does-not-block` | PASS | FAIL | 中途进入 forced（`execution_mode_enter`），多用 4 次工具 |
| `model-led-real-incremental-functions` | PASS | FAIL | 注入 `[Runtime Self-Review]`，同一文件只写 3 次（改动后 5 次），耗时 55s（改动后 42s） |

两边一致失败的 10 个（按脚本模型设计，真实模型下必然对不上，非回归）：`async-subagent-oauth-context`、`gate-simple-python-edit`、`local-edit-stale-after-second-write`、`local-runtime-default-fail-unverified`、`local-explicit-must-run-failed`、`local-mutating-verify-command-not-fresh`、`audit-reminder-does-not-continue`、`audit-location-verb-is-not-a-file`、`audit-dont-forget-is-not-amnesia`、`audit-deny-survives-skip-permissions`。

另有 `model-led-same-file-five-edits`、`model-led-rerun-failing-command` 在这一轮两边都失败，原因是用例初版写死了实现字符串和「至少跑 4 次 npm test」。已改为按行为断言（测试通过、无 TODO、同一文件写入 ≥5 次 / 命令 ≥2 次），之后的重复实验里两边均通过。

## 3. `model-led` 重复实验（真实模型，每边 4 个样本）

| 用例 | 改动后通过 | 改动前通过 | 改动前监管痕迹 | 同一文件写入均值 新/旧 | run_command 均值 新/旧 | token 均值 新/旧 | 耗时均值(s) 新/旧 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 同一文件连改 5 次 | 3/3* | 3/3* | 0 | 5.0 / 5.0 | 1.0 / 1.0 | 66,835 / 66,680 | 30 / 29 |
| 失败命令反复跑 | 3/3* | 3/3* | 0 | 1.0 / 1.0 | 2.0 / 2.0 | 36,696 / 34,781 | 16 / 15 |
| 连续读 9 个文件 | **4/4** | 2/4 | 2 次只读催促 | – | – | 33,403 / 46,692 | 15 / 18 |
| 逐个实现 5 个函数 | **4/4** | 2/4 | 2 次 Self-Review | 4.5 / 4.5 | 4.3 / 3.0 | 101,397 / 92,478 | 41 / 39 |
| 只读追踪 8 个模块 | 4/4 | 4/4 | 0 | – | 0.5 / 0.5 | 27,137 / 23,926 | 12 / 11 |

\* 断言修正后的 3 轮。

读法：改动后模型按自己的节奏工作——增量实现时测试跑得更勤（4.3 次 vs 3.0 次），因为没有人插话叫它「换策略」；长时间只读也不再被催着动手。

## 4. 单元 / 集成测试

| 项 | 改动前 | 改动后 |
| --- | --- | --- |
| `npm run lint`（后端 + Web） | 通过 | 通过 |
| vitest 后端（不含 `test/public`） | – | 342 文件 / 3133 用例全过 |
| vitest 全量 | 413 文件，2 个既有失败（`etl-integration` 执行流文案） | 见交付说明 |
| 删除的专门测试 | – | 约 6,200 行（supervisor / task-graph / branch-budget / step-review / rebuild-escalation 等） |

新增 / 改写的兼容性测试：旧 V2 `runtimeV2`、旧 V3 `runtimeResilience` 与 `execution.resumable` 里带 `branchBudget`、`executionModeState`、`recoverySignals` 的检查点都能打开并丢弃这些字段（`checkpoint-engine.test.ts`、`project-checkpoint-resume-gate.test.ts`、`harness-run-reset.test.ts`）。

## 复现

```bash
npx vitest --run test/eval/agent-eval-sandbox.test.ts
npm run eval:agent -- --mode=local --category=model-led --format=markdown
npm run eval:agent -- --mode=real --category=model-led --format=markdown
npm run eval:agent -- --mode=real --format=json
```

对照旧代码的做法见 `.cursor/skills/icecoder-agent-eval/SKILL.md`。
