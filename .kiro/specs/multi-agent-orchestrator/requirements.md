# 需求文档

## 简介

本系统是一个基于 Node.js 的多 Agent 协同工作平台。系统由一个主协调 Agent 统一调度多个子 Agent，形成完整的软件开发流水线。用户提交原始需求文件（HTML、DOC、PPT、XMind 等格式），系统自动完成需求分析、系统设计、任务拆分、代码编写、E2E 测试和需求核对等环节，并在每个阶段生成对应的报告文档。系统同时提供 Web 前端界面，用户通过浏览器访问配置页面和聊天主页面，在配置页面中管理 LLM 提供商的 API URL、API Key 和模型参数，在聊天主页面中上传文件、发起对话并以流式输出实时查看 Agent 的响应内容和 Pipeline 执行状态。

## 术语表

- **Orchestrator**：主协调 Agent，负责管理整个工作流的执行顺序、子 Agent 之间的数据传递和状态监控
- **Requirement_Analysis_Agent**：需求分析 Agent，负责解析输入文件并生成结构化的需求 Markdown 文档
- **Design_Agent**：设计 Agent，负责基于需求文档进行系统设计并生成设计 Markdown 文档
- **Task_Generation_Agent**：任务生成 Agent，负责基于设计文档拆分并生成任务 Markdown 文档
- **Code_Writing_Agent**：代码编写 Agent，负责根据任务文档编写源代码
- **Testing_Agent**：测试 Agent，负责基于需求、设计和任务文档编写 E2E 测试用例并执行测试
- **Requirement_Verification_Agent**：需求核对 Agent，负责核对最终实现是否符合原始需求
- **Report_Generator**：报告生成模块，负责在每个阶段结束后生成该阶段的执行报告
- **Pipeline**：工作流水线，指从需求分析到需求核对的完整执行链路
- **Stage**：阶段，Pipeline 中的一个独立执行步骤，对应一个子 Agent 的工作
- **File_Parser**：文件解析器，负责将不同格式的输入文件转换为统一的文本内容
- **Memory_Manager**：记忆管理器，每个 Agent 拥有的记忆系统核心组件，负责协调各类记忆的存储、检索、巩固和清理
- **Memory**：记忆数据结构，包含内容、类型、时间戳、重要性分数、来源 Agent 等元数据的记忆片段
- **Short_Term_Memory**：短期记忆模块，容量有限、快速访问、自动衰减的记忆存储，用于当前会话的对话历史和上下文
- **Long_Term_Memory**：长期记忆模块，基于向量数据库的持久化记忆存储，支持语义相似性检索
- **Episodic_Memory**：经历性记忆模块，存储具体事件和经历的记忆，包含时间戳、参与者、情感等信息
- **Semantic_Memory**：语义记忆模块，存储事实、概念和知识的记忆，支持主谓宾三元组和知识图谱查询
- **Procedural_Memory**：程序性记忆模块，存储技能、程序和习惯的记忆，包含技能步骤、掌握度和使用频率
- **Importance_Score**：重要性分数，基于内容长度、情感强度、交互类型、记忆类型和重复频率计算的 0 到 1 之间的数值
- **Memory_Consolidation**：记忆巩固，将短期记忆中的重要信息压缩并转移到长期记忆的过程
- **Memory_Decay**：记忆衰减，基于时间和重要性对记忆强度进行弱化的机制
- **TTL**：生存时间（Time To Live），短期记忆中每条记忆的最大存活时间
- **LLM_Adapter**：LLM 提供商适配层，负责屏蔽不同 LLM 提供商的 API 差异，为所有 Agent 提供统一的 LLM 调用接口
- **LLM_Provider**：LLM 提供商，指提供大语言模型推理服务的外部服务方，如 OpenAI、Anthropic 等
- **Provider_Adapter**：提供商适配器，针对特定 LLM 提供商实现的适配器组件，负责将统一接口调用转换为该提供商的 API 格式
- **OpenAI_Adapter**：OpenAI 适配器，实现 OpenAI Chat Completions API 格式的 Provider_Adapter
- **Anthropic_Adapter**：Anthropic 适配器，实现 Anthropic Messages API 格式的 Provider_Adapter
- **Unified_Message**：统一消息格式，系统内部使用的标准化消息数据结构，包含角色、内容和工具调用等信息
- **Token_Counter**：Token 计数器，负责统计每次 LLM 调用的输入 Token 数、输出 Token 数和总用量
- **Streaming_Handler**：流式响应处理器，负责处理 LLM 提供商返回的流式响应数据并转换为统一的流式输出格式
- **Web_Server**：Web 服务模块，基于 Node.js 的 HTTP 服务器，负责托管前端静态资源和提供后端 API 接口
- **SPA**：单页应用（Single Page Application），前端采用的应用架构，所有页面路由在客户端处理
- **Config_Page**：模型配置页面，用于管理 LLM 提供商的 API URL、API Key、模型名称和模型参数的 Web 界面
- **Chat_Page**：聊天主页面，用于用户与系统交互的 Web 界面，支持文本对话、文件上传和流式输出显示
- **SSE**：服务器发送事件（Server-Sent Events），用于服务端向客户端推送实时流式数据的通信协议
- **Navigation**：页面导航组件，用于在 Config_Page 和 Chat_Page 之间切换并显示系统状态信息

