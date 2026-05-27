# implement-spellbrigade-survivor-01 — 超高难 Benchmark 任务规格

> **版本**：1.0  
> **日期**：2026-05-22  
> **层级**：L1 + L5 + **L6（超高难）**  
> **对标玩法**：《咒语旅团 / Spell Brigade》类俯视角幸存者 Roguelike  
> **task yaml**：[`../tasks/implement-spellbrigade-survivor-01.yaml`](../tasks/implement-spellbrigade-survivor-01.yaml)

---

## 0. 难度定位

| 维度 | pipeline-01 | saga-02 | **本任务** |
|------|-------------|---------|------------|
| 类型 | 修 bug + 补全 | 分布式模式实现 | **从零做游戏** |
| 预估轮次 | 18–28 | 50–80 | **120–180** |
| 时间盒 | 45 min | 150 min | **240 min** |
| 客观验收 | 单测 | 单测 | **单测 + 素材审计 + E2E** |
| 主观权重 | 低 | 低 | **中高（美术/UI，Judge D1/D3）** |

本任务用于拉开「长时、多模态、创意实现」场景下各 Agent 运行时差距；**不期望**在 45 分钟标准盒内完成。

---

## 1. 参测提示词（verbatim）

与 yaml `prompt` 字段一致，复制时勿增删平台专属指令。完整版见 [`implement-spellbrigade-survivor-01.yaml`](../tasks/implement-spellbrigade-survivor-01.yaml)。

---

## 2. 游戏设计契约

### 2.1 表 1 — 十角色与初始技能

| ID | 名称 | 技能关键词 | 战斗表现要求 |
|----|------|------------|--------------|
| `blade_dancer` | 刀舞士 | 旋转飞刀 | 环绕角色旋转的飞刀，碰怪造成伤害 |
| `greatsword_knight` | 巨剑骑士 | 巨剑挥砍 | 扇形/front arc 大范围近战 |
| `meteor_mage` | 星陨术士 | 陨石 | 随机落点 AOE，有落点指示 |
| `alchemist` | 炼金师 | 毒气路径 | 移动留下持续伤害毒雾 trail |
| `ranger` | 游侠 | 穿透箭 | 直线穿透多怪 |
| `storm_caller` | 唤雷者 | 连锁闪电 | 命中后弹跳 2–4 个目标 |
| `frost_witch` | 霜巫 | 冰环 | 周期性冻结周围 |
| `summoner` | 召唤师 | 灵魂仆从 | 1–3 个跟随单位自动攻击 |
| `paladin` | 圣骑士 | 护盾光环 | 减伤 + 低频治疗 |
| `shadow_assassin` | 影刺 | 影刺冲刺 | 短 CD 冲刺 + 路径伤害 |

数据文件：`src/game/data/characters.ts` 导出 `CHARACTERS`（长度 10，skillId 唯一）。

### 2.2 经验球档位

| 档位 | 颜色 token | 典型数值 | 来源怪物 tier |
|------|------------|----------|---------------|
| T1 | `green` | 1–3 | 普通 |
| T2 | `blue` | 5–8 | 精英 |
| T3 | `orange` | 12–20 | 小 BOSS |
| T4 | `purple` | 30–50 | 区域 BOSS / 任务奖励 |

`src/game/systems/xp.ts`：`xpOrbColor(tier)`、`xpValueForTier(tier)`、`levelsFromXp(totalXp)`。

### 2.3 幸运值与升级

- 基础 Luck：5（0–100），商城可 +1。
- 升级弹出 3 个 `UpgradeOption`（id、name、baseValue、category）。
- `rollUpgradeValue(baseValue, luck)`：`multiplier = 1 + (luck / 100) * 0.5`，返回 `Math.round(baseValue * multiplier)`。
- 单测覆盖 luck=0 与 luck=100 边界。

### 2.4 随机任务

- 调度：`TaskScheduler` 每局 `spawnIntervalMs` 默认 60_000（允许 45_000–90_000 配置）。
- 任务池至少 4 种：`kill_count`、`survive_no_damage`、`collect_orbs`、`elite_kill`。
- 完成奖励：`gold` | `xp` | `temp_buff` 三选一，写入单测可断言的结构。

### 2.5 三地图

| mapId | 显示名 | 视觉 | 怪物池倾向 |
|-------|--------|------|------------|
| `desert` | 沙漠 | 沙黄/棕褐 tile | 快速小怪 + 蝎子精英 |
| `forest` | 森林 | 绿棕 tile | 均衡 + 远程 |
| `snow` | 雪山 | 蓝白 tile | 高血慢怪 + 冰系 |

`src/game/data/maps.ts` 导出 `MAPS`（长度 3），含 `thumbnailPath` 指向 `public/assets/maps/`。

