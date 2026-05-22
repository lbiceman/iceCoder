# iceCoder 双模手工观测手册

> **规格**：[`双模方案2.md`](./双模方案2.md) V1.3.7 · **自动化用例**：`test/e2e/dual-mode-scenarios.test.ts`

本文档给 **Web 聊天手工联调** 用：每项只有四块——**什么模式、复制什么提示词、怎么观察、预期什么结果**。  
发版/改 `supervisor/` 前仍建议跑 §12 自动化回归。

---

## 0. 测前 30 秒（每项通用）

1. `npm run iceCoder`，浏览器打开聊天页，顶栏 **连接绿点** 亮。
2. 顶栏切到本文档指定的 **自由 / 自适应 / 严格**（写入 `data/config.json` 的 `supervisorMode`）。
3. **新建或清空会话**（场景 E 除外），避免旧 checkpoint 干扰。聊天框发 **`~clear`** 可清前端会话；同时建议清磁盘缓存（见 §10.1）。
4. 档位切换后 **下一条新消息** 才生效。
5. **`~clear` 会重置**冰豆底部 `forced · …` 状态（新任务开始时也会自动清 L1 chip，避免上一轮残留）。

### 0.1 实时观测（开第二个终端）

**L1 执行模式（free ↔ forced）**

```powershell
Get-Content data/runtime/telemetry.jsonl -Wait |
  Where-Object { $_ -match 'execution_mode_' }
```

**L2 监管 Timeline（takeover / no_progress 等）**

```powershell
Get-Content data/runtime/supervisor-events.jsonl -Wait
```

**任务结束后汇总**

```text
~supervisor days=1 limit=20
```

### 0.2 页面上看什么

| 看什么 | 在哪 | 表示什么 |
|--------|------|----------|
| 监管档位 | 顶栏按钮 + 冰豆**眼色** | 自由 `#88EDC7` / 自适应 `#86E0FF` / 严格 `#F1A8B2`（**手动选的**，不随 forced 变） |
| L1 forced | 冰豆底部 **`forced · …`** | 已进入强约束执行；悬停看原因与信号 |
| 执行计划面板 | 透明 popover / 任务图 | **TaskGraph 进度 UI**，≠ L1 forced；**off 模式下仍可能出现** |
| 执行计划 25% | 计划 popover 内进度 | **任务图进度**，≠ 模式切换，别用它判断 forced |
| L2 汇总 | 聊天输入 `~supervisor` | 进入/退出次数 + Timeline |

### 0.3 浏览器 DevTools（可选，最准）

F12 → Network → WS → `/api/chat/ws` → Messages，搜 `execution_mode_enter` / `execution_mode_exit`。

---

## 1. 场景 A — 纯读取（adaptive 应全程 free）

**模式**：`adaptive`（顶栏 **自适应**）

**前置**：新会话；模型只做 read/search，不要写代码。

**提示词**（整段复制发送）：

```text
请分析 src/harness/harness.ts 的架构。只用 read_file、search_codebase、delegate_to_subagent 等只读工具，不要修改任何文件，不要写代码。分析完用 10 行以内总结。
```

**如何观察**

- 冰豆底部：**不要**出现 `forced · …`
- 终端 telemetry：无新 `execution_mode_enter`
- `~supervisor days=1 limit=10`：Execution Mode 进入 **0 次**（或本场景时段内无 enter）

**预期结果**

- 全程 **free**
- adaptive 下 **无** `task_graph_init`（首轮不建图，§I3）
- `supervisor-events.jsonl` 无 forced 相关 switch

---

## 2. 场景 B — 单文件小编辑（adaptive 可 free）

**模式**：`adaptive`

**前置**：新会话。

**提示词**：

```text
只做一件事：在 src/harness/logger.ts 里把 loopStart 方法中一条 log 文案最前面加上前缀 [probe-test]，改完运行 npx tsc --noEmit。不要改其他文件。
```

**如何观察**

- 首轮结束后：执行计划里 **不应**在第一条 user 消息后就出现完整五步任务图（§I3 首轮无 graph）
- 冰豆底部：可能无 `forced`（单文件单轮写入可保持 free）
- 若出现 forced：记录 chip 上信号（如 `multi_write`）

**预期结果**

- 首轮 **无** `task_graph_init`（adaptive）
- **可**全程 free；若进入 forced，属可接受，记录 `enteredBy` 即可

---

## 3. 场景 C — 单轮多文件新建（adaptive 应 forced）