## 需求

### 需求 1：文件上传与解析

**用户故事：** 作为用户，我希望能够提交多种格式的需求文件，以便系统能够自动解析并提取其中的内容。

#### 验收标准

1. WHEN 用户提交一个 HTML 格式的文件, THE File_Parser SHALL 解析该文件并提取其中的文本内容和结构信息
2. WHEN 用户提交一个 DOC 或 DOCX 格式的文件, THE File_Parser SHALL 解析该文件并提取其中的文本内容
3. WHEN 用户提交一个 PPT 或 PPTX 格式的文件, THE File_Parser SHALL 解析该文件并提取每页幻灯片的文本内容
4. WHEN 用户提交一个 XMind 格式的文件, THE File_Parser SHALL 解析该文件并提取思维导图的节点层级结构和文本内容
5. IF 用户提交的文件格式不在支持列表中, THEN THE File_Parser SHALL 返回包含文件格式名称的错误信息
6. IF 用户提交的文件内容为空或已损坏, THEN THE File_Parser SHALL 返回描述具体问题的错误信息
7. WHEN File_Parser 成功解析文件后, THE File_Parser SHALL 输出统一的纯文本格式内容供后续 Agent 使用

### 需求 2：主协调 Agent（Orchestrator）

**用户故事：** 作为用户，我希望有一个主 Agent 自动协调所有子 Agent 按顺序执行，以便我只需提交文件即可获得完整的开发流水线输出。

#### 验收标准

1. WHEN 用户提交文件并启动 Pipeline, THE Orchestrator SHALL 按照以下固定顺序依次调度子 Agent：Requirement_Analysis_Agent → Design_Agent → Task_Generation_Agent → Code_Writing_Agent → Testing_Agent → Requirement_Verification_Agent
2. WHEN 一个 Stage 执行完成, THE Orchestrator SHALL 将该 Stage 的输出作为下一个 Stage 的输入进行传递
3. WHILE Pipeline 正在执行, THE Orchestrator SHALL 维护并更新每个 Stage 的执行状态（等待中、执行中、已完成、失败）
4. IF 某个 Stage 执行失败, THEN THE Orchestrator SHALL 停止后续 Stage 的执行并记录失败原因
5. WHEN 所有 Stage 执行完成, THE Orchestrator SHALL 汇总所有阶段的报告并输出最终的 Pipeline 执行摘要
6. THE Orchestrator SHALL 为每次 Pipeline 执行分配一个唯一的执行 ID

### 需求 3：需求分析 Agent

**用户故事：** 作为用户，我希望系统能够自动分析提交的文件内容并生成结构化的需求文档，以便后续设计和开发有明确的依据。

#### 验收标准

1. WHEN Requirement_Analysis_Agent 接收到解析后的文本内容, THE Requirement_Analysis_Agent SHALL 分析内容并生成 Markdown 格式的需求文档
2. THE Requirement_Analysis_Agent SHALL 在需求文档中包含以下章节：功能需求列表、非功能需求列表、约束条件和优先级标注
3. WHEN 需求文档生成完成, THE Requirement_Analysis_Agent SHALL 将文档保存到指定的输出目录中
4. IF 输入的文本内容不包含可识别的需求信息, THEN THE Requirement_Analysis_Agent SHALL 返回说明无法提取有效需求的错误信息

