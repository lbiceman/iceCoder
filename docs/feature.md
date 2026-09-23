iceCoder Multi-Agent V3 改造提示词
========================================

使用方式：
按批次执行。每批完成后先运行 tsc 和相关测试，再进入下一批。
如果发现架构偏离“Main Harness 唯一控制面 + 唯一写者”，立即停止。


【第一批】架构审计，禁止改代码
--------------------------------

你现在负责改造 iceCoder，但第一阶段禁止修改任何代码。

请先完整审计当前项目，重点确认以下事实：

1. src/harness/harness.ts
   - Harness.run() 的 while(true) 主循环
   - 每轮上下文组装
   - LLM 调用
   - toolCalls 执行
   - 停止判定
   - LoopController
   - 当前 request_analysis 链路

2. 当前子代理实现：
   - AnalysisSupervisor
   - AsyncSubAgentManager
   - SubAgentRunner
   - request_analysis
   - 当前 explorer/search/review/dependency/test_analysis
   - analysis workspace
   - [Analysis Ready]
   - 已消费标记
   - 并发、去重、超时机制

3. 当前监管：
   - L0：off/adaptive/strict
   - L1：free/forced
   - ModeDecisionEngine
   - L3：TaskGraph contract / block / force_switch

4. 当前 TaskGraph：
   - GraphExecutor
   - inspect/search/edit/verify/summarize/delegate
   - 游标推进
   - 偏离检测
   - 工具约束

5. 当前单写者保护：
   - workspace lock
   - checkpoint
   - verification gate
   - ToolGate
   - HostGuard
   - 连续工具失败熔断
   - 分支预算

6. 找出所有与旧多 Agent 流水线相关的残留代码。
   不允许恢复旧 Orchestrator 多 Agent 架构。

本阶段只输出：

A. 当前实际架构图
B. 当前子代理调用链
C. 当前 Agent / Harness / TaskGraph 的职责边界
D. 当前哪些代码可以复用
E. 为 Multi-Agent Coordinator 改造需要新增/修改的文件
F. 潜在架构风险

特别注意：

不要自行设计第二套 Supervisor。
不要新增 Agent-to-Agent 对话。
不要改变 Harness.run() 的单主循环。
不要让子代理拥有写文件、shell、patch 能力。
不要修改代码。

完成后停止，等待下一条指令。


【第二批】实现 Multi-Agent Coordinator
---------------------------------------

基于上一阶段的审计结果，开始实现 Multi-Agent Coordinator。

核心目标：

把现在：

request_analysis
→ AnalysisSupervisor
→ AsyncSubAgentManager
→ SubAgentRunner

升级为：

Main Harness
→ Multi-Agent Coordinator
→ 多个短生命周期只读分析 Agent
→ Analysis Artifact
→ Main Harness

但是必须保持现有架构事实：

1. Main Harness 是唯一控制面。
2. Main Harness 是唯一工作区写者。
3. 子代理不能：
   - 写文件
   - 修改文件
   - apply patch
   - 执行 shell
   - 执行会改变工作区的命令
   - 调用 request_analysis
   - 创建自己的 Agent
4. 子代理只能使用现有只读工具：
   - read_file
   - glob
   - grep
   - fs_operation(list)
5. 子代理无长期会话记忆。
6. 子代理只能通过 Artifact 与主 Harness 交接。
7. 不允许 Agent-to-Agent 对话。
8. 不允许恢复旧 Orchestrator 多 Agent pipeline。
9. 不新增第二套监管轴。
10. TaskGraph 仍然只有一个 cursor，不变成 Agent 调度器。

实现 Coordinator，负责：

- 创建分析任务
- 分配角色
- 任务去重
- 并发限制
- 超时
- 生命周期管理
- 收集结果
- 写入 analysis workspace
- 产生统一 Artifact
- 向 Main Harness 提供未消费结果

建议抽象：

MultiAgentCoordinator
AnalysisTask
AnalysisArtifact
AgentRole
AnalysisTaskStatus

角色暂时保持：

explorer
search
review
dependency
test_analysis

不要为了“多 Agent”增加无意义的 Agent 类型。

现有 AsyncSubAgentManager 能复用的代码优先复用，不要重复实现已有的并发、超时、去重逻辑。

完成后：

