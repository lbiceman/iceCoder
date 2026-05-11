# iceCoder 架构与运行时说明

iceCoder 是面向本地代码仓库的 **工具化 LLM 运行时**：以 Harness 为核心，把提示词系统、工具执行、任务状态、仓库上下文、长期记忆、会话记忆、上下文压缩和评测骨架组合在一起，目标是接近 Claude Code / Codex CLI 等工具在**可靠执行工程任务**上的表现。

**已从代码库移除：** 早期的**多阶段流水线**及按阶段注册的 **Agent** 抽象（如 `BaseAgent`、`executePipeline`、阶段报告生成等）。当前 `Orchestrator` 仅聚合 `FileParser` 与 `LLMAdapter`，供 WebSocket 聊天等入口共享实例。

[English](./README.md) | [后续优化计划](./nextWork.md)

[English](./README.md) | [后续优化计划](./nextWork.md)

---

## 1. 当前状态

当前已经完成 Runtime P0/P1 的核心整改，重点解决“该干活时不干活”“改完不验证”“权限规则不生效”“压缩丢短指令”等问题。

已验证基线：

```bash
npx tsc --noEmit
npm test
npm run eval:agent
```

当前验证结果（请以本机为准）：

- 32 个测试文件通过
- 531 条测试通过

---

## 2. 总体架构

```text
CLI / Web / Remote
  -> loadAssembledChatPrompt()
  -> HarnessConfig
      -> ContextAssembler
      -> LLMAdapter
      -> ToolExecutor
      -> HarnessMemoryIntegration
      -> ContextCompactor
  -> Harness.run()
```

核心模块：

| 模块 | 职责 |
|---|---|
| `src/prompts/*` | 提示词分段、静态 system、动态 overlay、评测/禁工具模式 |
| `src/harness/harness.ts` | 带工具调用的 LLM 主循环、执行、恢复、权限、验证门禁 |
| `src/harness/task-state.ts` | 当前任务状态账本 |
| `src/harness/repo-context.ts` | 仓库上下文账本 |
| `src/harness/context-assembler.ts` | 组装 system prompt 与动态上下文 |
| `src/harness/context-compactor.ts` | 微压缩、硬压缩、恢复提示、文件内容重注入 |
| `src/harness/harness-memory.ts` | 长期记忆召回/注入/提取与会话记忆协作 |
| `src/memory/file-memory/*` | 文件化长期记忆完整生命周期 |
| `src/tools/*` | 工具注册、执行、元数据、权限辅助 |
| `src/llm/*` | OpenAI / Anthropic 兼容适配器 |

---

## 3. Harness 运行流程

Harness 是运行时核心。它负责把“模型想做什么”变成“实际执行了什么”。

```text
初始化消息
初始化 TaskState
初始化 RepoContext
while running:
  maybeCompact()
  注入 Runtime State / Repo Context
  normalizeMessages()
  调用 LLM(messages, tools)

  if toolCalls:
    权限裁决 allow/confirm/deny
    执行工具
    更新 TaskState / RepoContext
    失败恢复与重复失败检测
    注入相关记忆
    continue

  else:
    no-tool recovery
    verification gate
    stop hooks
    final
```

### 3.1 已完成的运行时保障

| 能力 | 状态 |
|---|---|
| 无工具早停兜底 | 执行型任务没调用工具时会自动要求继续执行 |
| 工具调用判定放宽 | 只要 `toolCalls` 非空就执行，不强依赖 `finishReason` |
| 权限规则 | `allow / confirm / deny` 已进入工具执行前置裁决 |
| confirm 缺省安全 | 需要确认但没有 UI 回调时默认拒绝 |
| Task State v1 | 跟踪任务 intent、phase、改动文件、验证状态 |
| Verification Gate v1 | 改过代码但未验证时不能直接完成 |
| RepoContext v1 | 跟踪读过/改过文件、运行命令、测试命令、诊断 |
| 压缩恢复 Runtime Context | 硬压缩后重新注入 `TaskState + RepoContext`，保留目标、改动文件和验证命令 |
| 重复失败检测 | 同工具同参数重复失败时提示换策略 |
| 短指令保护 | 微压缩不会删除“跑测试”“继续”等短执行指令 |
| 会话记忆 force 更新 | 压缩前可强制备份当前会话状态 |

---

## 4. 提示词系统

提示词系统采用静态层和动态层分离。

### 4.1 静态 System Prompt

由 `src/prompts/sections.ts` 定义，经 `PromptAssembler` 拼装。内容包括：

- 身份与工作方式
- action-first 行为
- 执行规则
- 修改规则
- 工具使用原则
- Shell/Git 规范
- 上下文管理提醒

静态层尽量稳定，便于 provider 侧 prompt cache 命中。

### 4.2 动态上下文

由 `ContextAssembler` 注入，包含：

- 工作目录、平台、日期
- 语言设置（仅显式配置时）
- 记忆提示词
- 项目说明
- Runtime State
- Repo Context
- 相关长期记忆

### 4.3 工具禁用模式

`ICE_EVAL_MODE=1` 或 `ICE_DISABLE_TOOLS=1` 时：

- 移除工具相关提示段
- runtime 传入 `tools: []`

这样评测/禁工具模式不会出现“提示词说不能用工具但 runtime 仍提供工具”的不一致。

---

## 5. 工具系统

工具系统位于 `src/tools/`。

核心组件：

| 组件 | 作用 |
|---|---|
| `ToolRegistry` | 注册和导出工具定义 |
| `ToolExecutor` | 执行工具、超时、重试、参数校验 |
| `StreamingToolExecutor` | 多工具执行与输出流转发 |
| `tool-metadata` | 只读、破坏性、并发安全、结果大小等元信息 |
| Harness permissions | 执行前权限裁决 |