### 需求 4：设计 Agent

**用户故事：** 作为用户，我希望系统能够基于需求文档自动进行系统设计，以便开发团队有清晰的技术方案可以参考。

#### 验收标准

1. WHEN Design_Agent 接收到需求 Markdown 文档, THE Design_Agent SHALL 分析需求并生成 Markdown 格式的设计文档
2. THE Design_Agent SHALL 在设计文档中包含以下章节：系统架构概述、模块划分、接口设计和数据模型设计
3. WHEN 设计文档生成完成, THE Design_Agent SHALL 将文档保存到指定的输出目录中
4. IF 需求文档内容不完整或无法支撑设计, THEN THE Design_Agent SHALL 在设计文档中标注存在的需求缺口

### 需求 5：任务生成 Agent

**用户故事：** 作为用户，我希望系统能够基于设计文档自动拆分开发任务，以便开发工作可以有序推进。

#### 验收标准

1. WHEN Task_Generation_Agent 接收到设计 Markdown 文档, THE Task_Generation_Agent SHALL 分析设计内容并生成 Markdown 格式的任务文档
2. THE Task_Generation_Agent SHALL 在任务文档中为每个任务包含以下信息：任务编号、任务描述、所属模块、依赖关系和预估复杂度
3. WHEN 任务文档生成完成, THE Task_Generation_Agent SHALL 将文档保存到指定的输出目录中
4. THE Task_Generation_Agent SHALL 按照模块和依赖关系对任务进行排序

### 需求 6：代码编写 Agent

**用户故事：** 作为用户，我希望系统能够根据任务文档自动编写代码，以便加速开发进程。

#### 验收标准

1. WHEN Code_Writing_Agent 接收到任务 Markdown 文档, THE Code_Writing_Agent SHALL 按照任务列表逐个生成对应的源代码文件
2. THE Code_Writing_Agent SHALL 生成的代码使用 Node.js 技术栈
3. WHEN 代码文件生成完成, THE Code_Writing_Agent SHALL 将所有源代码文件保存到指定的输出目录中
4. THE Code_Writing_Agent SHALL 为每个生成的代码文件添加文件头注释，包含对应的任务编号和任务描述
5. IF 任务描述不够明确导致无法生成代码, THEN THE Code_Writing_Agent SHALL 在输出中标注该任务并说明原因

### 需求 7：测试 Agent

**用户故事：** 作为用户，我希望系统能够自动编写 E2E 测试用例，以便验证代码实现是否符合需求和设计。

#### 验收标准

1. WHEN Testing_Agent 接收到需求文档、设计文档和任务文档, THE Testing_Agent SHALL 综合分析三份文档并生成 E2E 测试用例
2. THE Testing_Agent SHALL 生成的测试用例覆盖需求文档中列出的所有功能需求
3. WHEN 测试用例生成完成, THE Testing_Agent SHALL 将测试代码文件保存到指定的输出目录中
4. THE Testing_Agent SHALL 在测试用例中包含测试描述、前置条件、测试步骤和预期结果
5. WHEN 测试用例执行完成, THE Testing_Agent SHALL 生成测试结果报告，包含通过数量、失败数量和失败详情

### 需求 8：需求核对 Agent

**用户故事：** 作为用户，我希望系统能够自动核对最终实现是否符合原始需求，以便确保交付质量。

#### 验收标准

1. WHEN Requirement_Verification_Agent 接收到原始需求文档和测试结果报告, THE Requirement_Verification_Agent SHALL 逐条核对每个需求的实现状态
2. THE Requirement_Verification_Agent SHALL 为每条需求标注核对结果：已满足、部分满足或未满足
3. IF 存在未满足或部分满足的需求, THEN THE Requirement_Verification_Agent SHALL 在核对报告中说明具体的差距描述
4. WHEN 核对完成, THE Requirement_Verification_Agent SHALL 生成 Markdown 格式的需求核对报告并保存到指定的输出目录中

### 需求 9：阶段报告生成

**用户故事：** 作为用户，我希望每个阶段执行完成后都能生成报告，以便我可以追踪整个流水线的执行情况。

#### 验收标准

