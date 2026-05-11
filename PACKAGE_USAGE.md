# iceCoder 使用说明

## 简介

iceCoder 是一个面向本地仓库的 AI 编程助手运行时。它集成了工具调用引擎、长期记忆系统、会话管理、CLI/Web 等多种接口。

## 前置要求

- **Node.js** >= 18
- **pnpm**（推荐）或 npm / yarn

## 安装

### 方式一：从 tgz 包安装

```bash
# 解压
tar -xzf iceCoder.tgz
cd iceCoder

# 安装依赖
pnpm install
```

### 方式二：通过 npm pack（如有源码）

```bash
# 在项目目录执行
npm run build
# 会生成 ice-coder-1.0.0.tgz
```

## 配置

首次使用需要配置 API Key。复制配置模板并编辑：

```bash
cp data/config.example.json data/config.json
# 编辑 data/config.json，填入你的 API Key
```

> ⚠️ `data/config.json` 包含敏感信息（API Key），**不要**提交到版本控制或分发给他人。

配置示例：

```json
{
  "providers": [
    {
      "id": "default",
      "providerName": "openai",
      "apiUrl": "https://api.deepseek.com",
      "apiKey": "sk-your-api-key-here",
      "modelName": "deepseek-chat",
      "parameters": {
        "temperature": 0.7,
        "maxTokens": 8192
      },
      "maxContextTokens": 131072,
      "isDefault": true
    }
  ]
}
```

支持任意 OpenAI 兼容 API（DeepSeek、OpenAI、Claude API 等）。

## 使用方式

### CLI 模式（命令行交互）

```bash
# 启动交互式编码会话
pnpm iceCoder

# 或直接使用 CLI 子命令模式
pnpm iceCoder:cli
```

### Web 模式（浏览器界面）

```bash
# 启动 Web 服务
pnpm iceCoder:web
```

### 工具调用

```bash
# 执行单次工具调用
pnpm iceCoder:tools
```

### MCP 服务

```bash
# 启动 MCP（Model Context Protocol）服务
pnpm iceCoder:mcp
```

### 开发模式

```bash
# 同时启动 API + Web + 内网穿透
pnpm dev
```

## 验证安装

运行测试确认一切正常：

```bash
npm test
```

## 命令行选项

| 命令 | 说明 |
|------|------|
| `pnpm iceCoder` | 启动交互式编码会话 |
| `pnpm iceCoder:cli` | CLI 子命令模式 |
| `pnpm iceCoder:web` | 启动 Web 界面 |
| `pnpm iceCoder:run` | 运行任务 |
| `pnpm iceCoder:tools` | 工具调用模式 |
| `pnpm iceCoder:mcp` | 启动 MCP 服务 |
| `pnpm iceCoder:config` | 配置管理 |

## 注意事项

1. **API Key**：请妥善保管 `data/config.json` 中的 API Key
2. **data/ 目录**：运行数据（记忆文件、上传文件等）存储在 `data/` 目录，打包时已排除
3. **首次运行**：会创建 `data/memory-files/` 等目录，用于存储长期记忆
