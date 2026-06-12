# saga-warehouse-reconciliation 评测报告

> **task_id**：`saga-warehouse-reconciliation-02`  
> **评测日期**：2026-05-22  
> **裁判**：Cursor Composer 2.5（盲评 → 2026-05-22 解盲）  
> **rubric**：`JUDGE_RUBRIC_v0.1`

---

## 平台

| 代号 | 平台 | 工作目录 | 状态 |
|------|------|----------|------|
| **A** | **iceCoder** | `E:\test\agentToolTest\saga-warehouse-reconciliation-a` | ✅ 已评 |
| **B** | **CC**（Claude Code） | `E:\test\agentToolTest\saga-warehouse-reconciliation-b` | ✅ 已评 |
| — | 基线（未修） | `E:\test\agentToolTest\saga-warehouse-reconciliation-basic` | 对照 |

> 参测产物目录结构相同，仅文件夹后缀不同。裁判阶段使用代号盲评；**A = iceCoder**，**B = CC（Claude Code）**。

**参测约定（全平台一致）**

- 模型：`minimax-m2.5`
- 基线对照：`E:\test\agentToolTest\saga-warehouse-reconciliation-basic`（11 failed / 4 passed）

---

## 提示词

这是一个**多租户仓库调拨** TypeScript 练习仓库（事件溯源 + Saga + 读模型投影）。当前大量测试失败。请在**不修改 `test/`** 的前提下修复并实现缺失模块，使 `npm test` 全部通过。

**系统语义**（详见 `ARCHITECTURE.md`，若有冲突以测试为准）

- 命令幂等键为 **`(tenantId, commandId)`**。
- 调拨 Saga 5 步：ReserveSource → ValidateDestCapacity → DeductSource → CreditDest → ReleaseAndComplete。
- 任一步失败必须**补偿**，且库存投影与事件日志一致。
- `ReconciliationEngine.reconcile()` 须释放**孤儿预留**并修正 `reserved` 漂移。
- `SagaTimeoutMonitor.tick(now)` 须超时回收 `IN_PROGRESS` 且 `updatedAt` 超过 TTL 的 Saga。

**已知故障线索（勿只修单点）**

1. 事件追加乐观并发校验逻辑错误，重复追加或丢版本。
2. 跨租户使用相同 `commandId` 时幂等缓存互相污染。
3. 自事件重放构建的库存与增量投影不一致（重放路径有重复计数）。
4. ValidateDestCapacity 成功后 Saga 时间戳未刷新，导致超时监控失效。
5. 补偿链未同步更新读模型，且部分失败场景未回滚源仓扣减/目标仓入账。
6. `reconciliation-engine.ts` 与 `saga-timeout-monitor.ts` 仍为**空壳，必须实现**。
7. `inventory-projection.legacy.ts` 为误导遗留，测试不使用。

**要求**

- 只改 `src/`；禁止改 `test/`、`package.json`、锁文件。
- 保持现有导出 API；不要引入新依赖。
- 修复过程中多次运行 `npm test` 驱动迭代。
- 完成后运行 `npm test` 与 `npm run build`。
- 用 8 条以内 bullet 说明：实现了哪两个模块、修了哪些缺陷、如何验证补偿与对账。

从 `README.md` → `ARCHITECTURE.md` → 失败测试输出开始。

---

## Run: A / iceCoder / saga-warehouse-reconciliation-a

### 实现摘要（≤150 字）

实现 `ReconciliationEngine`（孤儿预留释放写 EventStore + `reserved` 漂移修正）与 `SagaTimeoutMonitor`（超时 `FAILED`+补偿）。修复 EventStore 并发（`expectedVersion !== current`）、租户级幂等键、投影重放单路径、ValidateDest 时间戳、补偿链事件+投影同步，并修正 `seedInventory` 版本读取。`npm test` 15/15，`build` 通过。

### 变更文件

