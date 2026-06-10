# iceCoder Electron 桌面 GUI 打包方案

> **状态**：待实现  
> **版本**：v1.1  
> **日期**：2026-06-08  
> **执行者**：MiniMax-M3（或后续 Agent）  
> **范围**：用 Electron 将现有 Web UI + Node 后端打包为 Windows / macOS / Linux 安装包，面向**非开发者**用户；含 **IceBean 桌面宠物窗口**（主窗内嵌 ↔ 桌面悬浮互斥切换）

---

## 0. 执行摘要

### 0.1 目标

| 项 | 说明 |
|----|------|
| **用户价值** | 双击安装、双击启动，无需安装 Node.js、无需命令行 |
| **技术路线** | Electron **壳** + 内嵌 **已编译的 iceCoder 后端**（`dist/`）+ 现有 **Vite 静态前端**（`dist/public/`） |
| **不改写** | 不重写 React/Vanilla Web 聊天页；Harness、WebSocket、双模、记忆等逻辑保持原样 |
| **数据目录** | 继续使用 `~/.iceCoder/`（Windows：`%USERPROFILE%\.iceCoder`），与 tgz 全局安装一致 |
| **工作区** | 桌面版需支持「选择项目文件夹」作为 `process.cwd()` / 工具工作区根 |
| **IceBean 宠物** | 主窗口可见时冰豆仅在主窗内；主窗最小化/隐藏/收托盘时冰豆脱离为桌面透明悬浮窗；**任意时刻仅一个可见冰豆** |

### 0.2 非目标（V1 不做）

- 不替换现有 CLI / `npm pack` 分发链路
- 不做应用内自动更新（可留 hook，V2 再接 `electron-updater`）
- 不把 Electron 窗口改成原生 UI（仍加载本地 HTTP + 现有 SPA）
- 不在安装包内捆绑 LLM API Key
- 不支持 macOS App Store 签名（先用 Developer ID / 未签名 dev 包验证）

### 0.3 验收标准（全部满足即完成）

1. **Windows**：`npm run desktop:dist:win` 产出 `iceCoder Setup x.x.x.exe`，全新机器（无 Node）安装后可启动主窗口。
2. **首次启动**：无 API Key 时自动打开 `/#/config` 配置页；保存后可正常聊天。
3. **工作区**：启动时或菜单「打开文件夹…」选定目录后，`run_command` / 读写文件的 cwd 为该目录。
4. **退出**：关闭窗口或托盘「退出」后，子进程 Node 服务被干净终止（无残留 `node.exe`）。
5. **数据持久化**：重启应用后会话、记忆、`config.json` 仍在 `~/.iceCoder/`。
6. **搜索工具**：`search_codebase`（`@vscode/ripgrep`）在打包环境下可用。
7. **现有测试**：`npm test` 仍全部通过（Electron 代码在独立目录，不破坏现有用例）。
8. **IceBean 互斥**：主窗正常显示时仅主窗内冰豆可见；最小化/隐藏/收托盘后仅桌面悬浮冰豆可见；恢复主窗后桌面冰豆消失。**禁止**两者同时可见（见 §11）。
9. **桌面冰豆交互**：悬浮窗可拖动、始终置顶；双击恢复并聚焦主窗口。

---

## 1. 现状与约束

### 1.1 已有能力（可直接复用）

| 模块 | 路径 | 桌面版用法 |
|------|------|------------|
| 生产入口 | `dist/index.js` / `npm start` | 子进程启动目标 |
| Web 静态资源 | `dist/public/`（`vite build`） | Express 同端口托管 |
| API + WS | `src/web/server.ts`、`chat-ws.ts` | 不变 |
| 数据路径 | `src/cli/paths.ts` | 需新增 Electron 检测 |
| 配置引导 | Web Setup Gate + `/#/config` | 不变 |
| 打包流水线 | `npm run build`（tsc + vite + npm pack） | 桌面构建前置步骤 |
| 冰豆 UI | `src/public/js/session-pet.js`、`chat-pet-bridge.js` | 主窗内嵌实例 + 悬浮窗轻量实例，状态经 Main IPC 同步 |

### 1.2 关键约束

