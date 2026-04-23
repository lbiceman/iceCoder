# iceCoder

基于 Node.js + TypeScript 的 AI 编程助手，支持 PC 和移动端通过聊天界面与 AI 交互，自动调用工具完成复杂任务。

## 项目概览

iceCoder 是一个 AI 编程助手，核心能力包括：

- **多轮对话**：跨轮次累积的结构化消息历史，AI 能记住完整上下文
- **32+ 内置工具**：文件操作、搜索、Git、Shell 命令、文档解析、网页搜索、系统文件浏览
- **MCP 协议支持**：可连接外部 MCP Server 动态扩展工具能力
- **6 智能体流水线**：需求分析 → 设计 → 任务拆分 → 编码 → 测试 → 验证
- **五层记忆系统**：短期、长期（向量检索）、情景、语义、过程记忆
- **移动端支持**：扫码连接，手机远程操控电脑上的 AI
- **上下文压缩**：自动裁剪 + LLM 摘要，支持超长对话

---

## 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      客户端层                            │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   PC 浏览器   │  │  移动端浏览器  │  │  SSE 客户端   │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │ WebSocket        │ WebSocket         │ SSE     │
└─────────┼─────────────────┼──────────────────┼──────────┘
          │                  │                  │
┌─────────▼──────────────────▼──────────────────▼──────────┐
│                      Web 服务层                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Express + WebSocket Server              │ │
│  ├──────────┬──────────┬───────────┬──────────────────┤ │
│  │ /api/chat│ /api/    │/api/tools │  /api/sessions   │ │
│  │   /ws    │ pipeline │           │  /api/config     │ │
│  └────┬─────┴────┬─────┴─────┬─────┴──────────────────┘ │
└───────┼──────────┼───────────┼───────────────────────────┘
        │          │           │
┌───────▼──────────▼───────────▼───────────────────────────┐
│                      核心引擎层                           │
│  ┌──────────────────────┐  ┌──────────────────────────┐  │
│  │   Harness 循环引擎    │  │   Orchestrator 编排器    │  │
│  │  (聊天对话核心循环)    │  │  (6 智能体流水线)        │  │
│  └──────────┬───────────┘  └──────────┬───────────────┘  │
└─────────────┼──────────────────────────┼─────────────────┘
              │                          │
┌─────────────▼──────────────────────────▼─────────────────┐
│                      能力层                               │
│  ┌────────────┐ ┌────────────┐ ┌────────────────────────┐│
│  │  工具系统   │ │  LLM 适配  │ │      记忆系统          ││
│  │ 32+ 工具   │ │ OpenAI     │ │ 短期/长期/情景/语义/过程││
│  │ + MCP 扩展 │ │ Anthropic  │ │ + 文件记忆             ││
│  │ + 验证器   │ │            │ │                        ││
│  └────────────┘ └────────────┘ └────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```


---

## 核心流程

### 1. 聊天对话流程（Harness 循环）

这是用户日常使用的主要路径：

```
用户发送消息（PC / 移动端）
        │
        ▼
┌─────────────────────────────┐
│  WebSocket 接收消息          │
│  加载 session 消息缓存       │
│  (跨轮次累积的完整历史)       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Harness.run() 启动核心循环  │
│  追加用户消息到历史           │
└──────────────┬──────────────┘
               │
     ┌─────────▼─────────┐
     │   while (true)     │◄──────────────────────┐
     └─────────┬─────────┘                        │
               │                                  │
     ┌─────────▼─────────┐                        │
     │ ① 预处理            │                        │
     │  · 工具结果预算裁剪  │                        │
     │  · 上下文压缩检查    │                        │
     └─────────┬─────────┘                        │
               │                                  │
     ┌─────────▼─────────┐                        │
     │ ② 调用 LLM         │                        │
     │  · 消息规范化       │                        │
     │  · 网络错误重试(3次) │                        │
     └─────────┬─────────┘                        │
               │                                  │
        ┌──────▼──────┐                           │
        │ 有工具调用？  │                           │
        └──┬───────┬──┘                           │
        是 │       │ 否                            │
           │       │                               │
     ┌─────▼────┐  │  ┌────────────────────┐      │
     │③ 执行工具 │  ├─►│ max-output 恢复？   │──是──┘
     │ · 并行安全 │  │  └────────┬───────────┘
     │   的并行   │  │           │ 否
     │ · 其余串行 │  │  ┌────────▼───────────┐
     └─────┬────┘  │  │ 停止钩子要求继续？   │──是──┘
           │       │  └────────┬───────────┘
     ┌─────▼────┐  │           │ 否
     │④ 注入记忆 │  │  ┌────────▼───────────┐
     │ (仅首轮)  │  │  │ Token 预算有剩余？  │──是──┘
     └─────┬────┘  │  └────────┬───────────┘
           │       │           │ 否
           └───────┘  ┌────────▼───────────┐
                      │ ⑤ 返回最终回复      │
                      │  · 合并记忆         │
                      │  · 缓存消息历史     │
                      │  · 推送到 WebSocket │
                      └────────────────────┘
