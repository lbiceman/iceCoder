# Shell 后台持久生命周期与 ETL 命令列表 — 需求文档

> **状态**：已实现（P0–P2）；**Phase 3 不做**  
> **版本**：v1.0  
> **日期**：2026-07-21  
> **范围**：`run_command` 后台任务生命周期策略 · `session-shell-control` 拆分 · 执行透明层（ETL）底部 Shell Dock · WebSocket 快照 · **不新增工具**

---

## 1. 目标

在现有 `run_command` + `BackgroundTaskManager` 基础上，让**后台 shell 命令**满足以下产品行为，并在执行透明层（ETL）右侧栏底部展示当前会话的运行中命令列表。

### 1.1 用户故事（五条硬需求）

| # | 需求 | 说明 |
|---|------|------|
| R1 | **会话终止了，命令还在跑** | Agent 回合结束、用户 Stop（停 Agent）、turn abort 后，已启动的后台命令**不被杀** |
| R2 | **切换会话，命令还在跑** | 用户切换到其它 session 时，离开 session 的后台命令**继续在原 session 下运行** |
| R3 | **iceCoder 关闭，命令停止** | 应用进程退出（CLI `chat` 结束、`serve` shutdown、Electron 退出）时，**全部**前台 + 后台 shell 子进程终止 |
| R4 | **主动停止，命令也停止** | 用户在 UI 或 Agent 调用 `action:"stop"` / `bg_task_stop` 时，**仅**终止指定任务 |
| R5 | **ETL 底部展示当前会话命令列表** | 命令启动后，在右侧执行透明层**底部**展示列表；每个 item 对应当前活跃 session 的一个后台任务，支持停止 |

### 1.2 设计决策：改写现有，不新增工具

| 方案 | 结论 |
|------|------|
| 新增 `run_daemon` / `background_command` 工具 | ❌ 不采用。与 `run_command` 重复 sandbox、classifier、验收门控、checkpoint、harness 摘要 |
| **改写 `run_command` 后台路径 + 生命周期策略 + ETL UI** | ✅ 采用。改动集中、LLM 工具面不变 |

### 1.3 非目标

- **不做跨进程持久** — server 重启后旧 task 不接管（维持现有 `[stale]` 语义）；
- **不做系统级桌面通知 / 浏览器 Notification API**；
- **不把 Shell Dock 内容写入聊天历史** `{id}.json`（ephemeral，与现有 `bg_task_update` 一致）；
- **不引入 JSON 配置项**控制 detached/bound（lifespan 写死在服务端）；
- **不改变 classifier / hard timeout 分级**（仍沿用 `shell-双轨执行-finish.md`：long → 24h 等）；
- **不做 Phase 3** — 不删 `BgTaskChip`、不做多 session 并行 WS 推送、不做侧栏 running 角标；非当前 session 终态靠切回时 `bgTasks` 快照补齐。

---

## 2. 现状与差距

### 2.1 已具备（可复用）

| 能力 | 实现位置 |
|------|----------|
| 后台 spawn / adopt / check / stop / list | `src/tools/builtin/shell-tool.ts` |
| 按 sessionId 隔离的 `BackgroundTaskManager` | `src/tools/background-task-manager.ts` |
| 输出环形缓冲 + 落盘 `data/sessions/<sid>/bg/<taskId>.log` | 同上 |
| WS 推送 `bg_task_update` + UI stop `bg_task_stop` | `src/web/bg-task-pusher.ts`、`src/web/chat-ws.ts` |
| 聊天区 ephemeral chip（`BgTaskChip`） | `src/public/js/chat-bg-task-chip.js` |
| 应用退出 kill 全部 | `stopAllShellWork` → `chat.ts` / `serve.ts` / `cleanupChatResources` |
| ETL 右侧面板 + footer 统计行 | `src/public/js/chat-execution-plan.js` |

### 2.2 与需求的差距

| 需求 | 现状 | 差距 |
|------|------|------|
| R1 会话终止仍运行 | 正常回合结束 ✅；**Stop / turn abort 会 `stopAllShellWorkForSession` 杀后台** | 需拆分 kill 策略 |
| R2 切会话仍运行 | 无 harness 时 ✅；**switch 时若 leaving session 有 harness → 杀后台** | 同上 |
| R3 关闭即停 | ✅ | 无 |
| R4 主动停止 | ✅ `bg_task_stop` / `action:"stop"` | 无 |
| R5 ETL 底部列表 | ❌ 仅在聊天消息区 chip | 需新 Shell Dock UI |

### 2.3 相关 kill 调用点（须逐一审计）

