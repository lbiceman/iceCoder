# iceCoder 短文 — 中文摘要

## 标题

**iceCoder：面向长程工具化编码 Agent 的选择性双模运行时监管器**

## 摘要

在本地仓库上持续运行数十轮工具调用的自主编码 Agent，常出现目标漂移、工具死循环与无验证进展的停滞，而主流产品多优化模型调用与对话体验，对漂移的治理往往隐式且难以配置。本文介绍开源系统 **iceCoder**：一种可自托管、可叠加在现有 Agent 栈之上的**运行时治理层**。其核心包含三项机制：（1）每轮显式**偏离信号**（无进展、工具重复失败、文件循环、目标漂移）；（2）**选择性双模**监管——默认自由执行，仅在关键任务域按风险升级为强制模式，并通过架构公理约束模式切换与纠偏注入；（3）**Checkpoint v2** 在会话压缩或进程重启后从结构化快照恢复，而非仅依赖聊天记录。系统在 L0 策略 / L1 执行模式 / L2 运行时监管三层架构下实现，并以 TaskGraph 作为关键意图下唯一的结构化上下文注入源。在固定模型（minimax-m2.5）、同任务、盲评裁判的受控对比中，两个多文件修复基准上 iceCoder 与 Claude Code 均达到客观验收成功，综合质量分分别为 86 vs 83 与 88 vs 85（百分制 rubric）。实现为 TypeScript/Node.js，含 1165 条单元测试，支持 CLI、Web、WebSocket 与 MCP。

**关键词**：coding agent，runtime supervision，tool-using LLM，checkpoint recovery，software engineering benchmark

## 投稿信息（建议）

| 项 | 建议 |
|----|------|
| arXiv 主分类 | cs.SE |
| 次分类 | cs.AI |
| 篇幅 | 短文 / workshop（5–8 页） |
| 英文全文 | `icecoder-runtime-supervisor-short.tex` |