**模式**：`adaptive`

**前置**：新会话。本场景要 **同一轮** 创建多个文件，才易触发 `multi_write`。

**提示词**：

```text
在同一轮任务里依次完成，不要分多轮闲聊：
1. 新建 src/harness/_probe-a.ts，export function probeA() { return 'a'; }
2. 新建 src/harness/_probe-b.ts，export function probeB() { return 'b'; }
3. 新建 test/harness/_probe-ab.test.ts，import 上面两个函数并写 2 个 expect 测试
4. 运行 npm test -- test/harness/_probe-ab.test.ts
完成后删除上述 3 个临时文件并再跑一次 tsc。
```

**如何观察**

- 冰豆底部：应出现 **`forced · 多文件写入`** 或类似 chip
- telemetry tail：出现 `execution_mode_enter`，`enteredBy` 含 `multi_write` 或 `task_graph_active`
- `~supervisor days=1 limit=10`：最近进入 forced 有记录，`primaryReasonHuman` 非空

**预期结果**

- **`execution_mode_enter`**，`executionMode=forced`
- adaptive 首轮仍可能 **无** graph（§I3）；forced 由 L1 信号触发，不一定先有任务图面板

---

## 4. 场景 D — strict 首轮建图 + forced

**模式**：`strict`（顶栏 **严格**，冰豆眼色 `#F1A8B2`）

**前置**：新会话。

**提示词**：

```text
在 src/harness/ 下新增一个小工具函数 export function strictProbeTag(): string { return 'strict-probe'; }，并新增对应单测文件，最后 npm test 跑该单测。完成后删除临时文件。
```

**如何观察**

- 首轮：执行计划出现 **任务图 / 执行计划** 步骤（`task_graph_init`）
- 冰豆底部：**尽早**出现 `forced · …`
- telemetry：`execution_mode_enter` 且 `enteredBy` 含 `task_graph_active` 或 `explicit_impl`

**预期结果**

- 首轮有 **`task_graph_init`**
- 尽早 **forced**
- 进入 forced 后 **2 轮内**不因表面稳定立刻变 free（modeLock，默认 2 轮）

---

## 5. 场景 E — checkpoint 恢复（必须 forced）

**模式**：`adaptive`

**前置（两步）**

1. 先跑场景 C 或 D **做到一半**（已改文件、未删临时文件），然后 **刷新页面或重启服务**（保留同 session 历史）。
2. 再发下面提示词。

**提示词**：

```text
从中断处继续实现，不要重新开始，不要清空已有改动。
```

**如何观察**

- 恢复后 **第一条工具轮前后**：telemetry 出现 `execution_mode_enter`
- `enteredByPrimary` 为 **`checkpoint_resumed`**
- 冰豆底部：`forced · checkpoint 恢复` 或类似

**预期结果**

- 恢复后 **必须 forced**，不能一直 free 忽略 checkpoint
- `~supervisor` 最近 forced 列表含 checkpoint 相关信号

---

## 6. 场景 F — 工具连续失败（L2 记录 no_progress）

**模式**：`adaptive`

**前置**：新会话。

**提示词**：

```text
请用 read_file 读取下面这个不存在的路径，若失败则用相同参数再读一次，然后换策略总结错误原因。路径：src/__file_that_does_not_exist__.ts
```

**如何观察**

- telemetry：可能出现 `execution_mode_enter`，`enteredBy` 含 **`tool_failure`**（若当轮被判为非 L0 只读）
- `supervisor-events.jsonl`：出现 **`failure · no_progress:3/4/5…`** 或 **`tool_repeat_fail:2`**
- `~supervisor event=failure days=1`

**预期结果**

- L1：工具失败轮可能 **forced**（视风险档而定；干净会话下常见 **R2 `tool_failure`**，R1 仍 free）
- L2：**至少 1 条**失败信号写入 Timeline（**`no_progress` 或 `tool_repeat_fail` 均可**；任务 3 轮内结束时常为后者）
- **已知缺口**：当前版本 L2 **takeover（recover）** 可能不出现（`TaskContext.domain` 暂为 `non_critical_read`）；**不以 recover 为必达**
- **前置务必清 checkpoint**：否则 R1 可能被 **`checkpoint_resumed`** 抢先 forced，掩盖 `tool_failure` 路径

---

## 7. 场景 G — off 对照（双模关闭）

**模式**：`off`（顶栏 **自由**）

**前置**：新会话。

**提示词**：

