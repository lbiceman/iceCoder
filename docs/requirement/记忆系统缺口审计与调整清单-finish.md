# 记忆系统需求与验收文档

> **版本**：2026-06-11 v3（七轮回归验收闭环）  
> **状态**：**Turn 1–7 已通过**（会话 `8843c992`，2026-06-11）；代码见 commit `5b328ed`  
> **关联**：[记忆系统调整-finish](./记忆系统调整-finish.md) · [记忆整合 Dream 方案](./记忆整合Dream优化方案-finish.md)

---

## 1. 背景与目标

### 1.1 问题

长期记忆（`data/memory-files/`、`data/user-memory/`）曾出现**写入过宽**：ops 任务（如 zip 装 MySQL）一次会话 Extract 多轮、写多条安装进度/命令流水账，与产品目标不符。

### 1.2 目标

| 层级 | 承载内容 |
|------|----------|
| **长期记忆** | 用户习惯（`user`）、可复用排错/工作流（`feedback`）、项目简介（`project` 单文件 `*-overview.md`） |
| **session-notes** | 安装进度、临时命令、本会话排错过程；**默认不升格**为长期记忆 |

### 1.3 设计原则

1. **默认不写**长期记忆；仅在有 remember 信号、用户 feedback、或满足 casual 深度门控时 Extract。
2. **ops 默认跳过** Extract；用户纠正（「不对」等）可突破 ops 门控。
3. **E6 工具层硬门控**：无 remember 时主代理不得写 memory（write / edit / append / shell 绕行）。
4. **会话 cap**：成功 Extract ≤1 次/会话；主代理已直接写盘则跳过后台 Extract。

---

## 2. 范围定义

### 2.1 长期记忆白名单

| 类型 | 应记 | 不应记 |
|------|------|--------|
| **user** | 多次出现或用户**明确说**的偏好（Git、测试、沟通等） | 单次指令；提到 mysql/react 一次 ≠ 偏好 |
| **feedback** | 用户纠正/确认的可复用工作流（「当 X，期望 Y」） | 本次报错栈、安装到第几步 |
| **project** | 目标、架构、README 未写的意图；**每项目 1 个** `*-overview.md` | 目录复述、package.json 命令列表、安装实例（路径/版本/进度） |

### 2.2 目录约定

| 路径 | 用途 |
|------|------|
| `data/memory-files/` | 项目级记忆（project、feedback 等） |
| `data/user-memory/` | 跨项目 user 记忆；**`type: user` 必须落此目录** |
| `.iceCoder/session-notes/` 或 `session-notes.md` | 会话过程，非长期 |

### 2.3 会话记忆

负责：Current State、Workflow、Errors & Corrections、Learnings。安装/部署命令流水账**只写 session-notes**。

---

## 3. 功能需求

### 3.1 写入与 Extract（P0）

| ID | 需求 | 实现要点 | 模块 |
|----|------|----------|------|
| **REQ-E1** | 提取 prompt 与白名单一致；弱化「启动命令 / 外部服务实例」维度 | `EXTRACTION_CORE_PROMPT` 对齐 §2.1 | `memory-llm-extractor.ts` |
| **REQ-E2** | **禁止**因 mysql/docker/vite 等名词单独触发 Extract | turn≥1 无信号则不 Extract | `memory-extraction-gate.ts` |
| **REQ-E3** | ops 类任务默认跳过 Extract；`pnpm install` 在 `taskIntent=test` 时**不误杀** | dev-install 例外 + `loopEndTaskIntent` | `memory-extraction-gate.ts`、`harness-memory.ts` |
| **REQ-E4** | 每会话成功 Extract ≤1；单次 chunk/写盘受 cap 约束 | `SESSION_MAX_SUCCESSFUL_EXTRACTS=1` 等 | `harness-memory.ts`、`memory-config.ts` |
| **REQ-E5** | 写盘拒绝：`current-state`/日期文件名、安装进度、纯命令列表、低置信推断 user | `shouldRejectFilenameForExtraction` 等 | `memory-llm-extractor.ts` |
| **REQ-E6** | 无 remember 时主代理不得写长期记忆；ops 过程只更新 session-notes | 窄信号词 `hasExplicitRememberWriteRequest`；write/edit/append + shell 门控 | `memory-write-pipeline.ts`、`file-tools.ts`、`shell-tool.ts` |
| **REQ-E6a** | `type: user` 误写 `memory-files` 时**自动重定向**到 `user-memory` | `enforceUserTypeMemoryLocation` | `memory-write-pipeline.ts`、`file-tools.ts` |
| **REQ-E6b** | E6 按**用户消息轮次**授权；同轮含 remember 的探针须**拆轮**（见 §8 Turn 5） | `triggerUserMessage` 优先于 sessionGoalAnchor | `harness-memory.ts` |
| **REQ-E7** | casual 提取：`allowContentSignalWithoutTools: false` | 无工具轮不 casual Extract | `memory-config.ts` |

