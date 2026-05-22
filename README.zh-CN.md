# iceCoder

**自主编码 Agent 在长任务里容易失控。** 偏离目标、反复调用同一工具、看似收尾实则没交付——这些问题在 20+ 轮工具调用后尤其常见。

**iceCoder 是面向自主编码 Agent 的运行时治理层** — 持续观察 Agent 行为，在出问题时收紧约束，在会话中断后恢复任务状态。

[English README](./README.md) · [项目介绍](./docs/项目介绍.md) · [Project guide](./docs/PROJECT-GUIDE.md)

---

## 为什么重要

多数 Agent 产品优化的是*模型调用*。真实工程任务需要的是能撑过 20+ 轮工具的*运行时*：识别卡住、约束鲁莽行为、在压缩或崩溃后恢复——而不是把任务直接丢掉。

iceCoder 跑在你本地仓库上。同样的工具、同样的模型 — **有治理的执行**。

---

## 工作原理

三个机制，贯穿全流程：

### 1. 漂移检测

每一轮工具调用都会对照任务目标打分。运行时标记：

- **停滞** — 多轮无文件变更、无验证进展
- **工具循环** — 同一失败调用反复重试，或同一文件被反复修改
- **目标漂移** — 工具与输出不再匹配任务意图（例如编辑任务却陷入只读探索）

信号触发纠正动作，而不是放任 Agent 跑到上下文耗尽。

### 2. 自适应 vs 强制执行

两种运行时模式，自动切换：

| 模式 | 行为 |
|------|------|
| **自适应（free）** | Agent 自由探索 — 适合问答、只读排查、低风险小改 |
| **强制（forced）** | 更严的工具门禁、结构化步骤上下文、完成前须验证 |

默认从宽松开始；出现漂移、失败或 checkpoint 恢复时升级到 forced；运行稳定后再降回。

用户侧策略：`off` · `adaptive`（默认） · `strict`。

### 3. Checkpoint 恢复

任务状态、已触达文件、已执行命令、验证结果在会话中持续落盘。上下文压缩、浏览器刷新或进程重启后，运行时**从快照恢复**并继续 — 不只靠聊天记录硬猜。

---

## 与 Agent 产品对比

| | Cursor / Claude Code / Codex 类 | iceCoder |
|---|--------------------------------|----------|
| **漂移处理** | 隐式；用户往往事后才察觉 | 显式信号 → 纠正或模式升级 |
| **控制力** | 产品固定行为 | 可配 `off` / `adaptive` / `strict`；forced 模式 + 工具门禁 |
| **恢复能力** | 依赖会话/聊天历史 | 结构化 checkpoint + 运行时快照恢复 |
| **部署形态** | 托管或 IDE 绑定 | 自托管运行时：CLI、Web、WebSocket、MCP |

iceCoder 不是 IDE 替代品。它是可跑在现有 Agent 栈之下或旁边的**治理层**。

---

## Benchmark

同模型（`minimax-m2.5`）、同任务、同 rubric，与 Claude Code 盲评对比。详情见 [`benchMark/reports/`](./benchMark/reports/)。

- **多文件订单流水线** — 9/9 测试通过；综合分 **86 vs 83**（iceCoder vs CC）
- **Saga + 仓库对账** — 15/15 测试通过；综合分 **88 vs 85**
- 两次运行均通过项目回归门禁（自动化 + 改动范围检查）
- `adaptive` 策略下，高风险任务自动进入 forced，无需人工干预

---

## 快速开始

**环境要求：** Node.js 18+

```bash
git clone <repo-url> && cd iceCoder
npm install
cp data/config.example.json data/config.json   # 填入 LLM 提供者配置
npm run dev                                     # API :1024 · UI :1025
```

```bash
npm test                                        # 1165 用例
npx tsx src/cli/index.ts run "修复失败测试"
npx tsx src/cli/index.ts web --port 3784
```

---

## 文档

| 文档 | 内容 |
|------|------|
| [项目介绍](./docs/项目介绍.md) | 架构、记忆、工具、测试 |
| [Project guide](./docs/PROJECT-GUIDE.md) | English architecture reference |
| [环境变量](./docs/环境变量.md) | 配置参考（[English](./docs/environment-variables.md)） |
| [后续优化计划](./docs/nextWork.md) | 路线图 |

**技术栈：** TypeScript · Node.js · Express · Vite · Vitest

---

## 许可证

ISC
