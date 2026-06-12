iceCoder 双模自适应执行引擎设计文档
版本：1.0
状态：详细设计阶段
前身：Task Graph Planner 设计文档（规则驱动、图引导执行）
核心演化：从“纯规则约束”升级为“信任优先、异常接管”的双模弹性架构

1. 概述
iceCoder 双模自适应执行引擎是一种用于工具化 LLM 运行时的执行控制层。它在现有 Harness 主循环之上，引入正常模式（Model‑Led）与校准模式（Graph‑Guided）的双模切换机制：模型在大多数情况下自由规划与执行，系统静默观察；一旦检测到偏离信号，系统立即接管控制权，激活结构化任务图、节点合约、升级策略等规则层，强制将执行拉回正确路径，并在安全点交还控制权。

这一设计将“AI 代理的灵活性”与“确定性系统的可靠性”融为一体，形成一种弹性信任架构——在模型表现良好时完全透明，仅在必要时施加约束。

2. 动机与问题分析
2.1 纯模型主导的困境
当前主流 AI 编码工具（Claude Code、Codex CLI、Devin 等）均以模型为唯一决策者。模型自主规划、执行、纠错。这种模式存在固有缺陷：

不可靠性天花板：模型是概率系统，长周期任务中必然出现目标漂移、幻觉、重复循环。

无结构化恢复：偏离后只能依赖模型“自行醒悟”，缺乏外部纠偏抓手。

成本失控风险：模型可能在循环中浪费大量 token，却无法收敛。

2.2 纯规则约束的局限
iceCoder 已有的 Task Graph Planner（V1）采用强规则方案：预设任务图、节点合约、硬性偏离检测。虽然执行确定性极高，但：

灵活性不足：仅能处理预定义模板的任务类型，无法应对开放式需求。

模型能力利用不充分：强大模型在狭窄节点内被降级为“代码猴子”。

用户感知受限：始终被约束，缺少自然流畅的协作感。

2.3 双模方案的价值
双模架构在“规则”与“模型”之间找到了可配置的平衡点。它承认模型会犯错，但选择先信任、再兜底——就像工业控制系统中的“正常模式 + 安全联锁”，最大程度发挥模型能力的同时，为关键工程任务提供可靠性保障。

3. 核心哲学：弹性信任
双模引擎建立在一条简单原则上：

信任模型的灵活性，但不信任模型的可靠性；用系统层的确定性，兜底模型层的概率性。

这一原则通过三个机制实现：

被动观察（不干预正常执行）

按需激活（只在确认偏离后接管）

安全交还（校准完成即恢复自由）

4. 双模架构总览
text
                          ┌─────────────────────────────┐
                          │       用户任务输入            │
                          └─────────────┬───────────────┘
                                        │
                                        ▼
                          ┌─────────────────────────────┐
                          │       Harness 主循环          │
                          │   (LLM 调用 / 工具执行)       │
                          └─────────────┬───────────────┘
                                        │
                        ┌───────────────┼───────────────┐
                        │               │               │
             mode = Model‑Led    ActivationPolicy    mode = Graph‑Guided
                        │               │               │
                        ▼               ▼               ▼
              ┌─────────────────┐ ┌───────────┐ ┌─────────────────┐
              │  PassiveObserver │ │ 切换到     │ │  TaskGraph 组件  │
              │  (静默采集信号)   │ │ 校准模式   │ │  (合约/偏离/升级) │
              └─────────────────┘ └───────────┘ └─────────────────┘
                        │                               │
                        └───────────────┬───────────────┘
                                        │
                                        ▼
                            HandoffConditions 满足？
                                        │
                         ┌──────────────┴──────────────┐
                         │ Yes：交还控制权，回到 Model‑Led │
                         │ No ：继续校准模式              │
                         └─────────────────────────────┘
4.1 正常模式（Model‑Led）
无预设任务图，无节点约束。

模型自由推理、自由选择工具、自由执行。

PassiveObserver 在后台收集偏离信号，不干预执行。

