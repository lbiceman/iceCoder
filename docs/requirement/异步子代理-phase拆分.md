# Async Sub-Agent — 工程实施 Phase 拆分

> 基于 `docs/requirement/sub-agent-sync.md`（RFC v1.0）的严格执行拆分。  
> 本文件不是设计文档。不增加新章节、不优化架构、不提出新方案。  
> 仅做执行拆分，每个 Phase 可独立交给 Cursor Composer 执行。

---

## 现状基线（实施前必读）

| 模块 | 现状 | RFC 差距 |
|------|------|----------|
| `src/harness/sub-agent-runner.ts` | 同步 `delegate_to_subagent`，主 Harness **await** 子循环 | 需改为后台运行 + 结果落盘 |
| `src/harness/harness-tool-executor.ts` | 工具轮内阻塞等待 `SubAgentRunner.run()` | 需 fire-and-forget + 后续轮次消费 |
| `src/tools/background-task-manager.ts` | Shell 后台任务（EventEmitter、状态查询） | **可复用** 生命周期管理模式 |
| `src/harness/supervisor/` | Recovery / Mode / EventTimeline | 需新增 **Analysis Supervisor** 调度层 |
| Session 数据目录 | `{dataDir}/sessions/{id}.*` | 需新增 `analysis/` 子目录树 |

**核心原则（RFC §九、§十一）：**

- Main Agent 默认 **不等待** Sub-Agent
- 仅在做 **关键决策前**（如即将修改某模块）才允许阻塞等待对应分析完成
- Sub-Agent 永远 **ReadOnly**（沿用现有白名单）
- Main Agent **不直接** spawn Sub-Agent；经 Supervisor 调度

**建议执行顺序：** `1 → 2 → 3 → 4 → 5 → 6 → 7`

---

# Phase 1 — Core Types Layer

## 1. Scope

覆盖 RFC 章节：

| RFC | 内容 |
|-----|------|
| §六 | Workspace 目录结构 |
| §八 | Sub-Agent 类型枚举 |
| §十 | 结果同步事件 |
| §十二 | 事件流类型 |
| §十三 | 权限模型（类型层声明） |

## 2. Goals

- `src/types/async-sub-agent.ts` 包含异步 Sub-Agent 全部 TypeScript 类型
- 扩展 `SupervisorTimelineEventType`（仅追加，不破坏现有事件）
- `npx tsc --noEmit` 零错误

## 3. Files To Modify

| 路径 | 变更 |
|------|------|
| `src/types/supervisor.ts` | 追加 timeline event 类型（见 §5） |

## 4. Files To Create

| 路径 | 内容 |
|------|------|
| `src/types/async-sub-agent.ts` | 全部 Async Sub-Agent 类型（~250 行） |

## 5. Task Checklist

- [ ] 定义 `SubAgentKind`：`explorer` \| `search` \| `review` \| `dependency` \| `test_analysis`
- [ ] 定义 `AsyncSubAgentStatus`：`pending` \| `running` \| `completed` \| `failed` \| `timeout` \| `cancelled`
- [ ] 定义 `AnalysisArtifact`：`id`, `kind`, `taskId`, `relativePath`, `summary`, `filesRead`, `createdAt`, `status`
- [ ] 定义 `AsyncSubAgentTask`：`taskId`, `sessionId`, `kind`, `prompt`, `context?`, `status`, `artifactPath?`, `startedAt`, `finishedAt?`, `error?`
- [ ] 定义 `SubAgentWorkspaceLayout`：`analysisDir`, `subtasksDir`, `artifactsDir`（相对 session 目录）
- [ ] 定义 `RequestAnalysisInput` / `RequestAnalysisResult`（立即返回 `taskId`，不阻塞）
- [ ] 定义 `AnalysisReadyEvent` payload 结构
- [ ] 定义 `SubAgentPermissions`（Read / Search / Grep / Tree / Summary；禁止 Edit / Delete / Git / Terminal）
- [ ] 定义各 `SubAgentKind` 的输出 schema 占位（ExplorerOutput, SearchOutput, …）
- [ ] 在 `SupervisorTimelineEventType` 追加：
  - `analysis_requested`
  - `analysis_started`
  - `analysis_finished`
  - `workspace_analysis_updated`
  - `analysis_ready`
