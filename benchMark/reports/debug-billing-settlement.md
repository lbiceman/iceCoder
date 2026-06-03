# debug-billing-settlement-03 评测报告

> **task_id**：`debug-billing-settlement-03`  
> **prompt 版本**：v1.0（2026-05-25）  
> **评测日期**：2026-06-03（裁判复评 + 本机验收复跑）  
> **裁判**：Cursor Composer 2.5（盲评）  
> **rubric**：`JUDGE_RUBRIC_v0.1`

## 项目介绍

多租户 **SaaS 计费与收入确认** TypeScript 沙箱（L4+ 超高难 · 长上下文 stress）：

- **97 源文件 · ~441KB · ~9200 行**（显著超出 200K token 上下文）
- **19 处**跨 currency / tax / pricing / proration / subscription / invoice / payment / credit / revenue / reconciliation / dunning / idempotency / pipeline 的隐性逻辑缺陷
- 基线 **19/19 Vitest 探针全失败**；验收要求仅改 `src/`，禁止改 `test/` 与锁文件
- 任务 yaml 时间盒：**180 min / 200 turns**

---

## 提示词（verbatim · v1.0）

复制参测时使用 [`../tasks/debug-billing-settlement-03.yaml`](../tasks/debug-billing-settlement-03.yaml) 中 `prompt` 字段。

**任务特点**：prompt 内含 **19 条已知现象线索**（模块级 hint），降低纯盲探难度，但仍需理解边界语义并在 19 个文件中分别落地最小修复。

---

## 平台

| 代号 | 平台 | 工作目录 | 状态 |
|------|------|----------|------|
| **01** | **iceCoder**（Harness · adaptive） | `E:\test\agentToolTest\debug-billing-settlement-01` | ✅ 已评 |
| **02** | **CC**（Claude Code） | `E:\test\agentToolTest\debug-billing-settlement-02` | ✅ 已评 |

> 目录后缀为批次代号；**平台身份已解盲**：**01 = iceCoder**，**02 = CC（Claude Code）**。01 执行统计来自 Harness session **`c662d476`**；02 墙钟由参测方记录，**无 turn 日志**。

**参测约定**

- 模型：两家均为 **`MiniMax-M3`（minimax-m3）** — **同模可横比**
- 01：iceCoder `adaptive` · Harness
- 02：Claude Code CLI/IDE
- 工作区均 **非 git 仓库**；变更范围依据代码审查 + 与 01 逐文件 diff + 任务规格 §3 缺陷表

---

## Run: 01 / iceCoder / debug-billing-settlement-03

### 实现摘要（≤150 字）

在 **19 个目标模块** 各做 **1–5 行级**逻辑修正，使 **19/19 Vitest 探针全绿**。覆盖：FX 除法方向、税区 `>=` 门槛、复合税 local 税基、量价档边界、折扣取 max、账期实际天数 proration、升级 credit 负号、账期/试用 inclusive 日期、setup fee 去重、税行整单舍入、付款高优先级分配、credit 封顶、递延 schedule 条数、余数 cent 均分、对账币种校验、催款工作日、幂等 tenant 作用域、编排先折扣后税。**未改** `test/`、`package.json`、锁文件；`src/` 体量保持 97 文件 / 441KB。

### 变更文件