1. **ESM**：项目 `"type": "module"`；Electron 主进程建议单独 `tsconfig.desktop.json` 编译为 CommonJS 或 ESM（推荐 **主进程 CJS + `"type":"commonjs"` 子 package**，见 §4）。
2. **原生依赖**：`@vscode/ripgrep` 含平台二进制，**不能**打进 asar 不解压会找不到可执行文件 → `electron-builder` 配置 `asarUnpack`。
3. **端口**：生产默认 **1024**（`src/cli/serve-port.ts`）。桌面版若端口占用，主进程应选空闲端口并通过 `PORT` 传给子进程。
4. **安全**：`BrowserWindow` 使用 `contextIsolation: true`、`nodeIntegration: false`；仅 `preload` 暴露有限 IPC。
5. **Windows 路径**：子进程 `spawn` 时注意 `shell: false`，路径用 `path.join`；工作区含空格需正确 quoting。

### 1.3 相关文档

- [`PACKAGE_USAGE.md`](../../PACKAGE_USAGE.md) — tgz 安装与数据目录
- [`docs/使用文档.md`](../使用文档.md) — Web / CLI 命令
- [`docs/环境变量.md`](../环境变量.md) — `ICE_DATA_DIR` 等

---

## 2. 架构设计

### 2.1 进程模型

```text
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process (desktop/src/main.ts)            │
│  · 选工作区 / spawn Node 子进程 / 托盘 / 菜单           │
│  · Main BrowserWindow → http://127.0.0.1:PORT（完整 SPA）│
│  · PetWindowManager：冰豆 embedded ↔ floating 互斥      │
└───────────┬─────────────────────────────┬───────────────┘
            │ spawn                       │ 创建/隐藏
            ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────┐
│  Node Child (server)      │   │  Pet BrowserWindow      │
│  dist/index.js            │   │  透明、无边框、置顶       │
│  Express + WS + Harness   │   │  仅主窗隐藏/最小化时显示  │
└───────────────────────────┘   └─────────────────────────┘
         ▲
         │ WebSocket / API
         │
┌───────────────────────────┐
│  Main BrowserWindow       │
│  聊天页 #agent-status-bar │  ← embedded 模式：唯一可见冰豆
│  desktop-pet-bridge 上报  │  → IPC 镜像状态到 Pet 窗
└───────────────────────────┘
```

### 2.2 目录结构（新增）

在仓库根目录新增 `desktop/`，与 `src/` 解耦：

```text
desktop/
  package.json              # 桌面专用依赖（electron, electron-builder）
  tsconfig.json             # 编译 main/preload → desktop/dist/
  electron-builder.yml      # 或写在 package.json build 字段
  assets/
    icon.ico                # Windows
    icon.icns               # macOS
    icon.png                # Linux 512×512
    tray-icon.png           # 16×16 或 32×32
  src/
    main.ts                 # Electron 入口
    preload.ts              # contextBridge API
    server-process.ts       # spawn/kill/wait-ready
    port-utils.ts           # getAvailablePort
    paths.ts                # 解析 extraResources 内 server 路径
    menu.ts                 # 应用菜单
    tray.ts                 # 系统托盘（收主窗时触发 floating 模式）
    pet-window-manager.ts   # 冰豆 embedded ↔ floating 状态机（§11）
    pet-window.ts           # 透明悬浮 BrowserWindow 创建与配置
    ipc-channels.ts         # IPC 通道常量
    constants.ts
  pet-renderer/             # 悬浮冰豆专用静态页（打包进 asar）
    pet-floating.html
    pet-floating.js         # SessionPet + IPC 订阅（可复用 session-pet ESM）
  scripts/
    copy-server-artifacts.cjs   # 构建时复制 dist/ + prod node_modules 子集
```

**资源布局（安装后，`process.resourcesPath`）**：

```text
resources/
  app.asar                    # desktop 主进程 + preload
  server/                     # extraResources，不压缩
    dist/                     # iceCoder 编译产物
    node_modules/             # 仅 production dependencies
    data/                     # config.example.json, system-prompt.md, supervisor-config.example.json
    package.json
```

### 2.3 数据流

| 变量 | 设置方 | 值 |
|------|--------|-----|
| `NODE_ENV` | Main | `production` |
| `ICE_ELECTRON` | Main | `1`（新增，供 `paths.ts` 识别） |
| `PORT` | Main | 动态或 1024 |
| `ICE_DATA_DIR` | 默认 | `~/.iceCoder`（用户可通过环境变量覆盖，V1 不做 GUI 设置） |
| 子进程 `cwd` | Main | 用户选定的工作区目录 |

---

## 3. 与现有代码的最小改动

> 以下改动在 **`src/`** 内，行数应控制在 **≤80 行**；执行时逐项落地并跑 `npm test`。

### 3.1 `src/cli/paths.ts` — 识别 Electron 环境

