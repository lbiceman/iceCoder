# Harness 长任务稳定性

> **状态**：待执行  
> **版本**：v0.5  
> **日期**：2026-09-15  
> **工程拆分**：[`Harness长任务稳定性-任务拆分.md`](./Harness长任务稳定性-任务拆分.md)  
> **背景审查**：长任务不稳定不在轮次/墙钟不够，而在跨轮纠偏被掏空 + LLM 传输层过脆 + 把命令目录当成「验收」。  
> **v0.2**：运行时不认语言；验收交给提示词。  
> **v0.3**：目标是任意命令字符串，不是语言枚举。  
> **v0.4**：§2.2 列出的写死模块全部纳入改造。  
> **v0.5**：用户若指定测试方式/框架/命令，**按用户方案走**（不透明字符串）。Harness 不因此写死该框架；未指定时才让模型读仓库自选。

---

## 1. 一句话

长任务要能自己换策略、扛住模型思考和断线。Harness **不维护语言列表**：不认识 `cargo`、不认识 `go`、也不需要认识。它只报告进程是否还在跑、退出码是什么、有没有改文件。用哪条命令验收：用户指定了就按用户的；没指定才由模型读仓库后自己决定。

---

## 2. 问题

资源上限已经够长：默认 5000 轮、24h 墙钟、50M 累计 token。Spell Brigade 那种 347 轮硬停已经不是主因。

### 2.1 空转与传输层

1. **跨轮预算每轮清零**  
   `harness-tool-round.ts` 在每轮工具开始调用 `resetRoundBudget()`。BranchBudget 的「同文件 3 次 edit / 同命令 2 次重试」只对同一 LLM 回复里的并行连打有效。顺序 debug（改文件 → 检查红 → 再改）永远计不满。与语言无关。

2. **熔断看错进展**  
   `circuit_breaker` 要连续 10 轮工具全失败。写文件成功就算 `meaningful_progress`，计数归零。改代码但项目检查一直红，熔断永不触发。与语言无关。

3. **后台启动被当成完成**  
   长命令被送进后台后，工具返回 `success: true`（started）。进度分类若再把「命令字符串像测试」当成有进展，就会把**启动**说成**跑完**。这是执行形态问题，不是某几种测试命令特有的问题：只要工具返回「已启动、还在跑」，无论 command 写成什么，都不算跑完。

4. **LLM 默认 120s**  
   OpenAI 适配器默认 timeout 120000 ms；当前默认供应商配置没有 `requestTimeoutMs`。推理模型 + 大窗口很容易超过 2 分钟，整轮变 `error`。

5. **紧急压缩整次 run 一次**  
   `contextEmergencyCompactUsed` 用过之后，第二次再触窗口直接 LLM error。适配器流式在已吐 chunk 后不重试（P0-13 去重，必须保留）。

6. **硬压缩可能阻塞主循环 120s**  
   压缩前等待会话笔记 LLM 更新，上限 `PRE_COMPACT_SESSION_MEMORY_WAIT_MS = 120_000`。

### 2.2 语言/栈写死（通用 Harness 的结构性债）

iceCoder Harness 面向任意仓库，但多处用**命令名字录**判断「这是不是验收 / 要不要后台 / 算不算进展」。JS 路径被写得很满，其他语言要么漏、要么靠再抄一份正则——这是错方向。

