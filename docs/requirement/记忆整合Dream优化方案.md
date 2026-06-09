# 记忆整合（Dream）与索引漂移优化方案

> **状态**：待评审（未实施）  
> **范围**：Phase 1 + Phase 2 全量；Phase 3 仅 #12、#13（不做 #11 定期后台巡检）  
> **关联提交**：`991a11c`（dream-state 竞态、召回遥测、同进程互斥、手动 Dream 冷却戳）  
> **关联文档**：[PROJECT-GUIDE 记忆系统](../PROJECT-GUIDE.md) · [记忆系统调整-finish](./记忆系统调整-finish.md) · [LoCoMo 召回路线图](../locomo/memory-optimization-roadmap.md)

---

## 1. 背景与问题

基于 `data/memory/telemetry.jsonl`（91 次 Dream 遥测）与代码审计，当前整合链路存在系统性失调：

| 现象 | 数据 |
|------|------|
| 索引类触发占比极高 | `stale_index` 82/91，`index_drift` 0（历史代码未拆分标签） |
| 瞬时 no-op | `executed=false` 54/91，其中 49 次 ≤5ms |
| LLM 空转 | `executed=true` 但 mod/del/ev=0：31/37 |
| 索引与磁盘脱节 | 曾出现 MEMORY.md 极少条目、磁盘 90+ 文件（孤儿 70+） |
| 手动整合「只读不写」 | LLM 常返回空 JSON；删改仅认 `file_writes`/`file_deletes`，`actions[]` 不执行 |

### 1.1 根因链

```text
每轮会话结束
  → evaluateDreamGate（orphans≥15 或 dead≥3）
  → 触发 Dream
  → 抢锁/互斥失败 → executed=false（无冷却）→ 下轮再触发
  → 或 LLM 整合 → 空 JSON / 仅 rebuild MEMORY.md
  → topic 记忆仍膨胀，索引漂移持续
```

### 1.2 三类问题需分别治理

| 类型 | 本质 | 能否靠 LLM 解决 |
|------|------|----------------|
| **索引漂移** | MEMORY.md 与磁盘 `.md` 不同步 | **否**，应规则层确定性修复 |
| **整合空转** | 门控敏感 + 失败无退避 + LLM 保守 noop | 部分，需改 prompt 与执行器 |
| **语义合并/删冗** | 重复记忆、过时事实 | **是**，但需预筛 + 安全闸 |

---

## 2. 设计原则

1. **索引健康 = 确定性规则，不靠 LLM**  
   MEMORY.md 的增删改查用代码完成；LLM 只做语义合并、删冗、习惯提炼。

2. **分层触发，各干各的**  
   - `index_drift` → **零 LLM**，规则重建索引  
   - `stale_index`（死链）→ 规则修链 → 仍不健康才 LLM  
   - `new_files` / `session` / `expired` / `over_cap` → LLM 整合

3. **写时修索引，读时校验**  
   每次写入记忆文件同步更新 MEMORY.md 一行，从源头避免孤儿累积。

4. **失败必退避**  
   任何 Dream 尝试（含 `executed=false`）对索引类触发写入退避，避免会话结束连环空打。

5. **自动化删改必有安全闸**  
   禁止自动删除高置信 / 高召回 / `feedback` 类型；合并留 `merged-from` 元数据。

6. **可观测**  
   遥测区分 `memory_index_rebuild`（规则）与 `memory_dream`（LLM），记录 `skipReason`。

---

## 3. 目标架构

```text
                    ┌─────────────────────────────────────┐
                    │         MemoryIndexMaintainer        │  ← 新增
                    │  upsertRow / removeRow / rebuildAll  │
                    └──────────────┬──────────────────────┘
                                   │ 写时同步
              Extract / Dream ─────┤
                                   │
                    ┌──────────────▼──────────────────────┐
                    │         evaluateDreamGate v2         │
                    │  1. 规则预检 indexHealth             │
                    │  2. 按 trigger 分流                  │
                    └──────────────┬──────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
   index_drift              stale_index              new_files / session
   RuleRebuild only         RuleRepair → LLM?        LLM consolidate
   (0 token)                (conditional)            (full pipeline)
```

---

## 4. 实施分期

### 4.1 Phase 1 — 止血（P0，预估 1–2 人天）

