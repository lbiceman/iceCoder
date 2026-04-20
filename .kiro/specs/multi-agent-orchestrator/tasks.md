# 实现计划：多智能体编排器

## 概述

本实现计划涵盖使用 Node.js 和 TypeScript 构建的完整多智能体协作平台。系统由四个主要子系统组成：文件解析、核心流水线（编排器 + 6 个子智能体）、记忆系统（5 种记忆类型）、LLM 提供者适配层以及 Web 前端（配置页面 + 聊天页面）。任务按顺序排列，先构建基础层，然后逐步将各组件连接起来。

## 任务

- [x] 1. 项目初始化与核心类型定义
  - [x] 1.1 初始化 TypeScript 项目及依赖
    - 初始化 `package.json`，要求 Node.js >= 18
    - 安装依赖：`express`、`cheerio`、`officeparser`、`jszip`、`lancedb`、`openai`、`@anthropic-ai/sdk`、`uuid`、`multer`
    - 安装开发依赖：`typescript`、`ts-node`、`@types/express`、`@types/node`、`@types/multer`、`vitest`
    - 配置 `tsconfig.json`，使用 ES 模块输出、严格模式和路径别名
    - 按照设计文档创建目录结构（src/core、src/agents、src/parser、src/memory、src/llm、src/web、src/public、data、output）
    - 创建 `data/config.json`，预填充默认 NVIDIA 提供者配置（见任务 1.4）
    - _Requirements: 10.1, 22.1_

  - [x] 1.2 定义核心 TypeScript 接口和类型
    - 创建 `src/core/types.ts`，包含 `AgentContext`、`AgentResult`、`Agent` 接口（含 `execute` 和 `getName` 方法）、`StageDefinition`、`PipelineState`、`StageStatus`
    - 创建 `src/parser/types.ts`，包含 `FileParserStrategy` 接口和 `ParseResult` 类型
    - 创建 `src/memory/types.ts`，包含 `MemoryType` 枚举、`Memory` 接口、`EpisodicEvent`、`Triple`、`Concept`、`Skill` 类型
    - 创建 `src/llm/types.ts`，包含 `UnifiedMessage`、`LLMResponse`、`TokenUsage`、`LLMOptions`、`ToolCall`、`ToolDefinition`、`ProviderAdapter` 接口、`StreamCallback`、`RetryConfig`
    - 创建 `src/web/types.ts`，包含 `ProviderConfig`、`SSEEvent` 类型
    - _Requirements: 10.1, 10.2, 10.3, 11.4, 19.1_

  - [x] 1.3 编写类型验证辅助函数的单元测试
    - 测试 MemoryType 枚举包含全部五种记忆类型
    - 测试 AgentContext 和 AgentResult 结构验证
    - _Requirements: 10.2, 10.3_

  - [x] 1.4 创建默认提供者配置
    - 创建 `data/config.json`，预配置默认 NVIDIA 提供者：
      - `id`: `'default-nvidia'`
      - `providerName`: `'openai'`（NVIDIA API 兼容 OpenAI 格式）
      - `apiUrl`: `'https://integrate.api.nvidia.com/v1'`
      - `apiKey`: `'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'`
      - `modelName`: `'z-ai/glm-5.1'`
      - `parameters`: `{ temperature: 1, topP: 1, maxTokens: 16384, chatTemplateKwargs: { enable_thinking: true, clear_thinking: false } }`
      - `isDefault`: `true`
    - 此配置供 OpenAI 适配器使用，因为 NVIDIA API 遵循 OpenAI Chat Completions 格式
    - _Requirements: 19.4, 20.1_