```text
请分析 src/harness/harness.ts 的架构，然后修改 logger.ts 里任意一条 log 文案（仅一处），最后 npx tsc --noEmit。
```

**如何观察**

- 冰豆底部：**永不**出现 `forced · …`
- telemetry：**无** 新 `execution_mode_enter`
- `~supervisor days=1`：本场景时段 enter 次数不增加

**预期结果**

- 与未接入双模前行为一致：只有普通 tool 流程，无 Execution Mode 切换
- **TaskGraph 执行计划面板仍可能出现**（与 L1 无关）；通过标准只看 **无 forced chip、无 `execution_mode_enter`**

---

## 8. 场景 H — 长会话压测（可选，约 30～60 轮）

**模式**：`adaptive`

**前置**：新会话；可选 `$env:ICE_HARNESS_MAX_ROUNDS="120"` 后重启服务。

**提示词**：

```text
【双模观测压测】
- 保持 supervisorMode=adaptive，连续执行，目标约 40 轮工具调用。
- Phase1：只读分析 docs/test.md §0 和 src/harness/supervisor/（禁止写文件）。
- Phase2：单文件改 logger 一处字符串 + tsc。
- Phase3：同一轮新建 2 个临时 ts 文件 + 1 个 test 文件，跑 vitest 后删除。
- 每 Phase 结束在回复里写一行：Supervisor观测: executionMode=? / 冰豆底部=? / ~supervisor enter次数=?
- 不要 git commit。
开始 Phase1，直接调用工具。
```

**如何观察**

- 全程开 §0.1 两个 tail 终端
- Phase1 结束：应 **free**
- Phase3：应至少 **1 次** `execution_mode_enter`
- 结束后：`~supervisor days=1 limit=30`

**预期结果**

- Phase1：**free**，无 forced chip
- Phase3：**forced** 至少 1 次
- L2：可能有 `no_progress`；**recover 非必达**（见场景 F 缺口说明）

---

## 9. 结果判定速查

| 场景 | 模式 | 必达现象 |
|------|------|----------|
| A | adaptive | 无 forced；无 enter |
| B | adaptive | 首轮无 graph；可 free |
| C | adaptive | `execution_mode_enter` + forced |
| D | strict | 首轮 graph + forced + modeLock |
| E | adaptive | `checkpoint_resumed` + forced |
| F | adaptive | L1 可能 `tool_failure` forced；L2 有 `no_progress` 或 `tool_repeat_fail` |
| G | off | 无 enter、无 forced chip（任务面板可出现） |
| H | adaptive | Phase1 free；Phase3 至少 1 次 enter |

**不算通过的情况**

- 顶栏是 **off** 却期望 forced
- 用 **执行计划 25%** 判断模式（应看冰豆底部 `forced ·` 或 telemetry）
- 多轮会话混在一起看 `~supervisor`（应用 `days=1` 且新会话测单项）
- 把 **`npm test` 凌晨批量写入** 的 telemetry 当成 Web 手工结果（看时间戳）

---

## 10. A–H 手工联调报告（2026-05-22）

> 环境：Web 聊天 · `npm run iceCoder` · Windows · 模型 z-ai/glm-5.1（NVIDIA API）  
> 观测源：`data/runtime/telemetry.jsonl`、`data/runtime/supervisor-events.jsonl`、冰豆 UI、`~supervisor`

### 10.1 测前清缓存（PowerShell）

每项重跑前（场景 E 第二步除外）：

```powershell
@(
  "data/runtime/telemetry.jsonl",
  "data/runtime/supervisor-events.jsonl",
  "data/memory/telemetry.jsonl"
) | ForEach-Object { Set-Content -Path $_ -Value "" -Encoding UTF8 }

Remove-Item -Force -ErrorAction SilentlyContinue @(
  "data/sessions/default.checkpoint.json",
  "data/sessions/default.json",
  "data/sessions/default.structured.json",
  "data/sessions/session-notes.md"
)
```

UI 再发 **`~clear`**。**不删** `data/config.json`、`data/memory-files/`、`data/user-memory/`。

### 10.2 总览

