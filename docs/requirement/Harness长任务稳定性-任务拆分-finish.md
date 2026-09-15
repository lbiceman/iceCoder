# Harness 长任务稳定性 — 工程任务拆分

> **状态**：待执行  
> **版本**：v0.5  
> **日期**：2026-09-15  
> **依据**：[`Harness长任务稳定性.md`](./Harness长任务稳定性.md) v0.5  
> **本文件性质**：执行任务清单，不新增产品需求、不修改架构决策。  
> **v0.4**：§6.7 全部写死模块进入 Wave 6，不再列为「本方案不做」。  
> **v0.5**：用户指定的测试方式/框架/命令按用户方案走（依据 §6.8）；Harness 仍不写死该框架。

---

## 1. 如何使用本文档

1. **严格按 Wave 顺序执行**（同 Wave 内标注 `∥` 的可并行）。
2. 每个任务交给 Agent 时，复制对应 **Agent Prompt 片段**（§9）并指定任务编号。
3. 合并前对照依据文档 §7、§6.7、§6.8 与本文件各任务 **验收**。
4. Agent Prompt 在 §9（文末）。
4. **禁止**加大 `maxRounds` / 24h / 50M token。  
5. **禁止**在 `LLMAdapter.stream` 里对已产出 chunk 的流做重放重试（P0-13）。  
6. **禁止**为任何语言增加命令名单（包括 cargo / go / pytest / mvn）。单测里的命令字符串是**不透明夹具**：用来证明规则不读 argv[0]，不是「本方案支持这几种语言」。其中至少一条必须是现有正则匹配不到的（如 `./scripts/ci.sh`）。

---

## 2. 执行总览

```text
Wave 0  跨轮 BranchBudget
  0.1 去掉工具轮 reset ──→ 0.2 单测钉死跨轮累计与新消息清零
         │
Wave 1  通用进度事实 + 提示词
  1.1 后台启动 ≠ 有进展
  1.2 接入 tool-round
  1.3 所有注入文案去工具链（sections / rebuild / workspace-anchor / shell-tool）
  1.4 删除 LONG_RUNNING 测试特权（必做）
         │
Wave 2  LLM 传输
  …
         │
Wave 3  压缩
         │
Wave 4  后台终态摘要
         │
Wave 6  去栈写死（其余模块）
  6.1 停用验收命令正则控制流（digest / buffer / executor / tool-round 升 forced）
  6.2 AcceptanceTracker 只抽用户原文命令
  6.3 task-state 意图不再认框架名
  6.4 session-memory / memory-recall 去 JS 测试栈
  6.5 RepoShape 枚举 → 自由字符串
  6.6 编年史 / tool-trace 中性文案
  6.7 preflight / graph-review 去 ts/js / package.json 启发式
         │
Wave 5  回归（依赖 Wave 6）
```

### PR 切分

| PR | 包含 | 合并门槛 |
|----|------|----------|
| **PR-A** | Wave 0 + Wave 1 | 跨轮预算；后台启动对未知脚本也不算有进展；提示词/anchor/rebuild/shell 描述无工具链；LONG_RUNNING 无测试特权 |
| **PR-B** | Wave 2 | 默认 10min；stream-retry-dedup 仍绿 |
| **PR-C** | Wave 3 + Wave 4 | emergency 配额；硬压缩 5s；任意后台终态立即注入 |
| **PR-D** | Wave 6 + Wave 5 | §6.7 模块不再用命令名单做控制流；AcceptanceTracker/task-state/memory/UI/RepoShape/preflight 按依据改完；回归绿 |

---

## 3. 硬约束（落地时仍有效）

**允许**

- 改 BranchBudget 的 reset 调用点与注释。
- 按 **background / running / completed / exit / 写文件** 改进度分类。
- 改适配器默认 timeout、Harness 层 retry 常数。
- 改 emergency compact 次数与压缩前等待上限。
- 改系统提示、workspace-anchor、rebuild、shell-tool 描述（含：用户指定了检查命令则必须用那个）。
- **停用并拆除**生产路径上的 `isHarnessVerificationCommand` 等命令名单控制流。
- 改 AcceptanceTracker、task-state、session-memory、memory-recall、RepoShape、编年史文案、preflight 启发式。
- 把用户 goal 里出现的命令原样登记并执行；不因此给该命令开运行时特权。

