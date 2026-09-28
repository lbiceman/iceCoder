# iceCoder 多 Agent 协同方案（最终版）

## 0. 结论

目标形态对齐 Claude Code / OpenCode 这类编码 Agent：**主 Agent 通过一个 `task` 工具派出子 Agent；每个子 Agent 是一个完整的 Agent 循环，有自己独立的上下文，能读代码、改代码、跑命令、自己验证，一直干到任务完成，再把报告交回主 Agent。** 主 Agent 可以在一条回复里同时派出多个子 Agent 并行干活。

实现方式：**子 Agent 就是一个子 `Harness` 实例。** 它直接复用主 Harness 已有的全部能力——长循环（默认 5000 轮上限）、上下文压缩、失败恢复、权限确认、验证计划与停止判定——而不是另写一个几轮就结束的小循环。

适用范围：**只在默认模式生效。** Shell 协作模式、规划模式下不暴露 `task` 工具，行为保持现状。设置页可以关闭子 Agent；关闭后不暴露 `task`，也不注入 Sub-agents 提示词。字段缺失视为开启。

是否使用：**由主 Agent 自行决定，不强制。** 默认模式下 `task` 只是主 Agent 可用的一个工具；用不用、何时用、派几个、派哪种类型，都由主模型判断。系统没有任何规则强制派出子 Agent，也不会因为没派子 Agent 而拦截停止或判定任务失败。简单任务主 Agent 直接自己做即可。

### 与上一版方案相比的变化

| 上一版 | 本版 | 原因 |
| --- | --- | --- |
| 子 Agent 用 `SubAgentRunner` 小循环（10 轮 / 180 秒） | 子 Agent 是完整的子 `Harness` | 要能干大活，必须有压缩、恢复、验证等全套能力；自己再写一套只会更弱 |
| 只读分析异步回传 `[Analysis Ready]`，Worker 回传 patch | `task` 调用直接返回子 Agent 的最终报告 | 与参考产品一致；主 Agent 拿到结果就能接着做，不用等待、轮询、消费标记 |
| Main Harness 是主 workspace 唯一写者，Worker 在 git worktree 里改、主 Agent 再 apply | 子 Agent 直接在主 workspace 里改，并行写入用文件租约防冲突 | 参考产品的默认做法；改动走同一条工具管线，天然进入 checkpoint、可回滚；worktree 隔离留作后期可选项 |
| 规则式自动委派（按意图和关键词派分析） | 由主模型决定何时委派，靠工具描述、系统提示和 Agent 类型说明引导 | 规则推出来的任务质量差；参考产品都是模型决定 |
| 子 Agent 管理器每轮新建 | 同步模式下子 Agent 生命周期在本轮内，无需跨轮管理；后台模式（Phase 2）再引入会话级注册表 | 简化 |

保留的约束：子 Agent 不能再派子 Agent；Agent 之间不直接对话；不新增第二套 Supervisor；TaskGraph 不做 Agent 调度；Verification Gate、Checkpoint、ToolGate、HostGuard、权限系统的职责不变。

---

## 1. 目标形态

```
用户：修复支付超时问题，并确保退款流程不受影响

主 Agent
  ├─ 读几处入口，判断可以拆成两块互不重叠的工作
  ├─ 同一条回复里并行调用：
  │    task(general, "修复支付超时重试", prompt=…范围 src/payment/**…)
  │    task(general, "核查退款流程", prompt=…范围 src/refund/**…)
  │    task(explore, "找出支付与退款的共享依赖", prompt=…)
  │
  │   三个子 Agent 各自独立运行：读、改、跑测试、修，直到完成
  │   聊天区三张 Agent 卡片实时显示它们在做什么
  │
  ├─ 三份报告返回（改了哪些文件、跑了哪些命令、结论）
  ├─ 主 Agent 审阅、补充修改、跑最终验证
  └─ 回复用户
```

子 Agent 能做的事与主 Agent 在默认模式下能做的一样（按类型收窄，见 §4.3），区别是：

- 从空白上下文开始，只拿到主 Agent 写给它的任务说明和项目规则；
- 不能派子 Agent，不能向用户提问（需要确认的危险操作照常弹给用户，标明是哪个子 Agent 发起的）；
- 不写长期记忆；
- 结束时必须输出结构化报告。

---

## 2. 现有代码事实（与本方案相关）

