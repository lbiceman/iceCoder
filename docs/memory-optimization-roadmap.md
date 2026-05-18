# 记忆系统极限优化路线图

> 目标：LoCoMo 全量 10 样本整体通过率从 **53.27% → 85%+**
> 
> 核心原则：不改架构，不引入向量/新依赖，只压榨现有组件的极限
> 
> 模型：DeepSeek V4 Flash（不变）

---

## 当前基线

### 全量 10 样本结果（v13_full，1986 QA）

| 样本 | QA数 | 通过率 | 备注 |
|------|:----:|:------:|------|
| conv-26 | 199 | 60.30% | 优化重点样本 |
| conv-30 | 105 | 71.43% | 最高 |
| conv-41 | 193 | 51.81% | |
| conv-42 | 260 | 46.54% | 最低之一 |
| conv-43 | 242 | 53.72% | |
| conv-44 | 158 | 51.90% | |
| conv-47 | 190 | 44.74% | 最低 |
| conv-48 | 239 | 51.46% | |
| conv-49 | 196 | 55.10% | |
| conv-50 | 204 | 55.88% | |
| **总计** | **1986** | **53.27%** | |

### 按类别（v13_full）

| 类别 | 名称 | QA数 | 通过率 | 保守目标 | 乐观目标 |
|:----:|------|:----:|:------:|:-------:|:-------:|
| 1 | Single-hop QA | 282 | 36.88% | 60%+ | 70%+ |
| 2 | Multi-hop QA | 321 | 52.02% | 65%+ | 75%+ |
| 3 | Open-ended QA | 96 | 34.38% | 50%+ | 65%+ |
| 4 | Temporal QA | 841 | 42.69% | 55%+ | 70%+ |
| 5 | Adversarial QA | 446 | 88.57% | 92%+ | 95%+ |

### 差距分析：53% → 80% 需要补 27 个百分点

```
当前分布：  Adversarial 88.57%  ← 已接近极限
            Multi-hop  52.02%  ← 召回+推理都有问题
            Temporal   42.69%  ← 最大分数池(841题)，关键战场
            Single-hop 36.88%  ← 提取遗漏+召回不准
            Open-ended 34.38%  ← 模型推理弱

保守提分：  Temporal   +12pp → 55%   = +101 题（841×0.12）最大收益
            Single-hop +23pp → 60%   = +65 题
            Multi-hop  +13pp → 65%   = +42 题
            Open-ended +16pp → 50%   = +15 题
            Adversarial+4pp  → 92%   = +18 题
                                    合计 +241 题 ≈ 53%→65%

乐观提分：  Temporal   +28pp → 70%   = +235 题（841×0.28）最大收益
            Single-hop +33pp → 70%   = +93 题
            Multi-hop  +23pp → 75%   = +74 题
            Open-ended +31pp → 65%   = +30 题
            Adversarial+7pp  → 95%   = +31 题
                                    合计 +463 题 ≈ 53%→77%
```

**关键洞察**：Temporal QA（841题）是最大分数池，提升它效果最大。但 80%+ 需要所有类别同时提升，且受模型推理能力天花板限制。

---

## 瓶颈诊断

```
提取 → 写文件 → 扫描manifest → LLM选文件 → fact精排 → 注入 → 模型回答
  ↑         ↑          ↑             ↑                        ↑
天花板5   天花板4     天花板1       天花板2                   天花板3
```