| 调用场景 | 文件 | 当前行为 | 目标行为 |
|----------|------|----------|----------|
| 用户 Stop（停 Agent） | `chat-ws.ts` `stop` | kill 前台 + 后台 | **abort harness + kill 前台 only** |
| 切换 session（leaving 有 harness） | `chat-ws.ts` `switch_session` | kill 前台 + 后台 | **abort harness + kill 前台 only** |
| turn abort 兜底 | `chat-ws.ts` `handleChatMessage` finally | kill 前台 + 后台 | **kill 前台 only** |
| 清空 session | `clear_session` → 杀全部 + 清 `.bg-tasks.json` + WS `session_cleared { bgTasks: [] }` |
| 应用 shutdown | `cleanupChatResources` / CLI graceful | kill 全部 | **保持 kill 全部** |
| 单任务 stop | `bg_task_stop` / `run_command action:stop` | kill 单个 | **保持** |

---

## 3. 核心概念：任务 lifespan

为 `BackgroundTask` 增加 **`lifespan`** 字段（服务端内部，**不暴露给 LLM tool schema**）。

| lifespan | 含义 | 何时终止 |
|----------|------|----------|
| **`detached`**（默认） | 与 Agent / harness 回合解耦 | 应用退出 · 删除/清空 session · 用户主动 stop · hard timeout |
| **`bound`**（保留，默认不用） | 与 harness 生命周期绑定 | 上述 + chat Stop · switch abort · turn abort |

**默认规则：**

- `BackgroundTaskManager.spawn()` → `lifespan: 'detached'`
- `BackgroundTaskManager.adopt()`（前台 8s escalate）→ `lifespan: 'detached'`
- 前台同步命令（未转后台）→ 仍走 `foreground-shell-registry`，不受 lifespan 影响

### 3.1 「会话终止」语义（已拍板）

**用户点聊天 Stop = 只停 Agent，不停 detached 后台命令。**

与 R1 一致：Stop 触发 `abortHarnessForSession` + `stopForegroundShellWorkForSession`，**不**调用 `killAllRunningBackgroundTasksForSession`。

---

## 4. 后端设计

### 4.1 拆分 `session-shell-control`

```typescript
// src/tools/session-shell-control.ts（概念 API）

/** 用户 Stop / switch abort / turn abort：只杀前台 + registry */
export function stopForegroundShellWorkForSession(
  sessionId: string,
  reason?: string,
): { foreground: number };

/** 只 abort harness（chat-ws 已有 abortSession；此处可选封装） */

/** 删除 session / clear / shutdown：杀 detached + bound + 前台 */
export function stopAllShellWorkForSession(
  sessionId: string,
  reason?: string,
): ShellWorkStopResult;

/** 应用退出 */
export function stopAllShellWork(reason?: string): ShellWorkStopResult;
```

`killAllRunningBackgroundTasksForSession` 增加过滤：

```typescript
killAllRunning(options?: { lifespan?: 'detached' | 'bound' | 'all' })
// 默认 'all' — 仅 delete/clear/shutdown 使用
```

### 4.2 `BackgroundTaskManager` 变更

**`BackgroundTask` 新增字段：**

```typescript
lifespan: 'detached' | 'bound';
```

**方法调整：**

| 方法 | 变更 |
|------|------|
| `spawn()` / `adopt()` | 写入 `lifespan: 'detached'`（参数可预留 `lifespan?`，默认 detached） |
| `killAllRunning({ lifespan })` | 按 lifespan 过滤后 kill |
| `list()` / `getRunningSummary()` | 返回中带 `lifespan`（UI 可选展示） |
| `exportSnapshot()` | 序列化 `lifespan`（checkpoint 元数据） |

### 4.3 `run_command` 工具面

**Phase 1 不改 tool schema。** 行为变化对 LLM 透明：

- 仍返回 `mode:'background' | 'escalated'` + `taskId`
- 仍用 `action:"check" | "stop" | "list"`
- `action:"list"` 仅列出**当前 session** 的任务（已有）

可选 Phase 2：在 check/list JSON 中增加 `"lifespan":"detached"` 供调试，**非必须**。

### 4.4 WebSocket 协议扩展

#### 4.4.1 现有事件（保持）

```json
{ "type": "bg_task_update", "sessionId": "...", "timestamp": "...", "tasks": [...] }
{ "type": "bg_task_stop_result", "ok": true, "taskId": "...", "sessionId": "..." }
```

客户端 → 服务端：

```json
{ "type": "bg_task_stop", "taskId": "bg_abc123" }
```

#### 4.4.2 新增：会话切换 / 连接时快照