| 事实 | 位置 | 对方案的意义 |
| --- | --- | --- |
| Web 端每条用户消息 `new Harness(config, toolExecutor)` 后 `run()` | `src/web/chat-ws-turn.ts` | 子 Harness 用同样方式创建即可 |
| 主循环默认上限 5000 轮、24 小时、token 预算 5000 万 | `src/harness/token-budget-config.ts` | 子 Agent 也能跑长任务，只需另设合理默认值 |
| `StreamingToolExecutor` 对 `isConcurrencySafe` 的工具并行执行，非并发安全的工具等前面全部完成 | `src/harness/streaming-tool-executor.ts`、`src/tools/tool-metadata.ts` | 把 `task` 标为并发安全，同一回复里的多个 `task` 自然并行 |
| 默认模式 / Shell 协作 / 规划模式由会话工具策略决定 | `src/session/session-tool-policy.ts` | `task` 只在默认模式注册 |
| 写前快照按 sessionId 找“活跃回合” | `src/harness/intent-checkpoint-turn-snapshot.ts` | 子 Agent 的写入要挂到父会话的活跃回合上 |
| touched files、tool trace diff 按 sessionDir + sessionId 记录 | `src/harness/intent-checkpoint-store.ts`、`src/web/session-tool-trace-diffs.ts` | 同上，需要“checkpoint 归属”覆盖 |
| 回滚依据写前快照和 UI 消息中的 `tool_trace` 条目 | `src/harness/session-workspace-restore.ts`、`runtime-restore-coordinator.ts` | 子 Agent 的工具轨迹要写进父会话的 UI 消息 |
| 工具在创建时把 workDir、sessionId 闭包进去（read-before-edit、后台任务按此记录） | `src/tools/index.ts`、`src/tools/read-before-edit.ts` | 子 Agent 复用主会话的 ToolExecutor，读过的文件对主 Agent 也算已读 |
| `run()` 开始时 `clearReadBeforeEditScope(workspaceRoot, sessionId)` | `src/harness/harness.ts` | 子 Harness 必须用独立 sessionId，否则会清掉父会话的已读记录 |
| 流式输出、step 事件经 `onStep` 回调，由 `chat-ws-turn.ts` 广播 `step` / `stream` | `src/web/chat-ws-turn.ts` | 子 Agent 的事件要带 `agentId` 转发，不能混进主 Agent 的流 |
| 已有 `request_analysis` 异步只读分析链路 | `src/harness/sub-agent-runner.ts` 等 | 默认模式下由 `task(explore)` 取代，旧链路下线 |

---

## 3. 总体设计

### 3.1 组件

```
Harness（主）
  └─ harness-tool-executor
       └─ AgentAwareToolExecutor（本轮包装，拦截 task）
            └─ AgentSpawner.run(request)          ← 由 chat-ws-turn 注入
                 ├─ 构造子 HarnessConfig（§3.5）
                 ├─ new Harness(childConfig, 同一个 toolExecutor)
                 ├─ childHarness.run(prompt, chatFn, onChildStep, …)
                 ├─ onChildStep → 加上 agentId 转发给父 onStep（UI、日志）
                 └─ 汇总结果 → 返回给主 Agent 作为 task 的工具结果
```

- `AgentSpawner` 放在 `src/harness/agents/agent-spawner.ts`，不依赖 Web 层；Web 层（`chat-ws-turn.ts`）负责把 LLM 调用、确认回调、广播等依赖注入进去。CLI 以后可以用同一接口接入。
- `HarnessConfig` 增加 `agentSpawner?: AgentSpawner`。不传时不暴露 `task` 工具，所以 Shell 协作、规划模式、CLI 行为不变。

### 3.2 `task` 工具契约

```ts
interface TaskToolInput {
  description: string;       // 3~8 个字的短标题，显示在卡片上，如“修复支付超时重试”
  prompt: string;            // 完整、自包含的任务说明：目标、范围、已知信息、验收标准、要求的报告内容
  subagent_type: 'general' | 'explore' | string; // Phase 2 起支持自定义类型
}
```

工具结果（返回给主 Agent）：

```
[Agent Result] agent=general id=ag_xxx status=completed
duration=6m12s rounds=37 toolCalls=112 tokens=1.8M
files changed (5): src/payment/client.ts (+42 -10), src/payment/retry.ts (+18 -3), test/payment/timeout.test.ts (+60 -0), ...
commands: npm test -- test/payment → exit 0 (18 passed); npx tsc --noEmit → exit 0
--- report ---
<子 Agent 最终回复，超过 12000 字符时截断，末尾附完整日志位置>
```

- `files changed` 与 `commands` 由系统从子 Harness 的工具记录中统计，不采信子 Agent 自述。
- 状态取值：`completed`、`failed`、`timeout`、`cancelled`、`max_rounds`。非 `completed` 时仍返回已完成的改动清单和子 Agent 最后的输出。

### 3.3 Agent 类型

| 类型 | 工具 | 用途 | 默认上限 |
| --- | --- | --- | --- |
| `general` | 默认模式下主 Agent 的全部工具，去掉 §3.5 的排除项 | 独立完成一块实现、修复、重构、补测试、排查 | 2000 轮 / 4 小时 |
| `explore` | 只读工具：`read_file`、`glob`、`grep`、`fs_operation`（list）、文档解析类、只读 MCP 工具 | 大范围搜索、梳理调用链、定位问题，不改任何东西 | 300 轮 / 30 分钟 |

- 轮次、超时和 token 预算写在 `src/harness/agents/agent-config.ts`，不通过环境变量覆盖。`general` 默认 2000 轮、4 小时；`explore` 默认 300 轮、30 分钟；每个子 Agent token 预算 2000 万。
- 子 Agent 超时不得超过主 Harness 剩余时长减 2 分钟。
- 每种类型有自己的系统提示（§3.9），在主 Agent 看到的 `task` 工具描述里列出每种类型的适用场景。
- Phase 2 支持用户自定义类型（§7.2）。

