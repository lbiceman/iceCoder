# 缓存命中率测试用提示词集

> 目的：模拟 iceCoder 多轮工具调用型 Agent 真实工作流，对比改造前/后 DeepSeek 前缀缓存命中率。
> 用法：每条提示词当作一次 `user` 消息依次发到同一会话，每条之间至少 1 次 `assistant + tool_call + tool` 回合。
> 推荐模型：**DeepSeek-V4-Flash**（实测归档见 §8）、DeepSeek-V3 / DeepSeek-V3.1（自动前缀缓存、usage 报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）。
> 日志观察点：每轮响应 `usage` 的 hit / miss，以及 harness 自己的 `cache_hit/miss=…/…` 日志。
>
> 复现脚本（可选）：`scripts/bench-cache-hit.mjs`（见文末骨架）

---

## 0. 测试基线要求

跑这套提示词前，确保会话处于**单条 user 消息 + 多轮工具调用**形态：

- 模型：**`deepseek-v4-flash`**（归档实测用；亦可用 `deepseek-chat` / V3.1 非 thinking 模式，避免 CoT 干扰前缀字节）
- temperature: 0（保证同输入下多轮采样稳定，便于复现）
- stream: 关闭或开启均可，但会话内**保持一致**（流式 / 非流式字节会变化，会被分到不同缓存段）
- 工具集：固定不变（这一项目的 `tool-offering` 已按 name 排序）
- 同一会话内：不允许手工清空 history、不允许 fork 分支
- 每条 user 提示之间**不要**做 `applyToolResultBudget` 之类的就地修改（改造后已无此操作）

---

## 1. 真实工具调用链（推荐主测）

> 模拟 agent 完成一个真实改动：建文件 → 写代码 → 跑测试 → 读结果 → 修代码 → 再跑。
> 这正是 harness 跑业务最常见的前缀稳定场景。

```text
P1.1  在项目根新建 src/utils/stringify.ts，写一个 safeStringify(v: unknown, indent=2): string
      内部用 JSON.stringify，对循环引用走 WeakSet 缓存、抛 TypeError 前先 console.warn 一行。
      写完直接告诉我文件路径。
P1.2  跑 `node --check src/utils/stringify.ts`，把输出贴给我；不通过就修到通过为止。
P1.3  在 test/utils/stringify.test.ts 写 4 个 vitest 用例：
      - 普通对象
      - 嵌套对象
      - 循环引用（断言抛 TypeError）
      - BigInt（断言抛 TypeError 或返回 'null'，任选其一，在注释说明）
P1.4  跑 `npx vitest run test/utils/stringify.test.ts`，把全部断言数量告诉我。
P1.5  把 src/utils/stringify.ts 的循环引用处理函数抽成 named export，名字叫 `detectCycle`，
      并在 test/utils/ 下加一个 detectCycle.test.ts，至少 3 个用例。
P1.6  再跑一次 vitest，全部输出贴给我。
P1.7  改 safeStringify 默认 indent 为 0，保留 2 作为可选参数；不要改函数签名。
P1.8  跑 vitest，看新行为。
P1.9  在 README.md 加一个"工具方法"小节，把 safeStringify 写进去。
P1.10 最后跑一次 `npx tsc --noEmit`，告诉我 0 报错。
```

> 这 10 条加起来大约 20～30 轮 LLM 调用，**正是方案里"15～30 次/任务"的典型值**。

---

## 2. 长前缀压测（验证 64 token 单元对齐）

> 制造一个超长 system + 大量 tool 定义的前缀，然后用完全相同的 user 反复问，
> 看 hit 比例是否能逼近 100%。

```text
P2.1  读 src/harness/index.ts 的全文并给我一个 200 字摘要。
P2.2  列出 src/harness/ 下所有以 'harness-' 开头的 .ts 文件，给出每个的导出符号清单。
P2.3  给我 3 个 src/tools/ 下工具函数的简单调用例子。
P2.4  解释 src/harness/context-assembler.ts 的 prompt caching 三原则。
P2.5  解释 src/harness/harness-api-messages.ts 中 buildMessagesForLlm 的封存与易变块分离。
```

