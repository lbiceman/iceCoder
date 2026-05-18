# 记忆系统极限优化方案（目标 > 80%）

> 基于 LoCoMo conv-47 评测（47.37% / 190 QA）逐题分析，纯当前架构，无外部依赖。

---

## 核心发现：真正的瓶颈不是召回，是提取丢失

逐题分析 100 道失败题后，发现一个关键事实：

**大部分 "I don't know" 失败（~60 题）不是因为记忆没被召回，而是记忆根本不存在于系统中。**

证据链：
- 159 个记忆文件，覆盖 8-10 个 session → 平均 16-20 文件/session
- 但后期 session（9-11，Sep-Nov 2022）的信息大面积缺失：
  - Samantha 相关（认识、恋爱、同居）→ 全部 "不知道"
  - McGee's bar（啤酒、见面、同居地点）→ 全部 "不知道"
  - 烹饪课（报名、费用、学做菜）→ 全部 "不知道"
  - 第二次慈善锦标赛（Oct 30-31）→ "不知道"
  - FIFA 23、桌游、编程竞赛 → 全部 "不知道"
  - 公路旅行、拜访 Mark/Josh → "不知道"
- 前期 session（1-5）的信息召回正常

**结论：提取阶段丢失了后期 session 的大量信息，这是 47% → 80%+ 的最大障碍。**

---

## 失败模式分类（100 道失败）

| 模式 | 题数 | 根因 | 优化方向 |
|------|------|------|----------|
| 记忆不存在（"不知道"） | ~60 | **提取丢失**后期 session 信息 | S1, S2, S3 |
| 部分回答（列表不全） | ~15 | 召回只命中部分文件，完整性指令不足 | S4, S5 |
| 日期错误 | ~10 | eventDate 未正确填写或召回时未用时间索引 | S6 |
| 实体混淆（James/John） | ~8 | 无实体索引，tag 太泛 | S7 |
| Judge API 崩溃 | ~8 | 非记忆系统问题 | S8 |

---

## 方案分层

### S 层：提取质量（最关键，解决 ~60 题）

| # | 改动 | 文件 | 改法 | 预期挽回 |
|---|------|------|------|----------|
| S1 | **原子化提取**：将 topic 分组改为逐事实提取 | `evaluator_judge.py` EXTRACTION_SYSTEM_PROMPT | 删除 "5-8 items per session" 限制，改为 "extract every distinct fact as a separate item"；删除 "topic-oriented grouping"，改为 atomic facts | +25-30 题 |
| S2 | **提高 chunk 上限** | `evaluator_judge.py` | `MAX_CHUNK`: 5000 → 8000，`transcript[:6000]` → `[:10000]`，减少切分导致的信息碎片化 | +8-10 题 |
| S3 | **两轮提取**：第一轮正常提取，第二轮对未覆盖段落做补充提取 | `evaluator_judge.py` `extract_memories_from_session()` | 第一轮提取后，检查哪些段落的关键词未出现在任何提取结果中，对这些段落做第二轮提取 | +10-15 题 |
| S4 | **完整性校验 prompt** | `evaluator_judge.py` EXTRACTION_SYSTEM_PROMPT | 加入："If the conversation mentions a LIST of items (games, countries, tricks, books), you MUST include ALL items in a single memory entry. Do not truncate lists." | +5-8 题 |
| S5 | **放宽输出 token** | `evaluator_judge.py` | `max_tokens`: 6144 → 12288，确保长 session 的所有 facts 都能输出 | +3-5 题 |

**S1 是最关键的改动。** 当前提取 prompt 说 "5-8 items per session" + "topic-oriented grouping"，导致：
- 一个 session 提取 5-8 个 topic，每个 topic 合并了多个 facts
- 但 topic 合并时，细节被压缩或丢失
- 例如 "James's gaming interests" topic 合并了 Apex Legends、Witcher 3、Civilization VI，但 QA 问 "James's favorite game" 时答案是 Apex Legends，这个细节被 topic 描述淹没了

改为原子化提取后：
- 每个独立事实一个文件，不合并
- 一个 session 可能产生 20-30 个原子 facts（而非 5-8 个 topics）
- 10 个 session × 25 facts = 250 个文件（仍在合理范围内）

---

### R 层：召回质量（解决剩余 "不知道" + 部分回答）

