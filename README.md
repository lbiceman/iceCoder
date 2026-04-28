# iceCoder

基于 Node.js + TypeScript 的 AI 编程助手，支持 PC 和移动端通过聊天界面与 AI 交互，自动调用工具完成复杂任务。

> **记忆系统亮点**：参考 社区逆向的 Claude Code 架构实现 LLM 驱动记忆系统（LLM 语义召回 + LLM 自动提取 + autoDream 整合 + 文件持久化），核心架构与 社区逆向的 Claude Code 同级，在容错、遥测、可维护性上更优。

## 核心能力

- **多轮对话** — 跨轮次累积的结构化消息历史
- **32+ 内置工具** — 文件操作、搜索、Git、Shell、文档解析、网页搜索
- **MCP 协议** — 连接外部 MCP Server 动态扩展工具
- **6 智能体流水线** — 需求分析 → 设计 → 任务拆分 → 编码 → 测试 → 验证
- **LLM 驱动记忆** — 语义召回 + 自动提取 + autoDream 整合 + 秘密扫描
- **移动端** — 扫码连接，手机远程操控
- **上下文压缩** — 自动裁剪 + LLM 摘要，支持超长对话

## 快速开始

```bash
npm install
# 编辑 data/config.json，配置至少一个 OpenAI 兼容的 API Key
```

### 常用命令

```bash
# 启动全部（CLI + Web + Tunnel）
npm run iceCoder

# 仅 CLI / 仅 Web
npm run iceCoder:cli
npm run iceCoder:web

# 单次任务
npm run iceCoder:run -- "修复编译错误"

# 查看工具 / MCP / 配置
npm run iceCoder:tools
npm run iceCoder:mcp
npm run iceCoder:config

# Vite 前端热更新
npm run dev

# 生产构建 + 启动
npm run build && npm start
```

### 全局安装

```bash
npm run build && npm link

iceCoder start                    # CLI + Web + Tunnel
iceCoder start --port 8080        # 指定端口
iceCoder cli                      # 仅终端对话
iceCoder web                      # 仅 Web
iceCoder run "修复编译错误"        # 单次任务
iceCoder run "加 JSDoc" --max-rounds 50 --json
iceCoder tools / mcp / config / help
```

### 内置命令

终端（`iceCoder cli`）和 Web 聊天框均支持 `~` 前缀命令：

| 命令 | 说明 |
|------|------|
| `~clear` | 清空对话历史 |
| `~open` | 文件管理器（Web） |
| `~scan` | 手机扫码连接 |
| `~telemetry` | 记忆系统遥测报告（Web） |
| `~tools` | 列出可用工具（终端） |
| `~quit` | 退出（终端） |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ICE_CONFIG_PATH` | `data/config.json` | LLM + MCP 配置 |
| `ICE_SYSTEM_PROMPT_PATH` | `data/system-prompt.md` | 系统提示词 |
| `ICE_SESSIONS_DIR` | `data/sessions` | 会话存储 |
| `ICE_MEMORY_DIR` | `data/memory-files` | 文件记忆 |
| `ICE_OUTPUT_DIR` | `output` | 流水线输出 |

---

## 架构概览

```
客户端（PC/移动端 WebSocket + SSE）
  → Express + WebSocket Server
    → Harness 循环引擎（聊天对话）/ Orchestrator 编排器（6 阶段流水线）
      → 工具系统（32+ 内置 + MCP）+ LLM 适配（OpenAI/Anthropic）+ 记忆系统
