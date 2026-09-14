# debug-saas-order-supply-approval-fusion-05 评测报告

> **task_id**：`debug-saas-order-supply-approval-fusion-05`  
> **prompt 版本**：v0.1（2026-07-09）  
> **评测日期**：2026-07-09（01/02 公开验收复跑 + 隐藏语义探针 + 盲评归档）· **2026-09-14**（**05** 增补）  
> **出题 / 裁判**：GPT-5.5（盲评；平台映射为赛后归档）  
> **rubric**：`JUDGE_RUBRIC_v0.1`（Gate 0–40 + Judge 0–60）  
> **任务规格**：[`../md/debug-saas-order-supply-approval-fusion-05-任务规格.md`](../md/debug-saas-order-supply-approval-fusion-05-任务规格.md)

## 项目介绍

**L8 企业系统极限融合** TypeScript 沙箱：多租户订单 × 供应链库存 × 审批流 × 计费结算 × 审计合规 × Outbox / 迁移。

| 维度 | 数值 |
|------|------|
| 设计口径源文件 | **160–220** · **900–1200KB** |
| 缺陷规模 | **36** 逻辑 BUG + **8** 空壳 + **6** 冲突需求 |
| 公开验收链 | `npm ci` / `test` / `test:integration` / `test:contracts` / `migrate:check` / `audit:snapshot` / `build` |
| 任务 yaml 时间盒 | **420 min / 320 turns** |
| 隐藏探针 | outbox tenant scope、发货超量、自动审批 audit tenant 等 |

相对 `debug-fusion-supply-fintech-04`：验收链更长（合同 + 迁移 + 审计快照），并强调 **公开测试全绿 ≠ 隐藏语义全绿**。

---

## 提示词（verbatim · v0.1）

复制参测时使用 [`../tasks/debug-saas-order-supply-approval-fusion-05.yaml`](../tasks/debug-saas-order-supply-approval-fusion-05.yaml) 中 `prompt` 字段。

**任务特点**：需先读多份领域文档（含故意冲突），以测试 / 类型契约 / ADR source-of-truth 消解；禁止改 `test/**`、`scripts/**`、`fixtures/**`、`package.json`、lockfile。

---

## 平台

| 代号 | 平台 | 工作目录 | 状态 |
|------|------|----------|------|
| **01** | **iceCoder** | `E:\test\agentToolTest\debug-saas-order-supply-approval-fusion-01` | ✅ 已评 |
| **02** | **CC**（Claude Code） | `E:\test\agentToolTest\debug-saas-order-supply-approval-fusion-02` | ✅ 已评 |
| **05** | **iceCoder**（Harness · adaptive） | `E:\test\agentToolTest\debug-saas-order-supply-approval-fusion-05` | ✅ 已评 |

> 目录后缀为批次代号；**01 / 02** 平台身份已解盲（赛后归档）：**01 = iceCoder**，**02 = CC**。**05** 为同任务新批次，目录名与 task_id 后缀一致。

**参测约定**

- **01 / 02**：盲评后归档映射；模型未在报告中统一标注（非 05 批次）
- **05**：模型 **`deepseek-4.1-flash`** · iceCoder **Harness** · `adaptive`
- 工作区均 **非 git 仓库**；G2 范围合规无法完整审计，保守扣 2 分
- 产物 `src/**/*.ts` 规模：**01/02 约 34** · **05 约 30**，均明显低于 L8 设计口径 `160–220`

---

## Run: 01 / iceCoder / debug-saas-order-supply-approval-fusion-05

### 实现摘要（≤150 字）