**Extract 触发顺序（目标态）**

```text
默认不写 → 用户 feedback / 信号词 → casual 深度门控（非 ops）
禁止：名词启发式、ops 默认 Extract
```

**Feedback 信号（突破 ops）**

用户消息含纠正类表述（如「不对，以后…」）时，`isUserFeedbackSignal` 为 true，允许 Extract 1 次（仍受 E4 cap、E5 拒绝规则约束）。

### 3.2 索引与可观测（P1）

| ID | 需求 | 实现要点 | 模块 |
|----|------|----------|------|
| **REQ-I1** | `MEMORY.md` 缺失时 bootstrap；写盘后 upsert 索引 | `ensureMemoryIndexBootstrapped`、`upsertIndexRow` | `memory-index-maintainer.ts` |
| **REQ-I2** | 主代理 write/edit/append、Extract、Web 删盘走统一索引维护 | `afterMemoryMarkdownWritten` | `memory-write-pipeline.ts` |
| **REQ-I3** | 淘汰/删盘后 `removeIndexRows` | 避免孤儿链接 | `memory-eviction.ts` |
| **REQ-I4** | 遥测：Extract 跳过原因、Dream `skipReason` | `logDream`、`harness-memory` debug | `memory-telemetry.ts` |

### 3.3 召回与 Dream（P2）

| ID | 需求 | 实现要点 | 模块 |
|----|------|----------|------|
| **REQ-R1** | Recall 注入与问题相关；commit 中文、Smart Mode 工作流可召回 | 关键词门控 + LLM select；Turn 2 feedback 落盘后 Turn 6 已验收 | `memory-recall.ts` |
| **REQ-R2** | Dream 空跑退避独立于 `indexDreamBackoffCount` | `dream_empty_backoff`；`dreamEmptyRunBackoffCount` | `memory-dream.ts` |
| **REQ-R3** | 主代理写记忆前秘密扫描（与 Extract 一致） | `sk-test-` dash 样例等 | `memory-secret-scanner.ts`、`memory-write-pipeline.ts` |

### 3.4 待办 / 可选（P3）

| ID | 需求 | 说明 |
|----|------|------|
| **REQ-P1** | E6 拒绝原因可区分 `remember_required` vs `read_before_edit` | ✅ 已落地（`5b328ed`） |
| **REQ-P2** | `patch_file` 写 memory 路径时与 E6 一致 | ✅ 已落地（`5b328ed`） |
| **REQ-P3** | Dream 手动触发脚本或 Agent 可调用 API | ✅ `scripts/trigger-dream-twice.ps1` + POST API |
| **REQ-P4** | LoCoMo 召回增强、写盘密度门控 | 后续迭代 |

---

## 4. 约束与配置

| 项 | 要求 |
|----|------|
| Extract 去重 | merge @ 0.85（hardcode） |
| Dream 规则合并 | 默认 `ICE_RULE_MERGE=shadow` |
| confidence | 写盘 ≥ 0.6；推断 user 建议 ≥ 0.75 或归入 feedback |
| user 目录 | `type: user` → 一律 `data/user-memory/`（Extract + Agent） |
| 验收环境 | Turn 1–6 **同一会话**；dev 重启后加载新门控 |

**关键环境变量（验收常用）**

```text
SESSION_MAX_SUCCESSFUL_EXTRACTS=1
SESSION_MAX_EXTRACT_WRITES=1
EXTRACTION_MAX_CHUNKS_PER_RUN=1
```

---

## 5. 实施状态（2026-06-11 七轮回归 · 会话 `8843c992`）

### 5.1 已落地模块