| # | 任务 | 主要文件 | 说明 |
|---|------|----------|------|
| 1.1 | **MemoryIndexMaintainer** | 新建 `memory-index-maintainer.ts` | `upsertIndexRow` / `removeIndexRows` / `rebuildIndexIfDrifted` / `repairIndexIfNeeded` |
| 1.2 | Extract 写后维护索引 | `memory-llm-extractor.ts` | 每次 `file_writes` 成功后 `upsertIndexRow` |
| 1.3 | Dream 删写后维护索引 | `memory-dream.ts` `executeDreamActions` | 与 1.1 共用串行写盘 |
| 1.4 | **index_drift 零 LLM** | `memory-dream.ts` `evaluateDreamGate` | 纯孤儿、无死链 → 仅 `rebuildMemoryIndexFromMemories`，`shouldRun: false` |
| 1.5 | **stale_index 规则优先** | `memory-dream.ts` | 先 `repairDeadLinks` + rebuild，仍不健康才 LLM |
| 1.6 | **失败退避** | `memory-dream.ts` + `dream-state.json` | `executed=false` 也写退避；指数退避 1–30min |
| 1.7 | 门控阈值可调 | `memory-config.ts` + `memory-config.json` | 孤儿改为比例阈值（见 §6） |
| 1.8 | 遥测增强 | `memory-telemetry.ts` | 新事件 `memory_index_rebuild`；`memory_dream.skipReason` |

**MEMORY.md 写串行化**：对 `MEMORY.md` 的所有写操作经 `sequential()` 或专用 index 锁，避免 Extract 与 Dream 竞态。

**验收标准**：

- 模拟 MEMORY.md 空 + 30 个 topic 文件 → 一轮会话结束 → **无 LLM 调用**，MEMORY.md 重建，orphans ≤ 5  
- 7 天内 `stale_index` 门控触发 < 3 次（真实死链除外）  
- `executed=false` 占比 < 5%

---

### 4.2 Phase 2 — 固本（P1，预估 3–5 人天）

| # | 任务 | 主要文件 | 说明 |
|---|------|----------|------|
| 2.1 | **Extract 写时去重** | `memory-llm-extractor.ts` + 新 `memory-dedup.ts` | 同 type + 描述相似度 > 0.85 → 更新已有文件而非新建；先 **shadow 模式** |
| 2.2 | **LLM 两阶段拆分** | `memory-dream.ts` | Index pass（`new_index` only，8192 tokens）/ Content pass（`file_writes/deletes`，4096 tokens） |
| 2.3 | **actions[] 映射器** | `memory-dream.ts` | `type: merge` → 读两文件拼写 + 删其一；默认 **关闭**，需 flag |
| 2.4 | 手动 Dream 分流 | `web/routes/memory-dream.ts` + `memory-page.js` | 先规则修索引 → 可选「深度 LLM 整合」 |
| 2.5 | 记忆页健康展示 | `memory-page.js` + `memory.css` | 索引 orphans/dead、上次整合原因、`skipReason` |
| 2.6 | 安全闸 | `memory-dream.ts` + `memory-dedup.ts` | 禁止自动删 `feedback`、禁止删 `confidence≥0.9` 或 `recallCount≥3` |
| 2.7 | 合并溯源 | 记忆 frontmatter | `merged-from: [a.md, b.md]`、`merged-at` ISO 时间 |

**验收标准**：

- 手动整合 UI：一步可见「索引已修复 N 条」+ 可选 LLM  
- shadow 去重运行 1 周，`would_merge` 日志无高危误并  
- LLM 整合空产出率 < 20%

---

### 4.3 Phase 3（部分）— 长效（P2，预估 2–3 人天）

**本方案包含**：

| # | 任务 | 说明 |
|---|------|------|
| 3.12 | **规则重复合并（无 LLM）** | TF-IDF / 文件名前缀聚类找候选对；超阈值则合并（先 shadow） |
| 3.13 | **Dream 专用模型 / 更高 maxTokens** | `memory-config.json` 增加 `dreamLlmModel`、`dreamMaxOutputTokens`；默认保持现值 |

**本方案明确不做**：

| # | 任务 | 不做原因 |
|---|------|----------|
| 3.11 | 定期后台 `indexHealthCheck`（每 30min） | 无会话时静默改索引，用户难感知、难排查；收益不如写时维护 |

