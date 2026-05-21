# iceCoder 双模（Supervisor / Execution Mode）完整测试手册

> **适用范围**：双模方案 **V1.3.7** 已落地功能（L1 Execution Mode + L2 Runtime Supervisor）。  
> **权威规格**：[`双模方案2.md`](./双模方案2.md) · **流程图**：[`双模 L2 流程图.md`](./双模%20L2%20流程图.md) · **缺口/验收边界**：[`双模落地缺口.md`](./双模落地缺口.md)

本文档包含：**自动化回归命令**、**Web 手工联调**、**6 场景端到端**、**附录 B 可执行检查项**。每项均写明 **前置条件** 与 **操作步骤**，并给出 **通过标准**。

---

## 1. 测试前准备

### 1.1 环境条件

| 条件 | 要求 |
|------|------|
| Node.js | ≥ 18 |
| 依赖 | 已执行 `npm install` |
| 编译 | `npx tsc --noEmit` 无 error |
| LLM（Web/CLI 真实任务） | `data/config.json` 中至少一个可用 provider（API Key 有效） |
| 工作目录 | 仓库根目录 `iceCoder`（含 `src/`、`data/`） |

### 1.2 双模相关配置

| 配置项 | 路径 / 方式 | 说明 |
|--------|-------------|------|
| **监管档位** | `data/config.json` → **`supervisorMode`** | `off` \| `adaptive` \| `strict`；Web 顶栏三态按钮可改 |
| **监管参数** | `data/supervisor-config.json` | 可参考 `data/supervisor-config.example.json`；缺省回落内置默认 |
| **影子模式（可选）** | 环境变量 `ICE_SUPERVISOR_SHADOW=1` | 跑评估链但不改 `supervisorPhase` |
| **参数文件路径（可选）** | `ICE_SUPERVISOR_CONFIG_PATH` | 覆盖 supervisor-config 位置 |

**注意**：`supervisorMode` 写入 **`config.json`**，不再使用 `ICE_SUPERVISOR_MODE` 环境变量。切换档位后 **下一条新消息** 起生效（WebSocket 会话内已创建的 Harness 实例不 retroactive）。

### 1.3 可观测性文件（测试后检查）

| 文件 | 内容 |
|------|------|
| `data/runtime/telemetry.jsonl` | `execution_mode_enter` / `execution_mode_exit` |
| `data/runtime/supervisor-events.jsonl` | L2 Timeline（switch / recover / failure / shadow_diagnostic 等） |
| `data/sessions/*.checkpoint.json` | checkpoint 恢复、`supervisorPhase`、execution mode 快照 |

### 1.4 启动 Web 服务

```bash
npm run iceCoder
# 或开发：npm run dev:api + npm run dev:web
```

浏览器打开聊天页（默认 CLI **3784** 或见终端输出）。确认顶栏 **连接绿点**、**监管模式按钮**（自由/自适应/严格）、**冰豆** 可见。

---

## 2. 自动化回归（必跑）

### 2.1 全量

**条件**：无特殊 env；CI / 发版前必跑。

```bash
npx tsc --noEmit
npm test
```

**通过标准**：0 error；全部用例 green（基线约 **1150+**，以终端为准）。

### 2.2 双模专项（推荐每次改 supervisor/ 后跑）

**条件**：同上。

```bash
npm test -- test/e2e/dual-mode-scenarios.test.ts
npm test -- test/harness/execution-mode-harness.test.ts
npm test -- test/harness/execution-mode-acceptance.test.ts
npm test -- test/harness/recovery-boundary.test.ts
npm test -- test/harness/supervisor-bridge.test.ts
npm test -- test/harness/harness-round-prep-first-graph.test.ts
npm test -- test/web/routes/supervisor-events.test.ts
```

**通过标准**：上述文件全部 PASS。

### 2.3 off 模式零回归

**条件**：Harness 集成测试不注入 supervisor 或 `supervisorMode=off`。

```bash
npm test -- test/harness/harness.test.ts
npm test -- test/harness/execution-mode-harness.test.ts
```

**通过标准**：与双模接入前行为一致；off 时不应出现 `execution_mode_enter` 步骤（见 execution-mode-harness 对应用例）。

---

## 3. 三档模式基础验证（Web + CLI）

### 3.1 档位切换与持久化