| 场景 | 模式 | 结论 | 关键证据 |
|------|------|------|----------|
| **A** 纯读取 | adaptive | ✅ 通过 | 全程 free；无 `execution_mode_enter` |
| **B** 单文件改 | adaptive | ✅ 通过 | 首轮无 graph；单 write 全程 free |
| **C** 多文件新建 | adaptive | ✅ 通过 | R2 `multi_write` → forced；R8 `execution_mode_exit` → free |
| **D** strict 建图 | strict | ✅ 通过 | R1 `task_graph_active+pending_steps+explicit_impl` forced；全程无 exit |
| **E** checkpoint | adaptive | ✅ 通过 | R1 `checkpoint_resumed` forced；R4 exit free |
| **F** 工具失败 | adaptive | ⚠️ 部分通过 | 重跑：R2 `tool_failure` forced ✅；L2 为 `tool_repeat_fail:2` 非 `no_progress` |
| **G** off 对照 | off | ✅ 通过 | 无 enter / 无 forced；R1 出现 TaskGraph 面板（正常） |
| **H** 长会话 | adaptive | ✅ 通过 | Phase1 R1–R5 free；Phase3 R9 `multi_write` enter → R12 exit；L2 `no_progress:3/4/5` |

**套件结论**：L0/L1 主链路 **8 场景中 7 项完全通过、1 项（F）L2 信号口径差异**；L2 takeover（recover）全程未触发（已知缺口）。

### 10.3 分场景摘要

#### A — 纯读取

- **UI**：冰豆底部无 `forced`
- **telemetry**：0 次 enter
- **备注**：L2 可能出现 drift / no_progress 类记录，不影响 L1 判定

#### B — 单文件小编辑

- **UI**：全程 free
- **telemetry**：无 enter；adaptive 首轮无完整五步任务图（§I3）
- **备注**：单文件单轮 write 不触发 `multi_write`

#### C — 单轮多文件新建

- **UI**：`forced · 多文件写入`
- **telemetry**：`execution_mode_enter` → `enteredBy: multi_write`；任务收尾 `execution_mode_exit`
- **备注**：forced 由 L1 信号触发，不一定先有任务图面板

#### D — strict 首轮建图

- **UI**：首轮任务面板 + 尽早 `forced`
- **telemetry**：R1 enter，`enteredBy: task_graph_active, pending_steps, explicit_impl`；strict 下无 exit
- **备注**：modeLock 生效，不因表面稳定立刻 free

#### E — checkpoint 恢复

- **前置**：场景 D 中途打断后恢复
- **UI**：`forced · checkpoint 恢复`；约 2 轮后 chip 消失（对应 exit）
- **telemetry**：R1 `checkpoint_resumed` enter；R4 exit free

#### F — 工具连续失败

| 轮次 | 首次（checkpoint 污染） | 重跑（干净会话） |
|------|-------------------------|------------------|
| R1 | `checkpoint_resumed` forced ❌ | free；`read_file` 失败 |
| R2 | 第二次读失败 | **`tool_failure` forced** ✅ |
| R3 | 文本总结 `model_done` | 同上 |
| L2 | `tool_repeat_fail` + drift | `tool_repeat_fail:2` + drift（**无 `no_progress`**） |

- **UI 观测（重跑）**：R2 出现 **`forced · 工具失败`**
- **判定**：L1 ✅；L2 按现行实现记 **`tool_repeat_fail`** 而非 `no_progress`（见 §6 放宽口径）

#### G — off 对照

- **UI**：无 `forced`；**R1 出现 TaskGraph 透明任务面板**（≠ L1 forced，属正常）
- **telemetry / supervisor-events**：全程无 `execution_mode_enter`；supervisor-events 为空
- **业务**：读 harness → 改 logger → tsc → 总结，5 轮完成

#### H — 长会话压测

| Phase | 轮次 | Mode | 要点 |
|-------|------|------|------|
| Phase1 只读 | R1–R5 | free | L2：`no_progress:3/4/5` |
| Phase2 单文件改 | R6–R7 | free | edit logger + tsc |
| Phase3 多文件 | R8–R12 | R9 enter → R12 exit | R8 双 write；R9 `multi_write` forced；R11 删临时文件；R12 exit free |

- **UI 观测**：约 R6–R12 见 **`forced · 多文件写入`**，R12 消失（telemetry enter 在 **R9**，冰豆轮次可能早 2～3 轮，**exit 轮次更准**）
- **规模**：12 轮 / 20 次工具（未达提示词 40 轮，但三 Phase 均完成）

### 10.4 跨场景结论

**已验证**