- [ ] 运行 `npx tsc --noEmit`

## 6. Validation

```bash
npx tsc --noEmit
```

人工验证：
- 新 timeline event 不与现有 `switch` / `recover` 等冲突
- 类型不 import 任何 `src/harness/*` 文件

## 7. Rollback

```bash
git checkout -- src/types/supervisor.ts
rm src/types/async-sub-agent.ts
```

## 8. Dependency

无。

## 9. Forbidden Changes

- 不允许修改 `sub-agent-runner.ts`
- 不允许修改 Harness 主循环
- 不允许实现任何运行时逻辑

## 10. Cursor Execution Notes

- Sub-Agent 输出 schema 本 Phase 只定义 interface + JSDoc，校验逻辑放 Phase 6
- `SubAgentPermissions` 与现有 `DEFAULT_ALLOWED_TOOLS` 对齐文档即可

---

# Phase 2 — Analysis Workspace Store

## 1. Scope

| RFC | 内容 |
|-----|------|
| §六 | `workspace/subtasks/`, `artifacts/`, `analysis/` |
| §十 | Sub-Agent 完成后写入 Workspace |

## 2. Goals

- Session 级 Analysis Workspace 可创建、读写、列举
- Artifact 以 Markdown + 侧车 JSON metadata 落盘
- 支持 checkpoint 恢复后枚举未消费的分析结果

## 3. Files To Modify

| 路径 | 变更 |
|------|------|
| `src/cli/paths.ts` | 可选：追加 `resolveAnalysisWorkspacePaths(sessionId)` helper |
| `src/web/routes/sessions.ts` | 删除会话时清理 `{sessionId}/analysis|subtasks|artifacts` |

## 4. Files To Create

| 路径 | 内容 |
|------|------|
| `src/harness/analysis-workspace-store.ts` | 目录初始化、artifact CRUD、列表（~300 行） |
| `test/harness/analysis-workspace-store.test.ts` | 单元测试（~150 行） |

## 5. Task Checklist

- [ ] `ensureAnalysisWorkspace(sessionDir, sessionId)` 创建：
  - `{sessionDir}/{sessionId}/analysis/`
  - `{sessionDir}/{sessionId}/subtasks/`
  - `{sessionDir}/{sessionId}/artifacts/`
- [ ] `writeAnalysisArtifact(sessionDir, sessionId, artifact)` → 写入 `analysis/{kind}-{slug}.md` + `.meta.json`
- [ ] `readAnalysisArtifact(...)`, `listAnalysisArtifacts(...)`, `listPendingAnalysisTasks(...)`
- [ ] `markArtifactConsumed(taskId)`（可选 consumedAt 字段）
- [ ] 文件名 slug 规则：kind + 短 hash，避免冲突
- [ ] 测试：创建、读写、列表、并发写入

## 6. Validation

```bash
npx tsc --noEmit
npm test -- analysis-workspace-store
```

## 7. Rollback

删除 Phase 2 新增文件；回滚 `paths.ts` / `sessions.ts` 若有改动。

## 8. Dependency

Phase 1（类型）。

## 9. Forbidden Changes

- 不允许接入 Harness / Supervisor
- 不允许 spawn Sub-Agent

## 10. Cursor Execution Notes

- 路径根目录与 `session-workspace-store.ts` 一致（`SESSIONS_DIR`）
- 不要与 repo `workspaceRoot`（用户代码目录）混淆——Analysis Workspace 在 **session 数据目录**

---

# Phase 3 — Async Sub-Agent Manager

## 1. Scope

| RFC | 内容 |
|-----|------|
| §四.2 | Sub-Agent 生命周期 |
| §九 | 异步执行（不阻塞调用方） |
| §十三 | ReadOnly 权限 |

## 2. Goals

- 参照 `BackgroundTaskManager` 实现进程内 Async Sub-Agent 调度
- 复用 `SubAgentRunner` 核心逻辑，但 **run 在后台 Promise** 中执行
- 完成后自动写入 Analysis Workspace

