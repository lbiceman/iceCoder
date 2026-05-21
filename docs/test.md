# iceCoder 双模手工观测手册

> **规格**：[`双模方案2.md`](./双模方案2.md) V1.3.7 · **自动化用例**：`test/e2e/dual-mode-scenarios.test.ts`

本文档给 **Web 聊天手工联调** 用：每项只有四块——**什么模式、复制什么提示词、怎么观察、预期什么结果**。  
发版/改 `supervisor/` 前仍建议跑 §9 自动化回归。

---

## 0. 测前 30 秒（每项通用）

1. `npm run iceCoder`，浏览器打开聊天页，顶栏 **连接绿点** 亮。
2. 顶栏切到本文档指定的 **自由 / 自适应 / 严格**（写入 `data/config.json` 的 `supervisorMode`）。
3. **新建或清空会话**（场景 E 除外），避免旧 checkpoint 干扰。
4. 档位切换后 **下一条新消息** 才生效。

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
| 执行计划 25% | 计划 popover | **任务图进度**，≠ 模式切换，别用它判断 forced |
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
- `supervisor-events.jsonl`：连续出现 **`failure · no_progress:3/4/5…`**
- `~supervisor event=failure days=1`

**预期结果**

- L1：工具失败轮可能 **forced**（视风险档而定）
- L2：**至少 1 条** `no_progress` 写入 Timeline
- **已知缺口**：当前版本 L2 **takeover（recover）** 可能不出现（`TaskContext.domain` 暂为 `non_critical_read`）；以 Timeline 有 `no_progress` 为通过，**不以 recover 为必达**

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
| F | adaptive | Timeline 有 `no_progress` |
| G | off | 无 enter、无 forced chip |
| H | adaptive | Phase1 free；Phase3 至少 1 次 enter |

**不算通过的情况**

- 顶栏是 **off** 却期望 forced
- 用 **执行计划 25%** 判断模式（应看冰豆底部 `forced ·` 或 telemetry）
- 多轮会话混在一起看 `~supervisor`（应用 `days=1` 且新会话测单项）
- 把 **`npm test` 凌晨批量写入** 的 telemetry 当成 Web 手工结果（看时间戳）

---

## 10. 手工记录（复制填空）

```markdown
## 双模手工记录

- 日期：
- 场景：A / B / C / D / E / F / G / H
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

## 11. 自动化回归（开发/发版用）

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

## 12. 相关索引

| 资源 | 路径 |
|------|------|
| 规格 | [`双模方案2.md`](./双模方案2.md) |
| 流程图 | [`双模 L2 流程图.md`](./双模%20L2%20流程图.md) |
| 环境变量 | [`环境变量.md`](./环境变量.md) |
| e2e | `test/e2e/dual-mode-scenarios.test.ts` |
| 审计待办 | [`双模 L2 审计与优化清单.md`](./双模%20L2%20审计与优化清单.md) |

---

## 13. 版本

| 日期 | 说明 |
|------|------|
| 2026-05-21 | 初版 |
| 2026-05-21 | 改为「模式 + 可复制提示词 + 观测 + 结果」实操格式；补充 L2 no_progress 与 takeover 缺口说明 |