```


### 2. 开发流水线流程（Orchestrator 编排）

用户上传需求文档后，通过 `/pipeline` 命令触发 6 阶段自动化开发：

```
上传需求文档 (PPT/XMind/DOCX/HTML)
        │
        ▼
┌─────────────────────────────┐
│  FileParser 解析文档          │
│  (策略模式：HTML/Office/XMind)│
└──────────────┬──────────────┘
               │
  ┌────────────▼────────────┐
  │  Stage 1: 需求分析       │ ← RequirementAnalysisAgent
  │  提取功能模块和业务规则   │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Stage 2: 系统设计       │ ← DesignAgent
  │  架构设计、接口定义       │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Stage 3: 任务拆分       │ ← TaskGenerationAgent
  │  拆解为可执行的开发任务   │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Stage 4: 代码实现       │ ← CodeWritingAgent
  │  根据任务编写代码         │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Stage 5: 测试           │ ← TestingAgent
  │  编写并执行测试用例       │
  └────────────┬────────────┘
               │
  ┌────────────▼────────────┐
  │  Stage 6: 需求验证       │ ← RequirementVerificationAgent
  │  对照原始需求逐项验证     │
  └────────────┬────────────┘
               │
               ▼
        生成最终报告
  (每个阶段的报告 + 总结)
```

每个阶段：
- 失败自动重试（最多 2 次，指数退避）
- 通过 SSE 实时推送进度到前端
- 输出链接为下一阶段的输入


### 3. 记忆系统流转

```
用户消息
  │
  ├──► 短期记忆 (ShortTermMemory)
  │      容量: 100 条, TTL: 5 分钟
  │         │
  │         │ consolidate() 合并
  │         ▼
  │    长期记忆 (LongTermMemory)
  │      LanceDB 向量存储
  │      语义相似度检索
  │
  ├──► 情景记忆 (EpisodicMemory)
  │      记录工具调用事件
  │      时间戳 + 参与者 + 结果
  │
  ├──► 语义记忆 (SemanticMemory)
  │      知识图谱三元组
  │      工具使用模式
  │
  └──► 过程记忆 (ProceduralMemory)
         技能熟练度追踪
         工具执行成功率

         ┌──────────────────┐
         │  后台衰减调度器    │
         │  每 5 分钟执行     │
         │  decay() 指数衰减  │
         │  0.95/0.90/0.80   │
         └──────────────────┘