公开验收链 **7/7 全绿**。相对 `02` 修掉了发货超量：`canShip()` 在 reservation=1 时申请发货 2 返回 `false`。自动审批 audit 的 `eventId` 稳定，但 `tenantId` 仍为空；`outbox.nextVersion()` 仍仅按 `aggregateId` 计版本，未按 `(tenantId, aggregateId)` 作用域。实现偏薄，未达完整 L8 语义覆盖。

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm ci` | **PASS** | exit 0 |
| `npm test` | **PASS** | 公开单测 / 迁移 / 审计相关通过 |
| `npm run test:integration` | **PASS** | exit 0 |
| `npm run test:contracts` | **PASS** | exit 0 |
| `npm run migrate:check` | **PASS** | exit 0 |
| `npm run audit:snapshot` | **PASS** | exit 0 |
| `npm run build` | **PASS** | exit 0 / `tsc --noEmit` 通过 |

### 执行统计

| 字段 | 值 |
|------|-----|
| codename | **01** |
| platform | iceCoder |
| duration | **967853ms**（约 **16m 8s**） |
| turns | **122** |
| 备注 | 耗时 / 轮次为赛后执行元数据，不参与评分 |

### Gate 客观门禁（0–40）

| 子项 | 分数 | 证据 |
|------|------|------|
| G1 验收通过 | **25 / 25** | 公开验收命令全部 exit 0 |
| G2 范围合规 | **6 / 8** | 非 git repo，禁改路径无法完整审计；未见直接违规证据 |
| G3 可构建 | **4 / 4** | `npm run build` 通过 |
| G4 无致命泄漏 | **3 / 3** | 未发现 `.env`、密钥或超大二进制风险 |

**Gate 合计：38/40**

### Judge 六维（0–60）

| 维度 | 分数 | 证据 |
|------|------|------|
| D1 需求完成度 | **4 / 10** | 公开测试覆盖域名义齐全，实现规模与业务完整性明显低于 L8 规格 |
| D2 正确性 | **4 / 10** | `canShip()` 已校验发货数量；outbox 未按 tenant 作用域；自动审批 audit `tenantId` 为空 |
| D3 代码质量 | **5 / 10** | 集成流程比 `02` 少一些固定值问题，隐藏 tenant / currency / policy / batch 变体风险仍高 |
| D4 最小改动 | **7 / 10** | 未见大范围无关实现；无 git diff，保守评分 |
| D5 验证意识 | **8 / 10** | 完整公开验收链已跑通；缺少隐藏语义探针与禁改路径审计 |
| D6 实现说明 | **5 / 10** | 公开通过结果可说明，与完整规格差距大，缺少原始 run 可靠总结证据 |

**Judge 合计：33/60**

```json
{
  "run_id": "anon-saas-fusion-01",
  "dimensions": {
    "D1": { "score": 4, "evidence": "Public acceptance green; ~34 src files vs L8 160-220 target" },
    "D2": { "score": 4, "evidence": "canShip quantity check fixed; outbox not tenant-scoped; auto-approve audit tenantId empty" },
    "D3": { "score": 5, "evidence": "Thinner than L8; fewer hardcodes than 02; hidden variant risk remains" },
    "D4": { "score": 7, "evidence": "No large unrelated surface; no git audit" },
    "D5": { "score": 8, "evidence": "Full public acceptance chain green; no hidden probes in-run" },
    "D6": { "score": 5, "evidence": "Public pass explainable; gap vs full L8 spec" }
  },
  "judge_total": 33,
  "one_line_verdict": "公开测试通过且优于 02；outbox tenant scope 与自动审批审计仍会被隐藏探针打穿。",
  "implementation_summary": "公开验收全绿；修掉发货超量；outbox/audit tenant 语义仍不足。"
}
```

### 综合分与等级

| 指标 | 值 |
|------|-----|
| Gate | **38/40** |
| Judge | **33/60** |
| **Composite** | **71** |
| **等级** | **B**（验收通过 + 可用但有明显瑕疵） |

### 关键扣分证据

| 探针 | 观察到的行为 | 风险 |
|------|--------------|------|
| `outboxCrossTenant` | `nextVersion()` 仅按 `aggregateId` 计算版本 | 跨租户同 aggregate 互相影响 |
| `canShipTooMuch` | reservation=1 发货 2 → `false` | **通过**，优于 `02` |
| `autoApproveAudit` | `eventId` 稳定，`tenantId` 为空 | 审计不满足 tenant scope |

---

## Run: 02 / CC / debug-saas-order-supply-approval-fusion-05

### 实现摘要（≤150 字）

公开验收链 **7/7 全绿**，但隐藏语义风险更高：`canShip()` 在 reservation=1 时申请发货 2 仍返回 `true`；自动审批 audit 的 `tenantId` 与 `eventId` 均为空；`outbox` 同样未按 tenant 作用域计版本。实现更偏公开测试适配，硬编码与隐藏变体风险高于 `01`。

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm ci` | **PASS** | exit 0 |
| `npm test` | **PASS** | 公开单测通过（复跑约 30 passed） |
| `npm run test:integration` | **PASS** | exit 0 |
| `npm run test:contracts` | **PASS** | exit 0 |
| `npm run migrate:check` | **PASS** | exit 0 |
| `npm run audit:snapshot` | **PASS** | exit 0 |
| `npm run build` | **PASS** | exit 0 |

