# chat-ws.ts 拆分方案

> 状态：**已完成**（2026-08-19）
> 范围：只拆 `src/web/chat-ws.ts`（原约 2996 行 → 现 237 行）。不改协议、不改行为、不顺带做 Harness / 前端工程化。
> 对照：前端 `chat-page.js` 已按业务域拆出 4 个 handler 模块（见 `docs/chat-page-ws-handlers-split-handoff.md`）。服务端复用「一刀一 commit、行为不变、静态测试锁死」，**不复用 ctx 注入**。

---

## 1. 目标

把巨型单文件拆成「进程运行时 + 若干业务域模块」，使：

- 改入站协议只动 inbound
- 改一轮对话只动 turn
- 改推送只动 broadcast
- `chat-ws.ts` 只剩 HTTP upgrade、connected 载荷、对外 re-export

**行为不变。** 默认组合 ≡ 今天。每一刀可单独合并、可停。

**行数指标（软）：** 主文件 ≤ 600 行；单域模块尽量 ≤ 400 行。`chat-ws-turn.ts` 允许到 ~650（它就是「一轮对话」这一个职责）。

---

## 2. 非目标

- 不改 WS 协议字段、不改 first-win confirm、不改 session 锁定（P1-8 / P1-9）
- 不把 Map 设计成「服务 / 类」；不引入 DI 容器、策略模式、event bus
- 不把 `handleChatMessage` 再按「准备 / 调用 / 收尾」切三份（那是下一轮的事）
- 不改对外 import 路径：`src/web/chat-ws.js` 仍是唯一公共入口

---

## 3. 现状切面（按行号，2026-08-19）

| 行号大约 | 内容 | 迁出目标 |
|----------|------|----------|
| 72–98 | `parseClientMessageId` / 路径 strip | `chat-ws-helpers.ts` |
| 201–423 | 路径常量、active session、cache、fileBrowser、deferred tools、**purge** | `chat-ws-runtime.ts`（purge 编排留主文件，见 §5） |
| 436–780 | abort / processing / pending / shell 队列 / enqueue 辅助 | runtime + persist + shell |
| 545–683 | `handleShellCollabRoute` | `chat-ws-shell.ts` |
| 786–865 | confirm first-win | `chat-ws-confirm.ts` |
| 868–1003 | tombstone、structured 刷盘、memory init、prewarm 接线 | runtime + persist |
| 1014–1128 | `chatClients` / `sessionSubscribers` / broadcast / sendJSON | `chat-ws-broadcast.ts` |
| 1135–1262 | bg-task pusher 接线 / `handleBgTaskStop` | `chat-ws-bg-tasks.ts` |
| 1274–1484 | `RunningTurnSnapshot` / `foldStepIntoRunningTurn` | `chat-ws-running-turn.ts` |
| 1487–1700 | mcp/tunnel 快照、`appendMessages`、文件浏览收尾 | broadcast 快照 + persist + turn 旁路 |
| 1707–1803 | `enqueueAndMaybeKickoff` / `runSessionMessageLoop` | `chat-ws-loop.ts` |
| 1807–2332 | upgrade + connected + **入站 type 大 switch** | 主文件留 upgrade/connected；switch → inbound |
| 2343–2958 | `handleChatMessage` | `chat-ws-turn.ts` |
| 2961–2995 | `sendJSON` / `cleanupChatResources` | broadcast / 主文件编排 |

入站 `msg.type`（整份方案必须保持一一对应、不可丢）：

`ping` · `clear_session` · `confirm_reply` · `stop` · `bg_task_stop` · `restore_runtime` · `delete_user_message` · `switch_session` · `message`（内含 `/also` `/shell` `/next` `~open`）

对外 API（必须仍从 `chat-ws.ts` 导出，调用方零改动）：

| 符号 | 当前调用方 |
|------|------------|
| `attachChatWebSocket` | `cli/commands/serve.ts` |
| `cleanupChatResources` | `serve.ts` |
| `broadcastMcpReady` | `serve.ts`、`cli/bootstrap.ts` |
| `broadcastTunnelReady` | `serve.ts` |
| `getActiveSessionId` | `serve.ts` → `registerBootstrapSessionHints` |
| `getProcessingSessionIds` | 同上 |
| `purgeSessionRuntimeCaches` | `serve.ts` → `registerSessionCleanupHook` |
| `notifyTaskQueueUpdated` | `routes/sessions.ts` 动态 import |
| `getSessionsDir` / `isSessionTombstoned` / `ChatWSOptions` | 仅内部或预留；继续 re-export |