| 项 | 内容 |
|----|------|
| **条件** | Web 已连接；当前在聊天页 |
| **步骤** | 1. 点击顶栏监管按钮，循环 **自由 → 自适应 → 严格** 各一次<br>2. 刷新页面<br>3. 打开 `data/config.json` 查看 `supervisorMode` |
| **通过标准** | 按钮文案与 `data-mode` 一致；冰豆眼色对应（自由 `#88EDC7` / 自适应 `#86E0FF` / 严格 `#F1A8B2`）；切换时气泡 **「当前模式：…」**；刷新后档位保持 |

### 3.2 off（自由）— 与旧 Harness 等价

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode`: **`off`**；普通工程问题 |
| **步骤** | 1. 顶栏切到 **自由**<br>2. 发送：「阅读 `README.zh-CN.md` 并总结 §3.6 双模一节」<br>3. 观察是否仅有常规模型/tool 行为 |
| **通过标准** | 无 **forced** 状态 chip；`telemetry.jsonl` 无新的 `execution_mode_enter`；无 L2 takeover 类 System 强注入 |

### 3.3 adaptive（自适应）— 默认档

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode`: **`adaptive`** |
| **步骤** | 1. 顶栏 **自适应**<br>2. 发送场景 B prompt（见 §5.2）<br>3. 再发送场景 C 类 multi-write prompt（见 §5.3） |
| **通过标准** | B 可能全程 **free**；C 类应出现 **forced** 或 takeover 信号；adaptive 首轮关键 intent **不应** `task_graph_init`（§I3） |

### 3.4 strict（严格）— 全程强约束

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode`: **`strict`** |
| **步骤** | 1. 顶栏 **严格**<br>2. 发送：「在 `src/harness/` 下新增一个小工具函数并写单测」<br>3. 观察首轮是否初始化任务图 |
| **通过标准** | 尽早进入 **forced**；首轮关键 intent 出现 **`task_graph_init`**；冰豆眼色为严格色 |

### 3.5 shadow 影子模式（可选）

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode=adaptive`；进程 env **`ICE_SUPERVISOR_SHADOW=1`**；重启服务 |
| **步骤** | 1. 触发易接管任务（连续工具失败或多文件编辑）<br>2. 查 `supervisor-events.jsonl` 与 `~supervisor` |
| **通过标准** | timeline 有 **`shadow_diagnostic`** 或等价记录；UI **不**长期停留在 takeover 相位；`supervisorPhase` 不因 shadow 改写 |

---

## 4. Web UI 与可观测性

### 4.1 Execution Mode 前端（P3-2）

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode` 为 `adaptive` 或 `strict`；任务触发 **forced** |
| **步骤** | 1. 发送多步编辑类任务直至 forced<br>2. 看冰豆底部 **#status-turn** 区域<br>3. 点击/悬停 forced chip（若有 popover） |
| **通过标准** | 出现 **forced · &lt;原因&gt;**；popover 展示 `primaryReasonHuman` 与 `enteredBy` 信号列表 |

### 4.2 `~supervisor` 报告（P3-5）

| 项 | 内容 |
|----|------|
| **条件** | 已跑过至少一轮含双模的任务 |
| **步骤** | 1. 聊天输入 `~supervisor`<br>2. 再试 `~supervisor days=1 limit=20`<br>3. 再试 `~supervisor event=recover` |
| **通过标准** | 返回 Markdown 报告：Execution Mode 进入/退出次数、最近 forced 记录、Timeline 聚合；过滤参数生效 |

### 4.3 HTTP API

| 项 | 内容 |
|----|------|
| **条件** | API 服务运行中 |
| **步骤** | `GET /api/supervisor/events?days=7&limit=10`<br>`GET /api/supervisor/events?format=json` |
| **通过标准** | JSON `success: true`；`report` 或结构化 `timeline` / `executionMode` 字段合理 |

### 4.4 档位 API

| 项 | 内容 |
|----|------|
| **条件** | 同上 |
| **步骤** | `PATCH /api/config/supervisor-mode` body `{"supervisorMode":"strict"}`<br>`GET /api/config` 查看 `supervisorMode` |
| **通过标准** | PATCH 返回 `success: true`；GET 与磁盘 `config.json` 一致 |

---

## 5. 六场景端到端（任务执行文档 · 规格验收核心）

与自动化 **`test/e2e/dual-mode-scenarios.test.ts`** 对齐。手工联调时使用 **真实 LLM + 真实工具**；判定以 **UI + JSONL + 步骤事件** 为准。

**通用步骤（每场景）**：

1. 按场景设置 `supervisorMode` 与（若需要）`supervisor-config.json` 阈值。  
2. **新建或清空会话**（避免旧 checkpoint 干扰，场景 E 除外）。  
3. 发送指定 **用户 prompt**，允许模型多轮 tool 调用直至结束或明显停滞。  
4. 记录：`execution_mode_enter/exit` WebSocket 步骤、冰豆 forced chip、`telemetry.jsonl` 末几条、`supervisor-events.jsonl`（若有 L2 事件）。  
5. 对照 **通过标准** 勾选。

---

### 5.1 场景 A — 纯读取（必须 free）

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode`: **`adaptive`**（或 `strict` 下仅只读工具也可作对照）；intent 为 inspect/question 类 |
| **Prompt** | `请分析 src/harness/harness.ts 的架构` |
| **步骤** | 1. 确认 adaptive<br>2. 发送 prompt<br>3. 确保模型调用 **read_file / search** 等只读工具，**不要**主动要求大改代码 |
| **通过标准** | 全程 **`executionMode=free`**；无 `execution_mode_enter` 或 enter 后仍为 free；无 `task_graph_init`（adaptive）；Timeline 无 forced switch |

