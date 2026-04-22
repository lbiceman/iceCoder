# iceCoder

基于 Node.js + TypeScript 的 AI 编程助手，支持 PC 和移动端通过聊天界面与 AI 交互，自动调用工具完成复杂任务。

## 项目概览

iceCoder 是一个参考 Claude Code 架构设计的智能体系统，核心能力包括：

- **多轮对话**：跨轮次累积的结构化消息历史，AI 能记住完整上下文
- **20+ 内置工具**：文件操作、搜索、Shell 命令、文档解析、系统文件浏览
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
│  │ 20+ 工具   │ │ OpenAI     │ │ 短期/长期/情景/语义/过程││
│  │ + 验证器   │ │ Anthropic  │ │ + 文件记忆             ││
│  └────────────┘ └────────────┘ └────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```


---

## 核心流程

### 1. 聊天对话流程（Harness 循环）

这是用户日常使用的主要路径，参考 Claude Code 的 `queryLoop` 设计：

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
│   └── builtin/                # 20+ 内置工具
│       ├── file-tools.ts       # 文件读写删改
│       ├── search-tools.ts     # 文件内容/名称搜索
│       ├── shell-tool.ts       # Shell 命令执行
│       ├── url-fetch-tool.ts   # HTTP 请求
│       ├── doc-parse-tool.ts   # 文档解析
│       ├── pptx-parse-tool.ts  # PPTX 深度解析
│       ├── xmind-parse-tool.ts # XMind 深度解析
│       ├── doc-extract-tool.ts # DOC 格式解析
│       └── filesystem-browser-tool.ts  # 系统文件浏览器
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
    ├── config.json             # LLM 提供者配置
    ├── system-prompt.md        # 系统提示词
    ├── sessions/               # 会话历史
    ├── memory-files/           # 文件记忆
    └── memory/                 # 结构化记忆数据库
```


---

## 工具清单

| 分类 | 工具名 | 说明 | 执行方式 |
|------|--------|------|---------|
| 文件 | `read_file` | 读取文件内容 | 可并行 |
| 文件 | `write_file` | 写入/创建文件 | 串行 |
| 文件 | `append_file` | 追加内容 | 串行 |
| 文件 | `edit_file` | 查找替换 | 串行 |
| 文件 | `delete_file` | 删除文件 | 串行 |
| 文件 | `list_directory` | 列出目录 | 可并行 |
| 文件 | `file_info` | 文件详情 | 可并行 |
| 搜索 | `search_in_files` | 文件内容搜索 | 可并行 |
| 搜索 | `find_files` | 文件名搜索 | 可并行 |
| 解析 | `parse_document` | 通用文档解析 | 可并行 |
| 解析 | `parse_pptx_deep` | PPTX 逐页解析 | 可并行 |
| 解析 | `parse_xmind_deep` | XMind 树形解析 | 可并行 |
| 解析 | `parse_doc_deep` | DOC 格式解析 | 可并行 |
| 网络 | `fetch_url` | HTTP 请求 | 可并行 |
| Shell | `run_command` | 执行命令 | 串行 |
| 浏览器 | `list_drives` | 列出磁盘驱动器 | 可并行 |
| 浏览器 | `browse_directory` | 浏览任意目录 | 可并行 |
| 浏览器 | `open_file` | 读取任意文件 | 可并行 |

> **可并行**：同一轮多个调用可同时执行，提高速度。**串行**：写操作或有副作用的命令，按顺序逐个执行，避免冲突。

---

## 快速开始

```bash
# 安装依赖
npm install

# 配置 LLM 提供者（编辑 data/config.json）
# 至少配置一个 OpenAI 或 Anthropic 的 API Key

# 启动开发服务器
npm run dev

# 或构建后启动
npm run build
npm start
```

访问 `http://localhost:3000` 打开聊天界面。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `ICE_CONFIG_PATH` | `data/config.json` | LLM 配置文件路径 |
| `ICE_OUTPUT_DIR` | `output` | 流水线输出目录 |
| `ICE_SYSTEM_PROMPT_PATH` | `data/system-prompt.md` | 系统提示词路径 |
| `ICE_SESSIONS_DIR` | `data/sessions` | 会话存储目录 |
| `ICE_MEMORY_DIR` | `data/memory-files` | 文件记忆目录 |

### 聊天命令

在聊天框输入 `~` 查看可用命令：

| 命令 | 说明 |
|------|------|
| `~new` | 新建聊天 |
| `~history` | 显示/隐藏历史记录 |
| `~clear` | 清空当前聊天 |
| `~open` | 打开文件管理器，浏览电脑文件 |
| `~qrCode` | 生成二维码，手机扫码远程控制 |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js ≥ 18 / Bun |
| 语言 | TypeScript |
| Web 框架 | Express |
| 实时通信 | WebSocket (ws) + SSE |
| LLM | OpenAI SDK + Anthropic SDK |
| 向量数据库 | LanceDB |
| 文档解析 | jszip, xml2js, cheerio, officeparser |
| 前端 | 原生 HTML/CSS/JS（单页应用） |