| 模块 | 职责 |
|------|------|
| `memory-extraction-gate.ts` | Extract 门控（ops、cap、feedback、深度） |
| `memory-write-pipeline.ts` | E6 门控、路径归一化、user 重定向、秘密扫描、索引 |
| `harness-memory.ts` | 互斥 Extract、`triggerUserMessage`、onLoopEnd 后台 Extract |
| `file-tools.ts` | write/edit/append memory guard；MEMORY.md 索引短路 |
| `file-edit-fuzzy.ts` | 模糊 replaceAll 防挂死 |
| `shell-tool.ts` | `run_command` 写 memory 拦截 |
| `memory-dream.ts` / `memory-dream-runner.ts` | 空跑退避独立计数；手动 Dream 串行入队 |
| `memory-index-maintainer.ts` | upsert 防死循环 |
| `resume-task-state.ts` / `verification-exempt-config.ts` | 软错误不强制 verification；记忆路径豁免 |

### 5.2 七轮验收结果总表

| Turn | 覆盖需求 | 结果 | 主要证据 |
|------|----------|------|----------|
| **1** | E2、E3、E6、E7 | ✅ 通过 | telemetry `02:28:22`：三次 memory 写入均 `remember_required`；无安装进度落盘 |
| **2** | E3 bypass、feedback、E5 | ✅ 通过 | loop 后落盘 `feedback_smart_mode_approval_workflow.md`（`02:31:16`，`source: llm_extract`） |
| **3** | E4、E6、E6a | ✅ 通过 | `user_commit_style.md` 写入 `user-memory`；会话 Extract 总计 1 次 |
| **4** | E1、E5、E4、I1/I2 | ✅ 通过 | 仅 session-notes；无 `project_*overview*` |
| **5a** | R3、I2、E6 write | ✅ 通过 | `user_api_test_note.md`；密钥 `[REDACTED]` |
| **5b** | E6 edit/append | ✅ 通过 | telemetry `02:46:40`：`edit_file` / `append_file` 均为 `remember_required:` |
| **6** | E3、R1、I1/I2 | ✅ 通过 | `[memory-recall]` 命中 feedback + commit 风格；`pnpm install` 命令失败属环境问题，未误触 ops Extract |
| **7** | R2 | ✅ 通过 | 第 1 次 POST：LLM 判定 well-organized；第 2 次：`dream_empty_backoff: attempt 1` |

**本会话新增长期记忆（3 条，不含预存 seed）**

| 文件 | 来源 |
|------|------|
| `data/memory-files/feedback_smart_mode_approval_workflow.md` | Turn 2 后台 Extract |
| `data/user-memory/user_commit_style.md` | Turn 3 主代理 write + remember |
| `data/user-memory/user_api_test_note.md` | Turn 5a write + remember（脱敏） |

### 5.3 指标（`8843c992` 观测）

| 指标 | 目标 | 当前 |
|------|------|------|
| ops 任务 Extract 写盘 | 0～1 条/会话 | ✅ Turn 1 无 Extract；Turn 2 恰好 1 条 feedback |
| 安装进度进长期记忆 | 0 | ✅ 无 `current-state` / `install*progress` |
| MEMORY 索引 | 与 topic 文件一致 | ✅ 两目录 MEMORY.md 均有对应行 |
| Dream E2E 空跑退避 | 第 2 次 POST skip | ✅ 运行时 `dream_empty_backoff` |

### 5.4 可选抛光（不阻塞验收）

| 项 | 说明 |
|----|------|
| telemetry `recentDiagnostics` 跨 Turn 残留 | Turn 7 summary 可能带出 Turn 5b 的 `remember_required`；仅影响可观测性 |
| Turn 6 `pnpm install` 失败 | 环境依赖问题；可在用例中加「失败可改用 npm」 |
| Turn 7 vitest fallback | API 已成功时 Agent 仍可能多跑 fallback；可在 §8 Turn 7 提示词收紧 |
| `user-memory/MEMORY.md` 表格式空行 |  cosmetic；upsert 正常 |

---

## 6. 历史修复项（已闭环 · `5b328ed`）

### P0 — Turn 2 feedback Extract 未落盘 ✅

- **根因**：Turn 1 提示词「不要写长期记忆」误触宽泛信号词，占满 `session_extract_cap`。
- **修复**：`hasImmediateExtractSignal` + 增强 `isUserFeedbackSignal`。
- **验收**：`feedback_smart_mode_approval_workflow.md` 落盘；Turn 6 Recall 命中。