| 文件 | 变更类型 | 一行说明 |
|------|----------|----------|
| `src/currency/currency-converter.ts` | 修改 | `convertToBase` 改为 `amount / foreignPerBase` |
| `src/tax/jurisdiction-resolver.ts` | 修改 | 阈值判定 `subtotal >= threshold` |
| `src/tax/compound-tax-engine.ts` | 修改 | local 税基仅 `subtotalCents` |
| `src/pricing/volume-tier.ts` | 修改 | 最高档 `quantity >= tier.minQuantity` |
| `src/pricing/loyalty-discount.ts` | 修改 | `Math.max(loyalty, promo)` 非叠加 |
| `src/proration/daily-proration.ts` | 修改 | 分母为账期实际 `daysBetween` |
| `src/proration/upgrade-proration.ts` | 修改 | unused credit 返回负值 |
| `src/subscription/billing-cycle.ts` | 修改 | 期末 `addDays(start, intervalDays - 1)` inclusive |
| `src/subscription/trial-manager.ts` | 修改 | 试用末日前 `today <= trialEnd` 仍 active |
| `src/invoice/line-item-aggregator.ts` | 修改 | `priorSetupFeeCharged` 时跳过 setup fee |
| `src/invoice/tax-line-builder.ts` | 修改 | 整单 tax 一次舍入后分摊至各行 |
| `src/payment/allocation-engine.ts` | 修改 | 按 `priority` 降序分配 |
| `src/credit/credit-applicator.ts` | 修改 | `Math.min(credit, amountDue)` 封顶 |
| `src/revenue/deferred-revenue.ts` | 修改 | schedule 恰好 `periods` 条 |
| `src/revenue/recognition-schedule.ts` | 修改 | 余数 cent 均匀加到前几期 |
| `src/reconciliation/ledger-matcher.ts` | 修改 | 增加 `currency` 一致校验 |
| `src/dunning/escalation-ladder.ts` | 修改 | `escalationForPeriod` 用 `businessDaysBetween` |
| `src/idempotency/idempotency-guard.ts` | 修改 | cache key 为 `` `${tenantId}:${commandId}` `` |
| `src/pipeline/billing-orchestrator.ts` | 修改 | 先折扣后税：`taxable = subtotal - discount` |

**未改动**：`test/`、`package.json`、`package-lock.json`、`vitest.config.ts`、`scripts/generate-all.mjs`；`audit/`、`utils/` 等干扰模块未动刀

### BUG 修复完成度（19/19）

| ID | 模块 | 状态 | 修复要点 |
|----|------|------|----------|
| BUG-01 | currency | ✅ | 外币→本币除 rate |
| BUG-02 | tax/jurisdiction | ✅ | 恰好在门槛也征税 |
| BUG-03 | tax/compound | ✅ | local 不对 subtotal+state 二次计税 |
| BUG-04 | pricing/volume | ✅ | 顶档边界 inclusive |
| BUG-05 | pricing/loyalty | ✅ | 取最优单项折扣 |
| BUG-06 | proration/daily | ✅ | 分母为账期日历天数 |
| BUG-07 | proration/upgrade | ✅ | credit 负号 |
| BUG-08 | subscription/cycle | ✅ | 期末 off-by-one |
| BUG-09 | subscription/trial | ✅ | 试用末日仍 active |
| BUG-10 | invoice/aggregator | ✅ | 升级不重复 setup fee |
| BUG-11 | invoice/tax-line | ✅ | penny 与整单舍入一致 |
| BUG-12 | payment/allocation | ✅ | 高 priority 先分配 |
| BUG-13 | credit | ✅ | amountDue 不为负 |
| BUG-14 | revenue/deferred | ✅ | 恰好 N 条 schedule |
| BUG-15 | revenue/recognition | ✅ | 余数不均堆末期 |
| BUG-16 | reconciliation | ✅ | 币种必须一致 |
| BUG-17 | dunning/escalation | ✅ | 工作日而非日历日 |
| BUG-18 | idempotency | ✅ | tenant 作用域隔离 |
| BUG-19 | pipeline/orchestrator | ✅ | 先折扣后税 |

### 关键 diff 片段

**BUG-01 · FX 方向**

```typescript
// 修复后
return Math.round(amountCents / foreignPerBase);
```

**BUG-19 · 编排顺序**

```typescript
const discountCents = Math.round((input.subtotalCents * input.discountPercent) / 100);
const taxableCents = input.subtotalCents - discountCents;
const taxCents = Math.round((taxableCents * input.taxRateBps) / 10000);
```

**BUG-18 · 幂等作用域**

