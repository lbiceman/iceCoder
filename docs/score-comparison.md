# 项目 vs Claude Code 模块对比评分

> 以 Claude Code 为 10 分基准，评估本项目各对应模块的完成度。
> 更新时间：2026-04-22（上下文管理优化后）

---

## 一、Harness 层（模型控制层）

| 模块 | CC | 本项目 | 完成度 | 差距分析 | 优化建议 |
|------|:--:|:------:|:------:|----------|----------|
| 核心循环 | 10 | 9 | 90% | CC 有 fallback 模型切换、prompt-too-long 恢复。本项目已有：错误重试、流式工具执行、中断响应、缺失 tool_result 补齐、max-output-tokens 恢复 | 加 fallback 模型切换；加 prompt-too-long 检测和紧急压缩恢复 |
| 上下文压缩 | 10 | 8.5 | 85% | CC 有四层递进（snip→microcompact→collapse→autocompact）。本项目已有五层（snip→microcompact→toolResultTrim→structuralExtract→llmSummarize），token 估算区分中英文 | 加 feature gate 独立控制每层开关；collapse 层（按对话段落折叠而非按消息数切割） |
| 消息规范化 | 10 | 8 | 80% | CC 有 normalizeMessagesForAPI、stripSignatureBlocks、filterOrphanedThinking。本项目已有 normalizeMessages（合并连续 user、去重 tool_use ID、清理空消息） | 加 stripSignatureBlocks（模型切换时剥离 thinking 签名） |
| 上下文组装 | 10 | 8.5 | 85% | CC 有 16+ section、静态/动态分界、prompt cache、模型补偿。本项目已有静态/动态分界+缓存、用户上下文注入、系统上下文注入、工具结果清理提醒 | 加 prompt cache 的 cache_control 标记；加模型特定补偿 |
| 权限系统 | 10 | 5 | 50% | CC 有 plan/supervised/auto 三种模式、yoloClassifier。本项目只有 allow/confirm/deny 规则匹配 | 加 plan 模式；加 auto 模式（基于工具元数据自动判断） |
| 停止钩子 | 10 | 7 | 70% | CC 有 9 种 hook 类型。本项目只有 Stop hook | 扩展 PreToolUse/PostToolUse hook |
| Token 预算 | 10 | 7 | 70% | 基本功能一致 | 加 feature gate；nudge 消息根据剩余比例调整 |
| 流式工具执行 | 10 | 8 | 80% | 已集成到循环，模型输出完毕后并行执行 | 在流式输出阶段就提交已完成的工具调用 |

## 二、提示词系统

| 模块 | CC | 本项目 | 完成度 | 差距分析 | 优化建议 |
|------|:--:|:------:|:------:|----------|----------|
| 系统提示词 | 10 | 7 | 70% | CC 有 16+ section、模型补偿（@MODEL LAUNCH）。本项目有 8 个 section + 静态/动态分界 | 加更多 section（会话指南、MCP 指令等）；加模型特定补偿 |
| 用户上下文注入 | 10 | 7 | 70% | CC 有 CLAUDE.md 多级加载、Git 状态。本项目已支持自定义 userContext + systemContext | 实现 CLAUDE.md 多级加载（项目级+用户级+目录级） |
| 提示词缓存 | 10 | 5 | 50% | CC 有 ephemeral cache_control、section 级 memoize。本项目有静态部分 memoize 但无 API 级缓存标记 | 加 cache_control 标记到 API 请求 |

## 三、记忆系统