**禁止**

- 工具轮开始继续 `resetRoundBudget()`。
- 新用户消息 / 新 `harness.run()` **不**清三维计数。
- 检查失败直接 `circuit_breaker`。
- 改 CompletionGate 有界退出、Checkpoint V3 主结构、记忆子系统换架构（session-memory 只去 JS 锚定，不重做记忆）。
- 在 `LLMAdapter.stream` 已 `emittedAny` 后 `withRetry` 重放。
- **新增或延长**任何语言/框架命令名单。
- 为「支持 Rust/Go」增加 Cargo.toml / go.mod 专段（换名单）。
- 因为用户说了 `cargo test` / pytest 就给这些命令写特殊超时、后台特权或进度规则。

---

## Wave 0 — 跨轮 BranchBudget

覆盖：依据 §6.1、验收场景 1。与语言无关。

### 任务 0.1 — 工具轮不再清三维计数

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/harness/harness-tool-round.ts`、`src/harness/branch-budget.ts`（注释） |
| **不要改** | `src/harness/harness.ts` 里每次 `run()` 的 `resetRoundBudget()` |

**Checklist**

- [ ] 删除 `runHarnessToolRound` 里工具执行前的 `state.branchBudget?.resetRoundBudget()`
- [ ] 注释改为：三维计数在**每次用户发送 / 每次 `harness.run()`** 归零，**不**在每轮工具开始归零
- [ ] 不要按命令是否像测试来 reset 或豁免

**验收**

- 同一次 `run()` 内连续多轮 `edit_file` 同一 path，次数跨轮累加

---

### 任务 0.2 — 跨轮累计单测

| 项 | 内容 |
|----|------|
| **依赖** | 0.1 |
| **修改** | `test/harness/branch-budget.test.ts`；必要时 `rebuild-escalation.test.ts` |
| **保持绿** | `test/harness/harness-run-reset.test.ts` |

**Checklist**

- [ ] 跨「模拟两轮」不 reset 则第 `fileEditMax+1` 次 `wouldBlockFileEdit`
- [ ] 一次 `run()` 两个 tool 轮次各 edit 同一文件，计入预算
- [ ] checkpoint 耗尽后新 run 仍允许 edit

**验收**

- `npx vitest run test/harness/branch-budget.test.ts test/harness/harness-run-reset.test.ts test/harness/rebuild-escalation.test.ts`

---

## Wave 1 — 通用进度事实 + 提示词

覆盖：依据 §6.2、§6.6、§6.8、验收场景 2 / 3 / 8 / 9 / 11。

### 任务 1.1 — 后台启动不算 meaningful_progress

| 项 | 内容 |
|----|------|
| **依赖** | 无（纯函数可与 Wave 0 并行；合入同一 PR-A） |
| **修改** | `src/harness/tool-round-progress.ts` |
| **参考** | `classifyRunCommandResult`（看 kind，不看 command 是否像测试） |
| **禁止** | 调用 `isHarnessVerificationCommand`；为 pytest/mvn 加特殊分支 |

**Checklist**

- [ ] 删掉「`run_command` 且命中验收正则 → 有进展」
- [ ] 规则：`background_start` / `background_running` / escalated 启动 → 该条为 `non_progress_success`
- [ ] 前台结束且 success、或 `background_completed` 且成功 → 该条可构成有进展
- [ ] 删掉「读 `.test.` / `/test/` 路径算 meaningful_progress」（`MEANINGFUL_TEST_READ_RE`）
- [ ] 单测 command 至少三条，期望**完全相同**：名单内一条、另一栈一条、**现有 `isHarnessVerificationCommand` 匹配不到的**一条（推荐 `./scripts/ci.sh` 或 `just check`）。不要写成「支持 npm/pytest/mvn」。

**验收**

- 仅后台 started JSON + success → 上述三类命令都 **不是** `meaningful_progress`
- `edit_file` 成功 + 任意 command 后台启动 → 仍可以是 `meaningful_progress`（因为有写入）
- 仅前台成功、无 background JSON → 三类命令都是 `meaningful_progress`

---

### 任务 1.2 — 接入 tool-round

| 项 | 内容 |
|----|------|
| **依赖** | 1.1 |
| **修改** | `src/harness/harness-tool-round.ts`、`test/harness/tool-round-progress.test.ts` |
| **不要改** | `CIRCUIT_BREAKER_THRESHOLD`；不要为「检查红」新增熔断 |

**Checklist**

- [ ] 分类时传入 `classifyRunCommandResult` 的 kind / 输出，不传入「是不是验收命令」
- [ ] 单独的后台启动不能清 `consecutiveToolFailures`
- [ ] 检查失败不因命令名 `submitModeSignal(tool_failure)`；完整改为「任意失败 run_command 不升 forced」在任务 6.1

**验收**

- `npx vitest run test/harness/tool-round-progress.test.ts`
- 不得引入新的语言命令正则

---

### 任务 1.3 — 所有注入文案去工具链

| 项 | 内容 |
|----|------|
| **依赖** | 无（可与 1.1 并行） |
| **修改** | `src/prompts/sections.ts`；`src/harness/rebuild-escalation.ts`；`src/harness/workspace-anchor.ts`；`src/tools/builtin/shell-tool.ts` description |
| **参考** | 依据 §6.6 |

**Checklist**

- [ ] sections：去掉唯一 `npm test` 示例；开放规则（**用户指定了检查命令/框架则必须用那个**；否则当前仓库找检查方式；启动≠通过；check 到退出）。不要改成多语言对照表
- [ ] rebuild：删除 `e.g. npm test`；失败路径不要写死 `.test.ts`
- [ ] workspace-anchor：删除 `use npm test`；改为 cwd 已在仓库根、直接执行检查命令（用户指定则用用户的）
- [ ] shell-tool description：长任务/短任务不要举 npm test、vitest、tsc --noEmit 为唯一例子
- [ ] 这些文件不得把「请默认用 npm/cargo/go/pytest」写成系统指令；可以说「跟用户指定的命令走」

**验收**

- 对上述文件检索 `npm test` / `vitest` / `cargo test`：生产字符串（非测试夹具）为零或仅出现在被删除的 diff 里

---

### 任务 1.4 — 删除 LONG_RUNNING 测试特权（必做）

| 项 | 内容 |
|----|------|
| **依赖** | 1.3 更合适（提示词先告诉模型会后台化） |
| **修改** | `src/tools/shell-runtime-classifier.ts`、对应测试、`shell-tool.ts` description |
| **禁止** | 把 pytest / mvn / gradle 加进 `LONG_RUNNING` |

**Checklist**

- [ ] 从 `LONG_RUNNING` **删除** `npm|pnpm|yarn … test` 与 `vitest|jest|playwright|cypress` 这类「测试命令特权」（保留 docker / git clone / curl -o 等与语言无关的基础设施长任务，若你认为 playright 也是测试则一并删）
- [ ] 测试命令与 Java/Python 一样走现有 `auto` + `SOFT_TIMEOUT_MS` escalate，避免「只有 JS 测试立刻后台」
- [ ] 工具 description 不要只举 npm test 为长任务例子
- [ ] 若担心 JS 回归：软超时 escalate 已存在，用单测钉「未进 LONG_RUNNING 的长命令仍会 escalate」，不要用加名单解决

**验收**

- `LONG_RUNNING` diff 只有删除/收紧，没有新增语言测试正则
- `npm test` 与 `./scripts/ci.sh` 分类结果同属 `auto`（或同等 generic），不再只有 JS 测试立刻 `long`

---

## Wave 2 — LLM 传输

覆盖：依据 §6.3、验收场景 4–5。**P0-13 红线。**

### 任务 2.1 — 请求超时与 Stream 空闲检测

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/llm/openai-adapter.ts`、`src/llm/stream-idle-watchdog.ts`、`src/config/model-capabilities.ts` 注释 |