1. WHEN 每个 Stage 执行完成, THE Report_Generator SHALL 生成该阶段的 Markdown 格式执行报告
2. THE Report_Generator SHALL 在每份阶段报告中包含以下信息：阶段名称、执行开始时间、执行结束时间、执行耗时、执行状态和输出摘要
3. WHEN 整个 Pipeline 执行完成, THE Report_Generator SHALL 生成一份汇总报告，包含所有阶段的执行概览和最终结论
4. THE Report_Generator SHALL 将所有报告文件保存到指定的输出目录中，并使用统一的命名规范：{执行ID}_{阶段名称}_report.md

### 需求 10：Agent 基础架构

**用户故事：** 作为开发者，我希望所有 Agent 遵循统一的接口规范，以便系统具有良好的可扩展性和可维护性。

#### 验收标准

1. THE Orchestrator SHALL 定义统一的 Agent 接口，包含 execute 方法用于执行任务和 getName 方法用于返回 Agent 名称
2. WHEN 任何 Agent 的 execute 方法被调用, THE Agent SHALL 接收一个包含输入数据和配置参数的上下文对象
3. WHEN 任何 Agent 的 execute 方法执行完成, THE Agent SHALL 返回一个包含输出数据和执行状态的结果对象
4. THE Orchestrator SHALL 支持通过注册机制动态添加新的子 Agent 到 Pipeline 中
5. IF Agent 执行过程中发生未捕获的异常, THEN THE Orchestrator SHALL 捕获该异常并将 Stage 状态标记为失败

### 需求 11：记忆系统基础架构

**用户故事：** 作为开发者，我希望系统提供统一的记忆管理基础架构，以便每个 Agent 都能以一致的方式存储和检索记忆。

#### 验收标准

1. THE Memory_Manager SHALL 提供统一的记忆存储接口，包含 store 方法用于存储记忆和 retrieve 方法用于检索记忆
2. THE Memory_Manager SHALL 提供 delete 方法用于删除指定记忆和 update 方法用于更新已有记忆
3. WHEN 存储一条新记忆时, THE Memory_Manager SHALL 为该 Memory 自动分配唯一标识符、创建时间戳和初始 Importance_Score
4. THE Memory SHALL 包含以下元数据字段：唯一标识符、内容、记忆类型、创建时间戳、最后访问时间戳、Importance_Score、来源 Agent 名称和关联标签列表
5. WHEN Memory_Manager 初始化时, THE Memory_Manager SHALL 创建并协调 Short_Term_Memory、Long_Term_Memory、Episodic_Memory、Semantic_Memory 和 Procedural_Memory 五个子模块
6. IF 存储记忆时传入的记忆类型不在支持的类型列表中, THEN THE Memory_Manager SHALL 返回包含无效类型名称的错误信息

### 需求 12：短期记忆

**用户故事：** 作为开发者，我希望每个 Agent 拥有短期记忆能力，以便在当前会话中快速访问最近的交互上下文。

#### 验收标准

1. THE Short_Term_Memory SHALL 使用固定大小的队列存储记忆，队列容量通过配置参数指定
2. WHEN 短期记忆队列已满且有新记忆需要存储时, THE Short_Term_Memory SHALL 根据 Importance_Score 最低且最后访问时间最早的淘汰策略移除一条记忆
3. WHEN 存储一条新的短期记忆时, THE Short_Term_Memory SHALL 为该记忆设置 TTL 值，TTL 值通过配置参数指定
4. WHEN 一条短期记忆的 TTL 到期时, THE Short_Term_Memory SHALL 自动将该记忆从队列中移除
5. WHEN 检索短期记忆时, THE Short_Term_Memory SHALL 在 50 毫秒内返回匹配结果
6. WHEN 一条短期记忆被访问时, THE Short_Term_Memory SHALL 更新该记忆的最后访问时间戳

### 需求 13：长期记忆

**用户故事：** 作为开发者，我希望系统支持长期记忆存储和语义检索，以便 Agent 能够持久化保存重要信息并通过语义相似性进行查找。

#### 验收标准

