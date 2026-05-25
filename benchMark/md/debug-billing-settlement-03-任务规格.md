# debug-billing-settlement-03 — 超高难找 BUG Benchmark 任务规格

> **版本**：1.0  
> **日期**：2026-05-25  
> **层级**：L2 + L4 + L5（**超高难 · 长上下文**）  
> **领域**：多租户 SaaS 计费 · 税 · Proration · 递延收入 · 对账  
> **task yaml**：[`../tasks/debug-billing-settlement-03.yaml`](../tasks/debug-billing-settlement-03.yaml)  
> **沙箱**：[`../repos/debug-billing-settlement-03/`](../repos/debug-billing-settlement-03/)

---

## 0. 难度定位

| 维度 | pipeline-01 | saga-02 | spellbrigade | **本任务** |
|------|-------------|---------|--------------|------------|
| 类型 | 修 bug + 补全 | 分布式模式实现 | 从零做游戏 | **纯找 BUG（19 处）** |
| 源文件数 | ~8 | ~12+ | 中 | **97** |
| 源码体积 | ~15KB | ~40KB | 中 | **~453KB** |
| 上下文压力 | 低 | 中 | 高 | **显著 >200K tokens** |
| 预估轮次 | 18–28 | 50–80 | 120–180 | **80–150** |
| 时间盒 | 45 min | 150 min | 240 min | **180 min** |
| 客观验收 | 9 单测 | 多组单测 | 单测+E2E | **19 单测全绿** |

本任务用于拉开「**超长上下文 + 跨模块隐性逻辑缺陷**」场景下各 Agent 的探索、定位与分批修复能力；**不期望**在 45 分钟标准盒内完成。

---

## 1. 参测提示词（verbatim）

与 yaml `prompt` 字段一致，复制时勿增删平台专属指令。完整版见 [`debug-billing-settlement-03.yaml`](../tasks/debug-billing-settlement-03.yaml)。

---

## 2. 仓库结构

```text
debug-billing-settlement-03/
├── README.md
├── ARCHITECTURE.md          # 含故意偏差描述，以测试为准
├── package.json
├── scripts/
│   ├── generate-all.mjs     # 生成 97 个 src 文件（禁止参测者修改）
│   └── size-report.mjs
├── src/                     # ~453KB，9195 行
│   ├── domain/      (8)
│   ├── config/      (6)
│   ├── currency/    (5)  ← BUG-01
│   ├── tax/         (6)  ← BUG-02, BUG-03
│   ├── pricing/     (6)  ← BUG-04, BUG-05
│   ├── proration/   (5)  ← BUG-06, BUG-07
│   ├── subscription/(7)  ← BUG-08, BUG-09
│   ├── invoice/     (7)  ← BUG-10, BUG-11
│   ├── payment/     (6)  ← BUG-12
│   ├── credit/      (5)  ← BUG-13
│   ├── revenue/     (5)  ← BUG-14, BUG-15
│   ├── reconciliation/(5) ← BUG-16
│   ├── dunning/     (5)  ← BUG-17
│   ├── idempotency/ (3)  ← BUG-18
│   ├── audit/       (4)  # 干扰项
│   ├── pipeline/    (5)  ← BUG-19
│   └── utils/       (6)  # 干扰项
└── test/
    └── billing-settlement.test.ts   # 19 探针（禁止修改）
```

---

## 3. 植入缺陷清单（评测方持有，勿写入参测 prompt）