| # | 瓶颈 | 现状 | 影响类别 | 损失 |
|---|------|------|---------|------|
| 1 | **LLM sideQuery 收到全部文件** | 150+文件全量manifest ≈12K+ tokens | 全部 | LLM 在 12K+ 里选 5 个，精度 < 60% |
| 2 | **选文件粒度太粗** | LLM选文件→文件内5条fact可能只1条相关 | 1,2,4 | 注入预算浪费 |
| 3 | **模型推理能力弱** | DS4 Flash 多跳推理+时间推理差 | 2,3,4 | 记忆召回了但答错 |
| 4 | **提取时无去重** | 跨 session 重复，同一实体3+文件 | 1,2,4 | 信息冗余+丢失 |
| 5 | **fact 分割粗糙** | 机械分割，长句信息杂 | 1,4 | 精排不准 |
| 6 | **系统级 I/O 无缓存** | scanMemoryFiles 每次全量扫描，100+文件逐一readFile | 全部 | 召回延迟 2-4秒，重复 I/O 占 60%+ |
| 7 | **LLM 两次调用可合并** | 选文件+精排=2次独立 LLM 调用 | 全部 | 召回路径 token 消耗翻倍 |
| 8 | **预取与主召回割裂** | AsyncMemoryPrefetcher 用简单关键词，主路径用 TF-IDF+LLM | 全部 | 预取结果无法被主路径利用 |
| 9 | **代码重复（可维护性）** | tokenize/extractBody 在 3+ 文件中重复实现 | — | 优化迭代慢，改一处漏一处 |

---

## 优化步骤

### 第 0 步：系统级 I/O 与 LLM 调用优化 ⭐ 基础设施层

- **预估提升**：+3-5% 整体（间接收益：更快的缓存命中 + 更精准的 LLM 输入）
- **改动量**：~150 行
- **改动文件**：`memory-recall.ts`、`memory-fact-index.ts`、`memory-scanner.ts`、`harness-memory.ts`、新增 `memory-tokenizer.ts`、`memory-parser.ts`
- **依赖**：无
- **影响类别**：全部（基础设施优化，所有后续步骤均受益）

**核心思路**：

消除重复 I/O 和冗余 LLM 调用，为后续召回优化提供高性能底座

```
现在：每次召回 → 全量扫描 → 100+ readFile → 2次 LLM → 更新 recallCount(写文件)
改后：每次召回 → 缓存命中 → 按需读取 → 1次 LLM → 批量延迟更新
```

**0a. 文件扫描缓存**

- [x] 新增 `MemoryScannerCache`（进程级，TTL 5秒）
- [x] 缓存 `scanMemoryFiles()` 结果，写入/删除/淘汰后主动失效
- [x] `recallRelevantMemories()` 每次不再重新扫描，命中率 > 80%

**0b. Fact Index 文件内容缓存**

- [x] 在 `FactIndex.buildIndex()` 层缓存 `fullContents`（mtime 未变时复用）
- [x] 避免每次召回对 100+ 文件逐一 `readFile`
- [x] 召回延迟预期降 40-50%

**0c. recallCount 批量延迟写入**

- [x] 将 `updateRecallMetadata()` 改为内存计数器 + 30秒定时 flush
- [x] 运行中仅维护内存状态，`drainRecallMetadata()` 用于优雅关闭
- [x] 减少 80% 小文件写入 I/O

**0d. TF-IDF IDF 表缓存**

- [x] 将 `buildIdfMap()` 结果缓存为进程级单例（`buildIdfMapCached`）
- [x] 基于记忆列表指纹（filenames + mtimeMs）判断是否需要重算
- [x] 关键词回退路径速度提升 2-3x

**0e. LLM 两次调用合并为一次**

- [x] 合并 `llmSelectMemories`（选文件）和 `extractFactsFromSelected`（精排）为 `llmSelectAndRankMemories`
- [x] 新 prompt 同时输出选中的 fact 和排序：`{"selected_facts": [{"id": "F1", "reasoning": "..."}]}`
- [x] **召回路径 token 消耗减少 ~40%**

**0f. 预取结果注入主召回路径**

- [x] `FileMemoryManager.getPrefetchedMemories()` 获取预取结果
- [x] 预取命中的文件直接提升初始评分（+0.2），减少主路径需要评估的文件数
- [x] 首字延迟降低

**0g. 代码去重（可维护性）**

- [x] 抽取 `tokenize()` + `extractEntities()` 为 `memory-tokenizer.ts`
- [x] 抽取 `extractBodyFromMarkdown()` 为 `memory-parser.ts`
- [x] 三个文件的重复代码已全部替换为共享模块

**为什么优先做**：零风险、确定性收益。不做这步，后续所有步骤都跑在低效底座上——每次验证都要等 2-4 秒召回延迟，迭代效率极低。