**Checklist**

- [x] SDK 默认 `timeout` 保持 600000，主要覆盖非 stream / stream 取响应头前的传输
- [x] stream 使用单一 **300000 ms 无活动超时**，每个 SSE chunk 重置
- [x] 仍尊重 `provider.requestTimeoutMs` 与 `ICE_OPENAI_REQUEST_TIMEOUT_MS`

**验收**

- 未配置时 stream 连续 300s 无活动即中止；持续有 chunk 不因空闲检测中止
- 用户 abort 与 stream 空闲超时分类不同

---

### 任务 2.2 — Harness 层传输重试

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/harness/harness-constants.ts`、`src/harness/harness-llm-call.ts` |
| **约束** | Harness 调用必须传 `skipRetry: true`，避免 LLMAdapter × Harness 乘法重试 |

**Checklist**

- [x] 一般传输错误仍最多重试 **3** 次
- [x] stream 空闲超时最多重试 **1** 次
- [x] abort 不重试
- [x] 重试等待结束时清理 timer / abort listener

**验收**

- stream 空闲最多两次请求后 `action: 'error'`；abort 零次 retry
- Harness 路径不会进入 Adapter 内层重试

---

### 任务 2.3 — 半截流整轮重试不拼接

| 项 | 内容 |
|----|------|
| **依赖** | 2.2 |
| **修改** | `src/harness/harness-llm-call.ts`；必要时最少 step 事件 + `chat-ws-turn.ts` |

**Checklist**

- [ ] 已推过 stream delta 后因可重试错误 rewind：先作废本轮流，再新开一轮
- [ ] `test/llm/stream-retry-dedup.test.ts` 四条语义不变

**验收**

- 适配器层产出后再 hang up → `provider.stream` 仍只调一次
- UI / step 不把两次尝试拼成一句

---

## Wave 3 — 压缩

覆盖：依据 §6.4、验收场景 6–7。

### 任务 3.1 — emergency compact 配额

| 项 | 内容 |
|----|------|
| **依赖** | 无（建议 PR-C） |
| **修改** | `harness-run-state.ts`、`harness-llm-call.ts`、`harness-compaction.ts` 及对应测试 |

**Checklist**

- [ ] 每 run 最多 **3** 次 emergency/proactive fork（共用配额）
- [ ] 成功硬压缩且占用回到微压缩线以下时归还 1 次（不超过 max）
- [ ] 配额用尽后再触窗口 → error，不循环 compact

**验收**

- 第 1、2 次可 fork；第 4 次 error

---

### 任务 3.2 — 硬压缩等笔记改为 5s

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/harness/harness-constants.ts` |

