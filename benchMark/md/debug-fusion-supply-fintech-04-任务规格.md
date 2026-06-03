# debug-fusion-supply-fintech-04 — 极难融合 Benchmark 任务规格



> **版本**：1.0  

> **日期**：2026-06-03  

> **层级**：L2 + L4 + L5 + **L7（极难 · 融合 stress）**  

> **领域**：供应链 Saga · 多实体总账 · 转移定价 · FX 对冲 · 集成链  

> **task yaml**：[`../tasks/debug-fusion-supply-fintech-04.yaml`](../tasks/debug-fusion-supply-fintech-04.yaml)  

> **沙箱**：[`../repos/debug-fusion-supply-fintech-04/`](../repos/debug-fusion-supply-fintech-04/)



---



## 0. 难度定位（相对现有全集）



| 维度 | pipeline-01 | saga-02 | billing-03 | spellbrigade | **本任务 (04)** |

|------|-------------|---------|------------|--------------|-----------------|

| 类型 | 修 bug | 修+实现 2 空壳 | 纯 19 BUG | 从零游戏 | **28 BUG + 4 空壳 + 5 集成** |

| 源文件数 | ~8 | ~12+ | **97** | 中（渐进） | **160** |

| 源码体积 | ~15KB | ~40KB | **~453KB** | 中 | **~1.3MB** |

| 探针数 | 9 | ~15 | **19** | 单测+E2E | **33（28+5）** |

| 误导文档 | README | ARCHITECTURE | ARCHITECTURE | 设计 doc | **4 份矛盾文档** |

| 预估轮次 | 18–28 | 50–80 | 80–150 | 120–180 | **180–280** |

| 时间盒 | 45 min | 150 min | 180 min | 240 min | **360 min** |

| 顺序陷阱 | 低 | 中 | 中（编排） | Phase 纪律 | **高（单元绿≠集成绿）** |



**设计意图**：在 billing-03「长上下文多 BUG」之上，叠加 saga-02 的**空壳实现**与 spellbrigade 的**长时纪律**，并用 **5 条集成探针**惩罚「只修单文件、不理解跨域编排」的 Agent。不期望在 45/180 分钟标准盒内完成。



---



## 1. 参测提示词（verbatim）



与 yaml `prompt` 字段一致。完整版见 [`debug-fusion-supply-fintech-04.yaml`](../tasks/debug-fusion-supply-fintech-04.yaml)。



---



## 2. 仓库结构



```text

debug-fusion-supply-fintech-04/

├── README.md

├── ARCHITECTURE.md          # 故意偏差

├── RUNBOOK.md               # 与 ARCHITECTURE 矛盾

├── POSTMORTEM-DRAFT.md      # 第三套「正确」叙述（仍可能错）

├── package.json

├── vitest.config.ts

├── tsconfig.json

├── scripts/

│   ├── generate-all.mjs     # 生成 160 个 src（禁止参测者修改）

│   └── size-report.mjs

├── src/                     # ~1.3MB，160 文件（generate-all 生成）

│   ├── domain/         (10)  # 噪音

│   ├── config/         (8)

│   ├── reference/      (12) # 干扰：看似正确范例

│   ├── warehouse/      (22) ← BUG 1–5, 空壳 sync

│   ├── ledger/         (14) ← BUG 8, 20–21

│   ├── transfer-pricing/(6) ← BUG 9

│   ├── fx/             (8)  ← BUG 6–7

│   ├── hedge/          (6)  ← BUG 14, 空壳 bridge

│   ├── tax/            (8)  ← BUG 10–11, 28

│   ├── fiscal/         (5)  ← BUG 12–13, 空壳 calendar

│   ├── settlement/     (6)  ← BUG 15–16

│   ├── pricing/        (6)  ← BUG 24–25

│   ├── proration/      (4)  ← BUG 26

│   ├── credit/         (4)  ← BUG 27

│   ├── revenue/        (6)  ← BUG 20–21

│   ├── reconciliation/ (5)  ← BUG 18–19, 空壳 engine

│   ├── pipeline/       (5)  ← BUG 16–17

│   ├── scheduler/      (6)  ← BUG 4, 23, timeout

│   ├── audit/          (6)  # 干扰项

│   └── utils/          (8)

└── test/

    ├── fusion-supply-fintech.test.ts      # 28 单元（禁止修改）

    └── integration/fusion-e2e.test.ts     # 5 集成（禁止修改）

```