---

### 第 1 步：关键词前置过滤 ⭐ 最高优先级

- **预估提升**：+8-12% 整体（+160-240 QA）
- **改动量**：~50 行
- **改动文件**：`src/memory/file-memory/memory-recall.ts`
- **依赖**：无
- **影响类别**：全部（1-5 均受益于更精准的召回）

**核心思路**：

LLM sideQuery 前先用关键词粗排 top-30，再让 LLM 从 30 里选 top-5

```
现在：150+ 文件全量 → LLM 选 5 个   (12K+ tokens manifest, 精度低)
改后：150+ 文件 → 关键词 top-30 → LLM 选 5 个  (2.4K manifest, 精度高)
```

**改动要点**：

- [ ] 在 `llmSelectMemories` 前增加 `keywordPrefilter` 函数
- [ ] 复用现有 `keywordFallback` 的 TF-IDF 逻辑，但只做粗排不下发
- [ ] 粗排 top-30 送入 LLM，manifest 从 12K+ → ~2.4K tokens
- [ ] 保留关键词回退路径作为兜底（LLM 失败时仍可用）

**为什么有效**：LLM 在 2.4K tokens manifest 里做选择，准确率远高于 12K+。关键词粗排的 recall@30 能覆盖 90%+ 相关文件。

---

### 第 2 步：Fact 级 sideQuery

- **预估提升**：+5-8% 整体（+100-160 QA）
- **改动量**：~80 行
- **改动文件**：`src/memory/file-memory/memory-recall.ts`
- **依赖**：步骤 1

**核心思路**：

LLM 选的不再是"文件"，而是"fact"

```
现在：manifest 按"文件"列 → LLM 选文件 → 读文件内 fact → 精排
改后：manifest 按"fact"列 → LLM 选 fact → 映射回文件 → 加载
```

**改动要点**：

- [ ] 新增 `formatFactManifest` 函数，按 fact 逐条列出
- [ ] 每条 fact 标注来源文件名（如 `F1 [jamess_dogs.md]: ...`）
- [ ] LLM 返回 `{"selected": ["F1", "F2"]}`，映射回源文件
- [ ] 修改 `SELECT_MEMORIES_SYSTEM_PROMPT`，从"选文件"改为"选 fact"

**manifest 格式对比**：

```markdown
# 现在（按文件）
- [reference] jamess_dogs.md: James has two dogs...
  · James has dogs named Max and Daisy
  · They can do tricks: sit, stay, paw, rollover

# 改后（按 fact）
- F1 [jamess_dogs.md]: James has dogs named Max and Daisy
- F2 [jamess_dogs.md]: They can do tricks: sit, stay, paw, rollover
```

---

### 第 3 步：查询扩展（同义词表）

- **预估提升**：+4-6% 整体（+80-120 QA）
- **改动量**：~60 行
- **改动文件**：`src/memory/file-memory/memory-recall.ts`
- **依赖**：无
- **主要影响类别**：Single-hop（词汇不匹配是最大漏召回原因）

**核心思路**：

关键词匹配前，用规则扩展查询的同义词和领域词（零 LLM 成本）

```
现在："What are James's pets?" → tokenize → {james, pets}
改后："What are James's pets?" → expand → {james, pets, dog, cat, puppy, animal}
```

**改动要点**：

- [ ] 新增 `expandQueryWithSynonyms` 函数
- [ ] 构建通用同义领域表
- [ ] 扩展后的 tokens 合并到 `queryTokens` 参与粗排
- [ ] 扩展 token 的 TF-IDF 权重降为 0.5（避免噪声词主导）

**同义词表**：