---

## 4. 架构：runtime 模块，不用 ctx

前端拆分必须 ctx，因为是 IIFE + `window`，共享函数只能留在 `chat-page.js` 闭包。服务端是 ESM，**共享状态做成叶子模块**，域模块直接 import，避免 40 个函数指针的 `ChatTurnContext`。

```
chat-ws-helpers.ts          纯函数，零状态
chat-ws-runtime.ts          全部 Map/Set/activeSessionId（叶子，禁止 import 其它 chat-ws-*）
        ↑
chat-ws-broadcast.ts        订阅 / 广播 / sendJSON / mcp·tunnel 快照
chat-ws-confirm.ts
chat-ws-running-turn.ts
        ↑
chat-ws-persist.ts          structured 读写、appendMessages、memory init
chat-ws-bg-tasks.ts
        ↑
chat-ws-shell.ts
chat-ws-turn.ts             handleChatMessage
chat-ws-loop.ts             队列 kickoff + 串行 run
        ↑
chat-ws-inbound.ts          ws.on('message') 分发
        ↑
chat-ws.ts                  upgrade / connected / 对外 API / purge 与 cleanup 编排
```

**硬规则：禁止环。** `chat-ws-runtime.ts` 不得 import 任何 `chat-ws-*.ts`。需要副作用（杀 shell、unwire pusher）的 purge / cleanup **留在 `chat-ws.ts` 编排**，各域只暴露自己的 `purgeXxx(sessionId)`。

```ts
// chat-ws.ts — 编排示例（行为与今天 purgeSessionRuntimeCaches 相同）
export function purgeSessionRuntimeCaches(sessionId: string): void {
  runtime.tombstoneSession(sessionId);
  runtime.purgeSessionMaps(sessionId);
  confirm.purgeSessionConfirms(sessionId);
  runningTurn.clear(sessionId);
  bgTasks.unwire(sessionId);
  persist.dropCache(sessionId);
  // 现有：stopAllShellWorkForSession / abort / disposeBackgroundTaskManager / …
}
```

`handleChatMessage` 迁出时把 10 个位置参数收成一个对象（内部重构，调用点只在 loop）：

```ts
export async function handleChatMessage(input: {
  ws: WebSocket;
  message: string;
  runSessionId: string;
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  mcpManager?: MCPManager;
  images?: string[];
  referencePaths?: string[];
  clientMessageId?: string | null;
  skipUserMessageAppend?: boolean;
  source?: 'implicit' | 'explicit';
}): Promise<StopReason | undefined>
```

---

## 5. 五刀（一刀一 commit）

顺序固定：后刀依赖前刀抽出的模块。每刀合入后主文件仍能独立编译、现有测试全绿。

### 块 1 — 插座：helpers + runtime + broadcast

**新文件**

- `src/web/chat-ws-helpers.ts`：`parseClientMessageId`、`normalizeReferencePath`、`stripReferencePathLinesForWorkspaceLock`、`isSessionImageApiUrl`
- `src/web/chat-ws-runtime.ts`：`SESSIONS_DIR` / `MEMORY_DIR` / `DATA_DIR` / `MAIN_CONFIG_PATH` / `DEFAULT_WORK_DIR`、`activeSessionId`、`structuredCache`、`fileBrowserStateBySession`、`sessionDeferredToolCalls`、`sessionAbortControllers`、`sessionProcessing`、`sessionActiveBatchCounts`、`tombstonedSessionIds`、`saveTimerMap`、`get/setCachedMessages`、`getFileBrowserState`、`abortSession` / `hasBusySessionRun`、`getSupervisorRuntime`
- `src/web/chat-ws-broadcast.ts`：`chatClients`、`sessionSubscribers`、`wsToSubscribedSession`、`subscribeWsToSession`、`broadcastToSession*`、`sendJSON`、`sendToAllChatClients`、`broadcastSessionUpdated`、`broadcastMcpReady`、`broadcastTunnelReady`、mcp/tunnel 快照

**主文件** 改为 import 上述模块；`purge` / `cleanup` 仍在主文件，改成调用 runtime/broadcast 的 API。

**验收：** `serve.ts` / `bootstrap.ts` 无需改 import；`broadcastMcpReady` 仍从 `chat-ws.js` 出去。

### 块 2 — 快照与确认：running-turn + confirm