1. tsc --noEmit
2. 运行现有子代理测试
3. 新增 Coordinator 单元测试
4. 确认旧 request_analysis 行为没有回归

不要修改 Harness 主循环的核心停止逻辑。


【第三批】并行认知任务拆解
----------------------------

现在在已有 Multi-Agent Coordinator 基础上，实现“并行认知任务拆解”。

目标：

Main Harness 在面对复杂工程任务时，不需要用户手动指定：

“去叫 explorer”
“去叫 dependency”
“去叫 test_analysis”

而是可以根据当前任务自动生成一组只读分析任务。

注意：

这不是新的 Planner。
不是新的 TaskGraph。
不是新的 Supervisor。

它只是认知任务调度器。

设计原则：

简单任务：

Main Harness
→ 不启动子代理
→ 直接工作

复杂任务：

Main Harness
→ Coordinator
→ 并行启动多个只读分析任务
→ Artifact
→ Main Harness 消费结果

分析任务应该围绕“未知信息”产生，而不是机械地每次启动所有 Agent。

例如：

用户：
“修复支付超时问题，并保证退款流程不受影响。”

可以产生：

Explorer：
查找支付超时入口。

Dependency：
查找支付 → 订单 → 退款依赖关系。

Test Analysis：
查找已有支付/退款测试。

Review：
分析潜在副作用。

但是简单任务：

“把变量 foo 改名为 bar”

不要启动 4 个 Agent。

加入一个轻量的 complexity / need-analysis 判断。

不要把它做成新的监管层。

Coordinator 可以根据：

- 涉及文件数量
- 未知符号数量
- 跨模块程度
- 依赖关系复杂度
- 用户任务复杂度
- 当前 Harness 已经获得的信息量

判断是否需要并行分析。

要求：

1. 默认最多 5 个并发分析任务。
2. 遵守现有超时。
3. 遵守现有去重。
4. 不阻塞 Main Harness。
5. 主 Harness 可以继续工作。
6. 分析结果回来后通过 [Analysis Ready] 注入。
7. 已消费结果不能重复注入。
8. 失败的分析任务不能阻塞主 Harness。
9. 子代理失败只能产生诊断信息。
10. 不能改变主 Harness 的停止机制。

重点：

不要让 Coordinator 替代 Harness 决策。

Coordinator 只能提供信息。
最终是否采用分析结果，由 Main Harness 决定。


【第四批】Artifact 驱动的 Agent 接力
-------------------------------------

现在实现 Artifact-driven follow-up。

目标：

允许一个只读 Agent 根据自己的发现提出“后续分析任务”，但不能直接调用另一个 Agent。

错误架构：

Agent A
→ Agent B

禁止。

正确架构：

Agent A
→ Artifact
→ Multi-Agent Coordinator
→ 验证 follow-up
→ 创建 Agent B

例如：

Explorer 发现：

“真正的重试逻辑不在当前文件，而在 RetryManager。”

它可以在 Artifact 中提出：

followup:
role = dependency

objective:
分析 RetryManager 对退款流程的影响

Coordinator 再决定：

- 是否允许
- 是否重复
- 是否超预算
- 是否超过深度
- 是否超过任务总数
- 是否仍然与用户目标相关

然后才创建新的分析任务。

要求：

1. Agent 不能直接创建 Agent。
2. Agent 不能调用 request_analysis。
3. Agent 不能修改 Coordinator 状态。
4. Follow-up 必须经过 Coordinator。
5. Follow-up 必须有最大深度。
6. Follow-up 必须有最大数量。
7. Follow-up 必须去重。
8. Follow-up 必须检查 allowedPaths。
9. Follow-up 失败不能阻塞主 Harness。
10. 不能形成无限递归。

建议：

maxDepth 默认 2。
maxTasks 默认遵守现有并发/预算机制。

Artifact 增加：

- findings
- references
- confidence
- suggestedNextActions / followups

但 followup 只是建议，不是执行命令。

最终是否继续由 Coordinator 判断。

完成后增加完整测试：

- 正常 follow-up
- 重复 follow-up
- 超深度
- 超数量
- 非法角色
- 非法路径
- Agent 尝试创建 Agent
- Agent 尝试写文件
- Agent 尝试执行 shell

全部必须被拒绝。


【第五批】TaskGraph 协同接入
----------------------------