```typescript
const SYNONYM_EXPANSION: Record<string, string[]> = {
  pet:     ['dog', 'cat', 'puppy', 'animal', 'hamster', 'kitten'],
  hobby:   ['pastime', 'activity', 'interest', 'leisure', 'pastime'],
  game:    ['gaming', 'video game', 'rpg', 'tournament', 'play'],
  music:   ['instrument', 'drums', 'guitar', 'piano', 'band', 'song'],
  job:     ['work', 'career', 'profession', 'employment', 'position'],
  friend:  ['buddy', 'pal', 'companion', 'mate', 'colleague'],
  food:    ['meal', 'cuisine', 'dish', 'restaurant', 'cooking'],
  travel:  ['trip', 'vacation', 'journey', 'visit', 'holiday'],
  sport:   ['exercise', 'athletic', 'competition', 'fitness', 'game'],
  school:  ['class', 'course', 'education', 'study', 'university'],
  car:     ['vehicle', 'automobile', 'drive', 'driving'],
  house:   ['home', 'apartment', 'place', 'residence', 'live'],
  movie:   ['film', 'cinema', 'show', 'watch'],
  book:    ['read', 'novel', 'literature', 'author'],
  weather: ['temperature', 'rain', 'snow', 'sunny', 'cold', 'hot'],
  family:  ['parent', 'sibling', 'brother', 'sister', 'mother', 'father'],
  health:  ['doctor', 'hospital', 'medicine', 'sick', 'illness'],
  money:   ['salary', 'pay', 'income', 'cost', 'price', 'expensive'],
};
```

---

### 第 4 步：LoCoMo 评测流程改造（提取去重 + Dream 整合）

- **预估提升**：+5-8% 整体（+100-160 QA）
- **改动量**：~120 行 Python
- **改动文件**：`LoCoMo/_run_conv47.py`、`LoCoMo/evaluator_judge.py`
- **依赖**：无
- **主要影响类别**：Multi-hop、Temporal（跨 session 实体合并最受益）

**4a. 提取时传入已有 manifest（去重）**

- [ ] 在 `_run_conv47.py` 中，每个 session 提取前扫描已有记忆文件
- [ ] 将已有文件列表作为 `existing_memories` 传入提取 prompt
- [ ] 修改 `EXTRACT_USER_TEMPLATE`，增加已有记忆区段
- [ ] 提取 prompt 指令：如果已有文件覆盖同一主题，返回 `update` 而非 `create`

**4b. 注入完成后触发 Dream 整合**

- [ ] 在所有 session 注入完成后，调用 Dream 整合
- [ ] 用 DeepSeek API 执行一次合并：合并同实体文件、去重、修剪索引
- [ ] Dream 整合后再写入 MEMORY.md
- [ ] 合并后文件数预期从 ~170 降至 ~80-100（甜点区间）

**4c. 可选：后处理去重脚本**

- [ ] 新增 `LoCoMo/_dedup_memories.py`
- [ ] 纯规则去重：同 tags Jaccard ≥ 0.6 的文件合并
- [ ] 同实体名（从 description 提取）的文件合并
- [ ] 作为 Dream 的轻量替代（不依赖 LLM）

---

### 第 5 步：Fact 分割优化

- **预估提升**：+2-4% 整体（+40-80 QA）
- **改动量**：~40 行
- **改动文件**：`src/memory/file-memory/memory-fact-index.ts`
- **依赖**：无
- **主要影响类别**：Single-hop、Temporal（精确 fact 匹配更准确）

**核心思路**：

从机械分割改为"语义句分割"——按主谓宾结构分割，每段只有一个核心断言

```
现在："James went bowling on 16 March 2022, got two strikes, and expressed his love for bowling"
     → 整条作为一个 fact

改后：fact1: "James went bowling on 16 March 2022"
      fact2: "James got two strikes while bowling"
      fact3: "James loves bowling"
```

**改动要点**：

- [ ] 修改 `splitIntoFacts` 函数
- [ ] 增加逗号+连词分割规则
- [ ] 每段长度限制 50-150 字符
- [ ] `MAX_FACTS_PER_FILE` 从 30 调整为 50

---

### 第 6 步：Temporal QA 专项优化 ⭐ 最大分数池

- **预估提升**：+5-8% 整体（Temporal 841题，+42-67pp → 整体+18-28pp）
- **改动量**：~100 行
- **改动文件**：`memory-recall.ts`（时间索引）、`harness-memory.ts`（注入策略）
- **依赖**：步骤 1（前置过滤）
- **主要影响类别**：Temporal（42.69% → 70%+）

