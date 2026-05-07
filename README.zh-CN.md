# iceCoder

**面向 AI 编程代理的完整记忆系统** — 附带一个完整的编程助手。

[English](./README.md) | **中文**

大多数 AI 编程助手在会话结束后就忘记一切。iceCoder 不会。它内置了一套 15 模块的 LLM 驱动记忆系统，能自动提取、召回、整合和保护跨会话知识——零外部数据库，纯文件持久化。

> **为什么重要：** Aider 没有持久记忆。Cline 依赖社区构建的 "Memory Bank" hack。即使 Claude Code 的记忆系统（根据 2025 年源码泄露）也采用了更简单的架构。iceCoder 的记忆系统是目前最完整的开源实现。

---

## 记忆系统做了什么

```
会话 1："我喜欢用 Vitest 而不是 Jest"
  → 自动提取为记忆文件，带置信度评分
  → 写入磁盘前自动秘密扫描

会话 2："帮这个模块写测试"
  → LLM 语义召回找到 Vitest 偏好
  → 相关性门控验证：通过 ✓
  → 用 Vitest 生成测试，而不是 Jest
  → 💾 被动确认："已召回：vitest 偏好"

会话 3："帮我部署到生产环境"
  → LLM 召回返回 Vitest 记忆
  → 相关性门控：Layer 1 关键词不匹配 → Layer 2 LLM rescue → 过滤掉
  → 不会注入无关的 Vitest 记忆

后台：autoDream 整合合并重复项，
  修剪陈旧记忆，检测用户习惯模式
```

---

## 记忆系统完整架构

```
用户输入
  → 异步预取记忆（fire-and-forget）
  → Harness 循环
      ├─ onLoopStart: 加载记忆上下文
      ├─ injectMemoryContext: 召回 → 精排 → 相关性门控 → CoN+JSON 注入
      ├─ LLM + 工具执行（循环）
      └─ onLoopEnd: 后台提取 + 会话笔记 + autoDream
  → 返回回复 + 被动确认通知
```

### 记忆生命周期

```
写入路径：
  对话 → 信号词检测 → LLM 提取 → 去重检查 → 秘密扫描 → 写入文件
                                                    ↓
                                            矛盾检测 → 通知用户

读取路径：
  用户消息 → 关键词提取 → LLM/关键词召回 → 精排 → 相关性门控 → 注入上下文
                                                      ↓
                                              Layer 1: 关键词重叠（零成本）
                                              Layer 2: LLM rescue（自动触发）

整合路径：
  会话积累 → autoDream 触发 → Orient → Gather → Consolidate → Prune
                                                ↓
                                        合并重复 / 解决矛盾 / 晋升用户偏好
```

---

## 15 个模块，完整生命周期

| 模块 | 职责 |
|------|------|
| **memory-recall** | LLM 语义召回 + TF-IDF 加权关键词回退，二级召回（粗召回 → LLM 精排），Fact 粒度精排，否定查询展开，时间范围加权，实体匹配，**相关性门控**（两层过滤，自动 LLM rescue） |
| **memory-llm-extractor** | 信号词 + 30 条内容特征正则 + 轮次节流自动提取，与主代理写入互斥，秘密扫描，矛盾检测 |
| **memory-dream** | autoDream 整合：合并/修剪/去重/过期清理，ConsolidationLock 含 PID + 死锁检测 + 回滚，用户候选晋升 |
| **memory-age** | 三级衰减（fresh/stale/expired），高置信度记忆衰减速度减半 |
| **session-memory** | 10-section 会话笔记，写入前格式验证，上下文压缩后注入保持连续性 |
| **memory-concurrency** | `sequential()` 串行包装 + inProgress 互斥 + trailing run 模式 |
| **memory-secret-scanner** | 25 条高置信度规则（源自 gitleaks），写入前自动脱敏 |
| **memory-security** | 路径验证覆盖 7 种攻击向量（null byte / 遍历 / URL 编码 / Unicode NFKC / symlink / 绝对路径 / 反斜杠） |
| **memory-telemetry** | JSONL 日志 + EventEmitter，记录召回/提取/Dream 指标 |
| **memory-remote-config** | 运行时动态调参，配置文件热加载（5 分钟缓存） |
| **multi-level-memory** | 三级加载（项目/用户/目录），user 类型跨项目共享 |
| **harness-memory** | 集成层：被动确认 + 偏好正则 + 话题切换检测 + 主代理写入互斥 + 相关性门控集成 |
| **json-parser** | 4 层 LLM JSON 解析回退（直接解析 → markdown 代码块 → 正则提取 → 修复常见错误） |
| **memory-config** | 所有记忆子系统的集中默认配置 |
| **async-prefetch** | Fire-and-forget 记忆预取 + 缓存 |

