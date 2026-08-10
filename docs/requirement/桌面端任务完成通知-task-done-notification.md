# 桌面端任务完成通知（Task Done Notification）设计

> 设计规格 · **已实现**  
> 目标：iceCoder 桌面端（Electron）在 Agent 任务完成后，通过系统级通知（右下角）提醒用户，避免任务在后台跑完却无人察觉。

---

## 1. 背景与目标

### 1.1 现状

- iceCoder 任务在 Web 前端执行，Harness 循环完成后 `handleChatMessage` 返回 `StopReason`（`src/web/chat-ws.ts:2739`），并广播 `step` 事件。
- 桌面端是 Electron 壳：主进程 `desktop/src/main.ts` 起本地 Express 服务（`server-process.ts`），渲染层加载 Web 页面；已有悬浮宠物（Pet）窗口与 IPC 通道体系。
- 任务完成时用户如果切到其他窗口/应用，Web 页内 Toast（`src/public/js/notification.js`）不可见——需要**系统级**通知（Windows 右下角气泡）。

### 1.2 目标

| 项 | 说明 |
|----|------|
| 触发时机 | 任务（Harness run）结束，且是「正常完成」（`stopReason === 'model_done'`） |
| 不触发 | 用户手动中止（`user_abort`）、运行失败（`error`/`length`）、纯闲聊无工具调用 |
| 通知内容 | 标题 + 摘要（成功/失败 + 任务消息摘要） |
| 形态 | Electron `new Notification()`（Windows 右下角系统气泡，macOS 通知中心） |
| 仅桌面端 | Web 浏览器访问不触发（无桌面桥） |
| **开关** | 设置页「执行透明层」下的「任务完成消息通知」开关，持久化于 `data/config.json` 的 `iceEtlPrefs.taskDoneNotification`（默认关闭） |

---

## 2. 架构

### 2.1 数据流

```text
Web 前端（renderer）
  └─ chat-pet-bridge.js 收到 step（final + stopReason=model_done）→ applyModelDoneNotice()
       │
       │  maybeNotifyTaskDone()：读取 EtlPrefs.taskDoneNotification，开启且存在桌面桥时
       │  window.iceDesktop.notifyTaskDone({ success, summary })   ← preload 桥（仅桌面存在）
       ▼
preload.ts（contextBridge）
  └─ ipcRenderer.send(IPC.TASK_DONE_NOTIFY, payload)
       │
       ▼
main.ts（Electron 主进程）
  └─ new Notification({ title, body }).show()  → 文案：用户任务【摘要】已完成。请确认。
```

### 2.2 关键设计决策

| 决策 | 理由 |
|------|------|
| **通知由前端渲染层发起，经 preload 桥转发主进程** | 主进程不知道任务状态；前端已有 stopReason / step 事件流 |
| **Web 浏览器访问不触发** | `window.iceDesktop` 仅桌面 preload 暴露；不存在即跳过 |
| **IPC 用 `send`（单向）** | 通知即发即走，无需回执 |
| **主进程统一收口创建 Notification** | Electron 通知 API 只能在主进程可靠使用；且 Windows 需 app 图标支持 |

---

## 3. 触发信号（前端）

### 3.1 任务结束事件

`src/web/chat-ws.ts` 在 `handleChatMessage` 结束后返回 `stopReason`（`chat-ws.ts:2938`），同时已有事件流：

- `broadcastToSession` 广播 `step` 事件（`chat-ws.ts:2708`）
- `run_done` / `task_graph_done` 事件（`chat-ws.ts:1462` 附近）

### 3.2 判定规则

| stopReason | 通知 | 说明 |
|------------|------|------|
| `model_done` | ✅ 成功通知 | 正常完成任务 |
| `error` / `length` | ❌ 暂不通知（预留失败分支，未接入） | 任务失败提醒为后续增强 |
| `user_abort` | ❌ 不通知 | 用户主动中止，无需提醒 |
| 其他 | ❌ | 兜底不通知 |

**附加判定（防打扰，已实现）：**
1. 本轮无任何工具调用（纯闲聊）不通知——「任务」指真正跑了工具的轮次（前端 `applyHarnessStepToPet` 收到 `tool_call` 时置位，新一轮 `showThinking` 复位）。
2. 主窗口处于前台时不通知（R10）——仅后台弹通知，用户在看着时不打扰；前端 `maybeNotifyTaskDone()` 内 `document.hasFocus()` 为真则跳过，主进程 `main.ts` 再以 `mainWindow.isFocused()` 兜底（为真则直接 return）。