### 3.4 执行与并行

- `task` 在 `tool-metadata.ts` 中标为 `isConcurrencySafe: true`。同一条回复里的多个 `task` 由 `StreamingToolExecutor` 并行执行；同一批里的其它非并发安全工具（如写文件）会等所有 `task` 完成后再执行，与现有语义一致。
- 主 Agent 在 `task` 返回前阻塞，这与参考产品的默认行为一致。需要主 Agent 同时继续干活的场景由 Phase 2 的后台模式解决。
- 并发上限：同时运行的子 Agent 最多 4 个，超出的排队；每次 `run()` 最多派出 16 个，超出时 `task` 直接返回错误并说明原因。这两个数同样在 `src/harness/agents/agent-config.ts`。
- `task` 属于中性工具：forced 模式下 ToolGate 不按 TaskGraph 节点拦截它，TaskGraph 偏离检测不把它计入同工具重复次数。

### 3.5 子 Harness 的配置

以主 Agent 本轮的 `HarnessConfig` 为基础，逐项调整：

| 配置项 | 子 Agent 取值 | 说明 |
| --- | --- | --- |
| `sessionId` | `agent-{agentId}` | 独立 id，避免清掉父会话的已读记录，也让子 Agent 的压缩、遥测、项目 checkpoint 各自独立。不含 `:`，满足 Windows 文件名要求 |
| `sessionDir` | `{SESSIONS_DIR}/{parentSessionId}/agents` | 子 Agent 自己的 checkpoint、遥测文件都在父会话目录下，会话删除时一并清理 |
| `checkpointOwner`（新增） | `{ sessionDir: SESSIONS_DIR, sessionId: parentSessionId }` | 写前快照、touched files、tool trace diff 记到父会话（§4） |
| `workspaceRoot` | 与主 Agent 相同 | 同一个 workspace |
| 工具执行器 | 与主 Agent 相同的 `ToolExecutor` | 工具实现、MCP 连接、后台任务管理全部复用 |
| `context.tools` | 按类型过滤 | 排除：`task`、`request_analysis`、记忆写入类工具、向用户提问类工具、会话模式切换类工具；`explore` 另外排除全部写入与命令执行工具 |
| `context.systemPrompt` | 该类型的系统提示 + 主 Agent 的项目规则部分（仓库说明、工作区信息、工具规则） | 不带主 Agent 的对话历史 |
| `loop` | §3.3 的上限；`signal` 为子 Agent 自己的 `AbortController`，与父轮次的中断信号联动 | |
| `supervisorConfig` | `off` | 子 Agent 自由执行，不初始化 TaskGraph，不进入 forced 模式 |
| 验证计划、停止判定、失败恢复、上下文压缩 | 与主 Agent 相同 | 子 Agent 会被自己的停止判定督促去验证改动 |
| `fileMemoryManager` / `memoryDir` | 不传 | Phase 1 子 Agent 不召回、不提取长期记忆 |
| `onConfirm` / `onShellMandatoryConfirm` | 父会话的确认回调，附带 agentId 与 description | 用户看到“子 Agent『修复支付超时重试』请求执行 …” |
| `permissions`、`skipPermissionChecks` | 与主 Agent 相同 | |
| `planModeActive`、`shellCollabActive` | false | `task` 只在默认模式出现，子 Agent 自然也是默认模式 |
| `agentSpawner` | 不传 | 禁止嵌套 |

LLM 调用：使用主会话同一个 `llmAdapter` 的 `chat` / `stream`，`usageSource: 'sub_agent'`，并带上 `agentId`。Phase 2 允许按类型指定模型。

### 3.6 并行写入：文件租约

子 Agent 直接写主 workspace。主 Agent 在 `task` 期间阻塞，所以冲突只可能发生在并行的子 Agent 之间。

- 新增 `src/harness/agents/write-lease.ts`：按 `workspaceRoot + 相对路径` 记录当前持有者 agentId。
- 子 Agent 第一次写某个文件时获取租约；租约持续到该子 Agent 结束。
- 另一个子 Agent 写同一文件时，工具返回错误：“`src/x.ts` 正由子 Agent『修复退款适配』修改。不要修改这个文件；如果确实需要改，请在最终报告中写明需要的改动。”并在 transcript 与卡片上记一条拦截。
- 主 Agent 不受租约限制（它只在子 Agent 全部结束后才会继续写）。
- `run_command` 引起的文件变化（格式化、代码生成）无法事先加租约，只能事后从命令前后的文件清单差异中发现。发现与其它子 Agent 的租约冲突时，在两个子 Agent 的报告里都标注。
- 子 Agent 禁止执行会改变仓库历史或工作区整体状态的 git 命令：`commit`、`push`、`reset`、`checkout`、`switch`、`stash`、`rebase`、`merge`、`clean`。只读 git 命令（`status`、`diff`、`log`、`show`）允许。这条规则在子 Agent 的命令预检里实现。

