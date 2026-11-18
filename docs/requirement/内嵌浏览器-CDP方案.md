# iceCoder 内嵌浏览器（CDP）方案

> **状态**：待实现
> **版本**：v1.0
> **日期**：2026-11
> **范围**：在 Electron 桌面端内嵌浏览器视图（tab2），由 AI 通过 CDP 驱动；替代/补充 MCP 浏览器方案
> **前置**：`docs/requirement/Electron桌面GUI方案finish.md`（桌面壳已落地）

---

## 0. 执行摘要

### 0.1 目标

| 项 | 说明 |
|----|------|
| **用户价值** | AI 可在应用内操作浏览器做测试、抓数据、填表单；用户可视、可接管、无需装 Node |
| **技术路线** | Electron `WebContentsView` 承载页面 + `webContents.debugger`（CDP）驱动 |
| **不改写** | Harness、工具层、Web UI 主结构保持原样 |
| **零外部依赖** | 不依赖 npx / 系统 Node / 外部 Chrome，复用安装包内已有 Chromium |
| **控制权** | 默认 AI 独占（用户输入被拦截），一键接管/交还 |

### 0.2 非目标（v1 不做）

- 不定制 / fork Chromium 内核（见 §2）
- 不做多浏览器实例并发（v1 单 view）
- 不做无头模式（headless 与"可见性"目标冲突）
- 不做远程 CDP（`streamablehttp` 仍由 MCP 承载）
- 不做控制权租约 / harness 暂停机制（见 §5.3）

### 0.3 起因：MCP 现状

当前运行时的实测状态：

```
puppeteer:       error — spawn EINVAL
chrome-devtools: disabled
unity-mcp/mcd-mcp/wps: disabled
mcpToolsAvailableThisTurn: (none)
```

`src/mcp/resolve-mcp-command.ts` 共 394 行，绝大部分用于在 Windows 上定位 Node/npx：扫 PATH、扫注册表、扫 `%APPDATA%\npm`、`where` 兜底。即便如此仍然 `spawn EINVAL`（失败点在 `src/mcp/mcp-client.ts:115-121` 的 `spawn`）。

**结论**：当前"MCP 效率不高"的判断，实际是"MCP 不可用"。两者解法完全不同，这一点决定了本方案的优先级。

---

## 1. 关键判断

### 1.1 不需要定制 Chromium

CDP（Chrome DevTools Protocol）就是"暴露出来的操作接口"，Electron 32 已完整内置：

| 需求能力 | CDP 命令 |
|---|---|
| 打开页面 | `Page.navigate` |
| 点击 / 输入 | `Input.dispatchMouseEvent` / `Input.insertText` |
| 读 DOM | `DOM.querySelector` / `Runtime.evaluate` |
| 截图 | `Page.captureScreenshot` |
| 网络拦截 | `Network.enable` + `Fetch` |

定制内核意味着 fork 约 3500 万行 C++、每 6 周跟一次 Chromium 大版本、自出安全补丁、失去 Electron 预编译与签名链路，**换来的能力为 0**。

### 1.2 "MCP 慢"的真因不是传输层

| 环节 | 量级 | 是否瓶颈 |
|---|---|---|
| MCP stdio JSON-RPC 往返 | 1–5 ms | ❌ |
| puppeteer 元素可交互等待 | 100–500 ms | ✅ |
| MCP Server 独立 Chromium 冷启动 | 1–3 s | ✅ |
| 独立 Chromium 额外内存 | 150–300 MB | ✅ |

**传输只占 1% 不到。** 那 100–500 ms 是 puppeteer 在等元素可见+可点+动画结束——正是它可靠的原因。所以要去掉的是"多一个浏览器进程"，不是"多一层协议"。

### 1.3 为什么选择内嵌（对照 Cursor 的做法）

> Cursor 的具体实现细节未公开，以下为**从产品形态反推的动机**，非源码结论。