### 2.6 局外商城

- `src/game/data/shop.ts`：`SHOP_ITEMS` ≥ 6 项，含 `priceGold`、`effect`。
- `src/game/systems/meta-progress.ts`：`loadMeta()` / `saveMeta()` / `purchaseItem()` / `addRunGold()`。
- 持久化键：`spellbrigade-clone-meta-v1`（localStorage）。

### 2.7 单局流程

```text
Boot → MainMenu → CharacterSelect(10) → MapSelect(3) → GameScene
  → (升级暂停 UI) → GameOver → 结算金币 → 回 MainMenu / Shop
```

---

## 3. 美术与资源规范

### 3.1 禁止项

- 纯色 `Graphics` 矩形代替角色/怪物/经验球（**UI 面板背景除外**）。
- 1×1 或 8×8 占位 PNG。
- 未在 `ASSETS.md` 记录来源的素材。

### 3.2 必须项

| 目录 | 最少文件数 | 说明 |
|------|------------|------|
| `public/assets/characters/` | 10 | 每角色至少 1 张 idle 或 portrait |
| `public/assets/monsters/` | 6 | 至少 3 种普通 + 2 精英 + 1 BOSS |
| `public/assets/orbs/` | 4 | 四档经验球 |
| `public/assets/maps/` | 3 | 缩略图或 tileset 预览 |
| `public/assets/ui/` | 4 | 按钮、面板、图标等 |
| `public/assets/shop/` | 6 | 与商城条目对应 |

`public/assets/manifest.json`：列出上述路径及 `sourceUrl`、`license`（Gate 校验）。

### 3.3 推荐素材站（Agent 自行下载）

- [Kenney.nl](https://kenney.nl/assets)（CC0）
- [OpenGameArt.org](https://opengameart.org/)
- itch.io 标注 CC0 / MIT 的 top-down / survivor pack

**不需要**音频文件。

---

## 4. 客观验收（Gate 扩展）

在 [`三平台同模对比评测与裁判评分体系.md`](./三平台同模对比评测与裁判评分体系.md) 基础上，本任务 **G1** 拆分：

| 子项 | 分值 | 判定 |
|------|------|------|
| G1a 单元测试 | 12 | `npm test` 通过比例 × 12 |
| G1b 构建 | 5 | `npm run build` exit 0 |
| G1c E2E | 8 | `npm run test:e2e` 通过比例 × 8 |
| **G1 合计** | **25** | 上限 25 |

**G2 素材合规（8 分）**：`test/asset-audit.test.ts` — manifest 一致、最小尺寸 ≥ 32px、非单色占位。

**G4 补充**：单个 PNG > 2MB 每个 −1（防止塞无压缩大图凑数）。

---

## 5. Judge 补充维度（视觉，仍并入 D1/D3）

裁判盲评时除六维外，参考以下 **checklist**（写入 evidence，不单独加分）：

- [ ] 角色选择屏能辨认 10 个不同头像/立绘
- [ ] 战斗画面可见技能特效（非仅数字飘字）
- [ ] 经验球颜色与档位一致
- [ ] 三地图缩略图可区分
- [ ] 商城图标与商品语义一致
- [ ] 整体非「程序员美术」纯色块

---

## 6. E2E 探针清单（Playwright）

| 用例 | 断言 |
|------|------|
| `boot.spec` | `/` 加载，标题含游戏名 |
| `character-select.spec` | 10 个 `[data-testid^="char-"]` |
| `map-select.spec` | 3 个 `[data-testid^="map-"]` |
| `game-start.spec` | 选角选图后 `#game-canvas` 存在 |
| `shop.spec` | 商城列表 ≥ 6 项，`data-testid="shop-item-*"` |

E2E 针对 **`npm run build` 后的 `dist/`**（`vite preview` 或 playwright webServer 配置）。

---

## 7. 报告模板

评测完成后落盘：`benchMark/reports/implement-spellbrigade-survivor-01.md`

需额外记录：

- 素材总数与 `ASSETS.md` 条目数
- E2E 通过数 / 总数
- 是否使用子 Agent 探索 Phaser
- 截图路径（若有）

---

## 8. 与评测体系文档的关系

建议在 [`三平台同模对比评测与裁判评分体系.md`](./三平台同模对比评测与裁判评分体系.md) §3.1 增加一行：

| L6 | `implement-game-*` | 1+ | 从零实现可玩前端/游戏，含 E2E + 素材 | 中（逻辑高 + 视觉 Judge） |

本任务为 **L6 首发**。

---

*Starter 仓库：`benchMark/repos/implement-spellbrigade-survivor-01`。参测前 `npm ci` 后单测应大量失败，直至 Agent 实现完整游戏。*
