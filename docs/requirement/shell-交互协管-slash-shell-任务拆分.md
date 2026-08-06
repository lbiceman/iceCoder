# `/shell` Shell 协作 — 工程任务拆分

> **状态**：待执行  
> **版本**：v1.0  
> **日期**：2026-08-06  
> **依据**：[`shell-交互协管-slash-shell.md`](./shell-交互协管-slash-shell.md)（需求 v1.8）  
> **范围**：Phase 1 MVP 全量（PTY · 4 工具 · R9 隔离 · mandatory confirm · UI 标识 · Skill）  
> **本文件性质**：执行任务清单，不新增产品需求、不修改架构决策。

---

## 1. 如何使用本文档

1. **严格按 Wave 顺序执行**（同 Wave 内标注 `∥` 的可并行）。
2. 每个任务交给 Cursor Agent 时，复制对应 **Agent Prompt 片段**（§16）并指定 **推荐模型**。
3. 合并 PR 前对照 **验收用例**（§15）与需求文档 §12、§13。
4. **R9 工具隔离**（Wave 4）与 **mandatory confirm**（Wave 5）必须人工 review，不可仅依赖 Agent 自测。

---

## 2. 模型选用说明

| 模型 | 适用场景 | 本方案任务数 |
|------|----------|--------------|
| **Composer 2.5** | 文档已写死的 CRUD、UI 标识、单文件工具、mock 单测 | 12 |
| **Grok 4.5** | PTY 工具封装、WS 路由、Prompt/Skill、E2E 脚本 | 9 |
| **GPT 5.6 Sol** | 跨 2～3 文件 Harness 接入、状态持久化、脱敏链路 | 5 |
| **GPT 5.6 Terra** | 安全隔离、不可绕过 confirm、嵌套命令解析、防旁路 | 8 |

**原则**：Terra 仅用于安全关键路径；其余用 Composer / Grok 控成本；Sol 用于需要理解 Harness 上下文但不涉及安全策略的模块。

---

## 3. 执行总览

### 3.1 依赖顺序

```text
Wave 0（基础设施）
  0.1 node-pty 依赖 ──→ 0.2 shell-collab-store
         │
Wave 1（PTY 核心）
  1.1 Manager 骨架 → 1.2 增量 read → 1.3 awaiting_input
         │                              │
         ├── 1.4 lifespan kill ∥ 1.5 mock 单测
         │
Wave 2（Shell 工具）
  2.1 interactive_shell → 2.2 shell_exec → (2.3 shell_wait ∥ 2.4 shell_send_keys)
         → 2.5 工厂 → 2.6 提示态保护 → 2.7 脱敏
         │
Wave 3（路由）          Wave 6（UI 标识，可与 3 并行）
  3.1 commands ──→ 3.2 chat-ws /shell ──→ 3.3 active Harness
  3.4 session 载荷     6.1～6.3
         │
Wave 4（R9 隔离）← 依赖 2.5 + 3.3
  4.1 session-tool-policy → 4.2 chat-ws 分流 → (4.3 harness ∥ 4.4 executor ∥ 4.5 旁路) → 4.6 测试
         │
Wave 5（mandatory confirm）← 依赖 2.x + 3.x
  5.1 风险分类 → 5.2 嵌套解析 → 5.3 permission runtime → (5.4 前端弹框 ∥ 5.5 write 防绕过)
         │
Wave 7（Prompt/Skill）← 4 完成后定稿
  7.1 skill.md ∥ 7.2 system 注入
         │
Wave 8（E2E 验收）
  8.1 mock SSH 脚本 → 8.2 T1～T37 清单
```

### 3.2 PR 切分（5 个）

| PR | 包含 Wave / 任务 | 合并门槛 |
|----|------------------|----------|
| **PR-A** | Wave 0 + Wave 1 | PTY mock 单测绿；spawn/kill 手动 smoke |
| **PR-B** | Wave 2 | 4 工具 handler 单测；T3/T4/T24 工具层 |
| **PR-C** | Wave 3 + Wave 6 + Wave 7 | T1/T15/T34/T35；`/shell` 进模式 + UI 标识 |
| **PR-D** | Wave 4 | T11～T23 自动化子集绿；**必须 Terra review** |
| **PR-E** | Wave 5 + Wave 8 | T28～T37 + 需求 §12 两条 E2E |