| # | 动机 | 权重 |
|---|---|---|
| 1 | 可见性即信任：AI 点网页的过程可审计 | 最高 |
| 2 | 零依赖分发：不让用户装 Node / 配 PATH | 极高 |
| 3 | 资源几乎免费：Chromium 已在安装包内（`win-unpacked` 中运行时约 268 MB） | 高 |
| 4 | 人机接力：登录 / 2FA / 验证码必须用户接手 | 高 |
| 5 | 生命周期可控：App 自己管 view 的创建/销毁/恢复 | 中 |
| 6 | 安全边界可控：独立 partition，可随时掐断 | 中 |
| 7 | 不离开应用：浏览器弹到外部会流失注意力 | 中 |

**本方案的收益应归于上述四项（可见性、零依赖、资源复用、人机接力），而非性能提升。**

### 1.4 MCP 方案对比

| | MCP（puppeteer / chrome-devtools） | 内嵌 CDP |
|---|---|---|
| 兼容层（iframe / 元素等待 / 导航竞态 / 反检测） | ✅ 现成 | ❌ 需自行实现 |
| 进程隔离 | ✅ 浏览器崩不影响 app | ❌ 同进程树内 |
| 登录态持久 | ✅ 独立 user-data-dir | ✅ 独立 partition |
| 可替换性 | ✅ 换 server 不改 harness | ⚠️ 需自己维护 |
| 远程浏览器 | ✅ streamablehttp | ❌ v1 不做 |
| UI 工作量 | ✅ 零 | ⚠️ tab 条 + 拦截层 + 定位 |
| 冷启动 | ❌ 1–3 s | ✅ 复用已有 Chromium |
| 额外内存 | ❌ 150–300 MB | ✅ 约 80–150 MB/view |
| 部署依赖 | ❌ 需 Node/npx（当前失败点） | ✅ 零 |
| 用户可见 / 可接管 | ❌ 架构上给不了 | ✅ 核心价值 |

**取舍本质**：MCP 的缺点能用硬件补（内存、启动），自建 CDP 的缺点只能持续用时间补（兼容层可靠性）。

---

## 2. 技术选型

### 2.1 窗口 API

| API | 结论 |
|---|---|
| `<webview>` 标签 | ❌ Electron 官方明确不推荐，进程模型怪异 |
| `BrowserView` | ❌ Electron 30 起已废弃 |
| **`WebContentsView`** | ✅ 当前 `electron ^32.2.5` 原生支持 |

**不要重构为 `BaseWindow` + 双 view。** 现 `desktop/src/main.ts` 的 `BrowserWindow` 加载聊天页结构保留，叠加 child view 即可。

```ts
const browserView = new WebContentsView({
  webPreferences: {
    partition: 'persist:icecoder-browser', // 必须隔离，避免目标站点 cookie 与 app cookie 混用
    contextIsolation: true,
    nodeIntegration: false,
  },
});
mainWindow.contentView.addChildView(browserView); // 后 add 的在上面
browserView.setBounds({ x: 640, y: 0, width: 640, height: 860 });
```

### 2.2 布局（tab1 聊天 / tab2 浏览器）

v1 采用**左右分栏**而非真正的 tab 切换：浏览器 view 覆盖在右侧区域，聊天区保留在左。理由：

- 用户能**同时**看到 AI 对话和 AI 在页面上做什么（`WebContentsView` 无法与 DOM 混排，只能覆盖）
- 真正的 tab 切换会让"可见性"价值打折

若后续需要 tab 语义，可在 view 隐藏/显示间切换，成本很低。

### 2.3 CDP 桥：跨进程问题（关键约束）

| 事实 | 依据 |
|---|---|
| `webContents.debugger` **只在 Electron 主进程可用** | Electron API |
| Harness / 工具层运行在**独立 Node 子进程** | `desktop/src/server-process.ts:102-106`（`spawn(process.execPath, [entry])` + `ELECTRON_RUN_AS_NODE`） |
| 工具层超时保护存在，但**救不了主进程侧** | `src/tools/tool-executor.ts:199-214` 在 server 子进程内 |

因此必须有桥：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 主进程暴露本地端点（HTTP/WS），工具层调用，主进程执行 `debugger.sendCommand` | 一层转发，不开端口 |
| **B（仅验证用）** | `app.commandLine.appendSwitch('remote-debugging-port', '9222')` + `puppeteer-core connect` | 半天跑通，但 CDP 端口对本机全进程开放且**无鉴权** |