4.2 切换逻辑（ActivationPolicy）
当 PassiveObserver 累积的信号满足预设阈值时，系统自动进入校准模式。阈值可配置，默认包括：

连续 3 轮无工具调用

同工具同签名失败 ≥ 2 次

5 轮内任务 phase 无前进

同一文件反复读写 ≥ 4 次

用户主动中断（Ctrl+C 后选择“让系统接管”）

4.3 校准模式（Graph‑Guided）
系统从当前执行轨迹反向构建一个校准用 TaskGraph。

启用 V1 所有约束组件：节点合约、偏离检测、升级策略、分支预算。

按照图节点顺序强制执行，确保任务收束到安全状态。

4.4 安全交还（HandoffConditions）
满足以下任一条件时，系统交还控制权，回到正常模式，并进入冷却期（默认 3 轮）防止乒乓切换：

当前校准节点执行完毕

验证通过

连续 N 轮无新偏离信号

校准图全部执行完毕

5. 组件详解
5.1 PassiveObserver（被动观察器）
typescript
interface PassiveObserver {
  signals: DeviationSignal[];
  addSignal(signal: DeviationSignal): void;
  shouldActivate(): boolean;
  reset(): void;
}

interface DeviationSignal {
  type: 'repeated_failure' | 'no_progress' | 'tool_loop' | 'phase_regression' | 'scope_creep';
  severity: 'low' | 'medium' | 'high';
  round: number;
  detail: string;
}
工作方式：在每轮 Harness 循环结束后，PassiveObserver 被调用，分析本轮工具调用结果、phase 变化、文件操作模式等，产生 0 个或多个 DeviationSignal，累积至内部列表。shouldActivate() 基于加权计数器（可配置阈值）返回 true/false。

5.2 RetrospectiveGraphBuilder（反向图构建器）
当切换至校准模式时，系统调用此构建器。它接收：

当前完整的 ExecutionTrace（工具调用历史、LLM 响应、失败记录）

原始任务目标 goal

PassiveObserver 的累积信号列表

处理流程：

轨迹分析：识别已完成步骤和当前失败点。

剩余步骤规划：调用一次轻量 LLM（在异常已发生时，一次额外调用是可接受的成本），基于目标和轨迹推断剩余步骤序列。

图构建：复用 V1 的 buildGraph() 逻辑，将剩余步骤映射为带合约约束的 TaskGraph 节点。

typescript
async function buildRetroGraph(
  trace: ExecutionTrace,
  goal: string,
  signals: DeviationSignal[]
): Promise<TaskGraph> { ... }
5.3 V1 约束组件的复用
进入校准模式后，以下 V1 组件被完整激活：

GraphExecutor：按图游标逐节点驱动 Harness。

ContractValidator：在工具调用前检查节点合约，阻止违规工具。

DeviationDetector：实时检测当前节点内的偏离。

EscalationPolicy：对偏离进行分级纠正（提示→阻止→分支切换）。

FallbackBranch：当节点重试耗尽或严重偏离时，自动切换到后备策略。

所有组件在校准模式外保持休眠，不消耗任何资源。

5.4 HandoffConditions（安全交还条件）
typescript
interface HandoffEvaluator {
  shouldHandoff(
    currentNode: TaskNode,
    deviationHistory: DeviationResult[],
    roundCount: number
  ): { handoff: boolean; reason?: string };
}
交还条件：

节点状态变为 done，且对应 OutputSignal 全部满足。

verificationStatus 变为 passed。

连续 3 轮无新 DeviationSignal。

校准图的所有节点均已完成（任务完成）。

交还后系统重置 PassiveObserver，并启动冷却期，防止短时间内再次触发切换。

6. 与现有 Harness 的集成
双模引擎在现有 Harness 主循环中的插入点与 V1 完全一致，但逻辑变为：

