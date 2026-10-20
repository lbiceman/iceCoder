| | base | new |
| --- | --- | --- |
| 模型 | unknown | unknown |
| 运行次数（历史记录条数） | 3 | 3 |

| 分组 | 用例 | 通过 base | 通过 new | token 中位 base | token 中位 new | 变化 | 单次请求峰值 base | 单次请求峰值 new | LLM 调用 base | LLM 调用 new | 工具调用 base | 工具调用 new | 补读 new | 发送前收紧 new |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | compression-recovery | 3/3 | 3/3 | 42368 | 62857 | +48% | 0 | 0 | 5 | 7 | 7 | 9 | 0 | 0 |
| all | model-led-real-incremental-functions | 3/3 | 3/3 | 164397 | 143660 | -13% | 0 | 0 | 16 | 14 | 17 | 15 | 0 | 0 |
| all | model-led-real-read-chain | 3/3 | 3/3 | 140169 | 36680 | -74% | 0 | 0 | 16 | 5 | 26 | 12 | 0 | 0 |
| all | model-led-real-large-theme-file | 3/3 | 3/3 | 53971 | 52757 | -2% | 0 | 0 | 7 | 7 | 11 | 9 | 0 | 0 |
| all | model-led-real-log-middle-error | 3/3 | 3/3 | 70093 | 72128 | +3% | 0 | 0 | 5 | 4 | 7 | 5 | 1 | 0 |
| **合计** | | 15/15 | 15/15 | 470998 | 368082 | -22% | | | | | | | | |