| 落点 | 现状 | 后果 |
|------|------|------|
| `isHarnessVerificationCommand` | npm/pnpm/yarn/vitest/jest + 少量 pytest/mvn/gradle/go/cargo/dotnet/phpunit | 漏 `make test`、`tox`、`sbt test`、`cmake --build`、自定义脚本；命中了也不代表「测完了」 |
| `isUnitTestVerificationCommand` / `isBuildVerificationCommand` / `isTestVerificationCommand` | 以 npm/tsc/vite/vitest 为主 | 构建 vs 单测的切分绑死 JS 生态 |
| `classifyToolRoundProgress` | 命令命中上面的正则且工具 success → `meaningful_progress` | `npm test` 后台启动也算有进展；未进名单的 `pytest` 即使跑完也不走这条 |
| `shell-runtime-classifier` `LONG_RUNNING` | **立刻后台**：`npm test` / vitest / jest / `npm run build`；**没有** pytest / mvn / gradle | 同一条「跑测试」，JS 直接后台，Java/Python 走 auto（8s 后才 escalate）。栈不一致 |
| `task-acceptance-tracker` 从 goal 抽命令 | 写死 `npm ci → npm test → npm run build → npm run test:e2e` | 用户说「跑 Maven 验收」抽不出来 |
| rebuild 提示 | 文案 `e.g. npm test` | 把模型往 Node 仓库推 |
| `prompts/sections.ts` | `run_command` 示例是 `{ "command": "npm test" }` | 系统提示默认教模型用 npm |
| session-memory / task-state 意图 | package.json 里有没有 vitest；goal 匹配 vitest/jest/pytest | 记忆和意图启发式偏 JS |
| 编年史 UI 文案 | vitest/jest/playwright 才叫「运行测试」 | 中性「运行命令」；见 §6.7 |

**错误修法**：把 `pytest`、`mvn test`、`cargo test`、`go test` 再补进正则，假装「支持所有语言」。Rust/Go 今天碰巧在旧名单里有两行，并不等于通用；漏的是 `just test`、`bazel test`、`zig build test`、`./scripts/ci.sh` 以及明年才会出现的工具。

**正确修法**：

- **运行时只认通用事实**：工具成功/失败、exit code、是否 `background`/`running`/`completed`、是不是写文件。**不解析 argv[0] 是哪种语言的工具。**
- **策略交给模型**：提示词要求它在仓库里找出检查方式（读用户目标、README、已有脚本），选用对应命令；长任务启动 ≠ 结束，必须 `check` 直到进程退出。提示词里不要再列一份「请查看 go.mod / Cargo.toml / pom.xml」的封闭清单。
- **本方案禁止**为了稳定性再扩大 `isHarnessVerificationCommand` / `LONG_RUNNING` 的语言名单（包括「补上 Rust/Go」）。

### 2.3 Rust / Go / 任意栈：这套逻辑够不够？

**够，当且仅当实现遵守 §6.2 / §6.5 / §6.6，而不是「把 Rust、Go 写进支持列表」。**

| 能力 | 对 `cargo test` / `go test ./...` / `./scripts/ci.sh` 是否成立 |
|------|------|
| 跨轮同一文件反复 edit 被拦 | 成立。预算按路径，与语言无关。 |
| 后台启动不算验收通过 | 成立。看返回 JSON 的 mode/status，不看命令是 cargo 还是 go。 |
| 进程跑很久（Rust 编译） | 成立。不靠「cargo 是长任务」白名单；走 auto + 软超时 escalate，或模型设 `background`。`npm test` 的立刻后台特权应删掉，否则只有 JS 特殊。 |
| 检查失败后换策略 | 成立。BranchBudget 按**规范化命令字符串**计数：连续同一条 `cargo test` 失败会触顶；模型应改代码或换命令，Harness 不需要知道这是 Rust。 |
| 检查命令是什么 | **不由 Harness 满足。** 模型读仓库决定。`cargo test` 与从没见过的 `./tools/verify.ps1` 地位相同。 |
| 旧正则里已有 `go test`/`cargo test` | **不要当成已支持。** 那是 §2.2 的债；新进度/摘要路径必须当它们不存在，才能覆盖名单外的命令。 |

**不够的情况**（实现走歪时）：

- 又加一行 `/\bcargo test\b/`「为了支持 Rust」——Zig、Nim、自定义脚本立刻再漏。
- 提示词写成「Node 用 npm、Rust 用 cargo、Go 用 go test」——仍是封闭世界，只是从 1 种变成 3 种。
- 单测只断言 `npm test`/`pytest`/`mvn test` 三种——Agent 会以为支持列表 = 这三种。必须再加一条**故意不在任何现有正则里的**命令（如 `./scripts/ci.sh` 或 `just check`）。

结论：全语言 = **对未知命令封闭运算**（只看执行态），不是 **对已知语言开放枚举**。

---

## 3. 目标

长任务（30–120 分钟、数十到数百轮）应满足：