**6a. eventDate 空值回填**

- [ ] 扫描所有记忆文件，eventDate 为空时从 content/tags 中正则提取
- [ ] 常见模式：`on [date]`、`in [month] [year]`、`[X] days ago`
- [ ] 回填后 Temporal QA 的时间加权（EVENT_TIME_BOOST=2.0）才能生效

**6b. 时间范围查询扩展**

- [ ] `parseTimeRange` 增加 "around [date]"、"before [date]"、"after [date]" 模式
- [ ] "around March 2022" → ±15天范围，"before April" → 2022-01-01 ~ 2022-03-31
- [ ] LoCoMo 高频模式："the week before [date]"、"about a month before [date]"

**6c. 时间推理辅助注入**

- [ ] 当检测到时间相关查询时，额外注入时间轴上下文
- [ ] 在 CoN prompt 中增加时间推理引导："If the question asks about timing, first identify all dated events in the memories, then compute the answer"

---

### 第 7 步：Multi-hop 推理增强

- **预估提升**：+3-5% 整体（Multi-hop 321题，+18-32pp → 整体+3-5pp）
- **改动量**：~60 行
- **改动文件**：`harness-memory.ts`（注入策略）、`memory-recall.ts`（关联扩展）
- **依赖**：步骤 2（Fact 级 sideQuery）
- **主要影响类别**：Multi-hop（52.02% → 75%+）

**7a. 关联扩展增强**

- [ ] `MAX_RELATED_EXPAND` 从 3 增加到 5
- [ ] tags Jaccard 阈值从 0.3 降低到 0.2（扩大关联面）
- [ ] 新增实体名关联：提取文件中的实体名（人名、地名），同名实体自动关联

**7b. 多跳推理引导注入**

- [ ] 检测到多跳查询（含 "also"、"both"、"relationship"）时，注入额外关联记忆
- [ ] CoN prompt 增加多跳引导："If the question requires combining information from multiple memories, explicitly list each fact you used and how they connect"

---

### 第 8 步：对抗性 QA 优化（防守型）

- **预估提升**：+1-2% 整体（Adversarial 446题，88.57%→92%）
- **改动量**：~20 行
- **改动文件**：`harness-memory.ts`（CoN prompt）
- **依赖**：无

- [ ] CoN prompt 增加对抗性引导："If the question seems to test whether you'll fabricate information, and the memories don't contain the answer, say you don't have that information rather than guessing"
- [ ] 对抗性检测：问题含 "also"、"exactly"、"specifically" 时，加强"不确定就说不确定"指令

---

### 第 9 步：遗漏的召回精度补丁

- **预估提升**：+3-5% 整体
- **改动量**：~100 行
- **改动文件**：`memory-recall.ts`、`memory-fact-index.ts`、`harness-memory.ts`
- **依赖**：步骤 0（代码去重后更易修改）、步骤 1（前置过滤）
- **主要影响类别**：1(Single-hop)、4(Temporal)、5(Adversarial)

**9a. 查询时 LLM 提取关键实体**

- [ ] sideQuery 前用极短 prompt（~50 tokens）让 LLM 从用户问题中提取核心实体名
- [ ] 比正则提取更准确：`"What did James buy last week?"` → 实体 `["James"]`，时间 `["last week"]`
- [ ] 实体名精确匹配加权 +0.5（高于当前正则的 +0.3）

**9b. Fact Index 增加 eventDate 字段**

- [ ] 当前 Fact Index 只有文本和 tags，没有时间维度索引
- [ ] 为每条 fact 添加 `eventDate` 字段（从文件 frontmatter 继承 + content 中正则提取）
- [ ] Temporal QA 可直接按时间过滤 facts，而非回退到文件级时间加权

**9c. LLM 选文件 prompt 结构化输出**

- [ ] 当前 LLM 返回文件名列表，改为返回 `{"selected": [...], "reasoning": "..."}`
- [ ] reasoning 可用于：① 调试召回质量 ② 后续精排加权（reasoning 中提及的 fact 优先级更高）