---

## 4. Wave 0 — 基础设施

### 任务 0.1 — 引入 `node-pty`

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 无 |
| **新建/修改** | `package.json`；desktop native rebuild 流程（参考现有 native 依赖） |
| **目标** | 跨平台 PTY 可编译；Electron 打包纳入 rebuild |

**Checklist**

- [x] 添加 `node-pty` 依赖
- [x] Windows ConPTY / Unix 本地 smoke：`spawn` shell 并 read 一行输出
- [x] Electron `rebuild` 脚本可跑通（或与现有 native 模块同一流程）
- [x] 文档 §10 依赖项在 README/构建说明中可追溯（若项目有统一位置则更新一行即可）

**验收**

- 本机 `npm run build`（或项目等价命令）不报错
- 简单脚本可 spawn PTY

---

### 任务 0.2 — Shell 协作状态持久化

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Sol |
| **依赖** | 无（可与 0.1 并行） |
| **新建** | `src/session/shell-collab-store.ts` |
| **类型** | `ShellCollabState`（需求 §3.1） |

**Checklist**

- [x] 内存 `Map<sessionId, ShellCollabState>`
- [x] sidecar：`data/sessions/{sessionId}.shell-collab.json`（或 `{sessionId}/shell-collab.json`，与现有 session 布局一致）
- [x] API：`getShellCollabState` / `setShellCollabActive` / `clearShellCollab` / `persist` / `loadForSession`
- [x] 字段：`active`, `taskId`, `enteredAt`
- [x] 删 session 时清 sidecar

**验收**

- [x] T15：`active` 写入后重启进程 / 模拟 load 仍为 `true`
- [ ] T16：重复 enter 幂等（由上层路由测，store 层保证不丢状态）

---

## 5. Wave 1 — PTY 核心

### 任务 1.1 — `InteractiveShellManager` 骨架

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 0.1 |
| **新建** | `src/tools/interactive-shell-manager.ts` |
| **参考** | `src/tools/background-task-manager.ts`（生命周期模式，非 PTY 实现） |

**Checklist**

- [x] 进程级单例；按 `sessionId` 至多一个活跃 `ish_*` task
- [x] `taskId` 格式 `ish_*`
- [x] `node-pty` spawn；字段：`pty`, `outputBuffer`, `cursor`, `awaitingInput`, `lifespan: 'copilot'`
- [x] `start` / `stop` / `getTask` / `listForSession`
- [x] sandbox 校验（需求 §5.4，复用现有 shell guard 若可）

**验收**

- [x] 同 session 两次 start 行为符合需求（复用或明确错误，与 §3.2 一致）
- [x] T5：`taskId` 跨调用稳定

---

### 任务 1.2 — 增量 read 与日志

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 1.1 |

**Checklist**

- [x] 环形缓冲 + 可选落盘 `data/sessions/<sid>/ish/<taskId>.log`
- [x] `read(since)` → `{ output, cursor, totalOutputLines }`
- [x] cursor 单调递增；不重复返回旧行

**验收**

- [x] 连续 read 拼接等于全量输出
- [x] 单测覆盖 cursor 边界

---

### 任务 1.3 — `awaiting_input` 检测

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 1.2 |
| **参考** | 需求 §5.3 |

**Checklist**

- [x] 启发式：`Password:`、`请输入密码`、`(yes/no)` 等（可配置列表）
- [x] 设置 `awaitingInput` 状态；read 返回 `status: 'awaiting_input'`
- [x] 非 100% 检测：文档声明 AI 读 raw output 兜底（不在本任务做 LLM）

**验收**

- [x] T3：`read -p "请输入密码:"` mock → `awaiting_input`
- [ ] T32：password 内容不误触 command confirm（与 Wave 5 联测）

---

### 任务 1.4 — 生命周期 kill 策略

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 1.1 |
| **修改** | `src/tools/session-shell-control.ts` |
| **参考** | 需求 §9 |