系统提示要求主 Agent：并行派出的 `general` 子 Agent 应分配互不重叠的文件范围。

### 3.7 结果回传与主 Agent 的验收

- 子 Harness 结束后，`AgentSpawner` 汇总：最终回复、状态、轮次、工具调用数、token、改动文件（含增删行数）、执行过的命令与退出码、被租约拦截的记录。
- 子 Agent 改过的文件合并进主 Agent 的 `taskState.filesChanged` 与 `repoContext`，主 Agent 的 Verification Gate 因此知道这些文件被改过。
- 验证证据的继承：子 Agent 运行过的验证命令，如果满足“在该子 Agent 最后一次写入之后运行、且之后没有任何 Agent 再写过相关文件”，作为主 Agent 验证状态的证据导入；否则主 Agent 需要自己再验证。最终验收始终由主 Agent 的 Verification Gate 决定。
- 主 Agent 的结构化消息里只有 `task` 调用和这份结果，子 Agent 的完整对话不进入主 Agent 上下文。这是派子 Agent 最主要的收益：主上下文保持干净。

### 3.8 取消、超时、失败

- 用户中断当前轮：所有运行中的子 Agent 收到中断，子 Harness 按现有 `user_abort` 路径结束，`task` 返回 `cancelled` 与已完成的改动。
- 卡片上的停止按钮：只中断该子 Agent，主 Agent 收到 `cancelled` 结果后继续。
- 超时、达到轮次上限、token 预算耗尽、熔断：`task` 返回对应状态与已完成的改动，主 Agent 决定继续、重新派发或自己处理。
- 子 Harness 抛出异常：捕获后返回 `failed` 与错误信息，不影响主循环。
- 进程在子 Agent 运行中退出：主轮次也随之中断。子 Agent 的元数据标记为 `interrupted`；主会话恢复时，未返回结果的 `task` 调用由现有的缺失工具结果补齐逻辑处理，补齐内容附上该子 Agent 已改动的文件清单。

### 3.9 提示词：让主 Agent 会用、子 Agent 会干

**主 Agent**（`src/prompts/sections.ts` 新增 “Sub-agents” 段，仅在 `task` 可用时出现）：

- 适合派子 Agent：需要在大量文件里搜索、答案不在一两个文件里的问题（`explore`）；可以拆成几块互不重叠的实现或修复（多个 `general` 并行）；一块体量大、边界清楚的工作，想让主上下文保持干净（`general`）。
- 不适合：读一个已知文件、改几行代码、只需一两次搜索就能回答的问题。
- 能并行时在同一条回复里一次发出多个 `task`。
- `prompt` 必须自包含：子 Agent 看不到对话历史，要写清目标、范围（允许改哪些路径）、已知信息、验收方式、报告需要包含什么。
- 子 Agent 的报告用户看不到全文，主 Agent 要自己审阅并向用户转述要点；子 Agent 的改动已经写入 workspace，主 Agent 需要审阅并做最终验证。

**子 Agent**（每种类型一个系统提示，`src/harness/agents/agent-prompts.ts`）：

- 你是被主 Agent 派来完成一项具体任务的子 Agent；用户看不到你的中间过程，只看到主 Agent 转述的结果。
- 完成整个任务再结束，不要中途停下来提问；遇到无法决定的问题，按最合理的做法推进，并在报告里说明。
- 只改任务范围内的文件；不要提交、推送或切换分支。
- `general`：改完必须运行相关验证，并如实报告结果。
- 结束时输出报告，固定段落：结论、改动（文件与原因）、验证（命令与结果）、未完成或有风险的地方。

---

## 4. Checkpoint 与会话日志

原则：**子 Agent 的每一次写入都走和主 Agent 相同的工具管线，并记在父会话、当前用户消息的名下。** 因此回滚、diff 查看、touched files 统计都不需要另写一套。

### 4.1 写入归属

- 新增 `HarnessConfig.checkpointOwner`。`harness-tool-executor.ts` 中调用 `capturePreTurnWriteSnapshot`、`recordPreTurnMissingFile`、`touchSessionTouchedPaths` 的地方，改为优先使用 `checkpointOwner` 的 sessionDir / sessionId。
- `intent-checkpoint-turn-snapshot.ts` 新增 `linkAgentToTurn(childSessionId, parentSessionId)`：子 Agent 开始时建立关联，结束时解除。`capturePreTurnWriteSnapshot` 查活跃回合时先按关联找到父会话。
- 结果：子 Agent 首次写某个文件前的内容，进入当前用户消息的 Intent Checkpoint；回滚到这条消息时，子 Agent 改过的文件被还原，新建的文件被删除。

### 4.2 工具轨迹