| 模块 | CC | 本项目 | 完成度 | 差距分析 | 优化建议 |
|------|:--:|:------:|:------:|----------|----------|
| 文件记忆 | 10 | 7 | 70% | CC 有多级加载、团队同步。本项目有完整的文件记忆（扫描、frontmatter、新鲜度） | 加多级加载；加团队记忆同步 |
| 记忆预取 | 10 | 6 | 60% | CC 有异步预取（using 确保 dispose）。本项目有相关性检索但非异步预取 | 改为异步预取，不阻塞主流程 |
| 结构化记忆 | N/A | 7 | — | 本项目独有设计（五种类型），已整合到 harness | 向量检索接入真实 embedding；情景/语义/程序性记忆加持久化 |
| 记忆提取 | 10 | 0 | 0% | CC 有 extractMemories 服务。本项目完全没有 | 加自动记忆提取（从对话中提取值得记住的信息） |

## 四、工具系统

| 模块 | CC | 本项目 | 完成度 | 差距分析 | 优化建议 |
|------|:--:|:------:|:------:|----------|----------|
| 工具数量 | 10 | 4 | 40% | CC 50+ 工具，本项目约 15 个 | 加 Agent/Task 工具、Web 搜索、Plan 模式工具 |
| 工具注册/执行 | 10 | 7 | 70% | CC 有按需加载（shouldDefer）。本项目有 Registry + Executor + 重试 | 加按需加载（ToolSearch 机制） |
| 工具元数据 | 10 | 7 | 70% | 元数据定义完整，已被 StreamingToolExecutor 使用 | 元数据驱动权限判断（auto 模式） |
| MCP 集成 | 10 | 0 | 0% | 完全没有 | 加 MCP 客户端管理、工具注册、指令注入 |
| Skill/Plugin | 10 | 0 | 0% | 完全没有 | 加 Skill 系统（Markdown 提示词模板 + 按需浮现） |

## 五、多 Agent / 编排

| 模块 | CC | 本项目 | 完成度 | 差距分析 | 优化建议 |
|------|:--:|:------:|:------:|----------|----------|
| 多 Agent 协调 | 10 | 6 | 60% | CC 有 coordinator + swarm + worktree。本项目有 Orchestrator 流水线 | 加动态协调模式 |
| 子任务系统 | 10 | 3 | 30% | CC 有 5 种任务类型。本项目是固定角色 Agent | 加动态子任务创建 |

## 六、应用层

| 模块 | CC | 本项目 | 完成度 | 差距分析 | 优化建议 |
|------|:--:|:------:|:------:|----------|----------|
| UI | 10 | 4 | 40% | CC 有定制 Ink + 200+ 组件。本项目有 Web UI | 增强 Web UI 交互 |
| CLI | 10 | 0 | 0% | 完全没有 | 加基础 CLI 框架 |
| 远程通信 | 10 | 3 | 30% | 本项目有 WebSocket + SSE，无认证 | 加 JWT 认证 |
| 会话管理 | 10 | 2 | 20% | 无持久化 | 加会话持久化和恢复 |
| LLM 适配 | 10 | 6 | 60% | 有双适配器，缺 fallback 和 effort | 加 fallback 和 effort 控制 |

## 七、总览

| 大类 | CC | 本项目 | 完成度 |
|------|:--:|:------:|:------:|
| Harness 核心循环 | 10 | 9 | 90% |
| **上下文管理** | **10** | **8.5** | **85%** |
| 权限与安全 | 10 | 5 | 50% |
| 提示词系统 | 10 | 6.5 | 65% |
| 记忆系统 | 10 | 6.5 | 65% |
| 工具系统 | 10 | 4.5 | 45% |
| 多 Agent 编排 | 10 | 5 | 50% |
| 应用层 | 10 | 3 | 30% |
| **加权总分** | **10** | **6.1** | **61%** |

## 八、优先改进路线（投入产出比排序）

1. **权限系统升级** → 加 plan/auto 模式，5→8 分
2. **MCP 基础集成** → 连接外部 MCP server，0→5 分
3. **Skill 系统** → Markdown 模板 + 按需浮现，0→5 分
4. **提示词缓存** → cache_control 标记，减少 API 成本
5. **记忆提取** → 自动从对话中提取值得记住的信息
6. **工具扩展** → Agent/Task/Web 工具
7. **CLI 框架** → 基础命令行入口