**自动化**：`dual-mode-scenarios` · `A · 纯读取`

---

### 5.2 场景 B — 小编辑（可 free）

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode`: **`adaptive`**；单文件、单次写入 |
| **Prompt** | `修改 logger 中一处字符串`（或等价小编辑，如改 `src/harness/logger.ts` 一条 log 文案） |
| **步骤** | 1. adaptive + 新会话<br>2. 发送 prompt<br>3. 观察首轮是否有 task graph |
| **通过标准** | **§I3**：首轮 **无** `task_graph_init`；若仅 1 个 write target 且未达 multi-write 阈值，**可保持 free**；若进入 forced，记录 `enteredBy` 原因供分析 |

**自动化**：`dual-mode-scenarios` · `B · 小编辑`

---

### 5.3 场景 C — 新增模块（应 forced）

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode`: **`strict`**（推荐）或 `adaptive` + 多 write 信号 |
| **Prompt** | `新增 branch tracker 模块`（或：在 `src/harness/` 新增 `branch-tracker.ts` 并导出 API） |
| **步骤** | 1. strict + 新会话<br>2. 发送 prompt<br>3. 等待首轮结束或 graph 初始化 |
| **通过标准** | 出现 **`task_graph_init`**（strict）；**`execution_mode_enter`** 且 `executionMode=forced`；`enteredBy` / `primaryReasonHuman` 非空 |

**自动化**：`dual-mode-scenarios` · `C · 新增模块`

---