- [x] 2. 文件解析器模块
  - [x] 2.1 使用策略模式实现 FileParser 主类
    - 创建 `src/parser/file-parser.ts`，包含 `FileParser` 类
    - 实现 `registerStrategy()`，按文件扩展名注册解析策略
    - 实现 `parse(buffer, filename)`，根据扩展名选择策略并委托解析
    - 对不支持的文件格式返回包含格式名称的错误
    - 对空文件或损坏文件返回错误
    - _Requirements: 1.5, 1.6, 1.7_

  - [x] 2.2 实现 HTML 解析策略
    - 创建 `src/parser/html-strategy.ts`，使用 `cheerio`
    - 提取文本内容和结构信息（标题、列表、段落）
    - 返回保留结构的统一纯文本输出
    - _Requirements: 1.1, 1.7_

  - [x] 2.3 实现 Office 文件解析策略（DOC/DOCX/PPT/PPTX）
    - 创建 `src/parser/office-strategy.ts`，使用 `officeparser`
    - 处理 DOC、DOCX、PPT、PPTX 格式
    - 从文档中提取文本内容，从演示文稿中提取每页幻灯片文本
    - 在 PPT/PPTX 文件的元数据中包含页数
    - _Requirements: 1.2, 1.3, 1.7_

  - [x] 2.4 实现 XMind 解析策略
    - 创建 `src/parser/xmind-strategy.ts`，使用 `JSZip`
    - 解压 XMind 文件并解析 `content.json`
    - 递归遍历节点树，提取带缩进的层级文本
    - 在元数据中包含节点数量
    - _Requirements: 1.4, 1.7_

  - [x] 2.5 编写文件解析器的单元测试
    - 测试 HTML 解析提取文本和结构
    - 测试 Office 解析处理 DOC/DOCX/PPT/PPTX
    - 测试 XMind 解析提取节点层级
    - 测试不支持的格式返回包含格式名称的错误
    - 测试空文件/损坏文件返回描述性错误
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 3. 检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 4. 记忆系统基础
  - [x] 4.1 实现 Memory 数据结构和重要性评分计算
    - 创建 `src/memory/memory.ts`，包含 `Memory` 类/工厂函数
    - 实现创建时自动生成唯一 ID（uuid）、创建时间戳和初始重要性评分
    - 实现 `calculateImportanceScore()`，使用设计文档中的加权公式：contentLength (w1=0.15)、emotionIntensity (w2=0.20)、interactionType (w3=0.25)、memoryType (w4=0.20)、repetitionFrequency (w5=0.20)
    - 将结果归一化到 [0, 1] 范围
    - _Requirements: 11.3, 11.4, 17.1_

  - [x] 4.2 实现短期记忆
    - 创建 `src/memory/short-term-memory.ts`，包含 `ShortTermMemory` 类
    - 实现可配置容量的固定大小队列
    - 实现 `store()`，为每条记忆条目设置 TTL
    - 实现淘汰策略：队列满时移除重要性评分最低且最早访问的记忆
    - 实现 TTL 过期清理，自动移除过期记忆
    - 实现 `retrieve()`，支持查询匹配，访问时更新 `lastAccessedAt`
    - 确保检索在 50ms 性能目标内完成
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 4.3 使用 LanceDB 实现长期记忆
    - 创建 `src/memory/long-term-memory.ts`，包含 `LongTermMemory` 类
    - 初始化 LanceDB 连接，支持可配置的存储路径
    - 实现 `store()`，将记忆内容转换为向量嵌入并与元数据一起存储
    - 实现 `retrieve()`，支持向量相似度搜索，可配置最大结果数和相似度阈值
    - 实现 `restore()`，在系统重启后恢复所有已存储的记忆
    - 处理 LanceDB 连接失败，记录错误日志并返回描述性错误信息
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [x] 4.4 实现情景记忆
    - 创建 `src/memory/episodic-memory.ts`，包含 `EpisodicMemory` 类
    - 实现 `store()`，验证必填字段（description、occurredAt）
    - 实现 `queryByTimeRange()`，返回按 occurredAt 升序排列的事件
    - 实现 `queryByParticipant()`，返回指定参与者的所有事件
    - 实现 `consolidateEvents()`，将相关事件合并为摘要记录
    - 必填字段为空时返回包含缺失字段名的错误
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [x] 4.5 实现语义记忆
    - 创建 `src/memory/semantic-memory.ts`，包含 `SemanticMemory` 类
    - 实现 `storeTriple()`，存储带验证的主语-谓语-宾语三元组
    - 实现 `storeConcept()`，存储包含属性和关系的概念定义
    - 实现 `queryBySubject()` 和 `queryByPredicate()`，用于三元组查询
    - 实现 `queryKnowledgeGraph()`，从起始概念进行深度受限的遍历
    - 主语、谓语或宾语为空时返回包含缺失字段名的错误
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 4.6 实现程序性记忆
    - 创建 `src/memory/procedural-memory.ts`，包含 `ProceduralMemory` 类
    - 实现 `store()`，初始 proficiency=0.1，usageCount=0
    - 实现 `recordExecution()`，递增使用次数并根据成功率更新熟练度
    - 当熟练度达到 0.8 时标记技能为已掌握
    - 实现 `queryByName()`，返回包含当前熟练度和使用统计的技能
    - 实现 `listByProficiency()`，返回按熟练度降序排列的所有技能
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_

  - [x] 4.7 编写记忆模块的单元测试
    - 测试不同输入下的重要性评分计算
    - 测试短期记忆的淘汰和 TTL 过期
    - 测试长期记忆的存储和向量相似度检索
    - 测试情景记忆的时间范围和参与者查询
    - 测试语义记忆的三元组存储和知识图谱遍历
    - 测试程序性记忆的熟练度更新和掌握标记
    - _Requirements: 11.3, 12.1, 12.2, 13.3, 14.3, 15.3, 16.3_

