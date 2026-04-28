# iceCoder

基于 Node.js + TypeScript 的 AI 编程助手，支持 PC / 移动端通过聊天界面与 AI 交互，自动调用工具完成复杂任务。

## 核心能力

- **多轮对话** — 跨轮次结构化消息历史
- **32+ 内置工具** — 文件、搜索、Git、Shell、文档解析、网页搜索
- **MCP 协议** — 动态连接外部工具 Server
- **6 智能体流水线** — 需求 → 设计 → 拆分 → 编码 → 测试 → 验证
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
npm run iceCoder              # 启动全部（CLI + Web + Tunnel）
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

---

## 架构

```
客户端（PC/移动端 WebSocket + SSE + CLI）
  → Express + WebSocket Server
    → Harness 循环引擎（对话）/ Orchestrator（6 阶段流水线）
      → 工具系统（32+ 内置 + MCP）+ LLM 适配 + 记忆系统
```

**Harness 循环**：预处理 → LLM → 工具执行 → 记忆注入 → 循环至无工具调用 → 返回回复 + 后台提取记忆。

### 关键设计决策

| 维度 | 方案 |
|------|------|
| 循环引擎 | 自研 Harness，非 LangChain，完全掌控工具执行流程 |
| 工具系统 | 集中注册 + Zod 校验 + 统一执行器 |
| LLM 适配 | 统一接口（OpenAI + Anthropic SDK），可热切换 |
| 记忆持久化 | 零外部 DB，纯文件 + LLM 语义召回 |
| 前端 | 零框架原生 HTML/CSS/JS |
| MCP | stdio 协议，动态加载/卸载 |

---

## 记忆系统

采用 **LLM 驱动 + 文件持久化** 架构，以 `FileMemoryManager` 为唯一管理器。

### 模块

| 模块 | 职责 |
|------|------|
| `memory-recall` | LLM 语义召回，回退关键词 + bigram 匹配，跨轮次去重，置信度/频率加权 |
| `memory-llm-extractor` | LLM 自动提取，结构化去重 + 用户习惯检测，与主代理写入互斥 |
| `memory-dream` | autoDream 整合（合并/修剪/去重/过期清理），ConsolidationLock 文件锁 |
| `memory-age` | 三级衰减（fresh/stale/expired），高置信度衰减更慢 |
| `session-memory` | 会话笔记（10 section），上下文压缩后保持连续性 |
| `memory-concurrency` | sequential 串行 + inProgress 互斥 + trailing run |
| `memory-secret-scanner` | 25 条正则，写入前自动脱敏 |
| `memory-security` | 路径安全（null byte/URL 编码/symlink） |
| `memory-telemetry` | JSONL 日志 + EventEmitter |
| `memory-remote-config` | 运行时动态调参 |
| `multi-level-memory` | 三级加载（项目/用户/目录），user 类型跨项目共享 |

### 数据流

```
用户输入 → 异步预取记忆 → Harness 循环（LLM + 工具 + 记忆注入）→ 返回回复
  → 后台：记忆提取(互斥) + 会话笔记 + autoDream + 遥测
```

### 评分（基于代码通读）

**架构维度**

| 维度 | 分数 | 说明 |
|------|:---:|------|
| 功能完整性 | **9.5** | 15 个模块覆盖完整生命周期：召回（LLM + 两阶段关键词 + bigram）→ 提取（信号词 + 内容特征 + 轮次三级触发）→ 互斥（主代理写入检测 `hasMemoryWritesSince`）→ 会话记忆（10-section 模板 + 写入前格式验证）→ autoDream（过期清理 + 用户习惯分析）→ 话题切换重召回（Jaccard 本地计算）→ 多级存储（user 类型跨项目共享）→ 安全 + 遥测 + 远程配置 + Prompt Caching。在开源 AI 编程助手中功能链条最完整 |
| 工程质量 | **9.0** | 零外部 DB 全文件方案，5 层 JSON 解析回退，并发控制四件套（sequential + inProgress + trailing run + ConsolidationLock），锁实现含 PID 写入 + 死锁检测 + 竞争检测 + mtime 回滚，8 个测试文件 100+ 用例。扣分项：scanMemoryFiles 每次全量 I/O（O(N) 读 frontmatter + preview），无备份机制 |
| 实际效果 | **9.0** | 召回路径设计精细：LLM 语义选择 → 失败回退关键词粗筛（description + filename + contentPreview）→ 精读二次排序 → 置信度/新鲜度/频率加权。提取触发不靠硬编码阈值，用信号词 + 30 条内容特征正则 + 轮次节流三级启发式。话题切换用 Jaccard < 0.15 判定，零 LLM 开销。扣分项：每轮 5 条上限偏保守 |
| 可扩展性 | **7.5** | 三级存储分离 + 过期清理 + 远程动态调参。200 文件硬上限 + 全量扫描是规模天花板，但对个人/小团队项目够用。接入向量检索后可突破 |
| 安全性 | **9.5** | 路径验证链覆盖 7 种攻击向量（null byte / 路径遍历 / URL 编码 / Unicode NFKC / symlink + dangling symlink + ELOOP / 绝对路径 / 反斜杠），25 条高置信度秘密扫描规则（gitleaks 精选，拆分拼接避免源码误报），会话记忆写入前 10-section 格式验证。在同类项目中安全覆盖最全面 |