- 子 Harness 的 `tool_call` / `tool_result` 事件经 `AgentSpawner` 转发给父 `onStep`，带上 `agentId` 与 `parentToolCallId`（发起它的那次 `task` 调用）。子 Agent 的 `toolCallId` 加前缀 `{agentId}:`，保证在父会话内唯一。
- `chat-ws-turn.ts` 把这些事件与主 Agent 的工具轨迹一样收进 `toolTraceBatch`，写入父会话 UI 消息（`role: 'tool_trace'`，新增字段 `agentId`、`parentToolCallId`），diff 写入父会话的 tool trace diff 索引。
- 回滚流程读取 UI 消息中的 `tool_trace` 条目时，子 Agent 的写入条目会被一并识别，不需要改回滚逻辑。
- 前端渲染时，带 `agentId` 的条目挂到对应 Agent 卡片内，不出现在主 Agent 的工具轨迹里（§5）。

### 4.3 子 Agent 自己的记录

目录：`{SESSIONS_DIR}/{parentSessionId}/agents/`

| 文件 | 内容 |
| --- | --- |
| `{agentId}.meta.json` | 类型、description、prompt、发起的 `messageId` 与 `parentToolCallId`、状态、起止时间、轮次、工具调用数、token、改动文件、命令记录、租约拦截记录、最终报告 |
| `agent-{agentId}.structured.json` | 子 Harness 的完整结构化消息，供“打开子会话”查看和问题排查 |
| 子 Harness 自身的 checkpoint、遥测文件 | 由 `sessionDir` 指向该目录自动生成 |

子 Agent 的对话不并入父会话结构化消息，不进入长期记忆，不写 session notes。

### 4.4 生命周期联动

| 场景 | 处理 |
| --- | --- |
| 回滚到消息 M | 现有流程还原文件、截断消息；另外删除 `messageId` 为 M 及之后的子 Agent 记录。回滚本来就要求会话不在运行中，此时不会有运行中的子 Agent |
| 删除单条消息 | 删除该消息派生的子 Agent 记录与 UI 条目；与现有语义一致，不回滚 workspace |
| 删除会话 | `agents/` 位于会话目录内，随现有清理一起删除 |
| 进程重启 | 见 §3.8 |
| 父会话项目 checkpoint | 不需要新增内容：`task` 的调用与结果本身就在主 Agent 的消息里 |

### 4.5 用量统计

- token usage log 每条记录增加 `agentId`（主 Agent 为空），来源 `sub_agent`。
- 统计页按“主 Agent / 子 Agent（按类型）”拆分。
- 本轮 agent 气泡上的用量显示为“主 Agent X + 子 Agent Y”，每张 Agent 卡片显示自己的用量。

---

## 5. 聊天区 UI

### 5.1 Agent 卡片

主 Agent 调用 `task` 时，工具轨迹里的这一行渲染为一张 Agent 卡片，卡片内实时展示子 Agent 在做什么。

**运行中**

```
┌ [general] 修复支付超时重试                                   运行中 · 02:41 · 23 次工具调用   ■ 停止
│  ▸ 读取 src/payment/client.ts
│  ▸ 编辑 src/payment/retry.ts   +18 -3        (可展开 diff)
│  ▸ 运行 npm test -- test/payment   → exit 1
│  ▸ 编辑 src/payment/retry.ts   +2 -1
│  … 正在分析测试失败原因
└  还有 18 条 · 展开
```

- 标题行：类型徽标、description、状态、计时、工具调用数；运行中显示停止按钮。
- 活动区：子 Agent 的工具轨迹，复用主 Agent 工具行的渲染（包括写入类工具的 diff 展开），默认显示最近 5 条，更早的折叠。
- 最后一行显示子 Agent 当前的流式输出摘要（最近一句），不展开全文。

**完成后**（自动折叠为一行）

```
[general] 修复支付超时重试   已完成 · 6m12s · 112 次工具调用 · 改了 5 个文件 · 测试通过   ⌄
```

展开后包含：

- 最终报告（Markdown 渲染）；
- 改动文件列表，每个文件可展开 diff；
- 执行过的命令与退出码；
- 全部工具轨迹（折叠，可展开）；
- 用量：轮次、token；
- “打开子会话”：以只读方式查看该子 Agent 的完整对话与工具调用。桌面端在侧边抽屉打开，移动端全屏打开。

**状态**：运行中（蓝）、已完成（绿）、失败 / 超时 / 达到上限（红 / 橙，附原因）、已取消（灰）。有租约拦截时在标题行加橙色提示“1 次写入被拦截”。

### 5.2 并行分组

同一条回复里派出的多个 `task` 合成一组：

```
并行 3 个 Agent · 2 运行中 · 1 已完成
  ├ [general] 修复支付超时重试      运行中 · 02:41
  ├ [general] 核查退款流程          运行中 · 01:58
  └ [explore] 找出共享依赖          已完成 · 0:52
```

每一行都是一张可展开的 Agent 卡片。

### 5.3 确认弹窗

子 Agent 触发的权限确认沿用现有确认弹窗，标题加上来源：“子 Agent『修复支付超时重试』请求执行：…”。多个子 Agent 同时请求时按到达顺序排队显示。

### 5.4 执行面板

右侧执行流中，派出子 Agent 的轮次显示“派出 N 个 Agent”，点击跳到对应卡片组。子 Agent 的改动属于该轮，检查点章节里的文件变更自动包含它们。

