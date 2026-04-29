# LoCoMo 评测框架 — iceCoder 记忆系统

基于 [LoCoMo (EMNLP 2024)](https://arxiv.org/abs/2402.17753) 基准的 iceCoder 记忆系统自动化评测工具。

## 评测维度

| 维度 | 说明 | 样本数 |
|------|------|:------:|
| **单跳检索** (single_hop) | 单一事实的记忆召回 | 3 |
| **多跳关联** (multi_hop) | 跨轮次多实体关联 | 3 |
| **过期过滤** (expired_filter) | 识别并过滤已过期信息 | 3 |

## 环境要求

- Python 3.10+
- iceCoder 服务运行中（默认 `http://127.0.0.1:3000`）

## 安装依赖

```bash
pip install requests tqdm websocket-client
```

> `websocket-client` 为可选依赖。如未安装，脚本会自动回退到 CLI 模式调用 iceCoder。

## 运行评测

### 1. 启动 iceCoder 服务

```bash
# 在项目根目录
npm run dev:api
# 或
npx tsx src/cli/index.ts start
```

### 2. 运行评测脚本

```bash
cd LoCoMo
python run_eval.py
```

可选参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--host` | `127.0.0.1` | iceCoder 服务地址 |
| `--port` | `3000` | iceCoder 服务端口 |
| `--dataset` | `dataset.jsonl` | 数据集路径 |
| `--output` | `result.json` | 结果输出路径 |
| `--extract-wait` | `5` | 记忆提取等待秒数 |
| `--skip-health-check` | - | 跳过服务健康检查 |

### 3. 生成报告

```bash
python generate_report.py
```

可选参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--input` | `result.json` | 评测结果路径 |
| `--output` | `report.md` | 报告输出路径 |

## 文件结构

```
LoCoMo/
├── README.md              # 本文件
├── dataset.jsonl           # 评测数据集（10 条样本）
├── run_eval.py             # 核心评测脚本
├── generate_report.py      # 报告生成器
├── result.json             # 评测结果（运行后生成）
├── report.md               # Markdown 报告（运行后生成）
└── eval.log                # 运行日志（运行后生成）
```

## 评测流程

```
dataset.jsonl
     │
     ▼
┌─────────────┐
│  run_eval.py │
│              │
│  1. 清空会话  │──── WebSocket: clear_session
│  2. 发送对话  │──── WebSocket: message
│  3. 等待提取  │──── sleep(5s)
│  4. 收集记忆  │──── HTTP: GET /api/memory/files
│  5. 查询验证  │──── WebSocket: query message
│  6. 评分判定  │──── keyword matching
│              │
└──────┬──────┘
       │
       ▼
  result.json
       │
       ▼
┌──────────────────┐
│ generate_report.py│
└──────┬───────────┘
       │
       ▼
   report.md
```

## 评测指标

- **Recall@5**: 单跳 + 多跳样本中，关键信息被成功召回的比例
- **多跳准确率**: 需要关联多个信息片段的样本通过率
- **过期过滤准确率**: 正确识别信息更新、返回最新状态的样本通过率

## 自定义数据集

在 `dataset.jsonl` 中添加新样本，格式：

```json
{
  "id": "locomo-N",
  "sessions": [{
    "turns": [
      {"role": "user", "content": "...", "trigger_extract": true},
      {"role": "assistant", "content": "..."}
    ]
  }],
  "query": "查询问题",
  "answer": "期望答案关键词",
  "metric": "single_hop | multi_hop | expired_filter"
}
```

对于 `expired_filter` 类型，额外字段：
- `answer_valid`: 当前有效的答案
- `expired_info`: 已过期的信息文本

## 注意事项

1. 评测会向 iceCoder 发送真实对话，会产生 LLM API 调用费用
2. 每个样本之间会清空会话，但记忆文件不会被清除（模拟真实使用场景）
3. 建议在干净的记忆状态下运行评测（可先手动清空 `data/memory-files/` 目录）
4. 记忆提取是异步的，`--extract-wait` 参数可调整等待时间