1. THE Long_Term_Memory SHALL 使用向量数据库持久化存储记忆片段
2. WHEN 存储一条长期记忆时, THE Long_Term_Memory SHALL 将记忆内容转换为向量嵌入并连同元数据一起存储到向量数据库中
3. WHEN 通过语义查询检索长期记忆时, THE Long_Term_Memory SHALL 基于向量相似性返回与查询内容最相关的记忆列表，列表按相似度降序排列
4. THE Long_Term_Memory SHALL 支持通过配置参数指定检索结果的最大返回数量和最低相似度阈值
5. WHEN 系统重启后, THE Long_Term_Memory SHALL 从向量数据库中恢复所有已存储的长期记忆
6. IF 向量数据库连接失败, THEN THE Long_Term_Memory SHALL 记录错误日志并返回包含连接失败原因的错误信息

### 需求 14：经历性记忆

**用户故事：** 作为开发者，我希望 Agent 能够存储具体的事件和经历，以便在后续任务中参考历史事件的上下文信息。

#### 验收标准

1. THE Episodic_Memory SHALL 为每条经历性记忆存储以下信息：事件描述、发生时间戳、结束时间戳、参与者列表和情感标注
2. WHEN 存储一条经历性记忆时, THE Episodic_Memory SHALL 验证事件描述和发生时间戳字段不为空
3. WHEN 通过时间范围查询经历性记忆时, THE Episodic_Memory SHALL 返回指定时间范围内的所有事件，按发生时间升序排列
4. WHEN 通过参与者名称查询经历性记忆时, THE Episodic_Memory SHALL 返回该参与者参与的所有事件
5. THE Episodic_Memory SHALL 支持将多个相关事件整合为一条摘要记录，摘要记录包含事件列表和整合后的叙述描述
6. IF 存储经历性记忆时事件描述或发生时间戳为空, THEN THE Episodic_Memory SHALL 返回说明缺失字段名称的错误信息

### 需求 15：语义记忆

**用户故事：** 作为开发者，我希望 Agent 能够存储和管理事实、概念和知识，以便通过知识图谱进行推理和查询。

#### 验收标准

1. THE Semantic_Memory SHALL 支持以主谓宾三元组形式存储事实，每个三元组包含主体、谓词和客体
2. THE Semantic_Memory SHALL 支持存储概念定义，每个概念包含名称、定义描述、属性列表和与其他概念的关系列表
3. WHEN 通过主体查询语义记忆时, THE Semantic_Memory SHALL 返回该主体相关的所有三元组
4. WHEN 通过谓词查询语义记忆时, THE Semantic_Memory SHALL 返回包含该谓词的所有三元组
5. THE Semantic_Memory SHALL 支持知识图谱的深度查询，根据指定的起始概念和最大深度返回关联的概念网络
6. IF 存储三元组时主体或谓词或客体为空, THEN THE Semantic_Memory SHALL 返回说明缺失字段名称的错误信息

### 需求 16：程序性记忆

**用户故事：** 作为开发者，我希望 Agent 能够记录和管理技能与习惯，以便随着使用次数增加逐步提升执行效率。

#### 验收标准

1. THE Procedural_Memory SHALL 为每条程序性记忆存储以下信息：技能名称、技能步骤列表、掌握度分数（0 到 1 之间）、使用次数和最后使用时间戳
2. WHEN 存储一条新的程序性记忆时, THE Procedural_Memory SHALL 将初始掌握度设置为 0.1 并将使用次数设置为 0
3. WHEN 一条程序性记忆被成功执行后, THE Procedural_Memory SHALL 将该记忆的使用次数加 1 并根据执行成功率更新掌握度分数
4. WHEN 通过技能名称查询程序性记忆时, THE Procedural_Memory SHALL 返回匹配的技能记录及其当前掌握度和使用统计
5. THE Procedural_Memory SHALL 支持按掌握度分数降序排列返回所有已存储的技能列表
6. WHEN 一条程序性记忆的掌握度达到 0.8 时, THE Procedural_Memory SHALL 将该技能标记为已熟练状态

### 需求 17：记忆巩固与衰减

**用户故事：** 作为开发者，我希望系统能够自动管理记忆的生命周期，以便重要的记忆被保留而不重要的记忆逐渐淡化。

#### 验收标准