---

## 5. 核心模块设计

### 5.1 MemoryIndexMaintainer（新增）

```typescript
// 职责摘要（非最终实现）
interface MemoryIndexMaintainer {
  upsertIndexRow(memoryDir: string, header: MemoryHeader): Promise<void>;
  removeIndexRows(memoryDir: string, filenames: string[]): Promise<void>;
  repairIndexIfNeeded(memoryDir: string): Promise<IndexRepairResult>;
  rebuildIndexIfDrifted(memoryDir: string, opts?: RebuildOpts): Promise<RebuildResult>;
}
```

| API | 调用时机 |
|-----|----------|
| `upsertIndexRow` | Extract / Dream 写盘后 |
| `removeIndexRows` | Dream 删盘 / evict 后 |
| `repairIndexIfNeeded` | `maybeDream` 门控前、`onLoopStart`（轻量） |
| `rebuildIndexIfDrifted` | `index_drift` 门控、手动「修复索引」按钮 |

复用现有：`auditMemoryIndexHealth`、`repairDeadLinksInMemoryIndex`、`rebuildMemoryIndexFromMemories`（`memory-index-health.ts`）。

### 5.2 evaluateDreamGate v2（伪代码）

```typescript
const health = await auditMemoryIndexHealth(memoryDir);

// 退避检查（含 executed=false 历史）
if (isIndexDreamInBackoff()) return { shouldRun: false, trigger: null, skipReason: 'backoff' };

// ① 纯孤儿漂移：规则自愈，不调 LLM
if (health.orphans >= orphanMinCount && health.dead === 0 && orphanRatio >= orphanRatioThreshold) {
  const rebuilt = await rebuildIndexIfDrifted(memoryDir);
  if (rebuilt.wrote) {
    await logIndexRebuild({ trigger: 'index_drift', entries: rebuilt.entryCount });
    await recordIndexDreamCompleted();
  }
  return { shouldRun: false, trigger: null, skipReason: rebuilt.wrote ? 'rule_fixed' : 'noop' };
}

// ② 死链：先规则修
if (health.dead >= staleIndexDeadLinksThreshold) {
  await repairIndexIfNeeded(memoryDir);
  const after = await auditMemoryIndexHealth(memoryDir);
  if (after.dead === 0 && after.orphans <= orphanSoftLimit) {
    await recordIndexDreamCompleted();
    return { shouldRun: false, skipReason: 'rule_fixed' };
  }
  return { shouldRun: true, trigger: 'stale_index' };
}

// ③ 其余门控：expired / over_cap / session / new_files（保持现有逻辑）
```

### 5.3 dream-state.json 扩展

```json
{
  "sessionCount": 1,
  "lastDreamTime": 0,
  "staleIndexDreamCompletedAt": 0,
  "lastDreamAttemptAt": 0,
  "lastDreamFailureAt": 0,
  "indexDreamFailureStreak": 0,
  "updatedAt": "2026-06-09T08:31:42.934Z"
}
```

退避公式：`min(30min, 2^streak × 1min)`，在 `stale_index` / `index_drift` 尝试失败时递增。

### 5.4 LLM 两阶段（Phase 2）

| 阶段 | 输入 | 输出 | maxTokens |
|------|------|------|-----------|
| **Index pass** | Index Health + 文件名列表 | `new_index` | 8192（可配置 3.13） |
| **Content pass** | top-40 摘要 + 重复候选对 | `file_writes` / `file_deletes` | 4096 |

当门控为 `new_files` / `session` 时仅跑 Content pass；仅当规则层未能修复索引时才跑 Index pass。

### 5.5 规则重复合并（Phase 3.12）

1. 扫描同 `type` 下所有记忆  
2. 计算 `description` + `tags` TF-IDF 余弦相似度  
3. 相似度 ≥ 0.88 且非同文件 → 候选对  
4. **shadow**：仅写 `memory_dedup_shadow` 遥测  
5. **merge**：保留高 `recallCount × confidence` 者，另一文件 body 追加为 `## Merged from xxx` 段落后删除  
6. 排除：`feedback` 类型不参与自动合并

---

## 6. 配置建议

`data/memory/memory-config.json`（支持热加载）：

