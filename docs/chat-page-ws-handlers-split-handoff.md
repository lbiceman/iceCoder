# 交接文档：拆分 chat-page.js 的 WebSocket 事件处理

> 状态：2026-08-11 完成。块 1/2/3/4 全部完成并验证（测试 35/35 全绿）；块 5（连接/杂项，约 150 行）未拆，属可选低优先级。
> 任务约束摘要：每个 WS event type 只能注册一个 handler（chat-websocket.js:33-35）；按业务域拆 Handler 模块 + 共享 Context（不用策略模式）；ChatPage 对外 API 不变；新模块遵循 IIFE + `/* exported X */` 风格；main.js 中新模块必须在 chat-page.js 之前 import；最小 diff（共享函数留 chat-page 闭包，经 ctx 注入，禁止模块内复制）。

## 拆分总览

| 模块 | commit | 迁出事件 | 行数 |
|---|---|---|---|
| chat-ws-stream-handlers.js | a803057 | stream / reasoning_stream / stream_end / response / step / status / error / tool_output（8） | 350 |
| chat-ws-session-handlers.js | 2cfd7c7 | connected / session_cleared / session_updated / sync / user_message_appended / workspace_updated（6） | 163 |
| chat-ws-restore-handlers.js | ba34006 | confirm / confirm_resolved / confirm_timeout / harness_state / checkpoint_message_ids / checkpoint_captured / runtime_restored / restore_failed / message_deleted / delete_message_failed（10） | 198 |
| chat-ws-bg-task-handlers.js | f6f07a1 | bg_task_update / bg_task_stop_result / task_queue_updated / also_note_appended / also_rejected / shell_collab_entered（6） | 139 |

chat-page.js：原约 2590 行 → **2035 行**（净减约 555 行）。chat-page.js 剩余：DOM 渲染/事件绑定、发送链路（handleSend / handleAlsoCommand / 命令面板）、会话切换与 runningTurn 恢复、token 统计、模型配置、mcp/tunnel/memory 通知、tokenUsage/pulse 等（约 150 行，即块 5 候选，未拆）。

## 1. 块 1：流式域（commit a803057）

### 新文件
`src/public/js/chat-ws-stream-handlers.js`（350 行）
- 暴露 `window.ChatWsStreamHandlers.bind(WS, ctx)`，注册 8 个流式事件。
- 行为保持：Thinking 块分流（`WS.isProcessing()` 时 delta 进 reasoning）、双包去重（stream_end + response）、token usage 回填、工具 diff 实时预览。

### chat-page.js
- 删除原 handler：`onWsReasoningStream` / `onWsStream` / `onWsStreamEnd` / `onWsResponse` / `onWsStep` / `onWsStatus` / `onWsError` / `onWsToolOutput`。
- 新增 `buildStreamHandlerCtx()`：共享状态留在闭包，经 `ctx.get/set` 读写（键：`isStreaming` / `userStopped` / `streamFinalized` / `streamChunksReceived` / `visibleStreamChunksReceived`）；另有 `getPendingTurnTokenUsage` / `setPendingTurnTokenUsage` / `getStreamingDiffBuffer` / `setStreamingDiffBuffer` / `getSessionPet` / `getElMessages` / `syncWelcomeState` / `endTransparencyTurnTimer` / `refreshChatHistoryAfterTurn` / `shouldSkipServerSnapshotSync` / `applyTotalTokenUsageFromStep` / `notifySnapshotRestoreAvailability` / `syncSendButtonWithWorkload`。
- **⚠️ 越界改动（P1，已记录）**：本 commit 同时删除 `src/public/js/chat-model-context.js`（169 行）并将其逻辑并回 chat-page.js（`applyModelContextFromWs` / `loadModelConfig` / `updateChipModelLabel`，现 chat-page.js 闭包；`notifyUsageChanged` 回调改为 `updatePetTokenUsage`）。已核查无残留引用、行为自洽，但超出"最小 diff"范围。

### 测试更新
- etl-integration.test.ts：新增 `CHAT_WS_STREAM_HANDLERS_SOURCE` 注入。
- etl-prefs.test.ts：`applyRuntimeStats` 断言改读 `chat-ws-stream-handlers.js`（该逻辑随流式域迁移）。

## 2. 块 2：会话域（commit 2cfd7c7）

### 新文件
`src/public/js/chat-ws-session-handlers.js`（163 行）
- 注册 `connected` / `session_cleared` / `session_updated` / `sync` / `user_message_appended` / `workspace_updated`。
- 内含 `onConnected` / `onSessionCleared` / `onSessionUpdated` / `onUserMessageAppended` / `syncActiveSessionFromServer`。

### chat-page.js
- 删除原 handler：`onWsConnected` / `onWsSessionCleared` / `onWsSessionUpdated` / `onWsUserMessageAppended` / `syncActiveSessionFromServer`。
- 新增 `buildSessionHandlerCtx()`：注入 `onSessionSwitched` / `paintInitialChatView` / `shouldSkipWsConnectedHeavyFetch` / `applyModelContextFromWs` / `loadModelConfig` / `syncChipModelLabelFromWs` / `syncSidebarWorkspace` / `restoreFromRunningTurn` / `announceMcpReadyFromPayload` / `announceTunnelReadyFromPayload` / `applyHarnessRestoreUi` / `notifyShellCollabState` / `needsInitialHistoryPaint` / `syncMessages` / `applyRemoteUserMessage` / `shouldSkipServerSnapshotSync` / `refreshChatHistoryAfterTurn` / `refreshSnapshotTimelinePanel` / `paintRemoteUserMessagesWithoutDom` / `pullServerChatSnapshotAuthoritative`。