**B 只用于验证假设，不用于分发版本。**

---

## 3. 控制权模型

### 3.1 采用方案（已定）

**默认 AI 独占，一键接管/交还，接管时提示风险，不做暂停。**

| 状态 | AI 可发 CDP | 用户可操作 | 切换方式 |
|---|---|---|---|
| `AI_OWNED`（默认） | ✅ | ❌（拦截层吸收） | 用户点「接管」 |
| `USER_OWNED` | ✅（不阻断） | ✅ | 用户点「交还 AI」 |

**明确不做**（用户已确认）：
- ❌ 控制权租约 / `SWITCHING` 过渡态
- ❌ harness 级暂停机制（当前 harness 只有 `abortSession()`，无 `pause/resume`）
- ❌ 接管时拒绝 AI 的 CDP 命令

接管仅弹一次提示：**「你正在手动操作浏览器，AI 同时操作可能互相干扰。」** 之后由用户自行判断是否让 AI 继续工作。

### 3.2 为什么不做锁

做锁需要解决"在途命令"问题：用户点接管时，AI 可能正有一条 CDP 命令在途，无法取消，只能等它自然结束。这需要一个 `SWITCHING` 过渡态 + CDP 桥层门控，复杂度显著上升。

用户裁定：**代价大于收益，先不做。** 改为提示，把判断权交给用户。

> 若后续实测"互相干扰"确实频繁，再回到租约方案。此处保留决策记录，避免重复讨论。

### 3.3 锁定实现

`WebContentsView` **没有** `setIgnoreMouseEvents`（那是 `BrowserWindow` 的 API，现用于 `desktop/src/ping/overlay.ts:190`）。在嵌入视图模型下，用**透明拦截层**：

```ts
const blocker = new WebContentsView();
mainWindow.contentView.addChildView(blocker);   // 必须后 add，才盖在上层
blocker.setBounds(sameBoundsAsBrowserView);
await blocker.webContents.loadURL(
  'data:text/html,<style>html,body{background:transparent;cursor:not-allowed}</style>'
);
// 键盘单独拦
browserView.webContents.on('before-input-event', (e) => e.preventDefault());
```

**关键点（整个方案成立的原因）**：
> 拦截层**不妨碍 AI**。CDP 的 `Input.dispatchMouseEvent` / `Input.insertText` 直接注入目标渲染进程，**不经过操作系统窗口事件路由**。用户点击被拦截层吸收，AI 注入直达浏览器视图，两者天然不冲突。

代价：多一个 webContents 进程，约 +30–60 MB。

### 3.4 焦点

**CDP 输入不依赖 OS 焦点。** `webContents.debugger.sendCommand()` 直接把消息注入目标渲染进程，不要求窗口在前台。因此只要不主动调用 `browserView.webContents.focus()`，焦点自然留在聊天页（tab1）。

### 3.5 UI 状态提示

| 状态 | 文案 |
|---|---|
| 锁定 | `AI 正在控制 · 点击接管` |
| 接管 | `你正在控制 · 点击交还 AI` |

视口边缘显示状态色带，避免用户"页面在动但点不动却不知为何"。

---

## 4. 页面感知

### 4.1 截图不是主通道（重要澄清）

"截图黑屏 = AI 看不见页面"是误解。CDP 的感知分三层，截图在最底层：

| 层 | 手段 | 特点 | 适用 |
|---|---|---|---|
| **首选** | `Runtime.evaluate` 取 `innerText` / DOM | 精确、KB 级、LLM 天然懂 | 抓数据、找元素、读状态 —— **约 90% 场景** |
| **次选** | `DOM.getDocument` + `Accessibility.getFullAXTree` | 结构化，含可点击性语义 | 定位交互目标 |
| **末选** | `Page.captureScreenshot` | MB 级，只能看大概 | canvas / WebGL、验证码、视觉回归 |

对 LLM 而言**文本 DOM 优于截图**：便宜 10–100 倍、可精确引用、不会看错。黑屏只影响那 10% 的视觉场景。

### 4.2 截图黑屏的修法

根因是**合成器路径**，不是 CDP 故障：