1. THE Memory_Manager SHALL 基于以下因素计算每条记忆的 Importance_Score：内容长度权重、情感强度权重、交互类型权重、记忆类型权重和重复频率权重
2. WHEN Short_Term_Memory 中一条记忆的 Importance_Score 超过配置的巩固阈值时, THE Memory_Manager SHALL 自动将该记忆压缩并转移到 Long_Term_Memory 中
3. THE Memory_Manager SHALL 按照配置的时间间隔定期执行 Memory_Decay 处理，降低长时间未被访问的记忆的 Importance_Score
4. WHILE 执行 Memory_Decay 时, THE Memory_Manager SHALL 对 Importance_Score 高于 0.7 的记忆使用较慢的衰减速率，对 Importance_Score 低于 0.3 的记忆使用较快的衰减速率
5. WHEN 一条记忆被重复访问或收到正反馈时, THE Memory_Manager SHALL 提升该记忆的 Importance_Score，提升幅度与访问频率正相关
6. WHEN 一条记忆的 Importance_Score 衰减至 0 时, THE Memory_Manager SHALL 自动将该记忆从存储中移除
7. THE Memory_Manager SHALL 支持自动发现记忆之间的关联关系，基于内容相似度和时间接近度为相关记忆建立关联链接

### 需求 18：Agent 记忆集成

**用户故事：** 作为开发者，我希望每个 Agent 都拥有独立的记忆系统并支持跨 Agent 记忆共享，以便 Agent 在执行任务时能够利用历史经验并协同工作。

#### 验收标准

1. WHEN 一个新的 Agent 注册到 Orchestrator 时, THE Orchestrator SHALL 为该 Agent 创建一个独立的 Memory_Manager 实例
2. WHEN Agent 执行任务时, THE Agent SHALL 通过自身的 Memory_Manager 存储执行过程中产生的关键信息
3. WHEN Agent 开始执行新任务时, THE Agent SHALL 通过自身的 Memory_Manager 检索与当前任务相关的历史记忆作为上下文参考
4. WHEN 一个 Agent 需要访问另一个 Agent 的记忆时, THE Orchestrator SHALL 验证访问权限并协调跨 Agent 的记忆检索请求
5. WHILE Pipeline 执行过程中, THE Orchestrator SHALL 将每个 Stage 的关键输出存储到对应 Agent 的 Episodic_Memory 中
6. THE Orchestrator SHALL 维护一个共享记忆空间，所有 Agent 均可向该空间存储和检索公共知识
7. IF 跨 Agent 记忆检索请求的目标 Agent 不存在, THEN THE Orchestrator SHALL 返回包含目标 Agent 名称的错误信息

### 需求 19：LLM 提供商适配层

**用户故事：** 作为开发者，我希望系统提供统一的 LLM 调用接口和提供商适配层，以便所有 Agent 无需关心底层 LLM 提供商的 API 差异，并可通过配置灵活切换提供商。

#### 验收标准

1. THE LLM_Adapter SHALL 定义统一的 LLM 调用接口，包含 chat 方法用于发送对话请求、stream 方法用于发送流式对话请求和 countTokens 方法用于计算 Token 数量
2. WHEN 任何 Agent 调用 LLM 时, THE Agent SHALL 通过 LLM_Adapter 的统一接口发送请求，不直接依赖特定 LLM_Provider 的 SDK
3. THE LLM_Adapter SHALL 采用 Provider_Adapter 模式，每个 LLM_Provider 对应一个独立的 Provider_Adapter 实现
4. WHEN 系统启动时, THE LLM_Adapter SHALL 根据配置文件加载指定的 Provider_Adapter 并完成初始化
5. WHEN 配置文件中的 LLM_Provider 信息发生变更时, THE LLM_Adapter SHALL 支持在不修改 Agent 代码的前提下切换到新的 Provider_Adapter
6. THE LLM_Adapter SHALL 为每个 Agent 支持独立配置不同的 LLM_Provider 和模型名称
7. IF LLM_Adapter 接收到的 Provider_Adapter 名称未注册, THEN THE LLM_Adapter SHALL 返回包含该适配器名称的错误信息
8. WHEN LLM 调用发生网络错误或速率限制错误时, THE LLM_Adapter SHALL 按照配置的重试策略（最大重试次数和退避间隔）自动重试请求
9. WHEN 每次 LLM 调用完成后, THE Token_Counter SHALL 记录本次调用的输入 Token 数、输出 Token 数、总 Token 数和对应的 LLM_Provider 名称
10. THE LLM_Adapter SHALL 提供注册新 Provider_Adapter 的方法，以便未来扩展支持新的 LLM_Provider（如 Google Gemini、本地模型等）

