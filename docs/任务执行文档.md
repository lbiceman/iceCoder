双模 V1.3.6 六批实施计划（可直接执行）
Batch 1 — 类型与全局模式基座
实施任务
T01
T02

即：

supervisor types
runtime checkpoint schema 扩展
GlobalModePolicy
ModeController
config defaults
GPT 5.5 实施提示词

给 GPT (5.5)：

基于当前仓库实现 dual-mode-tasks.md：

仅执行 Batch 1：

- T01
- T02

严格要求：

1. 不实现后续任务
2. 不提前接入 Harness 主循环
3. 不改变已有运行逻辑
4. 保持 checkpoint backward compatible
5. 所有新增代码放入文档指定位置
6. commit 粒度保持 batch 级

完成后输出：

A. 修改文件列表
B. 新增类型列表
C. 测试新增内容
D. 潜在风险点
E. 未实现内容

Opus 审计提示词

给 Claude Opus：

审计 Batch 1 实现是否符合 docs/双模方案2.md 与 dual-mode-tasks.md。
重点:
1. schema 是否兼容旧 checkpoint
2. env 是否只进入 Global 层
3. 是否违反 I6
4. 是否存在越界实现
5. 是否新增隐式逻辑
6. 是否污染现有 harness 行为
输出：
A. fatal
B. warning
C. safe
D. 是否允许进入 Batch 2



Batch 2 — 决策核心
实施任务
T03
T04
T05
GPT 提示词


仅执行 Batch 2：
- T03
- T04
- T05
必须遵守：
1. 仅实现 TaskRiskClassifier / ModeDecisionEngine / RuntimeExecutionState
2. 不接入 harness
3. executionMode 只能由 ModeDecisionEngine 写
4. 不读取用户 goal 关键词
5. 不接入 env 变量
6. signal 生命周期 append-only
完成后输出：
- modified files
- tests
- remaining hooks


Opus 审计重点
重点审：
I5
signal precedence
I10
fail-safe
enteredBy
degraded
提示词：

审计 Batch 2。
必须检查：
1. 是否只有 ModeDecisionEngine 写 executionMode
2. signal precedence 是否完整
3. exit gate 是否遵守 I10
4. fail-safe 是否 forced fallback
5. state 是否只读构造
6. graph failure 是否仍 forced



Batch 3 — Harness 主循环接入（最高风险）
实施任务
T06
T07
GPT 提示词
仅执行 Batch 3：
- T06
- T07
要求：
1. 插入点必须在 prepareHarnessRound 后 callHarnessLlm 前
2. 不重构 harness 结构
3. 仅 graft
4. task-bearing round 必须严格按文档
5. mode lock 与 min dwell 独立计数
6. telemetry 必须完整


Opus 审计（最重要）
提示词：

重点审计 Batch 3。
检查：
1. before-LLM 插入点是否正确
2. 是否破坏现有 loop
3. forced entry/exit 是否闪跳
4. I10 是否真实生效
5. telemetry 是否完整
6. 是否存在双写 executionMode
7. 是否破坏 off 模式兼容



Batch 4 — 持久化与信号接入
实施任务
T08
T09
GPT

仅执行 Batch 4：
- T08
- T09
要求：
1. 所有模块仅 submitSignal
2. checkpoint 只恢复 signal
3. 不直接写 executionMode
4. signal 清理生命周期明确


Opus 审计
重点：
signal leak
stale signal
checkpoint restore corruption


Batch 5 — 门控与纠偏
实施任务
T10
T11
T12
GPT

仅执行 Batch 5：
- T10
- T11
- T12
要求：
1. ToolGate 真阻断
2. CorrectionPort 唯一出口
3. free 不启 step gate
4. forced degraded 不降 free



Opus 审计
重点：
block 是否真的不执行
skip 是否补 tool result
free 模式是否被污染
forced degraded correctness



Batch 6 — 总回归
实施任务
T13
GPT


仅执行 Batch 6：
- T13
要求：
1. 仅补测试
2. 不改业务逻辑
3. 不再新增实现
4. 只修复缺陷


Opus 审计
重点：
regression completeness
hidden regression
compatibility


每批完成后，你自己做的事（非常简单）
不用看代码。
只跑：
1
npm test
2
npm run build
3（非常重要）

跑真实任务：

测试集（建议）

准备 6 个 prompt：
A 纯读取
分析 src/harness/harness.ts 架构
必须 free。

B 小编辑
修改 logger 中一处字符串
可 free。

C 新增模块
新增 branch tracker
应 forced。

D 多文件修改
重构 task graph checkpoint
应 forced。

E checkpoint 恢复
中断恢复。
必须 forced。

F graph fail
故意让图构建失败。
必须 degraded forced。