```typescript
export function idempotencyKey(tenantId: TenantId, commandId: CommandId): string {
  return `${tenantId}:${commandId}`;
}
```

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm ci` | **PASS** (exit 0) | 2026-06-03 复跑，48 packages |
| `npm test` | **PASS** (exit 0) | **19/19**（1.12s） |
| `npm run build` | **PASS** (exit 0) | `tsc --noEmit` 无错误 |
| `node scripts/size-report.mjs` | **PASS** (exit 0) | 97 files · 9204 lines · 441.0 KB |

**SR_objective = 通过**（四条验收全部 exit 0）

| 探针 | 结果 |
|------|------|
| currency converter | ✓ |
| jurisdiction resolver | ✓ |
| compound tax engine | ✓ |
| volume tier pricing | ✓ |
| loyalty discount | ✓ |
| daily proration | ✓ |
| upgrade proration | ✓ |
| billing cycle | ✓ |
| trial manager | ✓ |
| line item aggregator | ✓ |
| tax line builder | ✓ |
| payment allocation | ✓ |
| credit applicator | ✓ |
| deferred revenue | ✓ |
| recognition schedule | ✓ |
| ledger matcher | ✓ |
| escalation ladder | ✓ |
| idempotency guard | ✓ |
| billing orchestrator | ✓ |

### 执行统计

| 字段 | 值 |
|------|-----|
| platform | **iceCoder**（`adaptive` · Harness） |
| codename | **01** |
| sessionId | **`c662d476`** |
| model | **`MiniMax-M3`（minimax-m3）** |
| turns | **23**（`loop.currentRound: 23`；Harness 日志「第 23 轮」） |
| duration | **219217 ms（≈3.6 min）**（`createdAt` 01:05:19 → `updatedAt` 01:08:58 UTC，2026-06-03） |
| tool_calls | **71**（含 19×`edit_file`、3×`npm test`、19×末轮 `file_info` 等） |
| messages | **106** |
| tokens | in **787809** / out **7727** |
| human_assist | **false** |
| harness_notes | 第 16 轮 Supervisor **recover**（`no_progress`）；第 21 轮 **handoff** 交还模型；`tax-line-builder.ts` **v2 迭代**（首轮 tax 分摊仍 fail → 二修后 19/19） |

### Gate 客观门禁（0–40）

| 子项 | 分值 | 判定 |
|------|------|------|
| G1 验收通过 | **25/25** | 四条 acceptance 命令全 exit 0；19/19 探针 |
| G2 范围合规 | **8/8** | 仅 `src/` 内 19 个缺陷文件；未改 `test/`、`package.json`、锁文件、`generate-all.mjs` |
| G3 可构建 | **4/4** | `npm run build` exit 0 |
| G4 无致命泄漏 | **3/3** | 无 `.env`/密钥提交 |

**Gate 合计：40/40**

### Composer 2.5 裁判评分（0–60）

| 维度 | 分 | evidence（摘要） |
|------|-----|------------------|
| D1 需求完成度 | **10** | **19/19 全修**；未漏后半模块（idempotency / dunning / pipeline） |
| D2 正确性 | **9** | 修复为通用语义（`>=`、inclusive 日期、负 credit、tenant key 等），非测试值硬编码；`tax-line-builder` 分摊策略与整单舍入一致 |
| D3 代码质量 | **8** | 保留原有模块结构与 API；`escalation-ladder.ts` 遗留未使用的 `calendarDaysInclusive` 死代码 |
| D4 最小改动 | **10** | **仅 19 文件、行级 diff**；未重构 audit/utils 干扰项；未删大量 generate-all 产物 |
| D5 验证意识 | **8** | **3 次 `npm test`**（基线 fail → 批量修复后仍 1 fail → `tax-line-builder` v2 后 19/19）；`npm run build` 终验；末轮 19×`file_info` 复核 |
| D6 实现说明 | **8** | 终稿 **19 条 bullet** 与 diff 一一对应（session 终消息）；REFERENCE 注释与修复语义一致 |

**Judge 合计：53/60**

```json
{
  "run_id": "anon-billing-01",
  "dimensions": {
    "D1": { "score": 10, "evidence": "19/19 vitest probes green; all modules from BUG-01..19 addressed" },
    "D2": { "score": 9, "evidence": "Semantic fixes: FX divide, >= threshold, discount-before-tax, tenant-scoped idempotency" },
    "D3": { "score": 8, "evidence": "Minimal invasive edits; dead calendarDaysInclusive helper remains in escalation-ladder.ts" },
    "D4": { "score": 10, "evidence": "Exactly 19 src files touched; test/ and package.json untouched; 97 files 441KB preserved" },
    "D5": { "score": 8, "evidence": "3 npm test runs; tax-line-builder v2 after 18/19 pass; build + file_info verify" },
    "D6": { "score": 8, "evidence": "Final reply lists 19 bullets matching each module fix; REFERENCE blocks align" }
  },
  "judge_total": 53,
  "one_line_verdict": "19 处缺陷 23 轮 ≈3.6min 全修；测试驱动迭代（tax-line v2）；交付 bullet 完整。",
  "implementation_summary": "在 19 个 billing 子模块做行级逻辑修正（FX/税/proration/编排/幂等等），使 19 项 Vitest 探针与 tsc 构建全通过。"
}
```

### 综合分与等级

| 指标 | 值 |
|------|-----|
| Gate | **40/40** |
| Judge | **53/60** |
| **Composite** | **93** |
| **等级** | **S**（验收通过 + 实现优秀；**23 轮 / ≈3.6 min** 完成 L4+；可作为 iceCoder 标杆 run） |

### 关键亮点与剩余缺口

1. **全量完成**：Rare for L4+ — 19/19 探针 + 四条验收 + 体量未缩水（97 文件 / 441KB）。
2. **最小 diff 典范**：每个缺陷文件 1–5 行核心改动，未动 78 个干扰/噪音文件。
3. **效率突出**：**23 轮 / 墙钟 ≈3.6 min / 71 tool calls** 完成 19 文件修复，远低于任务规格 180 min / 200 turns。
4. **prompt 线索效应**：yaml prompt 已列出 19 条现象，Agent 按线索直读目标文件，**未体现「97 文件盲探 + 长上下文截断」压力**；跨平台对比时须标注。
5. **测试驱动迭代**：批量修复后 `tax-line-builder` 仍 1 fail，二修 `allocated` 分摊逻辑后全绿（`fileDeliverableWriteVersions: 2`）。
6. **Supervisor 介入**：第 16 轮 recover（连续 `no_progress`）；第 21 轮 handoff，**非人工 assist**。
7. **非阻塞**：`escalation-ladder.ts` 中 `calendarDaysInclusive` 未删除（不影响探针）。

### 与任务 prompt 偏差一览

| 要求 | 01（iceCoder）现状 |
|------|-------------------|
| 仅改 `src/` | ✅ |
| 19 探针全绿 | ✅ |
| `npm run build` | ✅ |
| size-report ≥55 文件 / ≥250KB | ✅（97 / 441KB） |
| 保持公开 API 不变 | ✅ |
| 完成后 ≤10 条 bullet 说明 | **✓**（session 终稿 19 条；未写入仓库文件） |
| 长上下文盲探（无线索） | **部分偏离** — prompt v1.0 含 19 条线索 |

---

## Run: 02 / CC / debug-billing-settlement-03

### 实现摘要（≤150 字）

Claude Code 在 **19 个目标模块** 做行级逻辑修正，**19/19 探针全绿**。修复语义与 01 基本一致：`convertToBase` 除法、税区 `>=`、复合税 local 基、量价档 `>=`、折扣 `Math.max`、账期天数 proration、负 credit、inclusive 日期、setup fee `&&`、税行整单舍入分摊、高 priority 分配、credit 封顶、schedule 条数、余数均分、币种校验、工作日 escalation、tenant 幂等键、先折扣后税。**差异**：`tax-line-builder` 用 `taxOnTotal` + 比例 `floor` 分摊（更整洁）；`idempotencyKey` 为 `` `${tenantId}::${commandId}` ``；`deferred-revenue` 循环上界已修但 **`i === periods` 分支成死代码**。

### 变更文件

与 01 相同 **19 个 `src/` 文件**；相对 01 有 **6 处实现差异**（见下表「相对 01」列）。

| 文件 | 变更类型 | 一行说明 | 相对 01 |
|------|----------|----------|---------|
| `src/currency/currency-converter.ts` | 修改 | `convertToBase` → `/ foreignPerBase` | 同 |
| `src/tax/jurisdiction-resolver.ts` | 修改 | `>= threshold` | 同 |
| `src/tax/compound-tax-engine.ts` | 修改 | local 基 = subtotal | 同 |
| `src/pricing/volume-tier.ts` | 修改 | `quantity >= tier.minQuantity` | index `for` vs `for-of` |
| `src/pricing/loyalty-discount.ts` | 修改 | `Math.max` | 同 |
| `src/proration/daily-proration.ts` | 修改 | `daysBetween` 分母 | 同 |
| `src/proration/upgrade-proration.ts` | 修改 | 负 credit | 同 |
| `src/subscription/billing-cycle.ts` | 修改 | `intervalDays - 1` | 同 |
| `src/subscription/trial-manager.ts` | 修改 | `t <= end` | 同 |
| `src/invoice/line-item-aggregator.ts` | 修改 | upgrade `&& !priorSetupFeeCharged` | 同 |
| `src/invoice/tax-line-builder.ts` | 修改 | `taxOnTotal` + 比例分摊 + 末行余量 | **实现不同**（更整洁） |
| `src/payment/allocation-engine.ts` | 修改 | `b.priority - a.priority` | 同 |
| `src/credit/credit-applicator.ts` | 修改 | `Math.min(..., Math.max(0, amountDue))` | 多一层 defensive |
| `src/revenue/deferred-revenue.ts` | 修改 | `i < periods` | **末条条件仍为 `i === periods`（死分支）** |
| `src/revenue/recognition-schedule.ts` | 修改 | 余数均匀分配 | `if (remainder > 0)` 包裹 |
| `src/reconciliation/ledger-matcher.ts` | 修改 | currency 校验 | 同 |
| `src/dunning/escalation-ladder.ts` | 修改 | `businessDaysBetween` | 同 |
| `src/idempotency/idempotency-guard.ts` | 修改 | `` `${tenantId}::${commandId}` `` | 分隔符 `::` vs `:` |
| `src/pipeline/billing-orchestrator.ts` | 修改 | 先折扣后税 | 同 |

**未改动**：`test/`、`package.json`、`package-lock.json`、`vitest.config.ts`、`scripts/generate-all.mjs`

**平台产物**：`.claude/settings.local.json`（CC 本地权限配置，非 `src/` 逻辑修复）

### BUG 修复完成度（19/19）

全部 ✅（与 01 相同探针表；BUG-14 仅断言条数，CC 未修正 `recognizedCents` 末条语义但探针仍过）

### 关键 diff 片段

**BUG-11 · 税行舍入（CC 实现）**

```typescript
const totalTax = taxOnTotal(totalTaxable, rateBps);
// ...
const share = isLast ? totalTax - allocated : Math.floor((totalTax * l.taxableCents) / totalTaxable);
```

**BUG-18 · 幂等键（CC）**

```typescript
return `${tenantId}::${commandId}`;
```

**BUG-14 · 递延收入（CC 遗留死分支）**

```typescript
for (let i = 0; i < periods; i++) {
  recognizedCents: i === periods ? totalCents - per * periods : per, // `i === periods` 不可达
}
```

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm ci` | **PASS** (exit 0) | 2026-06-03 复跑 |
| `npm test` | **PASS** (exit 0) | **19/19**（0.86s） |
| `npm run build` | **PASS** (exit 0) | `tsc --noEmit` 无错误 |
| `node scripts/size-report.mjs` | **PASS** (exit 0) | 97 files · 9210 lines · 441.2 KB |