### 需求 20：OpenAI API 兼容

**用户故事：** 作为开发者，我希望系统能够兼容 OpenAI Chat Completions API 接口格式，以便可以使用 OpenAI 的模型服务驱动 Agent 执行任务。

#### 验收标准

1. THE OpenAI_Adapter SHALL 实现 Provider_Adapter 接口，支持向 OpenAI Chat Completions API 端点（/v1/chat/completions）发送请求
2. WHEN 发送对话请求时, THE OpenAI_Adapter SHALL 将 Unified_Message 转换为 OpenAI 消息格式，包含 role（system、user、assistant）和 content 字段
3. THE OpenAI_Adapter SHALL 支持配置 OpenAI 的模型参数，包含 temperature、max_tokens、top_p、frequency_penalty 和 presence_penalty
4. WHEN 发送流式对话请求时, THE OpenAI_Adapter SHALL 使用 OpenAI 的 SSE 流式响应格式接收数据，并将每个数据块转换为 Unified_Message 格式的流式输出
5. WHEN Agent 需要调用外部工具时, THE OpenAI_Adapter SHALL 支持 OpenAI 的 Function Calling 功能，将统一的工具定义转换为 OpenAI 的 functions 参数格式，并解析 OpenAI 返回的 function_call 响应
6. WHEN OpenAI API 返回响应时, THE OpenAI_Adapter SHALL 将 OpenAI 的响应格式转换为包含内容、Token 用量和完成原因的 Unified_Message 格式
7. IF OpenAI API 返回错误响应, THEN THE OpenAI_Adapter SHALL 将 OpenAI 的错误码和错误信息转换为统一的错误格式并返回给 LLM_Adapter
8. WHEN 发送请求时, THE OpenAI_Adapter SHALL 通过配置的 API Key 和可选的 Organization ID 进行身份认证

### 需求 21：Anthropic API 兼容

**用户故事：** 作为开发者，我希望系统能够兼容 Anthropic Messages API 接口格式，以便可以使用 Anthropic 的模型服务驱动 Agent 执行任务。

#### 验收标准

1. THE Anthropic_Adapter SHALL 实现 Provider_Adapter 接口，支持向 Anthropic Messages API 端点（/v1/messages）发送请求
2. WHEN 发送对话请求时, THE Anthropic_Adapter SHALL 将 Unified_Message 转换为 Anthropic 消息格式，包含 role（user、assistant）字段和 content blocks 结构，并将 system 消息提取为独立的 system 参数
3. THE Anthropic_Adapter SHALL 支持配置 Anthropic 的模型参数，包含 max_tokens、temperature、top_p 和 top_k
4. WHEN 发送流式对话请求时, THE Anthropic_Adapter SHALL 使用 Anthropic 的 SSE 流式响应格式接收数据，并将每个事件（message_start、content_block_delta、message_stop 等）转换为 Unified_Message 格式的流式输出
5. WHEN Agent 需要调用外部工具时, THE Anthropic_Adapter SHALL 支持 Anthropic 的 Tool Use 功能，将统一的工具定义转换为 Anthropic 的 tools 参数格式，并解析 Anthropic 返回的 tool_use content block 响应
6. WHEN Anthropic API 返回响应时, THE Anthropic_Adapter SHALL 将 Anthropic 的响应格式转换为包含内容、Token 用量（input_tokens 和 output_tokens）和停止原因的 Unified_Message 格式
7. IF Anthropic API 返回错误响应, THEN THE Anthropic_Adapter SHALL 将 Anthropic 的错误类型和错误信息转换为统一的错误格式并返回给 LLM_Adapter
8. WHEN 发送请求时, THE Anthropic_Adapter SHALL 通过配置的 API Key 和 anthropic-version 请求头进行身份认证


### 需求 22：Web 服务与页面托管

**用户故事：** 作为用户，我希望启动 Node.js 服务时自动托管 Web 前端页面，以便我可以通过浏览器访问系统的配置和聊天界面。

#### 验收标准

