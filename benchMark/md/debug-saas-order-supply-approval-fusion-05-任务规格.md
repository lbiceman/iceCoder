# debug-saas-order-supply-approval-fusion-05 — 超高难 Benchmark 任务规格

> **版本**：1.0  
> **日期**：2026-07-09  
> **层级**：L2 + L4 + L5 + **L8（企业系统极限融合）**  
> **领域**：SaaS 订单 × 供应链 × 审批 × 计费 × 审计融合修复  
> **task yaml**：[`../tasks/debug-saas-order-supply-approval-fusion-05.yaml`](../tasks/debug-saas-order-supply-approval-fusion-05.yaml)  
> **已评测标记**：`01`、`02`
> **标记映射**：`01 = iceCoder`，`02 = CC`  
> **评测方式**：盲评  
> **出题模型**：GPT-5.5  
> **裁判模型**：GPT-5.5
> **归档说明**：`01/02` 与模型名称的映射为盲评完成后补充，仅用于结果归档；裁判评分阶段不可见。  
> **文档边界**：第 0-6 节为赛前任务规格 / 验收设计，第 7-10 节为赛后评测结果 / 报告模板。

---

## 0. 难度定位

| 维度 | billing-03 | fusion-04 | spellbrigade | **本任务** |
|------|------------|-----------|--------------|------------|
| 类型 | 纯找 BUG | 融合修复 | 从零做游戏 | **企业 SaaS 全链路融合修复** |
| 层级 | L4+ | L7 | L6 | **L8** |
| 源文件数 | ~97 | ~142 | 中高 | **160-220** |
| 源码体积 | ~453KB | ~720KB | 中高 | **900-1200KB** |
| 缺陷规模 | 19 处 BUG | 28 BUG + 4 空壳 | 从零实现 | **36 BUG + 8 空壳 + 6 冲突需求** |
| 预估轮次 | 80-150 | 120-220 | 120-180 | **160-320** |
| 时间盒 | 180 min | 360 min | 240 min | **420 min** |
| 客观验收 | 单测 + build | 单测 + 集成 | 单测 + E2E + 素材 | **单测 + 集成 + 合同 + 迁移 + 审计 + build** |

本任务用于拉开「**长上下文、多领域契约、迁移幂等、审计合规**」场景下各 Agent 运行时差距；**不期望**在 45 分钟标准盒内完成。

### 0.1 难度数字口径

上表中的 L8 难度数字来自 task yaml 与 starter 仓库的设计口径，用于说明本任务的目标压力面，而非赛后评分时的主观加权项：

| 数字 | 依据 |
|------|------|
| `160-220` 源文件、`900-1200KB` 源码体积 | yaml `estimated.source_files` / `estimated.source_size_kb` |
| `36` 处逻辑缺陷 | yaml `observability.complexity` 标注，覆盖 tenant / order / approval / inventory / procurement / billing / payment / revenue / outbox / audit / migration |
| `8` 个空壳模块 | yaml `observability.complexity` 标注，需要真实实现而非 fixture 适配 |
| `6` 处冲突需求 | yaml prompt 与 `3.1 必须先阅读` 对应，要求按测试、类型契约和 ADR source-of-truth 消解 |
| `160-320` 预估轮次、`420 min` 时间盒 | yaml `estimated`、`timeout_minutes`、`max_turns` |

因此，本任务的难度主张主要由「领域数量 × 变更边界 × 验收链长度 × 隐藏语义探针」共同支撑；最终优劣仍以 Gate 与 Judge 证据为准。

---

## 1. 参测提示词（verbatim）

与 yaml `prompt` 字段一致，复制时勿增删平台专属指令。完整版见 [`debug-saas-order-supply-approval-fusion-05.yaml`](../tasks/debug-saas-order-supply-approval-fusion-05.yaml)。

---

## 2. 企业 SaaS 业务契约

### 2.1 多租户隔离