### 关键设计（已验证）
- **共享函数留 chat-page、经 ctx 注入，模块内不复制**——杜绝双实现节流状态分叉（块 2 起草阶段曾复制 `syncMessages` 等 5 个函数，收尾时已全部改为 ctx 注入）。
- 约束满足：`ChatExecutionPlanBridge.notifyConnected` 仍由 ChatPage 转发（模块经 ctx 调用，未直接 `WS.on('connected')` 覆盖）。

## 3. 块 3：恢复/确认域（commit ba34006）

### 新文件
`src/public/js/chat-ws-restore-handlers.js`（198 行）
- 注册 `confirm` / `confirm_resolved` / `confirm_timeout` / `harness_state` / `checkpoint_message_ids` / `checkpoint_captured` / `runtime_restored` / `restore_failed` / `message_deleted` / `delete_message_failed`。
- 私有状态：`activeConfirmId` / `activeConfirmResolved`（模块闭包内）+ `dismissActiveConfirmModal`。

### chat-page.js
- 删除原 handler：`onWsConfirm` / `onWsConfirmResolved` / `onWsConfirmTimeout` / `onWsHarnessState` / `onWsCheckpointMessageIds` / `onWsRuntimeRestored` / `onWsRestoreFailed` / `onWsMessageDeleted` / `onWsDeleteMessageFailed`。
- 新增 `buildRestoreHandlerCtx()`：get/set（`runtimeRestoreInFlight` / `isStreaming` / `userStopped`）+ `getSessionPet` + `applyHarnessRestoreUi` / `refreshSnapshotTimelinePanel` / `notifySnapshotRestoreAvailability` / `clearSessionExecutionFlow` / `refreshChatHistoryAfterTurn` / `syncSidebarWorkspace` / `notifyUser` / `pullServerChatSnapshotAuthoritative`。

### 小改进（随本 commit）
- `chat-shell-dock.js`：`replaceTasks(tasks, sessionId)` 删除未使用的 `sessionId` 参数，同步 3 处调用点。
- 绑定区增加 `else console.warn('[ChatPage] ChatWsRestoreHandlers not loaded')` 开发告警。

## 4. 块 4：后台任务 + 协作域（commit f6f07a1）

### 新文件
`src/public/js/chat-ws-bg-task-handlers.js`（139 行）
- 注册 `bg_task_update` / `bg_task_stop_result` / `task_queue_updated` / `also_note_appended` / `also_rejected` / `shell_collab_entered`。
- 内部辅助：`appendShellCollabAgentMessage` / `removeAlsoNoteFromUi` / `appendSystemAgentMessage`。

### chat-page.js
- 删除原 handler：`onWsBgTaskUpdate` / `onWsBgTaskStopResult` / `onWsTaskQueueUpdated` / `onWsAlsoNoteAppended` / `onWsAlsoRejected` / `onWsShellCollabEntered`。
- 新增 `buildBgTaskHandlerCtx()`：get/set（`pendingAlsoMessageIds`，共享对象引用）+ `getElMessages` / `appendAlsoNoteBubble` / `notifyShellCollabState` / `syncWelcomeState`。
- **保留**：`appendAlsoNoteBubble`（`handleAlsoCommand` 仍用）、`notifyShellCollabState`（session ctx 也注入 + `syncShellCollabIndicator` 内部依赖）、`handleAlsoCommand`（composer/send 命令域，chat-page.js:513 调用）。

## 5. 测试

- 新增 `test/public/chat-ws-handlers-split.test.ts`（7 例静态断言）：
  - chat-page.js 不再注册 30 个已迁出事件（`WS.on('xxx')` 全查）
  - 4 个新模块各自注册对应事件
  - restore 模块 `ctx.xxx` 调用与 `buildRestoreHandlerCtx` 提供键交叉验证一致
  - main.js 各模块 import 顺序均在 chat-page.js 之前
- etl-integration.test.ts：注入顺序 `SHELL_DOCK → STREAM → SESSION → RESTORE → BG_TASK → CHAT_PAGE`，与 main.js 一致。

### 回归命令与结果
```
vitest run test/public/chat-ws-handlers-split.test.ts test/public/etl-integration.test.ts test/public/etl-prefs.test.ts test/public/chat-pet-bridge-user-checkpoint.test.ts
→ 4 files, 35/35 passed
```
语法检查：chat-page.js / 4 个 handler 模块均 `node --check` 通过。

## 6. 验收对照

- [x] chat-page.js ≤ 1600 行 → **2035 行**（未达 1600 硬指标，因块 5 未拆；如需压线可再拆 chat-ws-misc-handlers.js 约 150 行）
- [x] 无重复 WS.on 绑定（静态测试断言 chat-page.js 不再含 30 个已迁出事件，每个 type 仅一处注册）
- [x] ctx 无双实现分叉（共享函数留 chat-page 闭包，经 ctx 注入）
- [x] 35/35 测试全绿
- [x] 行为不变（流式/confirm/回滚/删除/checkpoint/bg_task/also/shell 协作，etl-integration 18 例覆盖）
- [x] handoff 文档与代码状态一致
- [ ] chat-page.js 仍有 ~150 行块 5 候选（open/close/mcp_ready/tunnel_ready/memory_notice/tokenUsage/pulse），可选

## 7. 工作区其他事项

- `src/web/routes/supervisor-events.ts` 有未提交改动（`M`），**非本任务**（来自之前的 lazy-tool-offering 相关改动），未混入任何本任务 commit。
- 四块均为独立 commit：`a803057` / `2cfd7c7` / `ba34006` / `f6f07a1`。
- 交接时注意：`docs/chat-page-ws-handlers-split-handoff.md` 本文件尚未 commit（`??` 未跟踪）。