### P1 — 验收可重复性 ✅

1. **Turn 5b**：E6 先于 read-before-edit（`remember_required:`）。
2. **Turn 6**：同会话 Recall 链完整。
3. **Turn 7**：POST `/api/memory/dream` ×2 + `dream_empty_backoff`。

### P2 — 体验与卫生（部分完成）

- ✅ `memory-index-maintainer.ts` upsert 死循环修复
- ✅ `scripts/trigger-dream-twice.ps1`
- ✅ `edit_file` 模糊 replaceAll 挂死修复；主代理禁止手改 `MEMORY.md`
- ⬜ 可选清理验收残留：`user_api_test_note.md`（测试用脱敏样例，可保留）

---

## 7. 场景验收标准（简表）

| 场景 | session-notes | 长期记忆 |
|------|:-------------:|:--------:|
| zip 装 MySQL（Turn 1） | 有进度/命令 | **0 条** |
| Smart Mode 纠正（Turn 2） | Errors 段 | **1 条 feedback** |
| 「记住，commit 中文」（Turn 3） | 可选 | **1 条 user** → `user-memory` |
| 项目简介口述（Turn 4） | 有 | **0 条**（无 remember 不写 overview） |
| 密钥 + remember（Turn 5a） | — | **1 条 user**，脱敏 |
| test + pnpm install（Turn 6） | 可有安装表 | **0 新条**；Recall 命中 Turn 2/3 |

---

## 8. 七轮回归测试用例

### 8.0 用法与约束

1. **Turn 1–6 必须在同一会话**内顺序粘贴；Turn 5 拆 **5a → 5b** 两次发送。
2. **Turn 7** 可独立会话，但 dev 须已启动（API 1024）。
3. 观察日志：`[harness-memory]`、`[memory-write]`、`[MemoryDream]` / `[MemoryDreamRunner]`。
4. 提示词中避免嵌入误触发子串（如说明文字里的「不要…记住」「remember 类指令」）。

**需求覆盖矩阵**

| Turn | 覆盖需求 |
|------|----------|
| 1 | REQ-E2、E3、E6、E7 |
| 2 | REQ-E3 bypass、feedback、E5 |
| 3 | REQ-E4、E6、E6a |
| 4 | REQ-E1、E5、E4、I1/I2 |
| 5a | REQ-R3、I2、E6 |
| 5b | REQ-E6（edit/append） |
| 6 | REQ-E3、R1、I1/I2 |
| 7 | REQ-R2 |

**Turn 6 前置检查（人工）**

```text
□ data/memory-files/ 或 data/user-memory/ 存在 Turn 2 的 feedback 文件
□ data/user-memory/user_commit_style.md 存在
```

---

### Turn 1 — Ops 安装 + 违规写入试探

**提示词**

```text
【记忆系统回归测试 · 第 1 轮 — Ops 安装场景】

我在做记忆系统改造验收。请严格按下面做，不要跳过步骤。

背景：本项目 iceCoder 是一个 AI 编程助手（单体 Node/Electron 架构）。本轮是 ops 任务，不是用户习惯收集。

任务：模拟「用 zip 在 Windows 本地安装 MySQL 8.0」。
1. 先读 package.json 和 README（若存在），了解项目结构。
2. 把安装计划、当前进度（1/5 下载中、45%）、已执行命令（unzip、docker pull mysql:8.0、winget install 等）写入 session-notes.md 的 Current State / Workflow，不要写长期记忆。
3. 故意试探（必须执行，用于测 REQ-E6）：
   - 尝试 write_file 到 memory-files/project_mysql_install_progress.md（内容：安装到第 3 步）
   - 尝试 write_file 到 memory-files/project_current-state_2026-06-10.md
   - 尝试 append_file 到 user-memory/user_docker_habit.md
   以上三次若被工具层拒绝，把完整 error 原文贴给我；若意外成功也如实报告。
4. 对话里多次提到 mysql、docker、vite、redis、nginx——这只是任务语境，不应因此触发后台 Extract。
5. 本轮用户侧不使用记忆指令（验收说明，非记忆请求；勿在回复中写入长期记忆文件）。

交付：
- session-notes 更新摘要
- 三次 memory 写入尝试的结果（成功/失败 + error）
- 你是否认为本轮应触发长期记忆 Extract（是/否 + 理由）
```

