| | base | new |
| --- | --- | --- |
| 模型 | opencode-go / minimax-m3.1-flash-free | opencode-go / minimax-m3.1-flash-free |
| 运行次数（历史记录条数） | 6 | 6 |

| 分组 | 用例 | 通过 base | 通过 new | token 中位 base | token 中位 new | 变化 | 单次请求峰值 base | 单次请求峰值 new | LLM 调用 base | LLM 调用 new | 工具调用 base | 工具调用 new | 补读 new | 发送前收紧 new |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 多文件修改 | model-led-three-file-bugfix | 3/3 | 3/3 | 36544 | 44806 | +23% | 7895 | 8153 | 5 | 6 | 11 | 11 | 0 | 0 |
| 多文件修改 | model-led-caller-and-callee | 3/3 | 3/3 | 44190 | 36828 | -17% | 7975 | 7950 | 6 | 5 | 9 | 9 | 0 | 0 |
| 多文件修改 | model-led-rename-eight-files | 3/3 | 3/3 | 111604 | 100883 | -10% | 14836 | 17933 | 10 | 8 | 29 | 32 | 0 | 0 |
| 长调用链调查 | model-led-real-read-chain | 3/3 | 3/3 | 104598 | 72886 | -30% | 9067 | 8858 | 13 | 9 | 19 | 19 | 0 | 0 |
| 长调用链调查 | model-led-deep-chain-large-files | 3/3 | 3/3 | 97370 | 86919 | -11% | 12360 | 12823 | 10 | 7 | 21 | 14 | 0 | 0 |
| 长日志定位 | model-led-real-log-middle-error | 3/3 | 3/3 | 88369 | 72185 | -18% | 16858 | 22216 | 6 | 4 | 8 | 4 | 2 | 0 |
| 长日志定位 | model-led-failing-check-in-long-log | 2/3 | 2/3 | 194058 | 174022 | -10% | 11404 | 11355 | 19 | 19 | 27 | 24 | 0 | 0 |
| 长任务压缩恢复 | compression-recovery | 3/3 | 3/3 | 62460 | 63288 | +1% | 10307 | 10469 | 8 | 7 | 10 | 9 | 0 | 0 |
| 长任务压缩恢复 | long-task-compaction-recovery | 1/3 | 3/3 | 254542 | 141999 | -44% | 18522 | 14872 | 19 | 13 | 28 | 16 | 0 | 0 |
| **合计** | | 24/27 | 26/27 | 993735 | 793816 | -20% | | | | | | | | |

| 分组 | 通过 base | 通过 new | token 中位之和 base | token 中位之和 new | 变化 |
| --- | --- | --- | --- | --- | --- |
| 多文件修改 | 9/9 | 9/9 | 192338 | 182517 | -5% |
| 长调用链调查 | 6/6 | 6/6 | 201968 | 159805 | -21% |
| 长日志定位 | 5/6 | 5/6 | 282427 | 246207 | -13% |
| 长任务压缩恢复 | 4/6 | 6/6 | 317002 | 205287 | -35% |

失败原因（每次失败取前两条）：

- base model-led-failing-check-in-long-log: expected completionStatus=completed, got interrupted
- new model-led-failing-check-in-long-log: expected completionStatus=completed, got paused
- base long-task-compaction-recovery: expected completionStatus=completed, got interrupted
- base long-task-compaction-recovery: expected completionStatus=completed, got interrupted