- 所有查询、幂等 key、outbox event、audit event、ledger entry 必须带 `tenantId`。
- 任何业务 id 查询都必须同时按 `tenantId` 过滤，禁止只按 `orderId`、`aggregateId` 或 `commandId` 匹配。
- 报表导出只能返回目标租户数据。

数据文件 / 模块：`src/tenant/query-scope.ts`、`src/idempotency/idempotency-guard.ts`、`src/outbox/outbox-store.ts`、`src/reporting/tenant-ledger-report.ts`。

### 2.2 订单状态机

- 拒绝非法状态跳转。
- 已开票订单不能直接取消，必须走 credit/refund。
- 取消订单必须释放未发货库存 reservation。
- 已拒绝审批不得重新变成 approved。

模块：`src/order/state-machine.ts`、`src/order/cancel-order.ts`。

### 2.3 审批流

- 按金额、毛利率、信用额度、新供应商动态路由。
- 审批链去重，但必须保持固定 source-of-truth 顺序。
- ADR 权威顺序：`sales_manager -> finance -> risk -> procurement`。
- 自动审批也必须写 audit event，且 audit event 必须带 `tenantId`。

模块：`src/approval/router.ts`、`src/approval/workflow-engine.ts`。

### 2.4 库存一致性

- 可用量：`available = onHand - reserved - safetyStock`。
- FEFO 批次预占：先过期批次优先 reservation。
- 普通订单和高优先级订单都不得消耗 safety stock。
- 发货只能扣减已有 reservation，且不得超过 reservation 数量。
- Reservation preemption 必须产生补偿事件。

模块：`src/inventory/availability.ts`、`src/inventory/batch-reservation.ts`、`src/inventory/shipment.ts`、`src/inventory/preemption.ts`。

### 2.5 采购补货

- 同 tenant 同 SKU 缺口合并。
- 不同 tenant 的缺口不得合并。
- Blacklisted supplier 不可被选择。
- 供应商选择禁止硬编码公开 fixture。

模块：`src/procurement/replenishment-planner.ts`、`src/procurement/supplier-selector.ts`。

### 2.6 定价、税和结算

- 折扣顺序：contract / volume 后，再取 promo 与 loyalty 的较大值。
- 税基使用折后金额。
- 税阈值 inclusive：达到门槛即征税。
- 多币种换算按 ADR / contract tests 的 source-of-truth 方向处理。
- 发票总额在 invoice 级别最终舍入，不得逐行提前舍入。

模块：`src/pricing/discount-engine.ts`、`src/pricing/volume-tier.ts`、`src/tax/tax-engine.ts`、`src/currency/converter.ts`、`src/billing/invoice-builder.ts`。

### 2.7 付款、贷项和收入确认

- 付款分配按 source-of-truth 优先级执行。
- Credit memo 不得让 amount due 变成负数。
- Refund 必须引用原 payment。
- Deferred revenue schedule 必须恰好 N 期，并正确分摊余数。

模块：`src/payment/allocation-engine.ts`、`src/credit/credit-memo.ts`、`src/refund/refund-processor.ts`、`src/revenue/deferred-schedule.ts`。

### 2.8 幂等与 outbox

- 幂等作用域为 `(tenantId, commandId)`。
- 重复命令不得重复写库存、发票或 outbox。
- Outbox 版本必须按 tenant aggregate scope 递增。
- 已发布事件不得重复发布。

模块：`src/idempotency/idempotency-guard.ts`、`src/outbox/outbox-store.ts`。

### 2.9 审计合规

- 关键动作必须写 audit event。
- Audit event 不允许删除。
- PII 字段必须脱敏。
- Snapshot 必须稳定排序，便于审计快照比较。

模块：`src/audit/audit-log.ts`、`src/audit/redaction.ts`。

### 2.10 v2 -> v3 迁移

- Ledger 必须回填 tenant scope。
- Approval 必须回填 role。
- Reservation 必须升级为 batch-aware reservation。
- 迁移必须幂等。
- 迁移必须写 audit event。