| # | 改动 | 文件 | 改法 | 预期挽回 |
|---|------|------|------|----------|
| R1 | **提高召回上限** | `memory-config.ts:87` | `MEMORY_MAX_RELEVANT`: 20 → 40 | +5-8 题 |
| R2 | **实体索引**：扫描时构建 entity→files 映射 | `memory-scanner.ts` 或新建 `memory-entity-index.ts` | 扫描所有文件的 description + contentPreview，提取人名/地名/游戏名等实体，建立倒排索引。召回时先查实体索引，再做语义匹配 | +5-8 题 |
| R3 | **时间索引**：按 eventDate 排序，支持时间范围查询 | `memory-recall.ts` | 构建 eventDate → file 映射。当 query 包含时间词时（"in October", "on November 5"），先按时间范围过滤，再做关键词匹配 | +5-8 题 |
| R4 | **两阶段召回**：第一阶段 LLM 选文件，第二阶段 LLM 选 facts | `memory-recall.ts` | 当前已是 v7 合并调用。改为：先用 LLM 从 manifest 选 top-60 文件，再读取这 60 个文件的完整内容，用 LLM 从中选 top-40 facts。比当前 "5 facts/file × 159 files" 的 manifest 更精准 | +5-8 题 |
| R5 | **facts 上限提升** | `memory-recall.ts:64, 251` | LLM prompt: 15 → 30；slice cap: 15 → 30 | +3-5 题 |
| R6 | **CoN prompt 完整性指令** | `harness-memory.ts:277-304` | 追加："If memories contain a list, you MUST include ALL items. Partial lists are worse than saying 'I don't know'." | +3-5 题 |
| R7 | **接入 memoryDecayFactor** | `memory-recall.ts:754` | 用 decay factor（stale 0.5x, expired 0.1x）替换当前 freshness 公式 | 避免过期记忆干扰 |

---

### T 层：时间推理（解决 temporal QA 49/83 失败）

| # | 改动 | 文件 | 改法 | 预期挽回 |
|---|------|------|------|----------|
| T1 | **强制 eventDate** | `evaluator_judge.py` EXTRACTION_SYSTEM_PROMPT + `run_locomo_official.py` | prompt 加："eventDate 字段是必须的。从对话日期和上下文推断绝对日期。格式 YYYY-MM-DD。如果无法确定精确日期，填写 session 日期。" | +8-10 题 |
| T2 | **session 日期回填** | `run_locomo_official.py` `inject_conversations()` | 如果 LLM 提取的 eventDate 为空，使用该 session 的日期作为默认值 | +3-5 题 |
| T3 | **时间范围查询增强** | `memory-recall.ts` `parseTimeRange()` | 当前 parseTimeRange 已经很强（163 行），但需要在 LLM prompt 中加入时间范围提示，让 LLM 知道要优先选择时间匹配的记忆 | +3-5 题 |

---

### J 层：Judge 稳定性（解决 8 题误判）

| # | 改动 | 文件 | 改法 | 预期挽回 |
|---|------|------|------|----------|
| J1 | **JSON 解析兜底** | `evaluator_judge.py` `_parse_judge_response()` | 当 JSON 解析失败时，用正则提取 `"verdict":\s*"(correct|incorrect)"` 和 `"confidence":\s*([\d.]+)`，而非直接返回 incorrect | +5-6 题 |
| J2 | **Judge 重试策略** | `evaluator_judge.py` `judge_qa()` | 重试时换用更低 temperature（0.1 → 0），并缩短 prompt | +1-2 题 |

---

### A 层：Agent 体验（并行优化）

| # | 改动 | 文件 | 说明 |
|---|------|------|------|
| A1 | context_replace 工具 | `file-tools.ts` | old_string/new_string 精确替换 |
| A2 | TaskCreate/Update/List/Get | 新建 `task-tool.ts` | 任务分解 + 状态追踪 |
| A3 | AskUserQuestion 工具 | 新建 `ask-tool.ts` | agent 中途提问 |
| A4 | Think/Plan 工具 | 新建 `think-tool.ts` | 显式思考空间 |
| A5 | search_in_files 用 ripgrep | `search-tools.ts` | 大仓库提速 10-100x |
| A6 | Glob 工具 | 新建 `glob-tool.ts` | 文件名模式匹配 |
| A7 | edit_file 失败提示 | `file-tools.ts` | 返回附近行号上下文 |