1. **`webContents.capturePage()` 替代 CDP** —— Electron 特有，走合成器，嵌入 view 下比 `Page.captureScreenshot` 稳。**首选**
2. `captureBeyondViewport: true` + 等 `Page.lifecycleEvent` 的 `firstMeaningfulPaint`
3. 强制 `--use-angle=swiftshader`（软件合成，慢但不出黑屏）

同类问题已在 `desktop/src/ping/capture-win.ts` 用 GDI BitBlt 绕过，可参考。

---

## 5. 稳定性

### 5.1 风险评估

| 风险 | 严重度 | 说明 |
|---|---|---|
| **iframe / 跨域 target** | 🔴 高 | `DOM.querySelector` 只作用于主 frame。需 `Target.getTargets` → `Target.attachToTarget({flatten:true})` → 按 `sessionId` 路由。**最易出问题处** |
| **导航后 contextId 失效** | 🔴 高 | SPA 软导航**不触发** `Page.navigate`；需监听 `Page.frameNavigated`，每次 evaluate 前重取 context 或不传 contextId |
| **截图黑屏** | 🟡 中 | 见 §4.2 |
| **debugger 独占** | 🟡 中 | 同一 client 才能 attach；用户按 F12 会抢占 → 需监听 `debugger.on('detach')` 并重连 |
| **renderer 崩溃** | 🟡 中 | 目标页 OOM 后白屏；需 `render-process-gone` 重建 view |
| **多 tab2** | 🟢 低 | 每 view 约 80–150 MB，线性增长（v1 单 view 不涉及） |
| **反检测** | 🟡 中 | CDP 连接暴露 `navigator.webdriver`，需 `Page.addScriptToEvaluateOnNewDocument` 抹除。成功率问题，非稳定性问题 |

### 5.2 稳定性结论

| 场景 | 评价 |
|---|---|
| 自控 / 内部页面 | 接近 puppeteer，且更优（复用 Chromium，省 1–3 s 冷启动与 150–300 MB） |
| 任意第三方站点 | puppeteer 代劳的兼容层（元素等待、iframe、导航竞态、反检测）需自行重写，**初期明显低于 puppeteer** |
| 与 MCP 对比 | **当前无基线**：puppeteer MCP 为 `spawn EINVAL`，尚无可比数据 |

---

## 6. 崩溃防护

### 6.1 先明确：view 死了不会拖垮 app

Electron 多进程架构下，`WebContentsView` 的渲染进程是独立 OS 进程。它崩溃时主进程存活、聊天窗口存活，只有该 view 白屏。**"view 死了 → 整个 app 崩溃"不成立。**

### 6.2 但当前代码无任何崩溃兜底

实测 grep 结果：

| 检查项 | 结果 |
|---|---|
| `desktop/src` 内 `render-process-gone\|child-process-gone\|uncaughtException\|unhandledRejection` | ❌ 0 处 |
| `src` 内 `process.on('uncaughtException'/'unhandledRejection')` | ❌ 0 处 |
| `desktop/src/main.ts` 事件 | 仅 `window-all-closed` / `before-quit` / `activate` |

### 6.3 三种真实崩法

**① 在途 CDP 命令被毁 → unhandledRejection → 进程退出（最可能）**

```
AI 发出 sendCommand('Runtime.evaluate')
       ↓ view 渲染进程崩溃
promise reject: "Target closed" / "Render frame was disposed"
       ↓ 桥未 catch
未处理 rejection
       ↓ Electron 32 = Node 20，默认终止进程
整个 app 退出
```
这是唯一真正能杀死 app 的路径，且无需编码失误，一次崩溃时序对上即可。

**② `debugger.attach` 二次附加 → 同步抛错**

已附加的 target 上 `debugger.attach()` 会**同步抛** "Debugger is already attached"。若重连逻辑未先 `detach()` 就重试，该 throw 发生在 `debugger.on('detach')` 回调内——**事件回调中的同步 throw 无人承接**，直接冒到主进程。

**③ 白屏静默**

无 `render-process-gone` 监听时，崩溃无人知晓。用户看到白面板，AI 继续发命令、继续失败、继续重试，最终以 `circuit_breaker` / `max_rounds` 收场。**不崩，但比崩更糟。**