## 3. Files To Modify

| 路径 | 变更 |
|------|------|
| `src/harness/sub-agent-runner.ts` | 抽取 `buildSubAgentPrompt(kind?, task, context)`；可选 `kind` 参数 |

## 4. Files To Create

| 路径 | 内容 |
|------|------|
| `src/harness/async-sub-agent-manager.ts` | 任务注册、后台 run、状态查询、EventEmitter（~400 行） |
| `test/async-sub-agent-manager.test.ts` | mock chatFn 测试生命周期（~200 行） |

## 5. Task Checklist

- [ ] `AsyncSubAgentManager` 单例（按 sessionId 隔离或全局 Map）
- [ ] `submit(task: AsyncSubAgentTaskRequest): { taskId }` — **同步立即返回**
- [ ] 后台：`SubAgentRunner.run()` → 格式化 summary → `writeAnalysisArtifact`
- [ ] 状态：`getTaskStatus(taskId)`, `listRunningTasks(sessionId)`, `listCompletedSince(sinceTs)`
- [ ] 事件：`analysis_started`, `analysis_finished`（本地 EventEmitter；Phase 4 接 EventTimeline）
- [ ] 并发上限：`ICE_ASYNC_SUBAGENT_MAX_CONCURRENT`（默认 5）
- [ ] 超时 / 取消：沿用 `ICE_SUBAGENT_TIMEOUT_MS`
- [ ] 保留现有同步 `delegate_to_subagent` 路径不变（本 Phase 不删除）
- [ ] 测试：submit 不阻塞、完成写盘、超时标记 failed

## 6. Validation

```bash
npx tsc --noEmit
npm test -- async-sub-agent-manager
```

## 7. Rollback

删除新文件；回滚 `sub-agent-runner.ts` 的非必要改动。

## 8. Dependency

Phase 1, Phase 2。

## 9. Forbidden Changes

- 不允许修改 `harness-tool-executor.ts` 的 await 行为（Phase 5 再做）
- 不允许 Main Agent 直接调用 Manager（须经 Supervisor，Phase 4）

## 10. Cursor Execution Notes

- 直接 copy `BackgroundTaskManager` 的 Map + EventEmitter + 并发上限模式
- `SubAgentRunner` 构造参数与 `harness-tool-executor.ts` 现有调用保持一致

---

# Phase 4 — Analysis Supervisor

## 1. Scope

| RFC | 内容 |
|-----|------|
| §七 | Supervisor 创建 / 启动 / 监控 / 收集 / 通知 |
| §十 | AnalysisReady 事件 |
| §十二 | 完整事件流 |

## 2. Goals

- Main Agent **不直接** 创建 Sub-Agent
- Supervisor 接收 `RequestAnalysis`，调度 Manager，写入 EventTimeline
- 分析就绪时发出 `analysis_ready`，供 Harness 注入 prompt 队列

## 3. Files To Modify

| 路径 | 变更 |
|------|------|
| `src/harness/supervisor/supervisor-bridge.ts` | 挂载 `AnalysisSupervisor` 引用（可选字段） |
| `src/harness/types.ts` | Harness 依赖注入位：`analysisSupervisor?` |

## 4. Files To Create

| 路径 | 内容 |
|------|------|
| `src/harness/supervisor/analysis-supervisor.ts` | 调度核心（~350 行） |
| `test/analysis-supervisor.test.ts` | 单元测试（~180 行） |

## 5. Task Checklist

- [ ] `AnalysisSupervisor` 构造：`AsyncSubAgentManager`, `AnalysisWorkspaceStore`, `EventTimeline?`
- [ ] `requestAnalysis(input: RequestAnalysisInput): RequestAnalysisResult`
  - 校验 kind + prompt
  - 调用 Manager.submit
  - `eventTimeline.recordTyped('analysis_requested', ...)`
- [ ] 监听 Manager 事件 → `analysis_started` / `analysis_finished` / `workspace_analysis_updated`
- [ ] 完成时 → `analysis_ready`（payload: taskId, kind, artifactPath, summaryPreview）
- [ ] `getReadyAnalyses(sessionId, unconsumedOnly?)` 供 Harness 查询
- [ ] `shouldAutoTrigger(kind, context)` 占位（Phase 6 实现启发式；本 Phase 返回 false）
- [ ] 测试：request → started → finished → ready 事件链