### 执行统计

| 字段 | 值 |
|------|-----|
| codename | **02** |
| platform | CC（Claude Code） |
| duration | **4m 58s** |
| turns | **未记录** |
| 备注 | 耗时为赛后执行元数据，不参与评分 |

### Gate 客观门禁（0–40）

| 子项 | 分数 | 证据 |
|------|------|------|
| G1 验收通过 | **25 / 25** | 公开验收命令全部 exit 0 |
| G2 范围合规 | **6 / 8** | 非 git repo，禁改路径无法完整审计；未见直接违规证据 |
| G3 可构建 | **4 / 4** | `npm run build` 通过 |
| G4 无致命泄漏 | **3 / 3** | 未发现 `.env`、密钥或超大二进制风险 |

**Gate 合计：38/40**

### Judge 六维（0–60）

| 维度 | 分数 | 证据 |
|------|------|------|
| D1 需求完成度 | **4 / 10** | 公开测试覆盖域名义齐全，实现规模与业务完整性明显低于 L8 规格 |
| D2 正确性 | **3 / 10** | outbox 未按 tenant 作用域；发货数量校验错误；自动审批 audit `tenantId` / `eventId` 为空 |
| D3 代码质量 | **4 / 10** | 实现偏薄，多处硬编码；隐藏 tenant / currency / policy / batch 变体风险高 |
| D4 最小改动 | **7 / 10** | 未见大范围无关实现；无 git diff，保守评分 |
| D5 验证意识 | **8 / 10** | 完整公开验收链已跑通；缺少隐藏语义探针与禁改路径审计 |
| D6 实现说明 | **5 / 10** | 公开通过结果可说明，与完整规格差距大，缺少原始 run 可靠总结证据 |

**Judge 合计：31/60**

```json
{
  "run_id": "anon-saas-fusion-02",
  "dimensions": {
    "D1": { "score": 4, "evidence": "Public acceptance green; ~34 src files vs L8 160-220 target" },
    "D2": { "score": 3, "evidence": "outbox not tenant-scoped; canShip allows overship; auto-approve audit tenantId/eventId empty" },
    "D3": { "score": 4, "evidence": "Thin implementation; hardcodes; high hidden-variant risk" },
    "D4": { "score": 7, "evidence": "No large unrelated surface; no git audit" },
    "D5": { "score": 8, "evidence": "Full public acceptance chain green; no hidden probes in-run" },
    "D6": { "score": 5, "evidence": "Public pass explainable; gap vs full L8 spec" }
  },
  "judge_total": 31,
  "one_line_verdict": "公开测试通过，但按完整 L8 规格看不达标，隐藏测试风险明显。",
  "implementation_summary": "公开验收全绿；发货超量、outbox/audit tenant 语义均不足。"
}
```

### 综合分与等级

| 指标 | 值 |
|------|-----|
| Gate | **38/40** |
| Judge | **31/60** |
| **Composite** | **69** |
| **等级** | **C**（勉强通过 / 明显瑕疵） |

### 关键扣分证据

| 探针 | 观察到的行为 | 风险 |
|------|--------------|------|
| `outboxCrossTenant` | `nextVersion()` 仅按 `aggregateId` 计算版本 | 跨租户同 aggregate 互相影响 |
| `canShipTooMuch` | reservation=1 发货 2 → `true` | 发货可能超过 reservation |
| `autoApproveAudit` | `tenantId` 与 `eventId` 均为空 | 审计不满足 tenant scope 与稳定追踪 |

---

## Run: 05 / iceCoder / debug-saas-order-supply-approval-fusion-05

### 实现摘要（≤150 字）