| 文件 | 变更类型 | 一行说明 |
|------|----------|----------|
| `src/reconciliation/reconciliation-engine.ts` | 实现 | 孤儿预留释放（写事件）+ `reserved` 漂移修正 |
| `src/scheduler/saga-timeout-monitor.ts` | 实现 | TTL 扫描超时 Saga 并补偿 |
| `src/store/event-store.ts` | 修复 | 并发校验改为 `expectedVersion !== current` |
| `src/idempotency/idempotency-guard.ts` | 修复 | 幂等键 `${tenantId}:${commandId}` |
| `src/projections/inventory-projection.ts` | 修复 | 重放与增量共用 `applyEventIncremental` |
| `src/saga/transfer-saga.ts` | 修复 | ValidateDest 刷新 `updatedAt`；步进与失败补偿 |
| `src/saga/compensation.ts` | 修复 | 补偿 append 后同步投影；`originalStatus` 保留 `FAILED` |
| `src/service/system-context.ts` | 修复 | `seedInventory` 用 `getVersion` 替代硬编码 0 |
| `src/service/transfer-service.ts` | 接线 | 注入 `ReconciliationEngine(store)` |

**未改动**：`test/`、`package.json`、`package-lock.json`、`vitest.config.ts`、`inventory-projection.legacy.ts`

### 实现说明（任务要求 bullet，补录）

