# iceCoder arXiv 短文

## 文件

| 文件 | 说明 |
|------|------|
| `icecoder-runtime-supervisor-short.tex` | 英文短文 LaTeX 源稿（约 5–6 页 PDF） |
| `icecoder-abstract-zh.md` | 中文摘要（投稿附录用） |

## 编译

```bash
cd docs/papers
pdflatex icecoder-runtime-supervisor-short.tex
pdflatex icecoder-runtime-supervisor-short.tex   # 第二次生成引用/目录
```

或使用 `xelatex`（若后续加入中文作者单位）。

## arXiv 投稿建议

1. **Category**：`cs.SE`（主）、`cs.AI`（次）
2. **Title**：*iceCoder: A Selective Dual-Mode Runtime Supervisor for Long-Horizon Tool-Using Coding Agents*
3. **替换匿名**：将 `\author{Anonymous Authors}` 改为真实作者与机构
4. **可选附图**：从 `docs/requirement/双模 L2 流程图-finish.md` 导出 supervision stack 示意图替换 Figure 1 的 fbox
5. **补充材料**：可附 `benchMark/reports/` 与 benchmark rubric 作为 ancillary files

## 声明

当前稿基于仓库 README、PROJECT-GUIDE、双模 V1.3.7 规格与 2026-05-22 benchmark 报告撰写；投稿前请由作者核对数据与引用，并确认许可证（ISC）与第三方商标（Claude Code、Cursor 等）表述符合 arXiv 与机构政策。