**SR_objective = 通过**

### 执行统计

| 字段 | 值 |
|------|-----|
| platform | **CC**（Claude Code） |
| codename | **02** |
| model | **`MiniMax-M3`（minimax-m3）** |
| turns | **—**（参测方未记录；CC 无 Harness session 可对齐） |
| duration | **345 s（5 min 45 s）**（参测方记录） |
| tool_calls | **—** |
| human_assist | **false**（假定） |
| notes | `.claude/settings.local.json` 预授权 `npm test` / `npm run` / `size-report` |

### Gate 客观门禁（0–40）

| 子项 | 分值 | 判定 |
|------|------|------|
| G1 验收通过 | **25/25** | 四条 acceptance 全 exit 0；19/19 |
| G2 范围合规 | **8/8** | 19 处逻辑修复均在 `src/`；`test/` / 锁文件未改；`.claude/` 为 CC 平台元数据不计入任务 diff |
| G3 可构建 | **4/4** | build exit 0 |
| G4 无致命泄漏 | **3/3** | 无 `.env`/密钥 |

**Gate 合计：40/40**

### Composer 2.5 裁判评分（0–60）

| 维度 | 分 | evidence（摘要） |
|------|-----|------------------|
| D1 需求完成度 | **10** | 19/19 全修；未漏 idempotency / pipeline 等后半模块 |
| D2 正确性 | **9** | 语义修复非硬编码；`deferred-revenue` 末条 `i === periods` 死分支但探针仅验条数 |
| D3 代码质量 | **8** | `tax-line-builder` 重构更清晰；`deferred-revenue` 遗留不可达分支；`escalation-ladder` 仍有 `calendarDaysInclusive` 死代码 |
| D4 最小改动 | **10** | 仅 19 个缺陷文件；未动 audit/utils 干扰项 |
| D5 验证意识 | **8** | 终态 19/19 + build；CC 权限配置含 `npm test`；墙钟 5m45s 合理；**无多轮 test 日志** |
| D6 实现说明 | **7** | 无 iceCoder 式 session 终稿 bullet 可核对；参测方未提供交付摘要 |