## 6. Validation

```bash
npx tsc --noEmit
npm test -- analysis-supervisor
```

## 7. Rollback

删除新文件；回滚 bridge/types 增量字段。

## 8. Dependency

Phase 1, 2, 3。

## 9. Forbidden Changes

- 不允许修改 RecoverySupervisor 决策链
- 不允许接入 Harness 主循环（Phase 5）
- 不允许删除同步 `delegate_to_subagent`

## 10. Cursor Execution Notes

- Analysis Supervisor 与 Recovery Supervisor **并列**，不继承、不合并
- EventTimeline payload 保持 JSON-serializable

---

# Phase 5 — Harness 接入与非阻塞工具

## 1. Scope

| RFC | 内容 |
|-----|------|
| §四.1 | Main Agent 生命周期 |
| §五 | OAuth 示例流程 |
| §九 | 异步原则 |
| §十一 | 关键决策点才等待 |
| §十 | Main 决定何时读取 |

## 2. Goals

- 新增工具 `request_analysis`：**立即返回** taskId，不 await Sub-Agent
- Harness 每轮开始前 / 工具轮后：注入 **AnalysisReady** 摘要到 prompt 队列
- 实现 **关键决策等待** gate（可选 env 开关）
- 保留 `delegate_to_subagent` 作为同步降级路径

## 3. Files To Modify

| 路径 | 变更 |
|------|------|
| `src/harness/harness-tool-executor.ts` | 处理 `request_analysis`；`delegate_to_subagent` 不变 |
| `src/harness/harness.ts` | 构造并注入 `AnalysisSupervisor` |
| `src/harness/context-assembler.ts` 或等价注入点 | AnalysisReady prompt 片段 |
| `src/harness/sub-agent-runner.ts` | `createRequestAnalysisToolDefinition()` |
| `src/prompts/sections.ts` | 追加异步 Sub-Agent 使用指引（简短） |

## 4. Files To Create

| 路径 | 内容 |
|------|------|
| `src/harness/analysis-ready-injector.ts` | 从 Supervisor 拉取 ready 分析，格式化为 system/user 注入块（~150 行） |
| `test/analysis-ready-injector.test.ts` | 注入格式测试 |

## 5. Task Checklist

- [ ] 工具 `request_analysis`：`{ kind, task, context? }` → `{ taskId, status: 'submitted' }`
- [ ] 工具描述明确：**Do not wait**；结果稍后通过 workspace / 注入块提供
- [ ] `prepareHarnessRound` 或 `callHarnessLlm` 前：调用 `injectAnalysisReadyMessages(messages, supervisor)`
- [ ] 注入格式示例：
  ```
  [Analysis Ready] explorer task abc123
  summary: Auth 位于 src/auth/, middleware/, config/
  artifact: analysis/explorer-auth-a1b2.md
  ```
- [ ] **Prompt 队列自主性**：AnalysisReady 注入优先级低于用户消息、高于 stale 工具结果；不覆盖 task graph cursor
- [ ] 关键决策等待：
  - 检测 Main 即将 `write_file` / `edit` 某路径
  - 若存在同 scope 的 pending explorer/search → 可选阻塞一轮并提示「等待分析」
  - 默认启用；存在 pending/running 分析且即将写入时软拦截一轮
- [ ] Web `chat-ws.ts`：可选推送 `analysis_ready` WS 事件（UI 展示后台分析完成）
- [ ] 测试：request_analysis 不增加 round 耗时；injector 正确插入消息

## 6. Validation

```bash
npx tsc --noEmit
npm test -- analysis-ready-injector
npm run eval:agent   # 回归：现有 7 case 不退化
```

人工验证：
- 发起 `request_analysis` 后 Main 同轮可继续调用其他工具
- Explorer 完成后下一轮 LLM 上下文可见 summary

## 7. Rollback

回滚 harness-tool-executor / harness / injector；保留 Phase 1–4 模块供后续启用。

## 8. Dependency