在 `usesUserDataRoot()` 中增加 Electron 分支：

```typescript
/** Electron 打包应用内嵌 server（由主进程设置 ICE_ELECTRON=1） */
export function isElectronRuntime(): boolean {
  return process.env.ICE_ELECTRON === '1';
}

export function usesUserDataRoot(): boolean {
  return isProductionRuntime() || isPackagedCliEntry() || isElectronRuntime();
}
```

可选：在 `isPackagedCliEntry()` 旁增加注释，说明 Electron server 子进程 argv 不含 `node_modules/ice-coder`，必须靠 `ICE_ELECTRON`。

### 3.2 `src/cli/paths.ts` — 包内示例路径

`resolvePackagedDataExamplePath()` 在 Electron 子进程中，`import.meta.url` 指向 `resources/server/dist/cli/paths.js`，相对路径 `../../data/` 仍成立——**验证即可**，若失败则增加：

```typescript
if (process.env.ICE_SERVER_ROOT) {
  return path.join(process.env.ICE_SERVER_ROOT, 'data', filename);
}
```

Main 启动子进程时设置 `ICE_SERVER_ROOT=<resources/server>`。

### 3.3 `src/web/server.ts` — 可选 CORS（仅当需要）

V1 窗口加载同源 `127.0.0.1`，**不必改 CORS**。若未来改 `loadFile` + 自定义协议再处理。

### 3.4 根 `package.json` — 新增脚本（不移动现有 build）

```json
{
  "scripts": {
    "build:desktop:server": "npm run build:server && npm run build:web",
    "desktop:dev": "npm run build:desktop:server && cd desktop && npm run dev",
    "desktop:pack": "npm run build:desktop:server && cd desktop && npm run pack",
    "desktop:dist:win": "npm run build:desktop:server && cd desktop && npm run dist:win",
    "desktop:dist:mac": "npm run build:desktop:server && cd desktop && npm run dist:mac",
    "desktop:dist:linux": "npm run build:desktop:server && cd desktop && npm run dist:linux"
  }
}
```

---

## 4. desktop/ 实现规格

### 4.1 `desktop/package.json`

```json
{
  "name": "icecoder-desktop",
  "version": "1.0.0",
  "private": true,
  "main": "dist/main.js",
  "type": "commonjs",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "predev": "npm run build && node scripts/copy-server-artifacts.cjs",
    "dev": "electron .",
    "prepack": "npm run build && node scripts/copy-server-artifacts.cjs",
    "pack": "electron-builder --dir",
    "dist:win": "electron-builder --win nsis",
    "dist:mac": "electron-builder --mac dmg",
    "dist:linux": "electron-builder --linux AppImage deb"
  },
  "devDependencies": {
    "electron": "^34.0.0",
    "electron-builder": "^25.1.0",
    "typescript": "^6.0.3"
  }
}
```

> Electron 版本选 **34.x LTS 线**；执行时查 npm 最新 stable 并锁定。

### 4.2 `desktop/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "electron"]
  },
  "include": ["src/**/*.ts"]
}
```

### 4.3 `desktop/src/main.ts` — 核心逻辑（伪代码 → 实现时写全）

```typescript
import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'path';
import { startServerProcess, stopServerProcess, waitForServerReady } from './server-process';
import { buildApplicationMenu } from './menu';
import { getAvailablePort } from './port-utils';

let mainWindow: BrowserWindow | null = null;
let serverPort = 0;
let workspaceDir = '';