- L0 顶栏档位（off / adaptive / strict）与 L1 `executionMode`（free / forced）分层正确
- 冰豆**眼色** = L0；冰豆**底部 chip** = L1
- adaptive：只读可 free（A）；多写 forced（C/H）；工具失败可 forced（F）；checkpoint 必 forced（E）
- strict：首轮建图 + 尽早 forced + modeLock（D）
- off：无 L1 切换（G）；TaskGraph 面板仍可独立出现

**已知缺口 / 注意**

| 项 | 说明 |
|----|------|
| L2 takeover | `TaskContext.domain` 写死 `non_critical_read`，recover 难触发；不以 recover 为通过条件 |
| F 的 L2 信号 | 短任务常记 `tool_repeat_fail:2` 而非 `no_progress:3+` |
| UI vs telemetry 轮次 | forced chip 显示轮次可能与 `telemetry.round` 差 1～3；以 telemetry 为准 |
| checkpoint 污染 | 未清 `default.checkpoint.json` 时，无关新任务 R1 可能 `checkpoint_resumed` |
| 工作区残留 | 测试后检查 `logger.ts`、`strict-probe*`、`*probe*` 等；建议 `git restore .` |

### 10.5 测试后清理

```powershell
git status
git restore .
# 如有未跟踪 probe 文件，手动删除 src/harness/_probe-*、test/harness/_probe-* 等
```

---

## 11. L2 纠偏专项（L2-1～L2-7）

> **与 §1–8 的区别**：§1–8 主要验 **L1 Execution Mode**；本节验 **L2 Runtime Supervisor** 的 Timeline 信号、C 类 inject（recovery / graph_hint）、以及（可选）takeover 全路径。  
> **Web 已知缺口**：`harness-tool-round.ts` 中 `TaskContext.domain` 暂为 `non_critical_read`，**L2-7 takeover 在 Web 聊天里几乎测不通**；L2-1～L2-6 仍可测。

### 11.0 测前步骤（每项必做）

1. **清磁盘缓存**（PowerShell，项目根目录）：

```powershell
@(
  "data/runtime/telemetry.jsonl",
  "data/runtime/supervisor-events.jsonl",
  "data/memory/telemetry.jsonl"
) | ForEach-Object { Set-Content -Path $_ -Value "" -Encoding UTF8 }

Remove-Item -Force -ErrorAction SilentlyContinue @(
  "data/sessions/default.checkpoint.json",
  "data/sessions/default.json",
  "data/sessions/default.structured.json",
  "data/sessions/session-notes.md"
)
```

2. 浏览器聊天框发 **`~clear`**（清前端会话 + 冰豆 forced 状态）。
3. 顶栏切到本节场景指定的 **自适应 / 严格**（写入 `data/config.json` 的 `supervisorMode`）。
4. **开 tail 终端**（整段 L2 测试期间保持运行）：

```powershell
Get-Content data/runtime/supervisor-events.jsonl -Wait
```

5. 发送本节 **提示词**（整段复制）。
6. 任务结束后在聊天框执行：

```text
~supervisor event=recover days=1 limit=20
~supervisor event=failure days=1 limit=20
~supervisor event=drift days=1 limit=20
```

### 11.1 推荐顺序

| 顺序 | 场景 | 模式 | 证明什么 |
|------|------|------|----------|
| 1 | L2-1 no_progress | adaptive | L2 在记无进展信号 |
| 2 | L2-3 tool_repeat_fail | adaptive | 信号 + recovery 文案注入 |
| 3 | L2-4 lifecycle | adaptive | 5 轮只读系统纠偏块 |
| 4 | L2-5 graph_hint | **strict** | forced 下 graph 纠偏（最接近「纠偏」） |
| 5 | L2-2 goal_drift | adaptive | 目标漂移检测 |
| 6 | L2-6 file_loop | adaptive | 前置 multi_write 进 forced，再 6 轮同文件 edit |
| 7 | L2-7 takeover | 单测/改码 | 完整接管链（Web 不测） |

### 11.2 L2-1 — no_progress（PassiveObserver）

**模式**：`adaptive`

**步骤**

1. 完成 §11.0 测前步骤。
2. 复制发送下面提示词。
3. 等任务结束（模型总结后停止）。
4. 看 tail：`supervisor-events.jsonl` 是否出现连续 `failure · no_progress:3/4/5…`。
5. 执行 `~supervisor event=failure days=1`。

**提示词**

```text
【L2-观测·no_progress】
连续至少 6 轮工具调用，每轮只用 read_file / fs_operation(list) 读文件。
禁止 write_file、edit_file、run_command。
先读 docs/test.md，再读 src/harness/supervisor/ 下 4 个不同 .ts 文件。
读完后用 5 行总结，不要改任何文件。
Supervisor观测: 每 2 轮汇报一次当前轮次。
```

