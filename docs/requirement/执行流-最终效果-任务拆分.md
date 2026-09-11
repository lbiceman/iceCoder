# 执行流编年史 — 工程任务拆分

> **状态**：待执行  
> **版本**：v1.0  
> **日期**：2026-09-11  
> **依据**：[`执行流-最终效果.md`](./执行流-最终效果.md)（效果文档 §1–§12）  
> **本文件性质**：执行任务清单。不新增产品需求、不改会话落盘语义、不改检查点恢复协议。  
> **数据原则**：编年史是已有 session 数据的只读 UI。权威来源是该会话的 UI 消息、structured、工具记录、检查点时间轴；不是新的 sidecar，也不是 localStorage。

---

## 1. 如何使用本文档

1. **严格按 Wave 顺序执行**（同 Wave 内标注 `∥` 的可并行）。
2. 每个任务交给 Agent 时，复制对应 **Agent Prompt**（§10）并指定该任务的文件范围。
3. 合并前对照效果文档 **§12 五条验收直觉** 与本文 **§8**。
4. 效果文档说「看见什么」；本文只拆「改哪些展示与装配」。若两者冲突，以效果文档为准。

---

## 2. 硬约束（全程有效）

**允许**

- 把已有 session 数据装配成章 / 轮 / 工具行，再用合适的折叠展示。
- 新增纯函数装配模块与前端测试。
- 必要时增加**只读**聚合（不写盘）。现有 `GET /api/sessions/:id/checkpoints`、structured 拉取、聊天区 `toolCallId` 已够用，优先不新开接口。
- `execution_plan_clear` 仍可由 Harness 发出；前端把它解释成「封上章、开新章」，而不是擦掉整本编年史。

**禁止**

- 改 `session.json` / `structured.json` / `session-notes.md` / Intent Checkpoint schema / `checkpoint-index.json` 的写入形状。
- 新增 session sidecar 作为编年史权威存储。
- 在执行流 Tab 加「恢复检查点」「打开文件」。
- 在执行流里展示模型正文、思考、stdout、diff。
- 改检查点 Tab 的恢复 / 打开文件行为（除「点某一档时若仍在执行流 Tab 则滚到对应章」）。
- 改 Harness 主循环、检查点捕获 / 回滚、聊天区渲染。
- 把 localStorage 执行流快照当成刷新后的权威数据。

---

## 3. 现状缺口（对照效果文档）

当前面板是「当前这一问」的轮次时间轴，不是会话编年史。

| 效果文档 | 现状 |
|----------|------|
| §4 默认是章节目录 | 根节点是轮次列表；任务总览挂在 Tab 上方、会话级一块 |
| §6 发下一条，上章还在 | `onNewTurnStarted` / `execution_plan_clear` 会 `clear()` 整块执行流 |
| §8 刷新 / 晚开应齐 | `hydrateFromStructured` 只切**最后一句用户话**；缺轮次时出现「轮次 1–N 未载入 · 去聊天区展开」 |
| §11 底栏工具 / 时间是本会话累计 | 工具与时间基本按本轮 `turnStartedAt` / 本轮工具计数 |
| §7 与检查点同一用户消息轴 | 检查点 Tab 已按 messageId 列点；执行流没有章、无法对上 |
| 页脚工具 20、中间只有整理结论 | 全局 `MAX_TOOL_HISTORY = 100`、`MAX_ROUND_HISTORY = 50` 且只 hydrate 当前问，历史工具进不了面板 |

任务图、监管条、检查点 Tab、底栏三格、移动端仅执行流 —— **保留外壳，改执行流主体。**

---

## 4. 执行总览

```text
Wave 0  视图模型（纯装配，无 DOM）
  0.1 章/轮/工具行类型与装配函数 ──→ 0.2 单测
         │
Wave 1  章节目录 UI（静帧）
  1.1 目录骨架 + 空态 + CSS ──→ 1.2 展开一章=轮次时间轴
         │
Wave 2  活章与不清空
  2.1 clear/新回合 = 封上章开新章  ∥  2.2 正在做 + 底栏会话累计
         │
Wave 3  回填与检查点对齐
  3.1 全会话 hydrate ──→ 3.2 回滚截断 / 点检查点滚到章
         │                 3.3 工具行跳聊天（跳不到也不复制原文）
         │
Wave 4  标记、走查、验收
  4.1 监管/压缩/熔断/停止/子代理标记  ──→  4.2 §12 五条 + 走查用例
```

建议合并：