**新文件**

- `src/web/chat-ws-running-turn.ts`：`RunningTurnSnapshot`、`ensureRunningTurn` / `foldStepIntoRunningTurn` / `snapshotRunningTurn` / `clearRunningTurn` / `getProcessingSessionIds`
- `src/web/chat-ws-confirm.ts`：`pendingConfirms`、`nextConfirmId`、`resolveConfirm`、`createShellMandatoryConfirmHandler`、以及 `handleChatMessage` 里那份普通 `onConfirm` 工厂（两处 confirm 逻辑必须进同一个文件，禁止再写一份 first-win）

**依赖：** broadcast、runtime（tombstone、sessionId）。

**验收：** confirm 60s 超时、多端 first-win、`confirmKind: 'shell_mandatory'` 行为不变。

### 块 3 — 会话副作用：persist + bg-tasks + shell

**新文件**

- `src/web/chat-ws-persist.ts`：`load/save/flushStructuredMessages`、`appendMessages`、`ensureMemoryInitialized`、`ensureGlobalActiveSessionId` 的刷盘部分、`globalFileMemoryManager`
- `src/web/chat-ws-bg-tasks.ts`：`ensureBgTaskPusher`、`rebindBgTaskPusher`、`handleBgTaskStop`、disk sync wire/unwire、`buildBgTasksForSession`
- `src/web/chat-ws-shell.ts`：`handleShellCollabRoute`、`buildShellCollabWsExtras`、`queueShellCollabTransition` / `waitForShellCollabTransition`

**依赖：** persist → runtime + broadcast；bg-tasks → broadcast + runtime；shell → persist + broadcast + confirm 不依赖 turn。

**验收：** 现有 `test/web/chat-ws-bg-push.test.ts`、`test/web/chat-ws-prewarm.test.ts` 全绿；`/shell` 幂等 enter、busy 拒绝、不能 exit 的文案不变。

### 块 4 — 入站路由器 + 队列循环

**新文件**

- `src/web/chat-ws-loop.ts`：`enqueueAndMaybeKickoff`、`runSessionMessageLoop`、`queuedTaskToPending`、`publishTaskQueueState` / `notifyTaskQueueUpdated`、`buildEnqueueInput`、`persistImplicitQueuedUserMessage`
- `src/web/chat-ws-inbound.ts`：`createInboundMessageHandler(deps)`，内含全部 `msg.type` 分支（含 `message` 里的 `/also` `/shell` `/next` `~open`）

`attachChatWebSocket` 收缩为：

1. `upgrade`（路径 / setup gate / token）
2. `connection`（bootstrap、扫码对齐、订阅、拼 `connected` 包）
3. `ws.on('message', inboundHandler)`

**静态测试从此刀开始锁：** 主文件不得再出现 `msg.type === 'restore_runtime'` 等已迁出 type（见 §6）。

**验收：** 9 个入站 type 只在 inbound 出现一次；loop 仍按 session 串行、`sessionProcessing` 防双 harness。

### 块 5 — 一轮对话

**新文件**

- `src/web/chat-ws-turn.ts`：`handleChatMessage` 整函数（含文件浏览旁路 `finalizeDirectBrowserTurn`、图片 persist、skill 解析、lazy offering、`new Harness`、step 广播、toolTrace 落盘、tokenUsage、checkpoint finalize）

**依赖：** 上面所有域模块。这是唯一允许 `import { Harness }` 的 chat-ws 文件。

**静态测试：** `chat-ws.ts` 与 inbound/loop **不得**出现 `new Harness(`。

**验收：** 主文件 ≤ 600；turn 单文件、职责就是「跑一轮」。

---

## 6. 测试（每刀必跑，块 4 起加静态锁）

新建 `test/web/chat-ws-split.test.ts`（对标 `test/public/chat-ws-handlers-split.test.ts`）：

| 断言 | 从哪一刀生效 |
|------|----------------|
| `src/web/chat-ws.ts` 仍 export §3 对外 API | 块 1 |
| `chat-ws-runtime.ts` 的 import 列表不含 `./chat-ws-` | 块 1 |
| 主文件不再含 `msg.type === '<已迁出>'`（9 个 type） | 块 4 |
| `new Harness(` 只出现在 `chat-ws-turn.ts` | 块 5 |
| 主文件行数 ≤ 600 | 块 5 |

每刀回归（必须）：