**Checklist**

- [ ] `PRE_COMPACT_SESSION_MEMORY_WAIT_MS`：120_000 → **5_000**
- [ ] 超时仍读盘继续

**验收**

- 笔记永不 resolve 时，约 5s 内结束硬压缩路径

---

## Wave 4 — 后台终态摘要

覆盖：依据 §6.5。

### 任务 4.1 — 任意后台终态立即注入

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/harness/harness-bg-summary.ts`、必要时 `background-task-manager.ts`、`test/harness/harness-bg-summary.test.ts` |
| **禁止** | 用 `isHarnessVerificationCommand` 决定是否立刻注入 |

**Checklist**

- [ ] running：所有任务仍可 5 分钟节流
- [ ] **任意** task 进入 completed / failed / timeout / killed：下次 prep 必须能注入，即使 < 5min
- [ ] dirty 优先于 interval
- [ ] 块 ≤ 600 字
- [ ] 单测用名单内、另一栈、以及 `./scripts/ci.sh` 作为 command/label，**终态注入行为必须相同**

**验收**

- 刚失败的后台任务，无论命令字符串，`takeBgStatusForInjection` 非 null
- 仍在 running 且未 dirty 的任务继续受 5min 节流

---

## Wave 6 — 去栈写死（其余模块）

覆盖：依据 §6.7、§6.8、验收场景 10–12。在 Wave 1 之后做；可与 Wave 2/3 并行，但合入 PR-D。

### 任务 6.1 — 停用验收命令正则控制流

| 项 | 内容 |
|----|------|
| **依赖** | 1.1 / 1.2 |
| **修改** | `verification-digest.ts` 调用点：`harness-tool-round.ts`（digest 注入 + `countModeEscalatingFailures`）、`harness-tool-executor.ts`、`verification-output-buffer.ts`、`rebuild-escalation.ts`、`branch-budget.ts` `resetCommandRetriesForVerificationCommands` |
| **禁止** | 把正则改长；新代码调用 `isHarnessVerificationCommand` |

**Checklist**

- [ ] 失败摘要：任意失败的 `run_command` 截取输出尾部，不走 `parseVitestFailureDigest` 作为唯一路径
- [ ] `countModeEscalatingFailures`：任意失败的 `run_command` 都不升 forced（不要「像测试才排除」）
- [ ] buffer：任意失败命令都可 `recordFailed`
- [ ] 续段：清全部 command retry 键，不按验收正则过滤
- [ ] 生产路径 `isHarnessVerificationCommand` / `isUnitTestVerificationCommand` / `isBuildVerificationCommand` / `isTestVerificationCommand` 引用为零（测试里测「已删除/未使用」即可）。能删函数则删

**验收**

- `./scripts/ci.sh` 失败也会进 buffer / 可出通用 digest
- `rg isHarnessVerificationCommand src` 无生产引用

---

### 任务 6.2 — AcceptanceTracker 只抽用户原文

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/harness/task-acceptance-tracker.ts` 及测试 |
| **参考** | 依据 §6.8 |