| 批次 | 包含 | 合并门槛 |
|------|------|----------|
| **PR-A** | Wave 0 + Wave 1 | 静帧目录可看；空会话干净；无任务图的问答也占一行 |
| **PR-B** | Wave 2 | 连说两句是两章；活章有「正在做」；底栏工具对得上 |
| **PR-C** | Wave 3 + Wave 4 | 刷新/旧会话/回滚/移动端走查通过；§12 五条用眼睛成立 |

---

## Wave 0 — 视图模型

覆盖：效果文档 §1、§2、§3、§9 短问答形态（数据层）。

### 任务 0.1 — 章 / 轮 / 工具行装配

| 项 | 内容 |
|----|------|
| **依赖** | 无 |
| **新建** | `src/public/js/etl-chronicle.js`（IIFE，挂 `window.EtlChronicle`） |
| **修改** | `src/public/js/main.js`（在 `chat-execution-plan.js` 之前 import） |

**输入（只读，调用方已有）**

- UI 消息（用户句切章；摘要用用户正文短截，去掉技能标签墙）
- structured（每句用户之后的 assistant 轮 = 一轮；`toolCalls` = 该轮工具）
- 可选：检查点时间轴 `entries[].messageId`（与章对齐，缺档仍按用户句成章）
- 可选：当前任务图（只填**当前章**的目标 / 阶段；历史章没有就留空）

**输出**

```text
chapters[]          时间正序，最新在最后
  messageId
  preview           用户句短摘要
  status            running | done | failed | paused | stopped
  roundCount
  filesChangedCount 由本章写类工具去重路径得出；0 则调用方不展示「改 N 个文件」
  durationMs
  markers[]         仅当输入里已有：supervision | compaction | circuit | subagent
  rounds[]
    iteration       本章内从 1 计（不是跨会话全局轮号）
    title           由已有 PHASE_LABELS 思路推导：收集上下文 / 实施修改 / 验证结果 / 整理结论
    status / durationMs
    tools[]         意图一句 + 路径或命令短预览 + 耗时 + 成败 + toolCallId
```

**Checklist**

- [ ] 按用户消息切章；没有任务图的问答章也输出一行，`rounds` 可为 1 条「整理结论」或空
- [ ] 只说过话、还没有 assistant：章 `status=running`，`rounds=[]`
- [ ] 空输入 → `chapters=[]`（UI 显示「等待模型开始执行」）
- [ ] 工具行不含 stdout / diff / 思考正文
- [ ] 写类工具计入 `filesChangedCount`；只读/搜索不计入
- [ ] 不读写 session 文件、不 fetch

### 任务 0.2 — 装配单测 ∥ 0.1 完成后

| 项 | 内容 |
|----|------|
| **依赖** | 0.1 |
| **新建** | `test/public/etl-chronicle.test.ts` |

**Checklist**

- [ ] 两句用户话 → 两章；第二句不吞第一句的工具
- [ ] 短问答：1 章 1 轮、无写文件字段
- [ ] 一章两轮：第 1 轮有工具，第 2 轮是整理结论
- [ ] 无用户消息 → 空数组
- [ ] 工具预览截断，不出现大段命令输出

**验收**：`npx vitest run test/public/etl-chronicle.test.ts`

**回滚**：删除新建文件，还原 `main.js`。

---

## Wave 1 — 章节目录 UI（静帧）

覆盖：效果文档 §4、§5、§8 空会话、§10.6 移动端目录形态。

### 任务 1.1 — 目录骨架

| 项 | 内容 |
|----|------|
| **依赖** | Wave 0 |
| **修改** | `src/public/js/chat-execution-plan.js`、`src/public/css/chat-execution-plan.css` |
| **测试** | `test/public/chat-execution-plan-observer.test.ts`、`test/public/etl-integration.test.ts`（改选择器，避免继续断言旧轮次根节点） |

**Checklist**

- [ ] 执行流默认渲染章节目录，不是一长串工具
- [ ] 最新一章在最下；进入时滚到最新
- [ ] 折叠章可见：摘要、状态、轮数、改文件数（有才写）、标记（有才写）、耗时
- [ ] 当前章（最后一行）默认展开；更早的章默认收起
- [ ] 空会话：一句「等待模型开始执行」，没有假卡片
- [ ] 工作台标题、监管条、Tab、底栏外壳不动
- [ ] 移动端 sheet 同样是章目录；不把检查点塞进执行流
- [ ] 执行流 DOM **没有**恢复按钮、打开文件按钮
- [ ] 去掉「轮次 1–N 未载入 · 去聊天区展开」（改由 Wave 3 真正补齐；本任务先不准再画出这条 hint）
- [ ] `#etl-task-overview` 不再作为面板级常驻块；有任务图时只出现在**展开章**的章头