模块：`migrations/003-v3-tenant-ledger.ts`。

---

## 3. 代码与变更规范

### 3.1 必须先阅读

- `README.md`
- `docs/DOMAIN-MODEL.md`
- `docs/ORDER-LIFECYCLE.md`
- `docs/APPROVAL-POLICY.md`
- `docs/INVENTORY-CONSISTENCY.md`
- `docs/BILLING-SETTLEMENT.md`
- `docs/AUDIT-COMPLIANCE.md`
- `docs/MIGRATION-v3.md`

注意：文档中存在 6 处故意冲突描述。以测试、类型契约和 ADR 中标注为 `source of truth` 的规则为准。

### 3.2 允许修改

- `src/**`
- `migrations/**`
- `docs/ADR-IMPLEMENTATION-NOTES.md`

### 3.3 禁止修改

- `test/**`
- `package.json`
- `package-lock.json`
- `vitest.config.ts`
- `scripts/**`
- `fixtures/**`
- `node_modules/**`

禁止通过修改测试、脚本、fixtures、lockfile 或 package scripts 制造通过结果。

---

## 4. 客观验收（Gate 扩展）

在 [`三平台同模对比评测与裁判评分体系.md`](./三平台同模对比评测与裁判评分体系.md) 基础上，本任务 **G1** 拆分：

| 子项 | 分值 | 判定 |
|------|------|------|
| G1a 单元 / 迁移 / 审计测试 | 8 | `npm test` 通过比例 × 8 |
| G1b 集成测试 | 5 | `npm run test:integration` 通过比例 × 5 |
| G1c 合同测试 | 5 | `npm run test:contracts` 通过比例 × 5 |
| G1d 迁移检查 | 3 | `npm run migrate:check` exit 0 |
| G1e 审计快照 | 2 | `npm run audit:snapshot` exit 0 |
| G1f 构建 | 2 | `npm run build` exit 0 |
| **G1 合计** | **25** | 上限 25 |

**G2 修改边界（8 分）**：只允许修改 `src/**`、`migrations/**`、`docs/ADR-IMPLEMENTATION-NOTES.md`；触碰禁止路径按评测体系扣分。

**G4 补充**：公开测试全绿但存在跨租户幂等、outbox 版本、库存发货数量、audit tenant 缺失等隐藏探针失败时，Judge D2/D3 降分。

### 4.1 验收命令

必须全部成功：

```bash
npm ci
npm test
npm run test:integration
npm run test:contracts
npm run migrate:check
npm run audit:snapshot
npm run build
```

### 4.2 必须存在文件

| 文件 | 说明 |
|------|------|
| `src/tenant/query-scope.ts` | tenant-scoped query |
| `src/authz/role-check.ts` | tenant authz |
| `src/contract/credit-limit.ts` | credit exposure |
| `src/order/state-machine.ts` | order lifecycle |
| `src/approval/router.ts` | approval routing |
| `src/approval/workflow-engine.ts` | workflow execution |
| `src/inventory/availability.ts` | available formula |
| `src/inventory/batch-reservation.ts` | FEFO reservation |
| `src/procurement/replenishment-planner.ts` | replenishment merge |
| `src/pricing/discount-engine.ts` | discount order |
| `src/tax/tax-engine.ts` | tax threshold / base |
| `src/billing/invoice-builder.ts` | invoice total |
| `src/payment/allocation-engine.ts` | payment priority |
| `src/credit/credit-memo.ts` | credit cap |
| `src/revenue/deferred-schedule.ts` | deferred revenue |
| `src/outbox/outbox-store.ts` | outbox version / publish |
| `src/idempotency/idempotency-guard.ts` | tenant command idempotency |
| `src/audit/audit-log.ts` | append-only audit |
| `src/audit/redaction.ts` | PII redaction |
| `src/reporting/tenant-ledger-report.ts` | tenant ledger export |
| `migrations/003-v3-tenant-ledger.ts` | v3 migration |
| `docs/ADR-IMPLEMENTATION-NOTES.md` | authoritative ADR notes |

