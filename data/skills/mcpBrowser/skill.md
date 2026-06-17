---
name: MCP控制浏览器
description: 通过 MCP（browsermcp / puppeteer）控制本机 Chrome 完成网页操作，固定流程可固化为同目录的 JS 脚本
createdAt: 2026-06-17T00:00:00.000Z
---

通过 MCP 浏览器服务（本机 Chrome）操控网页；当操作流程固定下来时，把步骤写成 JS 脚本放到同目录以便复用。

## 一次性前置
- 确认 MCP 配置中存在 `browsermcp` 或 `puppeteer`（`D:/work/self/iceCoder/.iceCoder/mcp.json`），并已启用 `disabled: false`。
- `puppeteer` 服务需设置 `PUPPETEER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`，使用本机 Chrome 而非内置 Chromium。

## MCP 工具速查
- `browsermcp_*`：`browser_navigate`、`browser_click`、`browser_type`、`browser_screenshot`、`browser_get_dom`、`browser_evaluate`、`browser_wait_for` 等
- `puppeteer_*`：`puppeteer_navigate`、`puppeteer_click`、`puppeteer_screenshot`、`puppeteer_evaluate` 等
- 截图默认存到 MCP 工作目录；如需指定本地路径，用 `browser_take_screenshot` 或脚本化方案

## 使用流程
1. **明确任务**：访问哪个 URL、要做什么操作、是否需要截图或取 DOM
2. **逐步调用**：用 MCP 工具完成首次探查（导航、点击、输入、等待元素）
3. **判断是否固化**：若同一流程会被重复执行（≥2 次），把它固化成脚本
4. **保存脚本**：在本目录 `D:/work/self/iceCoder/data/skills/mcpBrowser/` 下新建 `xxx.mjs`，命名表意
5. **在 skill 中引用**：在正文「脚本清单」追加一条，标注入参/输出/调用方式
6. **交付后清理**：临时调试脚本（`debug-*`、`probe-*`、`tmp-*`）任务结束必须删除

## 固化脚本规范
- 扩展名 `.mjs`（或 `.cjs`），使用 ESM/CommonJS 与 Node 兼容
- 顶部注释写明：用途、依赖（MCP 工具或库）、入参、输出
- 接收参数通过 `process.argv` 或环境变量，不硬编码敏感值
- 不引入浏览器自动化库 —— 仅做"组合 MCP 工具调用 / 后处理结果"；实际浏览器控制由 MCP 完成
- 失败要打印明确错误并以非 0 退出码返回

## 脚本示例（puppeteer-mcp 截图）
```js
// scripts/screenshot.mjs
// 用法: node screenshot.mjs <url> <outPath>
import { execSync } from 'node:child_process';

const [url, outPath] = process.argv.slice(2);
if (!url || !outPath) {
  console.error('usage: node screenshot.mjs <url> <outPath>');
  process.exit(1);
}

// 通过 MCP puppeteer_take_screenshot 截图（实际由 agent 在 MCP 上下文中调用）
// 此脚本负责参数校验与路径规范化
console.log(JSON.stringify({ url, outPath: outPath.replace(/\\/g, '/') }));
```

## 脚本清单（维护时同步）
- （暂无，按需追加）

## 禁止
- 不擅自修改 `.iceCoder/mcp.json` 启用未授权的服务器
- 不把 `PUPPETEER_EXECUTABLE_PATH` 改成本机 Chrome 之外的路径
- 不在 skill 目录外散落临时脚本
- 不把一次性探查动作固化（仅重复流程才固化）