现在把 Multi-Agent Coordinator 与现有 TaskGraph 做轻量集成。

重要：

TaskGraph 仍然不是 Multi-Agent Scheduler。

TaskGraph 仍然：

- 一个 Graph
- 一个 cursor
- 一个主执行路径
- 一个 Main Harness
- 节点仍然是 inspect/search/edit/verify/summarize/delegate

不要改变这个模型。

新增的只是：

某些节点可以声明“允许辅助分析”。

例如：

inspect：
允许：
explorer
dependency

search：
允许：
search
explorer

verify：
允许：
test_analysis
review

但是：

edit：
默认不启动辅助 Agent。

summarize：
消费已经存在的 Artifact，不再无限启动 Agent。

TaskGraph 只负责声明：

“当前节点允许哪些辅助认知任务”。

真正创建任务仍然由 Multi-Agent Coordinator 完成。

要求：

1. Graph cursor 不变。
2. Graph contract 不变。
3. L1 free/forced 不变。
4. L3 block/force_switch 不变。
5. Supervisor 不新增层。
6. 子代理仍然不能写工作区。
7. TaskGraph 不直接调用 LLM。
8. TaskGraph 不管理 Agent 生命周期。
9. Agent 结果不能直接改变 Graph 状态。
10. Coordinator 不推进 Graph cursor。

最终结构必须保持：

TaskGraph
→ 提供上下文/允许的分析能力

Coordinator
→ 管理只读分析任务

Main Harness
→ 决策和执行


【第六批】最终整合与回归验证
----------------------------

现在进行 Multi-Agent V3 最终整合。

不要继续增加 Agent 类型。

重点验证整个系统是否仍然满足：

【控制面】

只有：

Main Harness
Supervisor
TaskGraph

【写者】

只有：

Main Harness

【子执行体】

只能：

只读
短生命周期
无会话记忆
Artifact 交接

【禁止】

Agent-to-Agent 对话
Agent 自我复制
Agent 修改 workspace
Agent 执行 shell
Agent 推进 TaskGraph
Agent 改变 Supervisor 状态
恢复旧 Orchestrator 多 Agent pipeline
新增第二套监管体系

最终运行：

1. tsc --noEmit
2. 全量测试
3. 子代理测试
4. Coordinator 测试
5. TaskGraph 测试
6. Supervisor 测试
7. checkpoint 测试
8. verification gate 测试
9. workspace lock 测试
10. failure circuit breaker 测试

重点增加以下集成测试：

Case 1：
简单任务
→ 不启动 Agent

Case 2：
复杂任务
→ 启动多个只读 Agent

Case 3：
多个 Agent 并行
→ Main Harness 可以继续工作

Case 4：
分析结果回来
→ [Analysis Ready] 注入

Case 5：
分析结果消费
→ 不重复注入

Case 6：
Agent 提出 follow-up
→ Coordinator 接管

Case 7：
Agent 尝试继续创建 Agent
→ 拒绝

Case 8：
Agent 尝试写文件
→ 拒绝

Case 9：
Agent 尝试 shell
→ 拒绝

Case 10：
Agent 超时
→ 主 Harness 不受影响

Case 11：
Agent 全部失败
→ Main Harness 仍然可以继续

Case 12：
主 Harness 正在修改代码时
→ Agent 只能读取，不能修改

Case 13：
adaptive 模式
→ 简单任务保持 free 行为
→ 复杂任务自动启用分析

Case 14：
strict 模式
→ 不破坏现有 forced / TaskGraph 行为

Case 15：
off 模式
→ 行为与没有 Multi-Agent Coordinator 时一致

最后检查：

是否存在第二个写者？
是否存在 Agent-to-Agent 通信？
是否存在新的 Agent Supervisor？
是否存在无限 follow-up？
是否存在 TaskGraph cursor 被 Agent 修改？
是否存在分析结果直接驱动执行？
是否存在旧 Orchestrator 多 Agent 代码被恢复？

全部回答为“否”后，再整理最终架构文档。

最终输出：

A. 修改文件列表
B. 新增模块列表
C. 删除代码列表
D. 架构图
E. 数据流
F. Agent 生命周期
G. Artifact 格式
H. 并发模型
I. 故障处理
J. 测试结果
K. 与旧架构的兼容性说明