> 这 5 条前缀几乎**完全一致**，区别只在最末尾 user 内容，命中率应非常高（>90%）。

---

## 3. 缓存分段破坏点（验证行为正确性）

> 故意触发方案里 3.2 节列出的"破坏只追加日志"行为，观察命中率下降与 `cache-segment reset` 日志。

### 3.1 工具结果超长

```text
P3.1  读 src/llm/openai-adapter.ts 第 1~200 行，**原样**用 apply_patch 把这一段贴回去写到一个
      临时文件 /tmp/openai-adapter.head.ts。
P3.2  cat /tmp/openai-adapter.head.ts | head -c 200000，输出给我（>TOOL_RESULT_BUDGET_PER_MESSAGE 即可）。
P3.3  继续读 src/llm/openai-adapter.ts 第 201~400 行，同样贴回 /tmp/openai-adapter.head.ts 末尾。
P3.4  再 cat 一次，确认内容。
P3.5  删除 /tmp/openai-adapter.head.ts。
```

> 观察：第 3.2 / 3.4 之后 `applyToolResultBudget` 的旧版会原地改 content → 缓存分段重置；
> 改造后应只在 `apiSealedContent` 上写一次、之后字节稳定。

### 3.2 任务切换（task switch injection）

```text
P3.6  上一题完全无关，现在：把 src/utils/stringify.ts 删掉。
P3.7  把 src/utils/stringify.ts 重新写一遍。
P3.8  再跑 vitest。
```

> 观察：`taskSwitchInjected` 触发时向主历史 **一次性** `msgs.push` 固定文案（§5 阶段 2 有意保留，每会话最多一条）；
> 写入后字节不再变化，后续轮次前缀仍可命中。改造前若每轮 upsert 同类提示才会破坏对齐。

### 3.3 主动收缩 / micro / hard compact

```text
P3.9  把 P1.1 ~ P1.10 的 safeStringify 流程再做一遍，**但每次跑 vitest 后把 stdout 完整粘回来**。
P3.10 等到 `npx tsc --noEmit` 报 0 错为止；中间允许失败。
```

> 观察：命中数应在某次 compact 后明显跳变；harness 应输出
> `[cache-segment] reset round=N reason=proactive-fork|micro-compact|hard-compact`。
> 三种 reason 各触发一次为佳。

---

## 4. 易变块顺序稳定性

> 验证 ephemeral 块字节级一致 → 命中。
> 这两条 user 提示之间**不要**让 lockRoot / referenceReads 变化。

```text
P4.1  列出当前 lockRoot 下的所有 .ts 文件数量。
P4.2  列出其中 size > 10KB 的 .ts 文件名。
P4.3  随便挑一个 .ts，给出前 5 行 + 后 5 行。
P4.4  再挑一个，给出 export 列表。
P4.5  跑 `git status --short`，把输出给我。
```

> 观察：5 条 prompt 末尾的 `[Workspace Anchor]` + `[System Runtime State]` 块应**字节一致**，
> 模型侧应能复用一个长期缓存段。

---

## 5. 反向对照（同一会话改回旧实现再跑一次）

把分支切回主分支 `main`（或旧 commit），关闭 `sealToolResultsForApi` 调用点，
回退到 `applyToolResultBudget` 直接改 content 的版本，**完全跑同样 1.1~1.10**：

```bash
# 改造前
git checkout main
# 跑 P1.1 ~ P1.10，记录每轮 usage.hit / miss
# 改造后
git checkout feat-lb-cache
# 跑 P1.1 ~ P1.10，再记录一遍
```

对比指标：

| 指标 | 改造前（main，待补） | 改造后（feat-lb-cache，实测） | 目标 |
|------|----------------------|------------------------------|------|
| 总 hit tokens | — | 4,118,144（第 3 次） | +40% 以上 |
| hit / (hit+miss) | 30~50% | **84.25%**（稳态 ~83.9%） | 70~90% |
| `cache-segment reset` 次数 | 0 (无观测) | 1~3 | 计数即可 |
| 单次任务总成本 | — | **¥1.01**（V4-Flash，第 3 次） | 显著低于全未命中 |

> 改造后实测明细见 **§8**；改造前对照可在 `main` 分支按同样提示词补跑后填入上表。