**架构综合：9.0 / 10**

**用户体验维度**

| 维度 | 权重 | 分数 | 说明 |
|------|:---:|:---:|------|
| 记得住 | 25% | **8.5** | 三级触发（信号词 + 30 条内容特征正则 + 轮次节流），不靠消息长度硬编码。LLM 提取 prompt 含结构化去重指令 + 用户习惯检测 + tags 语义标签。主代理直接写入 + 后台提取互斥不冲突。扣分：短对话可能不触发，无用户确认 |
| 想得起 | 25% | **9.0** | LLM 语义召回 + 两阶段关键词回退（粗筛 15 → 精读 5）+ 中文 bigram 零依赖分词 + 跨轮次 `alreadySurfaced` 去重 + Jaccard 话题切换重召回 + contentPreview 300 字符兜底 + recallCount/lastRecalledAt 元数据追踪。召回路径在开源方案中最完整 |
| 不打扰 | 20% | **8.5** | 全后台异步（fire-and-forget 预取 + sequential 提取），注入用 `<system-reminder>` 标签包裹。会话记忆更新条件精细（token 增长 + 工具调用数 + 自然断点三重判断）。扣分：无记忆面板，注入消息用户可见 |
| 不出错 | 15% | **9.0** | 秘密扫描 + 7 种路径防护 + 会话记忆写入前验证（至少 7/10 section）+ ConsolidationLock 防并发 + Dream 失败自动回滚。扣分：无备份，无加密 |
| 能成长 | 15% | **7.5** | autoDream 四阶段整合（Orient → Gather → Consolidate → Prune）+ 三级衰减（高置信度阈值翻倍）+ 多级存储 + `~export` 导出。扣分：200 文件上限，无向量检索，无导入 |

**用户体验综合：8.6 / 10**

### 与 Claude Code 对比

基于社区逆向的 Claude Code 记忆架构对比：

| 能力 | iceCoder | Claude Code |
|------|:---:|:---:|
| LLM 语义召回 | ✅ | ✅ |
| LLM 自动提取 | ✅ | ✅ |
| autoDream 整合 | ✅ | ✅ |
| LLM 不可用时回退 | ✅ 正则 + bigram | ❌ |
| 记忆衰减 + 置信度 | ✅ 三级衰减 | ❌ |
| 话题切换重召回 | ✅ Jaccard 本地 | ❌ |
| contentPreview 兜底 | ✅ 300 字符 | ❌ |
| 遥测 | ✅ 真实 JSONL | ⚠️ stub |
| 远程配置 | ✅ 文件热加载 | ⚠️ 依赖 GrowthBook |
| 秘密扫描 | ✅ 25 条规则 | ✅ |
| 模块组织 | 单目录 15 模块 | 分散多目录 |

### 已知局限

- 200 文件硬上限 + 全量扫描，无向量检索
- 纯 LLM 召回每次消耗 ~256 output tokens
- 无记忆面板（用户无法查看/编辑/确认记忆）
- 无备份/恢复、无加密存储

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
├── memory/           # 记忆系统
├── parser/           # 文档解析
├── web/              # Express + WebSocket + SSE
├── public/           # 前端
└── data/             # 运行时数据
```

## 技术栈

Node.js ≥ 18 · TypeScript · Express · WebSocket + SSE · OpenAI SDK + Anthropic SDK · jszip + xml2js + cheerio + officeparser · MCP 2024-11-05 · 原生 HTML/CSS/JS