**如何观察**

- `supervisor-events.jsonl`：`failure · no_progress:3` → `:4` → `:5` …
- 冰豆底部：应 **无** forced（或全程 free）
- 聊天内容：free 段 **通常无** graph_hint 注入

**预期结果**

- Timeline **至少 1 条** `no_progress` ✅
- **无** takeover / `recover · takeover`（Web 缺口，不计 FAIL）

---

### 11.3 L2-2 — goal_drift（目标漂移）

**模式**：`adaptive`

**步骤**

1. 完成 §11.0 测前步骤。
2. 发送提示词；**前 4 轮模型应只读不写**（若模型提前写文件，可 stop 后重发并强调约束）。
3. 任务结束后查 `~supervisor event=drift days=1`。

**提示词**

```text
【L2-观测·goal_drift】
任务：在 src/harness/logger.ts 的 loopStart 日志前加前缀 [drift-probe]。

执行约束（故意偏离）：
- 第 1～4 轮：只允许 read_file，读 docs/、src/harness/supervisor/ 里与 logger 无关的文件；禁止写文件。
- 第 5 轮起：才开始 edit logger + npx tsc --noEmit。
每 Phase 结束写：Supervisor观测: drift=? / no_progress=?
```

**如何观察**

- `supervisor-events.jsonl`：`drift · goal_drift:0.xxx`
- 可能叠加：`failure · no_progress:…`

**预期结果**

- **至少 1 条** `goal_drift` 写入 Timeline ✅
- takeover 非必达

---

### 11.4 L2-3 — tool_repeat_fail + recovery 注入

**模式**：`adaptive`

**步骤**

1. 完成 §11.0 测前步骤。
2. 发送提示词；确认模型 **至少 2 轮同参 read_file 失败**。
3. 在**聊天正文**里找是否出现 `[System] Repeated failed tool call detected`。
4. 查 `~supervisor event=failure days=1` 与 telemetry 是否有 `tool_failure` enter。

**提示词**

```text
【L2-观测·tool_repeat_fail】
请用 read_file 读取 src/__l2_probe_missing__.ts。
若失败，下一轮用完全相同参数再读一次；再失败再读一次（至少 3 轮同参失败）。
第 4 轮起换策略：用 fs_operation list 确认路径不存在，然后总结 ENOENT 原因。
不要写任何文件。
```

**如何观察**

- `supervisor-events.jsonl`：`failure · tool_repeat_fail:2`（或更高）
- 聊天：可能出现 **`[System] Repeated failed tool call detected…`** 纠偏块
- telemetry（可选 tail）：R2 后可能有 `execution_mode_enter` · `tool_failure`
- 冰豆：可能出现 **`forced · 工具失败`**

**预期结果**

- Timeline 有 **`tool_repeat_fail`** ✅
- 聊天或 timeline 体现 **C 类 recovery 到达模型**（二选一即算观察到纠偏路径）✅

---

### 11.5 L2-4 — 5 轮只读 lifecycle recovery

**模式**：`adaptive`

**步骤**

1. 完成 §11.0 测前步骤。
2. 发送提示词；确认前 **5～6 轮只有 read_file**。
3. 在模型回复里找 **`[System] You have been reading/analyzing for 5 rounds`** 原文（提示词要求模型引用）。
4. 第 7 轮起应开始 edit + tsc。

**提示词**

```text
【L2-观测·lifecycle_recovery】
连续 6 轮，每轮只 read_file 读 src/harness/ 下一个不同 .ts 文件。
禁止任何 write/edit/run_command。
第 7 轮才开始：edit logger.ts 一处字符串 + tsc。
若收到 [System] You have been reading/analyzing for 5 rounds… 请在回复里原文引用该句。
```

**如何观察**

- 聊天：**约第 5 轮只读后** 出现 lifecycle 系统纠偏文案
- `supervisor-events.jsonl`：可能有 `no_progress`；**不一定**有 `recover` 事件（lifecycle 源可能不进 recover timeline）

**预期结果**

- 聊天中出现 **5 轮只读系统提示** ✅（本场景核心通过标准）

---

### 11.6 L2-5 — graph_hint 纠偏（strict，重点）

**模式**：`strict`（顶栏 **严格**，冰豆眼色 `#F1A8B2`）

**步骤**