```json
{
  "dream": {
    "minHours": 4,
    "minSessions": 3,
    "orphanRatioThreshold": 0.2,
    "orphanMinCount": 5,
    "orphanSoftLimit": 10,
    "staleIndexCooldownMinutes": 30,
    "indexRebuildMaxEntries": 120,
    "llmOnIndexDrift": false,
    "failureBackoffBaseMinutes": 1,
    "failureBackoffMaxMinutes": 30,
    "dreamMaxOutputTokens": 8192,
    "dreamLlmModel": null
  },
  "dedup": {
    "extractSimilarityThreshold": 0.85,
    "ruleMergeSimilarityThreshold": 0.88,
    "mode": "shadow"
  }
}
```

### 6.1 环境变量 Feature Flag（建议）

| 变量 | 默认 | 说明 |
|------|------|------|
| `ICE_INDEX_WRITE_THROUGH` | `true` | P1 写时维护索引 |
| `ICE_INDEX_DRIFT_RULE_ONLY` | `true` | P1 漂移零 LLM |
| `ICE_DREAM_FAILURE_BACKOFF` | `true` | P1 失败退避 |
| `ICE_EXTRACT_DEDUP` | `shadow` | P2 去重：`off` / `shadow` / `merge` |
| `ICE_RULE_MERGE` | `shadow` | P3.12：`off` / `shadow` / `merge` |
| `ICE_DREAM_TWO_PHASE` | `false` | P2 两阶段 LLM |
| `ICE_DREAM_ACTIONS_EXEC` | `false` | P2 actions 映射执行 |

---

## 7. 遥测与可观测性

### 7.1 新事件

| 类型 | 字段 |
|------|------|
| `memory_index_rebuild` | `trigger`, `orphansBefore`, `deadBefore`, `entriesAfter`, `durationMs`, `ruleOnly: true` |
| `memory_dedup_shadow` | `action`, `fileA`, `fileB`, `similarity`, `wouldMerge` |
| `memory_dream`（增强） | `skipReason`, `llmInvoked`, `ruleFixedBeforeLlm`, `phase` |

### 7.2 健康指标目标

| 指标 | 现状（约） | 目标 |
|------|------------|------|
| 7 天 `stale_index` 门控 | 82/91 | **< 3** |
| `executed=false` 占比 | 59% | **< 5%** |
| LLM Dream 空产出率 | 84% | **< 20%** |
| MEMORY.md 孤儿数 | 曾 70+，现 3 | **常态 ≤ 5** |
| 规则层索引修复占比 | ~0% | **> 90%** |

---

## 8. 风险评估

### 8.1 分项矩阵

| 阶段 | 项 | 风险等级 | 说明 |
|------|-----|----------|------|
| P1 | 写时维护 MEMORY.md | **中** | Extract 与 Dream 并发写索引；需串行化 |
| P1 | index_drift 零 LLM | **低** | 仅改索引，不删 topic 文件 |
| P1 | 失败退避 | **低** | 整合可能延迟 1–30min |
| P2 | Extract 去重 | **中高** | 误判合并 → 新事实未写入 |
| P2 | actions 映射执行 | **中高** | LLM 幻觉导致误删 |
| P2 | 两阶段 LLM | **中** | 延迟与成本上升 |
| P3.12 | 规则重复合并 | **中高** | 与去重叠加，近义不同事实可能误并 |
| P3.13 | 高 maxTokens / side model | **中** | 配置不当 → 成本或超时 |

### 8.2 数据安全闸（必须实现）

- 自动删除 **禁止**：`type: feedback`、任意 `confidence ≥ 0.9`、`recallCount ≥ 3`  
- 自动合并前：Dream 备份（现有 `enableBackup`）+ 合并写 `merged-from`  
- Extract 去重 / 规则合并：先 **shadow 1 周**，人工抽查 `would_merge` 日志

### 8.3 回滚策略

- 各 flag 可独立关闭，无需回滚代码  
- `dream-backups/` 保留最近 3 次整合前快照  
- `ICE_INDEX_WRITE_THROUGH=false` 可退回「仅 Dream 时修索引」旧行为

---

## 9. 用户体验影响

### 9.1 正面（主导）