**Checklist**

- [x] `lifespan: 'copilot'` 分支：删 session / app shutdown → kill PTY
- [x] Harness `model_done` / Stop Agent → **不 kill**
- [x] 旧 `/shell exit` → 拒绝并提示新建会话，不 kill、不清 active
- [ ] `action:stop` → kill PTY 但保持 `active`（工具层，Wave 2.1）

**验收**

- [x] T6 Stop Agent 后 PTY 仍存活
- [x] T7 删 session → PTY killed

---

### 任务 1.5 — Manager 单元测试

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 1.3 |
| **新建** | `test/tools/interactive-shell-manager.test.ts`（或 `interactive-shell-*.test.ts`） |

**Checklist**

- [x] mock `node-pty` 或使用 fake pty 接口
- [x] 覆盖：start/read cursor/awaiting_input/stop
- [x] CI Windows 集成测试可 `skip`（需求 §12 Phase 1）

**验收**

- [x] `npm test` 相关用例绿

---

## 6. Wave 2 — Shell 专用工具

### 任务 2.1 — `interactive_shell` 工具

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 1.3 |
| **新建** | `src/tools/builtin/interactive-shell-tool.ts` |
| **参考** | 需求 §5.1～§5.2 |

**Checklist**

- [x] actions：`start` | `read` | `write` | `check` | `stop`
- [x] `write` 仅 `awaitingInput === true`；否则拒绝并提示用 `shell_exec`
- [x] `stop`：kill PTY，**不**清 `ShellCollabState.active`
- [x] 返回 schema 与需求 §5.2 一致

**验收**

- [x] T3/T4/T5/T17

---

### 任务 2.2 — `shell_exec` 工具

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 1.3 |
| **新建** | `src/tools/builtin/shell-exec-tool.ts` |
| **参考** | 需求 §5.5.1 |

**Checklist**

- [x] 向当前 PTY 写入 command + 换行
- [x] 等待 idle / prompt / exit（与 manager 协作）
- [x] 返回新增输出 + cursor
- [x] **不** spawn 新 shell

**验收**

- [x] T24：`df -h` 写入当前 PTY
- [x] T27：password prompt 时拒绝 exec

---

### 任务 2.3 — `shell_wait` 工具

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 1.2 |
| **新建** | `src/tools/builtin/shell-wait-tool.ts` |
| **参考** | 需求 §5.5.2 |

**Checklist**

- [x] 等待异步输出 / prompt / timeout
- [x] timeout **不 kill** PTY

**验收**

- [x] T25

---

### 任务 2.4 — `shell_send_keys` 工具

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 1.1 |
| **新建** | `src/tools/builtin/shell-send-keys-tool.ts` |
| **参考** | 需求 §5.5.3 |

**Checklist**

- [x] 映射：`CTRL_C`, `CTRL_D`, `TAB`, 方向键等
- [x] `CTRL_C` 不触发 mandatory confirm（需求 §8.1.1）

**验收**

- [x] T26

---

### 任务 2.5 — 工具工厂与白名单常量

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 2.1～2.4 |
| **新建** | `src/tools/shell-collab-tools.ts` |

**Checklist**

- [x] `SHELL_COLLAB_TOOL_NAMES` 常量（需求 §5.6.1）
- [x] `createShellCollabTools({ sessionId, cwd })` 返回 4 个绑定 session 的 tool 实例
- [x] **不**注册进全局 `initializeToolSystem()`

**验收**

- [x] definitions 排序后严格等于白名单

---

### 任务 2.6 — 提示态保护与 sandbox

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Sol |
| **依赖** | 2.1, 2.2 |
| **参考** | 需求 §5.4 |

**Checklist**

- [x] `awaitingInput` 时 block `shell_exec`
- [x] start 命令仅先走不可配置 hard block / 宿主保护（如 `rm -rf /`）；配置正则留给 Wave 5 confirm → T8

**验收**

- [x] T8/T27

---

### 任务 2.7 — 凭证脱敏

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Sol |
| **依赖** | 2.1 |
| **参考** | 需求 §8.2 |