- 同一文件反复无效 edit 会被 BranchBudget 跨轮拦住，并走已有 rebuild / recovery 提示。与语言无关。
- **任何** `run_command` 的「已启动、仍在跑」都不算验收完成，也不单独清熔断计数。对未知命令与对 `npm test` 相同。
- 系统提示、workspace anchor、rebuild 文案、工具 description **都不再教某个工具链**。
- §2.2 表里每一行都有对应改造（见 §6.7），不是只改进度分类。
- 单次 LLM 请求默认扛得住推理模型思考；传输抖动由 Harness 层有界重试，不把半截流在适配器里重放。
- 窗口触顶可以再收缩有限次数，硬压缩不堵住主循环两分钟。
- **任何**后台任务进入终态（completed / failed / killed / timeout）都尽快注入状态，不靠「命令像不像 npm test」决定是否立刻告诉模型。

---

## 4. 非目标

不要做：

- 再加大 5000 轮 / 24h / 50M token。
- 重做 CompletionGate、验收死循环、第二套 Verification Gate。
- 改 Checkpoint V3 schema、主循环状态机形态、记忆子系统架构。
- 推翻 `LLMAdapter.stream` 的 P0-13。
- 把「项目检查一直红」直接打成 `circuit_breaker`。纠偏靠 BranchBudget + rebuild + 提示词，不靠熔断。
- **把 Rust/Go/Java/Python 命令补进正则当成「已经支持所有语言」。** 枚举不是全覆盖。
- 改工作台布局 / 桌面包一层（编年史**文案**要改，见 §6.7）。

---

## 5. 硬约束

1. 保留 `while (true)` 主循环。改造范围包括预算、进度事实、超时、压缩配额、提示词，以及 **§6.7 全部写死模块**。
2. **新用户消息**仍清 BranchBudget 三维计数。禁止把上一问的 file cap 带到新意图。
3. **工具轮开始不再清** file/command/error 计数。
4. 用户 abort 仍立刻停；传输重试不得吃掉 abort。
5. 流式已向 UI 推过 delta 后：适配器不重放；Harness 若整轮重试，必须让 UI 丢掉半截或另起一条。
6. 项目检查失败不单独把 adaptive 抬进 forced（现有「验收失败 ≠ 工具坏了」保留，但判断失败应靠 **exit / 工具 success**，不要靠命令是否像 npm）。
7. **禁止**用 `isHarnessVerificationCommand` / `isUnitTestVerificationCommand` / `isBuildVerificationCommand` / `isTestVerificationCommand` 做控制流（进度、熔断、升 forced、是否缓冲输出、是否注入 digest、segment 清哪些命令）。旧函数删掉或变成未引用；digest 改为对**任意失败的 run_command 输出**做通用截取。
8. 不新增 feature flag 也能默认生效。单测 command 必须包含名单外不透明脚本（如 `./scripts/ci.sh`），期望与其它 command 相同。

---

## 6. 预期行为

### 6.1 BranchBudget

| 场景 | 现在 | 之后 |
|------|------|------|
| 同一轮并行 4 次 edit 同文件 | 第 4 次硬拦 | 不变 |
| 跨 4 轮各 edit 同文件 1 次 | 每轮清零，从不拦 | 第 4 次硬拦，可触发 file-cap rebuild |
| 用户又发了一句新话 | `run()` 开头清零 | 不变 |
| checkpoint 里旧计数已满 | 新 `run()` 允许再 edit | 不变（`harness-run-reset` 已覆盖） |

`recoverTriggers` 仍跨轮保留，用于 recovery 去重。命令维预算按规范化命令字符串累计，不解析这是不是「测试」。

### 6.2 进度分类（只看执行事实）

Harness **不**根据命令是不是测试来打分。只看 `classifyRunCommandResult` 的形态 + 写/读工具：

| 工具结果 | 分类 |
|----------|------|
| 写文件成功（未被 budget 判为无效） | `meaningful_progress` |
| `run_command` 前台结束且 success | `meaningful_progress`（与命令名字无关） |
| `run_command` 后台启动 / escalated / check=running | **不是** `meaningful_progress` |
| check 完成且 exit≠0 / failed / timeout / killed | 该条失败；不因「这是测试」特殊对待 |
| 只读成功 | `non_progress_success`（不再用 `.test.ts` / `/test/` 路径猜「这是测试文件所以算进展」） |

