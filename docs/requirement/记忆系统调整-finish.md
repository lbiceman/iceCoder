# 长期记忆提取维度（单一事实来源）

> 由 `memory-llm-extractor` 在提取时读入；编辑本文件即可调整策略，无需改代码大段提示词。

## 一、用户画像（`type`: user）

| 维度 | 记录内容 | 示例 |
|------|----------|------|
| 技术栈 | 主要语言、框架、工具链、版本偏好 | TypeScript 5.x、React 18、Vitest、pnpm |
| 角色与职责 | 职业身份、工作领域、经验水平 | 前端架构师、全栈偏后端、初级 |
| 沟通风格 | 回复详细程度、幽默容忍度、被纠正时的反应 | 喜欢简洁回答、不喜欢过度解释、会立即纠正错误 |
| 工作节奏 | 活跃时间、休息时间、可被打断的容忍度 | 上午 8-12 点高效、下午 2 点后不被打扰 |
| 命名习惯 | 变量、函数、文件、分支的命名风格 | camelCase、组件 PascalCase、分支 feat/xxx |
| 代码风格 | 缩进、引号、分号、行宽、注释习惯 | 2 空格、单引号、不加分号、80 字符行宽 |
| 测试习惯 | 测试框架、测试文件位置、覆盖率要求 | Vitest、测试放 __tests__/、不强制 100% 覆盖 |
| Git 习惯 | Commit 格式、分支策略、合并偏好 | Conventional Commits、rebase 而非 merge |
| 文档习惯 | 文档工具、注释风格、README 格式 | Markdown、不喜欢 JSDoc、README 要带示例 |
| 安全偏好 | 本地运行、网络访问、API Key 管理 | 严格本地、不允许外网调用、Key 用环境变量 |
| 输出格式 | 日志、错误信息、终端输出偏好 | JSON 日志、不要彩色、错误带文件名行号 |
| 成本敏感度 | 模型选择、token、日预算 | 倾向 flash、关注日消耗、日预算上限 |

## 二、项目上下文（`type`: project，`memoryCategory`: project_convention）

| 维度 | 记录内容 | 示例 |
|------|----------|------|
| 项目目标 | 目的、核心功能、目标用户 | 带记忆的 AI 编程助手 |
| 技术架构 | 架构风格、主要模块、设计模式 | 单体 Runtime、状态机、文件持久化 |
| 依赖与约束 | 关键依赖、版本锁定、禁止的库 | Node.js 18+、禁止 lodash、必须用原生 fetch |
| 目录结构 | 源码/测试/输出/配置目录约定 | src/、test/、data/ |
| 构建与部署 | 构建工具、部署、环境 | npx tsc、本地、不依赖 Docker |
| 测试策略 | 单测/集成/E2E 约定 | Vitest、npm test 全量、不写 E2E |
| 代码审查规则 | 审查重点、不必审的内容 | 必查类型、不纠结格式、偏好逐行 |
| 外部服务 | 数据库、API、三方 | 无 DB、文件存储、OpenRouter |
| 环境变量 | 关键变量名、默认值（不写密钥） | ICE_CONTEXT_WINDOW、PORT |
| 启动命令 | 开发/构建/测试常用命令 | npm run dev、npm test、npx tsc --noEmit |

仅当**用户明确约定**或**难以从仓库一眼读出的意图**时写入；纯目录树复述可省略。

## 三、行为反馈（`type`: feedback）

| 维度 | 记录内容 | 示例 |
|------|----------|------|
| 纠正过的错误 | 被纠正的技术判断、工具、风格 | 「不要用 Jest，用 Vitest」 |
| 确认过的正确行为 | 用户明确满意的做法 | 「对，async 错误就这样处理」 |
| 工作流调整 | 顺序/流程变化 | 「先测再改」「不要跳过验证」 |
| 优先级变化 | 处理顺序 | 「安全优先于新功能」 |
| 中断与恢复 | 中断原因、恢复期望 | 「网络断了」「恢复时接着做不要重做」 |

## memoryCategory 与上述对应（摘要）

- **user 画像** → 多为 `stable_preference` / `habit` / `explicit_rule`，兴趣类 `hobby`（少用）
- **project** → `project_convention`
- **feedback** → 纠正/常错 → `recurring_mistake`；确认/流程 → `stable_preference` 或 `habit`

**tags**：可写 `dimension:tech_stack`、`dimension:git`、`dimension:feedback_correction` 等便于去重与召回。

**与代码门控一致**：`type: project` 必须搭配 `memoryCategory: project_convention`；反之亦然。其它组合会被丢弃，避免乱标进库。