### 6.4 三层防护（按收益递减）

| 层 | 做法 | 挡住什么 | 收益 |
|---|---|---|---|
| **一、提前判断** | 发命令前检查 `target 存活` / `debugger.isAttached()` / `view.isDestroyed()` | 让程序**不进入**坏路径 | **最大** |
| **二、局部 catch** | CDP 桥内 `try/catch` 包 `sendCommand` / `attach`，降级为"工具出错" | 单次失败不扩散 | 大 |
| **三、进程兜底** | `unhandledRejection` / `uncaughtException` | 最后一道网 | **小，有代价** |

**第一层才是根治，第三层只是安全网。顺序不可反**：只加第三层会变成"每次出错都吞掉、程序不崩但状态已乱"。

### 6.5 必需实现清单

| # | 补什么 | 位置 | 不加会怎样 |
|---|---|---|---|
| 1 | `process.on('unhandledRejection')` + `uncaughtException` | `desktop/src/main.ts` 顶部 | 一次时序错配 → app 消失 |
| 2 | `webContents.on('render-process-gone')` | view 创建处 | 白屏静默，AI 空转 |
| 3 | 所有 `sendCommand` 包 `try/catch` + target 存活检查 | CDP 桥 | 同上 rejection 路径 |
| 4 | `debugger.on('detach')` 内先 detach 再重连 | CDP 桥 | 二次 attach 抛错 |

### 6.6 重要限制：`uncaughtException` 不可用于"继续运行"

Node 官方立场：捕获后进程状态不可信。正确做法是：

```
记录结构化错误 → 让当前 run 失败收敛 → 可选：重启 app
```

**不可吞掉后继续跑。** 否则得到最坏结果：app 不崩了，但 AI 在已错乱的状态里继续干活，比崩溃更难排查。

`unhandledRejection` 相对安全（Promise 相互隔离），可"记录 + 失败当前 run"，不必退出进程。

### 6.7 catch 不住的类型（必须知晓）

| 崩溃类型 | 能否处理 |
|---|---|
| JS 异常 / Promise rejection | ✅ |
| renderer 崩溃（白屏） | ✅ 可感知，但进程已死，只能重建 |
| **主进程 native crash（C++ 层）** | ❌ |
| **主进程 OOM** | ❌ 基本无解 |
| **GPU 驱动崩溃** | ⚠️ 部分可 `--disable-gpu` 规避 |

前两类是主要风险，该策略有效；后三类不在覆盖范围。

### 6.8 崩溃后恢复

不要无脑重建 view——AI 的上下文已失效。正确流程：

1. 监听到 `render-process-gone` → 标记 target 失效
2. 向 AI 注入："浏览器视图已崩溃，之前的状态丢失"
3. 由 AI 决定重开页面还是放弃，**不替它重试**

> 复用 `harness-round-no-tools.ts` 的恢复注入通道。此为状态注入，与 §3.1 砍掉的暂停机制无关。

---

## 7. 实现计划

### 7.1 分阶段

| 阶段 | 内容 | 工作量 | 产出 |
|---|---|---|---|
| **P0** | CDP 桥 + 三个命令（navigate / screenshot / click） | 1 天 | 纯脚本验证：**CDP 输入是否真的不需要 OS 焦点**（方案成败关键） |
| **P1** | `WebContentsView` 定位 + tab 条 + 拦截层 | 2–3 天 | 用户点不动、AI 照常操作 |
| **P2** | 接管/交还 + 状态提示 + 交还时状态失效注入 | 1–2 天 | 人机接力可用 |
| **P3** | 健壮性：崩溃兜底（§6.5 四项）+ iframe + 导航重定向 + 反检测 | 3–5 天 | 第三方站点可用 |

### 7.2 P0 必须验证的假设

| 假设 | 验证方式 | 不成立的后果 |
|---|---|---|
| CDP 输入不依赖 OS 焦点 | 窗口失焦状态下 `Input.insertText` 是否生效 | **方案核心不成立**，需回到独立进程方案 |
| `webContents.capturePage()` 在嵌入 view 下不黑屏 | 连续截 20 次，检查非空白像素 | 需降级 swiftshader |
| `WebContentsView` 在上层拦截下仍接受 CDP 注入 | 拦截层存在时发 click，看目标是否响应 | §3.3 设计需重做 |