**9d. 低置信度召回标注（Adversarial 增强）**

- [ ] 召回时：如果查询和所有记忆的最高相似度 < 阈值（如 TF-IDF 最高分 < 0.1），标注"低置信度召回"
- [ ] 注入时在 CoN prompt 中提示："The following memories have low relevance to the question, they may not contain the answer"
- [ ] 让模型更倾向于"不知道"而非幻觉，Adversarial QA +2-3%

**9e. 否定/排除查询增强**

- [ ] 当前 `DOMAIN_EXPANSION` 表覆盖有限（仅 "test" → vitest/jest/mocha 等）
- [ ] 基于已有记忆文件的 tags 自动构建反向映射：如果某文件的 tags 全被否定查询排除，降权
- [ ] 例：用户说"不要用 React"，tags 含 `framework:react` 的文件全部降权

---

### 第 10 步：召回-推理分离诊断

- **预估提升**：0%（诊断步骤，但决定后续方向）
- **改动量**：~60 行 Python
- **改动文件**：`LoCoMo/evaluator_judge.py`（新增诊断模式）
- **依赖**：步骤 0-1 完成后
- **影响类别**：全部

**核心思路**：

在继续投入优化前，必须量化"没召回"vs"召回了但答错"的比例，否则后续投入方向可能偏离

- [ ] 新增 `--diagnose` 模式，对每个失败 QA case 记录：
  - 召回的记忆文件列表（来自 telemetry 日志）
  - 是否包含正确答案所需的关键信息
  - 模型回答的错误类型（幻觉/遗漏/推理错误）
- [ ] 分类统计：
  - **A 类**：完全没召回相关信息 → 优化召回（步骤 1-3、9）
  - **B 类**：召回了但信息不完整 → 优化提取/分割（步骤 4-5）
  - **C 类**：召回了完整信息但答错 → 优化 prompt 引导或换模型
- [ ] 根据诊断结果调整后续步骤优先级：
  - 如果 A 类 > 50%：继续召回优化
  - 如果 C 类 > 40%：考虑换模型（DS4 Pro / MiMo-Pro）
  - 如果 B 类 > 30%：优先做提取去重和 Fact 分割

---

## 预期收益汇总

### 召回精度优化（步骤 1-9）

| 步骤 | 改动量 | 预估整体提升 | 风险 | 主要影响类别 |
|------|:------:|:----------:|:----:|:----------:|
| 0. 系统级 I/O 与 LLM 优化 | ~150行 | +3-5% | 低 | 全部（基础设施） |
| 1. 关键词前置过滤 | ~50行 | +8-12% | 低 | 全部 |
| 2. Fact 级 sideQuery | ~80行 | +5-8% | 中 | 1,2,4 |
| 3. 查询扩展 | ~60行 | +4-6% | 低 | 1(Single-hop) |
| 4. LoCoMo 流程改造 | ~120行 | +5-8% | 低 | 2,4(Multi/Temporal) |
| 5. Fact 分割优化 | ~40行 | +2-4% | 低 | 1,4 |
| 6. Temporal 专项 | ~100行 | +5-8% | 中 | 4(Temporal) |
| 7. Multi-hop 增强 | ~60行 | +3-5% | 中 | 2(Multi-hop) |
| 8. 对抗性优化 | ~20行 | +1-2% | 低 | 5(Adversarial) |
| 9. 遗漏召回补丁 | ~100行 | +3-5% | 低 | 1,4,5 |
| 10. 召回-推理诊断 | ~60行 | 0%（诊断） | 低 | 全部（方向决策） |

**累计预估（0.7 叠加系数）**：

| 场景 | 预估通过率 | 说明 |
|------|:---------:|------|
| 乐观（所有步骤完美） | 82-87% | 需模型配合推理 |
| 保守（模型推理受限） | 75-80% | 召回优化到位但 C 类答错 |
| 仅做召回优化（步骤 0-5+9） | 72-76% | 不改流程和推理 prompt |

### 系统级优化对性能和用户体验的量化影响