**Checklist**

- [x] `write` 的 `input` 在 checkpoint / telemetry 记 `[redacted]`
- [x] PTY 日志不记录 password 明文
- [x] 用户聊天消息仍进 session JSON（不额外脱敏）

**验收**

- [x] T32 日志检查

---

## 7. Wave 3 — `/shell` 路由与 WS

### 任务 3.1 — 斜杠命令注册

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 无 |
| **修改** | `src/public/js/chat-commands.js` |
| **参考** | 需求 §4.2 |

**Checklist**

- [x] `SLASH_LOCAL_COMMANDS` 增加 `{ name: 'shell', description: '...', prefix: '/' }`

**验收**

- [x] 面板可见 `/shell`

---

### 任务 3.2 — 服务端 `/shell` 固定模式

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 0.2, 1.4 |
| **修改** | `src/web/chat-ws.ts` |
| **参考** | 需求 §4.4 |

**Checklist**

- [x] 路由顺序：`/also` → `/shell` → `/next` / 普通消息
- [x] `/shell`：`active=true` 持久化；**不**启动 Harness；广播 `shell_collab_entered`
- [x] 已有 PTY：`shell_collab_resumed`
- [x] 旧 `/shell exit`：拒绝并提示新建会话；保持 `active=true` 与 PTY
- [x] 幂等：已 active 再 `/shell` → 提示已在模式中

**验收**

- [x] T1/T2/T16/T17

---

### 任务 3.3 — active session 普通消息 Harness

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 3.2（Wave 4 完成后与 4.2 联调） |
| **修改** | `src/web/chat-ws.ts` |

**Checklist**

- [x] 已 `active` 的用户消息不带 `/shell` 前缀也走 Harness
- [x] 预留 `resolveSessionHarnessToolContext(sessionId)` 调用点（Wave 4.2 实现）

**验收**

- [x] T12/T13（Wave 4 后完整测；当前占位：active 消息走 Harness + sidecar 恢复）

---

### 任务 3.4 — session 列表 `shellCollabActive`

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 0.2, 3.2 |
| **修改** | `src/web/chat-ws.ts`、`src/public/js/chat-session-sidebar.js`（载荷消费） |

**Checklist**

- [x] 初始 session 列表含 `shellCollabActive`
- [x] 不只依赖 WS `shell_collab_entered`（需求 §7.2）

**验收**

- [x] T15/T35 F5 后 sidebar 仍显示 Shell 标签

---

## 8. Wave 4 — R9 工具域隔离（安全关键）

> **全部任务推荐 GPT 5.6 Terra 实施 + 人工 review。**

### 任务 4.1 — `session-tool-policy.ts`

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 2.5 |
| **新建** | `src/session/session-tool-policy.ts` |
| **参考** | 需求 §6.4 |

**Checklist**

- [x] `resolveSessionHarnessToolContext(sessionId)`
- [x] 非 active → 现有 `resolveWorkspaceToolContext`
- [x] active → 新建 `ToolRegistry` + `ToolExecutor`，仅 `createShellCollabTools`
- [x] `toolDefs` 严格等于 `SHELL_COLLAB_TOOL_NAMES`
- [x] `enableRequestAnalysis: false`；`mcpRuntimeContext: {}`

**验收**

- [x] T19 definitions 无 `run_command` / 文件 / MCP

---

### 任务 4.2 — `chat-ws.ts` ToolSystem 分流

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 4.1, 3.3 |

**Checklist**

- [x] 每轮 Harness 按 session `active` 选择 ToolSystem
- [x] Shell 分支不调用 `registerMcpToolsOnRegistry`
- [x] telemetry 记录 `shellCollabActive` + `toolNames`

**验收**

- [x] T11/T12/T21

---

### 任务 4.3 — Harness 禁 `request_analysis`

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Sol |
| **依赖** | 4.1 |
| **修改** | `src/harness/harness.ts` |

**Checklist**

- [x] Shell 模式 `enableRequestAnalysis: false`
- [x] 构造器不调用 `ensureRequestAnalysisTool()`

