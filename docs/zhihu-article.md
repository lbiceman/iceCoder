# Claude Code 的开源平替

> 一个支持 PC + 移动端、自带 32+ 工具、6 智能体流水线的开源 AI 编程助手

---

## 先说说为什么要有这个东西

过去一年我重度使用各种 AI 编程助手，从 GitHub Copilot 到 Cursor，再到 Claude Code。坦白说，Claude Code 是我用过最"智能"的那个——它的记忆系统能记住你是谁、你的偏好、项目上下文，跨会话保持一致性。

但问题是：

- **闭源**：你没法知道它怎么运作的，也不能改
- **只能 CLI**：没有 Web 界面，不能手机操作
- **绑死 Anthropic**：你必须用 Claude 的 API
- **按 token 计费**：高频使用肉疼

所以我想：能不能做一个开源的替代品？

一个月后，**iceCoder** 诞生了。

GitHub 地址：**[github.com/lbiceman/iceCoder](https://github.com/lbiceman/iceCoder)**

如果你觉得有用，欢迎点个 Star ⭐，让更多开发者看到。

---

## 它能做什么？

### 1. 多轮对话 + 工具调用

这不是一个简单的"问答机器"。它背后有一个**循环引擎（Harness）**：收到你的问题 → 调用 LLM → LLM 决定调用工具 → 执行工具 → 结果注入上下文 → 继续对话。

它内置了 **32 个工具**，覆盖日常开发所有场景：

```
📁 文件操作：读、写、编辑、搜索、删除、复制、移动、批量编辑
🔍 搜索：文本搜索、文件搜索、Web 搜索（需联网）
🐙 Git 集成：status、diff、log、add、commit、push、pull...
📄 文档解析：Word、PPT、PDF、Excel、XMind 思维导图、HTML
🌐 网络：curl 式 HTTP 请求
🔧 Shell：执行命令、运行脚本
```

### 2. LLM 无关，随便换模型

iceCoder 的 LLM 层是抽象的，通过适配器模式支持 **OpenAI 兼容接口** 和 **Anthropic**。

这意味着你可以用：
- DeepSeek V4（1M 上下文）
- GPT-4o / GPT-4.1
- Claude Sonnet / Haiku
- 任何兼容 OpenAI 格式的国产模型

而且支持**热切换**——改配置不用重启服务。

### 3. 6 智能体流水线

上传一份需求文档，iceCoder 会用 6 个 Agent 依次处理：

```
需求分析 → 方案设计 → 任务拆解 → 代码编写 → 测试生成 → 需求验证
```

每个阶段失败自动重试，SSE 实时推送进度，适合处理复杂的开发任务。

### 4. 记忆系统（重头戏）

这是 iceCoder 最核心的特性，也是我复刻 Claude Code 架构做得最认真的部分。

先看这张架构图：

```
记忆系统组成
├── 语义召回（LLM 驱动，回退关键词匹配）
├── 自动提取（fork 完整上下文，分析值得记住的内容）
├── autoDream（定期整合、合并、修剪、去重）
├── 会话笔记（10 个 section，跨对话保持连续性）
├── 秘密扫描器（25 条正则，写入前自动脱敏 API Key / Token）
├── 并发控制（串行 + 互斥锁 + trailing run）
├── 遥测系统（JSONL 日志 + 报告面板）
└── 远程配置（运行时调参，无需重启）
```

四种记忆类型：

| 类型 | 用途 | 例子 |
|------|------|------|
| `user` | 你的角色和偏好 | "用户是前端开发者，偏好 Vue + TypeScript" |
| `feedback` | 行为纠正和确认 | "用户不喜欢自动格式化别人的代码" |
| `project` | 项目上下文和截止日期 | "下周五上线，目前后端还在联调" |
| `reference` | 外部资源位置 | "设计稿在 Figma 项目 X 中" |

每次对话，iceCoder 会**异步预取**相关记忆注入上下文，结束对话后**自动提取**新信息写入记忆文件，再用 **autoDream** 定期整合去重。

对了，记忆写入前会经过**秘密扫描器**——25 条高置信度正则，防止 API Key、Token、密码等敏感信息意外写入。

### 5. 手机扫码操控

这个功能我真的很喜欢：

1. 电脑端启动 iceCoder
2. 浏览器打开 Web 界面，显示二维码
3. 手机扫码 → 在手机上继续对话

通勤路上想到一个 bug，掏出手机就能修。**WebSocket + SSE** 双通道实时推送，延迟很低。

### 6. MCP 协议扩展

支持 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/)，可以连接外部 MCP Server 动态扩展工具。