**Judge 合计：52/60**

```json
{
  "run_id": "anon-billing-02",
  "dimensions": {
    "D1": { "score": 10, "evidence": "19/19 vitest probes green" },
    "D2": { "score": 9, "evidence": "Semantic fixes; deferred-revenue dead branch i===periods passes length-only probe" },
    "D3": { "score": 8, "evidence": "Cleaner tax-line-builder; dead code in deferred-revenue recognizedCents ternary" },
    "D4": { "score": 10, "evidence": "19 src files only; 97 files 441KB preserved" },
    "D5": { "score": 8, "evidence": "Full acceptance pass; CC npm test permission; no logged iteration count" },
    "D6": { "score": 7, "evidence": "No verifiable delivery bullets in available logs" }
  },
  "judge_total": 52,
  "one_line_verdict": "同模全绿；tax-line 实现更优；deferred-revenue 留死分支；墙钟慢于 iceCoder 01。",
  "implementation_summary": "CC 在 19 个 billing 模块行级修 BUG，19/19 探针与 tsc 通过；6 处与 iceCoder 01 实现细节不同。"
}
```

### 综合分与等级

| 指标 | 值 |
|------|-----|
| Gate | **40/40** |
| Judge | **52/60** |
| **Composite** | **92** |
| **等级** | **S**（验收通过 + 质量良好；同模 SR=1） |

