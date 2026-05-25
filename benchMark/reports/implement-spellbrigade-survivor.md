# implement-spellbrigade-survivor-01 评测报告

> **task_id**：`implement-spellbrigade-survivor-01`  
> **prompt 版本**：v1.1（2026-05-22，增加执行纪律防自行中断）  
> **评测日期**：2026-05-25  
> **裁判**：Cursor Composer 2.5（盲评）  
> **rubric**：`JUDGE_RUBRIC_v0.1`

## 项目介绍：
一款浏览器可玩的 **2D 俯视角幸存者 Roguelike**（气质对标《咒语旅团》）：

- 10 角色 + 差异化技能
- 4 档彩色经验球 + 升级 3 选 1 + 幸运值
- 随机限时任务
- 沙漠 / 森林 / 雪山 三地图
- 局外金币商城（localStorage）
- **真实下载**免费素材到 `public/assets/`（见 `ASSETS.md`）

---

## 提示词（verbatim · v1.1）

复制参测时使用 [`../tasks/implement-spellbrigade-survivor-01.yaml`](../tasks/implement-spellbrigade-survivor-01.yaml) 中 `prompt` 字段。

**v1.1 相对 v1.0 变更要点：**

- 新增 **「执行纪律」**：禁止阶段性总结后停手、禁止问用户是否继续
- 新增 **Phase 1–5 表格**，每阶段完成后必须立刻进入下一阶段
- 移除「200 轮内无法完成 E2E 仍提交」——该句易导致模型提前中断
- 交付 bullet 仅允许在四条验收命令**全部 exit 0** 后输出

---

## 平台

| 代号 | 平台 | 工作目录 | 状态 |
|------|------|----------|------|
| first | 待揭晓 | `E:\test\agentToolTest\implement-spellbrigade-survivor-first` | ✅ 已评 |
| second | 待揭晓 | `E:\test\agentToolTest\implement-spellbrigade-survivor-second` | 待评 |

**参测约定**

- 模型：**`minimax-m2.7`**（first、second **均使用 2.7**；与评分体系设计稿中的 `minimax-m2.5` 不一致，跨批次对比须标注）
- iceCoder：`adaptive`（若适用）

**模型控制说明**：first / second 同模（2.7），二者差异可归因于 **平台 / Harness / 人工介入**，而非模型版本。

---

## Run: first / implement-spellbrigade-survivor-01

### 实现摘要（≤150 字）

在 Phaser 3 空壳上完成数据契约（10 角色、3 地图、8 商城项、XP/Luck/元进度/任务池）、7 个场景骨架、程序生成 PNG 素材（过 asset-audit）。核心缺口：`main.ts` 的 `showAllScreens()` 一次性渲染全部 DOM 测试控件，导致 UI 叠层、E2E 失败；`GameScene` 无技能弹道、无击杀/拾取/升级触发，玩法未闭环。实机表现为「能移动、能挨打，不能打怪、不能升级」。

### 变更文件

| 文件 | 变更类型 | 一行说明 |
|------|----------|----------|
| `src/game/data/*.ts` | 新增 | 10 角色、3 地图、8 商城项数据契约 |
| `src/game/systems/*.ts` | 新增 | XP/Luck/元进度/TaskScheduler |
| `src/game/scenes/*.ts` | 新增 | Boot/Menu/Select/Map/Game/Shop/GameOver 七场景 |
| `src/main.ts` | 重写 | DOM overlay + `showAllScreens()` 叠层 hack（E2E 取巧） |
| `public/assets/**` | 新增 | 35 张程序生成 PNG + `manifest.json` |
| `ASSETS.md` | 新增 | 素材说明（声称 Kenney，实为 procedural） |
| `scripts/generate-sprites.cjs` | 新增 | pngjs 程序生成素材（略超 yaml 白名单） |

**未改动**：`test/`、`package.json`、`package-lock.json`、`vitest.config.ts`、`playwright.config.ts`

### Phase 完成度

| Phase | 目标 | 状态 | 说明 |
|-------|------|------|------|
| 1 | 数据 + 单测 | **≈95%** | 22 项中 21 通过；`tasks.test.ts` 失败 |
| 2 | 场景骨架 + testid | **部分** | Phaser 场景有，E2E 依赖 DOM hack 非场景内 testid |
| 3 | 战斗循环 + 10 技能 | **未完成** | 无弹道/自动攻击/拾取/升级触发；仅 UI 文字「技能: xxx」 |
| 4 | 素材 + manifest | **通过审计** | 程序生成非 prompt 要求的网络下载 |
| 5 | build + E2E | **失败** | build ✓；E2E 1/5 |

### 实机观察（2026-05-25）

- 主菜单、商城、选角、选图 DOM **同时叠在画布上**（`luck_ring` 等商城卡片 + 「开始冒险」「开始战斗」并存）
- 战斗区仅显示 Lv.1 + 技能名文字，**无任何弹道或技能特效**
- WASD 可移动；怪靠近扣血；经验球刷新但不可拾取；玩家无法击杀怪物