在 **`connected`** 与 **`session_switched`** 响应中增加可选字段 `bgTasks`：

```typescript
interface BgTaskSnapshotEntry {
  taskId: string;
  label: string;
  command: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  elapsed: string;
  elapsedMs: number;
  exitCode: number | null;
  error: string | null;
  isTerminal: boolean;
  isHang: boolean;       // lastOutputAt > 30min
  newLines: number;      // 自上次摘要（快照时为 0 或 total）
}
```

**服务端组装：**

1. `getBackgroundTaskManagerFor(sessionId, workDir).list()`
2. 对 `status === 'running'` 的任务合并 `getRunningSummary()` 的 `lastOutputAt` / hang 信息
3. **`buildBgTaskRunningSnapshot`** — 仅含 `status === 'running'` 条目（ETL Dock 用；终态不进快照）
4. WS 重连时在 `connection` 回调 **`rebindBgTaskPusher`**

#### 4.4.3 多 session 并行推送（不做）

`BgTaskPusher` 仍为全局单例，仅 attach 当前活跃 session 的 manager。非当前 session 的 running/终态**不**实时推送；用户切回该 session 时靠 `connected` / `session_switched` 的 `bgTasks` 快照恢复。**不在后续 Phase 中扩展。**

---

## 5. 前端设计：ETL Shell Dock

### 5.1 位置与布局

在 **`#exec-transparency-panel`** 内，**现有 `#etl-footer` 统计行之上**新增区域：

```
┌ exec-transparency-panel ────────────────┐
│ [Snapshot] [Flow]  …tabs…               │
│ …主内容区…                               │
├ etl-shell-dock ─────────────────────────┤  ← 新增（仅 running）
│ ▶ npm test              12m        [×]  │
│ ▶ docker build           3m        [×]  │
├ etl-footer ─────────────────────────────┤  ← 现有
│ 上下文 12k/128k | 工具 3 | 时间 00:42    │
└─────────────────────────────────────────┘
```

**约束：**

- 仅展示 **当前活跃 sessionId** 的 **running** 后台任务（R5）；
- ETL 主开关关闭时：Shell Dock **一并隐藏**（与 ETL 同显隐）；
- 移动端 sheet 形态：Dock 放在 sheet 内 footer 上方，样式复用同一组件逻辑。
- **跨端同步**：running 列表落盘 `data/sessions/{sessionId}.bg-tasks.json`；REST `GET /api/sessions/:id/bg-tasks`；WS `connected` / `session_switched.bgTasks` 为实时校正；删除 session 时随文件族一并清除。

### 5.2 新模块

| 文件 | 职责 |
|------|------|
| `src/public/js/chat-etl-shell-dock.js` | Dock 渲染、upsert（仅 running）、stop、hydrate |
| `src/public/css/chat-execution-plan.css` | `.etl-shell-dock`、`.etl-shell-item`、stop 按钮、状态色 |
| `src/public/js/chat-execution-plan.js` | `#etl-shell-dock-host` 挂载点；teardown 时 `resetMount` |
| `src/session/bg-tasks-store.ts` | `{sessionId}.bg-tasks.json` 读写；manager 变更时 sync |
| `src/web/routes/sessions.ts` | `GET /api/sessions/:id/bg-tasks` |
| `src/public/js/chat-page.js` | `bg_task_update` / WS / REST 接线；`hydrateShellDockForSession` |
| `src/public/js/chat-execution-plan-bridge.js` | ETL mount 后 `syncShellDockOnMount` |
| `src/public/js/main.js` | import 新模块 |

### 5.3 交互规格

| 行为 | 规格 |
|------|------|
| 任务启动 | 收到 `bg_task_update`（spawn 时 `markSummaryDirty` 已立刻推）→ Dock 新增/更新 item |
| 运行中 | 显示 label（或 command 前 50 字）、elapsed、可选 `+N lines` |
| Hang | `isHang === true` → 文案「>30min 无输出」+ warning 样式 |
| 终态 | **Dock 立即移除**（不 linger）；`BgTaskChip` 仍 5min linger |
| 停止 | 点击 `[×]` → `WS.send({ type: 'bg_task_stop', taskId })` → item 进入 `stopping…`；失败则 `resetStopPending` |
| 切 session | `onSessionSwitched` → 读 localStorage + `session_switched.bgTasks` hydrate → 后续靠 push |
| 刷新 | WS `connected.bgTasks` 或 REST `/bg-tasks` → ETL mount 后 resync |
| 清空 session | `session_cleared` → Dock 立即清空 |

### 5.4 与 `BgTaskChip` 的关系（长期双轨）