```
vitest run test/web/chat-ws-split.test.ts test/web/chat-ws-bg-push.test.ts test/web/chat-ws-prewarm.test.ts
```

块 4 / 块 5 额外加一层现有 web 测（sessions / workspace / 与 WS 协议相关的 integration，以仓库当时 `test/web/` 为准），避免只绿静态断言。

---

## 7. 每刀操作清单（落地时按此改）

1. 新建目标文件，**剪切**（不要复制）对应函数与状态。
2. 主文件改为 import；对外符号在 `chat-ws.ts` re-export。
3. 迁出文件顶部写一句职责注释；禁止顺手改逻辑。
4. 跑 §6 回归；更新 `chat-ws-split.test.ts` 的「已迁出」名单。
5. 单独 commit，message 形如：`refactor(web): extract chat-ws broadcast and runtime`。

---

## 8. 验收对照

- [x] 五刀全部合入后 `chat-ws.ts` ≤ 600 行（**237**），且不含入站 type 分支、不含 `new Harness`
- [x] 对外 API 与 import 路径不变（`serve.ts` / `bootstrap.ts` / `sessions.ts` 零 diff）
- [x] runtime 无环（`test/web/chat-ws-split.test.ts`）
- [x] 静态锁：9 个入站 type 只在 inbound；`new Harness(` 只在 turn
- [x] 无双实现：`appendMessages`、`broadcastToSession`、`resolveConfirm` 全仓库各一处
- [x] 本方案文档与代码目录一致

落地偏差（有意为之，避免成环）：`hasBusySessionRun` 放在 `chat-ws-running-turn.ts` 而非 runtime（它依赖 `runningTurns`）。`buildEnqueueInput` 放在 persist，避免 shell ↔ loop 互引。

审计补丁（2026-08-19）：`purgeSessionMaps` 不得 abort；`purgeSessionRuntimeCaches` 必须先 `stopAllShellWorkForSession` 再 `dropSessionRunLocks`，与拆前 P1-11 一致。`saveStructuredMessages` 写 `structuredCache.set`（不走 `setCachedMessages`），与拆前一致。

### 完成后文件行数（2026-08-19）

| 文件 | 行数 |
|------|------|
| `chat-ws.ts` | 237 |
| `chat-ws-helpers.ts` | 40 |
| `chat-ws-runtime.ts` | 174 |
| `chat-ws-broadcast.ts` | 196 |
| `chat-ws-confirm.ts` | 145 |
| `chat-ws-running-turn.ts` | 251 |
| `chat-ws-persist.ts` | 330 |
| `chat-ws-bg-tasks.ts` | 150 |
| `chat-ws-shell.ts` | 216 |
| `chat-ws-loop.ts` | 188 |
| `chat-ws-inbound.ts` | 458 |
| `chat-ws-turn.ts` | 712 |

`chat-ws-turn.ts` 略超软指标 650：含 `finalizeDirectBrowserTurn`，仍是单一职责。inbound 458 因 9 个 type 全集中，可接受。

回归：`vitest run test/web/chat-ws-split.test.ts test/web/chat-ws-bg-push.test.ts test/web/chat-ws-prewarm.test.ts` + `tsc --noEmit` 全绿。

---

## 9. 明确不要做

| 不要 | 原因 |
|------|------|
| 一块 PR 拆完五刀 | 无法 bisect；前端拆分已证明分 commit 才能收口 |
| 给每个域做一个 class | 仍是上帝对象，只是换了文件名 |
| 复制 `appendMessages` / confirm 到 turn | 刷盘与 first-win 会分叉 |
| 先抽 `handleChatMessage` | 它依赖几乎全部状态；必须先有 runtime/broadcast |
| 把 purge 放进 runtime | runtime 会反向依赖 bg-tasks / shell，立刻成环 |
| 改 `handleChatMessage` 业务（记忆开关、模块快照等） | 超出本方案；拆完后再改 turn 文件 |

---

## 10. 建议决策

1. **按 §5 五刀拆，不按「连接 / harness / 广播 / 恢复 / 工具」五层拆。** 后者在源码里是交错的，硬切会复制状态。
2. **共享状态用 `chat-ws-runtime.ts`，不用 ctx。**
3. **`chat-ws.ts` 永远是公共入口。** 内部文件可以不 export 到包外。
4. **先插座后业务：** 块 1 → 2 → 3 → 4 → 5。停在块 3 也有收益（主文件仍大，但广播/确认/持久化已可独立改）。