1. 完成 §11.0 测前步骤；**务必切 strict**。
2. 发送提示词；观察首轮是否出现 **任务图面板** + **forced chip**。
3. 故意偏离计划时，看聊天是否收到 **graph 纠偏提示**，或工具是否被 **block**。
4. 查 tail：`recover · graph_hint:evaluate_round`；预算用尽时可能有 `correction_budget_exhausted:graph_hint`。
5. 执行 `~supervisor event=recover days=1`。

**提示词**

```text
【L2-观测·graph_hint】
在 src/harness/ 新增 export function l2GraphHintProbe(): string { return 'l2-probe'; } 及单测，npm test 跑单测，最后删临时文件。

故意偏离执行计划（用于触发 graph_hint）：
1. 不要按任务图顺序：先 write 单测文件，再 write 实现文件。
2. 跳过「先 read 再写」的步骤。
3. 每轮只调用工具，不要长篇解释。
4. 若工具被 block 或收到 graph 提示，在回复里写「收到纠偏: …」并改按提示执行。
```

**如何观察**

- 冰豆底部：尽早 **`forced · …`**
- `supervisor-events.jsonl`：
  - `recover · graph_hint:evaluate_round`（`inject_hint` 或 `block`）
  - 可能：`failure · correction_budget_exhausted:graph_hint`
- 聊天：forced 段出现 **graph 纠偏文案**（经 CorrectionPort）

**预期结果**

- **至少 1 条** `recover · graph_hint:…` ✅  
- 或聊天/工具层可见 **纠偏提示或 block** ✅  
- 这是 Web 端最接近「L2 纠偏」的场景

---

### 11.7 L2-6 — file_loop（同文件反复 edit）

**模式**：`adaptive`

> **重要**：`file_loop` 依赖 **forced 段** 的 branchBudget 计数；free 段连续 edit **不会** 出信号。  
> **重要**：`edit` 类任务会触发 Harness **验证门禁**；`node --check` 不算验证，易导致 70+ 轮不停止——本场景已拆成「前置进 forced + 主测 + 可选 tsc 出口」。

**步骤**

1. 完成 §11.0 测前步骤。
2. **先发「前置提示词」**，等到冰豆底部出现 **`forced · …`**（或 telemetry 有 `execution_mode_enter`）。
3. **再发「主测提示词」**；确认 **连续 6 轮、每轮仅 1 次 `edit_file`**，且只改 `logger.ts`。
4. 第 6 轮 edit 后应能文字总结并结束；若系统仍注入「必须验证」，按主测提示词 **仅跑一次** `npx tsc --noEmit`。
5. （可选）测试前设 `ICE_HARNESS_MAX_ROUNDS=40`，防止再次跑飞。

**前置提示词**（先进 forced，约 1–3 轮）

```text
【L2-6·前置·进 forced】
同一轮任务内依次 write_file 两个极小临时文件（不要 edit、不要 run_command）：
1. src/harness/_l2probe-a.ts  内容：export const l2ProbeA = 1;
2. src/harness/_l2probe-b.ts  内容：export const l2ProbeB = 2;
写完后一句话确认即可，不要删文件、不要测、不要继续别的任务。
```

**主测提示词**（forced 段内 file_loop）

```text
【L2-观测·file_loop】
我已在 forced 段。本任务只观测 L2，不是正式改代码。

只允许 edit_file，且只能改 src/harness/logger.ts。
连续 6 轮：每轮恰好 1 次 edit_file，改一处极小注释或字符串，6 轮位置各不相同。
禁止：read_file、write_file、run_command（含 node --check）、search_codebase、git、file_info、tsc、npm test。

第 6 轮 edit 完成后，下一回复只写 5 行以内总结，不要调用任何工具。
若系统仍注入「You changed files but has not verified」类消息，才允许额外运行一次：npx tsc --noEmit
除此之外禁止任何命令。不要 git commit。
```

**如何观察**

- 冰豆底部：前置后应有 **`forced · …`**；主测阶段保持 forced 更易触发
- `supervisor-events.jsonl`：`failure · file_loop:src/harness/logger.ts:4`（或类似，`fileLoopMin=4`）
- telemetry：主测阶段 **6 次** `edit_file`，不应出现大量 `run_command` 螺旋
- branchBudget 在 **forced** 下才累计同文件 edit 次数

**预期结果**