---

## 5. Judge 补充维度（融合修复，仍并入 D1/D3）

裁判盲评时除六维外，参考以下 **checklist**（写入 evidence，不单独加分）：

- [ ] 多租户隔离覆盖 query、idempotency、outbox、audit、ledger。
- [ ] 订单状态机拒绝非法跳转，已开票订单不能直接取消。
- [ ] 审批链按金额、毛利、信用、新供应商动态路由，并保持 ADR 顺序。
- [ ] 库存按 FEFO reservation，发货数量不得超过 reservation。
- [ ] 定价、税、币种、发票舍入符合 source-of-truth。
- [ ] Payment、credit memo、refund、deferred revenue 行为完整。
- [ ] Outbox 和 idempotency 可承受跨租户隐藏用例。
- [ ] Audit event 完整、PII 脱敏、snapshot 稳定。
- [ ] v2 -> v3 迁移可重复运行且结果稳定。
- [ ] 未修改 `test/**`、`scripts/**`、`fixtures/**`、`package.json`、lockfile 或配置文件。

---

## 6. 隐藏探针清单（评测方）

| 用例 | 断言 |
|------|------|
| `tenant-isolation.spec` | 同 `orderId` / `commandId` 跨 tenant 不串数据 |
| `outbox-version.spec` | version 按 `(tenantId, aggregateId)` 递增 |
| `shipment-reservation.spec` | 发货数量不得超过 reservation |
| `approval-audit.spec` | 自动审批 audit event 带 `tenantId` 和稳定 `eventId` |
| `invoice-rounding.spec` | 折后税基 + invoice 级别最终舍入 |
| `migration-repeat.spec` | v3 migration 重复运行不重复写 audit、不重复变换字段 |

隐藏测试会替换 tenant、currency、approval policy、库存批次和 fixture 值，禁止写死公开测试输入。

---

## 7. 01 评测结果

### 7.1 总分

| 项目 | 分数 | 说明 |
|------|------|------|
| Gate | **38 / 40** | 公开验收命令全部通过；但 `01` 目录不是 git repo，禁止路径是否被改过无法完整审计，范围合规保守扣 2 分 |
| Judge | **33 / 60** | 实现满足公开测试，并修掉发货超量问题；但完整 L8 语义覆盖仍不足 |
| Composite | **71 / 100** | Gate + Judge |
| 等级 | **B** | 公开验收通过且较 `02` 有改进，但仍有明显语义瑕疵 |
| 耗时 / 轮次 | `967853ms`（约 `16m 8s`）/ `122` 轮 | 运行耗时与轮次为赛后补充的执行元数据，不参与评分 |

一句话结论：**公开测试通过，且比 `02` 更好；但 outbox tenant scope 和自动审批审计仍会被隐藏探针打穿。**

### 7.2 Gate 明细

| 子项 | 分数 | 证据 |
|------|------|------|
| G1 验收通过 | **25 / 25** | `npm ci`、`npm test`、`npm run test:integration`、`npm run test:contracts`、`npm run migrate:check`、`npm run audit:snapshot`、`npm run build` 全部 exit 0 |
| G2 范围合规 | **6 / 8** | 目标目录不是 git repo，无法完整审计 `test/**`、`scripts/**`、`fixtures/**`、`package.json`、lockfile 是否被改动；未发现直接违规证据 |
| G3 可构建 | **4 / 4** | `npm run build` / `tsc --noEmit` 通过 |
| G4 无致命泄漏 | **3 / 3** | 未发现 `.env`、密钥或超大二进制风险 |

### 7.3 Judge 明细

