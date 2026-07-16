# 执行透明层（侧边栏 + 设置开关）— 工程实施 Phase 拆分

> 基于 `docs/requirement/执行透明层侧边栏与设置开关.md` 的严格执行拆分。
> 本文件不是设计文档：不增加新章节、不优化架构、不提出新方案，仅做执行拆分。
> 每个 Phase 可独立交给 Cursor Composer 执行；建议顺序 1 → 2 → 3 → 4 → 5 → 6 →（7）→ 8。

## 全局约束（每个 Phase 都必须遵守）

- **纯前端、加性改动**：不改后端事件协议、不改 `HarnessStepEvent` / `TaskGraphView` / `TaskGraphPatch`、不新增后端接口。
- **Observer 红线（设计 §14）**：透明层只消费事件、不影响事件；所有渲染/事件入口 `try/catch` 兜底，异常降级为空 UI，绝不 `throw` 冒泡、绝不中断 Agent。
- **契约不变**：`chat-execution-plan.js` 现有导出（`setPlan/applyPatch/clear/resetExecutionMode/setVisible/getPlan/isVisible/isPlanLive/isPlanComplete/formatFootSummary/formatExecutionModeChip/getExecutionModeChip/getExecutionModeState/applyExecutionModeEvent/isPanelSuppressed/renderGraph/updateGraphNode/highlightGraphBranch/markGraphComplete`）签名保持不变。
- **默认关闭**：主开关 `showTransparencyPanel` 默认 `false`。
- **桌面宠物零影响**：所有宠物改动仅针对聊天页 `session-pet.js`（`enableDrag` 默认 true）；桌面 `pet-floating-page.js`（`enableDrag:false`）不得受影响。
- 每个 Phase 结束跑 `npm run lint`（或项目对应校验），无新增 error。

---

# Phase 1 — 偏好层 EtlPrefs

## 1. Scope

覆盖设计章节：§4.2 开关项定义、§4.3 存储与迁移、§13.2。

## 2. Goals

- 提供统一的前端偏好读写与变更广播，兼容迁移旧键 `ICE_PLAN_PANEL`。
- 纯数据层，无 DOM 依赖；被 config-page / 面板 / 桥共同消费。

## 3. Files To Modify

| 路径 | 改动 |
|---|---|
| `src/public/js/main.js` | 在 `import './config-model-panel.js'` 之前加入 `import './etl-prefs.js';` |

## 4. Files To Create

| 路径 | 内容 |
|---|---|
| `src/public/js/etl-prefs.js` | `window.EtlPrefs`：`get()/getKey()/set()/onChange()`；`localStorage['ICE_ETL_PREFS']` |

## 5. Task Checklist

- [x] 创建 `etl-prefs.js`，DEFAULTS：`showTransparencyPanel=false`、`panelDefaultExpanded=true`、`showLlmActivity=true`、`showTimeline=true`、`autoScrollActiveStep=true`、`timelineGranularity='step'`、`timelineTimeMode='absolute'`、`panelWidth=360`
- [x] `load()`：读 `ICE_ETL_PREFS`；缺失则写 DEFAULTS；`sanitize()` 校验类型与取值域（`panelWidth` 夹 320–480）
- [x] 迁移：首次读取时若 `ICE_PLAN_PANEL==='0'` → `showTransparencyPanel=false`
- [x] `get()` 返回副本；`getKey(k)`；`set(patch)` 校验+持久化+`emit()`；`onChange(fn)` 返回取消订阅
- [x] `main.js` 增加 import（顺序在 config-page 之前）

## 6. Validation

- [x] 控制台 `EtlPrefs.get()` 返回默认对象；`EtlPrefs.set({panelWidth:9999})` 后读回被夹到 480
- [x] 预置 `localStorage.ICE_PLAN_PANEL='0'` 清空 `ICE_ETL_PREFS` 后首次 `get()` → `showTransparencyPanel===false`
- [x] `onChange` 回调在 `set` 有实际变化时触发、无变化不触发

---

# Phase 2 — 设置页「执行透明层」Section

## 1. Scope

覆盖设计章节：§4.1 放置位置、§4.2、§4.4 两层门控、§13.3。

## 2. Goals

- 设置 › 通用 出现「执行透明层」section；主开关 + 子项 + 宽度选择。
- 按 `features.executionPlan` 三态渲染；主开关关时子项置灰；改动即时 `EtlPrefs.set`。

## 3. Files To Modify

| 路径 | 改动 |
|---|---|
| `src/public/js/config-page.js` | `renderGeneralPanel` 追加 section + `bindEtlSettings` |
| `src/public/css/config.css` | 新增 `.settings-etl-subgroup/.settings-etl-row/.settings-etl-select` |