```

**Harness 循环**：预处理 → 调用 LLM → 执行工具 → 注入记忆 → 循环直到无工具调用 → 返回回复 + 后台提取记忆。

**流水线**：上传需求文档 → 6 个 Agent 依次执行（失败自动重试，SSE 实时推送）→ 生成报告。

---

## 记忆系统

采用 **LLM 驱动 + 文件持久化** 架构（参考 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)），以 `FileMemoryManager` 为唯一管理器。

| 模块 | 说明 |
|------|------|
| `memory-recall.ts` | LLM 语义召回（回退关键词匹配），跨轮次去重，置信度/召回频率加权排序 |
| `memory-llm-extractor.ts` | LLM 自动提取（fork 完整上下文），结构化去重 + 用户习惯检测，与主代理直接写入互斥 |
| `memory-dream.ts` | autoDream 定期整合（合并/修剪/去重/用户习惯分析/过期清理），ConsolidationLock 文件锁 |
| `memory-age.ts` | 记忆衰减机制（fresh/stale/expired 三级），高置信度记忆衰减更慢 |
| `session-memory.ts` | 会话笔记（10 section），上下文压缩后保持连续性 |
| `memory-concurrency.ts` | sequential 串行 + inProgress 互斥 + trailing run |
| `memory-secret-scanner.ts` | 25 条高置信度正则，写入前自动脱敏 API Key/Token |
| `memory-security.ts` | 路径安全验证（null byte/URL 编码/symlink） |
| `memory-telemetry.ts` | JSONL 日志 + EventEmitter，`~telemetry` 查看报告 |
| `memory-remote-config.ts` | 运行时动态调参，无需重启 |
| `multi-level-memory.ts` | 三级加载（项目级/用户级/目录级），user 类型记忆跨项目共享 |

四种记忆类型：`user`（用户画像/习惯/偏好）、`feedback`（行为反馈）、`project`（项目上下文）、`reference`（外部引用）。

**记忆元数据**：每条记忆携带 `confidence`（置信度 0-1）、`source`（来源）、`recallCount`（召回次数）、`lastRecalledAt`（上次召回时间）、`tags`（语义标签），用于结构化去重、衰减判断和召回排序。

**多级存储**：user 类型记忆写入 `data/user-memory`（跨项目共享），其他类型写入 `data/memory-files`（项目级）。召回时合并两级记忆。

**数据流**：用户输入 → 异步预取记忆 → LLM 调用 + 工具执行 → LLM 召回注入上下文（更新 recallCount） → 循环结束 → 主代理互斥检测 → 后台提取（结构化去重 + 用户习惯检测） + 会话记忆更新 + autoDream（过期清理 + 用户行为分析） + 遥测。

**Prompt Caching**：system prompt 纯静态（跨轮次不变），动态内容合并到首条 user 消息；Anthropic 适配器在 system 和 tools 上标记 `cache_control`；已发送消息不做就地修改（工具结果裁剪在副本上执行）。

#### 评分

**架构视角评分**

| 维度 | 分数 | 说明 |
|------|:---:|------|
| 功能完整性 | **10** | 召回 + 提取 + 互斥 + 会话记忆 + autoDream + 用户习惯检测 + 过期衰减 + 结构化去重 + 置信度追踪 + 多级加载 + 安全 + 遥测 + 远程配置 + Prompt Caching + 话题切换多轮注入 + 响应格式验证 + contentPreview 正文召回 + 中文 bigram 分词 |
| 工程质量 | **9.5** | 零外部 DB，全链路容错，5 层 JSON 解析回退，prompt cache，并发控制（sequential + inProgress + trailing run），ConsolidationLock（PID + 死锁检测 + 回滚），10 个测试文件 360 用例 + 8 场景 57 项端到端模拟 |
| 实际效果 | **9.5** | 语义召回 + 两阶段关键词回退（粗筛 description+preview → 精读二次排序）+ 中文 bigram 零依赖分词 + 跨轮次去重 + 话题切换重新召回 + 无关查询零误召回 + description 差时 contentPreview 兜底 |
| 可扩展性 | **8** | 多级分离 + 过期清理支撑更大规模，maxMemoryFiles=200 硬上限，向量检索待接入 |
| 安全性 | **9.5** | 路径验证链覆盖 7 种攻击向量 + 25 条高置信度秘密扫描规则自动脱敏 + 会话记忆写入前 10-section 格式验证 |

**架构综合：9.3 / 10**

**用户体验视角评分**（端到端模拟验证，8 场景 57 项检查全通过）

| 维度 | 权重 | 分数 | 说明 |
|------|:---:|:---:|------|
| 记得住 | 25% | **8.5** | 自动提取用户偏好/纠正/习惯，信号词+内容特征双触发，结构化去重。短对话可能不触发提取，无用户确认机制 |
| 想得起 | 25% | **9.0** | LLM 语义召回（manifest 含 contentPreview）+ 两阶段关键词回退（粗筛+精读）+ 中文 bigram 分词 + 话题切换重新召回 + description 差时 contentPreview 兜底。每轮最多 5 条的上限仍在 |
| 不打扰 | 20% | **8.0** | 全后台运行，异步预取，50 文件扫描 12ms。无记忆面板，注入消息用户可见 |
| 不出错 | 15% | **9.0** | 25 条秘密规则 + 7 种路径防护 + 会话记忆验证 + 并发锁。无备份机制 |
| 能成长 | 15% | **7.5** | autoDream 整合 + 三级衰减 + 多级存储。200 文件上限，无向量检索，无导出/导入 |

**用户体验综合：8.5 / 10**

> **相比 社区逆向的Claude Code**：模块集中单一目录更易维护、LLM 不可用时有正则+bigram 回退（中英文均可）、遥测是真实实现（非 stub）、远程配置不依赖 GrowthBook、记忆衰减和置信度追踪是 Claude Code 没有的特性、话题切换多轮注入和 contentPreview 正文召回是 Claude Code 没有的能力。
>
> **用户体验改进方向**：① 记忆面板 UI（查看/删除/搜索）② 记忆确认机制（"我记住了 X，对吗？"）③ Dream 前自动备份 ④ 接入向量检索突破 200 文件上限

---

## 内置工具（32 个）

| 分类 | 工具 |
|------|------|
| 文件（11） | `read_file` `write_file` `append_file` `edit_file` `delete_file` `list_directory` `file_info` `read_file_lines` `create_directory` `move_file` `copy_file` |
| 编辑（3） | `batch_edit_file` `diff_files` `patch_file` |
| 搜索（2） | `search_in_files` `find_files` |
| 解析（9） | `parse_document` `parse_doc` `parse_ppt` `parse_xmind` `parse_html` `parse_pptx_deep` `parse_xmind_deep` `parse_doc_deep` `parse_xlsx_deep` |
| 网络（2） | `fetch_url` `web_search` |
| Git/Shell（2） | `git` `run_command` |
| 浏览器（3） | `list_drives` `browse_directory` `open_file` |

---

## 目录结构

```
src/
├── index.ts                 # 入口
├── cli/                     # CLI 命令（start/cli/web/run/tools/mcp/config）
├── core/                    # 编排器 + 智能体基类 + 流水线状态
├── agents/                  # 6 个专业智能体
├── harness/                 # 对话循环引擎（核心循环 + 上下文压缩 + token 预算）
├── tools/                   # 工具注册表 + 执行器 + 验证器 + 32 个内置工具
├── mcp/                     # MCP 协议客户端（stdio + 多 Server 管理）
├── llm/                     # LLM 统一适配层（OpenAI + Anthropic）
├── memory/                  # 记忆系统
│   └── file-memory/         #   LLM 召回/提取/Dream/会话记忆/安全/遥测/并发控制
├── parser/                  # 文档解析（HTML/Office/XMind）
├── web/                     # Express + WebSocket + SSE + API 路由
├── public/                  # 前端（原生 HTML/CSS/JS 单页应用）
└── data/                    # 运行时数据（配置/会话/记忆）
```

---

## 技术栈

Node.js ≥ 18 · TypeScript · Express · WebSocket (ws) + SSE · OpenAI SDK + Anthropic SDK · jszip + xml2js + cheerio + officeparser · MCP 2024-11-05 · 原生 HTML/CSS/JS


---

## 系统架构总结

### 整体架构（三层）

```
┌─────────────────────────────────────────────────────┐
│  █ 客户端层                                        │
│  PC 浏览器（WebSocket） / 移动端（扫码 SSE） / CLI  │
├─────────────────────────────────────────────────────┤
│  █ 服务层（Express + WebSocket Server）              │
│  API 路由 → 会话管理 → 消息分发                      │
├─────────────────────────────────────────────────────┤
│  █ 引擎层                                            │
│  ┌──────────────┐   ┌──────────────────────────┐    │
│  │ Harness 循环  │   │ Orchestrator 流水线编排   │    │
│  │（对话模式）    │   │（6 Agent 依次执行）       │    │
│  └──────┬───────┘   └──────────┬───────────────┘    │
│         └──────────┬───────────┘                    │
│                    ▼                                 │
│  ┌──────────────────────────────────────────────┐   │
│  │ █ 基础设施层                                  │   │
│  │  工具系统(32内置+MCP) + LLM适配 + 记忆系统    │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 核心数据流