---

## 关键设计决策

### 相关性门控（Relevance Gate）

**问题：** 召回的记忆可能与当前对话无关（如解决部署问题时注入了 Vitest 测试配置），干扰 agent 决策。

**方案：** 两层过滤，自动 rescue。

```
召回记忆
  → Layer 1: 关键词重叠检查（零成本）
      ├─ 通过率 ≥ 50% → 直接返回
      └─ 通过率 < 50% → 触发 Layer 2
  → Layer 2: LLM rescue（自动触发）
      └─ 从被过滤的记忆中找回相关的
```

**配置（`data/memory/memory-config.json`）：**
```json
{
  "relevanceGate": {
    "enabled": true,
    "contextWindow": 3,
    "minKeywordOverlap": 1,
    "rescueThreshold": 0.5
  }
}
```

### LLM 召回 + 关键词 bigram 回退

LLM 可用时从 manifest 中语义选择相关记忆。不可用时（限流、超时），回退到两阶段关键词匹配 + 中文 bigram 分词（零依赖，无需词典）。

**二级召回流程：**
1. 粗召回：6x 候选数
2. LLM 精排：从候选中选出最相关的 top-K
3. 相关性门控：过滤与当前对话无关的记忆

**TF-IDF 加权（v5）：** 稀有词权重更高，description/filename 权重 ×2。

### 话题切换重召回

连续用户消息之间 Jaccard 系数 < 0.2 触发重新召回。纯本地计算，零 LLM 开销。

### 写入前秘密扫描

25 条正则规则（源自 gitleaks）在持久化前捕获 API Key、Token 和私钥。规则源码中拆分拼接 key 前缀，避免触发源码扫描工具误报。

### 主代理写入互斥

如果主代理通过 write_file 工具直接写入记忆文件，后台提取跳过该轮对话。`hasMemoryWritesSince` 扫描 assistant 的 tool_use 消息来检测。

### 被动确认

提取后下次回复附带"💾 已记住：..."，让用户知道存了什么。建立信任但不打断流程。

### autoDream 整合

四阶段流程（Orient → Gather → Consolidate → Prune），合并重复、解决矛盾、检测用户习惯模式、将确认的用户偏好从项目级晋升到用户级存储。文件锁保护 + PID 写入 + 死锁检测 + 失败回滚。

### 矛盾检测

LLM 提取时标记 `contradicts` 字段，新记忆不会直接覆盖旧记忆，而是记录矛盾并通知用户确认。

### 会话记忆（Session Memory）

独立于持久化记忆的会话级笔记系统，10 个固定 section，在上下文压缩后仍能保持会话连续性。

**触发条件：**
- Token 增长超过阈值（默认 5000）
- 工具调用次数超过阈值（默认 3）
- 或：上一轮 assistant 没有工具调用（自然对话断点）

---

## 与 Claude Code 记忆系统对比（基于 2025 年源码泄露）