主要工具类别：

- 文件读取、写入、编辑、patch
- shell 命令
- git
- 代码搜索
- 文档解析
- Web 搜索/抓取
- 环境信息、diff、撤销编辑

---

## 6. Task State 与 Repo Context

### 6.1 Task State

`TaskState` 是当前任务的结构化账本，记录：

```json
{
  "goal": "修复失败测试",
  "intent": "debug",
  "phase": "verification",
  "filesRead": ["src/a.ts"],
  "filesChanged": ["src/a.ts"],
  "commandsRun": ["npm test"],
  "verificationRequired": true,
  "verificationStatus": "passed"
}
```

作用：

- 判断是否需要验证
- 阻止“改完直接说完成”
- 为压缩恢复提供结构化状态

### 6.2 Repo Context

`RepoContext` 是仓库上下文账本，记录：

- 读过的文件
- 改过的文件
- 运行过的命令
- 测试命令
- 最近诊断/错误

一旦有有效状态，Harness 会在下一轮 LLM 前注入：

```text
[System Runtime State]
# Runtime State
...
# Repo Context
...
[/System Runtime State]
```

这样模型不必从长历史里重新推断当前任务状态。

---

## 7. 记忆系统

iceCoder 的长期记忆是文件化的，不依赖外部数据库。

### 7.1 记忆类型

| 类型 | 用途 |
|---|---|
| `user` | 用户角色、目标、明确偏好 |
| `feedback` | 用户纠正或行为反馈 |
| `project` | 项目事实、约定、目标 |
| `reference` | 外部系统、链接、文档引用 |

### 7.2 记忆生命周期

```text
对话
  -> 触发提取
  -> LLM 提取
  -> 密钥扫描
  -> 去重 / 冲突检测
  -> 写入 memory-files
  -> 后续召回
  -> 相关性门控
  -> CoN + JSON 注入
  -> Dream 整合
  -> 衰减 / 淘汰
```

### 7.3 召回流程

```text
用户查询
  -> 扫描记忆文件
  -> 置信度过滤
  -> FactIndex 构建/缓存
  -> 候选足够时 LLM recall
  -> 候选不足时 keyword fallback
  -> 关联扩展
  -> relevance gate
  -> 执行型任务门控
  -> token 预算过滤
  -> 注入结构化 JSON 记忆
```

### 7.4 已收紧的策略

- 召回从“宽泛相关”改为“严格相关”。
- 编码/调试/编辑任务优先注入项目事实和技术约束。
- 用户偏好只有强匹配当前动作时才注入。
- 记忆提取从“宁滥勿缺”改为“证据优先”。
- 单次弱信号不应进入长期记忆，交给会话记忆处理。

---

## 8. 会话记忆与压缩

### 8.1 会话记忆

会话记忆是当前会话的长期工作笔记，位于 `data/sessions/session-notes.md`。

包含 10 个 section：

1. Session Title
2. Current State
3. Task Specification
4. Files and Functions
5. Workflow
6. Errors & Corrections
7. Codebase Documentation
8. Learnings
9. Key Results
10. Worklog

当前实现：

- 支持压缩前 force 更新
- LLM 直接返回 Markdown
- 写入前校验结构
- 压缩后优先作为恢复上下文

### 8.2 上下文压缩

压缩器分层工作：

1. snip 重复 reminder / summary
2. microcompact 轻量压缩
3. trimToolResults 裁剪工具输出
4. structuralExtract 本地结构化摘要
5. 可选 LLM summary
6. 重注入最近文件内容与恢复提示

上下文窗口优先级：

```text
ICE_CONTEXT_WINDOW
  -> 默认 provider maxContextTokens
  -> 最大 provider maxContextTokens
  -> 128k 默认
```

---

## 9. 运行时评测（eval 骨架）

`npm run eval:agent` 为**历史脚本名**；当前提供的是最小 eval 骨架（指标名与 case 分类），尚未实现完整判分 Runner。

```bash
npm run eval:agent
```

输出内容包括：

- case 列表
- 指标名
- 基准任务类型

当前指标名：

- `task_success_rate`
- `tool_call_rate`
- `first_tool_latency`
- `no_tool_final_rate`
- `verification_rate`
- `repeat_failure_rate`
- `memory_interference_rate`
- `tokens_per_successful_task`
- `compaction_saved_tokens`

这还是骨架，后续需要升级为真正可判分的 eval runner。

---

## 10. 开发与验证

```bash
npm install
npx tsc --noEmit
npm test
npm run eval:agent
```

常用运行方式：

```bash
npm run dev
npm run dev:api
npm run dev:web
npx tsx src/cli/index.ts run "修复失败测试"
```

---

## 11. 当前仍需优化

后续工作主要包括：

1. Memory v2 结构化分级：hard_rule / project_fact / preference / observation / session_state。
2. 压缩恢复持久化：将 Runtime Recovery Context 同步进 session notes，支持进程重启恢复。
3. 正式 **Eval Runner**：真实执行、判分、输出趋势。
4. Runtime Telemetry 落盘：工具调用率、验证率、token 成本、记忆干扰率。
5. Tool Planner：按任务类型生成建议工具链。

---

## 12. 项目目标

iceCoder 的目标不是“回答更像聊天机器人”，而是：

```text
用户给任务
  -> 系统稳定执行
  -> 修改可验证
  -> 上下文可恢复
  -> 成本可度量
  -> 回归可阻断
```