**验收**

- [x] T20/T22 无 SubAgent 注入

---

### 任务 4.4 — Executor allowlist 二次校验

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 4.1 |
| **修改** | `src/harness/harness-tool-executor.ts` |
| **参考** | 现有 `harness-tool-executor-policy.test.ts` |

**Checklist**

- [x] 执行前校验 tool 名 ∈ 本轮 `currentTools`
- [x] 拦截 checkpoint salvage / 伪造 `run_command` / `mcp_*`

**验收**

- [x] T20/T21

---

### 任务 4.5 — 旁路隔离

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 4.2 |
| **修改** | `src/web/chat-ws.ts` |

**Checklist**

- [x] Shell active 跳过 direct file-browser shortcut
- [x] 不等待 MCP 初始化
- [x] `/api/tools` 不列出 Shell 专用工具（需求 §5.6.4）

**验收**

- [x] T22/T23

---

### 任务 4.6 — 隔离回归测试

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Sol |
| **依赖** | 4.4 |
| **修改/新建** | `test/harness/harness-tool-executor-policy.test.ts` 或专用 `shell-collab-tool-policy.test.ts` |

**Checklist**

- [x] 普通 session：无 Shell 工具
- [x] Shell session：仅 4 工具；伪造 call 返回 policy error
- [x] 旧 `/shell exit` 后仍严格保持 Shell 专用 tools

**验收**

- [x] T11～T23 自动化子集

---

## 9. Wave 5 — 敏感命令强制确认

### 任务 5.1 — 风险分类器

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 2.2 |
| **新建** | `src/tools/shell-collab-command-risk.ts` |
| **参考** | 需求 §8.1.2 |

**Checklist**

- [x] 从设置 `shellBlacklist` 读取并编译正则（字段名仅为兼容保留，语义为强制确认规则）
- [x] `classifyShellCollabCommandRisk(command)` → `{ risk, category, normalized, matchedPattern }` | null
- [x] 仅命中配置正则时返回风险；未命中必须返回 null
- [x] 入口：`shell_exec.command`、`interactive_shell start` 的 command

**验收**

- [x] T28

---

### 任务 5.2 — 嵌套与组合命令解析

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 5.1 |

**Checklist**

- [x] quote-aware 拆分 `;` `&&` `||` pipeline
- [x] `bash -c` / `cmd /c` / `powershell -Command` 内层递归
- [x] 任一子命令命中 → 整次 confirm

**验收**

- [x] T33

---

### 任务 5.3 — `shellMandatoryConfirm` runtime

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 5.1, 3.2 |
| **修改** | `src/harness/harness-permission-runtime.ts`、`src/web/chat-ws.ts`（onConfirm 扩展） |
| **参考** | 需求 §8.1 |

**Checklist**

- [x] 优先级：`hard block > 命中规则的 shellMandatoryConfirm > 未命中直接执行`
- [x] 命中后 `skipPermissionChecks` / 自动执行 **不能**跳过
- [x] 未命中配置正则时跳过普通 permission，不弹框并直接写入 PTY
- [x] `shellBlacklist: []` 仅关闭可配置确认，不关闭 hard block / 宿主保护
- [x] 单次授权：`sessionId + taskId + normalizedCommandHash`
- [x] 拒绝/超时 60s → 零字节写入 PTY；返回 `denied` / `confirmation_timeout`
- [x] 无「本次会话始终允许」

**验收**

- [x] T29/T30/T31/T37

---

### 任务 5.4 — 前端 mandatory confirm 弹框

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | 5.3 |
| **修改** | `src/public/js/chat-page.js` |
| **参考** | 需求 §8.1.3 |

**Checklist**

- [x] 标题：`Shell 敏感命令确认`
- [x] 展示：session、命令（脱敏）、命中的设置正则、影响说明
- [x] 默认焦点「取消」；固定提示不被自动执行跳过

**验收**

- [x] T28/T30 UI 手动测

---

### 任务 5.5 — write 防绕过