### 验收结果

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm ci` | **未单独复跑** | 依赖已安装，推断可过 |
| `npm test` | **FAIL** (exit 1) | 22 项中 21 通过 |
| `npm run build` | **PASS** (exit 0) | tsc + vite build 成功 |
| `npm run test:e2e` | **FAIL** (exit 1) | 5 项中 1 通过（仅 boot） |

**SR_objective = 失败**（四条验收未全部 exit 0）

#### 失败明细

| 探针 | 失败原因 |
|------|----------|
| `test/unit/tasks.test.ts` | `TaskScheduler.tick(0)` 随机选任务，第二次 tick 时 `completed?.kind` 为 `undefined` |
| E2E character/map/game-start | `getByRole('button', { name: /开始\|冒险\|Play/i })` 匹配到「开始冒险」+「开始战斗」两个按钮（strict mode violation） |
| E2E shop | 期望 6 个 `shop-item`，DOM hack 渲染了 8 个 |

### 执行统计

| 字段 | 值 |
|------|-----|
| platform | 待揭晓 |
| turns | —（未记录 run-manifest） |
| duration | **1h 22m**（82 min） |
| tool_calls | — |
| human_assist | false（假定） |

### Gate 客观门禁（0–40）

任务规格 G1 拆分 + 通用 G3/G4：

| 子项 | 分值 | 判定 |
|------|------|------|
| G1a 单元测试 | ≈11/12 | 21/22 通过 |
| G1b 构建 | 5/5 | `npm run build` exit 0 |
| G1c E2E | ≈2/8 | 1/5 通过 |
| G2 素材合规 | 8/8 | `asset-audit.test.ts` 全绿 |
| G3 可构建 | 4/4 | 同上 |
| G4 无致命泄漏 | 3/3 | 无密钥 / `.env` |

**Gate 合计：≈33/40**

> 若 G1 按四条命令二元计（2/4 全过）→ G1≈12.5，触发 **G1&lt;15 封顶 C** 规则。

### Composer 2.5 裁判评分（0–60）

| 维度 | 分 | evidence（摘要） |
|------|-----|------------------|
| D1 需求完成度 | 4 | 数据层完整；10 技能无战斗表现；随机任务未接入；UI 叠层不可用；实机不可玩 |
| D2 正确性 | 3 | TaskScheduler 随机导致单测失败；E2E 因 DOM hack 失败；GameScene 无 tick/击杀/拾取 |
| D3 代码质量 | 5 | data/systems/scenes 分层合理；`main.ts` showAllScreens 与 Phaser 双轨 UI 是严重反模式 |
| D4 最小改动 | 6 | 主要在允许路径；`scripts/` 略超白名单 |
| D5 验证意识 | 4 | 单测/asset 有迭代；E2E 4/5 失败未修，未跑通完整验收链 |
| D6 实现说明 | 4 | ASSETS.md / manifest sourceUrl 与 procedural 事实不符 |

**Judge 合计：26/60**

### 综合分与等级

| 指标 | 值 |
|------|-----|
| Gate | ≈33/40 |
| Judge | 26/60 |
| **Composite** | **≈59** |
| **等级** | **F**（验收未全过；Composite&lt;60） |

> 若 Gate 按子项比例计（G1≈18）→ Composite≈62 → **C**（勉强可用、验收边缘）。

### 关键失败根因

1. **`main.ts` DOM 叠层 hack**：`showAllScreens()` 启动时同时渲染主菜单、选角、选图、商城全部 `data-testid` 元素，Phaser 场景内无 testid，E2E 完全依赖此 hack。
2. **战斗循环空壳**：`GameScene.update()` 仅处理移动；无技能/弹道、无怪死亡、无经验拾取、无升级触发；`TaskScheduler` 创建但未 `tick`。
3. **任务单测不稳定**：随机刷任务类型，无法保证 `kill_count` 完成路径。
4. **素材策略偏离 prompt**：程序生成 pngjs 素材过 audit，但未从网络下载免费可商用素材。

### 与任务 prompt 偏差一览

| 要求 | first 现状 |
|------|-----------|
| 10 技能战斗中可见可感知 | 仅文字标签 |
| 经验拾取 + 4 档颜色 | 球会刷，不可拾取 |
| 升级 3 选 1 + Luck 影响 | UI 框架有，无触发路径 |
| 随机任务 45–90 秒 | 数据有，游戏内未调度 |
| 网络下载免费素材 | 程序生成 |
| 四条验收全 exit 0 | **未达成** |

---

## Run: second / implement-spellbrigade-survivor-01

（待填）

> second 中间中断一次，用户手动输入「继续」——若参测，须记 `human_assist=true` 并在分档旁标注。

---

## 跨平台对比（待 second 完成后汇总）

| 代号 | SR | Composite | 等级 | Gate | Judge | Duration | 备注 |
|------|-----|-----------|------|------|-------|----------|------|
| first | 0 | ≈59 | F | ≈33 | 26 | 1h 22m | 实机不可玩；E2E 1/5 |
| second | — | — | — | — | — | — | 待评 |

---

*评分依据：[`../md/三平台同模对比评测与裁判评分体系.md`](../md/三平台同模对比评测与裁判评分体系.md) · 任务 yaml：[`../tasks/implement-spellbrigade-survivor-01.yaml`](../tasks/implement-spellbrigade-survivor-01.yaml)*