| 策略 | 说明 |
|------|------|
| **ETL Shell Dock** | 主展示（ETL 开启时）；**仅 running** |
| **聊天区 `BgTaskChip`** | **永久保留** — ETL 关闭时仍可见；终态 5min linger；与 Dock 并行更新 |

---

## 6. 运行时流程

### 6.1 启动后台命令

```
Agent → run_command("npm test")
  → classifier: long → bgManager.spawn(..., lifespan: detached)
  → 返回 { mode: background, taskId }
  → BgTaskPusher.emitStatusChange → bg_task_update
  → ETL Shell Dock upsert item
```

### 6.2 用户 Stop Agent（不停命令）

```
用户 Stop
  → abortSession(sessionId)
  → stopForegroundShellWorkForSession(sessionId)   // 不杀 detached 后台
  → harness 收尾写入 session
  → 后台 npm test 继续；Dock item 仍为 running
```

### 6.3 切换 session

```
switch_session A → B
  → abortSession(A)                    // 若 A 有 harness
  → stopForegroundShellWorkForSession(A)  // 不杀 A 的 detached 后台
  → rebindBgTaskPusher(B)
  → session_switched { sessionId: B, bgTasks: [...] }
  → Dock 清空并展示 B 的任务
  → A 的后台命令在服务端继续跑（A 的 manager 仍在 managersBySession Map 中）
```

### 6.4 用户主动停止命令

```
Dock [×] 或 run_command action:stop
  → bgManager.kill(taskId)
  → taskStatusChanged → bg_task_update (isTerminal)
  → Dock item 立即移除；chip 终态 linger 5min
```

### 6.5 应用退出

```
SIGINT / shutdown hook
  → stopAllShellWork('shutdown')
  → disposeAllBackgroundTaskManagers()
  → 全部子进程 killTree
```

---

## 7. 与现有子系统联动

| 子系统 | 影响 |
|--------|------|
| **Harness 验收门控** | 无 schema 变更；`background_start/running/completed` 语义不变 |
| **Harness bg summary 注入** | 仍用 `getRunningSummary()`；detached 任务在 Stop 后仍会被摘要（符合「命令还在跑」） |
| **Checkpoint** | `exportSnapshot` 增加 `lifespan`；resume 仍不接管 running 子进程（stale） |
| **CLI `iceCoder chat`** | 退出时 `stopAllShellWork` — 符合 R3 |
| **多会话侧栏** | session 删除仍 `purgeSessionRuntimeCaches` 全杀 — 符合预期 |
| **Foreground escalate** | adopt 后 lifespan=detached，Stop 不杀 |

---

## 8. 实现阶段

### Phase 0 — 生命周期策略（P0，阻塞）

| 任务 | 文件 |
|------|------|
| `BackgroundTask` 增加 `lifespan` | `background-task-manager.ts` |
| 拆分 foreground / background kill | `session-shell-control.ts` |
| 调整 chat-ws stop / switch / turn abort | `chat-ws.ts` |
| 测试：Stop 不杀 detached；switch 不杀；delete 仍杀；bound 过滤 | `test/tools/session-shell-control.test.ts` |
| 测试：`buildBgTaskRunningSnapshot` | `test/web/bg-task-snapshot.test.ts` |

**验收：**

- [x] `npm test` 后台启动 → 用户 Stop → `action:check` 仍 `running`
- [x] session A 后台任务 → switch 到 B → A 的 task 仍 `running`（`list` on A's manager）
- [x] 删除 session A → A 的后台进程终止
- [ ] 进程 exit → 无残留 node 子进程（抽样）

### Phase 1 — WS 快照（P1）

| 任务 | 文件 |
|------|------|
| `buildBgTaskRunningSnapshot` / `bg-tasks-store` | `bg-task-pusher.ts` · `session/bg-tasks-store.ts` |
| `connected` / `session_switched` 附带 `bgTasks`（仅 running） | `chat-ws.ts` |
| REST + 前端解析 | `GET /api/sessions/:id/bg-tasks` · `chat-page.js` |

**验收：**

- [x] 切回有后台任务的 session → Dock 立即显示 running 项，无需等心跳
- [x] F5 刷新 / Mobile 切 session → REST 或 WS 恢复 Dock running 项

### Phase 2 — ETL Shell Dock UI（P2）

| 任务 | 文件 |
|------|------|
| Shell Dock 组件 | `chat-etl-shell-dock.js` + CSS |
| 挂载与 session 切换 | `chat-execution-plan.js`、`chat-page.js`、`chat-execution-plan-bridge.js` |
| stop 按钮接线 | 复用 `bg_task_stop` |