### 5.4 场景 D — 多文件重构（forced + modeLock）

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode`: **`strict`**；`supervisor-config.json` 中 `executionMode.modeLockRounds` ≥ 2（默认即可） |
| **Prompt** | `重构 task graph checkpoint 相关代码` |
| **步骤** | 1. strict + 新会话<br>2. 发送 prompt<br>3. 观察进入 forced 后 2 轮内是否因「表面稳定」立刻退出 |
| **通过标准** | **forced** 进入；`executionModeLockRemaining > 0`（checkpoint 或 telemetry 可见）；modeLock 窗口内不因 exit 信号立刻降 free |

**自动化**：`dual-mode-scenarios` · `D · 多文件重构`

---

### 5.5 场景 E — checkpoint 恢复（必须 forced）

| 项 | 内容 |
|----|------|
| **条件** | 已有 **含 runtimeV2 / execution mode 快照** 的 checkpoint；或手工复制测试 fixture 的 checkpoint 结构 |
| **Prompt** | `从中断处继续实现` |
| **步骤** | 1. **先**在 adaptive 下跑一轮多步任务并中断（或保留 `{sessionId}.checkpoint.json`）<br>2. 重启服务或刷新后 **带历史消息** 恢复同 session<br>3. 发送恢复 prompt |
| **通过标准** | 恢复后 **`enteredByPrimary=checkpoint_resumed`**（或 `enteredBy` 含该信号）；**必须 forced**；不可停留在 free 忽略 checkpoint |

**自动化**：`dual-mode-scenarios` · `E · checkpoint 恢复`（`seedCheckpointResume`）

**手工提示**：若难以稳定制造 checkpoint，以自动化用例 PASS + 抽查 `data/sessions/*.checkpoint.json` 内 execution 字段为准。

---

### 5.6 场景 F — graph 构建失败（degraded forced）

| 项 | 内容 |
|----|------|
| **条件** | **forced** 段或 strict 首轮需 init graph；graph builder **故意失败**（仅建议自动化/开发环境） |
| **Prompt** | `新增 logger 工具模块` |
| **步骤** | 1. 使用测试 mock（见 `dual-mode-scenarios` 场景 F）或临时注入会抛错的 GraphExecutor<br>2. 在 **forced** 下触发 `initGraph` |
| **通过标准** | **`forcedDegradedTier=graph`**（或 recovery_pending）；**仍保持 forced**（forced 段 init 失败路径）；timeline 含 **failure/recover** 类事件 |

**自动化**：`dual-mode-scenarios` · `F`（两条：forced 段 / strict 首轮）

**已知缺口（文档备查）**：strict **首轮** graph init 失败时，部分路径下 `executionMode` 仍为 `free` 且 `markForcedDegraded` rethrow — 以自动化场景 F 为准，手工不作为 blocking。

---

## 6. L2 接管链路（takeover / handoff / budget）

适合 **adaptive + 真实失败任务** 或阅读 **`supervisor-bridge.test.ts`** 覆盖。

### 6.1 takeover → 模板图或强提示

| 项 | 内容 |
|----|------|
| **条件** | `supervisorMode=adaptive`；`triggers.toolRepeatFailMin=2` 等默认触发器 |
| **步骤** | 1. 发送易失败任务（如让模型反复调用不存在路径）<br>2. 连续 2+ 轮工具失败后继续<br>3. 查 `supervisor-events.jsonl` |
| **通过标准** | `supervisorPhase` 进入 **takeover**；timeline 含 **recover:template_graph** 或 **recover:strong_hint**；仅 **一条** takeover 类 System 注入（CorrectionPort） |

### 6.2 handoff → cooldown

| 项 | 内容 |
|----|------|
| **条件** | 已完成 6.1 takeover；任务后续趋于稳定 |
| **步骤** | 1. 继续任务直至模型连续成功完成步骤<br>2. 观察 phase 变化 |
| **通过标准** | phase 经 **handoff_pending → handoff → cooldown**；cooldown 内不立即二次 takeover |

### 6.3 恢复预算耗尽 → user_checkpoint

| 项 | 内容 |
|----|------|
| **条件** | 调低 `params.adaptiveTakeover.maxRecoveryRounds` 为 1（`supervisor-config.json`）并重启 |
| **步骤** | 1. 触发 takeover<br>2. 持续失败直至 budget 耗尽 |
| **通过标准** | Harness **stopReason** 含 **user_checkpoint**；timeline **failure**；会话可人工恢复 |

### 6.4 RecoveryBoundary（inject 门禁）

| 项 | 内容 |
|----|------|
| **条件** | 自动化即可 |
| **步骤** | `npm test -- test/harness/recovery-boundary.test.ts` |
| **通过标准** | 64 矩阵全 PASS；free 段拒绝 takeover block；takeover 段仅 supervisor 源 |

---

## 7. 附录 B 检查表（可手工勾选 subset）

摘自 [`双模方案2.md` 附录 B](./双模方案2.md#附录-b验收检查表)。「自动化」列指出是否已有单测/集成测覆盖。

### 7.1 门禁子集

| # | 检查项 | 建议验证方式 | 自动化 |
|---|--------|--------------|--------|
| B1 | ToolGate block 时 tool 未 execute | 强制 step 与 forbidden tool | supervisor-bridge / harness |
| B2 | skip 时有可见 tool result | 查 msgs / UI tool 卡片 | 部分 |
| B3 | adaptive 关键 intent 第 1 轮无 task_graph_init | 场景 B | ✅ dual-mode-scenarios |
| B4 | takeover 段 C 类 inject 仅 supervisor 源 | grep / timeline | supervisor-bridge |
| B5 | free 段连续失败无多条 System 策略 inject | 场景 6.1 + timeline | 部分 |

### 7.2 Execution Mode 子集

| # | 检查项 | 建议验证方式 | 自动化 |
|---|--------|--------------|--------|
| E1 | 仅 ModeDecisionEngine 写 executionMode | 代码审计 + execution-mode-acceptance | ✅ |
| E2 | L0 只读计划不进入 forced | execution-mode-acceptance | ✅ |
| E3 | pendingStepCount≥2 → forced | execution-mode-acceptance | ✅ |
| E4 | modeLock 2 轮内不 exit | 场景 D | ✅ |
| E5 | I10 min dwell 防闪跳 | execution-mode-harness | ✅ |
| E6 | task-bearing round 后才可 exit | execution-mode-harness | ✅ |
| E7 | takeover 时不可降 free | supervisor-bridge | ✅ |
| E8 | 无 intent 关键词直触 forced | 代码审计（I6） | execution-mode-acceptance |
| E9 | 无业务模块读 ICE_SUPERVISOR_* env | grep 仓库 | 手动 |
| E10 | enter forced 含 enteredBy + primaryReasonHuman | telemetry + UI chip | 部分 |
| E11 | 多 signal 优先级（如 checkpoint_resumed） | 场景 E | ✅ |
| E12 | evaluate 抛错 → failSafe forced | mode-decision 单测 | 部分 |
| E13 | graph build 失败 → forced + degraded | 场景 F | ✅ |

### 7.3 全量验收

| # | 检查项 | 建议验证方式 |
|---|--------|--------------|
| F1 | off 无额外 inject | §3.2 + harness.test |
| F2 | shadow 只记不改 phase | §3.5 |
| F3 | strict 首轮 graph + CorrectionPort hint | §3.4 + §5.3 |
| F4 | adaptive 失败 → takeover | §6.1 |
| F5 | 无重复 branch recover inject | 长会话 + timeline |
| F6 | handoff → cooldown | §6.2 |
| F7 | budget 耗尽 → user_checkpoint | §6.3 |
| F8 | rollback 走 confirm | ⚠️ **未与 Supervisor 串联**（P3-3 缺口） |
| F9 | checkpoint 恢复 phase / timeline | §5.5 |
| F10 | token 开销 shadow 对照 <+5% | 可选 benchmark |

---

## 8. 测试记录模板

```markdown
## 双模测试记录

- 日期：
- 提交/分支：
- Node：
- supervisorMode（config.json）：
- ICE_SUPERVISOR_SHADOW：

### 自动化
- [ ] npx tsc --noEmit
- [ ] npm test
- [ ] dual-mode-scenarios

### 手工
- [ ] 3.1 档位切换 + 冰豆
- [ ] 3.2 off
- [ ] 3.3 adaptive
- [ ] 3.4 strict
- [ ] 5.1 A ~ 5.6 F（勾选）
- [ ] ~supervisor 报告

### 问题
- 
```

---

## 9. 相关文档与测试索引

| 文档 / 测试 | 路径 |
|-------------|------|
| 规格 V1.3.7 | [`双模方案2.md`](./双模方案2.md) |
| L2 流程图 | [`双模 L2 流程图.md`](./双模%20L2%20流程图.md) |
| 6 场景 prompt 来源 | [`任务执行文档.md`](./任务执行文档.md) |
| 审计待办 | [`双模 L2 审计与优化清单.md`](./双模%20L2%20审计与优化清单.md) |
| 环境变量 | [`环境变量.md`](./环境变量.md) |
| e2e 六场景 | `test/e2e/dual-mode-scenarios.test.ts` |
| Execution Mode 集成 | `test/harness/execution-mode-harness.test.ts` |
| T13  acceptance | `test/harness/execution-mode-acceptance.test.ts` |
| Boundary 64 矩阵 | `test/harness/recovery-boundary.test.ts` |
| Bridge 全链路 | `test/harness/supervisor-bridge.test.ts` |

---

## 10. 版本

| 日期 | 说明 |
|------|------|
| 2026-05-21 | 初版：对齐 V1.3.7 落地、config.json `supervisorMode`、P2/P3 自动化与 Web 验收 |