- **`reconciliation-engine.ts`**：孤儿预留通过 `EventStore.append` + `applyEventIncremental` 释放；按 reservations 汇总修正 `inventory.reserved` 漂移（含 `onHand` 上限 clamp）。
- **`saga-timeout-monitor.ts`**：`IN_PROGRESS` 且 `updatedAt < now - SAGA_TTL_MS` 时设 `FAILED` 并 `compensateSaga(..., 'FAILED')`。
- **`event-store.ts`**：乐观并发在版本**不相等**时抛 `ConcurrencyError`。
- **`idempotency-guard.ts`**：幂等缓存键含 `tenantId`，避免跨租户 `commandId` 碰撞。
- **`inventory-projection.ts`**：`replayEvents` 仅走增量投影，消除重放双计数。
- **`transfer-saga.ts`**：ValidateDestCapacity 成功后更新 `updatedAt`；各步失败走 `compensateSaga`。
- **`compensation.ts`**：逆序回滚 dest 入账、源仓扣减、预留释放，每步 `applyEventIncremental`。
- **验证**：容量失败 / CreditDest 后 abort / 超时 / 孤儿预留对账等探针用例全部通过。

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm test` | **PASS** (exit 0) | 15/15 tests passed |
| `npm run build` | **PASS** (exit 0) | `tsc --noEmit` |

**基线对照**（`saga-warehouse-reconciliation-basic`）：11 failed / 4 passed

### 执行统计

| 字段 | 值 |
|------|-----|
| platform | iceCoder |
| turns | —（未记录 run-manifest） |
| duration | —（用户自评：与 B 差距不大，B 约快 1 分钟） |
| tool_calls | — |
| human_assist | false（假定） |

### Gate 客观门禁（0–40）

| 子项 | 分值 | 判定 |
|------|------|------|
| G1 验收通过 | 25/25 | `npm test` + `npm run build` 全部通过 |
| G2 范围合规 | 8/8 | 仅 `src/**/*.ts` 九文件，无越界产物 |
| G3 可构建 | 4/4 | build exit 0 |
| G4 无致命泄漏 | 3/3 | 无密钥 / `.env` |

**Gate 合计：40/40**

### Composer 2.5 裁判评分（0–60）

| 维度 | 分 | evidence（摘要） |
|------|-----|------------------|
| D1 需求完成度 | 9 | 两空壳模块 + 七类故障线索全覆盖；15 项探针均满足 |
| D2 正确性 | 9 | 并发/租户幂等/重放/补偿/超时与测试一致；对账释放写事件日志 |
| D3 代码质量 | 8 | 分层清晰；`SagaTimeoutMonitor` 未复用 `failSaga`；detail 文案 bug |
| D4 最小改动 | 9 | 精准 9 文件、无平台会话产物 |
| D5 验证意识 | 7 | 全量 test + build 通过；无多轮 `npm test` 日志 |
| D6 实现说明 | 6 | 产物内无原始 bullet；`README` 仍写模块「待实现」 |

**Judge 合计：48/60**

```json
{
  "run_id": "A",
  "platform": "iceCoder",
  "dimensions": {
    "D1": { "score": 9, "evidence": "ReconciliationEngine + SagaTimeoutMonitor 完整实现；七类缺陷均修复" },
    "D2": { "score": 9, "evidence": "并发!==、tenantId:commandId、replay 单路径、补偿+投影、超时 updatedAt" },
    "D3": { "score": 8, "evidence": "timeout monitor 重复 failSaga 逻辑；clamp detail 赋值后拼接" },
    "D4": { "score": 9, "evidence": "仅 src 9 文件，无 .claude/.cursor 越界" },
    "D5": { "score": 7, "evidence": "15/15 test + build；无 run-manifest 分批回归记录" },
    "D6": { "score": 6, "evidence": "无交付 bullet；README 与实现不同步" }
  },
  "judge_total": 48,
  "one_line_verdict": "高难 Saga/对账/超时全链路修复正确，范围合规优于 B，缺过程文档与 README 同步。",
  "implementation_summary": "实现对账与超时监控，修复 store/幂等/投影/补偿，全部 vitest 通过。"
}
```

### 等级

| 指标 | 值 |
|------|-----|
| Gate | **40/40** |
| Judge | **48/60** |
| **Composite** | **88** |
| **等级** | **A**（80–89） |
| SR（本 run） | ✅ 客观成功 |
| iceCoder 回归门禁（附录 B） | ✅ G1=25 且 Composite≥70 |

### observability 对照（task yaml scoring_hints）

| 观测点 | iceCoder (A) |
|--------|------------|
| EventStore 并发 `!==` | ✅ |
| 幂等键含 tenantId | ✅ |
| 重放与增量投影一致 | ✅ |
| ValidateDest 刷新 `updatedAt` | ✅ |
| 补偿更新投影 + 回滚扣减/入账 | ✅ |
| ReconciliationEngine 非空壳 | ✅ |
| SagaTimeoutMonitor 非空壳 | ✅ |
| 未改 test / 未加依赖 | ✅ |
| 仅改 src/ | ✅ |
| ARCHITECTURE `reserved > onHand` 对账 | ⚠️ 未实现（测试未覆盖） |
| 交付 8 bullet / README 同步 | ⚠️ 未做到 |

### 已知瑕疵（不挡验收）

- `reconciliation-engine.ts`：`clamp_reserved` 的 `detail` 在赋值**后**拼接，日志文案前后值相同。
- `saga-timeout-monitor.ts`：未复用 `failSaga`，与 `transfer-saga.ts` 逻辑重复。
- `README.md` 仍标注 Reconciliation/Timeout「待补全」，与实现不符。

---

## Run: B / CC / saga-warehouse-reconciliation-b

### 实现摘要（≤150 字）

实现 `ReconciliationEngine`（孤儿预留释放 + `reserved` 与 reservations 对齐）与 `SagaTimeoutMonitor`（超时 `failSaga`+补偿）。修复 EventStore 并发判断（`expectedVersion !== current`）、租户级幂等键、投影重放路径、ValidateDest 时间戳刷新、补偿链事件+投影同步。`npm test` 15/15，`build` 通过。

### 变更文件

| 文件 | 变更类型 | 一行说明 |
|------|----------|----------|
| `src/reconciliation/reconciliation-engine.ts` | 实现 | 孤儿预留释放 + `reserved` 漂移修正 |
| `src/scheduler/saga-timeout-monitor.ts` | 实现 | TTL 扫描超时 Saga 并 `failSaga` |
| `src/store/event-store.ts` | 修复 | 并发校验改为 `expectedVersion !== current` |
| `src/idempotency/idempotency-guard.ts` | 修复 | 幂等键 `${tenantId}:${commandId}` |
| `src/projections/inventory-projection.ts` | 修复 | 重放与增量共用 `applyEventIncremental` |
| `src/saga/transfer-saga.ts` | 修复 | ValidateDest 刷新 `updatedAt`；步进与失败补偿 |
| `src/saga/compensation.ts` | 修复 | 补偿 append 后同步投影；`FAILED` 状态保留 |
| `.claude/settings.local.json` | 新增 | CC 会话权限（允许 `npm test` / `npm run`） |

**未改动**：`test/`、`package.json`、`package-lock.json`、`vitest.config.ts`、`inventory-projection.legacy.ts`

### 实现说明（任务要求 bullet，补录）

- **`reconciliation-engine.ts`**：扫描非 `IN_PROGRESS` Saga 的孤儿预留并释放；按 reservations 汇总修正 `inventory.reserved` 漂移。
- **`saga-timeout-monitor.ts`**：`IN_PROGRESS` 且 `now - updatedAt > SAGA_TTL_MS` 时调用 `failSaga` 并补偿。
- **`event-store.ts`**：乐观并发在版本**不相等**时抛 `ConcurrencyError`（基线为 `expectedVersion > current` 错误逻辑）。
- **`idempotency-guard.ts`**：幂等缓存键含 `tenantId`，避免跨租户 `commandId` 碰撞。
- **`inventory-projection.ts`**：`replayEvents` 仅走增量投影，消除重放双计数。
- **`transfer-saga.ts`**：ValidateDestCapacity 成功后更新 `updatedAt`；各步失败走 `compensateSaga`。
- **`compensation.ts`**：逆序回滚 dest 入账、源仓扣减、预留释放，每步 `applyEventIncremental`。
- **验证**：容量失败 / CreditDest 后 abort / 超时 / 孤儿预留对账等探针用例全部通过。

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm test` | **PASS** (exit 0) | 15/15 tests passed |
| `npm run build` | **PASS** (exit 0) | `tsc --noEmit` |