### 关键差异与剩余缺口

1. **相对 01（iceCoder · 同模 m3）**：02 **墙钟更长**（5m45s vs ≈3.6 min）；01 有 **23 轮 / 71 tool calls / tax-line v2 迭代** 可观测日志，02 无 turns。
2. **实现质量互有长短**：02 的 **`tax-line-builder`** 更整洁（复用 `taxOnTotal` + 比例分摊）；01 的 **`deferred-revenue`** 末条 `periods - 1` 语义更完整。
3. **prompt 线索效应**：与 01 相同，19 条 hint 降低盲探难度。
4. **非阻塞**：`deferred-revenue` 死分支、`escalation-ladder` 未删 `calendarDaysInclusive`。

### 与任务 prompt 偏差一览

| 要求 | 02（CC）现状 |
|------|-------------|
| 仅改 `src/` | ✅ |
| 19 探针全绿 | ✅ |
| `npm run build` | ✅ |
| size-report | ✅（97 / 441KB） |
| ≤10 条 bullet | **未核对**（无 session 终稿） |
| 长上下文盲探 | **部分偏离**（prompt 含 19 线索） |

---

## 跨平台对比

| 代号 | 平台 | 模型 | SR | Composite | 等级 | Gate | Judge | Turns | Duration | 备注 |
|------|------|------|-----|-----------|------|------|-------|-------|----------|------|
| **01** | **iceCoder** | **MiniMax-M3** | **1** | **93** | **S** | **40** | **53** | **23** | **≈3.6 min** | Harness；tax-line v2；Supervisor recover/handoff |
| **02** | **CC** | **MiniMax-M3** | **1** | **92** | **S** | **40** | **52** | **—** | **5m 45s** | tax-line 更整洁；deferred-revenue 死分支 |

**同模（MiniMax-M3）横向要点：**

