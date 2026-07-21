# iceCoder LoCoMo 60test 评测结果摘要

> 完整文档（测试过程、环境、数据集设计）：[`60test.md`](./60test.md)

> 生成时间: 2026-07-20T18:08:54.485037
> 评测服务器: 127.0.0.1:1024
> 总耗时: 512.5s | Judge 阈值: 0.6
> 数据集: `D:\work\self\iceCoder\LoCoMo\locomo60test.json`

---

## 一、总体指标

| 指标 | 值 |
|------|-----|
| 总题数 | 20 |
| 通过 | 17 |
| 失败 | 3 |
| **总体准确率** | **85.0%** |

| 样本 ID | 题数 | 通过 | 准确率 |
|---------|:----:|:----:|:------:|
| `60test-cap55` | 20 | 17 | **85.0%** |

### 耗时分解

| 阶段 | 耗时 | 备注 |
|------|------|------|
| 记忆注入 | 336.0s | 60 个记忆文件 |
| QA 问答 | 175.2s | 20 道题 |

## 二、分类得分

| Cat | 题型 | 题数 | 通过 | 准确率 | 均分 |
|:---:|------|:----:|:----:|:------:|:----:|
| 1 | Single-hop QA | 4 | 4 | **100.0%** | 0.975 |
| 2 | Multi-hop QA | 8 | 6 | **75.0%** | 0.756 |
| 3 | Open-ended QA | 4 | 3 | **75.0%** | 0.762 |
| 4 | Temporal QA | 2 | 2 | **100.0%** | 0.975 |
| 5 | Adversarial QA | 2 | 2 | **100.0%** | 1.000 |

## 三、错题详情

### Q7 · Open-ended QA

- **问题**: What pets wouldn't cause any discomfort to Joanna?
- **标准答案**: Hairless cats or pigs,since they don't have fur, which is one of the main causes of Joanna's allergy.
- **模型回答**: 根据记忆中关于Joanna的信息，她对大多数爬行动物和有毛皮的动物过敏，接触这些动物时会出现脸部肿胀和发痒的症状。

**不会引起Joanna不适的宠物：**

- **鱼类** — 无毛皮，非爬行动物，可以安全饲养
- **鸟类** — 无毛皮，非爬行动物（记忆中未提及对羽毛过敏）

来源：`locomo_60test-cap55_s5_03_60test-cap55_session_5_memory_45.md`
- **Judge 评分**: 0.1 (incorrect)
- **判定理由**: The model's response lists fish and birds as safe pets, while the expected answer specifies hairless cats or pigs, which are not mentioned in the model's response.

### Q17 · Multi-hop QA

- **问题**: Which hobby did Sam take up in May 2023?
- **标准答案**: painting
- **模型回答**: Based on the memories, Sam had **not yet taken up** a hobby in May 2023. During a conversation on 2023-05-18, Sam said they "have not yet found other hobbies for themselves" and were merely **keen to try** a new activity (painting/watercolor inspired by Evan). Sam was considering it but hadn't committed — Evan advised Sam to "keep trying new things until something sparks their excitement," and Sam promised to keep Evan posted.
- **Judge 评分**: 0.05 (incorrect)
- **判定理由**: The model explicitly states Sam had not taken up a hobby in May 2023, contradicting the expected answer that Sam took up painting.

### Q19 · Multi-hop QA

- **问题**: When did Calvin first travel to Tokyo?
- **标准答案**: between 26 March and 20 April 2023
- **模型回答**: Based on the memories, Calvin traveled to Tokyo in **April 2023** to attend a music festival, where he met talented artists and industry people. However, the memories do not explicitly confirm this was his *first* trip to Tokyo — it's the only Tokyo trip recorded.
- **Judge 评分**: 0.1 (incorrect)
- **判定理由**: The model's response only mentions April 2023, while the expected answer specifies a date range from 26 March to 20 April 2023, which is not semantically equivalent.

## 四、全量 QA 明细

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
| 10 | 4 | ✓ | 0.95 | What did Anthony and John end up playing during the chari... |
| 11 | 2 | ✓ | 1.00 | Which year did Audrey adopt the first three of her dogs? |
| 12 | 5 | ✓ | 1.00 | Which specific type of bird mesmerizes Audrey? |
| 13 | 1 | ✓ | 1.00 | How many charity tournaments has John organized till date? |
| 14 | 1 | ✓ | 1.00 | What games has John played with his friends at charity to... |
| 15 | 2 | ✓ | 0.95 | What kind of project was Jolene working on in the beginni... |
| 16 | 2 | ✓ | 1.00 | When did Jolene`s mother pass away? |
| 17 | 2 | ✗ | 0.05 | Which hobby did Sam take up in May 2023? |
| 18 | 5 | ✓ | 1.00 | What type of car did Sam get after his old Prius broke down? |
| 19 | 2 | ✗ | 0.10 | When did Calvin first travel to Tokyo? |
| 20 | 3 | ✓ | 1.00 | Which country do Calvin and Dave want to meet in? |

---

*本摘要由 `generate_report.py` 从 `result_60test.json` 自动生成；设计说明见 [`60test.md`](./60test.md)*
