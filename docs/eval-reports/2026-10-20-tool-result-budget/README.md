# 工具结果 token 预算：真实模型新旧对比（2026-10-20）

## 结论

- 固定任务集 `context`（9 个用例 × 3 次）：通过 **base 24/27 → new 26/27**，token 中位之和 **−20%**（993,735 → 793,816）。
- 差异主要来自「长任务压缩恢复」：`long-task-compaction-recovery` **base 1/3 → new 3/3**。
  base 的两次失败都在持续硬压缩下反复重跑已通过的 `npm test`（7 次、5 次），直到 token 预算耗尽（`token_budget`，约 25 万 token）；
  new 每次 2～3 次 `npm test` 就收尾。
- 多文件修改、长调用链、长日志三组通过率持平，token 分别 −5% / −21% / −13%。单个用例 ±25% 以内的差异在 3 次重复的噪声范围内
  （例如 `model-led-three-file-bugfix` +23%，两边都 3/3，LLM 调用 5 vs 6）。
- 代价：长日志用例单次请求峰值更高（`model-led-real-log-middle-error` 中位 16,858 → 22,216）。新版本一次注入更多日志，
  换来更少的调用（6 → 4），总 token −18%。
- 本轮真实运行里没有出现发送前收紧（`budget_shrinks` 全为 0）：1M 窗口下整轮预算基本不触线。触线行为由离线边界测试覆盖（见下文）。

## 固定口径

| 项 | 取值 |
| --- | --- |
| 模型 | provider `opencode-go`，model `minimax-m3.1-flash-free`（两边相同，历史记录里有 `model` 字段，不含密钥） |
| 上下文窗口 | provider 默认 1M，未设置 `ICE_CONTEXT_WINDOW` |
| base | `97cad8fd`（改动前）+ 新版 `scripts/agent-eval*.ts`（只换评测脚本，不换 src） |
| new | `56ed3495`（间歇失败修复）+ `0419f9b8`（本次功能），以及本报告所在提交里的两处用例调整 |
| 任务集 | `AGENT_EVAL_SUITES.context`：四组 9 个用例（下表） |
| 重复次数 | 每个用例新旧各 3 次；两边并行跑，同一时间段 |
| 通过标准 | runner 判定：`expected`（工具使用、验证次数、完成状态、最终回复内容等）+ 文件断言 + 结束后评判命令（如 `npm test`）全部满足 |
| token 口径 | `loopState.totalInputTokens + totalOutputTokens`，即每次模型调用 provider usage 之和；中位数含失败的运行 |
| 单次请求峰值 | 各次 `llm_response` 上报的 prompt token 的最大值（provider 口径） |

任务集：

| 分组 | 用例 | 考察点 |
| --- | --- | --- |
| 多文件修改 | `model-led-three-file-bugfix` | 三个文件各有一处错误 |
| | `model-led-caller-and-callee` | 调用方和被调用方都要改 |
| | `model-led-rename-eight-files` | 函数改名波及 8 个文件，每个文件约 120 行注释；测试扫描源码确认旧名一个不剩 |
| 长调用链调查 | `model-led-real-read-chain` | 8 级调用链，只读不改 |
| | `model-led-deep-chain-large-files` | 10 级调用链，每个文件约 400 行，函数埋在正中间；禁止运行命令 |
| 长日志定位 | `model-led-real-log-middle-error` | 4000 行日志正中间唯一的 ERROR |
| | `model-led-failing-check-in-long-log` | `npm test` 输出约 4000 行，唯一 FAIL 在中间；修好对应模块并重跑到通过 |
| 长任务压缩恢复 | `compression-recovery` | 小任务，每轮压缩 |
| | `long-task-compaction-recovery` | 6 份长文档收集密钥片段，写入后测试只校验 sha256；硬压缩阈值 7000（起始上下文约 6.4k） |

## 结果

完整表格：[compare-context.md](compare-context.md)（由 `scripts/agent-eval-compare.ts` 生成）。

| 分组 | 通过 base | 通过 new | token 中位之和 base | token 中位之和 new | 变化 |
| --- | --- | --- | --- | --- | --- |
| 多文件修改 | 9/9 | 9/9 | 192,338 | 182,517 | −5% |
| 长调用链调查 | 6/6 | 6/6 | 201,968 | 159,805 | −21% |
| 长日志定位 | 5/6 | 5/6 | 282,427 | 246,207 | −13% |
| 长任务压缩恢复 | 4/6 | 6/6 | 317,002 | 205,287 | −35% |
| **合计** | **24/27** | **26/27** | **993,735** | **793,816** | **−20%** |

### `long-task-compaction-recovery` 逐次

| 运行 | 结果 | 硬压缩次数 | `npm test` 次数 | 轮次 | token | 结束原因 |
| --- | --- | --- | --- | --- | --- | --- |
| new 1 | PASS | 5 | 2 | 8 | 79,435 | model_done |
| new 2 | PASS | 10 | 2 | 13 | 141,999 | model_done |
| new 3 | PASS | 11 | 3 | 14 | 167,674 | model_done |
| base 1 | FAIL | 17 | 7 | 20 | 256,662 | token_budget |
| base 2 | PASS | 10 | 3 | 13 | 141,004 | model_done |
| base 3 | FAIL | 16 | 5 | 19 | 254,542 | token_budget |

两边都在前几轮就用 grep 取出片段、写入正确的 KEY。base 失败的两次，此后几乎每轮都硬压缩，模型反复跑 `npm test`、重读 `src/key.js`，
看不出测试已经通过。结合早先的视图对比（下文），推测原因是旧版压缩后旧工具结果被改写成不含状态信息的截断文本；
新版的占位会写明「这不是工具输出、是否保存、如何补读」，短的未保存结果不清理。这一点没有逐条重放验证，属于推断。