| 维度 | 分数 | 证据 |
|------|------|------|
| D1 需求完成度 | **4 / 10** | 公开测试覆盖域名义齐全，但实现规模和业务完整性明显低于 L8 规格 |
| D2 正确性 | **4 / 10** | `canShip()` 已校验发货数量；但 `outbox` 未按 tenant 作用域，自动审批 audit 的 `tenantId` 仍为空 |
| D3 代码质量 | **5 / 10** | 集成流程比 `02` 少一些固定值问题，但整体实现仍偏薄，隐藏 tenant / currency / approval policy / batch 变体风险高 |
| D4 最小改动 | **7 / 10** | 未见大范围无关实现，但因无 git diff 只能保守评分 |
| D5 验证意识 | **8 / 10** | 完整验收链已实际跑通；缺少隐藏语义探针和禁改路径审计 |
| D6 实现说明 | **5 / 10** | 公开通过结果可说明，但与完整规格存在差距，缺少原始 run 的可靠总结证据 |

### 7.4 关键扣分证据

| 探针 | 观察到的行为 | 风险 |
|------|--------------|------|
| `outboxCrossTenant` | `nextVersion()` 仅按 `aggregateId` 计算版本，未按 `(tenantId, aggregateId)` 作用域 | 跨租户同 aggregate 会互相影响 |
| `canShipTooMuch` | reservation 数量为 1 时，申请发货 2 返回 `false` | 此项通过，优于 `02` |
| `autoApproveAudit` | 自动审批 audit event 的 `eventId` 稳定，但 `tenantId` 为空 | 审计事件不满足 tenant scope 要求 |

---

## 8. 02 评测结果

### 8.1 总分

| 项目 | 分数 | 说明 |
|------|------|------|
| Gate | **38 / 40** | 公开验收命令全部通过；但 `02` 目录不是 git repo，禁止路径是否被改过无法完整审计，范围合规保守扣 2 分 |
| Judge | **31 / 60** | 实现满足公开测试，但完整 L8 语义覆盖不足，存在隐藏测试风险 |
| Composite | **69 / 100** | Gate + Judge |
| 等级 | **C** | 公开验收通过，但按完整规格看属于勉强通过 / 明显瑕疵 |
| 耗时 / 轮次 | `4m 58s` / 未记录 | 运行耗时为赛后补充的执行元数据，不参与评分 |

一句话结论：**公开测试通过，但按完整 L8 规格看不达标，隐藏测试风险明显。**

### 8.2 Gate 明细

| 子项 | 分数 | 证据 |
|------|------|------|
| G1 验收通过 | **25 / 25** | `npm ci`、`npm test`、`npm run test:integration`、`npm run test:contracts`、`npm run migrate:check`、`npm run audit:snapshot`、`npm run build` 全部 exit 0 |
| G2 范围合规 | **6 / 8** | 目标目录不是 git repo，无法完整审计 `test/**`、`scripts/**`、`fixtures/**`、`package.json`、lockfile 是否被改动；未发现直接违规证据 |
| G3 可构建 | **4 / 4** | `npm run build` / `tsc --noEmit` 通过 |
| G4 无致命泄漏 | **3 / 3** | 未发现 `.env`、密钥或超大二进制风险 |

### 8.3 Judge 明细

| 维度 | 分数 | 证据 |
|------|------|------|
| D1 需求完成度 | **4 / 10** | 公开测试覆盖域名义齐全，但实现规模和业务完整性明显低于 L8 规格 |
| D2 正确性 | **3 / 10** | `outbox` 未按 tenant 作用域、发货数量校验错误、自动审批 audit 的 `tenantId` / `eventId` 为空 |
| D3 代码质量 | **4 / 10** | 实现偏薄，多个流程存在硬编码，隐藏 tenant / currency / approval policy / batch 变体风险高 |
| D4 最小改动 | **7 / 10** | 未见大范围无关实现，但因无 git diff 只能保守评分 |
| D5 验证意识 | **8 / 10** | 完整验收链已实际跑通；缺少隐藏语义探针和禁改路径审计 |
| D6 实现说明 | **5 / 10** | 公开通过结果可说明，但与完整规格存在差距，缺少原始 run 的可靠总结证据 |

### 8.4 关键扣分证据