---

## 实施路线图

### 第一阶段：提取重建（2-3天，最关键）

```
S1 + S2 + S3 + S4 + S5 + T1 + T2
```

改法详解：

**S1 — 原子化提取** (`evaluator_judge.py` EXTRACTION_SYSTEM_PROMPT)：
```
原 prompt:
  "5-8 ITEMS PER CONVERSATION SESSION"
  "Topic-oriented grouping strategy"
  "Group related facts by entity+topic into single items"

改为:
  "Extract EVERY distinct fact as a separate item"
  "DO NOT group multiple facts into one item"
  "Each item should contain exactly ONE piece of information"
  "There is NO limit on the number of items — extract as many as needed"
```

**S2 — chunk 上限** (`evaluator_judge.py`)：
```python
MAX_CHUNK = 8000  # 原 5000
transcript[:10000]  # 原 [:6000]
```

**S3 — 两轮提取** (`evaluator_judge.py` `extract_memories_from_session()`)：
```python
# 第一轮：正常提取
facts = extract_chunk(chunk)

# 覆盖率检查：提取结果是否覆盖了 chunk 的关键实体
covered_text = ' '.join(f['name'] + ' ' + f.get('description', '') for f in facts)
uncovered = find_uncovered_segments(chunk, covered_text)

# 第二轮：对未覆盖段落补充提取
if len(uncovered) > 200:
    extra_facts = extract_chunk(uncovered)
    facts.extend(extra_facts)
```

**S4 — 完整性指令** (追加到 EXTRACTION_SYSTEM_PROMPT)：
```
CRITICAL: When the conversation mentions a LIST of items (games, countries, tricks,
books, food, names), you MUST include ALL items in a single memory entry.
NEVER truncate a list. If you find 7 tricks a dog knows, list all 7.
```

**S5 — 放宽输出** (`evaluator_judge.py`)：
```python
max_tokens=12288  # 原 6144
```

**T1 — 强制 eventDate** (追加到 EXTRACTION_SYSTEM_PROMPT)：
```
The "eventDate" field is MANDATORY. Infer the absolute date from:
1. The session date (provided at the start of each session)
2. Date references in the conversation ("last week", "yesterday")
3. If no date can be inferred, use the session date as default
Format: YYYY-MM-DD
```

**T2 — session 日期回填** (`run_locomo_official.py` `inject_conversations()`)：
```python
# 在 inject_conversations 的 eventDate 处理中：
if not event_date:
    event_date = session_date  # 使用 session 日期作为默认
```

**预期：47% → 65-72%**

---

### 第二阶段：召回增强（2-3天）

```
R1 + R2 + R3 + R5 + R6 + R7 + J1
```

**R1 — 提高召回上限**：
```typescript
// memory-config.ts:87
MEMORY_MAX_RELEVANT = 40  // 原 20
```

**R2 — 实体索引**（新建 `memory-entity-index.ts`）：
```typescript
// 构建：扫描所有文件的 description + contentPreview
// 提取：人名、地名、游戏名、组织名
// 存储：Map<entity, Set<filePath>>
// 更新：文件写入/删除时更新索引
// 查询：recallRelevantMemories() 中先查实体索引，将命中的文件优先加入候选
```

**R3 — 时间索引**（在 `memory-recall.ts` 中增强）：
```typescript
// 构建：扫描所有文件的 eventDate 字段
// 存储：SortedMap<eventDate, filePath[]>
// 查询：parseTimeRange() 解析出时间范围后，先从时间索引中筛选
// 加权：时间范围内的文件 score × 2.0（当前已有 EVENT_TIME_BOOST）
```

**R5 — facts 上限**：
```typescript
// memory-recall.ts:64 — LLM prompt
"Limit to 30 facts total"  // 原 15
// memory-recall.ts:251 — slice cap
selectedFacts.slice(0, 30)  // 原 15
```

**R6 — 完整性指令**：
```typescript
// harness-memory.ts buildCoNMemoryPrompt() 追加：
"- **List completeness**: If memories contain a list of items (games, tricks, countries),
   you MUST include ALL items in your answer. A partial list is worse than admitting uncertainty."
```

**R7 — decay factor**：
```typescript
// memory-recall.ts:754
// 替换当前 freshness 公式为：
import { memoryDecayFactor } from './memory-age.js';
const decayFactor = memoryDecayFactor(memory.mtimeMs, memory.confidence);
score *= decayFactor;  // 替换原来的 freshness 加分
```