生成：`cd benchMark/repos/debug-fusion-supply-fintech-04 && node scripts/generate-all.mjs`



---



## 3. 植入缺陷清单（评测方持有，勿写入参测 prompt）



### 3.1 单元探针（28）



| ID | 文件 | 缺陷摘要 | 正确语义 |

|----|------|----------|----------|

| BUG-01 | `warehouse/store/event-store.ts` | OCC 版本校验错 | 乐观并发：重复 version 拒绝 |

| BUG-02 | `warehouse/idempotency/idempotency-guard.ts` | 仅 tenant 作用域 | `(tenantId, entityId, commandId)` |

| BUG-03 | `warehouse/projections/inventory-projection.ts` | 重放双计数 | 重放与增量一致 |

| BUG-04 | `warehouse/saga/transfer-saga.ts` | 步成功未刷新 updatedAt | 每步成功刷新 |

| BUG-05 | `warehouse/saga/compensation.ts` | 补偿未更新投影 | reserved/onHand 同步 |

| BUG-06 | `fx/forward-converter.ts` | 乘除反 | foreign / forwardRate |

| BUG-07 | `fx/revaluation-engine.ts` | 用 spot 非 locked | 资产负债表日 locked rate |

| BUG-08 | `ledger/intercompany/intercompany-poster.ts` | 借贷颠倒 | 借/贷与测试科目一致 |

| BUG-09 | `transfer-pricing/markup-engine.ts` | markup 两次 | 仅一次 arm's length |

| BUG-10 | `tax/nexus-resolver.ts` | 阈值 `>` | `>=` |

| BUG-11 | `tax/withholding-calculator.ts` | 对 gross | 对 net |

| BUG-12 | `fiscal/fiscal-period.ts` | 期末 off-by-one | inclusive end |

| BUG-13 | `settlement/eod-cutoff.ts` | UTC cutoff | warehouse TZ + DST |

| BUG-14 | `hedge/effectiveness-calculator.ts` | 全额有效 | ratio × notional |

| BUG-15 | `settlement/allocation-engine.ts` | 低优先级先分 | 高 priority entity 先 |

| BUG-16 | `pipeline/fusion-orchestrator.ts` | 先税后折扣 | 先折扣后税 |

| BUG-17 | `pipeline/fusion-orchestrator.ts` | 过账顺序错 | ledger slot 在 CreditDest 前 |

| BUG-18 | `reconciliation/entity-matcher.ts` | 忽略 entityId | 必须同 entity |

| BUG-19 | `reconciliation/currency-matcher.ts` | 忽略 currency | 币种一致 |

| BUG-20 | `revenue/deferred-revenue.ts` | N+1 条 schedule | 恰好 N 条 |

| BUG-21 | `revenue/recognition-schedule.ts` | 余数末期 | 前若干期 +1 cent |

| BUG-22 | `warehouse/idempotency/idempotency-guard.ts` | entity 级污染 | 见 BUG-02（同文件第二探针） |

| BUG-23 | `scheduler/escalation-ladder.ts` | 日历日 | `FiscalCalendarService` 工作日 |

| BUG-24 | `pricing/volume-tier.ts` | 边界档未命中 | `qty >= top.minQuantity` |

| BUG-25 | `pricing/internal-discount.ts` | 折扣叠加 | `Math.max(loyalty, promo)` |

| BUG-26 | `proration/daily-proration.ts` | 固定 30 天 | 账期实际天数 |