| 能力 | iceCoder | Claude Code |
|------|:--------:|:-----------:|
| LLM 语义召回 | ✅ | ✅ |
| LLM 自动提取 | ✅ | ✅ |
| autoDream 整合 | ✅ | ✅ |
| LLM 不可用时回退 | ✅ TF-IDF + bigram | ❌ |
| 记忆衰减 + 置信度 | ✅ 三级衰减 | ❌ |
| 话题切换重召回 | ✅ Jaccard 本地 | ❌ |
| 相关性门控 | ✅ 两层过滤 + 自动 rescue | ❌ |
| Fact 粒度精排 | ✅ | ❌ |
| 否定查询展开 | ✅ | ❌ |
| 时间范围加权 | ✅ | ❌ |
| contentPreview 兜底 | ✅ 300 字符 | ❌ |
| 遥测 | ✅ 真实 JSONL | ⚠️ stub |
| 远程配置 | ✅ 文件热加载 | ⚠️ 依赖 GrowthBook |
| 秘密扫描 | ✅ 25 条规则 | ✅ |

> 注：此表仅对比记忆子系统的功能点设计。Claude Code 依托 Anthropic 原生 prompt caching、200k 上下文窗口、多代理并行等基础设施优势，整体产品体验不在同一量级。

---

## 不只是记忆：完整的编程助手

iceCoder 同时也是一个完整的 AI 编程助手，支持 CLI、Web 和移动端。

### 核心能力

- **32+ 内置工具** — 文件操作、搜索、Git、Shell、文档解析（PPTX/XMind/XLSX/HTML）、网页搜索
- **MCP 协议** — 动态连接外部工具 Server
- **6 智能体流水线** — 需求 → 设计 → 拆分 → 编码 → 测试 → 验证
- **Harness 循环引擎** — 自研状态机（非 LangChain），含 max-output-tokens 恢复、`<status>` 标记继续、指数退避重试、工具结果预算裁剪、流式/非流式自动回退、**连续失败熔断器**
- **上下文压缩** — 自动裁剪 + LLM 摘要，支持超长对话
- **移动端** — 扫码连接，手机远程操控
- **LLM 适配** — 统一接口（OpenAI + Anthropic SDK），可热切换

### 连续失败熔断器（Circuit Breaker）

当工具连续失败达到阈值时自动停止，避免死循环。

**配置：** `maxConsecutiveFailures`（默认 3）

**行为：** 同一批次工具调用中任一失败 → 计数器递增 → 全部成功 → 计数器归零 → 达到阈值 → 自动停止并提示用户

---

## 快速开始

```bash
npm install
# 编辑 data/config.json，配置至少一个 OpenAI 兼容的 API Key
npm run iceCoder          # 启动全部（CLI + Web + Tunnel）
```

### 常用命令

```bash
npm run iceCoder              # CLI + Web + Tunnel
npm run iceCoder:cli          # 仅 CLI
npm run iceCoder:web          # 仅 Web
npm run iceCoder:run -- "修复编译错误"  # 单次任务
npm run iceCoder:tools        # 查看工具
npm run iceCoder:mcp          # 查看 MCP
npm run iceCoder:config       # 查看配置
npm run dev                   # Vite 前端热更新
npm run build && npm start    # 生产构建
```

### 全局安装

```bash
npm run build && npm link
iceCoder start [--port 8080]  # CLI + Web + Tunnel
iceCoder cli / web            # 仅终端 / 仅 Web
iceCoder run "修复编译错误" [--max-rounds 50] [--json]
iceCoder tools / mcp / config / help
```

### 内置命令（`~` 前缀）

| 命令 | 说明 |
|------|------|
| `~clear` | 清空对话历史 |
| `~open` | 文件管理器（Web） |
| `~scan` | 手机扫码连接 |
| `~telemetry` | 记忆遥测报告 |
| `~export` | 导出记忆文件 |
| `~memory` | 查看/管理/删除记忆文件 |
| `~tools` | 列出工具（终端） |
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

### 动态配置（`data/memory/memory-config.json`）

```json
{
  "extraction": {
    "minTurns": 3,
    "minTokens": 5000,
    "toolCallInterval": 3,
    "turnThrottle": 1
  },
  "dream": {
    "minHours": 6,
    "minSessions": 3,
    "enabled": true
  },
  "recall": {
    "maxResults": 15
  },
  "relevanceGate": {
    "enabled": true,
    "contextWindow": 3,
    "minKeywordOverlap": 1,
    "rescueThreshold": 0.5
  },
  "sessionMemory": {
    "enabled": true,
    "minTokensToInit": 10000,
    "minTokensBetweenUpdate": 5000,
    "toolCallsBetweenUpdates": 3
  }
}
```

