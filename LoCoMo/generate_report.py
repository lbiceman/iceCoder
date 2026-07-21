# -*- coding: utf-8 -*-
"""
LoCoMo Evaluation Report Generator for iceCoder.

Reads result.json and generates a Markdown report with metrics tables,
analysis, and per-sample details.

Usage:
    python generate_report.py [--input RESULT_JSON] [--output REPORT_MD]
"""

import json
import argparse
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()


def load_results(input_path: Path) -> dict:
    """Load evaluation results from JSON file."""
    if not input_path.exists():
        print(f"ERROR: Result file not found: {input_path}")
        print("Run the evaluation first: python run_eval.py")
        sys.exit(1)

    with open(input_path, "r", encoding="utf-8") as f:
        return json.load(f)


CATEGORY_NAMES = {
    1: "Single-hop QA",
    2: "Multi-hop QA",
    3: "Open-ended QA",
    4: "Temporal QA",
    5: "Adversarial QA",
}


def generate_official_report(data: dict) -> str:
    """Generate Markdown report from run_locomo_official.py results."""
    summary = data.get("summary", {})
    metadata = data.get("metadata", {})
    by_category = data.get("by_category", {})
    by_sample = data.get("by_sample", [])
    details = data.get("details", [])

    timestamp = metadata.get("timestamp", datetime.now().isoformat())
    elapsed = metadata.get("elapsed_seconds", 0)
    host = metadata.get("host", "unknown")
    port = metadata.get("port", "unknown")
    dataset = metadata.get("dataset", "N/A")
    threshold = metadata.get("threshold", 0.6)

    lines = []
    lines.append("# iceCoder LoCoMo 60test 评测结果摘要")
    lines.append("")
    lines.append("> 完整文档（测试过程、环境、数据集设计）：[`60test.md`](./60test.md)")
    lines.append("")
    lines.append(f"> 生成时间: {timestamp}")
    lines.append(f"> 评测服务器: {host}:{port}")
    lines.append(f"> 总耗时: {elapsed}s | Judge 阈值: {threshold}")
    lines.append(f"> 数据集: `{dataset}`")
    lines.append("")
    lines.append("---")
    lines.append("")

    lines.append("## 一、总体指标")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("|------|-----|")
    lines.append(f"| 总题数 | {summary.get('total_questions', 0)} |")
    lines.append(f"| 通过 | {summary.get('passed', 0)} |")
    lines.append(f"| 失败 | {summary.get('failed', 0)} |")
    lines.append(f"| **总体准确率** | **{summary.get('overall_accuracy', 0)}%** |")
    lines.append("")

    if by_sample:
        ss = by_sample[0]
        lines.append("| 样本 ID | 题数 | 通过 | 准确率 |")
        lines.append("|---------|:----:|:----:|:------:|")
        err = " ⚠" if ss.get("error") else ""
        lines.append(
            f"| `{ss.get('sample_id', 'N/A')}` | {ss.get('total', 0)} | "
            f"{ss.get('passed', 0)} | **{ss.get('accuracy', 0)}%**{err} |"
        )
        lines.append("")

    timing = (details[0].get("timing") if details else None) or {}
    if timing:
        lines.append("### 耗时分解")
        lines.append("")
        lines.append("| 阶段 | 耗时 | 备注 |")
        lines.append("|------|------|------|")
        lines.append(f"| 记忆注入 | {timing.get('inject_seconds', 'N/A')}s | "
                       f"{timing.get('messages_sent', '?')} 个记忆文件 |")
        lines.append(f"| QA 问答 | {timing.get('qa_seconds', 'N/A')}s | "
                       f"{summary.get('total_questions', 0)} 道题 |")
        lines.append("")

    lines.append("## 二、分类得分")
    lines.append("")
    lines.append("| Cat | 题型 | 题数 | 通过 | 准确率 | 均分 |")
    lines.append("|:---:|------|:----:|:----:|:------:|:----:|")
    for cat_id in sorted(by_category, key=lambda x: int(x)):
        c = by_category[cat_id]
        lines.append(
            f"| {cat_id} | {c.get('name', CATEGORY_NAMES.get(int(cat_id), '?'))} | "
            f"{c.get('total', 0)} | {c.get('passed', 0)} | "
            f"**{c.get('accuracy', 0)}%** | {c.get('avg_score', 0):.3f} |"
        )
    lines.append("")

    failed_qa: list[dict] = []
    for block in details:
        for qa in block.get("qa_results", []):
            if not qa.get("passed", False):
                failed_qa.append(qa)

    lines.append("## 三、错题详情")
    lines.append("")
    if not failed_qa:
        lines.append("*全部通过，无错题。*")
    else:
        for qa in failed_qa:
            cat = qa.get("category", "?")
            cat_name = CATEGORY_NAMES.get(cat, f"Cat {cat}")
            idx = qa.get("index", "?")
            lines.append(f"### Q{idx + 1 if isinstance(idx, int) else idx} · {cat_name}")
            lines.append("")
            lines.append(f"- **问题**: {qa.get('question', 'N/A')}")
            lines.append(f"- **标准答案**: {qa.get('answer', 'N/A')}")
            lines.append(f"- **模型回答**: {qa.get('response', 'N/A')[:500]}")
            lines.append(f"- **Judge 评分**: {qa.get('score', 0)} ({qa.get('judge_verdict', '?')})")
            if qa.get("reason"):
                lines.append(f"- **判定理由**: {qa.get('reason')}")
            lines.append("")

    lines.append("## 四、全量 QA 明细")
    lines.append("")
    lines.append("| # | Cat | 结果 | 分数 | 问题 |")
    lines.append("|:-:|-----|:----:|:----:|------|")
    for block in details:
        for qa in block.get("qa_results", []):
            idx = qa.get("index", 0)
            cat = qa.get("category", "?")
            ok = "✓" if qa.get("passed") else "✗"
            q = qa.get("question", "").replace("|", "\\|")
            if len(q) > 60:
                q = q[:57] + "..."
            lines.append(f"| {idx + 1 if isinstance(idx, int) else idx} | {cat} | {ok} | "
                         f"{qa.get('score', 0):.2f} | {q} |")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("*本摘要由 `generate_report.py` 从 `result_60test.json` 自动生成；设计说明见 [`60test.md`](./60test.md)*")
    lines.append("")
    return "\n".join(lines)