| 体验 | 变化 |
|------|------|
| 会话结束卡顿 | 明显减少；索引类不再触发 60s+ LLM |
| 手动「整合记忆」 | 有明确分步反馈：索引修复 → 可选深度合并 |
| MEMORY.md 可信度 | 与磁盘基本一致 |
| 记忆库体积 | 去重/合并后增速放缓 |
| 可解释性 | 记忆页展示健康度与 skip 原因 |

### 9.2 负面（需产品化处理）

| 体验 | 缓解 |
|------|------|
| 「怎么不自动整合了？」 | UI 文案说明索引已自动修复、深度合并有冷却 |
| 「记忆怎么没了？」 | 合并溯源 + 最近变更日志；禁止删 feedback |
| 手动整合变两步 | 默认「一键智能整合」= 规则 + LLM |
| 升级后索引一次性大变 | 首次启动静默 rebuild，不打断对话 |

### 9.3 综合评分

| 指标 | 1–5 | 备注 |
|------|:---:|------|
| 解决彻底性 | 5 | 对准根因 |
| 实施风险 | 3 | 去重/合并需 shadow |
| 回滚难度 | 2 | flag + 备份 |
| 用户感知收益 | 4 | 卡顿↓、整合可信↑ |
| 用户感知伤害 | 2 | 误并低概率但影响大 |

---

## 10. 推荐上线顺序

```text
Week 1  开 P1 全部（1.1–1.8）→ 观察遥测 3 天
Week 2  开 P2 的 2.4、2.5、2.6（UI + 安全闸 + 手动分流）
Week 2  开 P2 的 2.2（两阶段 LLM，flag 默认 false → true）
Week 3  ICE_EXTRACT_DEDUP=shadow → 抽查 → merge
Week 3  ICE_RULE_MERGE=shadow → 抽查 → merge
Week 4  ICE_DREAM_ACTIONS_EXEC=true（最后开）
Week 4  P3.13 按需调高 maxTokens 或指定 side model
```

**总工时估算**：8–12 人天（含测试与 shadow 观察期）。

---

## 11. 测试计划

| 类别 | 用例 |
|------|------|
| 单元 | `MemoryIndexMaintainer` upsert/remove/rebuild；门控 v2 各分支；退避计算 |
| 集成 | MEMORY.md 空 + 30 文件 → 会话结束 → 无 LLM、orphans≤5 |
| 集成 | 并发 Extract + Dream → MEMORY.md 无重复行 |
| 集成 | `executed=false` 后 5 分钟内不再 index 门控 true |
| 回归 | 现有 `memory-dream.test.ts`、`memory-index-health.test.ts`、召回 e2e |
| shadow | 真实库跑 7 天，导出 `would_merge` 供人工审核 |

---

## 12. 与现有代码的关系

| 已有能力 | 本方案如何使用 |
|----------|----------------|
| `rebuildMemoryIndexFromMemories` | P1 规则层主力，前移到晚于门控 |
| `repairDeadLinksInMemoryIndex` | P1 stale_index 规则优先 |
| `tryEnterConsolidation` | 保留；补充 `skipReason: mutex` 遥测 |
| `mergePersistedTimestamps` | 保留；与 dream-state 退避字段共存 |
| `notifyStaleIndexDreamCompleted` | 扩展为 `recordIndexDreamCompleted`（规则修复也写入） |
| Dream prompt `actions[]` | P2 映射器；默认不执行 |

---

## 13. 成功标准（「彻底解决」定义）

| 维度 | 目标 |
|------|------|
| 7 天 `stale_index` 触发 | < 3 次 |
| `executed=false` | < 5% |
| LLM Dream 空产出 | < 20% |
| MEMORY.md 孤儿 | 常态 ≤ 5 |
| 会话结束索引修复耗时 | < 200ms（规则层） |
| 用户投诉「记忆丢了」 | 0（shadow 期不计） |

---

## 14. 待决事项（评审时确认）

- [ ] Extract 去重相似度阈值 0.85 是否过激进？  
- [ ] `indexRebuildMaxEntries` 120 是否导致大库索引不全？（可调至 200 或分页索引）  
- [ ] 两阶段 LLM 是否默认开启，还是仅手动整合时开启？  
- [ ] `dreamLlmModel` 是否复用主模型配置还是独立 side 配置？  
- [ ] shadow 观察期 1 周是否可接受，还是 3 天快速迭代？

---

*文档版本：2026-06-09 · 作者：记忆系统审计会话整理*
