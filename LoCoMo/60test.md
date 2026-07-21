# iceCoder LoCoMo 60test 评测文档

> 最后更新：2026-07-20  
> 基准：[LoCoMo (EMNLP 2024)](https://arxiv.org/abs/2402.17753)  
> 目标：在 iceCoder **60 文件记忆上限**下，用一次注入覆盖官方 10 条 conv 的精选片段，验证记忆提取、召回与 QA 能力。

---

## 一、评测目标与设计约束

| 约束 | 说明 |
|------|------|
| **记忆文件上限** | 50–60 个（对齐 iceCoder 60 文件设计） |
| **注入次数** | **单次注入**（样本 `60test-cap55`） |
| **对话覆盖** | 官方 10 条 conv 各取 1–2 个 session，共 **12 session** |
| **QA 数量** | **20 道**，覆盖 LoCoMo 官方 5 类题型 |
| **题目特色** | 跨 session 聚合、long-gap、Single-hop、Adversarial 主语错位等 |

### 与全量官方评测的区别

| 项目 | 官方 locomo10 | 60test |
|------|---------------|--------|
| 样本数 | 10 个独立 conv | 1 个合并样本 |
| QA 数 | ~1986 | 20（精选） |
| 记忆文件 | 单 conv 可达 100+ | **bundled 压缩至 60** |
| 用途 | 全量基准 | 快速回归、上限压力测试 |

---

## 二、测试环境与前置条件

### 2.1 运行环境

| 项目 | 配置 |
|------|------|
| 操作系统 | Windows 10 |
| iceCoder 服务 | `http://127.0.0.1:1024` |
| Python | 3.10+（依赖：`requests`、`tqdm`、`websocket-client`） |
| Node.js | `npx tsx src/index.ts` 启动服务 |

### 2.2 必需环境变量

**服务端与客户端均需设置：**

```powershell
$env:ICE_EVAL_MODE="1"
$env:ICE_DISABLE_TOOLS="1"
$env:ICE_OPENAI_REQUEST_TIMEOUT_MS="600000"
```

| 变量 | 值 | 作用 |
|------|-----|------|
| `ICE_EVAL_MODE` | `1` | 评测模式，精简提示词 |
| `ICE_DISABLE_TOOLS` | `1` | 禁用工具调用，避免 QA 走工具链 |
| `ICE_OPENAI_REQUEST_TIMEOUT_MS` | `600000` | LLM 请求超时 10 分钟 |

**评测脚本自动设置（`_run_60test.py`）：**

| 变量 | 值 | 作用 |
|------|-----|------|
| `LOCOMO_TARGET_FILES` | `60` | bundled 注入：12 session × 5 文件 ≈ 60 |
| `LOCOMO_EXTRACT_TIMEOUT` | `600` | 每 session 记忆提取超时（秒） |
| `LOCOMO_QA_TIMEOUT` | `600` | 每道 QA WebSocket 超时（秒） |
| `LOCOMO_JUDGE_TIMEOUT` | `120` | Judge API 超时（秒） |

### 2.3 模型配置

记忆提取、LLM Judge、iceCoder 主模型均读取 `data/config.json`（可通过 `EVAL_MODEL` / `EVAL_API_KEY` / `EVAL_BASE_URL` 覆盖 Judge）。

- **Judge 阈值**：0.6（语义一致即通过）
- **评分方式**：LLM-as-Judge（`evaluator_judge.py`）

---

## 三、数据集构建

### 3.1 构建命令

```powershell
py LoCoMo/build_locomo60test.py --verify
```

输出：

- `LoCoMo/locomo60test.json` — 评测数据（1 样本 + 20 QA）
- `LoCoMo/locomo60test.manifest.json` — 元数据、session 血缘、题目标签

### 3.2 样本结构

- **样本 ID**：`60test-cap55`
- **Session 数**：12（来自 10 条 conv）
- **Bundled 策略**：每 session **5 个记忆文件**，多 fact 合并为单文件（`##` 分段）

### 3.3 10 条 conv 与 20 道 QA 映射

| # | 来源 conv | 主题 | Session | 题型亮点 |
|:-:|-----------|------|:-------:|----------|
| 1 | conv-26 | Caroline & Melanie · LGBTQ + 身份 | 1 | Multi-hop + Single-hop |
| 2 | conv-30 | Jon & Gina · 失业 + 减压偏好 | 1 | Multi-hop + Temporal |
| 3–4 | conv-41 | John & Maria · **跨 session 军事 aptitude** | 3, 8 | Cross-session Single-hop + Open-ended |
| 5 | conv-42 | Joanna & Nate · 过敏宠物 + 剧本 | 2 | Open-ended + Multi-hop |
| 6 | conv-43 | Tim & John · 慈善赛 + HP | 4 | Open-ended + Temporal |
| 7 | conv-44 | Audrey & Andrew · 宠物年表 + **Adversarial** | 1 | Multi-hop + Adversarial（主语错位） |
| 8–9 | conv-47 | James & John · **long-gap 慈善统计** | 10, 29 | Cross-session Single-hop ×2 |
| 10 | conv-48 | Deborah & Jolene · 工程 + 丧亲 | 1 | Multi-hop ×2 |
| 11 | conv-49 | Evan & Sam · 爱好 + **Adversarial** | 1 | Multi-hop + Adversarial（张冠李戴） |
| 12 | conv-50 | Calvin & Dave · 东京首访 + 见面国 | 3 | Multi-hop + Open-ended |

### 3.4 题型分布（manifest highlights）

| 维度 | 数量 |
|------|:----:|
| Single-hop QA | 4 |
| Multi-hop QA | 8 |
| Open-ended QA | 4 |
| Temporal QA | 2 |
| Adversarial QA | 2 |
| 跨 session QA | 4 |
| Long-gap conv | conv-47（session 10 → 29） |

---

## 四、评测流程

### 4.1 启动与运行

```powershell
# 终端 1：启动 iceCoder
$env:ICE_EVAL_MODE="1"
$env:ICE_DISABLE_TOOLS="1"
$env:ICE_OPENAI_REQUEST_TIMEOUT_MS="600000"
npx tsx src/index.ts

# 终端 2：运行 60test
py LoCoMo/_run_60test.py
```

### 4.2 流水线（`run_locomo_official.py`）

```
locomo60test.json
        │
        ▼
┌─────────────────────────────────────────────┐
│  Step 1: 清空会话 + 记忆文件                 │
│    · WebSocket clear_session（stop + 清 UI） │
│    · HTTP 删除 data/memory-files/ 下旧文件   │
├─────────────────────────────────────────────┤
│  Step 2: 记忆注入（bundled）                 │
│    · 12 session 逐条 LLM 提取 fact           │
│    · 143 fact → 60 bundled 文件（5/session） │
│    · 写入 data/memory-files/ + MEMORY.md     │
├─────────────────────────────────────────────┤
│  Step 3: QA 评测（20 题）                    │
│    · 每题前 clear_session（隔离对话历史）      │
│    · WebSocket 发题 → iceCoder 记忆召回+回答  │
│    · 后台线程池并行 LLM Judge 打分            │
└─────────────────────────────────────────────┘
        │
        ▼
  result_60test.json
        │
        ▼
  generate_report.py → report_60test.md（结果摘要）
```

### 4.3 Bundled 注入说明

**问题**：atomic 模式（1 fact = 1 文件）下 12 session 约 **140+ 文件**，超出 60 上限。

**方案**：设置 `LOCOMO_TARGET_FILES=60` 后，每 session 固定 **5 个 bundled 文件**，将同 session 多条 fact 合并进单文件，以 `##` 分段保留结构。

实测（2026-07-20）：**143 fact → 60 文件**，每 session 5 文件。

### 4.4 QA 隔离机制

每道题评测前执行 `clear_session`，确保模型**仅依赖记忆召回**，而非累积的对话上下文。WebSocket 需等待 `connected` 后再发题，避免竞态丢消息（已在 `chat-ws.ts` 与服务端脚本中修复）。

### 4.5 关键脚本与产物

| 文件 | 用途 |
|------|------|
| `build_locomo60test.py` | 构建数据集 |
| `_run_60test.py` | 一键启动 60test |
| `run_locomo_official.py` | 注入 + QA + 汇总 |
| `evaluator_judge.py` | 记忆提取 + LLM Judge |
| `generate_report.py` | 从 JSON 生成结果摘要 |
| `result_60test.json` | 结构化评测结果 |
| `report_60test.md` | 自动生成的结果摘要 |

---

## 五、评测结果（2026-07-20）

> 数据来源：`result_60test.json`  
> 评测时间：2026-07-20T18:08:54  
> 总耗时：**512.5s**（注入 336.0s + QA 175.2s）

### 5.1 总体指标

| 指标 | 值 |
|------|-----|
| 总题数 | 20 |
| 通过 | **17** |
| 失败 | 3 |
| **总体准确率** | **85.0%** |
| 记忆文件数 | 60 |
| 平均每题 QA 耗时 | ~8.8s |

### 5.2 分类得分

| Cat | 题型 | 题数 | 通过 | 准确率 | 均分 |
|:---:|------|:----:|:----:|:------:|:----:|
| 1 | Single-hop QA | 4 | 4 | **100.0%** | 0.975 |
| 2 | Multi-hop QA | 8 | 6 | **75.0%** | 0.756 |
| 3 | Open-ended QA | 4 | 3 | **75.0%** | 0.763 |
| 4 | Temporal QA | 2 | 2 | **100.0%** | 0.975 |
| 5 | Adversarial QA | 2 | 2 | **100.0%** | 1.000 |

### 5.3 亮点

- **Single-hop / Temporal / Adversarial 全对**：基础检索、时间推理、对抗陷阱均通过。
- **跨 session 军事 aptitude（conv-41）**：Q5、Q6 均通过。
- **Long-gap 慈善统计（conv-47）**：Q13、Q14 均通过。
- **Adversarial 张冠李戴（conv-49 Q18）**：正确识别 Sam 无换车记录，拒绝 adversarial 答案。

### 5.4 失败题目与根因

#### Q7 · Open-ended — Joanna 不过敏的宠物

| 项 | 内容 |
|----|------|
| 问题 | What pets wouldn't cause any discomfort to Joanna? |
| 标准答案 | Hairless cats or pigs（无毛，避免 fur 过敏） |
| 模型回答 | 鱼类、鸟类 |
| 根因 | 记忆提取/ bundling 未保留「hairless cats / pigs」关键表述；模型从「无毛皮」规则推理出 fish/birds，而非原文特例 |

#### Q17 · Multi-hop — Sam 2023 年 5 月爱好

| 项 | 内容 |
|----|------|
| 问题 | Which hobby did Sam take up in May 2023? |
| 标准答案 | painting |
| 模型回答 | Sam 尚未 take up，仅 keen to try painting |
| 根因 | 记忆写入「考虑尝试」而非「已开始 painting」；后续 session 状态未合并进 bundled 文件 |

#### Q19 · Multi-hop — Calvin 首次东京行

| 项 | 内容 |
|----|------|
| 问题 | When did Calvin first travel to Tokyo? |
| 标准答案 | between 26 March and 20 April 2023 |
| 模型回答 | April 2023（未确认是否首次） |
| 根因 | 记忆仅有月份粒度；Judge 要求精确日期区间，部分匹配被判失败 |

### 5.5 全量 QA 明细

| # | Cat | 结果 | 分数 | 问题 |
|:-:|-----|:----:|:----:|------|
| 1 | 2 | ✓ | 1.00 | When did Caroline go to the LGBTQ support group? |
| 2 | 1 | ✓ | 0.90 | What is Caroline's identity? |
| 3 | 2 | ✓ | 1.00 | When Jon has lost his job as a banker? |
| 4 | 4 | ✓ | 1.00 | How do Jon and Gina both like to destress? |
| 5 | 1 | ✓ | 1.00 | What test has John taken multiple times? |
| 6 | 3 | ✓ | 1.00 | Would John be considered a patriotic person? |
| 7 | 3 | ✗ | 0.10 | What pets wouldn't cause any discomfort to Joanna? |
| 8 | 2 | ✓ | 0.95 | When did Joanna finish her first screenplay? |
| 9 | 3 | ✓ | 0.95 | Who is Anthony? |
| 10 | 4 | ✓ | 0.95 | What did Anthony and John end up playing during the charity event? |
| 11 | 2 | ✓ | 1.00 | Which year did Audrey adopt the first three of her dogs? |
| 12 | 5 | ✓ | 1.00 | Which specific type of bird mesmerizes Audrey? |
| 13 | 1 | ✓ | 1.00 | How many charity tournaments has John organized till date? |
| 14 | 1 | ✓ | 1.00 | What games has John played with his friends at charity tournaments? |
| 15 | 2 | ✓ | 0.95 | What kind of project was Jolene working on in the beginning of January 2023? |
| 16 | 2 | ✓ | 1.00 | When did Jolene`s mother pass away? |
| 17 | 2 | ✗ | 0.05 | Which hobby did Sam take up in May 2023? |
| 18 | 5 | ✓ | 1.00 | What type of car did Sam get after his old Prius broke down? |
| 19 | 2 | ✗ | 0.10 | When did Calvin first travel to Tokyo? |
| 20 | 3 | ✓ | 1.00 | Which country do Calvin and Dave want to meet in? |

---

## 六、已知问题与修复记录

| 问题 | 现象 | 修复 |
|------|------|------|
| 记忆文件超标 | 12 session atomic 注入 ~149 文件 | `LOCOMO_TARGET_FILES=60` bundled 模式 |
| QA 长期 0/20 | `clear_session` 服务端未实现；发题竞态 | `chat-ws.ts` 实现 clear_session；WS 等 connected 再发题 |
| Windows GBK 崩溃 | SUMMARY 进度条 Unicode 字符 | `print_summary` 改用 ASCII `#`/`.` |

---

## 七、后续优化方向

1. **提取 prompt**：保留 identity、例外实体（hairless cats/pigs）、状态变更（took up painting）、精确日期区间。
2. **Bundled 策略**：对 Open-ended / Temporal 关键 fact 避免过度合并丢失细节。
3. **Judge 口径**：对「April 2023」vs 日期区间类答案，可评估是否放宽 partial credit。

---

## 八、重新生成结果摘要

```powershell
# 重跑评测（约 8–9 分钟）
py LoCoMo/_run_60test.py

# 仅从 JSON 刷新结果摘要
py LoCoMo/generate_report.py --input LoCoMo/result_60test.json --output LoCoMo/report_60test.md
```

---

*本文档描述 60test 的设计、环境、流程与 2026-07-20 评测结果；结果摘要由 `generate_report.py` 同步生成至 `report_60test.md`。*