---

## 4. 实现点

### 4.1 桌面端

| 文件 | 改动 |
|------|------|
| `desktop/src/constants.ts` | `IPC` 增加 `TASK_DONE_NOTIFY: 'task:done-notify'` |
| `desktop/src/preload.ts` | 增加 `notifyTaskDone(payload)` → `ipcRenderer.send(IPC.TASK_DONE_NOTIFY, payload)` |
| `desktop/src/task-done-notify.ts` | 新增纯函数 `resolveTaskDoneNotification(payload, mainWindow, appName)`：载荷校验、R10 前台判断、标题/正文拼装（成功 `用户任务【摘要】已完成。请确认。`、失败 `任务失败`）；无 Electron 依赖，可单测 |
| `desktop/src/main.ts` | `ipcMain.on(IPC.TASK_DONE_NOTIFY, ...)` 调用 `resolveTaskDoneNotification` 得决策，`skip` 则直接 return；否则 `new Notification(...).show()`；R9 通知 `click` 事件 → `showAndFocusMain()` 恢复并聚焦主窗 |

**主进程处理（已实现）：**

```typescript
// desktop/src/task-done-notify.ts（纯函数，无 Electron 依赖，可单测）
function resolveTaskDoneNotification(
  payload: unknown,
  mainWindow: { isDestroyed(): boolean; isFocused(): boolean } | null,
  appName: string,
): { skip: boolean; title: string; body: string; summary: string } {
  if (!payload || typeof payload !== 'object') return { skip: true, title: '', body: '', summary: '' };
  const success = (payload as { success?: unknown }).success === true;
  const rawSummary = typeof (payload as { summary?: unknown }).summary === 'string'
    ? (payload as { summary: string }).summary
    : '';
  const summary = rawSummary.length > 30 ? `${rawSummary.slice(0, 30)}…` : rawSummary; // P4 防御性兜底
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {   // R10 仅后台弹
    return { skip: true, title: '', body: '', summary };
  }
  const title = success ? `${appName} 任务完成` : `${appName} 任务失败`;
  const body = success
    ? (summary ? `用户任务【${summary}】已完成。请确认。` : '用户任务已完成。请确认。')
    : (summary || '任务执行出错');
  return { skip: false, title, body, summary };
}

// desktop/src/main.ts：skip 则 return；否则 new Notification(decision).show()，
// notification.on('click', () => showAndFocusMain()) // R9 点击聚焦主窗
```

> 注意：`Notification` 需从 `electron` 导入；Windows 下使用 app 图标（`resolveAppIcon()`）作通知图标（已实现）。

### 4.2 Web 前端

| 文件 | 改动 |
|------|------|
| `src/public/js/chat-pet-bridge.js` | `applyModelDoneNotice()` 内调用 `maybeNotifyTaskDone()`；新增 `setLastUserPrompt()` / `summarizeUserPrompt()`（用户提示词取前 30 字 + `…`） |
| `src/public/js/chat-page.js` | 发送消息时调用 `Pet.setLastUserPrompt(outboundText)` 记录用户提示词 |
| `src/public/js/config-page.js` | 设置页「执行透明层」卡片下新增「任务完成消息通知」开关（change 事件 → `EtlPrefs.set({ taskDoneNotification })`）；仅桌面桥存在时可用 |
| `src/public/js/etl-prefs.js` | `DEFAULTS` / `sanitize` 增加 `taskDoneNotification: false` |
| `src/public/css/config.css` | 新增 `settings-card-row--indent` 缩进行样式 |

**判定示例（已实现）：**

```javascript
function maybeNotifyTaskDone() {
  var prefs = window.EtlPrefs && typeof window.EtlPrefs.get === 'function'
    ? window.EtlPrefs.get()
    : null;
  if (!prefs || prefs.taskDoneNotification !== true) return;                          // ① 开关关闭不通知
  if (!turnHadToolCall) return;                                                       // ② R7 纯闲聊（无 tool_call）不通知
  if (!window.iceDesktop || typeof window.iceDesktop.notifyTaskDone !== 'function') return; // ③ 非桌面不通知
  if (document.hasFocus()) return;                                                    // ④ R10 主窗在前台不通知（主进程再兜底）
  window.iceDesktop.notifyTaskDone({ success: true, summary: summarizeUserPrompt() });
}
```