| 项 | 内容 |
|----|------|
| **推荐模型** | GPT 5.6 Terra |
| **依赖** | 2.1, 5.1 |
| **修改** | `interactive-shell-tool.ts` + manager |

**Checklist**

- [x] 命令态 / 未知态拒绝 `write`
- [x] 分片 write（`rm ` + `-rf` + ENTER）在触碰 PTY 前拒绝

**验收**

- [x] T36

---

## 10. Wave 6 — 前端最小模式标识

| 项 | 任务 | 模型 | 修改文件 |
|----|------|------|----------|
| **6.1** | 输入区底部 `>_ Shell 协作中` + tooltip | Composer 2.5 | `chat-page.js` |
| **6.2** | sidebar 终端图标 + `Shell` 标签 | Composer 2.5 | `chat-session-sidebar.js` |
| **6.3** | entered 插入 agent 提示消息；模式在 session 生命周期内常驻 | Composer 2.5 | `chat-page.js` |

**共同验收**

- [x] T18 无 xterm / 终端面板
- [x] T34/T35 进入、F5、切 session、exit 标识正确

**参考**：需求 §4.3、§7.2

---

## 11. Wave 7 — Prompt / Skill

### 任务 7.1 — `shellCopilot` Skill

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | Wave 4 完成后定稿 |
| **新建** | `data/skills/shellCopilot/skill.md` |
| **参考** | 需求 §6.2 |

**Checklist**

- [x] SSH / 考试场景示例
- [x] 「帮我执行」单回合多步 `shell_exec`
- [x] `awaiting_input` 停手规则
- [x] 汇报模板与错误处理

---

### 任务 7.2 — 动态 system 注入

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5 |
| **依赖** | 4.2 |
| **修改** | `src/prompts/sections.ts` 或现有 loader |
| **参考** | 需求 §6.1 |

**Checklist**

- [x] `ShellCollabState.active` 时追加 Shell Copilot section（或引用 skill）
- [x] 不出现 PDF/DOC/文件/MCP/`run_command` 说明

---

## 12. Wave 8 — 端到端验收

### 任务 8.1 — Mock SSH + 考试 E2E

| 项 | 内容 |
|----|------|
| **推荐模型** | Grok 4.5 |
| **依赖** | PR-A～E 合并或本地全功能分支 |

**Checklist**

- [x] 本地脚本模拟：password prompt → 考试账号 → 题面「日志与磁盘处理」
- [ ] 验收路径 1：§12 验收 1（SSH 协作）— 人工
- [ ] 验收路径 2：§12 验收 2（「帮我执行」同回合多 `shell_exec`）— 人工

---

### 任务 8.2 — 全量测试清单

| 项 | 内容 |
|----|------|
| **推荐模型** | Composer 2.5（跑脚本）+ **人工**勾 PR-D/E |

**Checklist**

- [ ] 逐项勾选需求 §13 T1～T37 — 人工
- [ ] 记录失败项与 follow-up issue — 人工
- [x] 单元测试：`test/prompts/shell-collab-prompt.test.ts`、`test/tools/mock-exam-shell.test.ts`

---

## 13. 文件改动索引（与需求 §11 对齐）

| 文件 | 任务 |
|------|------|
| `src/tools/interactive-shell-manager.ts` | 1.1～1.3, 2.7 |
| `src/tools/tool-argument-redaction.ts` | 2.7 |
| `src/tools/builtin/interactive-shell-tool.ts` | 2.1, 5.5 |
| `src/tools/builtin/shell-exec-tool.ts` | 2.2 |
| `src/tools/builtin/shell-wait-tool.ts` | 2.3 |
| `src/tools/builtin/shell-send-keys-tool.ts` | 2.4 |
| `src/tools/shell-collab-tools.ts` | 2.5 |
| `src/tools/shell-collab-command-risk.ts` | 5.1, 5.2 |
| `src/session/shell-collab-store.ts` | 0.2 |
| `src/session/session-tool-policy.ts` | 4.1 |
| `src/harness/harness.ts` | 4.3 |
| `src/harness/harness-tool-round.ts` | 2.7 |
| `src/harness/harness-tool-executor.ts` | 2.7, 4.4 |
| `src/harness/logger.ts` | 2.7 |
| `src/harness/checkpoint.ts` | 2.7 |
| `src/harness/harness-permission-runtime.ts` | 5.3 |
| `src/tools/session-shell-control.ts` | 1.4 |
| `src/public/js/chat-commands.js` | 3.1 |
| `src/public/js/chat-page.js` | 3.2, 5.4, 6.x |
| `src/public/js/chat-session-sidebar.js` | 3.4, 6.2 |
| `src/web/chat-ws.ts` | 3.2～3.4, 4.2, 4.5, 5.3 |
| `src/prompts/sections.ts` | 7.2 |
| `data/skills/shellCopilot/skill.md` | 7.1 |
| `test/tools/interactive-shell-*.test.ts` | 1.5 |
| `test/harness/*shell-collab*` | 4.6 |