文件记忆 (FileMemoryManager)
  │
  ├── data/memory-files/*.md
  ├── 多级加载 (项目/用户/目录/团队)
  ├── 异步预取 + 相关性排序
  └── 对话自动提取
```

---

## 目录结构

```
src/
├── index.ts                    # 入口：启动序列（11 步）
├── core/                       # 核心编排
│   ├── orchestrator.ts         # 编排器（6 阶段流水线）
│   ├── base-agent.ts           # 智能体基类
│   ├── types.ts                # 核心类型
│   └── pipeline-state.ts       # 流水线状态管理
├── agents/                     # 6 个专业智能体
│   ├── requirement-analysis.ts
│   ├── design.ts
│   ├── task-generation.ts
│   ├── code-writing.ts
│   ├── testing.ts
│   └── requirement-verification.ts
├── harness/                    # 对话循环引擎
│   ├── harness.ts              # 核心循环（while(true) 状态机）
│   ├── context-assembler.ts    # 提示词组装
│   ├── context-compactor.ts    # 上下文压缩（5 层策略）
│   ├── loop-controller.ts      # 循环控制（轮次/超时/预算）
│   ├── stop-hooks.ts           # 停止钩子
│   ├── token-budget.ts         # Token 预算追踪
│   └── streaming-tool-executor.ts  # 并行工具执行
├── tools/                      # 工具系统
│   ├── index.ts                # 工具注册入口
│   ├── tool-registry.ts        # 工具注册表
│   ├── tool-executor.ts        # 工具执行器（重试+超时+验证）
│   ├── tool-validator.ts       # 输入验证器
│   ├── tool-metadata.ts        # 工具元数据（并行安全/只读/破坏性）
│   └── builtin/                # 32 个内置工具
│       ├── file-tools.ts       # 文件读写删改（7 个）
│       ├── search-tools.ts     # 文件内容/名称搜索（2 个）
│       ├── shell-tool.ts       # Shell 命令执行
│       ├── url-fetch-tool.ts   # HTTP 请求
│       ├── doc-parse-tool.ts   # 文档解析（5 个）
│       ├── pptx-parse-tool.ts  # PPTX 深度解析
│       ├── xmind-parse-tool.ts # XMind 深度解析
│       ├── doc-extract-tool.ts # DOC 格式解析
│       ├── xlsx-parse-tool.ts  # XLSX 深度解析
│       ├── filesystem-browser-tool.ts  # 系统文件浏览器（3 个）
│       ├── fs-operations-tool.ts   # 创建目录/移动/复制（3 个）
│       ├── diff-tool.ts        # 文件差异对比
│       ├── batch-edit-tool.ts  # 批量查找替换
│       ├── read-lines-tool.ts  # 按行范围读取
│       ├── web-search-tool.ts  # 网页搜索
│       ├── git-tool.ts         # Git 操作
│       └── patch-tool.ts       # 应用 diff 补丁
├── mcp/                        # MCP 协议客户端
│   ├── index.ts                # 模块入口
│   ├── mcp-client.ts           # stdio MCP Server 客户端
│   ├── mcp-manager.ts          # 多 Server 生命周期管理
│   └── types.ts                # MCP 协议类型定义
├── llm/                        # LLM 适配层
│   ├── llm-adapter.ts          # 统一适配器（提供者注册+切换）
│   ├── openai-adapter.ts       # OpenAI 适配
│   ├── anthropic-adapter.ts    # Anthropic 适配
│   └── types.ts                # 统一消息/响应类型
├── memory/                     # 记忆系统
│   ├── memory-manager.ts       # 统一管理器（5 子模块协调）
│   ├── short-term-memory.ts    # 短期记忆（内存缓存）
│   ├── long-term-memory.ts     # 长期记忆（LanceDB 向量）
│   ├── episodic-memory.ts      # 情景记忆（事件）
│   ├── semantic-memory.ts      # 语义记忆（知识图谱）
│   ├── procedural-memory.ts    # 过程记忆（技能）
│   ├── types.ts                # 记忆类型定义
│   └── file-memory/            # 文件记忆子系统
│       ├── file-memory-manager.ts  # 文件记忆管理器
│       ├── multi-level-memory.ts   # 多级加载
│       ├── memory-extractor.ts     # 对话记忆提取
│       └── index.ts                # 导出入口
├── parser/                     # 文档解析（策略模式）
│   ├── file-parser.ts          # 解析器主体
│   ├── html-strategy.ts        # HTML 解析
│   ├── office-strategy.ts      # Office 文档解析
│   └── xmind-strategy.ts       # XMind 解析
├── web/                        # Web 服务层
│   ├── server.ts               # Express 服务器
│   ├── chat-ws.ts              # 统一 WebSocket 聊天
│   ├── sse.ts                  # SSE 管理器
│   └── routes/                 # API 路由
│       ├── config.ts           # 配置管理
│       ├── pipeline.ts         # 流水线执行
│       ├── tools.ts            # 工具列表/执行
│       ├── sessions.ts         # 会话管理
│       └── remote.ts           # 远程控制（扫码）
├── public/                     # 前端静态文件
│   ├── index.html              # 单页应用
│   ├── css/style.css           # 样式（暗色主题）
│   └── js/
│       ├── main.js             # 配置页逻辑
│       └── chat-page.js        # 聊天页逻辑
└── data/                       # 运行时数据
    ├── config.json             # LLM 提供者 + MCP 服务器配置
    ├── system-prompt.md        # 系统提示词
    ├── sessions/               # 会话历史
    ├── memory-files/           # 文件记忆
    └── memory/                 # 结构化记忆数据库
```


---

## 工具清单

### 内置工具（32 个）

| 分类 | 工具名 | 说明 | 执行方式 |
|------|--------|------|---------|
| 文件 | `read_file` | 读取文件内容 | 可并行 |
| 文件 | `write_file` | 写入/创建文件 | 串行 |
| 文件 | `append_file` | 追加内容 | 串行 |
| 文件 | `edit_file` | 查找替换 | 串行 |
| 文件 | `delete_file` | 删除文件 | 串行 |
| 文件 | `list_directory` | 列出目录 | 可并行 |
| 文件 | `file_info` | 文件详情 | 可并行 |
| 文件 | `read_file_lines` | 按行范围读取，支持负数索引 | 可并行 |
| 文件 | `create_directory` | 递归创建目录 | 串行 |
| 文件 | `move_file` | 移动/重命名文件或目录 | 串行 |
| 文件 | `copy_file` | 复制文件或递归复制目录 | 串行 |
| 编辑 | `batch_edit_file` | 一次调用多处查找替换 | 串行 |
| 编辑 | `diff_files` | 对比两个文件差异（unified diff） | 可并行 |
| 编辑 | `patch_file` | 应用 unified diff 补丁 | 串行 |
| 搜索 | `search_in_files` | 文件内容搜索 | 可并行 |
| 搜索 | `find_files` | 文件名搜索 | 可并行 |
| 解析 | `parse_document` | 通用文档解析 | 可并行 |
| 解析 | `parse_doc` | Word 文档解析 | 可并行 |
| 解析 | `parse_ppt` | PPT 解析 | 可并行 |
| 解析 | `parse_xmind` | XMind 解析 | 可并行 |
| 解析 | `parse_html` | HTML 解析 | 可并行 |
| 解析 | `parse_pptx_deep` | PPTX 逐页深度解析 | 可并行 |
| 解析 | `parse_xmind_deep` | XMind 树形深度解析 | 可并行 |
| 解析 | `parse_doc_deep` | DOC 格式深度解析 | 可并行 |
| 解析 | `parse_xlsx_deep` | XLSX 逐工作表解析 | 可并行 |
| 网络 | `fetch_url` | HTTP 请求（支持 GET/POST 等） | 可并行 |
| 网络 | `web_search` | 网页搜索（DuckDuckGo/SearXNG） | 可并行 |
| Git | `git` | 结构化 Git 操作（status/diff/log/commit 等） | 串行 |
| Shell | `run_command` | 执行 Shell 命令 | 串行 |
| 浏览器 | `list_drives` | 列出磁盘驱动器 | 可并行 |
| 浏览器 | `browse_directory` | 浏览任意目录 | 可并行 |
| 浏览器 | `open_file` | 读取任意文件 | 可并行 |

### MCP 动态工具

通过 MCP 协议连接外部 Server，工具以 `mcp_{server}_{tool}` 格式自动注册。

---

## MCP 配置

iceCoder 内置 MCP Client，可连接任意 MCP Server 扩展工具能力。配置格式兼容 Kiro / Claude Desktop 的 `mcp.json`。

在 `data/config.json` 的 `mcpServers` 字段配置：

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "data/mcp-memory.jsonl"
      },
      "disabled": false,
      "autoApprove": ["create_entities", "search_nodes", "read_graph"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "disabled": false
    },
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "disabled": false
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `command` | 启动命令（npx / uvx / node 等） |
| `args` | 命令参数 |
| `env` | 环境变量 |
| `disabled` | 设为 `true` 禁用该 Server |
| `autoApprove` | 自动批准的工具列表（无需用户确认） |

项目启动时自动连接所有已启用的 MCP Server，发现的工具会注册到工具系统供 LLM 调用。

---

## 快速开始

```bash
# 安装依赖
npm install

# 配置 LLM 提供者（编辑 data/config.json）
# 至少配置一个 OpenAI 兼容的 API Key
```

### 开发模式

```bash
# 启动开发服务器（API + Web + Cloudflare Tunnel）
npm run dev

# 仅启动 API 服务器
npm run dev:api

# CLI 交互式终端对话（+ Web 服务器）
npm run iceCoder:cli
npm run iceCoder:cli -- --port 8080

# 仅启动 Web 服务器
npm run iceCoder:start

# 单次任务
npm run iceCoder:run -- "修复编译错误"

# 查看工具 / MCP 状态
npm run iceCoder:tools
npm run iceCoder:mcp

# 查看/切换配置
npm run iceCoder:config

# 传任意参数给 CLI
npm run iceCoder -- <子命令> [参数]
```

### 生产模式

```bash
# 构建
npm run build

# 启动 Web 服务器
npm start
```

### CLI 命令

安装后通过 `iceCoder` 命令使用，开发时用 `npm run iceCoder` 代替：

```bash
# 交互式终端对话（同时启动 Web 服务器，终端/浏览器/手机三端同步）
iceCoder chat

# 交互式对话，指定端口
iceCoder chat --port 8080

# 纯终端模式（不启动 Web 服务器）
iceCoder chat --no-serve

# 启动 Web 服务器（仅 Web，无终端交互）
iceCoder start
iceCoder start --port 8080

# 单次任务执行（非交互，适合脚本/CI）
iceCoder run "修复 TypeScript 编译错误"
iceCoder run "给所有函数加 JSDoc" --max-rounds 50
iceCoder run "写一个登录 API" --json

# 列出所有可用工具
iceCoder tools
iceCoder tools --json

# 查看 MCP Server 连接状态
iceCoder mcp

# 查看 LLM 提供者配置
iceCoder config

# 切换默认 LLM 提供者
iceCoder config set default <provider-id>

# 显示帮助
iceCoder help
```

### 全局安装

```bash
npm run build
npm link          # 本地全局注册 iceCoder 命令

# 或发布后
npm install -g ice-coder
```

### 终端内置命令

在 `iceCoder chat` 交互模式下：

| 命令 | 说明 |
|------|------|
| `~scan` | 显示 ASCII 二维码，手机扫码连接 |
| `~tools` | 列出可用工具 |
| `~clear` | 清空对话历史 |
| `~quit` | 退出 |

### Web 聊天命令

在浏览器聊天框输入 `~` 查看可用命令：

| 命令 | 说明 |
|------|------|
| `~new` | 新建聊天 |
| `~history` | 显示/隐藏历史记录 |
| `~clear` | 清空当前聊天 |
| `~open` | 打开文件管理器，浏览电脑文件 |
| `~scan` | 手机扫码连接，远程控制 |

访问 `http://localhost:3000` 打开 Web 聊天界面。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ICE_CONFIG_PATH` | `data/config.json` | LLM + MCP 配置文件路径 |
| `ICE_OUTPUT_DIR` | `output` | 流水线输出目录 |
| `ICE_SYSTEM_PROMPT_PATH` | `data/system-prompt.md` | 系统提示词路径 |
| `ICE_SESSIONS_DIR` | `data/sessions` | 会话存储目录 |
| `ICE_MEMORY_DIR` | `data/memory-files` | 文件记忆目录 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js ≥ 18 |
| 语言 | TypeScript |
| Web 框架 | Express |
| 实时通信 | WebSocket (ws) + SSE |
| LLM | OpenAI SDK + Anthropic SDK |
| 向量数据库 | LanceDB |
| 文档解析 | jszip, xml2js, cheerio, officeparser |
| MCP 协议 | 内置 stdio 客户端，兼容 MCP 2024-11-05 规范 |
| 前端 | 原生 HTML/CSS/JS（单页应用） |