## 4. Files To Create

无。

## 5. Task Checklist

- [x] 在「安全与执行」section 后插入 `#settings-etl-section`，复用 `.settings-card`/`.config-default-switch`
- [x] 主开关 `#etl-show-panel` → `showTransparencyPanel`
- [x] 子项：`panelDefaultExpanded`/`showLlmActivity`/`showTimeline`/`autoScrollActiveStep` + 宽度 `<select>`（320/360/420/480）
- [x] 能力门控：读 `ChatExecutionPlanBridge.isEnabled()`，false → 主开关 `disabled` + 徽标「服务未启用」
- [x] 依赖置灰：主开关关时 `.settings-etl-subgroup.is-disabled` 且控件 `disabled`
- [x] 各控件 `change` → `EtlPrefs.set`，主开关切换给 Notification 提示
- [x] config.css 补样式

## 6. Validation

- [x] 主开关默认关；开→子项可用、关→子项置灰
- [x] 刷新后设置项与 `EtlPrefs` 一致（持久化生效）
- [x] 模拟 `isEnabled()===false` → 主开关禁用且显示「服务未启用」

---

# Phase 3 — 宠物交互改造

## 1. Scope

覆盖设计章节：§3.1、§5（最小化/双击宠物/删除双击复位/桌面宠物不受影响）、§13.4。

## 2. Goals

- 删除聊天页宠物「双击恢复默认位置」；双击语义改为「展开透明面板」（受门控）。
- 桌面悬浮宠物零影响。

## 3. Files To Modify

| 路径 | 改动 |
|---|---|
| `src/public/js/session-pet.js` | 删除 `initPetDrag` 内 `dblclick → clearCustomPosition()` 块 |
| `src/public/js/chat-page.js` | `#pet-canvas` 绑 `dblclick → ChatExecutionPlan.requestExpandFromPet()`；canvas aria/title 文案改「双击展开执行透明层」 |

## 4. Files To Create

无。

## 5. Task Checklist

- [x] `session-pet.js`：移除双击复位监听（保留拖拽 & `clearCustomPosition` 供越界兜底）
- [x] `chat-page.js`：宠物创建后绑定 `dblclick`（存在性判空调用 `ChatExecutionPlan.requestExpandFromPet`）
- [x] `chat-page.js`：canvas `aria-label`/`title` 文案更新
- [x] 确认桌面宠物路径（`enableDrag:false`）不进入 `initPetDrag`，无回归

## 6. Validation

- [x] 双击聊天页宠物不再复位；双击触发 `requestExpandFromPet`（自动化静态 wiring + 浏览器门控验证）
- [ ] 宠物拖拽移动仍正常（未执行真实拖拽手工验收）
- [ ] 桌面悬浮宠物双击/拖拽行为不变（仅有静态隔离断言，未执行真实桌面宠物交互）

---

# Phase 4 — 面板重构为右侧停靠侧边栏（执行流核心）

## 1. Scope

覆盖设计章节：§3.1 容器、§3.3 Tab、§3.4 当前步骤、§3.5 计划列表、§3.8 Footer、§13.5、§13.6 布局、§14 容错。

## 2. Goals

- `chat-execution-plan.js` 由 popover 改为右侧停靠 `<aside id="exec-transparency-panel">`。
- 头部（标题 + 最小化）→ Tab 条 → 当前步骤卡 → 执行计划列表（含 `startedAt/endedAt` 耗时）→ Footer。
- 最小化收为宠物形态；契约导出不变；所有入口 try/catch。

## 3. Files To Modify

| 路径 | 改动 |
|---|---|
| `src/public/js/chat-execution-plan.js` | 重构渲染 + 新增 `minimize/expand/requestExpandFromPet`；`isPanelSuppressed` 改读 `EtlPrefs` |
| `src/public/css/chat-execution-plan.css` | 重写为停靠侧边栏布局 |

## 4. Files To Create

无。

## 5. Task Checklist