- **SR**：均为 **1**（19/19 + 四条验收）。
- **质量**：Composite **01 93 > 02 92**（−1）；Judge **53 vs 52**（见下节「分差解读」）。
- **效率**：**01 墙钟更短**（≈3.6 min vs 5m45s）；01 有明确 **23 轮** Harness 记录，02 turns 未知。
- **实现差异**：19 文件中 **6 处** diff；02 **`tax-line-builder` 更优**；01 **`deferred-revenue` / `idempotencyKey` 语义更干净**。
- **归因**：同模下差异主要来自 **平台 Harness（Supervisor / 工具链）与实现细节**，非模型能力。

### Composite 分差解读（01 vs 02 · +1）

**Composite 93 vs 92 的 1 分差，全部来自 Judge；Gate 两家均为 40/40，验收层面完全等价。**

#### Judge 六维对照

| 维度 | 01 iceCoder | 02 CC | 差 |
|------|-------------|-------|-----|
| D1 需求完成度 | 10 | 10 | 0 |
| D2 正确性 | 9 | 9 | 0 |
| D3 代码质量 | 8 | 8 | 0 |
| D4 最小改动 | 10 | 10 | 0 |
| D5 验证意识 | 8 | 8 | 0 |
| **D6 实现说明** | **8** | **7** | **−1** |
| **Judge 合计** | **53** | **52** | **−1** |

**1 分扣在 D6（实现说明），不是验收、正确性或代码质量。**

#### 为何 D6 差 1 分？

| | 01 iceCoder | 02 CC |
|--|-------------|-------|
| 交付摘要 | Harness session **`c662d476`** 终稿含 **19 条 bullet**，与 19 个模块修复及 tool_trace diff **一一对应** | 裁判侧 **无** 可对齐的 session / 终稿 bullet；参测方亦未补充 CC 交付摘要 |
| rubric 档位 | **8 分** — diff 与行为一致，易审查 | **7 分** — 基本能看懂做了什么，但缺少可核对的书面说明 |

#### 01 是否「全面更好」？

**否。** 客观结果几乎打平，互有长短：

| 维度 | 谁略优 | 说明 |
|------|--------|------|
| 验收 SR | 平 | 均 19/19 + 四条 acceptance |
| 墙钟 | **01** | ≈3.6 min vs 5m45s |
| 可观测过程 | **01** | 23 轮、71 tool calls、3×`npm test`、`tax-line-builder` v2 迭代 |
| `tax-line-builder` | **02** | 复用 `taxOnTotal` + 比例 `floor` 分摊，结构更整洁 |
| `deferred-revenue` | **01** | 末条 `i === periods - 1`；02 留 **`i === periods` 死分支**（探针仅验条数，仍过） |
| `idempotencyKey` | **01** | `` `tenantId:commandId` `` vs 02 的 `` `tenantId::commandId` ``（均满足探针） |
| 交付说明 | **01** | 有 session 终稿 bullet |

#### 为何 D2 / D3 同分？

- **D2（9 vs 9）**：02 的 `deferred-revenue` 死分支**未导致探针失败**（测试只断言 `schedule.length === periods`），语义瑕疵记在 evidence，**不单独降档**。
- **D3（8 vs 8）**：02 **`tax-line-builder` 更优** 与 02 **`deferred-revenue` 死代码** 相互抵消；01 亦有 `escalation-ladder` 未删 `calendarDaysInclusive`，两家同属「可用但有瑕疵」档。

#### 追平条件

若补充 **02 的 CC 终稿 bullet** 或 **turn / npm test 迭代日志**，D6（及可能的 D5）有机会上调，Composite **可追平 93**。当前 −1 **不代表 CC 代码交付弱一档**，而是 **裁判可审计材料不对称**。

---

*评分依据：[`../md/三平台同模对比评测与裁判评分体系.md`](../md/三平台同模对比评测与裁判评分体系.md) · 任务 yaml：[`../tasks/debug-billing-settlement-03.yaml`](../tasks/debug-billing-settlement-03.yaml) · 任务规格：[`../md/debug-billing-settlement-03-任务规格.md`](../md/debug-billing-settlement-03-任务规格.md) · 平台映射：**01 = iceCoder（MiniMax-M3 · Harness adaptive）** · **02 = CC（Claude Code · MiniMax-M3）***