熔断仍只看 `all_failed_or_blocked` 连续 10 轮。写成功 + 检查红 **不清也不加** `consecutiveToolFailures`：既不误熔断，也不把「后台测试已启动」伪装成进展。停滞纠偏交给跨轮 BranchBudget + 提示词。

现有 `isHarnessVerificationCommand` 成功即有进展的分支**删掉或改成**上述通用规则，不要改成「验证命令名单再长一点」。

### 6.3 LLM 超时与重试

| 层 | 之后 |
|----|------|
| 非 stream SDK timeout | 默认 **600000 ms（10 分钟）**；`provider.requestTimeoutMs` 与 `ICE_OPENAI_REQUEST_TIMEOUT_MS` 仍优先 |
| Stream 活性检测 | 连续 **300000 ms** 无 SSE 活动即中止；首包和中途卡死统一处理 |
| `LLMAdapter.stream` | 非 Harness 调用保留自身重试；Harness 调用显式 `skipRetry` |
| Harness `callHarnessLlm` | stream 空闲只重试 **1** 次；其他可重试传输错误最多 **3** 次；abort 不重试 |
| 半截流后的 Harness 重试 | rewind 整轮；通知 UI 丢弃未完成 assistant 流 |

### 6.4 压缩

| 点 | 之后 |
|----|------|
| emergency / proactive fork | 每 run 最多 **3** 次，或一次成功硬压缩并把占用压回微压缩线以下后归还 1 次。禁止无限 compact 循环 |
| 硬压缩前等会话笔记 | 最多等 **5s**；超时读盘继续 |
| 失忆恢复 | **不改**。每次 compact 已把 `amnesiaRecoveryCount` 归零 |

### 6.5 后台任务摘要（同样不认语言）

- running：继续 5 分钟节流（所有后台任务，不论命令）。
- **任意**任务进入 completed / failed / timeout / killed：下一次 prep **立即**注入，不要求命令匹配验收正则。
- 提示词要求模型：看到后台终态后根据 **exit code / 输出** 自行判断本仓库的检查是否通过，不要等 Harness 贴「这是 npm test」。

### 6.6 提示词与所有注入文案

凡是会进模型上下文的字符串，都用开放规则，**禁止语言对照表**：

| 文件 | 现在 | 之后 |
|------|------|------|
| `src/prompts/sections.ts` | `run_command` 示例 `npm test` | 中性 schema；**用户指定了检查命令/框架则必须用那个**；否则在当前仓库找；启动≠通过；必须 check 到退出 |
| `src/harness/rebuild-escalation.ts` | `e.g. npm test`；从 vitest 输出抠 `.test.ts` | “re-run the project’s own verification command”；失败路径从**本轮输出**里找，不假设扩展名 |
| `src/harness/workspace-anchor.ts` | `use npm test` without cd | cwd 已在仓库根，直接跑检查命令，不要写死 npm |
| `src/tools/builtin/shell-tool.ts` | 长任务举例 npm test/vitest/tsc | 长命令可能后台化并返回 taskId；举例不要绑定某种测试工具 |
| `src/harness/harness-round-prep.ts` 注释 | 「有 npm test 在跑」 | 注释改成任意后台任务（行为已是通用注入则只改文案） |

### 6.7 写死模块对照（全部要改）

改造原则不变：运行时看执行事实；策略看提示词；**不许扩名单**。