async function pickWorkspaceDir(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: '选择 iceCoder 工作区（项目文件夹）',
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

async function createWindow() {
  if (!workspaceDir) {
    workspaceDir = (await pickWorkspaceDir()) ?? '';
    if (!workspaceDir) {
      app.quit();
      return;
    }
  }

  serverPort = await getAvailablePort(1024);
  await startServerProcess({ port: serverPort, workspaceDir });
  await waitForServerReady(serverPort, 30_000);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'iceCoder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  buildApplicationMenu(mainWindow, { onOpenFolder: reopenWithNewWorkspace });

  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopServerProcess();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopServerProcess());
```

**持久化工作区（V1 推荐）**：将最近路径写入 `app.getPath('userData')/workspace.json`，下次启动默认使用该路径，菜单提供「更换工作区」。

### 4.4 `desktop/src/server-process.ts`

职责：

1. 解析 server 根：`path.join(process.resourcesPath, 'server')`（开发模式：`path.join(__dirname, '../../server-bundle')`）。
2. 解析 Node 可执行文件：
   - 生产：`process.execPath` 配合 `ELECTRON_RUN_AS_NODE=1` **或** 捆绑 `resources/server/node`（推荐 **`ELECTRON_RUN_AS_NODE`**，零额外体积）。
3. `spawn` 参数示例：

```typescript
import { spawn, ChildProcess } from 'child_process';

let child: ChildProcess | null = null;

export function startServerProcess(opts: { port: number; workspaceDir: string }) {
  const serverRoot = resolveServerRoot();
  const nodeBin = process.execPath;
  const entry = path.join(serverRoot, 'dist', 'index.js');

  child = spawn(nodeBin, [entry], {
    cwd: opts.workspaceDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      ICE_ELECTRON: '1',
      PORT: String(opts.port),
      ICE_SERVER_ROOT: serverRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (d) => console.log('[server]', d.toString()));
  child.stderr?.on('data', (d) => console.error('[server]', d.toString()));
  child.on('exit', (code) => console.log('[server] exit', code));
}

export function stopServerProcess() {
  if (!child) return;
  // Windows: taskkill tree; Unix: SIGTERM → 5s 后 SIGKILL
  killProcessTree(child.pid!);
  child = null;
}
```

4. `waitForServerReady(port, timeout)`：`fetch(http://127.0.0.1:${port}/api/config)` 或 GET `/` 直到 200。

### 4.5 `desktop/src/preload.ts`

V1 最小暴露（后续可扩展「打开外部链接」已由 main 处理）：

```typescript
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('iceCoderDesktop', {
  platform: process.platform,
  versions: { electron: process.versions.electron },
});
```

前端在桌面版需实现 **冰豆显示模式** IPC（§11.4）；可选显示「桌面版」角标。

### 4.6 `desktop/scripts/copy-server-artifacts.cjs`

构建前从仓库根复制：

```javascript
// 伪逻辑
const root = path.join(__dirname, '../..');
const dest = path.join(__dirname, '../server-bundle'); // dev
// 1. rimraf dest
// 2. cp -r root/dist → dest/dist
// 3. cp root/data/config.example.json, system-prompt.md, supervisor-config.example.json → dest/data/
// 4. cp root/package.json → dest/
// 5. cd dest && npm install --omit=dev --ignore-scripts (或从 root node_modules 复制 prod deps)
```

**生产打包**：`electron-builder` 的 `extraResources` 指向 `server-bundle` 目录，安装后为 `resources/server/`。

> **依赖复制策略**：优先在 `copy-server-artifacts.cjs` 内对 `server-bundle` 执行 `npm install --omit=dev`，避免漏掉 `@vscode/ripgrep` 的平台包。

### 4.7 `electron-builder` 配置

`desktop/electron-builder.yml`（或 `package.json` → `"build"`）：

```yaml
appId: com.icecoder.app
productName: iceCoder
directories:
  output: release
  buildResources: assets
files:
  - dist/**/*
  - package.json
extraResources:
  - from: server-bundle
    to: server
    filter:
      - "**/*"
asar: true
asarUnpack:
  - "**/*.node"
  - "**/node_modules/@vscode/ripgrep/**"
win:
  target:
    - nsis
  icon: assets/icon.ico
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  shortcutName: iceCoder
mac:
  target:
    - dmg
  icon: assets/icon.icns
  category: public.app-category.developer-tools
linux:
  target:
    - AppImage
    - deb
  icon: assets/icon.png
  category: Development
```

---

## 5. 分阶段任务清单（执行顺序）

### Phase A — 脚手架（约 0.5 天）

- [ ] **A1** 创建 `desktop/` 目录树与 `package.json`、`tsconfig.json`
- [ ] **A2** 实现 `copy-server-artifacts.cjs`，验证 `server-bundle/dist/index.js` 可独立 `ELECTRON_RUN_AS_NODE=1 node dist/index.js` 启动
- [ ] **A3** 根 `package.json` 增加 `build:desktop:server` 与 `desktop:*` 脚本
- [ ] **A4** 准备 `desktop/assets/` 图标（可暂用占位 PNG，后续替换正式品牌）

### Phase B — 主进程（约 1 天）

- [ ] **B1** 实现 `port-utils.ts`（从 1024 递增探测或 `get-port` 小包）
- [ ] **B2** 实现 `server-process.ts`（spawn / health check / kill tree）
- [ ] **B3** 实现 `main.ts` + `preload.ts`
- [ ] **B4** 工作区选择 + `workspace.json` 持久化
- [ ] **B5** 菜单：打开文件夹、打开数据目录（`shell.openPath(homedir/.iceCoder)`）、开发者工具、退出
- [ ] **B6** 本地验证：`cd desktop && npm run dev` 能打开聊天页

### Phase C — 与 runtime 集成（约 0.5 天）

- [ ] **C1** `paths.ts` 增加 `isElectronRuntime()`（§3.1）
- [ ] **C2** 子进程 env 设置 `ICE_SERVER_ROOT`（§3.2）
- [ ] **C3** 验证 Setup Gate：删 `~/.iceCoder/config.json` 后首次启动进入配置页
- [ ] **C4** 验证 `search_codebase` / ripgrep 在 `server-bundle` 下可用

### Phase D — 安装包（约 1 天）

- [ ] **D1** 配置 `electron-builder`，`npm run pack` 产出未签名目录安装
- [ ] **D2** Windows NSIS：`npm run dist:win`
- [ ] **D3**（可选）macOS dmg / Linux AppImage
- [ ] **D4** 在**无 Node 的干净 VM** 安装 smoke test（打开 → 配置 → 发一条消息 → 退出无残留进程）

### Phase E — 文档与 CI（约 0.5 天）

- [ ] **E1** 更新 [`PACKAGE_USAGE.md`](../../PACKAGE_USAGE.md) 增加「桌面安装包」一节（链接本文）
- [ ] **E2** 更新 [`README.zh-CN.md`](../../README.zh-CN.md) 文档索引
- [ ] **E3**（可选）GitHub Actions `workflow`：tag 触发 `desktop:dist:win` 上传 artifact

### Phase F — IceBean 桌面宠物窗口（约 1–1.5 天，依赖 Phase B）

- [ ] **F1** 实现 `pet-window-manager.ts` 状态机（§11.2）与 `pet-window.ts` 透明窗配置
- [ ] **F2** 新增 `desktop/pet-renderer/pet-floating.html` + 轻量渲染页
- [ ] **F3** Main 监听主窗 `minimize` / `hide` / `close`（收托盘）→ `enterFloatingMode()`；`show` / `restore` / 托盘「显示」→ `enterEmbeddedMode()`
- [ ] **F4** `preload` + `src/public/js/desktop-pet-bridge.js`：主窗上报 pet 状态、响应 embedded 显隐
- [ ] **F5** 悬浮窗：拖动、置顶、单击/双击 IPC；双击 → 恢复主窗（§11.3）
- [ ] **F6** 互斥断言：切换过程先 hide 一侧再 show 另一侧；DevTools 手动测 §11.5 场景表
- [ ] **F7** 持久化悬浮窗位置 `app.getPath('userData')/pet-floating-position.json`

---

## 6. 测试计划

### 6.1 自动化（不引入 Electron 进 Vitest）

| 用例 | 命令 / 方式 |
|------|-------------|
| 原有单测 | `npm test` 全绿 |
| 类型检查 | `npx tsc --noEmit` + `cd desktop && npx tsc --noEmit` |
| Server bundle | 脚本：`node desktop/scripts/smoke-server-bundle.mjs`（可选，GET `/` 200） |

### 6.2 手动场景

| # | 步骤 | 期望 |
|---|------|------|
| M1 | 全新安装，无 `~/.iceCoder` | 自动创建数据目录，Web 显示配置页 |
| M2 | 配置 API Key 后发消息 | 流式回复，冰豆动画正常 |
| M3 | 菜单切换工作区 | 新 cwd 下 `run_command` 生效 |
| M4 | 关闭窗口 | 任务管理器无残留 node |
| M5 | 端口 1024 被占用 | 应用仍能启动（换端口） |
| M6 | `~scan` 二维码 | 手机 remote 页可连（同 LAN） |
| M7 | 长任务刷新 | `runningTurn` / checkpoint 恢复（沿用 Web 保活） |
| M8 | 主窗正常 + 聊天中 | 仅主窗内冰豆可见，无桌面悬浮窗 |
| M9 | 最小化主窗 | 主窗冰豆立即隐藏，桌面出现透明冰豆，表情/token 环与任务同步 |
| M10 | 双击桌面冰豆 | 主窗恢复聚焦，桌面冰豆消失，主窗冰豆重新出现 |
| M11 | 收托盘后任务继续 | Harness 仍跑；桌面冰豆状态随 WS 更新；无「双豆」闪烁 |

---

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| `@vscode/ripgrep` 在 asar 内无法执行 | `asarUnpack` + 复制完整 `node_modules/@vscode/ripgrep` |
| `ELECTRON_RUN_AS_NODE` 行为差异 | 仅用 Node API 跑 Express；不在子进程加载 `electron` 模块 |
| 安装包体积大（~150–250MB） | 可接受；`files` 白名单排除 devDependencies；V2 再 prune |
| MCP 依赖 `npx` / `uvx` | V1 文档声明：MCP 需用户本机已装 Node/Python 工具链；默认 `mcp.json` 仍 disabled |
| Windows SmartScreen 未签名警告 | 发布说明中提示「更多 → 仍要运行」；正式发行需代码签名证书 |
| 子进程 cwd ≠ 数据目录 | 设计如此：数据在 `~/.iceCoder`，代码操作在用户选的工作区 |
| 主窗与悬浮窗各跑一套 SessionPet 状态不同步 | 主窗为**唯一状态源**（仍连 WS）；Main 转发快照到悬浮窗；embedded 模式停更悬浮窗 |
| 切换瞬间双豆可见 | **先 hide 后 show** 顺序 + `PetDisplayMode` 锁；见 §11.2 |
| Windows 透明窗点击穿透 | `setIgnoreMouseEvents` 仅用于非交互区；冰豆 canvas 区域必须可点 |
| macOS 透明窗无阴影 | `hasShadow: false`；Retina 下 `-webkit-app-region` 与 DPR 对齐 |

---

## 8. 后续迭代（V2，本文不阻塞 V1）

- `electron-updater` + GitHub Releases 自动更新
- 安装向导内嵌 API Key 配置（替代纯 Web 配置页）
- 多窗口 / 多工作区
- 自定义协议 `icecoder://open?path=...`
- 代码签名（Windows Authenticode、macOS Notarization）
- 将 `desktop/` 迁入 monorepo workspace（若仓库拆分）

---

## 9. 执行者快速命令参考

```bash
# 1. 安装桌面依赖
cd desktop && npm install

# 2. 编译 server + 前端，启动 Electron 开发
cd ..
npm run desktop:dev

# 3. 打 Windows 安装包
npm run desktop:dist:win
# 产物：desktop/release/iceCoder Setup 1.0.0.exe

# 4. 仅目录打包（调试 installer 前）
cd desktop && npm run pack
```

---

## 10. 完成定义（DoD）检查表

复制到 PR 描述：

```
- [ ] desktop/ 主进程可 dev 启动并加载 Web UI
- [ ] paths.ts Electron 分支 + ICE_ELECTRON 子进程 env
- [ ] copy-server-artifacts 可复现 server-bundle
- [ ] electron-builder win nsis 产物在干净 Windows 可安装运行
- [ ] 工作区选择 + 持久化
- [ ] 退出无残留进程
- [ ] npm test 通过
- [ ] PACKAGE_USAGE / README 索引已更新
- [ ] IceBean embedded ↔ floating 互斥（§11.5 场景表全过）
- [ ] 双击桌面冰豆恢复主窗
```

---

## 11. IceBean 桌面宠物窗口系统

> **硬性约束：任意时刻全局只能有一个可见冰豆。**  
> 禁止「主窗口冰豆可见 + 桌面悬浮冰豆可见」同时存在。

### 11.1 用户可见行为

| 主窗口状态 | 冰豆位置 | 独立宠物窗 |
|------------|----------|------------|
| 正常显示、未最小化 | 主窗口聊天页内（现有 `#agent-status-bar`） | **不存在 / 隐藏** |
| 最小化 | 无（主窗内 DOM 隐藏） | **显示**：透明悬浮于桌面 |
| 隐藏（`hide()`，如 macOS 关闭钮收 Dock） | 同上 | **显示** |
| 关闭到托盘（点 × 不退出应用） | 同上 | **显示** |
| 从上述状态恢复（托盘菜单、双击桌面冰豆、任务栏点回） | 主窗内重新显示 | **立即隐藏/销毁** |

**交互（悬浮模式）**

- **拖动**：在冰豆本体区域按住拖动（保存位置，下次 floating 复用）。
- **始终置顶**：`alwaysOnTop: true`（可设 `level: 'floating'` / Windows `type: 'toolbar'` 按需微调）。
- **单击**：可选 — 显示当前 bubble 文案或短暂放大（V1 至少不崩溃、不穿透到桌面）。
- **双击**：`restoreMainWindow()` → `mainWindow.show()` + `focus()` + `enterEmbeddedMode()`。

### 11.2 状态机（Main 进程 `PetWindowManager`）

```text
                    ┌─────────────────┐
         启动 ────► │    EMBEDDED     │◄──── show / restore / 双击冰豆
                    │ 主窗冰豆可见     │
                    │ 悬浮窗 hidden   │
                    └────────┬────────┘
                             │ minimize / hide / close-to-tray
                             ▼
                    ┌─────────────────┐
                    │   FLOATING      │
                    │ 主窗冰豆 hidden │
                    │ 悬浮窗 visible  │
                    └─────────────────┘
```

**切换顺序（防双豆）**

```typescript
// enterFloatingMode — 必须先藏主窗豆，再显悬浮窗
async function enterFloatingMode() {
  if (mode === 'floating') return;
  await mainWindow.webContents.executeJavaScript(
    'window.__iceDesktopPet?.setEmbeddedVisible(false)'
  );
  await petWindow.show(); // 或 create + show
  mode = 'floating';
}

// enterEmbeddedMode — 必须先藏悬浮窗，再显主窗豆
async function enterEmbeddedMode() {
  if (mode === 'embedded') return;
  petWindow.hide(); // 不 destroy，保留 WebContents 以便下次快显
  await mainWindow.webContents.executeJavaScript(
    'window.__iceDesktopPet?.setEmbeddedVisible(true)'
  );
  mode = 'embedded';
}
```

**主窗事件绑定（`main.ts`）**

| 事件 | 动作 |
|------|------|
| `minimize` | `enterFloatingMode()` |
| `hide` | 若 `!app.isQuitting` → `enterFloatingMode()` |
| `close` | 若收托盘（`e.preventDefault()` + `hide()`）→ `enterFloatingMode()` |
| `show` / `restore` | `enterEmbeddedMode()` |
| `app.before-quit` | 销毁 pet 窗，`mode = 'none'` |

**与托盘联动**：托盘「显示 iceCoder」= `mainWindow.show()` + `enterEmbeddedMode()`；托盘「退出」= 销毁 pet 窗 + 退出应用。

### 11.3 悬浮窗技术规格（`pet-window.ts`）

```typescript
new BrowserWindow({
  width: 160,           // 含 bubble 预留；可随内容 adjust
  height: 200,
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  hasShadow: false,
  alwaysOnTop: true,
  skipTaskbar: true,    // 不在任务栏单独占位
  resizable: false,
  show: false,          // 创建时不 show，避免闪白
  webPreferences: {
    preload: path.join(__dirname, 'pet-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
  },
});
```

- **加载 URL**：开发 `file://${...}/pet-renderer/pet-floating.html`；生产同路径在 asar 内。
- **Windows**：可设 `win.setAlwaysOnTop(true, 'screen-saver')` 或 `'floating'` 测试遮挡行为。
- **位置持久化**：`pet-floating-position.json` `{ "x": number, "y": number }`；默认屏幕右下角偏上。
- **双击检测**：悬浮页 `dblclick` on canvas → IPC `pet:restore-main` → Main 恢复主窗。

### 11.4 状态同步（主窗为唯一真相源）

主窗口聊天页**继续**跑现有 `chat-pet-bridge.js` + WebSocket；悬浮窗**不**单独连 WS（避免双连接、双状态）。

**数据流**

```text
Harness WS 事件
  → chat-pet-bridge（主窗）
  → session-pet.setState / setBubbleText / setTokenUsage …
  → desktop-pet-bridge 序列化快照
  → IPC pet:state-update → Main
  → 若 mode===floating → 转发 pet:state-apply → 悬浮 webContents
  → 悬浮页 SessionPet 应用同一快照
```

**Pet 状态快照（JSON）**

```typescript
interface PetStateSnapshot {
  state: string;           // session-pet 20 种表情 id
  bubbleText: string;
  turnLabel: string;
  tokenUsed: number;
  tokenMax: number;
  tokenOutput: number;
  eyeColor: string;        // supervisorMode 眼色
  supervisorMode: string;
}
```

**新增文件（`src/public/js/`）**

| 文件 | 职责 |
|------|------|
| `desktop-pet-bridge.js` | 仅 `window.iceCoderDesktop` 存在时加载；包装 `Pet.init` 后 hook 各 setter；`setEmbeddedVisible(v)` 控制 `#agent-status-bar` 的 `visibility`/`pointer-events` |
| （修改）`chat-page.js` | 在 `SessionPet.create` 后调用 `DesktopPetBridge.attach(sessionPet)` |

**`setEmbeddedVisible(false)` 实现要点**

```javascript
// 必须彻底不可见，不能只调 setVisible(false)（当前实现仍保留 active 布局）
function setEmbeddedVisible(visible) {
  var bar = document.getElementById('agent-status-bar');
  if (!bar) return;
  bar.classList.toggle('session-pet-indicator--desktop-hidden', !visible);
  bar.setAttribute('aria-hidden', visible ? 'false' : 'true');
}
```

**CSS（`chat.css`）**

```css
.session-pet-indicator.session-pet-indicator--desktop-hidden {
  visibility: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
}
```

**Preload 扩展（`desktop/src/preload.ts`）**

```typescript
contextBridge.exposeInMainWorld('iceCoderDesktop', {
  platform: process.platform,
  onPetDisplayMode(callback) { ipcRenderer.on('pet:display-mode', (_, m) => callback(m)); },
  reportPetState(snapshot: PetStateSnapshot) {
    ipcRenderer.send('pet:state-update', snapshot);
  },
  setEmbeddedVisible(visible: boolean) {
    ipcRenderer.invoke('pet:set-embedded-visible', visible);
  },
});
```

> 注：`setEmbeddedVisible` 也可纯主窗 JS 实现（`executeJavaScript`），preload 暴露给 `desktop-pet-bridge` 调用即可。

**悬浮页 `pet-floating.js`**

- `import` 或 script 加载打包后的 `session-pet.js` 逻辑（V1 可 duplicate 最小 DOM：`session-pet-indicator` + canvas + bubble + turn）。
- `ipcRenderer.on('pet:state-apply', (_, snap) => applySnapshot(snap))`.
- 启动时 IPC `pet:request-snapshot` → Main 向主窗要最新快照再下发。

### 11.5 验收场景表（必须全部通过）

| # | 操作 | 期望 |
|---|------|------|
| P1 | 启动后进聊天页 | 主窗有冰豆；任务管理器/屏幕仅一个冰豆 |
| P2 | 最小化主窗 | ≤300ms 内主窗冰豆不可见；桌面冰豆出现；**无重叠帧** |
| P3 | 恢复主窗 | 桌面冰豆消失；主窗冰豆可见 |
| P4 | 双击桌面冰豆 | 主窗 restore + focus；embedded 模式 |
| P5 | 点 × 收托盘 | 主窗隐藏；桌面冰豆出现；server 子进程仍运行 |
| P6 | 托盘「显示」 | 同 P3/P4 |
| P7 | 悬浮模式下发消息 | 桌面冰豆表情随 thinking/read/happy 变化 |
| P8 | 快速连续 最小化↔恢复 10 次 | 从未出现双豆同屏 |
| P9 | 非 Electron（浏览器 `npm run dev`） | 无 `iceCoderDesktop`；行为与现网一致，无 regression |
| P10 | 退出应用 | 主窗 + 悬浮窗 + server 全部销毁 |

### 11.6 与现有 Web 冰豆的差异

| 项 | Web 浏览器 | Electron 主窗 embedded | Electron 悬浮 floating |
|----|------------|------------------------|-------------------------|
| 拖动范围 | 聊天页 viewport + 输入栏避让 | 同左 | **整屏桌面**（独立 bounds） |
| 位置存储 | `localStorage` `ice-session-pet-position` | 同左 | `pet-floating-position.json` |
| 可见性 | 始终单实例 | 与 floating 互斥 | 与 embedded 互斥 |
| WS / Harness | 直连 | 直连（状态源） | 仅 IPC 镜像 |

### 11.7 实现检查清单（Phase F 细化）

```
desktop/src/pet-window-manager.ts     — 状态机 + 互斥锁
desktop/src/pet-window.ts             — BrowserWindow 工厂
desktop/src/pet-preload.ts            — 悬浮窗 IPC
desktop/pet-renderer/pet-floating.html
desktop/pet-renderer/pet-floating.js
src/public/js/desktop-pet-bridge.js   — 主窗 hook + setEmbeddedVisible
src/public/css/chat.css               — --desktop-hidden 类
src/public/js/chat-page.js            — attach DesktopPetBridge
desktop/src/main.ts                   — 绑定 minimize/hide/close/show
```

**Vitest**：为 `desktop-pet-bridge` 的 snapshot 序列化/反序列化加纯函数单测（不启动 Electron）。

---

**文档结束。** MiniMax-M3 请按 **§5 Phase A → F** 顺序实施；**Phase F 依赖 Phase B 主窗可用**；遇阻塞在 PR 中标注 Phase 编号与日志片段。