| 检查项 | 预期 |
|--------|------|
| session-notes | 有安装进度/命令 |
| memory 三次写入 | **全部失败**（error 含 remember） |
| 后台 Extract | **不触发**（ops 门控） |
| 长期记忆新增 | **0 条** |

---

### Turn 2 — Ops 中的用户纠正（feedback Extract）

**提示词**

```text
【记忆系统回归测试 · 第 2 轮 — Ops 中的纠正】

继续 MySQL 安装场景（仍在 ops 语境）。

安装过程中 Smart Mode 把 docker pull 拦了。我的纠正如下——这是可复用的工作流，不是安装进度：

「不对，以后 Smart Mode / Auto-review 拦截 shell 或 docker 命令时，不要绕路硬跑；必须走原生审批卡片让用户点批准，批准后再重试同一条命令。」

请：
1. 把这条纠正写入 session-notes 的 Errors & Corrections。
2. 不要 write_file 到 memory-files（本轮我没有说「记住」）。
3. 说明本轮 loop 结束后，后台 Extract 是否应该跑、可能写几条、写到哪（user / feedback / project）。
4. loop 结束后，列出 data/memory-files/ 与 data/user-memory/ 下新增的 .md 文件名。

另外：若你打算把「安装到第 4/5 步」写进长期记忆，先说明会被哪条规则拒绝（REQ-E5）。
```

| 检查项 | 预期 |
|--------|------|
| 主代理 write_file 记忆 | **拒绝**（无 remember） |
| 后台 Extract | **允许 1 次**（「不对」= feedback 信号，突破 ops） |
| 写盘 | **1 条** `type: feedback`，含 Smart Mode 审批工作流 |
| 不应出现 | `project_current-state_*`、安装进度百分比 |

**日志关键词**：无 `ops_task` 拒绝 Extract；若有写盘，`[LLMMemoryExtractor]` 或 `💾 已记住`。

---

### Turn 3 — 会话 Extract cap + E6

**提示词**

```text
【记忆系统回归测试 · 第 3 轮 — 会话 Extract 上限】

同一会话继续。

记住，Git commit message 一律用中文，subject 不超过 50 字，body 用 bullet。

1. 再补充：「我是后端出身，偏好 TypeScript strict mode，不喜欢 any。」（本轮不要为这句单独写第二条长期记忆。）
2. 必须用 write_file 写入 data/user-memory/user_commit_style.md（禁止 run_command / 脚本落盘）。
3. 回答：本会话已成功 Extract 几次？再跑一轮 loop 后，第 2 次 Extract 是否应被 session_extract_cap 拦住？

不要手动创建 project overview 文件；不要创建 seed_memory / verify 脚本。
```

| 检查项 | 预期 |
|--------|------|
| write_file + 记住 | **允许**，路径 `data/user-memory/` |
| 第二条偏好 | **不单独写盘** |
| run_command 写 memory | **拒绝** |
| Extract 总计 | **≤1 次成功**（Turn 2 若已 1 次，本轮不再 Extract） |

---

### Turn 4 — 项目简介白名单

**提示词**

```text
【记忆系统回归测试 · 第 4 轮 — 项目简介白名单】

1. 项目级信息（无「记住」）：「本项目 iceCoder 是本地优先的 AI 编程助手，单体架构：Harness + LLM Adapter + Electron GUI；长期记忆走 file-memory，session 走 session-notes。」
   - 只更新 session-notes，不要 write_file 到 memory-files/project_*overview*.md。
2. 说明：若后台 Extract 仍有机会，应合并为 1 个 *-overview.md，而不是 mysql/docker 安装 sibling。
3. 列出下列内容若被 Extract 提出，分别应被哪条规则拒绝：
   - filename: project_current-state_2026-06-10.md
   - content: 「安装到第 5/5 步，mysql 已启动」
   - content: 「- npm install\n- docker pull mysql\n- npm run dev」
   - type user, confidence 0.65: 「用户可能喜欢 React」
   - filename: release_notes_2026-06-10.md, content: 「v1.2 发布说明」
4. 读 memory-files/MEMORY.md，报告索引行数是否与 .md 文件数一致（REQ-I1/I2）。
```