| BUG-27 | `credit/credit-applicator.ts` | amountDue 可负 | `>= 0` |

| BUG-28 | `tax/compound-tax-engine.ts` | local 含 state | local 仅 subtotal |



### 3.2 空壳模块（必须实现）



| 模块 | 文件 | 契约要点 |

|------|------|----------|

| STUB-1 | `reconciliation/cross-entity-reconciliation-engine.ts` | 释放孤儿预留；修正跨实体 reserved 漂移 |

| STUB-2 | `fiscal/fiscal-calendar-service.ts` | `addBusinessDays`；排除周末；供 escalation 使用 |

| STUB-3 | `hedge/hedge-settlement-bridge.ts` | 套保结算 → 生成配对 ledger 行 |

| STUB-4 | `warehouse/saga-ledger-projection-sync.ts` | Saga 完成/补偿 → 同步 ledger 与 inventory 投影 |



### 3.3 集成探针（5）



| ID | 场景 | 依赖 |

|----|------|------|

| I1 | 5 步 Saga 端到端 + 双实体借贷平衡 | BUG 1–5, 17, STUB-4 |

| I2 | EOD 结算 + TP markup + 税行 | BUG 9–11, 15–16, 12–13, STUB-2 |

| I3 | 重估 + hedge roll 闭合 | BUG 6–7, 14, STUB-3 |

| I4 | 孤儿预留对账 | STUB-1, BUG 18–19 |

| I5 | 超时 + 补偿 + 投影回滚 | `saga-timeout-monitor`, BUG 4–5, STUB-4 |



基线：`npm test` → **28 failed**；`npm run test:integration` → **5 failed**（或合并报告 33 failed）。



---



## 4. 验收命令



| 命令 | 期望 |

|------|------|

| `npm ci` | exit 0 |

| `npm test` | 28/28 passed |

| `npm run test:integration` | 5/5 passed |

| `npm run build` | `tsc --noEmit` 无错误 |

| `node scripts/size-report.mjs` | src ≥ 130 文件，≥ 500KB（当前约 160 文件 / 1.3MB） |



---



## 5. Gate / Judge 观测点



### 5.1 Gate



- **G1**：33 项全过 = 25 分；仅单元 28 过、集成 0 = 最高约 18/25（按比例）。

- **G2**：仅 `src/**/*.ts`；改 `test/` 每个文件 −2。

- **G3**：`npm run build` exit 0。



### 5.2 Judge 重点



| 维度 | 观测 |

|------|------|

| D1 | 33/33 vs 28/33 vs 部分单元 |

| D2 | DST、实体作用域、编排顺序、舍入 |

| D4 | 4 空壳是否最小可用实现 |

| D5 | 是否先 test 后 test:integration |

| D6 | 12 bullet 是否覆盖空壳 + 集成 |



### 5.3 常见失败模式



- 文档陷阱：跟 RUNBOOK 改反

- 单元绿集成红：未实现 STUB-1/4 或 orchestrator 顺序

- 只修 tax/pricing 抄 billing 经验，忽略 warehouse

- 上下文截断：未读 `integration/` 失败信息

- 改测试凑过



---



## 6. 与评测体系文档的对应



| 文档章节 | 本任务 |

|----------|--------|

| §3.1 L4+ billing | 本任务为 **L7 上位**（体量 + 集成 + 空壳） |

| §3.1 时间盒 | **360 min / 300 turns** |

| 附录 B 双模 | 长上下文 + 编排顺序 stress |



---



## 7. 冻结检查清单



- [x] `tasks/debug-fusion-supply-fintech-04.yaml` 已创建

- [x] `repos/.../scripts/generate-all.mjs` 可生成同构 src

- [ ] 参测前 `npm ci && npm test && npm run test:integration` 确认基线 33/33 fail

- [ ] prompt hash 写入 run-manifest



---



*参测者仅接收 yaml `prompt` + 干净沙箱克隆，不接收 §3 缺陷表。*