### 7.3 明确不做

- ❌ 测试前修复前，先不要以 MCP 作为性能对照基线（`puppeteer` 当前 `spawn EINVAL`，无有效数据）

---

## 8. 验收标准

1. **无需外部依赖**：全新 Windows 机器（无 Node / 无 Chrome）安装后，浏览器功能可用。
2. **可见**：AI 操作时页面渲染在主窗右侧区域，用户实时可见。
3. **锁定有效**：`AI_OWNED` 状态下用户点击不产生任何页面交互。
4. **AI 不受阻**：拦截层存在时，AI 的 CDP 点击/输入仍能到达目标页面。
5. **接管有效**：点击「接管」后用户可自由操作（含输入密码、完成 2FA），并弹出风险提示。
6. **焦点正确**：AI 操作期间键盘输入仍落在聊天输入框（tab1）。
7. **崩溃隔离**：`browserView` 渲染进程被强制 kill 后，主进程存活、聊天窗口可用。
8. **崩溃可感知**：view 崩溃后 AI 收到状态失效注入，不会对已死 target 持续重试。
9. **无进程级静默退出**：模拟在途 CDP 命令 target 销毁，app 不退出并记录结构化错误。
10. **现有测试**：`npm test` 全绿（CDP 代码在独立目录，不破坏现有用例）。

---

## 9. 待确认 / 未验证

| 项 | 状态 |
|---|---|
| Cursor 内部浏览器的具体实现 | **未公开**，§1.3 为产品形态反推，非源码结论 |
| puppeteer MCP `spawn EINVAL` 根因 | **未定位**。失败点在 `src/mcp/mcp-client.ts:115-121`，疑与 Windows `.cmd` + `shell` 标志组合有关 |
| MCP 与内嵌 CDP 的端到端耗时对比 | **无基线**，需待 MCP 修好后实测 |
| `WebContentsView` 在 Electron 32 的透明叠层行为 | **未实测**，§3.3 方案需 P1 阶段验证 |
| 任意第三方站点的实际成功率 | **未知**，取决于兼容层实现完整度 |

---

## 10. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 是否定制 Chromium | **否** | CDP 已内置，定制能力增量 0 |
| 是否继续用 MCP | **保留，但不作为主路径** | 保留远程/隔离场景；主路径改内嵌 |
| tab 语义 | **左右分栏** | `WebContentsView` 只能覆盖不能混排；分栏保住"可见性" |
| 控制权 | **默认锁定 + 一键接管** | 用户裁定；降低"页面在动但点不动"的困惑 |
| 是否做控制权租约 | **否** | 在途命令无法取消，需 `SWITCHING` 过渡态，复杂度大于收益（用户裁定） |
| 是否做 harness 暂停 | **否** | 当前 harness 只有 `abortSession()`，无 pause/resume；改为提示由用户自行处理 |
| `uncaughtException` 是否吞掉继续跑 | **否** | Node 状态不可信，只记录 + 失败当前 run |
| 崩溃后是否自动重建 view | **否** | AI 上下文已失效，注入状态通知后由 AI 决定 |

---

## 附：相关代码位置

| 用途 | 路径 |
|---|---|
| 主窗口创建 / IPC | `desktop/src/main.ts` |
| server 子进程启动 | `desktop/src/server-process.ts:102-106` |
| 透明窗 + 点击穿透参考 | `desktop/src/ping/overlay.ts:190` |
| GDI 截图参考（黑屏同类问题） | `desktop/src/ping/capture-win.ts` |
| MCP 启动失败点 | `src/mcp/mcp-client.ts:115-121` |
| MCP 命令解析（394 行 Node 探测） | `src/mcp/resolve-mcp-command.ts` |
| 工具执行超时 | `src/tools/tool-executor.ts:199-214` |
| 恢复注入通道（崩溃后复用） | `src/harness/harness-round-no-tools.ts` |
| session 中止 | `src/web/chat-ws-runtime.ts:198` |