**基线对照**（`saga-warehouse-reconciliation-basic`）：11 failed / 4 passed（并发、幂等、重放、补偿、超时、对账等）

### 执行统计

| 字段 | 值 |
|------|-----|
| platform | CC（Claude Code） |
| turns | —（未记录 run-manifest） |
| duration | —（用户自评：与 A 差距不大，约快 1 分钟） |
| tool_calls | — |
| human_assist | false（假定） |

### Gate 客观门禁（0–40）

| 子项 | 分值 | 判定 |
|------|------|------|
| G1 验收通过 | 25/25 | `npm test` + `npm run build` 全部通过 |
| G2 范围合规 | 6/8 | 仅 `src/**/*.ts` 改动；`.claude/settings.local.json` 越界 −2 |
| G3 可构建 | 4/4 | build exit 0 |
| G4 无致命泄漏 | 3/3 | 无密钥 / `.env` |

**Gate 合计：38/40**

### Composer 2.5 裁判评分（0–60）

| 维度 | 分 | evidence（摘要） |
|------|-----|------------------|
| D1 需求完成度 | 9 | 两空壳模块 + 七类故障线索全覆盖；15 项探针均满足 |
| D2 正确性 | 9 | 并发/租户幂等/重放一致/补偿逆序/超时 TTL/`failSaga` 状态与测试一致 |
| D3 代码质量 | 8 | 模块边界清晰，与仓库 TS 风格一致 |
| D4 最小改动 | 8 | 核心仅 `src/` 七文件；另有 `.claude/` 会话产物 |
| D5 验证意识 | 7 | 全量 test + build 通过；无多轮 `npm test` 日志 |
| D6 实现说明 | 6 | 产物内无原始 bullet；`README` 仍写模块「待实现」 |

**Judge 合计：47/60**

```json
{
  "run_id": "B",
  "platform": "CC",
  "dimensions": {
    "D1": { "score": 9, "evidence": "ReconciliationEngine + SagaTimeoutMonitor 完整实现；七类缺陷均修复" },
    "D2": { "score": 9, "evidence": "并发!==、tenantId:commandId、replay 单路径、补偿+投影、超时 updatedAt" },
    "D3": { "score": 8, "evidence": "Saga/Store/投影分层清晰；reconcile detail 文案有小瑕疵" },
    "D4": { "score": 8, "evidence": "仅 src 必要文件；.claude/settings.local.json 越界" },
    "D5": { "score": 7, "evidence": "15/15 test + build；无 run-manifest 分批回归记录" },
    "D6": { "score": 6, "evidence": "无交付 bullet；README 与实现不同步" }
  },
  "judge_total": 47,
  "one_line_verdict": "高难 Saga/对账/超时全链路修复正确且探针齐全，缺过程文档与 README 同步。",
  "implementation_summary": "实现对账与超时监控，修复 EventStore/幂等/投影/补偿，全部 vitest 通过。"
}
```