Phase 1–4。

## 9. Forbidden Changes

- 不允许移除 `delegate_to_subagent`
- 不允许默认开启 block-on-missing（必须 opt-in）
- 不允许重构 Harness 主循环结构（仅 graft）

## 10. Cursor Execution Notes

- **最高风险 Phase**；插入点参照 `双模方案2` Batch 3：`prepareHarnessRound` 后、`callHarnessLlm` 前
- 先实现 inject + request_analysis，block-on-missing 可拆子 PR

---

# Phase 6 — Sub-Agent 类型化 Prompt 与自动触发

## 1. Scope

| RFC | 内容 |
|-----|------|
| §八 | Explorer / Search / Review / Dependency / Test Analysis |
| §十四 | 更高利用率（Supervisor 自动触发） |

## 2. Goals

- 每种 `SubAgentKind` 有专用 system prompt + 输出结构模板
- Supervisor 在 Main **未显式请求** 时，根据 task intent 自动提交后台分析
- 输出写入对应 schema，便于 Main merge

## 3. Files To Modify

| 路径 | 变更 |
|------|------|
| `src/harness/supervisor/analysis-supervisor.ts` | 实现 `shouldAutoTrigger` + `inferKindFromIntent` |
| `src/harness/sub-agent-runner.ts` | 按 kind 选择 prompt 模板 |

## 4. Files To Create

| 路径 | 内容 |
|------|------|
| `src/harness/sub-agent-prompts.ts` | 五类 Sub-Agent 模板（~200 行） |
| `src/harness/sub-agent-output-parser.ts` | 从 summary 提取结构化字段（~150 行） |
| `test/sub-agent-prompts.test.ts` | 模板快照测试 |

## 5. Task Checklist

- [ ] Explorer 输出：模块、目录、入口、依赖、调用关系
- [ ] Search 输出：文件、函数、引用、关键词
- [ ] Review 输出：风险、建议、可能影响
- [ ] Dependency 输出：Import、调用链、循环依赖
- [ ] Test Analysis 输出：覆盖、失败原因、测试入口
- [ ] `inferKindFromIntent(userGoal, taskPhase)` 启发式（保守：仅 high-confidence 触发）
- [ ] 自动触发上限：每轮最多 1 个 auto analysis（防 token 风暴）
- [ ] 自动触发默认启用；每轮最多 1 个 auto analysis（防 token 风暴）
- [ ] 测试：各 kind prompt 含必需输出节；parser 提取字段

## 6. Validation

```bash
npx tsc --noEmit
npm test -- sub-agent-prompts
```

## 7. Rollback

删除新文件；回滚 analysis-supervisor / sub-agent-runner 增量。

## 8. Dependency

Phase 5（Harness 已能消费 analysis）。

## 9. Forbidden Changes

- 不允许自动触发默认开启
- 不允许 Sub-Agent 获得写权限

---

# Phase 7 — 并行 Sub-Agent 与 Merge 策略

## 1. Scope

| RFC | 内容 |
|-----|------|
| §十五 | Explorer + Search + Review + Dependency 并行 |
| §三 | Main Merge 后继续执行 |

## 2. Goals

- 单次用户任务可并行启动多类 Sub-Agent
- Main Agent 收到多个 `AnalysisReady` 时，提供合并摘要注入
- 会话级并发与 dedupe

## 3. Files To Modify

| 路径 | 变更 |
|------|------|
| `src/harness/async-sub-agent-manager.ts` | 批量 submit、同 kind 去重 |
| `src/harness/analysis-ready-injector.ts` | 多 artifact 合并块 |
| `src/harness/supervisor/analysis-supervisor.ts` | `requestAnalysisBatch` |

## 4. Files To Create

| 路径 | 内容 |
|------|------|
| `src/harness/analysis-merge.ts` | 按 kind 合并 summary（~120 行） |
| `test/analysis-merge.test.ts` | 合并逻辑测试 |

## 5. Task Checklist