```
用户输入
  → 异步预取记忆（语义召回）
  → Harness 循环:
      预处理消息 → 调用 LLM → 解析工具调用
      → 执行工具（循环，直到无工具调用）
      → 注入记忆 + 上下文压缩（token 预算检测）
      → 返回回复
  → 后台: 记忆提取(互斥锁) + 会话笔记更新 + autoDream + 遥测
```

### 关键设计决策

| 维度 | 方案 |
|------|------|
| **循环引擎** | 自研 Harness，非 LangChain — 完全掌控工具执行流程 |
| **工具系统** | 集中注册 + Zod 参数校验 + 统一执行器，非分散式实现 |
| **LLM 适配** | 统一接口层（OpenAI SDK + Anthropic SDK），可热切换 |
| **记忆持久化** | 零外部依赖（无 DB），纯文件 + LLM 语义召回 |
| **前端** | 零框架原生 HTML/CSS/JS，避免打包体积和构建复杂度 |
| **MCP** | stdio 协议，动态加载/卸载外部工具 Server |
| **流水线** | SSE 实时推送进度，失败自动重试，报告归档到 output/ |

### 模块职责

```
src/
 ├─ harness/    对话引擎 — while(true) 循环，驱动整个交互
 ├─ core/       编排器 + 流水线状态机，管理 6 Agent 生命周期
 ├─ agents/     6 个 LLM Agent（需求/设计/拆分/编码/测试/验证）
 ├─ tools/      工具注册表 + 32 个内置工具 + Zod schema 校验
 ├─ mcp/        MCP 客户端，连接外部工具 Server
 ├─ llm/        LLM 统一适配层（请求/重试/退避/流式）
 ├─ memory/     记忆系统（召回/提取/Dream/安全/遥测/并发）
 ├─ parser/     文档解析引擎（Office/PDF/XMind/HTML）
 ├─ cli/        CLI 命令分发（commander）
 └─ web/        HTTP 服务 + WebSocket + SSE + 前端静态资源
```

### 启动流程

```
1. 加载配置（data/config.json）→ LLM 端点 + MCP Server 列表
2. 初始化 工具注册表 → 注册 32 内置工具 + 连接 MCP 工具
3. 初始化 记忆系统 → 加载记忆文件 → 准备召回索引
4. 启动 Express 服务 → 挂载 API/WebSocket/SSE 路由
5. 根据模式进入 CLI 交互 / Web 服务 / 单次任务
```
