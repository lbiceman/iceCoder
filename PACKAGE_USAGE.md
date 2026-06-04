# iceCoder 打包与分发使用说明

> 最后更新：2026-06-04  
> 日常开发命令（`dev`、测试、Benchmark、`~` 命令）见 [`docs/使用文档.md`](./docs/使用文档.md)。本文只说明 **`npm pack` 产物如何安装与运行**。

## 简介

iceCoder 可通过 `npm pack` 打成 **`ice-coder-<version>.tgz`**，在**无完整源码树**的环境安装 CLI / 生产服务。包内仅包含编译产物与最小配置模板（见 `package.json` 的 `files` 字段）。

## 前置要求

- **Node.js** >= 18（推荐 **22+**）
- **npm**（仓库脚本以 npm 为准；亦可用 pnpm / yarn 安装依赖）

## 构建安装包（维护者）

在**有源码**的仓库根目录执行：

```bash
npm install
npm run build
```

`build` 依次执行：

1. `tsc` — 输出到 `dist/`
2. `vite build` — 前端静态资源写入 `dist/public/`（生产 Web 用）
3. `npm pack` — 在项目根生成 **`ice-coder-1.0.0.tgz`**（版本号随 `package.json` 的 `version` 变化）

> 打包包体**不包含**用户 `data/config.json`、会话、记忆文件等运行数据。

### 包内文件（`files` 白名单）

| 路径 | 说明 |
|------|------|
| `dist/` | 编译后的 Node 入口、CLI、Harness、Web 服务 |
| `data/config.example.json` | API 配置模板 |
| `data/system-prompt.md` | 系统提示词模板 |
| `package.json` | 依赖与 `bin` |
| `README.md` | 英文简要说明 |

安装后可通过 `npm run iceCoder:config` 或复制模板生成真实配置。

## 安装方式（使用者）

### 方式一：从 tgz 全局安装（推荐 CLI）

```bash
npm install -g ./ice-coder-1.0.0.tgz
iceCoder --help
```

全局命令 **`iceCoder`** 对应 `dist/cli/index.js`（见 `package.json` → `bin`）。

### 方式二：安装到当前项目

```bash
npm install ./ice-coder-1.0.0.tgz
npx iceCoder web
# 或 package.json scripts 中引用 node_modules/.bin/iceCoder
```

### 方式三：解压 tgz 后本地运行（无 npm 全局）

```bash
mkdir iceCoder-dist && cd iceCoder-dist
tar -xzf ../ice-coder-1.0.0.tgz
cd package
npm install --omit=dev
cp data/config.example.json data/config.json
# 编辑 data/config.json 填入 API Key
node dist/index.js
# 或 npx iceCoder web
```

Windows 可用 7-Zip 等工具解压 `.tgz`，进入 `package` 目录后步骤相同。

## 配置

首次使用必须提供 API Key：

```bash
cp data/config.example.json data/config.json
```

编辑 `data/config.json`（支持任意 OpenAI 兼容 API）。**勿**将含密钥的文件提交版本库或外传。

```json
{
  "providers": [
    {
      "id": "default",
      "providerName": "openai",
      "apiUrl": "https://api.example.com/v1",
      "apiKey": "sk-your-api-key-here",
      "modelName": "your-model",
      "parameters": {
        "temperature": 0.5,
        "maxTokens": 8192
      },
      "maxContextTokens": 131072,
      "isDefault": true
    }
  ]
}
```

环境变量（`ICE_DATA_DIR`、`ICE_SUPERVISOR_MODE` 等）见 [`docs/环境变量.md`](./docs/环境变量.md)。

## 运行方式

### 生产模式（已 build 的 `dist/`）

```bash
npm start
# 等价：cross-env NODE_ENV=production node dist/index.js
```

默认提供 API + 内置静态 Web（端口见启动日志，常见为 **1024**）。

### CLI 子命令（`iceCoder` 入口）

与源码仓库中 `npm run iceCoder:*` 对应（打包环境用全局 `iceCoder` 或 `npx iceCoder`）：

| 命令 | 说明 |
|------|------|
| `iceCoder` / `iceCoder start` | 交互式编码会话（CLI） |
| `iceCoder cli` | CLI 子命令模式 |
| `iceCoder web` | 启动 Web 界面 |
| `iceCoder run "<任务>"` | 一次性任务（Harness） |
| `iceCoder tools` | 列出可用工具 |
| `iceCoder mcp` | MCP 服务状态 |
| `iceCoder config` | 查看 / 切换默认模型 |
| `iceCoder help` | 帮助 |

一次性任务示例：

```bash
iceCoder run "修复失败测试并跑通 npm test" --max-rounds 100
```

有源码时亦可：`npx tsx src/cli/index.ts <子命令>`（开发期，无需先 pack）。

## 数据目录

| 环境 | 数据根 | 说明 |
|------|--------|------|
| **生产**（`NODE_ENV=production` 或 `npm start`） | `~/.iceCoder/` | 记忆、会话、checkpoint、上传等 |
| **开发**（源码 `npm run dev`） | 项目内 `./data/` | 仅克隆仓库开发时 |

可用 **`ICE_DATA_DIR`** 覆盖数据根路径。

打包分发时**不要**把使用者的 `data/` 打进 tgz；首次运行会在数据根下自动创建 `memory-files/`、`sessions/` 等子目录。

## 验证安装

**维护者**在打包容器前建议在源码仓执行：

```bash
npm test
# 约 1,867 条 Vitest 用例，详见 docs/使用文档.md
```

**使用者**安装 tgz 后快速自检：

```bash
iceCoder tools
iceCoder config
```

能列出工具且无配置报错即说明 `dist/` 与依赖正常；完整能力需配置有效 API Key 后执行 `iceCoder web` 或 `iceCoder run`。

## 与《使用文档》的分工

| 文档 | 适用场景 |
|------|----------|
| **本文 `PACKAGE_USAGE.md`** | `npm pack`、tgz 安装、生产 `npm start`、全局 `iceCoder` |
| [`docs/使用文档.md`](./docs/使用文档.md) | 克隆仓库开发、`npm run dev`、测试、Benchmark、Web `~` 命令 |
| [`docs/PROJECT-GUIDE.md`](./docs/PROJECT-GUIDE.md) | 架构与模块说明 |

## 注意事项

1. **API Key**：仅保存在使用者本机 `data/config.json` 或 `~/.iceCoder/` 对应配置路径，勿泄露。
2. **包版本**：`package.json` 中 `name` 为 `ice-coder`，`bin` 为 `iceCoder`；tgz 文件名形如 `ice-coder-1.0.0.tgz`。
3. **依赖**：安装 tgz 时会解析 `package.json` 的 `dependencies`；开发依赖（Vitest、Vite 等）不会装入生产安装。
4. **监管档位**：`data/config.json` 可配置 `supervisorMode`（`off` / `adaptive` / `strict`），详见 [`docs/双模机制详解.md`](./docs/双模机制详解.md)。

## 相关链接

- [README.zh-CN.md](./README.zh-CN.md) — 能力概览与 Benchmark
- [docs/使用文档.md](./docs/使用文档.md) — 开发期命令大全
- [docs/环境变量.md](./docs/环境变量.md) — 环境变量说明