**Checklist**

- [ ] 删除写死的 `npm ci → npm test → npm run build → npm run test:e2e` 抽取
- [ ] 删除 `npx vitest` → `npm test` 归一
- [ ] 只把用户 goal 里**明确出现的命令片段**当成不透明字符串（反引号、列举）；这就是「按用户方案走」
- [ ] 抽不到则命令列表为空，不填默认 Node 流水线
- [ ] 用户写了 `cargo test` / `pytest -q` / `./scripts/ci.sh` 时原样登记，不要翻译成别的工具链

**验收**

- goal 不含 npm 时，不会凭空登记 `npm test`
- goal 写 `./scripts/ci.sh` 或 `cargo test` 时原样登记该字符串
- goal 写 `npx vitest run` 时登记的是用户那串，不是 `npm test`

---

### 任务 6.3 — task-state 意图去框架名

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/harness/task-state.ts`（`inferIntent` / `hasExecutableSideSignal` / `looksLikeVerificationCommand`）及测试 |

**Checklist**

- [ ] 「测试 / 跑测 / verify / run tests」可以导致 `test` 意图
- [ ] 删除对 vitest/jest/pytest/mocha/npm test/tsc 的匹配
- [ ] `looksLikeVerificationCommand` 删除，或不再用 `isUnitTestVerificationCommand`

**验收**

- 「跑一下仓库里的检查」可进 test/debug 类意图，不必出现 vitest
- 仅提到 `Cargo.toml` 文件名不等于自动 `test` 意图（不要换成匹配 cargo）

---

### 任务 6.4 — session-memory / memory-recall

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/memory/file-memory/session-memory.ts`、`memory-recall.ts` 及测试 |

**Checklist**

- [ ] 有 package.json 只作「读到的文件事实」，不当成全局测试栈
- [ ] 无 package.json：不写 vitest/jest 锚定、不编造 Node 栈
- [ ] 删除 Jest vs Vitest 一致性警告
- [ ] **不要**新增 Cargo.toml / go.mod / pyproject 专段
- [ ] memory-recall：删除 jest↔vitest↔mocha 内置同义表；按用户原词搜

**验收**

- 空目录/纯 Go 仓库 hydrate 笔记不出现 vitest=true/false 这类 Node 结论
- 用户没说 jest 时，recall 不自动加 vitest 扩词

---