- Timeline 出现 **`file_loop`** ✅（forced 段第 4 次 edit 后应可见）
- 任务能在 **约 10–15 轮** 内 `model_done` 结束（6 edit + 前置 + 总结；若多 1 轮 tsc 仍正常）
- 若 free 全程 edit、无 forced：记 **未触发**，非 FAIL L1
- 若 again 70+ 轮不停：查 telemetry 是否 `verificationStatus` 一直为 `required`（验证命令未识别）

---

### 11.8 L2-7 — takeover 全路径（Web 不测）

**§9 三条件**（RecoverySupervisor）：

| 条件 | Web 聊天 |
|------|----------|
| `domain` 以 `critical_` 开头 | ❌ 现为 `non_critical_read` |
| `riskScore >= 0.6` | ✅ 编辑类任务通常满足 |
| 有偏离信号 | ✅ L2-1～L2-3 可堆叠 |

**Web 手工预期**：即使 L2-1～L2-3 信号齐全，也 **几乎不会** 出现 `recover · takeover`、takeover 消息块、handoff/cooldown 完整链。

**若要验 takeover，用自动化**：

```bash
npm test -- test/harness/supervisor-bridge.test.ts -t takeover
npm test -- test/e2e/dual-mode-scenarios.test.ts
```

**若要 Web 可测**：需改 `src/harness/harness-tool-round.ts` 的 `buildTaskContextForObserver`，按 intent/写文件映射 `critical_edit` / `critical_debug` 等（发版前单独 PR）。

---

### 11.9 L2 判定速查

| 现象 | 说明 |
|------|------|
| `failure · no_progress:N` | PassiveObserver ✅ |
| `drift · goal_drift:…` | GoalDriftDetector ✅ |
| `failure · tool_repeat_fail:N` | 工具重复失败 ✅ |
| `recover · graph_hint:…` | **forced 段 graph 纠偏** ✅ |
| `failure · correction_budget_exhausted:graph_hint` | I4 预算门禁 ✅ |
| 聊天 `[System] Repeated failed…` | C 类 recovery inject ✅ |
| 聊天 `[System] You have been reading…5 rounds…` | lifecycle recovery ✅ |
| `recover · takeover:…` | Web **当前预期 ❌**（domain 缺口） |

---

## 12. 手工记录（复制填空）

```markdown
## 双模手工记录

- 日期：
- 场景：A / B / C / D / E / F / G / H / **L2-1～L2-7**
- supervisorMode：
- 新会话：是 / 否

### 观测
- [ ] 冰豆 forced chip：
- [ ] telemetry execution_mode_enter 次数：
- [ ] ~supervisor 摘要（粘贴）：

### 结论
- [ ] 通过 / [ ] 未通过
- 备注：
```

---

## 13. 自动化回归（开发/发版用）

```bash
npx tsc --noEmit
npm test
npm test -- test/e2e/dual-mode-scenarios.test.ts
npm test -- test/harness/execution-mode-harness.test.ts
npm test -- test/harness/execution-mode-acceptance.test.ts
npm test -- test/harness/recovery-boundary.test.ts
npm test -- test/harness/supervisor-bridge.test.ts
```

off 零回归：

```bash
npm test -- test/harness/harness.test.ts
npm test -- test/harness/execution-mode-harness.test.ts
```

---

## 14. 相关索引

| 资源 | 路径 |
|------|------|
| 规格 | [`双模方案2.md`](./双模方案2.md) |
| 流程图 | [`双模 L2 流程图.md`](./双模%20L2%20流程图.md) |
| 环境变量 | [`环境变量.md`](./环境变量.md) |
| e2e | `test/e2e/dual-mode-scenarios.test.ts` |
| 审计待办 | [`双模 L2 审计与优化清单.md`](./双模%20L2%20审计与优化清单.md) |

---

## 15. 版本

| 日期 | 说明 |
|------|------|
| 2026-05-21 | 初版 |
| 2026-05-21 | 改为「模式 + 可复制提示词 + 观测 + 结果」实操格式；补充 L2 no_progress 与 takeover 缺口说明 |
| 2026-05-22 | 新增 §10 A–H 手工联调报告；F/G 预期口径修正；补充清缓存脚本、`~clear` 与 TaskGraph 面板说明 |
| 2026-05-22 | 新增 §11 L2 纠偏专项 L2-1～L2-7（步骤 + 提示词 + 判定速查） |
| 2026-05-22 | §11.7 L2-6 拆为前置进 forced + 主测 6 轮 edit；补充验证门禁死循环说明与 tsc 出口 |