公开验收链 **7/7 全绿**（2026-09-14 本机复跑：单测 30/30、集成 2/2、合同 3/3）。`canShip()` 校验超量发货；`executeApprovalWorkflow` 自动审批可写带 `tenantId` 的稳定 `eventId`；`nextVersion(events, aggregateId, tenantId?)` 在传入 tenant 时可隔离，**省略 tenant 时仍与公开 contract 测例一致、按 aggregate 合并版本**。`src` 约 **30** 文件，仍远低于 L8 完整规格。

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm ci` | **PASS** | exit 0 |
| `npm test` | **PASS** | 30/30 |
| `npm run test:integration` | **PASS** | 2/2 |
| `npm run test:contracts` | **PASS** | 3/3 |
| `npm run migrate:check` | **PASS** | exit 0 |
| `npm run audit:snapshot` | **PASS** | exit 0 |
| `npm run build` | **PASS** | `tsc --noEmit` |

### 执行统计

| 字段 | 值 |
|------|-----|
| codename | **05** |
| platform | iceCoder（Harness · adaptive） |
| model | **deepseek-4.1-flash** |
| duration | **743000ms**（**12m 23s**） |
| turns | **83** |
| 备注 | 耗时 / 轮次为赛后执行元数据，不参与评分 |

### Gate 客观门禁（0–40）

| 子项 | 分数 | 证据 |
|------|------|------|
| G1 验收通过 | **25 / 25** | 公开验收命令全部 exit 0 |
| G2 范围合规 | **6 / 8** | 非 git repo，禁改路径无法完整审计；未见直接违规证据 |
| G3 可构建 | **4 / 4** | `npm run build` 通过 |
| G4 无致命泄漏 | **3 / 3** | 未发现 `.env`、密钥或超大二进制风险 |

**Gate 合计：38/40**

### Judge 六维（0–60）

| 维度 | 分数 | 证据 |
|------|------|------|
| D1 需求完成度 | **4 / 10** | 公开测试覆盖域名义齐全；约 30 个 `src` 文件 vs L8 160–220 |
| D2 正确性 | **5 / 10** | 发货数量校验正确；自动审批 audit 可带 tenant；outbox 默认路径仍跨租户合并版本 |
| D3 代码质量 | **6 / 10** | 模块分层清晰、审批链 ADR 顺序合理；整体仍偏薄实现 |
| D4 最小改动 | **7 / 10** | 未见大范围无关实现；无 git diff，保守评分 |
| D5 验证意识 | **9 / 10** | 完整公开验收链复跑；隐藏语义探针（outbox / canShip / auto-approve）已核对 |
| D6 实现说明 | **5 / 10** | 产物内无参测终稿 bullet；行为与公开通过结果可对照 |

**Judge 合计：36/60**

```json
{
  "run_id": "saas-fusion-05-deepseek-flash",
  "model": "deepseek-4.1-flash",
  "dimensions": {
    "D1": { "score": 4, "evidence": "Public acceptance green; ~30 src files vs L8 160-220 target" },
    "D2": { "score": 5, "evidence": "canShip OK; auto-approve audit with tenant OK; nextVersion cross-tenant when tenantId omitted" },
    "D3": { "score": 6, "evidence": "Clear module boundaries; ADR approval order; thin but coherent" },
    "D4": { "score": 7, "evidence": "No large unrelated surface; no git audit" },
    "D5": { "score": 9, "evidence": "7/7 acceptance re-run; hidden semantic probes checked" },
    "D6": { "score": 5, "evidence": "No delivery bullets in repo; gap vs full L8 spec" }
  },
  "judge_total": 36,
  "one_line_verdict": "公开验收全绿且隐藏探针优于 01；outbox 默认路径与 L8 体量仍不达标。",
  "implementation_summary": "Harness 83 轮 / 12m23s；全链绿；canShip 与 audit 改进；outbox 可选 tenant 但默认仍合并。"
}
```

### 综合分与等级

| 指标 | 值 |
|------|-----|
| Gate | **38/40** |
| Judge | **36/60** |
| **Composite** | **74** |
| **等级** | **B**（验收通过 + 可用；L8 完整语义未达成） |

### 关键扣分证据

| 探针 | 观察到的行为 | 风险 |
|------|--------------|------|
| `outboxCrossTenant` | 不传 `tenantId` 时 `nextVersion()` 对同 `aggregateId` 取全局 max | 与 contract 测例一致，但跨租户串版本 |
| `canShipTooMuch` | reservation=1 发货 2 → `false` | **通过** |
| `autoApproveAudit` | 显式 tenant → `tenantId` + 稳定 `eventId`；无 tenant 时 fallback `"unknown"` | **优于 01**；无 tenant 路径语义仍弱 |

---

## 跨平台对比

| 代号 | 平台 | 模型 | SR | Composite | 等级 | Gate | Judge | Turns | Duration | 备注 |
|------|------|------|-----|-----------|------|------|-------|-------|----------|------|
| **05** | **iceCoder** | **deepseek-4.1-flash** | **1** | **74** | **B** | **38** | **36** | **83** | **12m 23s** | Harness；隐藏探针优于 01 |
| **01** | **iceCoder** | — | **1** | **71** | **B** | **38** | **33** | **122** | **≈16m 8s** | 修掉发货超量；audit `tenantId` 空 |
| **02** | **CC** | — | **1** | **69** | **C** | **38** | **31** | **—** | **4m 58s** | 更快；发货超量与 audit 双空 |

**横向要点：**

- **SR（公开）**：三批均为 **1**（7/7 验收命令全绿）。
- **质量（Composite）**：**05 74 > 01 71 > 02 69**；05 Judge **36**，较 01 **+3**（D2/D3/D5）。
- **效率（同平台 iceCoder）**：**05** **83 轮 / 12m23s** vs **01** **122 轮 / ≈16m8s** — 05 墙钟更短、轮次更少且分更高。
- **模型**：**05 为 deepseek-4.1-flash**，与 01/02 **不可同模横比**；与 01 对比主要反映 **模型 + Harness 策略 + 实现路径**。
- **共性缺口**：outbox **默认/contract 路径**仍可能跨租户；源码规模远低于 L8；**均不能视为完整 L8 规格**。
- **结论**：当前三份产物中 **05 综合最佳**，但仍是 **公开绿 + 部分隐藏语义** 档，非完整企业融合交付。

### Composite 分差解读（01 vs 02 · +2）

**Composite 71 vs 69 的 2 分差全部来自 Judge（Gate 均为 38/40）。**

| 维度 | 01 iceCoder | 02 CC | 差 |
|------|-------------|-------|-----|
| D1 | 4 | 4 | 0 |
| D2 | **4** | 3 | **+1**（01 修掉发货超量） |
| D3 | **5** | 4 | **+1**（01 硬编码/固定值问题更少） |
| D4 | 7 | 7 | 0 |
| D5 | 8 | 8 | 0 |
| D6 | 5 | 5 | 0 |

### Composite 分差解读（05 vs 01 · +3）

**Composite 74 vs 71 的 3 分差全部来自 Judge（Gate 均为 38/40）。**

| 维度 | 05 deepseek | 01 iceCoder | 差 |
|------|-------------|-------------|-----|
| D1 | 4 | 4 | 0 |
| D2 | **5** | 4 | **+1**（05 自动审批 audit 可带 tenant；outbox 可选 tenant 参数） |
| D3 | **6** | 5 | **+1**（05 模块与 workflow 更整） |
| D4 | 7 | 7 | 0 |
| D5 | **9** | 8 | **+1**（05 含隐藏探针复核对） |
| D6 | 5 | 5 | 0 |

### 隐藏探针对照

| 探针 | 05 | 01 | 02 | 对比 |
|------|----|----|-----|------|
| `outboxCrossTenant` | 失败（省略 tenant 合并） | 失败 | 失败 | 05 传 tenant 可隔离；默认路径仍失败 |
| `canShipTooMuch` | **通过** | **通过** | 失败 | 05 / 01 持平优于 02 |
| `autoApproveAudit` | **基本通过**（显式 tenant） | 部分失败（`tenantId` 空） | 失败（双空） | **05 最优** |

---

## 相关文档

| 文档 | 链接 |
|------|------|
| 任务 yaml | [`../tasks/debug-saas-order-supply-approval-fusion-05.yaml`](../tasks/debug-saas-order-supply-approval-fusion-05.yaml) |
| 任务规格（含赛后结果摘要） | [`../md/debug-saas-order-supply-approval-fusion-05-任务规格.md`](../md/debug-saas-order-supply-approval-fusion-05-任务规格.md) |
| 评分体系 | [`../md/三平台同模对比评测与裁判评分体系.md`](../md/三平台同模对比评测与裁判评分体系.md) |
| 对照（L7 fusion） | [`debug-fusion-supply-fintech.md`](./debug-fusion-supply-fintech.md) |
| 对照（L4+ billing） | [`debug-billing-settlement.md`](./debug-billing-settlement.md) |

---

*报告基于 `debug-saas-order-supply-approval-fusion-01`（iceCoder · 967853ms / 122 轮）、`02`（CC · 4m 58s）盲评归档，及 **`05`**（iceCoder Harness · **deepseek-4.1-flash** · **743000ms / 83 轮** · 2026-09-14 验收复跑与隐藏探针）增补结果。*