想接数据库？接文件系统？接浏览器自动化？写个 MCP Server 就行。

### 7. 上下文压缩

DeepSeek V4 有 1M 上下文？那也不能随便浪费。

iceCoder 的循环引擎会在长对话中**自动裁剪 + LLM 摘要**，只保留关键信息，有效控制 token 消耗。

---

## 代码质量

项目目前有 **23 个测试文件，319 条测试用例，全部通过**：

```
 Test Files  23 passed (23)
      Tests  319 passed (319)
```

记忆系统、工具系统、LLM 适配器、解析器、Web 服务等核心模块都有覆盖。

---

## 快速体验

```bash
git clone git@github.com:lbiceman/iceCoder.git
cd iceCoder
npm install
# 编辑 data/config.json 配置你的 API Key
npm run iceCoder
```

就这么简单。浏览器打开 `http://localhost:3000` 就能用。

如果想全局安装：

```bash
npm run build && npm link
iceCoder start          # CLI + Web + Tunnel
iceCoder cli            # 仅终端
iceCoder web            # 仅 Web
iceCoder run "改这个bug" # 单次任务
```

---

## 和其他项目的对比

| 特性 | iceCoder | Claude Code | Cursor | Copilot |
|------|----------|-------------|--------|---------|
| 开源 | ✅ MIT | ❌ | ❌ | ❌ |
| LLM 自由切换 | ✅ | ❌（仅 Anthropic） | ✅（需订阅） | ❌（仅 OpenAI） |
| 记忆系统 | ✅ LLM 驱动 | ✅ LLM 驱动 | ❌ | ❌ |
| 移动端 | ✅ 扫码连接 | ❌ | ❌ | ❌ |
| 流水线 Agent | ✅ 6 阶段 | ❌ | ❌ | ❌ |
| MCP 扩展 | ✅ | ✅ | ❌ | ❌ |
| 自部署 | ✅ | ❌ | ❌ | ❌ |
| 价格 | 仅 API 费用 | API + 订阅 | 订阅制 | 订阅制 |

---

## 一些技术实现细节

如果你对实现感兴趣：

1. **记忆系统**参考了 Claude Code 的公开文档，但用文件持久化替代了数据库，用 LLM 做召回和提取。容错、可维护性上做了更多打磨。

2. **工具系统**采用注册表 + 执行器模式，新工具只需要实现一个 `Tool` 接口就能注册进去，MCP 工具也是动态注册到同一个注册表。

3. **循环引擎**处理了各种边界情况：LLM 返回空工具调用、工具执行超时、并发工具执行、错误重试等。

4. **6 个 Agent** 各自有独立的 system prompt，通过编排器协调输出格式，上一个 Agent 的输出作为下一个 Agent 的输入。

---

## 最后

iceCoder 还处于早期阶段，但核心功能已经跑通了。我每天用它来写代码、重构、修 bug，体验不错。

如果你也在找开源的 AI 编程助手，欢迎试试 iceCoder，提 issue、PR 都行。

**[github.com/lbiceman/iceCoder](https://github.com/lbiceman/iceCoder)**

觉得有用的话点个 ⭐，这对我很重要🙏

---

> 作者：李冰
> 项目地址：https://github.com/lbiceman/iceCoder
> 许可证：MIT