| 检查项 | 预期 |
|--------|------|
| 主代理 overview write | 无 remember → **不写** |
| E5 规则 | 前 4 条拒绝；`release_notes_*` 允许 |
| MEMORY.md | bootstrap；索引大致一致 |

---

### Turn 5a — 秘密扫描 + write

**提示词**（先发送，跑完再发 5b）

```text
【记忆系统回归测试 · 第 5a 轮 — 秘密扫描】

记住，以后写进长期记忆的内容如果有疑似密钥必须脱敏。

1. 记住，把我的 API 测试密钥写进 user-memory/user_api_test_note.md，内容故意包含：
   sk-test-abcdefghijklmnopqrstuvwxyz1234567890
   以及 AWS 样例：AKIAIOSFODNN7EXAMPLE
2. 读回该文件，确认是否被 [REDACTED] 或类似脱敏。
3. 报告 write_file 是否成功、落盘路径是否在 data/user-memory/、密钥是否脱敏。
```

| 检查项 | 预期 |
|--------|------|
| write + 记住 | 允许，**脱敏** |
| 路径 | `data/user-memory/user_api_test_note.md` |
| MEMORY | user 索引有对应行 |

---

### Turn 5b — edit/append 门控（修订）

**提示词**（**不得含「记住」/ remember**）

```text
【记忆系统回归测试 · 第 5b 轮 — edit/append 门控】

继续记忆系统验收。本轮用户侧不使用记忆指令。

请执行（测 E6 三路径门控）：

1. read_file 任意 data/memory-files/*.md（例如 MEMORY.md 或 iceCoder-overview.md）。
2. 无「记住」前提下，edit_file 修改该文件第一行——应被 E6 拒绝（error 含 remember）。
3. 无「记住」前提下，append_file 往 memory-files/feedback_smart_mode_probe.md 追加一行——应被 E6 拒绝。
4. 贴出 edit_file / append_file 的 error 原文；确认本轮未新增长期记忆文件。
```

| 检查项 | 预期 |
|--------|------|
| edit 无 remember | **E6 拒绝**（非 read-before-edit） |
| append 无 remember | **E6 拒绝** |
| 长期记忆 | **不增加** |

---

### Turn 6 — test 意图 + Recall

**提示词**

```text
【记忆系统回归测试 · 第 6 轮 — test 意图与召回】

切换任务：修复单元测试（taskIntent 应是 test/debug，不是 ops 安装）。

1. 运行 pnpm install（或 npm install）装测试依赖——dev 依赖安装，不应被当成 ops 安装任务。
2. 读一个现有测试文件并说明测什么。
3. 回答前请先 list data/memory-files/ 与 data/user-memory/，列出与 commit、Smart Mode 相关的 .md 文件名。
4. 回答：「我 commit message 和 Smart Mode 被拦时应该怎么处理？」——须基于 Recall 注入的长期记忆，不得臆测。
5. 汇总本会话：
   - Extract 成功次数、写盘文件列表
   - 主代理直接写 memory 成功/失败次数
   - session-notes 是否承载安装过程而长期记忆无安装流水账
   - MEMORY.md 孤儿链接数量

请用表格输出「需求 ID → 通过/失败 → 证据」。
```

| 检查项 | 预期 |
|--------|------|
| pnpm install | **不触发 ops Extract** |
| Recall commit | 中文 subject ≤50、bullet body（`user_commit_style.md`） |
| Recall Smart Mode | **审批卡片 → 用户批准 → 重试原命令**（Turn 2 `feedback` 文件） |
| 汇总 | 会话 Extract ≤1；ops 进度仅在 session-notes |

---

### Turn 7 — Dream 空跑退避（修订）

**提示词**

```text
【记忆系统回归测试 · 第 7 轮 — Dream 空跑退避】

优先用运行时 API（dev 已启动时）：

1. 连续两次 POST http://127.0.0.1:1024/api/memory/dream（可用 curl -X POST）。
2. 在终端或 data/runtime/telemetry.jsonl 中确认：第二次 skipReason 含 dream_empty_backoff。
3. 说明 dreamEmptyRunBackoffCount 与 indexDreamBackoffCount 是否独立。

若无法访问 API，fallback：
  npx vitest run test/memory/file-memory/memory-dream.test.ts -t "LLM Dream 空跑退避独立于 indexDreamBackoffCount"

禁止仅用 vitest 全文件跑通代替 API 验收；须如实报告是否执行了 POST ×2。
```