### 任务 6.5 — RepoShape 去 JS 枚举

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/types/task-graph.ts` `RepoShape`；写入/读取该字段的构建器 |

**Checklist**

- [ ] `testFramework` / `packageManager` / `typeSystem` / `lintTool` / `buildTool` 改为 `string` 或 `unknown`（发现什么记什么，没有就空）
- [ ] 旧 checkpoint 里的 `vitest` 仍能读
- [ ] 不要改成 `vitest|jest|mocha|cargo|go|pytest` 更长枚举

**验收**

- 类型上可以记下 `"unknown"` 或任意发现值；编译通过；旧快照不崩

---

### 任务 6.6 — 编年史 / tool-trace 中性文案

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **修改** | `src/public/js/etl-chronicle.js`、`chat-execution-plan.js`、`src/public/js/tool-trace-format.js`、`src/web/tool-trace-format.ts`（保持两端一致） |

**Checklist**

- [ ] 删除「vitest/jest/playwright/cypress ⇒ 运行测试验证改动」
- [ ] `run_command` 标题用命令短截或「运行命令」
- [ ] 不要换成 cargo/go/pytest 名单

**验收**

- `./scripts/ci.sh` 与 `npm test` 在编年史里同类展示
- 两端 tool-trace-format 规则一致（已有 parity 测试则更新它）

---

### 任务 6.7 — preflight / graph-review 启发式

| 项 | 内容 |
|----|------|
| **依赖** | 6.1 更合适 |
| **修改** | `src/harness/harness-tool-preflight.ts`、`src/harness/task-graph-review.ts` |

**Checklist**

- [ ] 删除或停止用 `isBuildVerificationCommand` 做门控；改为「当前失败的那条 run_command」（执行事实）
- [ ] 删除 `SOURCE_FILE_RE` 对 `src/**/*.ts,js` 的写死；没有通用替代就删该启发式，**不要**加 `.rs`/`.go`
- [ ] graph-review：`package.json`/`tsconfig` not found 改为通用 manifest/config missing，不专认 npm

**验收**

- preflight 不再要求源文件必须是 ts/js 才算「源码」
- 不为 Rust 增加 `.rs` 正则

---

## Wave 5 — 回归与文档

### 任务 5.1 — 测试与环境变量文档

| 项 | 内容 |
|----|------|
| **依赖** | Wave 0–4 **与 Wave 6** |
| **修改** | `docs/环境变量.md` |

**Checklist**

- [ ] 适配器默认超时描述：120000 → **600000**
- [ ] `rg isHarnessVerificationCommand src` 生产引用为空
- [ ] `git diff` 无新的语言测试命令正则
- [ ] 跑：`npx vitest run test/harness test/llm/stream-retry-dedup.test.ts test/tools test/public test/memory`

**验收**

- 上述测试绿
- 依据 §6.7 每一行能指认「已改成通用」或「该启发式已删除」

---

## 9. Agent Prompt 片段

复制时把 `{N.N}` 换成任务号。同一时间只做**一个**任务。

```text
基于 docs/requirement/Harness长任务稳定性.md 与
docs/requirement/Harness长任务稳定性-任务拆分.md 实现任务 {N.N}。

严格要求：
1. 只做该任务 Checklist，不提前做后续 Wave
2. 不加大 maxRounds / 24h / 50M token
3. 不把项目检查失败打成 circuit_breaker
4. 不修改 LLMAdapter.stream 在 emittedAny 之后的重试（P0-13）
5. 新用户消息仍 resetRoundBudget；只禁止工具轮开头清预算
6. 保持 checkpoint 恢复后的新 run 仍允许 edit
7. 不要按语言枚举（Rust/Go/Java/Python 都不要写进正则或提示对照表）。
   运行时只看 background/running/exit/写文件。
   用户指定了检查命令/框架则必须按用户原文走（不透明字符串）；未指定才由模型读当前仓库决定。
   单测必须包含现有名单匹配不到的命令字符串（如 ./scripts/ci.sh），且期望与任意其它 command 相同。
   不要因为夹具里出现了 cargo/pytest 就给它们写特权规则。
8. 完成后列出：修改文件、测试命令与结果、未做事项
```

Wave 2 额外：

```text
9. test/llm/stream-retry-dedup.test.ts 必须保持四条语义
```

---

## 10. 建议不要在本方案做的跟进

审查里见过、**本拆分仍不做**：

- 子代理 180s 信封
- `compactionKeepRecent` Web=10 vs 默认 15
- MICRO_MAX_PER_SESSION = 24
- CompletionGate 同签名只 continue 一次
- 失败工具路径上同步 await checkpoint 落盘
- 工具 abort 时 orphan 进程
- 重做整套记忆架构（只去 JS 测试栈锚定）
- 为每种语言各写一份 manifest 解析器