**验收：**

- [x] 后台命令启动后 ETL 底部出现 item
- [x] `[×]` 可终止；Dock 终态立即消失（chip 仍 5min linger）
- [x] ETL 关闭时 Dock 不可见；**chip 仍可见**（长期双轨）

---

## 9. 测试清单

### 9.1 单元 / 集成

| 用例 | 预期 |
|------|------|
| spawn 默认 lifespan=detached | `getStatus().lifespan === 'detached'` |
| killAllRunning({ lifespan: 'bound' }) 不杀 detached | running count 不变 |
| stopForegroundShellWorkForSession 不杀后台 | background running |
| disposeBackgroundTaskManagerForSession 杀全部 | 进程 exit |

### 9.2 手动 / E2E

| 步骤 | 预期 |
|------|------|
| 启动 `npm run test:watch` 类 long 命令 | 立刻 background + Dock item |
| Stop Agent | Agent 停；Dock 仍 running |
| 切换 session 再切回 | 原 task 仍在；snapshot 正确 |
| Dock stop | 进程树 kill；item 终态 |
| 关闭 iceCoder | 任务终止 |

---

## 10. 迁移与兼容

| 项 | 说明 |
|----|------|
| **Tool schema** | 无 breaking change |
| **旧 checkpoint** | 无 `lifespan` 字段 → load 时视为 `detached` |
| **旧客户端** | 忽略 `bgTasks` 字段；chip 仍工作 |
| **文档** | 已更新 `docs/PROJECT-GUIDE.md` Shell 双轨 + 生命周期小节 |
| **Shell Dock 会话文件** | `data/sessions/{sessionId}.bg-tasks.json`；DELETE session 时 purge |

---

## 11. 风险与边界

| 风险 | 缓解 |
|------|------|
| Stop 后后台 dev server 仍占端口 | 文档说明；用户用 Dock stop；Hang 检测仍生效 |
| 多 session 各跑 dev server | 已有 MAX_CONCURRENT=8；session 隔离 |
| 用户误以为 Stop 会停测试 | ETL Dock + 聊天区 chip 均可见 running |
| server 重启 task 丢失 | 维持 stale + log 只读；`.bg-tasks.json` 在 sync 时清空 running；不承诺跨重启接管进程 |

---

## 12. 关联文档与代码

| 文档 | 关系 |
|------|------|
| `docs/requirement/shell-双轨执行-finish.md` | 前置：classifier、adopt、24h timeout、BgTaskPusher |
| `docs/requirement/执行透明-finish.md` | ETL 面板结构、footer、桥接 |
| `docs/requirement/多会话-web侧栏-finish.md` | session 切换、delete 清理 |

| 代码 | 关系 |
|------|------|
| `src/tools/background-task-manager.ts` | lifespan、kill 过滤 |
| `src/tools/session-shell-control.ts` | kill 拆分 |
| `src/tools/builtin/shell-tool.ts` | 工具入口（不改 schema） |
| `src/web/chat-ws.ts` | stop/switch/shutdown、snapshot |
| `src/web/bg-task-pusher.ts` | WS 推送 |
| `src/public/js/chat-execution-plan.js` | Dock 挂载点 |
| `src/public/js/chat-etl-shell-dock.js` | Dock UI（仅 running） |
| `src/public/js/chat-page.js` | WS / REST 接线；`hydrateShellDockForSession` |
| `src/public/js/chat-bg-task-chip.js` | 长期保留，与 Dock 双轨 |
| `test/tools/session-shell-control.test.ts` | lifespan / kill 拆分 |
| `test/session/bg-tasks-store.test.ts` | session 文件 sync |
| `test/web/bg-task-snapshot.test.ts` | `buildBgTaskRunningSnapshot` |

---

## 13. 验收总表（Definition of Done）

- [x] R1：Stop / turn abort 后 detached 后台仍 running  
- [x] R2：switch session 不杀 leaving session 的 detached 后台  
- [x] R3：应用 exit 杀全部 shell 子进程  
- [x] R4：`bg_task_stop` / `action:"stop"` 杀指定任务  
- [x] R5：ETL 底部展示当前 session **running** 任务列表，可 stop  
- [x] Dock 仅 running；刷新 / 跨端经 REST + WS `bgTasks` 恢复  
- [x] 不新增 LLM 工具；`session-shell-control` + `bg-task-snapshot` 测试通过  
- [x] 无回归：`delete session`、`clear session` 仍清理后台进程 + `.bg-tasks.json`  
- [ ] 手动 E2E（§9.2）全绿（可选回归）