- [x] 5. 记忆管理器与生命周期管理
  - [x] 5.1 实现 MemoryManager 协调全部五个记忆子模块
    - 创建 `src/memory/memory-manager.ts`，包含 `MemoryManager` 类
    - 在构造时初始化并协调 ShortTermMemory、LongTermMemory、EpisodicMemory、SemanticMemory 和 ProceduralMemory
    - 实现统一的 `store()`，根据记忆类型路由到正确的子模块
    - 实现统一的 `retrieve()`，查询相应的子模块
    - 实现 `delete()` 和 `update()` 方法
    - 存储时验证记忆类型，对不支持的类型返回包含无效类型名的错误
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.6_

  - [x] 5.2 实现记忆巩固与衰减
    - 在 MemoryManager 中实现 `consolidate()`：将重要性评分超过可配置阈值的短期记忆压缩后转移到长期记忆
    - 实现 `decay()`，采用分段指数衰减：评分 > 0.7 时慢速衰减（0.95），0.3-0.7 时中速衰减（0.90），评分 < 0.3 时快速衰减（0.80）
    - 当重要性评分衰减到 0 时自动移除记忆
    - 实现重复访问时的重要性评分提升，与访问频率成正比
    - 实现基于内容相似度和时间邻近性的记忆间自动关联发现
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7_

  - [x] 5.3 编写 MemoryManager 的单元测试
    - 测试记忆按类型正确路由到对应子模块
    - 测试巩固操作将高重要性短期记忆转移到长期记忆
    - 测试衰减根据重要性评分阈值应用正确的衰减率
    - 测试评分降至 0 时记忆被移除
    - 测试重复访问时重要性评分提升
    - _Requirements: 11.1, 11.5, 17.2, 17.3, 17.4, 17.5, 17.6_

- [x] 6. 检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 7. LLM 提供者适配层
  - [x] 7.1 实现 Token 计数器
    - 创建 `src/llm/token-counter.ts`，包含 `TokenCounter` 类
    - 跟踪每次 LLM 调用的输入 Token、输出 Token、总 Token 和提供者名称
    - 提供获取累计使用统计的方法
    - _Requirements: 19.9_

  - [x] 7.2 实现 LLM 适配器主类
    - 创建 `src/llm/llm-adapter.ts`，包含实现 `LLMAdapterInterface` 的 `LLMAdapter` 类
    - 通过 `registerProvider()` 和 `setDefaultProvider()` 实现提供者注册
    - 实现 `chat()`，委托给已配置的提供者适配器并记录 Token 使用量
    - 实现 `stream()`，通过回调将流式传输委托给提供者适配器
    - 实现 `countTokens()`，用于 Token 估算
    - 实现重试逻辑，支持可配置的最大重试次数和指数退避，用于网络/限流错误
    - 请求的提供者未注册时返回包含适配器名称的错误
    - 支持按智能体配置提供者和模型
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10_

  - [x] 7.3 实现 OpenAI 提供者适配器
    - 创建 `src/llm/openai-adapter.ts`，包含实现 `ProviderAdapter` 的 `OpenAIAdapter` 类
    - 接受可配置的 `baseURL` 以支持 OpenAI 兼容 API（例如 NVIDIA `https://integrate.api.nvidia.com/v1`）
    - 实现 `chat()`：将 UnifiedMessage 转换为 OpenAI 消息格式（role: system/user/assistant, content），发送到 `/v1/chat/completions`，将响应转换回包含 Token 使用量和完成原因的 UnifiedMessage
    - 实现 `stream()`：使用 OpenAI SSE 流式传输，处理 `delta.content` 和 `delta.reasoning_content` 字段（用于支持思考功能的模型如 NVIDIA 的 glm-5.1），通过回调将每个块转换为统一格式
    - 支持 OpenAI 模型参数：temperature、max_tokens、top_p、frequency_penalty、presence_penalty
    - 支持透传提供者特定参数如 `chat_template_kwargs`（用于 NVIDIA 思考模式：`{ enable_thinking: true, clear_thinking: false }`）
    - 实现函数调用：将 ToolDefinition 转换为 OpenAI functions 格式，解析 function_call 响应
    - 处理 OpenAI 错误响应：将错误码和消息转换为统一错误格式
    - 通过配置的 API Key 和可选的 Organization ID 进行认证
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8_

  - [x] 7.4 实现 Anthropic 提供者适配器
    - 创建 `src/llm/anthropic-adapter.ts`，包含实现 `ProviderAdapter` 的 `AnthropicAdapter` 类
    - 实现 `chat()`：将 UnifiedMessage 转换为 Anthropic 格式（将系统消息提取为单独参数，role: user/assistant 带内容块），发送到 `/v1/messages`，将响应转换回包含 Token 使用量（input_tokens、output_tokens）和停止原因的统一格式
    - 实现 `stream()`：处理 Anthropic SSE 事件（message_start、content_block_delta、message_stop），通过回调转换为统一流格式
    - 支持 Anthropic 模型参数：max_tokens、temperature、top_p、top_k
    - 实现工具使用：将 ToolDefinition 转换为 Anthropic tools 格式，解析 tool_use 内容块
    - 处理 Anthropic 错误响应：将错误类型和消息转换为统一错误格式
    - 通过 API Key 和 anthropic-version 头进行认证
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8_

  - [x] 7.5 编写 LLM 适配层的单元测试
    - 测试 LLMAdapter 路由到正确的提供者
    - 测试指数退避的重试逻辑
    - 测试 OpenAI 消息格式转换（统一格式 → OpenAI → 统一格式）
    - 测试 Anthropic 消息格式转换（统一格式 → Anthropic → 统一格式）
    - 测试 Token 计数器正确累计使用量
    - 测试未注册提供者的错误处理
    - _Requirements: 19.1, 19.7, 19.8, 20.2, 20.6, 21.2, 21.6_