---

## 14. 禁止事项（全 Wave 通用）

- 不新增 xterm / 终端面板 / WS 终端推流（需求 §1.4）
- 不把 Shell 工具注册进全局 `ToolRegistry`
- 不用「完整 tools + prompt 软提醒」代替 R9 硬隔离
- 不让 `skipPermissionChecks` 绕过已命中的 `shellMandatoryConfirm`；也不对未命中命令追加普通 permission
- 不在 v1 实现 `/shell ssh …` 带参语法
- 不修改无关模块风格（最小 diff）

---

## 15. 验收用例映射（需求 §13 摘要）

| 用例 | 验证任务 |
|------|----------|
| T1～T2 | 3.1, 3.2 |
| T3～T5 | 1.3, 2.1 |
| T6～T8 | 1.4, 2.6 |
| T9～T10 | 7.1, 8.1 |
| T11～T23 | 4.x |
| T24～T27 | 2.2～2.4 |
| T28～T31 | 5.x |
| T32 | 2.7, 5.1 |
| T33 | 5.2 |
| T34～T35 | 6.x, 3.4 |
| T36 | 5.5 |
| T37 | 5.1, 5.3 |

完整步骤见需求文档 §13。

---

## 16. Agent 启动 Prompt 模板

复制以下块，替换 `{TASK_ID}`、`{MODEL}`，并 `@` 需求文档。

```markdown
## 任务
执行 shell-交互协管 任务 **{TASK_ID}**（见 `docs/requirement/shell-交互协管-slash-shell-任务拆分.md`）。

## 必读
- @docs/requirement/shell-交互协管-slash-shell.md
- @docs/requirement/shell-交互协管-slash-shell-任务拆分.md §{章节号}

## 约束
- 仅改该任务「文件改动索引」列出的文件；禁止事项见任务拆分 §14
- 完成后运行相关测试并列出验收用例勾选结果
- 不要实现后续 Wave 的内容

## 验收
{从对应任务 Copy「验收」小节}
```

**示例（PR-A 首任务）**

```markdown
## 任务
执行 **0.1 — 引入 node-pty** 与 **0.2 — shell-collab-store**（可分两 commit）。

## 必读
@docs/requirement/shell-交互协管-slash-shell.md §3.1、§10
@docs/requirement/shell-交互协管-slash-shell-任务拆分.md §4

## 模型
0.1 → Composer 2.5；0.2 → GPT 5.6 Sol

## 验收
- node-pty 本地 spawn smoke
- shell-collab sidecar 读写 + T15 模拟
```

---

## 17. 进度跟踪

| Wave | 状态 | PR | 备注 |
|------|------|-----|------|
| 0 | 🟡 进行中（0.1 ✓） | PR-A | |
| 1 | ⬜ | PR-A | |
| 2 | ⬜ | PR-B | |
| 3 | ⬜ | PR-C | |
| 4 | ⬜ | PR-D | Terra review |
| 5 | ✅ | PR-E | Terra review |
| 6 | ✅ | PR-C | |
| 7 | ✅ | PR-C | |
| 8 | 🟡 单元测试 ✓；E2E 人工 | PR-E | |

---

## 18. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-08-06 | 初稿：Wave 0～8、模型标注、PR 切分、Agent 模板 |