> 注：判定链 ①→②→③→④ 均有单测覆盖（`test/public/chat-pet-bridge-notify.test.ts`）。

### 4.3 配置层（config.json）

| 文件 | 改动 |
|------|------|
| `src/web/types.ts` | `IceEtlPrefs` 增加 `taskDoneNotification: boolean` |
| `src/config/main-config-ice-etl-prefs.ts` | `DEFAULT_ICE_ETL_PREFS` / `sanitizeIceEtlPrefs` 增加该字段（默认 `false`） |
| `src/web/routes/config.ts` | PATCH `/api/config/ice-etl-prefs` 的 `allowedKeys` 与类型校验增加该字段 |

---

## 5. 边界与兼容

| 场景 | 行为 |
|------|------|
| 浏览器访问（非桌面） | `window.iceDesktop` 不存在 → 静默跳过 |
| 任务失败 / 超时 | 不通知（失败分支预留，未接入） |
| 用户手动中止 | 不通知 |
| 纯闲聊（无工具调用） | 不通知（前端 `turnHadToolCall` 过滤，已实现；含工具调用但结果全失败也算「跑了任务」，会通知） |
| 主窗口处于前台（focused） | 不通知（R10：前端 `document.hasFocus()` + 主进程 `isFocused()` 双保险） |
| 主窗口最小化 / 隐藏 | 仍通知（`isFocused()` 为 false 即视为后台；P3 结论：不需显式判断最小化/隐藏） |
| 摘要超长 | 双重截断：前端 `summarizeUserPrompt()` 30 字 + `…`，主进程 `resolveTaskDoneNotification` 再防御性兜底（幂等，P4） |
| 通知被系统关闭（Windows 专注助手 / macOS 免打扰） | Electron Notification 自动降级，无副作用 |
| 任务队列多轮 | 每次 `model_done` 都通知（可后续加节流） |

---

## 6. 测试要点

### 6.1 自动化（vitest，已落地）

| 用例 | 覆盖 | 文件 |
|------|------|------|
| maybeNotifyTaskDone 行为（开关关/无工具/前台/无桌面桥/正常发送/摘要截断） | P2 | `test/public/chat-pet-bridge-notify.test.ts`（6 例） |
| 主进程通知决策纯函数（非法载荷/成功/失败/超长/前台 skip/最小化仍通知） | P2 | `test/desktop/task-done-notify.test.ts`（8 例） |
| 桌面 server-bundle smoke（启动 + 健康检查） | P2 | `test/desktop/smoke-server-bundle.test.ts`（产物存在时跑） |

### 6.2 手动（桌面端人工验证）

1. 桌面端运行一个耗时任务（如「写个脚本」），切到其他窗口 → 任务完成右下角弹出通知
2. 纯聊天「你好」→ 无通知
3. 手动停止任务 → 无通知
4. 浏览器访问同一服务 → 无通知（开关应 disabled）
5. 通知文案含中文且摘要超长时正确截断
6. **R9**：点击通知气泡 → 主窗口恢复并聚焦、冰豆进入 embedded 模式
7. **R10**：主窗保持前台时任务完成 → 不弹通知

---

## 7. 不在本规格范围（当前）

- 失败通知（`error`/`length`）
- 任务队列逐条通知的节流/合并

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-08-10 | 初稿：桌面端任务完成通知设计 |
| 2026-08-10 | 落地：IPC 通道 / preload 桥 / 主进程 Notification；设置页开关（iceEtlPrefs.taskDoneNotification，默认关）；chat-pet-bridge 触发；通知文案「用户任务【摘要】已完成。请确认。」（摘要 30 字截断）；Web 端无桌面桥静默跳过 |
| 2026-08-10 | 评审修订：R7 纯闲聊（本轮无 tool_call）不通知；R8 通知使用 app 图标；R10 主窗前台不弹（仅后台通知） |
| 2026-08-10 | R9 通知点击恢复并聚焦主窗（`showAndFocusMain`）；R10 主进程 `isFocused()` 前台不弹；失败分支通知补全（title/body 统一处理） |
| 2026-08-10 | P1-P6 收口：通知决策抽为纯函数 `desktop/src/task-done-notify.ts`；补自动化测试（maybeNotifyTaskDone 6 例 / 主进程决策 8 例 / server-bundle smoke 1 例）；文档同步 §4 示例、§5 边界（最小化仍通知、摘要双重截断）、§6 测试要点（含 R9/R10 手动项） |