配置文件热加载，5 分钟缓存刷新，无需重启。

---

## 架构

```
客户端（PC/移动端 WebSocket + SSE + CLI）
  → Express + WebSocket Server
    → Harness 循环引擎（对话）/ Orchestrator（6 阶段流水线）
      → 工具系统（32+ 内置 + MCP）+ LLM 适配 + 记忆系统
```

### 设计决策

| 维度 | 方案 |
|------|------|
| 循环引擎 | 自研 Harness 状态机，非 LangChain — 完全掌控工具执行流程 |
| 工具系统 | 集中注册 + Zod 校验 + 统一执行器 + 流式并行执行 |
| LLM 适配 | 统一接口（OpenAI + Anthropic SDK），可热切换 Provider |
| 记忆持久化 | 零外部 DB，纯文件 + LLM 语义召回 |
| 前端 | 零框架原生 HTML/CSS/JS |
| MCP | stdio 协议，动态加载/卸载 |

---

## 目录结构

```
src/
├── index.ts          # 入口
├── cli/              # CLI 命令
├── core/             # 编排器 + 智能体基类 + 流水线状态
├── agents/           # 6 个专业智能体
├── harness/          # 对话循环引擎
├── tools/            # 工具注册表 + 32 个内置工具
├── mcp/              # MCP 客户端
├── llm/              # LLM 适配层
├── memory/           # 记忆系统（15 个模块）
├── parser/           # 文档解析
├── web/              # Express + WebSocket + SSE
├── public/           # 前端
└── data/             # 运行时数据
```

---

## 记忆系统文件清单

```
src/memory/file-memory/
├── index.ts                  # 统一导出
├── types.ts                  # 类型定义
├── file-memory-manager.ts    # FileMemoryManager 主类
├── memory-recall.ts          # 召回引擎（LLM + 关键词 + 相关性门控）
├── memory-llm-extractor.ts   # LLM 自动提取
├── memory-dream.ts           # autoDream 整合
├── memory-scanner.ts         # 文件扫描 + frontmatter 解析
├── memory-scanner-cache.ts   # 扫描缓存
├── memory-fact-index.ts      # Fact 粒度索引
├── memory-prompt.ts          # 记忆系统提示词
├── session-memory.ts         # 会话记忆（10-section 笔记）
├── multi-level-memory.ts     # 三级加载
├── memory-config.ts          # 集中默认配置
├── memory-remote-config.ts   # 远程动态配置
├── memory-eviction.ts        # LRU 淘汰
├── memory-age.ts             # 衰减 + 新鲜度
├── memory-security.ts        # 路径安全
├── memory-secret-scanner.ts  # 秘密扫描
├── memory-concurrency.ts     # 并发控制
├── memory-telemetry.ts       # 遥测日志
├── memory-tokenizer.ts       # 中英文分词
├── memory-parser.ts          # Markdown 解析
├── json-parser.ts            # LLM JSON 解析回退
└── async-prefetch.ts         # 异步预取

src/harness/
├── harness.ts                # Harness 循环引擎
├── harness-memory.ts         # 记忆集成层
├── loop-controller.ts        # 循环控制 + 熔断器
└── types.ts                  # 类型定义
```

---

## 已知局限

- 200 文件硬上限 + 全量扫描（每次召回 readdir + stat + readFile），无向量检索
- 纯 LLM 召回每次消耗 ~256 output tokens
- 无备份/恢复、无加密存储
- Dream 整合只读前 50 个文件（每个截断 2000 字符），记忆文件多时覆盖不完整
- `harness-memory.ts` 集成层职责过重（~450 行）
- 记忆模块 15 个文件平铺在单目录，未按功能子目录组织

## 技术栈

Node.js ≥ 18 · TypeScript · Express · WebSocket + SSE · OpenAI SDK + Anthropic SDK · jszip + xml2js + cheerio + officeparser · MCP 2024-11-05 · 原生 HTML/CSS/JS

## License

ISC