### 失败原因

- `model-led-failing-check-in-long-log`：base 1 次 `interrupted`（轮次上限），new 1 次 `paused`
  （模型为拿退出码在工作区里写验证脚本，验证命令改了工作区，按规则暂停）。两边都是模型在 Windows 上与重定向 / 退出码较劲，属于模型随机性。
- `long-task-compaction-recovery`：见上表。

## 用例调整（影响口径，单独说明）

第一轮跑完后调整了两个用例，这两个用例的结果取自调整后的第二轮（新旧同样重跑 3 次），其余 7 个用例取第一轮：

1. `model-led-failing-check-in-long-log`：删掉 `notContains: 'Math.floor'`（模型用别的写法修好、测试通过也会判失败，属于写死实现）；
   `maxRounds` 20 → 30（第一轮 6 次中 3 次因轮次上限中断）。
2. `long-task-compaction-recovery`：硬压缩阈值 24,000 → 7,000。真实模型用 grep 一步取出全部片段，上下文涨不到 24k，
   6 次都没有触发压缩，用例没有考到「压缩后恢复」。7,000 约为起始上下文 + 600，任何解法都会在写 `key.js` 前触发。
   这是持续压缩下的压力设置，比日常使用严苛。

调整前的原始记录保留在 `raw/context-*-round1-unadjusted.jsonl`：调整前两个用例新旧都是失败居多（长日志 1/3 vs 1/3，长任务 0/3 vs 0/3），没有区分度。

## 早先一轮对比（同一模型，功能的较早版本）

5 个用例 × 3 次，[compare-earlier.md](compare-earlier.md)，原始数据 `raw/earlier-*.jsonl`。通过 15/15 vs 15/15，token −22%。
当时的历史记录还没有 `model` 字段（表中显示 unknown），运行日志显示两边同为 `minimax-m3.1-flash-free`。
其中 `model-led-real-read-chain` −74% 主要来自 base 的 `node -e` 被 Windows 守卫拦截后的重试，属于模型随机性，不应算作改动收益；
`compression-recovery` 在那一轮 +48%，之后修了微压缩清理（未落盘的短结果不清理），本轮持平（+1%）。

## 视图对比：压缩后模型看到的旧工具结果

同一条 `dir /s /b` 结果（约 757 字符、未落盘）在压缩后的视图：

- base：`[succeeded] [succeeded] [succeeded] <TEMP>\ice-agent-eval-...`（原文为本机临时目录，已替换），看不出被截断，也不知道如何找回
- new（较早版本）：`[Old tool result cleared for context] tool=run_command status=succeeded (~757 chars). This placeholder is NOT the tool output. The original output was not saved; re-run the tool if you need it.`
- new（当前版本）：未落盘且不超过 1000 字符的结果不再清理，原样保留

## 离线边界测试（不打 API）

`test/eval/context-budget-boundary.test.ts`，窗口 40k、输出上限 8k（硬上限 32k），另有 100k / 40k 的大输出上限场景：

| 场景 | 断言 |
| --- | --- |
| 一轮 10 个并行大结果 | 下一次请求 ≤ 32k；会话历史里保留原文 |
| 12 轮累积大结果 | 每次请求 ≤ 32k |
| 1 个大结果 + 60 个小结果 | 请求 ≤ 32k |
| provider 计数是本地估算 1.6 倍，3 轮 × 8 个并行 | 按 provider 口径每次 ≤ 32k |
| 工具跑完后又排入 /also 长备注 | 压缩吸收，备注完整，请求 ≤ 32k |
| 本轮跳过压缩（如 fork 后首轮）+ 长备注，估算一致 / 偏低 1.6 倍 | 只靠发送前检查收紧本轮结果；占位写明不是工具输出；原文仍在 |
| 低余量读超大文件 | 分页而不是丢弃 |
| 输出上限 40k / 窗口 100k，14 轮 | 每次请求 ≤ 60k，且每轮都能看到刚执行的结果（不被降级为 omitted） |

逐一关掉保护验证用例不是摆设：关掉发送前检查 → 「跳过压缩」用例失败；关掉校准 → 1.6 倍用例按 provider 口径到 48,684 > 32,000；
压缩线不计输出上限 → 大输出上限用例第 13 轮最新结果被降级为 omitted。

## 复现

```bash
# new（仓库）
ICE_AGENT_EVAL_HISTORY=<dir>/new.jsonl npx tsx scripts/agent-eval.ts --mode=real --suite=context --repeat=3 --label=new --format=markdown
# base（改动前的 worktree，拷入新版 scripts/agent-eval*.ts；步骤见 .cursor/skills/icecoder-agent-eval）
ICE_AGENT_EVAL_HISTORY=<dir>/base.jsonl npx tsx scripts/agent-eval.ts --mode=real --suite=context --repeat=3 --label=base --format=markdown
# 对比
npx tsx scripts/agent-eval-compare.ts --base=<dir>/base.jsonl --new=<dir>/new.jsonl --suite=context --out=compare.md
```

固定模型用 `ICE_AGENT_EVAL_PROVIDER=<provider id>`；启动时只打印 provider id、model 和是否有 key。

## 局限

- 只有一个模型、每例 3 次；单用例结论看通过率和明显的行为差异，不看 ±25% 内的 token 波动。
- 1M 窗口下整轮预算和发送前检查在真实运行里没有触线；小窗口下的效果只由离线测试证明，没有真实模型数据。
- `model-led-failing-check-in-long-log` 仍受 Windows shell 行为影响较大，两边各有 1/3 失败。