### 任务 1.2 — 展开一章

| 项 | 内容 |
|----|------|
| **依赖** | 1.1 |
| **修改** | 同 1.1 |

**Checklist**

- [ ] 展开后单位是 Harness 一轮，不是聊天气泡
- [ ] 先看到轮次标题，不是 `read_file` 这种工具名
- [ ] 再展开一轮才看到工具清单
- [ ] 「整理结论」挂在章内最后一轮，不是面板里唯一一张卡
- [ ] 有任务图：章头「目标 / 阶段 / 进度」；没有则只有摘要和统计
- [ ] 超长会话：更早的章保持一行；提供「加载更早的章节」（可先只改文案与分页接口，数据在 Wave 3 接全量 hydrate）

**验收**：静帧 fixture 能画出效果文档 §4 / §5 的结构；`npx vitest run test/public/etl-integration.test.ts test/public/chat-execution-plan-observer.test.ts`

**回滚**：还原上述 JS/CSS/测试。

---

## Wave 2 — 活章与不清空

覆盖：效果文档 §6、§11、§12.1 / §12.3。

### 任务 2.1 — 新回合封章，不擦历史

| 项 | 内容 |
|----|------|
| **依赖** | Wave 1 |
| **修改** | `src/public/js/chat-execution-plan-bridge.js`、`src/public/js/chat-execution-plan.js` |
| **测试** | `test/public/etl-bridge-lifecycle.test.ts`、`test/public/etl-integration.test.ts` |

**现状**：`onNewTurnStarted` 与 `execution_plan_clear` 调用 `clearPlanStateForSession` → 面板清空。

**目标**

- 上一章打上完成或停止，收起。
- 底下出现新章，进入进行中。
- 上面的历史章节都还在。
- Harness 仍可发 `execution_plan_clear`；**不要**为了 UI 去改 `src/harness/harness.ts` 事件发射。

**Checklist**

- [ ] `clear()` 不再是默认的「整本编年史扔掉」；若保留 `clear`，须显式区分 `resetSession`（切会话 / 清会话）与 `sealChapter`（新回合）
- [ ] 切到另一个 session 才换一本编年史
- [ ] `GET /plan` 的上一轮任务图不得覆盖历史章；只更新当前章章头
- [ ] localStorage 快照若仍写，只能当瞬时缓存，且必须按章结构存；刷新权威仍走 hydrate（Wave 3）

### 任务 2.2 — 正在做 + 底栏累计 ∥ 可与 2.1 后半并行

| 项 | 内容 |
|----|------|
| **依赖** | 1.2 |
| **修改** | `src/public/js/chat-execution-plan.js` |

**Checklist**

- [ ] 当前章状态「进行中」；轮次往下长
- [ ] 章头「正在做」：当前工具 + 文件或命令 + 已耗时（现有 `#etl-current-step` 挪进当前章，不要再单独占满一屏）
- [ ] 当前轮次自动展开；刚结束的轮次收成一行
- [ ] 上一章冻结：不再闪、不再改统计
- [ ] 底栏：**上下文**仍是此刻窗口；**工具** = 各章合计；**时间** = 本会话有工作在跑或已跑过的累计墙钟（不是单章秒表）
- [ ] 章耗时写在章行上
- [ ] 取消或放宽「整面板最多 100 条工具 / 50 轮」的全局裁剪；改成按章分页或按章上限，避免「页脚 20、中间只有整理结论」

**验收**：连发两句用户话（fixture 或集成测）侧栏两章；活章有正在做；工具数与各章合计一致。

**回滚**：还原 bridge + panel；Harness 无改动故无需回滚后端。

---

## Wave 3 — 回填与检查点对齐

覆盖：效果文档 §7、§8、§10.1–§10.5。

### 任务 3.1 — 全会话 hydrate

| 项 | 内容 |
|----|------|
| **依赖** | Wave 2 |
| **修改** | `src/public/js/chat-execution-plan.js`、`src/public/js/chat-page.js`（仍调用 hydrate，参数改为全量 structured + UI 消息）、`src/public/js/chat-execution-plan-bridge.js` |

**现状**：`sliceCurrentTurnStructured` 从最后一条 `role=user` 切开。

**Checklist**

