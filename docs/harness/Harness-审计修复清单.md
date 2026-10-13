# Harness 模块审计修复清单

> 审计范围：`src/harness/**`（含 `agents/`、`supervisor/`），以及其直接依赖的 `src/tools/tool-executor.ts`。
> 审计基线：commit `0f438aec`（2026-10-13）。行号以该版本为准，修改后可能漂移，按函数名定位即可。
> 用法：修完一条把 `[ ]` 改成 `[x]`，必要时在条目下追加「修复说明 / PR」。全部完成后文件名加 `-finish` 后缀。

## 目录

- [P0 高优先级缺陷](#p0-高优先级缺陷)
- [P1 中优先级缺陷](#p1-中优先级缺陷)
- [P2 性能](#p2-性能)
- [P3 可精简](#p3-可精简)
- [P4 需完善（架构 / 配置 / 测试）](#p4-需完善架构--配置--测试)
- [建议修复顺序](#建议修复顺序)
- [已排除的误报](#已排除的误报)

---

## P0 高优先级缺陷

会导致数据损坏、越权写入或错误行为。每条都应附带回归测试。

### [x] 1. 工具超时完全无效

- **位置**：`src/tools/tool-executor.ts:84-86`、`:126-139`；`src/harness/streaming-tool-executor.ts:84-137`
- **问题**：`executeWithTimeout(fn)` 把 `controller.signal` 传给 `fn`，但调用处是 `() => tool.handler(...)`，signal 被丢弃；且没有 `Promise.race`，timer abort 后仍在 `await` handler。卡住的工具会让整轮永远挂起。`StreamingToolExecutor` 持有 `abortSignal` 但也没传给 `executeTool`。
- **修法**：
  - `executeWithTimeout` 用 `Promise.race([fn(signal), abortPromise])`，超时立即 reject。
  - 合并 harness abort signal 与超时 signal，透传到 `tool.handler`（shell 类工具据此 kill 子进程）。
  - 重试循环每次 attempt 前检查 `signal.aborted`。
- **测试**：handler 永不 resolve 时，超时后 `execute` 在 `toolTimeout + ε` 内返回失败；abort 后不再重试。
- **修复说明**：`ToolHandler` 增加第三参 `signal`；`executeWithTimeout` 用 `Promise.race` 合并超时与上游 abort，超时 / 中止不重试；`StreamingToolExecutor`、子 Agent 包装器透传 signal；`shell-tool` 收到 abort 时 kill 进程树。其他工具 handler 未响应 signal 时仍会在后台跑完，但结果被丢弃。

### [x] 2. 正文里的 JSON 示例会被当作工具调用执行

- **位置**：`src/harness/text-format-tool-call-parsers.ts:255-286`（`parseJsonToolObjects`）、`:288-315`（`parseFencedJsonBlocks`）；`src/harness/text-tool-call-salvage.ts:63-84`
- **问题**：模型讲解时写的 `` ```json {"name":"write_file",...}``` `` 或行内 `{"name":"run_command",...}` 会被抢救成真实 `toolCalls`。没有可用工具白名单校验。单测 `test/harness/text-tool-call-salvage.test.ts:53-57` 把该行为固定为正确。`skipPermissionChecks` 开启时等于直接执行。
- **修法**：
  - 抢救结果必须按 `currentTools` 名称白名单过滤。
  - fenced JSON / 行内 JSON 仅在「整段正文几乎只有工具块」时才升格，否则只 strip 不执行。
  - 调整上述单测的预期。
- **测试**：带解释文字 + fenced JSON 示例的回复不产生 `toolCalls`；不在工具列表中的名字不产生 `toolCalls`。
- **修复说明**：新增 `parseEmbeddedToolCallsForExecution`：XML / 通道分隔符等专用标记总是采信；JSON 仅在工具块外正文（去空白）≤ `JSON_TOOL_CALL_MAX_SURROUNDING_PROSE`（120 字符）时采信；按本轮工具名过滤。no-tool 恢复改用 `containsExecutableEmbeddedToolCalls`。

### [x] 3. 工作区快照恢复可写 / 删工作区外文件

- **位置**：`src/harness/workspace-snapshot.ts:54`（`return inside ?? posix`）、`:69-72`（`absInWorkspace`）、`:139-166`（`applyWorkspaceFileSnapshot`）；同模式 `src/harness/intent-checkpoint-turn-snapshot.ts:76-77`
- **问题**：路径不在工作区内时 `remapPathToWorkspace` 回落成原始 posix 串，`../../x` 或 `C:/other/x` 经 `path.resolve` 后越出根目录，随后被 `writeFile` / `unlink`。
- **修法**：`remapPathToWorkspace` 越界时返回 `null`；`absInWorkspace` / `applyWorkspaceFileSnapshot` 写删前强制 `isUnderRoot`，越界跳过并 warn。
- **测试**：`test/harness/workspace-snapshot-paths*.test.ts` 增加 `../`、跨盘绝对路径用例，断言根外文件未被修改。
- **修复说明**：`remapPathToWorkspace` 的调用方普遍依赖回落值，故未改其语义；改为在 I/O 落点统一用新增的 `resolveInsideWorkspace`（越界返回 `null`），覆盖 capture / apply（写与删）、`intent-checkpoint-turn-snapshot`、`session-workspace-restore`。

### [x] 4. `messageId` 未校验直接拼文件路径

- **位置**：`src/harness/intent-checkpoint-store.ts:34-36`（`archivePath`）；来源 `src/web/chat-ws-turn.ts:353`（客户端 `clientMessageId`）
- **问题**：`${messageId}.intent.json` 中 id 含 `../` 或路径分隔符时可写出 `checkpoints` 目录。
- **修法**：入口校验 `/^[A-Za-z0-9_-]{1,128}$/`，不合法则拒绝 / 重新生成；`archivePath` 内再做一次 `isUnderRoot` 断言。
- **测试**：恶意 id 不能在 checkpoints 目录外产生文件。
- **修复说明**：导出 `isSafeIntentMessageId`；web 入口（turn / plan / shell）不合法时改用 `randomUUID()`；`archivePath` 对不合法 id 抛错；索引里的 `archiveFileName` 必须是合法 basename，否则跳过 unlink。

### [x] 5. 删除消息后 checkpoint 被内存缓存「复活」

- **位置**：`src/harness/conversation-delete.ts:302-304`（`clearActiveTaskCheckpoint`）；`src/harness/project-checkpoint-store.ts:50`（模块级 `writeStates`）、`:213-225`；`src/harness/checkpoint-engine.ts:239`
- **问题**：只 `unlink` 磁盘文件，模块级 `writeState.latest` 仍持有完整 V3。下一次 `CheckpointEngine.save` 优先用 `projectStore.latest()`，把已删 checkpoint 写回。目前只有删整个会话时才调用 `releaseProjectCheckpointWriteState`（`src/web/chat-ws.ts:119`）。
- **修法**：`clearActiveTaskCheckpoint` 内等待写队列排空后 `discardCachedLatest()`（或提供 `clearProjectCheckpoint(sessionDir, sessionId)` 统一入口，删文件 + 清缓存）。
- **测试**：save → 删消息 → 再 `CheckpointEngine.save`，断言不复现旧 execution/completion 内容。
- **修复说明**：新增 `ProjectCheckpointStore.clear()`（在写队列内清缓存 + 加文件锁删除）；`clearActiveTaskCheckpoint` 改为调用它。

### [x] 6. 强制压缩切断 tool_call / tool_result 配对

- **位置**：`src/harness/context-compactor.ts:390-420`（`resolveSplitForCompact`）；触发 `src/harness/harness-compaction.ts:177-180`（硬压缩总是 `forceFullCompact: true`）
- **问题**：`splitAt = length - minRecent` 硬切，未经过 `splitMessages`（`:1161-1198`）里 `while (role === 'tool') splitAt--` 等配对修正。又因「首条长 user 保护」（`:1112-1124`）常让自然切分 zero-drop，这条路径很常见。`finalizeCompacted` 只补占位 / 删孤儿，语义已丢。
- **修法**：把配对修正（含文件工具扩展）抽成 `adjustSplitForToolPairs(messages, splitAt)`，自然切分与强制切分共用。
- **测试**：`harness-compaction-api-drive.test.ts` 增加含 assistant(tool_calls)+tool 的强制压缩用例，断言配对不跨越 dropped/recent。
- **修复说明**：新增 `alignSplitOutsideToolResults`，强制切分点先向前退到 assistant(tool_calls)，退到保护区时改为向后越过 tool 结果。

### [x] 7. microcompact 先清空参数再做摘要

- **位置**：`src/harness/context-compactor.ts:849-864`（`compact` 流水线顺序）、`:979-988`、`:1242-1247`
- **问题**：snip → microcompact（`arguments: {}`）→ trim → split → `extractStructuralSummary`，摘要里只剩 `read_file({})`，路径与关键参数丢失；LLM 精炼也基于这份空参摘要。
- **修法**：先 split 并对 dropped 段做 structural extract，再 microcompact；或 microcompact 保留 `path` / `command` 等关键字段。
- **测试**：压缩后摘要包含被丢弃工具调用的文件路径。
- **修复说明**：采用第二种修法：microcompact 保留 `MICROCOMPACT_KEPT_ARG_KEYS`（path / command / pattern / url 等），字符串截到 200 字符、数组最多 10 项，其余大参数仍清掉。

### [x] 8. 会话笔记校验失败仍推进游标

- **位置**：`src/harness/harness-memory.ts:2060-2096`
- **问题**：`validation.valid === false` 或空响应时不写盘，但 `:2094-2096` 仍更新 `tokensAtLastExtraction` 与 `lastProcessedIndex`，之后 `shouldUpdateSessionMemory` 可能长期不触发，压缩用到过期笔记。
- **修法**：两行移到成功 `writeFile` 分支内。
- **测试**：mock LLM 返回不合格笔记，断言游标不变、下次仍会触发更新。
- **修复说明**：游标只在 `writeFile` 成功后推进；失败 / 退避分支不再推进。

### [x] 9. Harness 层无写入工作区边界门禁

- **位置**：`src/harness/harness-tool-executor.ts:574-655`（提交执行前）；`src/harness/harness-tool-preflight.ts:94-138`（只做 missing-file）；`src/shared/path-scope.ts:8-20`（`isUnderRoot` 不做 `realpath`）
- **问题**：`lockedWorkspaceRoot` 仅用于 missing-file 预检，写类工具未校验目标在根内。据子审计，file-tools 层对绝对路径（Windows 盘符、junction/symlink）也可绕过——**需再确认工具层行为**。
- **修法**：preflight 增加「写类工具目标必须 `isUnderRoot(realpath)`，`referenceReads` 仅允许读」；Windows 下大小写归一。
- **测试**：绝对路径、`..`、工作区内 junction 指向外部，写入均被拦截。
- **修复说明**：`checkWorkspaceWriteBoundary` 作为 preflight 第一道检查，写类工具（含 `fs_operation` 的非 list 操作及 move/copy 的 `target`）目标取最近存在祖先的 `realpath` 后做 `isUnderRoot`；记忆目录放行。**仅在 `lockedWorkspaceRoot` 存在时生效**；`run_command` 的写入不在此门禁内。

---

## P1 中优先级缺陷

### 完成判定 / 停止

> #10–#18 统一契约（参考 Codex / Claude Code）：**模型不带工具调用的回复就是它的完成决定**。Harness 只在有确定性证据时介入（未决操作、用户拒绝、验收命令失败），启发式只能换来一次带证据的自检，不能改写终态。系统提示词 `Stopping rules` 补了一条说明这个契约。
> 回归测试：`test/harness/audit-p1-fixes.test.ts` + 各模块单测；端到端 eval：`test/eval/harness-audit-p1-eval.test.ts`，以及 `scripts/agent-eval-cases.ts` 的 `audit-file-deliverable-self-check`、`audit-routed-around-failure-completes`（`npm run eval:agent -- --mode=local`）。

- [x] **10. 「未交付文件」只拦一轮**
  - `harness-round-no-tools.ts:309-328`、`:405-432`；`incomplete-completion.ts:9-14`
  - 一次 `noToolExecutionRecovery` 用完后，模型一句「已整理好」即 `completed`。终态前 `hasPendingWork` 为真应 `paused`，不要标 completed。需同步改 `harness-round-no-tools.test.ts:531-554` 的契约。
  - **修复说明**：没有改成 `paused`，改为让模型自己决定（同 Claude Code 的 Stop hook `block` + `stop_hook_active`）。`hasPendingWork` 为真时注入一次 `[System / Completion Check]`：说明「目标要求产出文件，但本轮没有创建或修改任何文件」，让模型选择继续调工具，或明确说明已完成 / 不需要 / 被阻塞。自检每 run 只发一次（`completionSelfCheckIssued`），之后模型再停手即按正常路径收尾。原来只在「本轮从未调用工具」时才拦，现在读过文件后口头说「整理好了」也会自检。去掉了 `isImplementationIntent` / resume 分支；`noToolExecutionRecoveryCount` 只留给正文嵌入工具语法的协议恢复。

- [x] **11. 完成硬状态被跨 scope 历史失败粘住**
  - `completion-state.ts:75-113`；放大源 `harness-verification-tool-adapter.ts:100-105`
  - 只看「未解决」项：同 target 后续成功即清除，或只看最近 meaningful_progress 之后的 outcome；验收探针命令不升格为终态门禁。
  - **修复说明**：`evaluateCompletionHardState(ledger, { since })`：失败 / 拒绝 / 高风险缺回执只看本 run（`runStartedAt` 之后）记录的；失败类再要求发生在最近一次成功改动（completed + executed + 非 observe）之后（同毫秒视为未解决）；`stop-verification:` 前缀的合成调用整体排除，由验收路径裁决。未决操作（pending / awaiting_approval）不受这些过滤影响。

- [x] **12. optional 验收命令失败整体仍 passed**
  - `harness-stop-verification.ts:156-157`、`:178-184`
  - 改为 `passed_with_optional_failures` 或仅全部通过才 passed。
  - **修复说明**：`StopVerificationResult` 增加 `optionalFailures`（失败或无法执行的可选命令）。`passed` 只表示必选命令全过；收尾正文追加「Required verification passed, but optional checks did not: …」。目前用户目标解析出的命令都是必选，可选命令只在直接构造计划时出现。

- [x] **13. 权限 / 用户拒绝未计入 `policyBlockedSignatures`**
  - `harness-tool-executor.ts:446-533`（对比 `emitHarnessPolicyBlock` `:134-200`）；`tool-round-progress.ts:18-47`
  - 被拒的写工具被当成进展，清零失败计数、解除 `recoveryPendingSticky`。所有 deny / confirm 拒绝 / 无 handler 统一走 `emitHarnessPolicyBlock`。
  - **修复说明**：5 条分支（shell mandatory 无 handler / 被拒，permission deny / confirm 无 handler / 被拒）全部走 `emitHarnessPolicyBlock`，会写 tool_result step、telemetry、TaskState，并计入 `directTotalCount`。用户拒绝的 `toolOutcome` / telemetry outcome 为 `user_denied`。验收适配器里专门补事件的 `emitApprovalBlockCompletion` 已删除。同时修了 `harness-tool-round` 里 forced 模式统计 task-bearing 时没排除 policy 拦截的问题（之前所有 preflight 拦截也会被算成成功执行）。

- [x] **14. abort 后已完成工具结果被丢弃**
  - `harness-tool-executor.ts:315-317`、`:659-675`、`:848-850`
  - 已完成的结果正常写入 messages 并记账（BranchBudget / TaskState / touched），只对未完成 id 补 `interrupted`。
  - **修复说明**：删掉结果循环里的 `isAborted() → break`。中断时 `flush()` 只返回已跑完的工具，这些照常写结果并记账；未完成的仍由 `yieldMissingToolResults` 补 `interrupted`。

- [x] **15. Stop hook 异常被吞后直接停止（fail-open）**
  - `stop-hooks.ts:81-90`
  - 异常时记 telemetry，并按 `paused` 处理，不当作「正常结束」。
  - **修复说明**：`StopHookManager.execute` 记下第一个异常；其它钩子仍可要求继续，都不要求时返回 `error`。no-tool 路径据此以 `paused` / `stop_hook_error` / `completion_paused` 收尾（summary telemetry 带上该 reason）。checkpoint 校验已接受新 reason。

- [x] **16. 任意成功 `run_command` 都清空验收失败证据**
  - `failure-evidence-recovery.ts:181-192`；调用 `harness-tool-round.ts:582-583`
  - 仅当命令匹配当前 VerificationPlan 的规范化键时才 clear。
  - **修复说明**：`roundHadSuccessfulVerification` 换成 `clearResolvedVerificationFailures`：只有终态成功的命令（foreground 成功 / background 完成且 exit 0）才算数，并且只按 `normalizeAcceptanceCommandKey` 清掉同一命令（含 `a && b` 的各段）之前的失败输出。没有按 VerificationPlan 匹配：计划命令重跑成功本来就是同一个键，而没有计划时也需要这个行为。

- [x] **17. 验收续轮计数不随 mutation 重置**
  - `verification-state.ts:104-110`、`:273-283`；持久化 `harness-checkpoint.ts:81`
  - mutation version 上升或新 fingerprint 时 `continuationCount` 归零。
  - **修复说明**：新增 `continuationScope = "<planFingerprint>@<workspaceMutationVersion>"`，scope 变化时计数归零。效果：模型改了文件再停手，验收失败会再给一次续轮；不改文件直接再停手则收尾并报告失败，所以停不停仍由模型决定，不会死循环。旧 checkpoint 没有 scope，恢复后会多给一次续轮。

- [x] **18. 工程改动无验收计划时 `completed_unverified` 仍走 `model_done`**
  - `harness-round-no-tools.ts:405-413`、`:563-588`
  - 对 `hasEngineeringTestTargets` 默认 `paused` + `verification_plan_unavailable`，或 UI 文案明确区分「未验证」。
  - **修复说明**：采用 UI 区分（按模型决定的契约，不改成 `paused`）。`model_task_final` 标记带上 `completionStatus`，轮次卡在 `completed_unverified` 时显示「模型已完成本次任务（未经独立验证）」，并随轮次快照持久化。桌宠气泡原本就会区分。

### 启发式正则过宽

- [ ] **19. 未完成任务钩子关键字过宽**：`incomplete-task-stop-hook.ts:15-35`。「还需要注意…」「Next step for the user…」触发续跑最多 5 次。改为句首 / 祈使语气 + 排除回顾句。
- [ ] **20. 文件交付目标误判**：`document-deliverable.ts:436-442`。单独「放到」即判定；要求与文件名词 / 扩展名共现。
- [ ] **21. 失忆检测误判**：`harness-round-no-tools.ts:171-176`。`/忘记/`、`/forgot/i` 匹配「不要忘记提交」；锚定疑问句并排除否定。
- [ ] **22. 验收输出未剥 ANSI / Windows 路径弱**：`verification-digest.ts:45-47`、`:127-141`；`run-command-result.ts`。分类与 digest 前统一 `stripAnsi`，路径正则支持 `C:\`。
- [ ] **23. `containsEmbeddedToolCalls` 过宽**：`text-format-tool-call-parsers.ts:349-358`。抽不出调用也因 hint 返回 true，触发 no-tool recovery。控制流只认 `calls.length > 0`，hint 仅用于流式 hold。

### 路径 / 持久化

- [ ] **24. Windows 大小写导致 BranchBudget / missing-file 计数分裂**：`branch-budget-path.ts:5-26`、`harness-tool-preflight.ts:112-119`。`Src/a.ts` 与 `src/a.ts` 分别计数可绕过 fileEditMax；win32 键统一小写 + `/`。
- [ ] **25. `workspace.json` 非原子写**：`session-workspace-store.ts:103-113`。改用 `src/memory/file-memory/atomic-write.ts` 的 `writeFileAtomic`；损坏时保留 `.corrupt` 并 warn。
- [ ] **26. checkpoint JSON 损坏 / 校验失败被当作「无 checkpoint」**：`project-checkpoint-store.ts:135-137`、`:295-301`；`checkpoint-engine.ts:216-218`；`harness-checkpoint.ts:93-95`。区分 ENOENT / 损坏 / schema 失败，损坏文件 rename 为 `.corrupt.<ts>`，日志升到 warn。
- [ ] **27. Intent 回合收尾调用会改 cursor 的 API**：`intent-checkpoint-turn-snapshot.ts:148-153` 调 `saveIntentCheckpoint`（`intent-checkpoint-store.ts:177-205`）。改用 `rewriteIntentCheckpoint`。
- [ ] **28. `lastCompletedStep` / `nextSuggestedStep` 落盘丢失**：`checkpoint.ts:161-167` 计算，`:214-223` 只写 `legacyApi`，`:295-316` 从 `legacySource` 读。统一字段或改为恢复时即时推断。
- [ ] **29. 文件锁 30s 直接删、无 PID 校验**：`project-checkpoint-store.ts:409-434`。锁内写 pid，`process.kill(pid, 0)` 仍存活则等待，或心跳刷新 mtime。
- [ ] **30. Intent 索引写入未走统一原子写**：`intent-checkpoint-store.ts:125-133`、`:161-167`、`:181-185`。Windows `EPERM/EEXIST` 无重试；统一 `writeFileAtomic`。
- [ ] **31. Intent 索引锁 key 未规范化**：`intent-checkpoint-store.ts:49`。与 `writeStateKey` 一样 `path.resolve().toLowerCase()`。
- [ ] **32. 恢复协调器优先用当前 `workspace.json` 根而非 archive 根**：`runtime-restore-coordinator.ts:333-344`、`:452-456`。以 archive.workspaceRoot 为准并归一化。
- [ ] **33. 工作区快照写回非原子、无事务**：`workspace-snapshot.ts:139-166`。每文件 tmp+rename；失败抛明确的 `RestoreFailedError`。

### 子 Agent / Supervisor

- [ ] **34. 任务图 fallback 几乎永不激活**：`task-graph-executor.ts:351-361`；`task-graph.ts:440-464`；调用 `harness-tool-round.ts:597-622`。`needsRecovery()` 要求节点 `failed`，force_switch 时节点仍是 running。切换前先标 failed，或独立 `tryFallback`。
- [ ] **35. git 策略可被嵌套 shell 绕过**：`agents/agent-git-policy.ts:27-61`。`bash -c "git commit"`、`pwsh -Command ...`、`cmd /c git` 不拦；对命令串做段拆分 + 子串扫描。
- [ ] **36. 写租约表进程级单例跨会话串扰**：`agents/write-lease.ts:63-64`；`agent-spawner.ts:320`；`web/chat-ws-agents.ts:67-90`。按 session 创建独立 `WriteLeaseRegistry`。
- [ ] **37. `run_command` 改文件不受租约约束**：`agent-spawner.ts:791-836`。命令后 diff 触及他人租约应失败或强警告；文档写明。
- [ ] **38. 后台 hub 只增不删；关机未 dispose spawner**：`agents/agent-background-hub.ts:38-118`；`agent-spawner.ts:1058`；`web/chat-ws-runtime.ts:273-281`。终态且已 drain 后 prune；关机遍历 `dispose()`。
- [ ] **39. `raceAbort` 不取消原确认 Promise**：`agent-spawner.ts:1111-1120`。确认通道支持 AbortSignal，abort 时撤销 UI 确认。

### 主循环 / 记忆

- [ ] **40. Harness 实例复用时 `workspaceRoot` 残留**：`harness.ts:509` 改写 `this.workspaceRoot`。下一次 run 若无锁定根，沿用上次值而非 `config.workspaceRoot`。改为 run 内局部变量，或每次 run 开头重置为 `this.config.workspaceRoot ?? process.cwd()`。
- [ ] **41. 记忆与压缩的上下文窗口两套逻辑**：`harness-memory.ts:1514-1518` 写死 128K；`context-compactor.ts:268-270` 构造时冻结 `tokenThreshold`。统一走 `readEffectiveContextWindowTokens()`，阈值按当前窗口动态计算。
- [ ] **42. 空召回冷却忽略话题切换**：`harness-memory.ts:777-782`。冷却期内 `hasTopicShifted` 为真则清冷却。
- [ ] **43. `dispose` 清空进程级长期记忆 cap**：`harness-memory.ts:1297-1299`；`memory/file-memory/memory-write-pipeline.ts:140-176`。只清本 session，或废弃全局槽。
- [ ] **44. `splitMessages` 文件工具集合与策略白名单不一致**：`context-compactor.ts:1073-1082` vs `compaction-strategy.ts:29-40`。漏 `batch_edit_file`、`diff_files`；统一用 `FILE_TOOLS_PRESERVE_FULL_OUTPUT`。
- [ ] **45. 「首条长 user」保护导致自然压缩 zero-drop**：`context-compactor.ts:1112-1124`。改为保留最近一条长任务 user 或锚点注入。
- [ ] **46. 微压缩记忆 reinject 条件与 break 矛盾**：`harness-compaction.ts:190-196`。条件 `< 3` 但首条即 `break`，实际只保留 1 条。
- [ ] **47. `skipPermissionChecks` 连 deny 规则也跳过**：`harness-tool-executor.ts:484-487`；`types.ts:183`。skip 时 deny 仍生效，只跳过 confirm。

---

## P2 性能

- [ ] **48. 每条 shell 命令前后全仓扫描 + 哈希**：`harness-tool-executor.ts:633-642`、`:736-738` → `workspace-command-touch.ts:149-210`。改为 mtime/size 差分，或仅扫描命令可能写入的子树。
- [ ] **49. 每轮 checkpoint 双写 pretty JSON**：`checkpoint.ts:112-132` + `checkpoint-engine.ts:233-267` + `project-checkpoint-store.ts:322`（`null, 2`）。合并为单次持久化，默认 compact JSON。
- [ ] **50. 压缩判定重复估算 + 同步读配置**：`harness-compaction.ts:135-138`；`context-compactor.ts:294-311`、`:359-366`、`:1325-1327`；`context-window-tier.ts:42-48`、`:88-107`。单次 usage 快照下传；窗口值短 TTL 缓存；split 用累计估算。
- [ ] **51. `finalizeMessagesForApi` 执行两次**：`harness-api-messages.ts:41` + `context-assembler.ts:290`、`:305-308`。只保留外层一次。
- [ ] **52. 文本抢救对同一正文解析最多 4 次**：`text-tool-call-salvage.ts:63-100`；`text-format-tool-call-parsers.ts:349-365`。解析一次复用结果。
- [ ] **53. ToolExecutor 对永久错误也重试 3 次**：`src/tools/tool-executor.ts:21-26`、`:82-116`。区分可重试错误；abort 时立即停止。
- [ ] **54. 轮询与同步 IO**：`agents/agent-spawner.ts:444-455`（100ms `setInterval`）改为事件唤醒；`task-graph-builder.ts:50-107`（`discoverRepoShape` 同步 fs）改异步。
- [ ] **55. 每轮两次遍历图节点**：`harness.ts:113-120`（`countPendingGraphSteps`）与 `:420-430`（`submitGraphModeSignals`）各调一次 `toSnapshot()` 并遍历。合并成一次。

---

## P3 可精简

### 死代码 / 近死代码（已全仓 grep `src/` + `test/` 验证）

- [ ] **56.** `permission.ts` 整个 `PermissionManager`（仅 `index.ts` 导出，默认 pattern 仍是过时的 `execute_shell_command`）；同步删 `index.ts` 文档注释中的条目
- [ ] **57.** `isResilienceV2Enabled()` 恒 `true`（`checkpoint-engine.ts:112-114`）→ 删除函数、`Harness.resilienceV2Enabled` 字段及所有分支；`branchBudget` / `checkpointEngine` 可去掉可选性
- [ ] **58.** `checkpoint-engine.ts:221-225` `loadCombined`
- [ ] **59.** `legacy-checkpoint-adapter.ts:268` `adaptLegacyCheckpointPayload`
- [ ] **60.** `resume-task-state.ts:116-124` `applyResumeTaskStateFixups`（deprecated）
- [ ] **61.** `checkpoint-snapshot.ts` 中 `RoundSnapshotStore` / `CheckpointSnapshotProvider`（只有接口无实现）
- [ ] **62.** `context-compactor.ts:901-909` `getTaskDescription`
- [ ] **63.** `thinking-content-strip.ts:139-140` `stripSystemTagsFromContent`（deprecated 别名）
- [ ] **64.** `context-assembler.ts:34-35`、`:207-208` `dynamicContextCache` / `dynamicContextHash`（只清零从不读）
- [ ] **65.** `harness-memory.ts:117` `EXTRACTION_MAX_CHUNKS`
- [ ] **66.** `memory-write-pipeline.ts:144-146` `getLongTermMemoryWriteCap`（`src/` 无调用）
- [ ] **67.** `casual-mode.ts:51` `buildNoToolsLlmReminder`；`resolveLlmToolsForRound` / `shouldUseCasualLlmFastPath` 恒等透传
- [ ] **68.** `run-command-result.ts:260` `firstCommandToken`
- [ ] **69.** `harness-tool-preflight.ts:44-50` `isBuildLikeCommand`（恒真）、`isDiagnosticAllowedCommand`（未用）
- [ ] **70.** `streaming-tool-executor.ts:143-152` `getCompletedResults` / `hasPending`（无外部调用，`hasPending` 逻辑也错）
- [ ] **71.** `task-graph-metrics.ts` 整文件（生产未 import，仅测试）；`task-graph.ts:570-615` `graphSessions`；`task-graph-executor.ts:313` `classifyFailure`；`NodeCostTrackerImpl`
- [ ] **72.** `HarnessRunState.consecutiveNoToolRounds`（只增减不决策）、`completionGateContinuationCount`（只读写 checkpoint 不门控）
- [ ] **73.** `harness.ts:489-491` `typeof userMessage === 'string'` 恒真分支
- [ ] **74.** `harness-tool-executor.ts:840-842` 空 Phase 11 注释块；`:779-781` `.catch(() => {})` 改为至少 debug 日志

### 重复 / 重叠机制

- [ ] **75. 多代 checkpoint 收敛**：TaskCheckpointManager / CheckpointEngine / V3 ProjectCheckpoint / Intent / legacy adapter / session notes 并存。V3 已是权威源：
  - `TaskCheckpointManager.save` + `CheckpointEngine.save` 合并为一次 `ProjectCheckpointStore.save`
  - legacy adapter 只保留「读旧格式」
  - recovery marker（`project-checkpoint-store.ts:304-313`、`:361-367`）写了又删、不参与恢复决策，按 phase 实现恢复或删除
- [ ] **76. 「别停、换策略」机制收敛为一张 RecoveryBudget 表**：empty / reasoning-only / no-tool / amnesia / stop-hook / verification continuation / failure-evidence 阶梯 / rebuild escalation / check-failure-streak / step-review。统一维护「原因 → 上限 → 重置条件」。
- [ ] **77. 合成 user 消息识别双实现**：`compaction-strategy.ts:50-62` `isSyntheticUserBlockContent` vs `harness-message-utils.ts:53-67` `isSystemInjectedUserContent`，规则不一致。合并为一个。
- [ ] **78. 写租约检查双循环**：`agent-spawner.ts:765-785` 先 `holderOf` 再丢弃返回值调 `acquire`。改为单循环直接用 `acquire()` 结果。

### 微文件合并（< 1.5KB）

- [ ] **79.**
  - `tool-plan-intent-map.ts` → `tool-planner.ts`
  - `branch-budget-tool-path.ts` → `branch-budget-path.ts`
  - `harness-tool-gate-context.ts` → `supervisor/tool-gate.ts`
  - `stream-step-dispatch.ts` → `harness-llm-call.ts`
  - `workspace-path-guard.ts` → 直接用 `shared/path-scope`
  - `supervisor/mode-controller.ts`、`supervisor/supervisor-runtime-cache.ts` → `supervisor/supervisor-config.ts`
  - `harness-cache-segment.ts`、`harness-policy-stats.ts`、`tool-output-spill.ts` 视情况并入调用方

### 注释与类型清理

- [ ] **80. 清理历史标签**：`Batch 1 承载位`、`W1`/`W2`/`W3`/`W4`/`W5`、`F1`、`§2.8 / T12`、`Phase 4a`/`Phase 11`、`L2-6`。主要在 `harness-run-state.ts:145-177`、`harness.ts`、`branch-budget.ts:421`、`harness-tool-round.ts:221,495`、`token-budget.ts:62`、`harness-bg-summary.ts`。
- [ ] **81. 注释与代码不符**：`harness-memory.ts:334-335` 写 Jaccard `< 0.15`，常量为 `0.2`（`:70`）。
- [ ] **82. `HarnessRunState` 可选字段改必填**：`executionMode?`、`executionModeLockRemaining?`、`pendingModeSignals?`、`forcedTaskBearingRoundsSinceEntry?`、`stableRoundsSinceLastFailure?` 等在 `harness.ts:589-645` 总会初始化，改必填后可删大量 `?? 0` / `?? []`。

---

## P4 需完善（架构 / 配置 / 测试）

### 架构

- [ ] **83. 拆分 `harness-memory.ts`（84KB）**

  | 新文件 | 职责 |
  |---|---|
  | `harness-memory-recall.ts` | 召回、rerank、冷却与去重 |
  | `harness-memory-extract.ts` | 提取门控、`_doExtract`、主代理互斥、游标 |
  | `harness-memory-session-notes.ts` | `maybeUpdateSessionMemory`、compact 读笔记 |
  | `harness-memory-feedback.ts` | `detectFeedback`、置信度调整 |
  | `harness-memory.ts` | 薄门面：构造、`onLoopStart/End`、`dispose`、委托 |

- [ ] **84. 拆分 `context-compactor.ts`（52KB）**：split + 配对修正 / recovery + reinject / 五层 pipeline。
- [ ] **85. `runScoped` 初始化逻辑抽离**：`harness.ts:451-795` 约 350 行会话初始化 / 工作区锁 / checkpoint 恢复 / 记忆 hydrate，抽成 `restoreRunState()`；`isFreshQueryMessage` 重复计算（`:556`、`:722`）合并。
- [ ] **86. `HarnessRunDeps` 上帝对象**：`harness.ts:125-130` 是 `RoundPrepDeps & ToolExecutorDeps & ToolRoundDeps & ...` 的交叉。按阶段只注入所需依赖，降低测试构造成本。
- [ ] **87. 明确 supervisor 产品语义**：CLI / Web 默认 `adaptive`（`supervisor-config.ts:42-46`、`main-config-supervisor-mode.ts:11`）会做 ExecutionMode + BranchBudget；任务图只在 `strict` 构建（`harness-round-prep.ts:161-163`），adaptive 下 forced 时 ToolGate 近乎透传。在文档 / UI 写清，或 adaptive 进入 forced 后懒建图。
- [ ] **88. 全局可变状态按会话隔离**
  - `harness-timing.ts:16` 进程级 `samples`
  - `runtime-telemetry.ts:84-88`、`:128-131` 所有会话追加同一 `telemetry.jsonl`
  - `workspace-command-touch.ts:48-67` `preCommandInventories` / `contentHashCache`
  - `verification-exempt-config.ts:33-48`、`:101-108` 作用域外 `set*` 污染 `globalRuntime`（无 ALS store 时应抛错或 no-op + 告警）
- [ ] **89. 任务图环检测**：`task-graph.ts:639-645` 无环检测 / 拓扑排序，自定义 edges 时会静默坏掉；`createTaskGraph` 加 DFS 环检。

### 魔法数字收拢到 `harness-constants.ts` 或配置

- [ ] **90.**
  - `harness.ts:761`：`existingMessages.length >= 60`、`* 0.5`
  - `harness.ts:110`：`APPROX_LINES_PER_FILE_CHANGE = 60`
  - `harness-tool-round.ts:695`：只读 5 轮提示
  - `harness-tool-truncation-recovery.ts:43,59`：`0.98`、`500`
  - `harness-round-no-tools.ts:491`：`tryConsumeVerificationContinuation(..., 1)`
  - `harness-stop-verification.ts:73-76`：poll `60` / `500ms` / `2000ms`
  - `context-compactor`：`SHORT_USER_MSG_MAX_LENGTH=50`、`MIN_USER_MSG_LENGTH_TO_PRESERVE=200`
  - `harness-memory`：`emptyRecallCooldown=3`
  - `agent-spawner.ts:159-160`：`HARD_TIMEOUT_GRACE_MS`、`DEFAULT_UPDATE_THROTTLE_MS`
  - `task-graph-executor.ts:194` vs `:343`：`maxSameToolRepeat` 3 与 5 不一致
- [ ] **91. TokenBudget 两套语义**：`token-budget.ts:20-24` 默认 `500000` vs `token-budget-config.ts:30` 成本护栏 `1e9`，命名区分或合并。
- [ ] **92. 静默失败补日志**：`context-compactor.ts:1299-1301`（`llmSummarize`）、`tool-output-spill.ts:27-28`、checkpoint save 失败等从 `console.debug` 升到 `warn` + telemetry。

### 测试缺口（按 P0/P1 对应）

- [x] **93.** 工具超时 / abort 真正中断（对应 #1、#14）
- [ ] **94.** fenced 教学 JSON 不执行；未知工具名不执行（#2）
- [ ] **95.** 快照恢复 `../`、跨盘绝对路径拒绝（#3）
- [ ] **96.** 恶意 `messageId` 不写出目录（#4）
- [ ] **97.** 删消息后再 save 不复活 checkpoint（#5）
- [ ] **98.** 强制压缩保持 tool 配对；摘要保留路径参数（#6、#7）
- [ ] **99.** 会话笔记校验失败不推进游标（#8）
- [ ] **100.** 写工具越界拦截（绝对路径 / junction）（#9）
- [x] **101.** 用户拒绝写工具不算 meaningful_progress（#13）
- [ ] **102.** Windows 大小写 BranchBudget（#24）
- [ ] **103.** `bash -c "git ..."` 被拦（#35）
- [ ] **104.** 任务图 fallback 真正激活（#34）
- [ ] **105.** `finalizeIntentCheckpointTurn` 不移动 cursor（#27）
- [ ] **106.** `workspace.json` 半写恢复（#25）

---

## 建议修复顺序

1. **第一批（改动小、收益大）**：#1 超时、#3 / #4 越界路径、#2 文本抢救白名单、#8 游标、#5 缓存复活。每条配一个回归测试。
2. **第二批（压缩正确性）**：#6、#7、#44、#45，配合 #98。
3. **第三批（完成判定）**：#10–#18，先定产品契约再改测试。
4. **第四批（精简）**：#57 去掉恒真开关 → #56、#58–#74 删死代码 → #75 合并 checkpoint 写入。
5. **第五批（结构）**：#83–#86 拆大文件与 deps。

## 已排除的误报

- **write-lease「TOCTOU 竞态可双写」**：`agent-spawner.ts:762-785` 从 `holderOf` 到 `acquire` 之间是纯同步代码，单线程 JS 不会插队，不构成竞态。仅作为精简项保留（#78）。