### 5.5 移动端

卡片只显示标题行，点击后以底部抽屉展示活动区与结果；“打开子会话”为全屏页面。

### 5.6 数据通路

- **step 事件**：子 Agent 的 step 经父 `onStep` 转发，`chat-ws-turn.ts` 广播时带上 `agentId`、`parentToolCallId`：`{ type: 'step', step, agentId, parentToolCallId }`。
- **流式输出**：子 Agent 的 `stream_delta` / `reasoning_stream_delta` **不能**走主 Agent 的 `stream` / `reasoning_stream` 消息，改发 `{ type: 'agent_stream', agentId, delta }`，前端只用于卡片上的“当前在做什么”一行。
- **卡片状态**：`AgentSpawner` 在子 Agent 开始、状态变化、结束时发 `{ type: 'agent_update', agent: AgentView }`；活动类更新节流为每 500ms 最多一次。
- **刷新与重连**：`foldStepIntoRunningTurn` 按 `agentId` 分别折叠子 Agent 的事件；新连接从运行中快照里恢复卡片与活动。
- **历史回放**：历史消息里的 `task` 条目与带 `agentId` 的 `tool_trace` 条目足以还原卡片的工具轨迹；标题行与报告从 `{agentId}.meta.json` 读取（REST：`GET /api/sessions/:id/agents`、`GET /api/sessions/:id/agents/:agentId`、`GET /api/sessions/:id/agents/:agentId/messages`）。
- **停止**：WS 入站 `agent_stop { agentId }`，回 `agent_stop_result`。

```ts
interface AgentView {
  agentId: string;
  parentToolCallId: string;
  messageId: string;
  type: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'max_rounds' | 'cancelled';
  startedAt?: number;
  finishedAt?: number;
  rounds: number;
  toolCalls: number;
  tokens: number;
  filesChanged: Array<{ path: string; additions: number; deletions: number }>;
  commands: Array<{ command: string; exitCode: number | null }>;
  leaseRejects: number;
  currentActivity?: string;
  reportPreview?: string;
  error?: string;
}
```

---

## 6. 不做 / 禁止

1. 在 Shell 协作模式、规划模式下暴露 `task` 或改变这两个模式的行为。
2. 子 Agent 再派子 Agent。
3. Agent 之间直接对话或共享对话历史。
4. 子 Agent 向用户提问、切换会话模式、写长期记忆。
5. 子 Agent 执行改变仓库历史或工作区整体状态的 git 命令。
6. 新增第二套 Supervisor；让 TaskGraph 调度 Agent。
7. 绕过 ToolGate / HostGuard / 权限系统；子 Agent 的确认请求静默通过。
8. 子 Agent 的对话并入主 Agent 的结构化消息。
9. 规则式自动委派。委派与否由主模型决定。
10. 为子 Agent 另写运行循环。子 Agent 必须是 `Harness` 实例。

---

## 7. 分期

### 7.1 Phase 1：同步子 Agent（核心）

`task` 工具、`general` / `explore` 两种类型、子 Harness、并行执行与上限、文件租约与 git 限制、结果汇总与验证证据导入、checkpoint 归属、工具轨迹转发与持久化、子 Agent 记录、Agent 卡片与并行分组、确认弹窗来源、刷新重连与历史回放、用量拆分。默认模式下下线 `request_analysis`。

### 7.2 Phase 2：自定义 Agent 与后台模式

- **自定义 Agent**：工作区 `.icecoder/agents/*.md` 与用户目录 `~/.icecoder/agents/*.md`。frontmatter 声明 `name`、`description`（写明何时使用）、`tools`（白名单）、`model`（可选）、`maxRounds`（可选）；正文是该类型的系统提示。工作区定义覆盖同名的用户定义。加载后出现在 `task` 的 `subagent_type` 中，描述进入主 Agent 的工具说明。
- **按类型指定模型**：例如 `explore` 用更快更便宜的模型。
- **后台模式**：`task` 增加 `run_in_background: true`，立即返回 agentId，主 Agent 继续工作。需要会话级注册表管理跨轮存活的子 Agent，结果完成后在主 Agent 下一轮注入，提供 `check_agent { agentId, waitMs }` 有界等待。此时主 Agent 与后台子 Agent 可能同时写，文件租约对主 Agent 同样生效。输入框上方增加“后台 Agent：N 运行中”的状态条。

### 7.3 Phase 3（可选）：worktree 隔离

`task` 增加 `isolation: 'worktree'`。子 Agent 在 git worktree 中工作，结束后返回 patch，由主 Agent 审阅后应用。用于多个 `general` 子 Agent 需要改同一片代码、或希望先审后合的场景。等 Phase 1、2 稳定后再评估是否需要。

---