- [ ] 删除「只 hydrate 当前问」；用 Wave 0 装配器吃完整 structured + UI 消息
- [ ] 打开旧会话、不说话：已是多章目录
- [ ] 刷新 / 晚开：已结束章直接齐；正在跑的章接到当前 WS 进度（实时事件仍只写入**当前章**，不覆盖冻结章）
- [ ] 聊天折叠里的历史工具出现在对应章的对应轮次下
- [ ] 页脚工具数与目录合计一致
- [ ] hydrate **不覆盖**正在进行的实时 tool/round 记录

### 任务 3.2 — 回滚截断与点检查点预览

| 项 | 内容 |
|----|------|
| **依赖** | 3.1 |
| **修改** | `src/public/js/chat-execution-plan.js`（检查点节点 click）、必要时 `src/public/js/chat-ws-restore-handlers.js`（restore 成功后重新 hydrate，不手改编年史） |

**Checklist**

- [ ] 恢复检查点后：再 hydrate，后面的章消失（因为会话文件已被截断；UI 不要自己删章却留下旧数据）
- [ ] 点检查点时间轴某一档、**仍停在执行流 Tab**：目录滚到对应章并展开（只读预览）
- [ ] 恢复按钮仍只在检查点 Tab
- [ ] 执行流里仍然没有恢复 UI

### 任务 3.3 — 工具行跳转聊天

| 项 | 内容 |
|----|------|
| **依赖** | 1.2 |
| **修改** | `src/public/js/chat-execution-plan.js`、必要时 `src/public/js/chat-ui.js` 增加只读 `scrollToToolCall(toolCallId)` |

**Checklist**

- [ ] 点工具行：若聊天区有对应 `data-tool-call-id`，滚到那条
- [ ] 找不到：不在执行流复制 stdout / diff
- [ ] 不打开文件

**验收**：`hydrateFromStructured` 相关测试改为多用户句；restore 后章数与检查点 cursor 之后一致。

---

## Wave 4 — 标记与验收

覆盖：效果文档 §6 监管条 vs 章标记、§9、§10、§12。

### 任务 4.1 — 章标记与子代理

| 项 | 内容 |
|----|------|
| **依赖** | Wave 3 |
| **修改** | `src/public/js/chat-execution-plan.js`、`src/public/css/chat-execution-plan.css` |

**Checklist**

- [ ] 会话级监管条仍在面板顶（当前是否处于监管）；章内用标记，不每轮刷永久黄条
- [ ] 压缩：章上小标记「本章发生过压缩」；不展示压缩摘要正文
- [ ] 失败 / 用户停止 / 熔断：章徽章对应文案；展开看到最后一轮哪次工具红了或「用户停止 / 熔断保护」；不打错误栈
- [ ] 子代理：章内一行「分析中 / 分析已就绪」；点击若跳转，去聊天区那条摘要

输入里没有这些信号时，标记不出现（「有才写」）。**禁止**为了徽章去改 Harness 事件或 session 字段。

### 任务 4.2 — 走查测试

| 项 | 内容 |
|----|------|
| **依赖** | 4.1 |
| **修改 / 新建** | `test/public/etl-integration.test.ts`、`test/public/etl-bridge-lifecycle.test.ts`、按需 `test/public/etl-chronicle-ui.test.ts` |

用眼睛 / 自动化对齐效果文档 §12：

1. 连说两句 → 两章，不是第二句擦掉第一句
2. 折叠像目录，展开才像施工记录
3. 不再出现「页脚工具 20、中间只有整理结论、叫人去聊天区翻历史」
4. 执行流里找不到「打开文件」「恢复检查点」
5. 空会话干净；长会话能往回翻章，而不是一屏几百条工具

另补 §10 走查：旧会话打开、新章追加、正在做、回滚后截断、跳转聊天、移动端 sheet。

**验收**：相关 `test/public/etl*.test.ts` 与 `chat-execution-plan-observer.test.ts` 全绿。

---

## 5. 文件改动索引（全集，按权限）