---

## 6. 一键跑测脚本骨架（可选）

```ts
// scripts/bench-cache-hit.mjs
// 1. 用 deepseek SDK 起一个 client，固定 baseURL / model / temperature=0 / stream=false
// 2. 起一个空 messages: [{ role: 'system', content: <static system prompt 来自 ContextAssembler> }]
// 3. 加载真实 tool 定义（按 name 排序）
// 4. 按 P1.1 ~ P1.10 顺序发 user 消息
//    每轮：等 assistant → 调本地 stub 工具 → 回 tool result → 下一轮 user
// 5. 每轮打印 usage.{prompt_cache_hit_tokens, prompt_cache_miss_tokens}
// 6. 跑完打汇总：
//    total_hit, total_miss, hit_ratio = hit / (hit + miss)
//    cost_miss = miss * 0.14 / 1e6   （按 deepseek 当时价改）
//    cost_hit  = hit  * 0.0028 / 1e6
//    saving_vs_all_miss = 1 - (cost_hit + cost_miss) / (total * 0.14 / 1e6)
```

---

## 7. 常见干扰项（务必规避）

| 干扰 | 现象 | 规避 |
|------|------|------|
| `reasoning_content` 写入 assistant 并回传 | 字节每轮都变 → 命中率归零 | 本项目已改：不写主历史、不回传 |
| `cache-segment reset` 之间穿插 micro-compact | 旧前缀清零 | 用 `logCacheSegmentReset` 日志观察 |
| 工具定义顺序变化 | 工具列表前缀变 → 缓存分段重置 | `tool-offering` 已按 name 排序，**别动** |
| 流式 / 非流式混用 | 同一前缀分两段 | 一个会话内统一 |
| `applyToolResultBudget` 残留调用 | 主历史 content 被改 → 旧前缀失效 | 已 grep 确认无残留调用点（见审计） |
| 主历史里出现 `[Workspace Anchor]` / `[System Runtime State]` | 前缀污染 | 已改 ephemeral；测试用 grep 守门 |

---

## 8. 实测归档（2026-06-08，`feat-lb-cache`，DeepSeek-V4-Flash）

**提示词：** 本文 §1～§4 组合压测（P1 工具链 + §3 破坏点 + §4 易变块稳定性）。  
**模型：** `deepseek-v4-flash`。  
**账单：** DeepSeek 控制台实付 **¥1.01**（第 3 次运行，2026-06-08）。

### 8.1 三次独立运行

| 指标 | 第 1 次 | 第 2 次 | 第 3 次（最新） | 2→3 变化 |
|------|---------|---------|----------------|----------|
| 总 Tokens | 3,993,674 | 4,380,827 | 4,966,980 | +13.38% |
| 输入（命中缓存） | 3,298,432 | 3,608,064 | 4,118,144 | +14.14% |
| 输入（未命中缓存） | 639,682 | 705,749 | 769,610 | +9.05% |
| 输出 | 55,560 | 67,014 | 79,226 | +18.22% |
| 总输入 | 3,938,114 | 4,313,813 | 4,887,754 | +13.31% |
| **命中率** | **83.76%** | **83.64%** | **84.25%** | **+0.61 pp** |

### 8.2 第 3 次 token 构成

| 项 | 数值 | 占比 |
|----|------|------|
| 输入（命中缓存） | 4,118,144 | 84.25% |
| 输入（未命中缓存） | 769,610 | 15.75% |
| 输出 | 79,226 | — |
| 总输入 | 4,887,754 | 100% |
| **命中率** = 命中 / (命中+未命中) | 4,118,144 / 4,887,754 | **84.25%** |

### 8.3 结论

- **稳态命中率 ~83.9%**（n=3，极差 0.61 pp），落在 `Prompt-Caching-优化方案.md` §10.3 中等任务预测 **75%～85%** 上沿。
- 总量扩大 ~13% 时未命中占比保持 ~15.8%，封存 + ephemeral 分离对负载增长不敏感。
- **实付 ¥1.01** 可作为 OKR / 上线报告的单次压测成本锚点；详细方案级解读见 `Prompt-Caching-优化方案.md` §10.5.1。