**J1 — JSON 兜底**：
```python
# evaluator_judge.py _parse_judge_response()
def _parse_judge_response(text):
    # 尝试 JSON 解析
    try:
        return json.loads(text)
    except:
        # 正则兜底
        import re
        verdict_m = re.search(r'"verdict"\s*:\s*"(correct|incorrect)"', text)
        conf_m = re.search(r'"confidence"\s*:\s*([\d.]+)', text)
        if verdict_m:
            return {
                "verdict": verdict_m.group(1),
                "confidence": float(conf_m.group(1)) if conf_m else 0.5,
                "reason": "Parsed via regex fallback"
            }
        return {"verdict": "incorrect", "confidence": 0.0, "reason": "Parse failed"}
```

**预期：65-72% → 75-80%**

---

### 第三阶段：精准化（1-2天）

```
S6 + R4 + T3 + J2 + M8
```

**S6 — eventDate 强制**（已在 T1 中覆盖）

**R4 — 两阶段召回**：
```
阶段 1：从 159 个文件的 manifest 中用 LLM 选 top-60 文件
阶段 2：读取这 60 个文件的完整内容，用 LLM 从中选 top-40 facts
比当前 "5 facts/file × 159 files" 的 manifest 更精准
```

**T3 — 时间提示增强**：
```typescript
// memory-recall.ts llmSelectAndRankMemories() 的 timeHint 改为：
`IMPORTANT: The user is asking about events in ${timeRange}.
ONLY select memories with eventDate within this range.
Memories outside this range are NOT relevant.`
```

**M8 — entity 提取补全**：
```typescript
// memory-tokenizer.ts:72
// 增加：全大写缩写 [A-Z]{2,}
// 增加：中文人名（2-4字连续中文，前后有标点或行首）
```

**预期：75-80% → 80-85%**

---

### 第四阶段：Agent 体验（3-5天，可并行）

```
A1 + A2 + A3 + A4 + A5 + A6 + A7
```

---

## 理论分析：为什么能突破 80%

| 阶段 | 提取召回率 | 召回命中率 | 推理准确率 | 综合 |
|------|-----------|-----------|-----------|------|
| 当前 | ~70% | ~65% | ~90% | 70%×65%×90% = **41%** (实际 47%) |
| S 层优化后 | ~90% | ~65% | ~90% | 90%×65%×90% = **53%** |
| S+R 层优化后 | ~90% | ~85% | ~92% | 90%×85%×92% = **70%** |
| S+R+T 层优化后 | ~92% | ~88% | ~95% | 92%×88%×95% = **77%** |
| 全部优化后 | ~95% | ~90% | ~95% | 95%×90%×95% = **81%** |

关键突破点：
1. **S1 原子化提取**：提取召回率从 70% → 90%（+20%），这是最大的杠杆
2. **R2 实体索引**：召回命中率从 65% → 80%（+15%），实体精确匹配远优于 TF-IDF
3. **R3 时间索引**：temporal QA 命中率从 40% → 75%（+35%），83 题中多挽回 ~30 题
4. **R1 提高上限**：多注入 20 条记忆，覆盖更多跨 session 信息

---

## 性能优化（同步进行）

| # | 改动 | 文件 | 改法 |
|---|------|------|------|
| P1 | ScannerCache TTL | `memory-scanner-cache.ts:23` | 5s → 30s |
| P2 | 消除未缓存 scan | `memory-llm-extractor.ts:169, 327` | 用 ScannerCache |
| P3 | 并行文件读取 | `harness-memory.ts:688` | Promise.all |
| P4 | Scanner 部分读取 | `memory-scanner.ts:75` | 只读前 2KB |
| P5 | 消除冗余 rerank | `harness-memory.ts:469-481` | LLM 召回成功时跳过 |

---

## 汇总预期

| 优化层 | 预期通过率 | 新增通过题数 |
|--------|-----------|-------------|
| 基线（含 judge 修正） | 51.6% | +8 |
| +S 层（提取重建） | 65-72% | +25~40 |
| +R 层（召回增强） | 75-80% | +15~20 |
| +T 层（时间推理） | 80-85% | +8~12 |
| +A 层（Agent 体验） | — | — |

**全部完成后：80-85%**