| 指标 | 当前 | 优化后（步骤 0） | 变化 |
|------|------|-----------------|------|
| 单次召回延迟 | ~2-4 秒 | ~0.8-1.5 秒 | **-50~60%** |
| 召回路径 token 消耗 | ~3-5K tokens/次 | ~1.5-2.5K tokens/次 | **-40~50%** |
| 磁盘 I/O 次数/对话轮 | ~200-400 次 | ~50-100 次 | **-60~75%** |
| 关键词回退速度 | 基线 | 2-3x 更快 | **+200%** |
| 记忆召回准确率（间接） | 基线 | +3-5pp | 缓存命中+更精准 LLM 输入 |
| 用户感知响应速度 | 偶有卡顿 | 明显流畅 | **质变** |

> 注：步骤 0 的 token 消耗是**减少**的（LLM 调用合并），不是增加。整体优化完成后，每次对话轮的 token 总消耗预计减少 15-25%。

---

## 执行计划

```
Phase 0（本周）：步骤 0 → 系统级 I/O 与 LLM 优化（零风险底座）
  ↓ 跑全量 10 样本验证（确认无回归）
Phase 1（本周）：步骤 1 + 3 → 召回精度核心优化
  ↓ 跑全量 10 样本验证
Phase 2（下周）：步骤 2 + 5 → Fact 粒度优化
  ↓ 跑全量验证
Phase 3（下周）：步骤 4 → LoCoMo 流程改造
  ↓ 跑全量验证
Phase 3.5（下周）：步骤 10 → 召回-推理分离诊断（决定后续方向）
  ↓ 根据诊断结果调整 Phase 4-5 优先级
Phase 4（第三周）：步骤 6 → Temporal 专项（最大分数池）
  ↓ 跑全量验证
Phase 5（收尾）：步骤 7 + 8 + 9 → Multi-hop + Adversarial + 遗漏补丁
  ↓ 最终全量验证
```

每步独立可测，验证标准：**全量 10 样本整体通过率**。

> **关键决策点**：Phase 3.5 诊断后，如果 C 类（召回了但答错）> 40%，应考虑在 Phase 4 前换模型，否则 Temporal/Multi-hop 的投入回报率极低。

---

## 验证方法

1. **全量评测**：每步改完后跑 `python run_locomo_official.py`（1986 QA，~6小时）
2. **快速验证**：先用 `--sample-ids conv-26 conv-47`（389 QA，~1.5小时）
3. **召回质量分析**：对失败 QA case，分类统计是"没召回"还是"召回了但答错"
4. **manifest token 统计**：对比优化前后送入 LLM 的 manifest 大小

---

## 风险与边界

**乐观估计**（所有步骤完美叠加）：53% → 82-87%
**保守估计**（步骤间有重叠，模型推理受限）：53% → 75-80%

**85% 可能需要的额外条件**：
- 如果保守估计只到 78%，需要考虑换模型（DS4 Pro / MiMo-Pro）补最后 5-7%
- Temporal QA 的 70% 目标过于乐观，DS4 Flash 的时间推理能力可能只能支撑到 55-65%
- Multi-hop 的 75% 目标同样受限于模型推理，实际可能只能到 65-70%

**步骤间收益重叠提示**：
- 步骤 1（关键词前置过滤）和步骤 3（查询扩展）有高度重叠——都改善关键词匹配质量
- 步骤 2（Fact 级 sideQuery）和步骤 5（Fact 分割优化）有重叠——都改善 fact 粒度
- 实际叠加系数约 0.6-0.7，非简单加法

**关键风险**：
- 如果诊断显示 C 类（召回了但答错）> 40%，后续召回优化投入回报率极低
- 系统级缓存（步骤 0）需注意缓存一致性，写入/删除后必须主动失效

## 不做的事

- ❌ 不引入向量数据库 / embedding
- ❌ 不换模型（但保留诊断后换模型的可能性）
- ❌ 不改 .md 文件存储格式
- ❌ 不改 frontmatter 结构
- ❌ 不改 Dream 整合逻辑（它已经在真实环境工作）