| ID | 文件 | 缺陷摘要 | 正确语义（测试断言） |
|----|------|----------|----------------------|
| BUG-01 | `currency/currency-converter.ts` | foreign→base 用乘 | 应 `foreign / rate` |
| BUG-02 | `tax/jurisdiction-resolver.ts` | 阈值用 `>` | 应 `>=`（恰好在门槛也征税） |
| BUG-03 | `tax/compound-tax-engine.ts` | local 税基含 state | local 仅对 subtotal |
| BUG-04 | `pricing/volume-tier.ts` | 最高档边界运算符错 | `qty >= top.minQuantity` |
| BUG-05 | `pricing/loyalty-discount.ts` | 折扣叠加 | `Math.max(loyalty, promo)` |
| BUG-06 | `proration/daily-proration.ts` | 固定 30 天 | 账期实际日历天数 |
| BUG-07 | `proration/upgrade-proration.ts` | credit 符号反 | unused credit 为负值 |
| BUG-08 | `subscription/billing-cycle.ts` | 期末 off-by-one | 末日 inclusive |
| BUG-09 | `subscription/trial-manager.ts` | 试用末日 inactive | `<= trialEnd` 仍 active |
| BUG-10 | `invoice/line-item-aggregator.ts` | 升级重复 setup fee | `priorSetupFeeCharged` 时跳过 |
| BUG-11 | `invoice/tax-line-builder.ts` | 逐行舍入 | 整单一次舍入 |
| BUG-12 | `payment/allocation-engine.ts` | 低优先级先分配 | 高 priority 优先 |
| BUG-13 | `credit/credit-applicator.ts` | credit 未封顶 | `amountDue >= 0` |
| BUG-14 | `revenue/deferred-revenue.ts` | schedule N+1 条 | 恰好 N 条 |
| BUG-15 | `revenue/recognition-schedule.ts` | 余数全给末期 | 前若干期 +1 cent |
| BUG-16 | `reconciliation/ledger-matcher.ts` | 忽略 currency | 币种必须一致 |
| BUG-17 | `dunning/escalation-ladder.ts` | 日历日 | 工作日 |
| BUG-18 | `idempotency/idempotency-guard.ts` | 缺 tenant 作用域 | `(tenantId, commandId)` |
| BUG-19 | `pipeline/billing-orchestrator.ts` | 先税后折扣 | 先折扣后税 |

基线：`npm test` → **19 failed / 19 total**。

---

## 4. 验收命令

| 命令 | 期望 |
|------|------|
| `npm ci` | exit 0 |
| `npm test` | 19/19 passed |
| `npm run build` | `tsc --noEmit` 无错误 |
| `node scripts/size-report.mjs` | src ≥ 55 文件，≥ 250KB |

---

## 5. Gate / Judge 观测点

### 5.1 Gate

- **G1**：19 项测试全过 = 25 分；部分过按比例。
- **G2**：仅 `src/**/*.ts` 变更；改 `test/` 每个文件 −2。
- **G3**：`npm run build` exit 0。

### 5.2 Judge 重点

| 维度 | 观测 |
|------|------|
| D1 | 是否 19/19 全修 vs 只修前半模块 |
| D2 | 边界语义（阈值、inclusive 日期、舍入顺序） |
| D4 | 是否最小 diff（勿整文件重写 utils/audit） |
| D5 | git/日志中是否多轮 `npm test` |
| D6 | bullet 说明是否与 diff 一致 |

### 5.3 常见失败模式

- 上下文截断：只读 `currency/` + `tax/`，漏 `idempotency/`、`dunning/`
- 文档陷阱：按 ARCHITECTURE「正确描述」改反
- 测试篡改：Gate G2 重罚
- 硬编码：测试值写死进实现，换参数即挂（Judge D2 降分）

---

## 6. 与评测体系文档的对应

| 文档章节 | 本任务 |
|----------|--------|
| §3.1 L4 `debug-*` | 主层级 |
| §3.1 L5 `multi-file-*` | 97 文件跨模块 |
| §3.1 时间盒 | **180 min / 200 turns**（超出标准 45/30） |
| 附录 B 双模专项 | 可作为 L4 长上下文 stress 子集 |

---

## 7. 冻结检查清单（首轮实测前）

- [x] `tasks/debug-billing-settlement-03.yaml` prompt hash 固定
- [x] `repos/debug-billing-settlement-03/` 基线 19 fail 可复现
- [x] `scripts/generate-all.mjs` 可重建同构 src（SHA 写入 run-manifest 可选）
- [ ] 参测前 `npm ci && npm test` 确认基线仍为 19/19 fail

---

*本文档为任务规格；参测者仅接收 yaml `prompt` + 干净沙箱克隆，不接收 §3 缺陷表。*