## 8. Phase 1 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/harness/agents/agent-spawner.ts` | 新增：构造子配置、运行子 Harness、事件转发、并发与每轮上限、取消、结果汇总 |
| `src/harness/agents/agent-types.ts` | 新增：`general` / `explore` 的工具过滤与默认上限 |
| `src/harness/agents/agent-prompts.ts` | 新增：各类型子 Agent 的系统提示与报告格式 |
| `src/harness/agents/agent-result.ts` | 新增：从子 Harness 结果与工具记录汇总 `[Agent Result]` |
| `src/harness/agents/agent-store.ts` | 新增：`agents/` 目录下的 meta 与结构化消息读写、按 messageId 删除 |
| `src/harness/agents/write-lease.ts` | 新增：文件租约 |
| `src/harness/agents/task-tool.ts` | 新增：`task` 工具定义（描述随可用类型生成） |
| `src/harness/types.ts` | `HarnessConfig` 增加 `agentSpawner`、`checkpointOwner`；`HarnessStepEvent` 增加 `agentId`、`parentToolCallId` |
| `src/harness/harness.ts` | 有 `agentSpawner` 时暴露 `task`；构造本轮的 `AgentAwareToolExecutor` |
| `src/harness/harness-tool-executor.ts` | 写前快照 / touched files 使用 `checkpointOwner`；写入前检查租约；合并子 Agent 改动与验证证据 |
| `src/harness/harness-tool-preflight.ts` | 子 Agent 的 git 命令限制 |
| `src/harness/intent-checkpoint-turn-snapshot.ts` | `linkAgentToTurn` / 解除关联 |
| `src/tools/tool-metadata.ts` | `task` 标为并发安全 |
| `src/harness/task-graph-review.ts`、`task-graph-executor.ts`、`supervisor/tool-gate.ts` | `task` 视为中性工具 |
| `src/prompts/sections.ts` | 主 Agent 的 “Sub-agents” 段 |
| `src/session/session-tool-policy.ts` | 仅默认模式启用；默认模式不再启用 `request_analysis` |
| `src/web/chat-ws-turn.ts` | 构造并注入 `AgentSpawner`；子 Agent 事件广播与持久化；`agent_stream` 分流；确认回调带来源 |
| `src/web/chat-ws-running-turn.ts` | 运行中快照按 `agentId` 折叠 |
| `src/web/chat-ws-inbound.ts` | `agent_stop` |
| `src/web/routes/sessions.ts` | agents 相关 REST 接口 |
| `src/harness/runtime-restore-coordinator.ts`、`src/harness/conversation-delete.ts` | 删除对应子 Agent 记录 |
| `src/llm/token-usage-log.ts`、`src/web/token-usage-stats.ts` | `agentId` 与按角色拆分 |
| `src/public/js/chat-agent-cards.ts` | 新增：Agent 卡片、并行分组、历史只读渲染 |
| `src/public/js/chat-agent-session-drawer.ts` | 新增：“打开子会话”只读视图 |
| `src/public/js/chat-ws-agent-handlers.ts` | 新增：`agent_update`、`agent_stream`、带 `agentId` 的 `step`、`agent_stop_result` |
| `src/public/js/chat-ui.ts` | `task` 行渲染为卡片；带 `agentId` 的工具轨迹挂进卡片 |
| `src/public/js/chat-page.ts`、`chat-ws-stream-handlers.ts` | 注册 handler；确保子 Agent 流不进入主消息流 |
| 确认弹窗相关前端文件 | 显示来源子 Agent |
| `src/public/js/chat-execution-plan.ts` | 轮次上的“派出 N 个 Agent” |
| 移动端页面与样式文件 | 卡片与抽屉 |

旧的 `request_analysis` / `AsyncSubAgentManager` / `AnalysisSupervisor` / `SubAgentRunner` 在默认模式下不再使用。Phase 1 完成并稳定后删除，连同相关测试。

---

## 9. 测试用例（Phase 1）

### 启用范围

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 默认模式 | 工具列表有 `task`，没有 `request_analysis` |
| 2 | Shell 协作模式 / 规划模式 | 没有 `task`，行为与改动前一致 |
| 3 | 子 Agent 的工具列表 | 没有 `task`、记忆写入、向用户提问、模式切换类工具；`explore` 没有写入与命令执行工具 |

### 运行

| # | 场景 | 期望 |
| --- | --- | --- |
| 4 | `general` 子 Agent 执行一个需要 50 轮以上的修复任务（用模拟 LLM） | 跑到完成，不会在固定小轮数处结束；中途触发上下文压缩后能继续 |
| 5 | 同一条回复里 3 个 `task` | 3 个子 Agent 同时运行；同批的写文件工具在它们全部结束后才执行 |
| 6 | 同时派出 6 个 | 最多 4 个同时运行，其余排队 |
| 7 | 一次 run 派出第 17 个 | 返回错误，说明已达上限 |
| 8 | 子 Agent 改了文件但没验证就想结束 | 被子 Harness 自己的停止判定督促验证 |
| 9 | 子 Agent 的 `[Agent Result]` | 改动文件与命令来自工具记录，与子 Agent 自述不一致时以记录为准 |
| 10 | 子 Agent 返回后 | 主 Agent 的 `filesChanged` 含子 Agent 改动；Verification Gate 按规则导入或要求重新验证 |
| 11 | 主 Agent 结构化消息 | 只有 `task` 调用与结果，不含子 Agent 对话 |