- [x] `<aside>` 挂 `document.body`，`position:fixed;right:0;width:var(--etl-w,360px)`；`top` 由 JS 测 `#top-nav` 底缘，`bottom:0`
- [x] 展开时 `body.etl-panel-open`，CSS 对 `.page-container` 施 `padding-right:var(--etl-w)`（不改 `.chat-page/.chat-main` 结构）
- [x] 头部：标题「执行透明层」+ 最小化按钮（`—`），**无 `×`**
- [x] Tab 条：执行流（默认）/工具调用/上下文/状态快照/日志（本期仅「执行流」有内容，其余占位「暂无数据」）
- [x] 当前步骤卡：`步骤 X/N` + 进度条 + 运行耗时 + 证据行
- [x] 执行计划列表：复用现有状态色，每步显示 `endedAt-startedAt` 耗时
- [x] Footer：Token（`totalTokenUsage`）/工具（`totalToolCalls`）/时间
- [x] 新增导出 `minimize()`/`expand()`/`requestExpandFromPet()`；`isPanelSuppressed()` 改读 `EtlPrefs.getKey('showTransparencyPanel')` 取反
- [x] 保留全部现有导出与 `syncExecPlanFoot` 依赖（`formatFootSummary/isPlanLive/getExecutionModeChip/getPlan`）
- [x] **容错**：`setPlan/applyPatch/renderStep` 等入口全部 `try/catch`，异常降级为空 UI
- [x] `panelWidth` 从 `EtlPrefs` 读取写入 CSS 变量 `--etl-w`

## 6. Validation

- [x] 主开关开 + 有 plan → 右侧停靠面板出现，聊天区自适应避让不被遮挡
- [x] 最小化 → 面板收起、宠物形态；双击宠物 → 展开
- [x] 主开关关 → 面板不挂载，双击宠物无效
- [x] 注入畸形 plan/patch → 面板降级不崩、Agent 与事件流零中断
- [x] `chat-pet-bridge.js` 底部摘要仍正常（契约未破）

---

# Phase 5 — LLM 当前动作 + 时间轴 + Supervisor 投影

## 1. Scope

覆盖设计章节：§3.6 LLM 当前动作、§3.7 时间轴、§3.7.1 Supervisor 事件、§13.5、§13.7、§14 容错。

## 2. Goals

- 执行流 Tab 内展示 LLM 当前动作（仅动作状态，**无 reasoning/思维链**）。
- 面板底部时间轴：节点级精确时间 + 总时长 + 绝对/相对切换；Supervisor 事件以 Warning 一级节点呈现、可展开。

## 3. Files To Modify

| 路径 | 改动 |
|---|---|
| `src/public/js/chat-execution-plan.js` | 新增 LLM 动作区、时间轴渲染、`pushSupervisorTimelineEvent` |
| `src/public/js/chat-execution-plan-bridge.js` | 把 `execution_mode_*` / `task_graph_branch` 投影为 Timeline supervisor 事件 |
| `src/public/css/chat-execution-plan.css` | 时间轴 + LLM 动作 + Supervisor 节点样式（Warning 色） |

## 4. Files To Create

无。

## 5. Task Checklist

- [x] LLM 当前动作：由「活动节点 phase/status + 最近 `tool_call`/`tool_result`」推导一条短语（20–40 字）；受 `showLlmActivity` 控制；**不读取任何 reasoning/thinking 文本**
- [x] 时间轴：节点起止用 `startedAt/endedAt`，起点 `createdAt`，现在 `Date.now()`；总时长条；绝对/相对切换（`timelineTimeMode`）；粒度切换（`timelineGranularity`）
- [x] 溢出：横向可滚动吸附当前步骤；窄面板退化为竖向时间线
- [x] `pushSupervisorTimelineEvent({kind,reasonHuman,signals,round,ts})`：Warning 色 + `⚠` + 可展开原因（复用 `MODE_SIGNAL_LABELS`/`DEGRADED_LABELS`）
- [x] 桥：`execution_mode_enter`→接管、`enteredBy` 含 `recovery_pending`/`checkpoint_resumed`→恢复、`task_graph_branch`→重新规划、`execution_mode_exit`→继续执行
- [x] 面板顶部监管横幅复用现有 `.exec-plan-mode-banner`（forced 时显示）
- [x] `showTimeline` 关闭时整块隐藏
- [x] **容错**：时间轴/Supervisor 投影入口 try/catch，异常隐藏对应区块

## 6. Validation

- [ ] 节点耗时/时刻与后端 `startedAt/endedAt` 一致；绝对/相对切换生效；hover tooltip、点击定位正常（时间数据与模式已有自动化证据；未执行真实 hover/点击手工验收）
- [x] `execution_mode_enter` → `⚠ 接管`（Warning）可展开；`task_graph_branch` → 重新规划；`exit` → 继续执行；无 Supervisor 事件时时间轴与普通任务一致
- [x] LLM 动作只显示一条、随状态更新、**无思维链文本**
- [x] 注入超大 Timeline / tooltip 抛错 → 仅对应区块降级，Agent 零中断

---

# Phase 6 — 桥接门控与偏好联动

## 1. Scope

覆盖设计章节：§4.4 两层门控、§13.7、§14。

## 2. Goals

- 显示与否由 `features.executionPlan && showTransparencyPanel` 决定；偏好变更即时生效。

## 3. Files To Modify