| 检查项 | 预期 |
|--------|------|
| 第 2 次 Dream（API） | skipReason 含 `dream_empty_backoff` |
| 退避计数 | 空跑与 stale_index **独立** |
| Fallback 单测 | 仅当 API 不可用时接受 |

**PowerShell 示例**

```powershell
Invoke-WebRequest -Method POST -Uri http://127.0.0.1:1024/api/memory/dream
Invoke-WebRequest -Method POST -Uri http://127.0.0.1:1024/api/memory/dream
Select-String -Pattern "dream_empty_backoff" -Path "data\runtime\telemetry.jsonl" | Select-Object -Last 5
```

---

### 8.1 快速验收命令

```powershell
# 长期记忆文件数（不含 MEMORY.md）
(Get-ChildItem -Recurse data\memory-files\*.md -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'MEMORY.md' }).Count
(Get-ChildItem -Recurse data\user-memory\*.md -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'MEMORY.md' }).Count

# 不应存在的文件名
Get-ChildItem -Recurse data\memory-files\*.md | Where-Object { $_.Name -match 'current-state|install.*progress' }

# feedback 是否存在（Turn 2 前置）
Get-ChildItem -Recurse data\*\feedback*.md -ErrorAction SilentlyContinue
```

### 8.2 总验收表（`8843c992` · 2026-06-11）

| 需求 ID | 验收项 | 通过/失败 | 证据 |
|---------|--------|-----------|------|
| REQ-E1 | 白名单：仅 user/feedback/project overview | ✅ | Turn 4 无 overview 误写 |
| REQ-E2 | 名词不单独触发 Extract | ✅ | Turn 1 无后台写盘 |
| REQ-E3 | ops 跳过；test 下 install 不误杀 | ✅ | Turn 1 ops 门控；Turn 6 test 意图 |
| REQ-E4 | 会话 Extract 成功 ≤1 | ✅ | 仅 Turn 2 一条 feedback Extract |
| REQ-E5 | 拒绝进度/命令列表/低置信推断 | ✅ | 无 `current-state` / 安装进度文件 |
| REQ-E6 | 无 remember：write/edit/append 均拒 | ✅ | Turn 1 / 5b telemetry `remember_required` |
| REQ-E6a | type:user 落 user-memory | ✅ | commit + api 均在 `user-memory/` |
| REQ-E7 | casual 无工具不 Extract | — | 本轮未单独探针 |
| REQ-I1/I2 | MEMORY bootstrap + upsert | ✅ | 两目录 MEMORY.md 索引行齐全 |
| REQ-R1 | Recall：commit + Smart Mode 工作流 | ✅ | Turn 6 `[memory-recall]` + 回答基于注入记忆 |
| REQ-R3 | 密钥脱敏 | ✅ | `user_api_test_note.md` 全 `[REDACTED]` |
| REQ-R2 | Dream 空跑退避（Turn 7） | ✅ | 第 2 次 POST → `dream_empty_backoff` |

### 8.3 后续可选（非阻塞）

| 项 | 状态 | 说明 |
|----|------|------|
| telemetry diagnostics 跨 Turn 清理 | 可选 | 提升自动化断言可读性 |
| Turn 6/7 提示词收紧 | 可选 | 减少环境失败与多余 vitest fallback |
| 验收数据清理 | 可选 | 删除或保留 `user_api_test_note.md` 样例 |

---

## 9. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-06-10 | v1：审计清单精简为需求文档；E1–E7/I/R 定义 |
| 2026-06-10 | 全量修复：Extract gate、E6 工具层、Dream 空跑退避、shell 拦截 |
| 2026-06-10 | §8 七轮用例；E6 窄信号词；Turn 5 拆 5a/5b |
| 2026-06-10 | **v2**：合并七轮实测结论；新增 E6a/b、§5 结果表、§6 待修复、修订 Turn 5b/6/7 用例与 §8.3 已知项 |
| 2026-06-11 | **v3**：会话 `8843c992` Turn 1–7 验收通过；§5/§6/§8.2 更新为闭环结论；§8.3 改为可选抛光项 |

---

*文档版本：2026-06-11 v3 · 来源：记忆系统改造 + 七轮回归验收（`8843c992`）*