### 等级

| 指标 | 值 |
|------|-----|
| Gate | **38/40** |
| Judge | **47/60** |
| **Composite** | **85** |
| **等级** | **A**（80–89） |
| SR（本 run） | ✅ 客观成功 |
| iceCoder 回归门禁（附录 B） | ✅ G1=25 且 Composite≥70 |

### observability 对照（task yaml scoring_hints）

| 观测点 | CC (B) |
|--------|--------|
| EventStore 并发 `!==` | ✅ |
| 幂等键含 tenantId | ✅ |
| 重放与增量投影一致 | ✅ |
| ValidateDest 刷新 `updatedAt` | ✅ |
| 补偿更新投影 + 回滚扣减/入账 | ✅ |
| ReconciliationEngine 非空壳 | ✅ |
| SagaTimeoutMonitor 非空壳 | ✅ |
| 未改 test / 未加依赖 | ✅ |
| 仅改 src/ | ⚠️ 有 `.claude/` 产物 |
| ARCHITECTURE `reserved > onHand` 对账 | ⚠️ 未实现（测试未覆盖） |
| 交付 8 bullet / README 同步 | ⚠️ 未做到 |

### 已知瑕疵（不挡验收）

- `reconciliation-engine.ts`：`clamp_reserved` 的 `detail` 在赋值**后**拼接，日志文案前后值颠倒。
- `README.md` 仍标注 Reconciliation/Timeout「待补全」，与实现不符。

---

## 跨平台汇总

| 平台 | 代号 | SR | Composite | 等级 | Gate | Judge | 备注 |
|------|------|-----|-----------|------|------|-------|------|
| **iceCoder** | **A** | ✅ | **88** | **A** | 40 | 48 | 15/15；纯 `src/` 无越界 |
| **CC** | **B** | ✅ | **85** | **A** | 38 | 47 | 15/15；`.claude/` 越界 |
| 基线 | basic | ❌ | — | F 倾向 | — | — | 11 failed |

**跨平台结论（A / iceCoder vs B / CC）**

1. 两家均从基线 **11 failed → 0 failed**，客观成功率 SR 均为 ✅。
2. **iceCoder（A）Composite 88 > CC（B）85**：A Gate 满分（无 `.claude/` 越界），Judge D4 最小改动 +1；B 超时监控复用 `failSaga` 略优但不足以反超。
3. 共同短板在 **D5/D6**：均无 run-manifest、无原始 8 bullet、`README` 未同步。
4. 实现差异：A 对账释放写 EventStore 事件；B 纯 snapshot 修正。两者均通过全部探针。
5. 冲 **S（≥90）** 需：补交付说明、同步 README、修 detail 文案、记录 run-manifest；B 另需移出 `.claude/`。

---

## 备注

- 工作根目录：`E:\test\agentToolTest`
- 统一参测模型：`minimax-m2.5`
- 平台映射：**A = iceCoder**，**B = CC**（Claude Code）
- 最终裁判：Cursor Composer 2.5
- 评测体系：`benchMark/md/三平台同模对比评测与裁判评分体系.md`

## 裁判 cursor 对比

### 提示词（盲评）

```
E:\test\agentToolTest\saga-warehouse-reconciliation-X
@benchMark/md/三平台同模对比评测与裁判评分体系.md
综合文档，分析当前文件夹项目的修复质量
```

### 提示词（落盘）

```
@benchMark/reports/saga-warehouse-reconciliation-basic.md 更新到文档中。当前工具代号A
```

### 提示词（平台解盲）

```
01是iceCoder，02是CC。更新当前文档
```


## 自评

```
两者修复时间差距不大。CC（B）快了约 1 分钟左右。
除需要权限的操作外，均为用户无介入。
```