| 路径 | 改动 |
|---|---|
| `src/public/js/chat-execution-plan-bridge.js` | `ensurePanelVisible` 读 `EtlPrefs`；订阅 `EtlPrefs.onChange` |

## 4. Files To Create

无。

## 5. Task Checklist

- [x] `ensurePanelVisible()`：`showTransparencyPanel && features.executionPlan` 才 `setVisible(true)`
- [x] 启动订阅 `EtlPrefs.onChange`：偏好变化即时 `setVisible`/重渲染/应用 `panelWidth`
- [x] `panelDefaultExpanded=false` 时初始最小化（宠物形态），等待双击展开
- [x] **容错**：`onStep` 整体 try/catch，单事件异常不影响后续分发

## 6. Validation

- [x] 设置页切主开关 → 聊天页面板即时显隐（无需刷新）
- [x] `features.executionPlan=false` → 无论主开关如何都不显示
- [x] `panelDefaultExpanded` 开/关分别为默认展开/默认最小化

---

# Phase 7 —（可选）移动端底部 Sheet

## 1. Scope

覆盖设计章节：§6 响应式与移动端。

## 2. Goals

- `≤720px`（`data-shell="mobile"`）不停靠侧栏，改顶部一行「执行 X/N ▸」+ 底部 sheet（执行流 + 工具调用）。

## 3. Files To Modify

| 路径 | 改动 |
|---|---|
| `src/public/js/chat-execution-plan.js` | 移动端分支渲染 sheet |
| `src/public/css/chat-execution-plan.css` | 移动端 sheet 样式 |

## 4. Files To Create

无。

## 5. Task Checklist

- [x] 移动端判定 `document.documentElement.getAttribute('data-shell')==='mobile'`
- [x] 顶部条 + 点击弹出底部 sheet；`panelDefaultExpanded` 语义为「是否自动弹出 sheet」；`panelWidth` 隐藏
- [x] **容错**：同 §14

## 6. Validation

- [x] 窄屏走 sheet，聊天区不被挤压变形
- [x] 桌面端不受影响

---

# Phase 8 — 回归与验收

## 1. Scope

覆盖设计章节：§11 验收清单、§14 Observer 红线。

## 2. Goals

- 全量回归；Observer 红线注入测试通过；零回归、零中断。

## 3. Files To Modify

无（必要时补测试）。

## 4. Files To Create

按需：手工/Playwright 冒烟用例。

## 5. Task Checklist（对齐设计 §11）

- [x] 设置页出现 section，主开关默认关
- [x] 主开关关→无面板 DOM 仅宠物；开→右侧常驻面板
- [x] 面板右上角仅最小化、无 `×`；展开时隐藏聊天页宠物，最小化后恢复宠物
- [x] 仅主开关开启时双击宠物展开；主开关关闭时双击无效
- [ ] 宠物双击复位逻辑已移除；拖拽仍可用（双击复位移除已有自动化证据；真实拖拽未手工验收）
- [ ] 打包桌面端独立宠物交互保持原样（仅有静态隔离与 `desktop:smoke` 证据；未执行真实桌面宠物双击/拖拽）
- [ ] 执行流/时间轴/LLM 动作/Supervisor 事件与后端一致（事件投影、时间字段与模式已有自动化证据；未执行完整真实后端任务及 Timeline hover/点击验收）
- [x] Footer Token/工具/时间与时间轴总时长一致
- [x] `setPlan/applyPatch/clear/setVisible` 契约不变
- [x] **Observer 注入测试**：畸形 plan、缺字段 patch、超大 Timeline、tooltip 抛错 → UI 降级为空、Agent 执行与事件流零中断

## 6. Validation

- [x] `npm run lint` 无新增 error
- [x] 最终审查自动化回归：真实会话切换只读重同步并废弃旧响应、`task_graph_update` 时间字段保真、能力/主开关联动禁用、Tab ARIA 与键盘导航均通过
- [x] Windows 终止链路改为异步“发起终止”：`taskkill` 非零/启动失败触发 CIM，端口兜底异步，8 任务 `dispose()` 快速幂等
- [x] 并发稳定性回归：后台 hard-timeout 句柄在终态/`dispose()` 立即释放；输出与完成态测试改为条件同步；Playwright 页面逐例回收且生命周期超时 30 秒
- [x] 全部 ETL 定向测试 80/80、`npm run build`、`desktop:smoke` 均通过
- [x] Shell/后台链路定向测试 52/52；全量 `npm test` 连续两轮均为 246 个测试文件、2283 个测试全部通过
- [ ] 一轮真实 `edit`/`debug` 任务全程面板正常、关闭主开关全程无面板且不影响执行（本轮未执行真实 edit/debug 手工任务，不虚报）