- [ ] `requestAnalysisBatch([{ kind, task }, ...])` 并行 submit
- [ ] 同 `(kind, scopeHash)` 运行中任务 dedupe
- [ ] `mergeAnalysisArtifacts(artifacts[])` → 单一注入块
- [ ] 并发上限维持 `ICE_ASYNC_SUBAGENT_MAX_CONCURRENT`（默认 5）
- [ ] eval case：OAuth 修改场景 — Explorer + Search 并行，Main 不阻塞
- [ ] 文档：更新 `docs/使用文档.md` 环境变量节

## 6. Validation

```bash
npx tsc --noEmit
npm test -- analysis-merge
npm run eval:agent
```

## 7. Rollback

回滚 Phase 7 增量；Phase 1–6 仍可单 Sub-Agent 异步运行。

## 8. Dependency

Phase 1–6 全部完成。

## 9. Forbidden Changes

- 不允许 Sub-Agent 之间共享可变状态
- 不允许 Main 直接读 Manager 内部 Map（经 Supervisor / Workspace）

---

# 附录 A — 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `ICE_ASYNC_SUBAGENT_MAX_CONCURRENT` | `5` | 并行 Sub-Agent 上限 |
| `ICE_SUBAGENT_TIMEOUT_MS` | `180000` | 单任务超时（复用） |

说明：Supervisor 自动触发分析、关键写入前等待 pending 分析均为默认策略，不再暴露环境变量。

---

# 附录 B — 验收场景（RFC §五）

**用户：** 「帮我修改 OAuth 登录。」

| 步骤 | 期望 |
|------|------|
| Main 开始规划 | 同轮或下轮 `request_analysis({ kind: 'explorer', task: '...auth...' })` |
| 工具返回 | 立即 `{ taskId, status: 'submitted' }`，**无长时间阻塞** |
| Main 继续 | 规划修改方案、读已知文件 |
| Explorer 完成 | `analysis_ready` 事件；artifact 落盘 |
| 下一轮 | 注入块含 `src/auth/`, `middleware/`, `config/` |
| Main merge | 基于 summary 开始改代码 |

**通过标准：**

- Main Agent 等待 Sub-Agent 的 wall-clock 时间 ≈ 0（除 opt-in block gate）
- Token：Main 未 full-repo read；Explorer 局部总结可用
- 同步 `delegate_to_subagent` 仍可用（降级）

---

# 附录 C — GPT / Opus 执行提示词模板

## 给实施模型（仅 Phase N）

```
基于 docs/requirement/sub-agent-sync.md 与 docs/requirement/异步子代理-phase拆分.md：

仅执行 Phase N。

严格要求：
1. 不实现后续 Phase
2. 不重构 Harness 主循环（Phase 5 前）
3. 不删除同步 delegate_to_subagent
4. Sub-Agent 永远 ReadOnly
5. Main Agent 不直接 spawn Sub-Agent（Phase 4 起经 Supervisor）
6. commit 粒度保持 phase 级

完成后输出：
A. 修改文件列表
B. 新增类型 / API 列表
C. 测试新增内容
D. 潜在风险点
E. 未实现内容（明确留给哪一 Phase）
```

## 给审计模型（Phase N 完成后）

```
审计 Phase N 实现是否符合 docs/requirement/sub-agent-sync.md 与 docs/requirement/异步子代理-phase拆分.md。

重点：
1. 是否违反「Main 默认不等待」
2. Sub-Agent 是否仍 ReadOnly
3. 是否越界实现后续 Phase
4. 是否破坏 eval:agent 回归
5. EventTimeline 事件是否可序列化
6. Analysis Workspace 是否与 repo workspaceRoot 混淆

输出：
A. fatal
B. warning
C. safe
D. 是否允许进入 Phase N+1
```

---

# 附录 D — 与 Agent OS 愿景对齐

| Agent OS V3 原则 | 本实施对应 |
|------------------|------------|
| Supervisor First | Phase 4 AnalysisSupervisor |
| Shared Workspace | Phase 2 Analysis Workspace |
| Stateless Agent | Sub-Agent 无会话状态，只写 artifact |
| Event Driven | Phase 4–5 EventTimeline + AnalysisReady |
| Progressive Execution | Phase 5 非阻塞 + Phase 7 并行 |

参考：`docs/agent-os-vision.md` §2.2–§2.4。