| 路径 | Wave | 作用 |
|------|------|------|
| `src/public/js/etl-chronicle.js` | 0 | **新建** 纯装配 |
| `src/public/js/main.js` | 0 | 增加 import |
| `test/public/etl-chronicle.test.ts` | 0 | **新建** 装配单测 |
| `src/public/js/chat-execution-plan.js` | 1–4 | 目录 / 活章 / hydrate / 跳转 / 标记 |
| `src/public/css/chat-execution-plan.css` | 1, 4 | 章行、展开、标记 |
| `src/public/js/chat-execution-plan-bridge.js` | 2, 3 | clear→封章；hydrate 入参 |
| `src/public/js/chat-page.js` | 3 | 全量 hydrate 调用 |
| `src/public/js/chat-ui.js` | 3 | 可选：`scrollToToolCall` |
| `src/public/js/chat-ws-restore-handlers.js` | 3 | 可选：restore 后触发 hydrate |
| `src/public/js/chat-execution-flow-store.js` | 2–3 | 仅当快照结构改成按章；仍非权威 |
| `test/public/etl-integration.test.ts` | 1–4 | 选择器与场景 |
| `test/public/etl-bridge-lifecycle.test.ts` | 2–4 | 不再断言 clear 擦掉历史章 |
| `test/public/chat-execution-plan-observer.test.ts` | 1–4 | Observer 红线仍成立：异常不冒泡 |

**默认不要动**

- `src/harness/**`（含 `execution_plan_clear` 发射）
- `src/memory/**`、`src/types/intent-checkpoint.ts`、`src/types/runtime-checkpoint.ts`
- `src/web/routes/sessions.ts` 的 checkpoint / plan 写路径（只读 GET 保持原样）
- 聊天区消息气泡、diff、思考折叠
- 检查点恢复协调器与 Intent Checkpoint 存储

---

## 6. 与检查点 / 聊天的分工（实现时不要做反）

| 区域 | 本任务可做 | 本任务不可做 |
|------|------------|--------------|
| 聊天 | 点工具行滚动到已有 trace | 在侧栏复制原文 |
| 执行流 | 章目录、轮次、工具短预览 | 恢复、打开文件、打断、改提示 |
| 检查点 | 点档位 → 滚到对应章（人还在执行流 Tab 时） | 把恢复按钮搬进执行流 |

同一根轴：用户每一句话 = 执行流一章 = 检查点一个点。对齐用已有 `messageId`，不要第二套 ID。

---

## 7. 每 Wave 验证

```bash
# Wave 0
npx vitest run test/public/etl-chronicle.test.ts

# Wave 1+
npx vitest run test/public/etl-chronicle.test.ts \
  test/public/etl-integration.test.ts \
  test/public/etl-bridge-lifecycle.test.ts \
  test/public/chat-execution-plan-observer.test.ts
```

人工（PR-C 必做）：打开已有多轮会话 → 不发消息先看目录 → 再发一句看新章 → 切检查点回滚 → 回到执行流确认后章消失。

---

## 8. 验收对照（效果文档 §12）

不必看代码，用眼睛判断：

1. 连说两句用户话，侧栏是两章，不是第二句把第一句擦掉。
2. 一章折叠时像目录，展开才像施工记录。
3. 再也不会出现「页脚工具 20、中间只有整理结论、叫人去聊天区翻历史」。
4. 执行流里找不到「打开文件」「恢复检查点」。
5. 空会话干净；长会话能往回翻章，而不是一屏几百条工具。

满足这五条，任务结束。不要顺手重构 Harness 或记忆系统。

---

## 9. Forbidden Changes（Agent 执行红线）

- 不允许修改 session / checkpoint 写入 schema
- 不允许新增编年史权威落盘
- 不允许在执行流 Tab 加入恢复或打开文件
- 不允许展示思考 / stdout / diff
- 不允许为了徽章或标题去改 Harness 事件载荷
- 不允许把「加载更早的章节」做成一次性摊开全部工具
- 不允许修改范围外文件「顺便整理」

---

## 10. Agent Prompt 片段

复制时把 `{WAVE}` 换成任务编号。

```text
执行 docs/requirement/执行流-最终效果-任务拆分.md 的任务 {WAVE}。

依据：docs/requirement/执行流-最终效果.md（效果为准）。
只改该任务列出的文件。遵守文档 §2 硬约束与 §9 Forbidden。

编年史 = 已有 session 数据的只读 UI，不改会话落盘。
execution_plan_clear 由前端解释为封章，不要改 harness.ts。

完成后列出：修改文件、测试命令、与效果文档哪几条对应、未做事项。
```

Wave 0 追加：只做纯函数与单测，不改 DOM。  
Wave 1 追加：只做静帧目录；不要接新回合不清空（那是 Wave 2）。  
Wave 2 追加：不要做全量 hydrate（那是 Wave 3）；先保证同一次打开里连说两句是两章。  
Wave 3 追加：restore 后重新读会话数据，不要在 UI 里手动删章。  
Wave 4 追加：没有信号就不要画标记；对照 §12 五条补测。