| 模块 | 现在怎么写死 | 改成 |
|------|----------------|------|
| `verification-digest.ts` | 命令正则 + `parseVitestFailureDigest` | 控制流不再调用这些函数。失败摘要：任意 `run_command` 失败时截取输出尾部（固定行数/字符），不解析 vitest/npm。函数删除或停止被引用 |
| `tool-round-progress.ts` | 验收正则 + `.test.` 路径 | §6.2：只看 background/exit/写文件；读文件一律非「验收完成」 |
| `harness-tool-round.ts` | digest 注入、升 forced 前用验收正则过滤 | **任意**失败的 `run_command` 都可出通用失败摘要；**任意**失败的 `run_command` 都不单独升 forced（检查红 ≠ 工具坏了，与命令名无关） |
| `verification-output-buffer.ts` | 只 `recordFailed` 验收命令 | 任意失败的 `run_command` 都可入缓冲 |
| `branch-budget.ts` | `resetCommandRetriesForVerificationCommands` 只清「像测试」的键 | 续段时清**全部** command retry，或清全部 `run_command` 键，不认语言 |
| `harness-tool-preflight.ts` | `isBuildVerificationCommand`；`SOURCE_FILE_RE` 只认 `src/**/*.ts,js` | 构建诊断门控看「这是不是刚失败的那条命令」（执行事实），不看是不是 `npm run build`。源文件探测不要写死 ts/js；没有通用规则就收窄/删除该启发式，而不是加 `.rs`/`.go` |
| `harness-tool-executor.ts` | 失败输出按验收正则进 buffer | 与 buffer 相同：任意失败命令 |
| `task-state.ts` `inferIntent` / `hasExecutableSideSignal` / `looksLikeVerificationCommand` | vitest/jest/pytest/npm test/tsc | 「测试 / 跑测 / verify / run tests」等**自然语言**可标 `test` 意图；**不要**匹配框架名。`looksLikeVerificationCommand` 删除或改为恒不按命令名判断 |
| `task-acceptance-tracker.ts` | 抽死 npm 链；`npx vitest` → `npm test` | 用户原文命令原样登记（§6.8）。没有抽到才空，让模型读仓库。禁止默认 Node 流水线、禁止框架别名归一 |
| `shell-runtime-classifier.ts` | npm/vitest/jest 立刻 `long` | 删除测试命令特权；一律 auto + 软超时。保留与语言无关的 docker/git clone/curl -o（可选保留）。**禁止**补 cargo/go/pytest |
| `session-memory.ts` | 读 package.json 的 vitest/jest 当「项目测试栈」；Jest vs Vitest 警告 | 有 `package.json` 可以当普通文件事实记下 scripts，**不当成全局测试栈**。没有 package.json 就不要 Node 锚定。禁止再写 Jest/Vitest 一致性警告。不要新增 Cargo.toml/go.mod 专段（那是换名单） |
| `memory-recall.ts` | 「不要用 Jest」会扩到 vitest/mocha | 只按用户原词检索；不要内置 JS 测试框架同义表 |
| `types/task-graph.ts` `RepoShape` | `testFramework: vitest\|jest\|mocha\|none` 等 JS 枚举 | 改为自由字符串或 `unknown`；从仓库发现什么记什么，没有就空。旧枚举值仍能读入 |
| `etl-chronicle.js` / `chat-execution-plan.js` / `tool-trace-format` | vitest/jest/playwright 才叫「运行测试」 | 任意 `run_command` 用中性文案（「运行命令」/显示命令短截）。不要用框架名单决定标题 |
| `task-graph-review.ts` | `package.json not found` / `tsconfig` | 缺清单文件的分类用通用 “config/manifest missing”，不要只认 npm/tsc |

### 6.8 用户指定了测试方式时

**要按用户的方案走。** 「不要写死语言」指的是 Harness **不要擅自假定**栈，不是忽略用户点名的框架或命令。

优先级（高 → 低）：

1. **用户本轮（及本会话仍有效的）明确指令**：例如「用 `pytest -q`」「必须 `cargo test`」「不要跑 npm test，用 Maven」「验收按仓库 README 的 `just check`」。
2. **用户 goal 里写出的命令片段**（反引号、箭头链、明确列举）→ AcceptanceTracker 原样登记为不透明字符串。
3. **用户未指定**：模型读当前仓库（脚本、README、清单）自己选检查方式，仍不要默认 npm。

| 谁 | 做什么 | 不做什么 |
|----|--------|----------|
| **提示词** | 写明：用户指定了检查命令或框架则必须用那个；启动后台后仍要 check 到退出 | 不要写「用户说 pytest 时改去跑 npm test」；不要把用户的框架名翻译成另一套默认工具链 |
| **AcceptanceTracker** | 抽出用户写过的命令，当作本 run 要满足的检查 | 不要把 `npx vitest` 归一成 `npm test`；用户没写 npm 就不要登记 npm 链 |
| **运行时** | 用户指定的命令与 `./scripts/ci.sh` 同一套执行事实：后台启动 ≠ 通过，看 exit | 不要因为用户说了 `cargo test` 就给 cargo 开特权名单或特殊超时 |
| **记忆/意图** | 用户说了 Jest/pytest 就按**原词**理解（包括「不要用 Jest」） | 不要自动扩成 vitest/mocha 同义表去改用户方案 |