def generate_report(data: dict) -> str:
    """Generate Markdown report from evaluation results."""
    if "by_category" in data:
        return generate_official_report(data)

    summary = data.get("summary", {})
    metadata = data.get("metadata", {})
    breakdown = data.get("breakdown", {})
    details = data.get("details", [])

    timestamp = metadata.get("timestamp", datetime.now().isoformat())
    elapsed = metadata.get("elapsed_seconds", 0)
    host = metadata.get("host", "unknown")
    port = metadata.get("port", "unknown")

    lines = []

    # Header
    lines.append("# iceCoder LoCoMo 评测报告")
    lines.append("")
    lines.append(f"> 生成时间: {timestamp}")
    lines.append(f"> 评测服务器: {host}:{port}")
    lines.append(f"> 运行耗时: {elapsed}s")
    lines.append(f"> 样本数量: {summary.get('total_samples', 0)}")
    lines.append("")
    lines.append("---")
    lines.append("")

    # Overall metrics table
    lines.append("## 一、总体指标")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("|------|-----|")
    lines.append(f"| 总样本数 | {summary.get('total_samples', 0)} |")
    lines.append(f"| 通过数 | {summary.get('passed', 0)} |")
    lines.append(f"| 失败数 | {summary.get('failed', 0)} |")
    lines.append(f"| 错误数 | {summary.get('errors', 0)} |")
    lines.append(f"| 总体准确率 | **{summary.get('overall_accuracy', 0)}%** |")
    lines.append(f"| Recall@5 | **{data.get('recall_at_5', 0)}%** |")
    lines.append(f"| 多跳准确率 | **{data.get('multi_hop_accuracy', 0)}%** |")
    lines.append(f"| 过期过滤准确率 | **{data.get('expired_filter_accuracy', 0)}%** |")
    lines.append("")

    # Per-metric breakdown
    lines.append("## 二、分项指标")
    lines.append("")
    lines.append("| 题型 | 样本数 | 通过 | 失败 | 准确率 |")
    lines.append("|------|:------:|:----:|:----:|:------:|")

    metric_labels = {
        "single_hop": "单跳检索",
        "multi_hop": "多跳关联",
        "expired_filter": "过期过滤",
    }

    for metric_key in ["single_hop", "multi_hop", "expired_filter"]:
        if metric_key in breakdown:
            b = breakdown[metric_key]
            label = metric_labels.get(metric_key, metric_key)
            lines.append(
                f"| {label} | {b['total']} | {b['passed']} | "
                f"{b['failed']} | **{b['accuracy']}%** |"
            )

    lines.append("")

    # Analysis
    lines.append("## 三、简要分析")
    lines.append("")

    overall_acc = summary.get("overall_accuracy", 0)
    recall_5 = data.get("recall_at_5", 0)
    mh_acc = data.get("multi_hop_accuracy", 0)
    exp_acc = data.get("expired_filter_accuracy", 0)

    if overall_acc >= 80:
        lines.append("- **总体表现优秀**：记忆系统在大部分场景下能正确召回和过滤信息。")
    elif overall_acc >= 60:
        lines.append("- **总体表现良好**：记忆系统基本可用，但部分场景存在召回不足或过滤不准确的问题。")
    else:
        lines.append("- **总体表现待改进**：记忆系统在多个维度存在明显不足，需要针对性优化。")

    if recall_5 >= 80:
        lines.append("- **Recall@5 表现强**：关键信息的召回率较高，记忆提取和索引机制有效。")
    elif recall_5 >= 50:
        lines.append("- **Recall@5 中等**：部分关键信息未能被有效召回，建议优化记忆提取的触发条件和关键词索引。")
    else:
        lines.append("- **Recall@5 偏低**：大量关键信息未被召回，记忆提取或索引机制可能存在根本性问题。")

    if mh_acc >= 80:
        lines.append("- **多跳关联能力强**：能有效关联分散在不同对话轮次中的信息片段。")
    elif mh_acc >= 50:
        lines.append("- **多跳关联中等**：部分跨轮次信息关联失败，建议增强关系提取和关联扩展机制。")
    else:
        lines.append("- **多跳关联较弱**：跨轮次信息关联能力不足，需要改进关系图谱或多跳检索策略。")

    if exp_acc >= 80:
        lines.append("- **过期过滤准确**：能正确识别并过滤已过期的信息，返回最新状态。")
    elif exp_acc >= 50:
        lines.append("- **过期过滤部分有效**：部分过期信息未被正确过滤，建议优化时间戳管理和信息更新机制。")
    else:
        lines.append("- **过期过滤不足**：过期信息频繁被错误召回，需要加强信息版本管理和过期标记机制。")

    lines.append("")

    # Failed samples detail
    failed_samples = [d for d in details if not d.get("passed", False)]
    if failed_samples:
        lines.append("## 四、失败样本详情")
        lines.append("")
        for fs_item in failed_samples:
            lines.append(f"### {fs_item['id']} ({metric_labels.get(fs_item['metric'], fs_item['metric'])})")
            lines.append("")
            lines.append(f"- **查询**: {fs_item.get('query', 'N/A')}")
            lines.append(f"- **期望答案**: {fs_item.get('answer', 'N/A')}")
            if fs_item.get("error"):
                lines.append(f"- **错误**: {fs_item['error']}")
            response_preview = fs_item.get("response", "")[:300]
            if response_preview:
                lines.append(f"- **实际回复** (前300字): {response_preview}")
            lines.append("")

    # Runtime info
    lines.append("## 五、运行环境")
    lines.append("")
    lines.append(f"- **评测时间**: {timestamp}")
    lines.append(f"- **服务器地址**: {host}:{port}")
    lines.append(f"- **运行耗时**: {elapsed}s")
    lines.append(f"- **样本数量**: {summary.get('total_samples', 0)}")
    lines.append(f"- **记忆提取等待时间**: {metadata.get('extract_wait', 'N/A')}s")
    lines.append(f"- **数据集路径**: {metadata.get('dataset', 'N/A')}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("*本报告由 LoCoMo 评测框架自动生成*")
    lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate LoCoMo evaluation report")
    parser.add_argument(
        "--input",
        default=str(SCRIPT_DIR / "result.json"),
        help="Path to result.json (default: LoCoMo/result.json)",
    )
    parser.add_argument(
        "--output",
        default=str(SCRIPT_DIR / "report.md"),
        help="Path to output report.md (default: LoCoMo/report.md)",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    print(f"Loading results from: {input_path}")
    data = load_results(input_path)

    print("Generating report...")
    report = generate_report(data)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"Report saved to: {output_path}")

    # Print summary to console
    summary = data.get("summary", {})
    print(f"\nOverall accuracy: {summary.get('overall_accuracy', 0)}%")
    if "by_category" in data:
        print(f"Passed: {summary.get('passed', 0)}/{summary.get('total_questions', 0)}")
        for cat_id in sorted(data.get("by_category", {}), key=lambda x: int(x)):
            c = data["by_category"][cat_id]
            print(f"  Cat {cat_id} ({c.get('name', '?')}): "
                  f"{c.get('passed', 0)}/{c.get('total', 0)} = {c.get('accuracy', 0)}%")
    else:
        print(f"Recall@5: {data.get('recall_at_5', 0)}%")
        print(f"Multi-hop: {data.get('multi_hop_accuracy', 0)}%")
        print(f"Expired filter: {data.get('expired_filter_accuracy', 0)}%")


if __name__ == "__main__":
    main()