### 冲突与限制

| # | 场景 | 期望 |
| --- | --- | --- |
| 12 | 两个并行子 Agent 写同一文件 | 后写者收到租约错误；卡片显示拦截；报告中列出 |
| 13 | 子 Agent 执行 `git commit` / `git checkout` | 被拒绝；`git status` / `git diff` 允许 |
| 14 | 子 Agent 触发需确认的命令 | 弹窗显示来源子 Agent；用户拒绝后子 Agent 收到拒绝并继续 |

### 取消与失败

| # | 场景 | 期望 |
| --- | --- | --- |
| 15 | 用户中断当前轮 | 所有子 Agent 结束，`task` 返回 `cancelled` 与已完成改动 |
| 16 | 点击某张卡片的停止 | 只有该子 Agent 结束，其它继续，主 Agent 收到 `cancelled` 后继续 |
| 17 | 子 Agent 超时 / 达到轮次上限 / 抛异常 | 返回对应状态；主循环继续 |
| 18 | 子 Agent 超时设置超过主 Harness 剩余时长 | 被压到剩余时长减 2 分钟 |

### Checkpoint 与日志

| # | 场景 | 期望 |
| --- | --- | --- |
| 19 | 子 Agent 修改与新建文件后，回滚到该用户消息 | 修改被还原，新建文件被删除；对应子 Agent 记录被删除 |
| 20 | 子 Agent 的写入 | 出现在父会话 UI 消息的 `tool_trace`（带 `agentId`）与 diff 索引中 |
| 21 | 子 Agent 运行期间父会话的已读记录 | 不被清空 |
| 22 | `agents/` 目录 | 有 meta 与结构化消息；删除会话后目录消失 |
| 23 | token 用量 | 子 Agent 调用带 `agentId`；统计页可按角色拆分 |

### UI

| # | 场景 | 期望 |
| --- | --- | --- |
| 24 | 运行中 | 卡片实时显示工具轨迹与计时；子 Agent 的流式输出不出现在主消息流 |
| 25 | 写入类工具 | 卡片内可展开 diff |
| 26 | 并行 3 个 | 显示为一个分组，状态计数正确 |
| 27 | 运行中刷新页面 / 移动端扫码 | 卡片从运行中快照恢复并继续更新 |
| 28 | 历史回放 | 卡片显示最终状态、报告、改动与完整工具轨迹；“打开子会话”可查看完整对话 |
| 29 | 完成后 | 卡片自动折叠为一行摘要 |

### 端到端

| # | 场景 | 期望 |
| --- | --- | --- |
| 30 | 在带支付 / 订单 / 退款模块和测试的夹具仓库上，用真实模型执行“修复支付超时，并确保退款流程不受影响” | 任务完成且主 Agent 最终验证通过，回滚可还原全部改动。主 Agent 是否派子 Agent 不作为通过条件；若派了，子 Agent 的改动与测试结果须出现在卡片和报告中。记录派出次数，用于调整提示词 |

每个阶段结束运行：

```
npm run lint
npm test
```

---

## 10. 交付顺序

1. 子 Harness 能跑起来：`AgentSpawner` + `task` 工具 + 类型过滤 + 结果汇总，先不接 UI，用测试 1–11 验证。
2. 并行与安全：并发上限、文件租约、git 限制、确认来源、取消与超时，测试 12–18。
3. Checkpoint 与日志：`checkpointOwner`、活跃回合关联、工具轨迹转发与持久化、agents 目录、用量，测试 19–23。
4. UI：Agent 卡片、并行分组、流分流、运行中快照、历史回放、子会话查看、移动端，测试 24–29。
5. 端到端：测试 30。通过后在默认模式下线 `request_analysis`。
6. Phase 2、Phase 3 按需另行排期。

---

## 11. 风险

- **主 Agent 用不用**：委派由模型决定，模型可能倾向自己做。靠 §3.9 的提示词和 Agent 类型描述引导；用遥测记录“每次 run 的 `task` 次数”，结合真实会话调整提示词。
- **成本**：一个 `general` 子 Agent 可以跑很久，多个并行时 token 消耗成倍增加。通过每个子 Agent 的 token 预算、每轮派出上限和并发上限控制；卡片和统计页让用量可见。
- **同一 workspace 并行写入**：租约只能拦住写文件工具，拦不住命令引起的改动（格式化、代码生成）。靠系统提示要求分配不重叠的范围，并在事后检测、报告中标注。需要严格隔离时走 Phase 3。
- **全局状态**：少数运行时状态按 workspaceRoot 而非 sessionId 记录（例如命令前后的文件清单比较），并行子 Agent 之间可能把对方的改动算到自己的命令上。实现时逐个排查 `harness-tool-executor.ts` 中按 workspaceRoot 记录的状态。
- **主 Agent 阻塞**：Phase 1 中主 Agent 在 `task` 返回前不做别的事，长时间子 Agent 期间主 Agent 空等。这与参考产品的默认行为一致；需要并行时由 Phase 2 的后台模式解决。