因此：用户说 Rust 用 `cargo test`，就跑 `cargo test`；说 Go 用 `go test ./...`，就跑那条。Harness 仍然不认识 cargo/go，只执行模型按用户意思发出的那条 `run_command`。

冲突时以**最新用户指令**为准（例如先说 pytest，后来说改用 tox）。

---

## 7. 验收场景（产品层）

1. **跨轮同文件**：连续 4 轮只 `edit_file` 同一路径，第 4 轮被 BranchBudget 硬拦。新用户消息后可以再 edit。与语言无关。
2. **后台启动 ≠ 完成**：仅一条 `run_command`、工具 success、输出为 background started——command 无论是名单内、名单外还是 `./scripts/ci.sh`——都**不是** `meaningful_progress`。
3. **前台跑完**：仅一条前台 `run_command` 且 success（无 background JSON），任意命令字符串都是 `meaningful_progress`。
4. **慢思考**：单次 LLM 流超过 2 分钟但 10 分钟内结束，不因默认 timeout 变 `error`。
5. **传输抖动**：流未结束时 socket hang up，Harness 最多再试 3 次；UI 不拼接两段正文。
6. **二次触顶**：emergency fork 用过一次后还能再收缩。
7. **硬压缩**：笔记 LLM 卡住时 5s 内继续压缩。
8. **提示词与注入**：sections / rebuild / workspace-anchor / shell-tool 描述均无工具链对照表。
9. **禁止名单膨胀**：diff 不得为「支持某语言」新增测试命令正则。
10. **写死模块清零**：§6.7 表中每一行的「现在怎么写死」在生产路径上不再作为控制流；`isHarnessVerificationCommand` 无新引用。AcceptanceTracker 不再默认 npm 链。编年史不对 vitest 特殊标题。session-memory 在无 package.json 的仓库不编造 Node 测试栈。
11. **用户指定检查方式**：goal 写 `cargo test` / `pytest -q` / `./scripts/ci.sh` 时，必须跑用户那条（或等价登记），不得改成 npm 默认链；后台启动该命令仍不算通过。
12. **用户改口**：后一句「改用 tox」后，以最新指令为准。

---

## 8. 关键代码（现状）

**稳定性 / 预算**

- `src/harness/harness-tool-round.ts` — `resetRoundBudget()` 在工具轮开头
- `src/harness/branch-budget.ts` — 三维上限与 reset 语义
- `src/harness/tool-round-progress.ts` — **用验收命令正则**把 success 当有进展
- `src/llm/openai-adapter.ts` — 默认 120s
- `src/llm/llm-adapter.ts` — `canRetry: () => !emittedAny`
- `src/harness/harness-llm-call.ts` — `LLM_MAX_RETRIES = 1`
- `src/harness/harness-compaction.ts` / `harness-run-state.ts` — emergency 一次性
- `src/harness/harness-bg-summary.ts` — 5 分钟节流

**语言写死（§2.2 / §6.7，均要改）**

- `src/harness/verification-digest.ts` 及全部调用点（tool-round、executor、preflight、output-buffer、rebuild、branch-budget、task-state）
- `src/tools/shell-runtime-classifier.ts`、`src/tools/builtin/shell-tool.ts`
- `src/harness/task-acceptance-tracker.ts`、`src/harness/task-state.ts`
- `src/prompts/sections.ts`、`src/harness/workspace-anchor.ts`、`src/harness/rebuild-escalation.ts`
- `src/memory/file-memory/session-memory.ts`、`src/memory/file-memory/memory-recall.ts`
- `src/types/task-graph.ts` `RepoShape`
- `src/public/js/etl-chronicle.js`、`chat-execution-plan.js`、`tool-trace-format.js` / `src/web/tool-trace-format.ts`
- `src/harness/task-graph-review.ts` 中 package.json/tsconfig 启发式