1. WHEN Node.js 服务启动时, THE Web_Server SHALL 自动托管前端 SPA 的静态资源文件（HTML、CSS、JavaScript）
2. WHEN 用户通过浏览器访问服务根路径时, THE Web_Server SHALL 返回 SPA 的入口 HTML 页面
3. WHEN 用户通过浏览器访问 SPA 中的任意客户端路由路径时, THE Web_Server SHALL 将请求回退到 SPA 的入口 HTML 页面以支持客户端路由
4. THE Web_Server SHALL 提供 RESTful API 接口供前端页面调用，包含模型配置管理接口和聊天对话接口
5. THE Web_Server SHALL 提供 SSE 端点用于向前端推送流式响应数据
6. WHEN Web_Server 启动成功时, THE Web_Server SHALL 在控制台输出服务监听的地址和端口信息
7. IF Web_Server 启动时指定的端口已被占用, THEN THE Web_Server SHALL 返回包含端口号的错误信息并终止启动

### 需求 23：模型配置页面

**用户故事：** 作为用户，我希望在浏览器中配置 LLM 提供商的 API 信息和模型参数，以便灵活管理系统使用的模型服务。

#### 验收标准

1. THE Config_Page SHALL 提供表单界面供用户输入 LLM 提供商的 API URL 地址
2. THE Config_Page SHALL 提供表单界面供用户输入 LLM 提供商的 API Key
3. WHEN Config_Page 显示已保存的 API Key 时, THE Config_Page SHALL 对 API Key 进行脱敏显示，仅展示前 4 位和后 4 位字符，中间部分使用星号替代
4. THE Config_Page SHALL 提供下拉选择或输入框供用户指定模型名称（如 gpt-4、claude-3 等）
5. THE Config_Page SHALL 提供表单界面供用户配置模型参数，包含 temperature 和 max_tokens
6. THE Config_Page SHALL 支持配置多个 LLM 提供商的信息，每个提供商包含独立的 API URL、API Key、模型名称和模型参数
7. WHEN 用户点击保存按钮时, THE Config_Page SHALL 将配置信息通过 API 接口发送到 Web_Server 进行持久化存储
8. WHEN Config_Page 加载时, THE Config_Page SHALL 通过 API 接口从 Web_Server 获取已保存的配置信息并填充到表单中
9. IF 用户提交的配置信息中 API URL 或 API Key 为空, THEN THE Config_Page SHALL 在对应字段旁显示验证错误提示信息
10. WHEN 用户成功保存配置后, THE Config_Page SHALL 显示保存成功的提示信息

### 需求 24：聊天主页面

**用户故事：** 作为用户，我希望在浏览器中通过聊天界面与系统交互，上传文件并实时查看 Agent 的响应和 Pipeline 执行状态，以便直观地使用系统完成开发任务。

#### 验收标准

1. THE Chat_Page SHALL 提供聊天对话界面，包含消息输入框和消息发送按钮
2. WHEN 用户输入文本消息并点击发送按钮时, THE Chat_Page SHALL 将消息通过 API 接口发送到 Web_Server
3. THE Chat_Page SHALL 提供文件上传功能，支持用户选择 HTML、DOC、DOCX、PPT、PPTX 和 XMind 格式的文件
4. WHEN 用户上传文件时, THE Chat_Page SHALL 将文件通过 API 接口发送到 Web_Server 并在界面上显示文件名称和上传状态
5. WHEN Web_Server 返回流式响应时, THE Chat_Page SHALL 通过 SSE 连接实时接收数据并逐步渲染 Agent 的响应内容到对话界面中
6. WHILE Pipeline 正在执行时, THE Chat_Page SHALL 显示当前 Pipeline 的整体执行进度
7. THE Chat_Page SHALL 显示每个 Stage 的执行状态标签，状态包含等待中、执行中、已完成和失败四种
8. WHEN 一个 Stage 执行完成后, THE Chat_Page SHALL 提供可点击的链接或按钮，供用户查看该阶段生成的文档内容（需求文档、设计文档、任务文档等）
9. THE Chat_Page SHALL 在对话区域按时间顺序显示完整的对话历史记录，包含用户消息和 Agent 响应
10. THE Navigation SHALL 提供侧边栏或顶部导航栏，支持用户在 Config_Page 和 Chat_Page 之间切换
11. THE Navigation SHALL 显示系统当前状态信息，包含 Web_Server 连接状态和当前使用的模型名称
12. IF SSE 连接断开, THEN THE Chat_Page SHALL 在界面上显示连接断开的提示信息并提供重新连接按钮