| 探针 | 观察到的行为 | 风险 |
|------|--------------|------|
| `outboxCrossTenant` | `nextVersion()` 仅按 `aggregateId` 计算版本，未按 `(tenantId, aggregateId)` 作用域 | 跨租户同 aggregate 会互相影响 |
| `canShipTooMuch` | reservation 数量为 1 时，申请发货 2 仍返回 `true` | 发货可能超过 reservation |
| `autoApproveAudit` | 自动审批 audit event 的 `tenantId` 和 `eventId` 为空 | 审计事件不满足 tenant scope 和稳定追踪要求 |

---

## 9. 01 / 02 对比表格

| 维度 | `01` | `02` | 对比结论 |
|------|------|------|----------|
| Gate | **38 / 40** | **38 / 40** | 两者公开验收命令均全绿；都因目标目录不是 git repo，禁止路径无法完整审计而保守扣 2 分 |
| Judge | **33 / 60** | **31 / 60** | `01` 略高，主要因为修掉了发货超量问题 |
| Composite | **71 / 100** | **69 / 100** | `01` 高 2 分 |
| 等级 | **B** | **C** | `01` 属于可用但有明显瑕疵；`02` 属于勉强通过 / 明显瑕疵 |
| 耗时 / 轮次 | `967853ms`（约 `16m 8s`）/ `122` 轮 | `4m 58s` / 未记录 | `02` 更快；`01` 分数略高但耗时更长 |
| 公开验收 | 7 / 7 通过 | 7 / 7 通过 | 持平 |
| 源码规模 | 约 34 个 `src/**/*.ts` | 约 34 个 `src/**/*.ts` | 均明显低于 L8 目标 `160-220` 源文件 |
| `outboxCrossTenant` | 失败：仅按 `aggregateId` 计算版本 | 失败：仅按 `aggregateId` 计算版本 | 持平，均有跨租户 outbox 风险 |
| `canShipTooMuch` | 通过：超量发货返回 `false` | 失败：超量发货返回 `true` | `01` 明显优于 `02` |
| `autoApproveAudit` | 部分失败：`eventId` 稳定，但 `tenantId` 为空 | 失败：`tenantId` 和 `eventId` 均为空 | `01` 略优，但仍不满足 tenant scope |
| 实现完整性 | 公开测试主路径可用，隐藏语义仍有风险 | 更偏公开测试适配，隐藏语义风险更高 | `01` 优于 `02`，但都未达到完整 L8 规格 |
| 推荐排序 | **第 1** | **第 2** | 当前两份产物中 `01` 更好 |

综合结论：**`01` 比 `02` 略好，主要改进点是发货数量校验；但两者都存在 outbox tenant scope 和审批审计 tenant 缺失问题，均不能视为完整符合 L8 规格。**

---

## 10. 报告模板

评测完成后落盘：`benchMark/reports/debug-saas-order-supply-approval-fusion-05-02.md`

需额外记录：

- 参测标记：`01` / `02`
- 运行耗时 / 轮次
- 修复域覆盖：tenant / order / approval / inventory / procurement / billing / payment / revenue / outbox / audit / migration
- 空壳模块实现数
- 验收命令通过数 / 总数
- 是否存在禁止路径改动
- 是否运行隐藏语义探针
- 关键风险：公开测试通过但隐藏探针可能失败的领域

---

## 11. 与评测体系文档的关系

建议在 [`三平台同模对比评测与裁判评分体系.md`](./三平台同模对比评测与裁判评分体系.md) §3.1 增加一行：

| L8 | `debug-saas-order-supply-approval-fusion-*` | 1+ | 企业 SaaS 订单、供应链、审批、计费、审计、迁移与 outbox 融合修复 | 高 |

本任务为 **L8 首发**。

---

*Starter 仓库：`benchMark/repos/debug-saas-order-supply-approval-fusion-05`。参测前 `npm ci` 后单测应大量失败，直至 Agent 修复完整企业 SaaS 链路并通过所有验收命令。*