typescript
// Harness.run() 伪代码
while (running) {
  // ... 现有逻辑 ...

  if (this.mode === 'graph-guided') {
    // 校准模式：图执行器驱动
    const node = this.graphExecutor.getCurrentNode();
    this.injectNodeContext(node);
    this.contractValidator.checkBeforeToolCall(toolCall);
    // ... 执行 ...
    this.deviationDetector.detect(toolCalls);
    this.escalationPolicy.evaluate(...);
    if (this.handoffEvaluator.shouldHandoff()) {
      this.switchToModelLed();
    }
  } else {
    // 正常模式：自由执行，仅观察
    const signals = this.passiveObserver.analyzeRound(toolCalls, response);
    if (this.passiveObserver.shouldActivate()) {
      const retroGraph = await this.retroBuilder.build(trace, goal, signals);
      this.switchToGraphGuided(retroGraph);
    }
  }
}
关键修改量：

新增 PassiveObserver、RetrospectiveGraphBuilder、HandoffEvaluator 三个模块（约 400 行）。

在 Harness 循环中增加约 40 行模式判断与切换逻辑。

V1 已有的所有图组件（TaskGraph、Contract、Deviation、Escalation）保持不变，仅在校准模式下被调用。

7. 配置与模式选择
通过环境变量 ICE_TASK_GRAPH 控制：

值	模式	描述
off	纯模型自由	完全关闭图系统，行为等同传统 AI 编码工具
adaptive	双模（默认）	正常模式自由执行，偏离后自动切换至校准模式
strict	纯规则（V1）	始终构建并强制执行 TaskGraph，无自由模式
推荐默认使用 adaptive，为大多数任务提供灵活性，同时为长周期关键任务保留兜底能力。

8. 预期提升与量化指标
基于 V1 设计文档的理论分析及双模补充，对比纯模型自由方案，预期提升如下：

指标	纯模型自由	双模 (adaptive)	提升幅度
复杂任务成功率	60-70%	88-95%	+25~30%
重复失败循环发生率	~15% 的任务出现	<3%	降低 5 倍
Token 浪费（无效探索/循环）	占总 token 30-40%	<10%	降低 60-75%
中断恢复准确率（从 checkpoint）	~50%	>95%	+45%
偏离检测响应时间	3-5 轮（被动发现）	1 轮内（主动接管）	快 3-5 倍
用户重试次数（任务失败后）	平均 1.8 次	平均 0.3 次	减少 83%
注：以上数据基于机制分析，最终需通过 GraphMetrics 在真实任务中验证。

9. 与竞品的对比
工具	规划方式	约束机制	偏离恢复	弹性模式
Claude Code	模型自发 TODO	无系统级约束	依赖模型自纠正	无
Codex CLI	模型循环决策	工具白名单	云端状态恢复	无
Trae SOLO	模型生成 Plan + 人工审批	人工确认	人工重新规划	无
iceCoder（adaptive）	双模：自由 + 按需图规划	被动观察 + 激活式合约	系统接管 + 反向图构建	弹性信任
双模架构是唯一提供“信任优先、异常接管”的系统级弹性方案。

10. 路线图
Phase 1（当前）
实现 PassiveObserver、RetrospectiveGraphBuilder、HandoffEvaluator

完成 Harness 集成，支持 ICE_TASK_GRAPH=adaptive

跑通 5-10 个基准任务，初步验证切换逻辑

Phase 2（1-2 个月后）
基于运行数据优化激活阈值和冷却期参数

支持用户自定义 activationPolicy 配置

产出公开 Benchmark 数据

Phase 3（长期）
引入 Meta‑Layer，从历史切换事件中自动学习最优策略

多智能体协同（探索 Agent、修复 Agent 等）在校准模式下分工

架构抽象为开源框架或学术论文

11. 总结
iceCoder 双模自适应执行引擎，将 AI 编码工具从“纯模型信任”或“纯规则约束”的二选一困境中解放出来。它在不牺牲灵活性的前提下，提供了一种工业级的可靠性兜底机制——这正是大型企业采纳自主 AI 代理时最核心的诉求。

信任模型，但把缰绳握在手里。
这就是双模引擎的设计哲学，也是 iceCoder 在 AI 辅助编程赛道中建立的独特壁垒