- [x] 8. 检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 9. 智能体基类与子智能体实现
  - [x] 9.1 实现 BaseAgent 抽象类
    - 创建 `src/core/base-agent.ts`，包含实现 `Agent` 接口的 `BaseAgent` 抽象类
    - 实现 `getName()`，返回智能体名称
    - 实现 `callLLM()` 辅助方法，通过上下文中的 LLM 适配器发送提示
    - 实现 `storeMemory()` 辅助方法，通过上下文中的 MemoryManager 存储内容
    - 实现 `retrieveMemory()` 辅助方法，从上下文中检索相关记忆
    - 实现 `saveDocument()` 辅助方法，将内容写入输出目录中的文件
    - 用 try-catch 包装 `execute()`，捕获未处理的异常并返回失败结果
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 18.2, 18.3_

  - [x] 9.2 实现需求分析智能体
    - 创建 `src/agents/requirement-analysis.ts`，继承 `BaseAgent`
    - 实现 `execute()`：接收解析后的文本内容，调用 LLM 分析并生成结构化需求 Markdown
    - 生成的文档必须包含以下章节：功能需求列表、非功能需求列表、约束条件和优先级标注
    - 将文档保存到输出目录
    - 如果输入文本不包含可识别的需求则返回错误
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 9.3 实现设计智能体
    - 创建 `src/agents/design.ts`，继承 `BaseAgent`
    - 实现 `execute()`：接收需求 Markdown，调用 LLM 生成设计 Markdown
    - 生成的文档必须包含以下章节：系统架构概述、模块分解、接口设计和数据模型设计
    - 将文档保存到输出目录
    - 如果需求不完整则标注需求缺口
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 9.4 实现任务生成智能体
    - 创建 `src/agents/task-generation.ts`，继承 `BaseAgent`
    - 实现 `execute()`：接收设计 Markdown，调用 LLM 生成任务 Markdown
    - 每个任务必须包含：任务编号、描述、所属模块、依赖关系和预估复杂度
    - 按模块和依赖顺序排列任务
    - 将文档保存到输出目录
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 9.5 实现代码编写智能体
    - 创建 `src/agents/code-writing.ts`，继承 `BaseAgent`
    - 实现 `execute()`：接收任务 Markdown，调用 LLM 按任务生成源代码文件
    - 生成的代码使用 Node.js/TypeScript 技术栈
    - 在每个生成文件的头部添加包含任务编号和描述的注释
    - 将所有源文件保存到输出目录
    - 标记描述不清晰的任务并说明无法生成代码的原因
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 9.6 实现测试智能体
    - 创建 `src/agents/testing.ts`，继承 `BaseAgent`
    - 实现 `execute()`：接收需求、设计和任务文档，调用 LLM 生成端到端测试用例
    - 测试用例必须覆盖需求文档中的所有功能需求
    - 每个测试用例包含：测试描述、前置条件、测试步骤和预期结果
    - 生成包含通过数、失败数和失败详情的测试结果报告
    - 将测试文件和报告保存到输出目录
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 9.7 实现需求验证智能体
    - 创建 `src/agents/requirement-verification.ts`，继承 `BaseAgent`
    - 实现 `execute()`：接收原始需求文档和测试结果报告，调用 LLM 验证每条需求
    - 将每条需求标记为：已满足、部分满足或未满足
    - 对部分满足或未满足的需求包含缺口描述
    - 生成 Markdown 验证报告并保存到输出目录
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 9.8 编写智能体的单元测试
    - 测试 BaseAgent 辅助方法（callLLM、storeMemory、retrieveMemory、saveDocument）
    - 使用模拟 LLM 响应测试每个智能体的 execute 方法
    - 测试无效输入的错误处理
    - _Requirements: 10.1, 10.5, 3.4, 4.4, 6.5_
