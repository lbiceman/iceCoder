# -*- coding: utf-8 -*-
"""
Build locomo60test.json — 单次注入，注入完成后记忆文件目标 **50–60 条**。

从全部 10 条官方 conv 精选 **极具特色** 的 QA（跨 session 聚合、long-gap、
Single-hop、Adversarial 等），合并为 **一个** 样本（`60test-cap55`），
一次注入 ≈ 60 个文件，对齐 iceCoder 60 文件设计上限。

Usage:
    py LoCoMo/build_locomo60test.py --verify
"""

from __future__ import annotations

import argparse
import json
import re
from copy import deepcopy
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
SOURCE = SCRIPT_DIR / "locomo10.json"
OUTPUT = SCRIPT_DIR / "locomo60test.json"

MERGED_SAMPLE_ID = "60test-cap55"
TARGET_FILES_MIN = 50
TARGET_FILES_MAX = 60
FILES_PER_SESSION_EST = 5.0

CATEGORY_NAMES = {
    1: "Single-hop QA",
    2: "Multi-hop QA",
    3: "Open-ended QA",
    4: "Temporal QA",
    5: "Adversarial QA",
}

# 10 conv × 12 session ≈ 60 文件
# 2 条跨 session conv（各 2 session）+ 8 条单 session conv（各 1 session）
CURATED_CONV_BLOCKS: list[dict] = [
    {
        "source": "conv-26",
        "theme": "Caroline & Melanie · LGBTQ 标志性 + Single-hop 身份",
        "sessions": [1],
        "cases": [
            {
                "qa_index": 0,
                "tags": ["iconic", "lgbtq", "multi_hop"],
                "note": "Caroline 参加 LGBTQ 支持小组的时间（LoCoMo 标志性题）",
            },
            {
                "qa_index": 4,
                "tags": ["single_hop", "identity"],
                "note": "Caroline 的身份认同（官方 Single-hop）",
            },
        ],
    },
    {
        "source": "conv-30",
        "theme": "Jon & Gina · 失业日期 + Temporal 偏好",
        "sessions": [1],
        "cases": [
            {
                "qa_index": 0,
                "tags": ["career", "multi_hop"],
                "note": "Jon 银行失业时间",
            },
            {
                "qa_index": 2,
                "tags": ["temporal", "preference"],
                "note": "两人共同的减压方式（Temporal 推理）",
            },
        ],
    },
    {
        "source": "conv-41",
        "theme": "John & Maria · 跨 session 军事 aptitude",
        "sessions": [3, 8],
        "cases": [
            {
                "qa_index": 12,
                "tags": ["cross_session", "single_hop", "military_aptitude"],
                "note": "John 多次参加的 aptitude 测试（session 3+8 聚合）",
            },
            {
                "qa_index": 14,
                "tags": ["cross_session", "open_ended", "inference"],
                "note": "John 是否爱国（跨 session 开放式推理）",
            },
        ],
    },
    {
        "source": "conv-42",
        "theme": "Joanna & Nate · 过敏宠物 + 剧本里程碑",
        "sessions": [2],
        "cases": [
            {
                "qa_index": 4,
                "tags": ["open_ended", "allergy"],
                "note": "不会致敏的宠物类型（过敏线）",
            },
            {
                "qa_index": 7,
                "tags": ["multi_hop", "screenplay"],
                "note": "Joanna 完成首个剧本的时间",
            },
        ],
    },
    {
        "source": "conv-43",
        "theme": "Tim & John · 慈善赛 + HP 线索",
        "sessions": [4],
        "cases": [
            {
                "qa_index": 15,
                "tags": ["open_ended", "entity"],
                "note": "Anthony 是谁（人物关系）",
            },
            {
                "qa_index": 85,
                "tags": ["temporal", "harry_potter", "charity"],
                "note": "慈善赛上 Anthony/John 玩了什么（Temporal + HP 线）",
            },
        ],
    },
    {
        "source": "conv-44",
        "theme": "Audrey & Andrew · 宠物年表 + Adversarial 主语错位",
        "sessions": [1],
        "cases": [
            {
                "qa_index": 0,
                "tags": ["multi_hop", "pets"],
                "note": "Audrey 收养前三只狗的年份",
            },
            {
                "qa_index": 123,
                "tags": ["adversarial", "wrong_subject"],
                "note": "Audrey 迷住的鸟种（主语错位陷阱）",
            },
        ],
    },
    {
        "source": "conv-47",
        "theme": "James & John · long-gap 慈善赛统计",
        "sessions": [10, 29],
        "cases": [
            {
                "qa_index": 20,
                "tags": ["cross_session", "long_gap", "single_hop", "charity"],
                "note": "John 迄今组织几场慈善赛（session 10→29 长期记忆）",
            },
            {
                "qa_index": 60,
                "tags": ["cross_session", "long_gap", "single_hop", "charity"],
                "note": "慈善赛上 John 和朋友玩了哪些游戏（跨 distant session）",
            },
        ],
    },
    {
        "source": "conv-48",
        "theme": "Deborah & Jolene · 工程项目 + 丧亲时间线",
        "sessions": [1],
        "cases": [
            {
                "qa_index": 0,
                "tags": ["project", "multi_hop"],
                "note": "Jolene 2023 年初的工程项目",
            },
            {
                "qa_index": 3,
                "tags": ["multi_hop", "grief"],
                "note": "Jolene 母亲去世时间",
            },
        ],
    },
    {
        "source": "conv-49",
        "theme": "Evan & Sam · 短期爱好 + Adversarial 张冠李戴",
        "sessions": [1],
        "cases": [
            {
                "qa_index": 4,
                "tags": ["hobby", "multi_hop"],
                "note": "Sam 2023 年 5 月新爱好",
            },
            {
                "qa_index": 156,
                "tags": ["adversarial", "wrong_subject"],
                "note": "Sam 换什么车（实为 Evan，wrong_subject 陷阱）",
            },
        ],
    },
    {
        "source": "conv-50",
        "theme": "Calvin & Dave · 东京首访 + 跨国见面推理",
        "sessions": [3],
        "cases": [
            {
                "qa_index": 0,
                "tags": ["temporal", "travel"],
                "note": "Calvin 首次东京行时间",
            },
            {
                "qa_index": 4,
                "tags": ["open_ended", "inference"],
                "note": "Calvin 和 Dave 想在哪国见面（开放式推理）",
            },
        ],
    },
]


def _evidence_sessions(evidence: list) -> set[int]:
    sessions: set[int] = set()
    for item in evidence or []:
        m = re.match(r"D(\d+):", str(item))
        if m:
            sessions.add(int(m.group(1)))
    return sessions


def _load_all_sources() -> dict[str, dict]:
    with open(SOURCE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {s["sample_id"]: s for s in data}


def _estimate_files(session_count: int) -> int:
    return int(session_count * FILES_PER_SESSION_EST + 0.5)


def _resolve_sessions(blocks: list[dict]) -> dict[str, set[int]]:
    """Union explicit sessions with QA evidence requirements; must fit 50–60 files."""
    sources = _load_all_sources()
    chosen: dict[str, set[int]] = {
        b["source"]: set(b["sessions"]) for b in blocks
    }

    for block in blocks:
        src = block["source"]
        qa_all = sources[src]["qa"]
        for case in block["cases"]:
            qa = qa_all[case["qa_index"]]
            chosen[src] |= _evidence_sessions(qa.get("evidence"))

    est = _estimate_files(sum(len(s) for s in chosen.values()))
    if est < TARGET_FILES_MIN or est > TARGET_FILES_MAX:
        raise ValueError(
            f"Session plan yields {est} estimated files "
            f"(need {TARGET_FILES_MIN}–{TARGET_FILES_MAX}). "
            "Adjust sessions or FILES_PER_SESSION_EST."
        )
    return chosen


def build_merged_sample() -> dict:
    sources = _load_all_sources()
    session_plan = _resolve_sessions(CURATED_CONV_BLOCKS)

    merged_conv: dict = {
        "speaker_a": "Participant A",
        "speaker_b": "Participant B",
    }
    merged_summary: dict = {}
    selected_qa: list[dict] = []
    merged_index = 0
    src_to_merged: dict[tuple[str, int], int] = {}
    session_lineage: list[dict] = []

    for block in CURATED_CONV_BLOCKS:
        src_id = block["source"]
        source = sources[src_id]
        conv = source["conversation"]
        summaries = source.get("session_summary") or {}

        for src_sess in sorted(session_plan[src_id]):
            merged_index += 1
            src_to_merged[(src_id, src_sess)] = merged_index
            sk = f"session_{src_sess}"
            dt_key = f"{sk}_date_time"
            if sk not in conv:
                raise KeyError(f"{src_id} missing {sk}")
            merged_conv[f"session_{merged_index}"] = deepcopy(conv[sk])
            if dt_key in conv:
                merged_conv[f"session_{merged_index}_date_time"] = conv[dt_key]
            sum_key = f"session_{src_sess}_summary"
            if sum_key in summaries:
                merged_summary[f"session_{merged_index}_summary"] = (
                    f"[{src_id} {sk}] {summaries[sum_key]}"
                )
            session_lineage.append({
                "merged_session": merged_index,
                "source_conv": src_id,
                "source_session": src_sess,
                "theme": block["theme"],
            })

        for case in block["cases"]:
            idx = case["qa_index"]
            qa_all = source["qa"]
            if idx < 0 or idx >= len(qa_all):
                raise IndexError(f"{src_id} QA {idx} out of range")
            qa = deepcopy(qa_all[idx])
            remapped: list = []
            for ev in qa.get("evidence") or []:
                m = re.match(r"D(\d+):(.+)", str(ev))
                if not m:
                    continue
                src_sn = int(m.group(1))
                key = (src_id, src_sn)
                if key not in src_to_merged:
                    raise ValueError(
                        f"{src_id} QA {idx} references session {src_sn} "
                        "not included in injection plan"
                    )
                remapped.append(f"D{src_to_merged[key]}:{m.group(2)}")
            qa["evidence"] = remapped
            qa["test_tags"] = case["tags"]
            qa["test_note"] = case["note"]
            qa["source_qa_index"] = idx
            qa["source_sample_id"] = src_id
            selected_qa.append(qa)

    total_sessions = merged_index
    est_files = _estimate_files(total_sessions)

    tag_counts: dict[str, int] = {}
    cat_counts: dict[int, int] = {}
    for qa in selected_qa:
        cat = qa.get("category", 0)
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        for tag in qa.get("test_tags", []):
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

    cross_session_qa = sum(
        1 for qa in selected_qa if "cross_session" in qa.get("test_tags", [])
    )
    adversarial_qa = sum(
        1 for qa in selected_qa if qa.get("category") == 5
    )
    single_hop_qa = sum(
        1 for qa in selected_qa if qa.get("category") == 1
    )

    conv_themes = [b["theme"] for b in CURATED_CONV_BLOCKS]

    return {
        "sample_id": MERGED_SAMPLE_ID,
        "conversation": merged_conv,
        "qa": selected_qa,
        "session_summary": merged_summary,
        "test_suite_meta": {
            "name": "60test",
            "description": (
                "Single injection from all 10 LoCoMo convs with distinctive QA: "
                "cross-session aggregation, long-gap charity stats, Single-hop, "
                f"Adversarial traps; target {TARGET_FILES_MIN}–{TARGET_FILES_MAX} memory files"
            ),
            "target_files_min": TARGET_FILES_MIN,
            "target_files_max": TARGET_FILES_MAX,
            "estimated_memory_files": est_files,
            "files_per_session_estimate": FILES_PER_SESSION_EST,
            "session_count": total_sessions,
            "qa_count": len(selected_qa),
            "source_convs": [b["source"] for b in CURATED_CONV_BLOCKS],
            "conv_themes": conv_themes,
            "session_lineage": session_lineage,
            "highlights": {
                "cross_session_qa": cross_session_qa,
                "long_gap_conv": "conv-47 (session 10 -> 29)",
                "military_aptitude_conv": "conv-41 (session 3+8)",
                "single_hop_qa": single_hop_qa,
                "adversarial_qa": adversarial_qa,
            },
            "dimension_tags": tag_counts,
            "categories": {
                str(k): {"name": CATEGORY_NAMES.get(k, f"Category {k}"), "count": v}
                for k, v in sorted(cat_counts.items())
            },
        },
    }


def verify_sample(sample: dict) -> None:
    meta = sample["test_suite_meta"]
    est = meta["estimated_memory_files"]
    if not (TARGET_FILES_MIN <= est <= TARGET_FILES_MAX):
        raise ValueError(
            f"Estimated {est} files not in [{TARGET_FILES_MIN}, {TARGET_FILES_MAX}]"
        )
    if len(meta["source_convs"]) != 10:
        raise ValueError("Must include all 10 official convs")
    if meta["highlights"]["single_hop_qa"] < 1:
        raise ValueError("Need at least 1 official Single-hop QA")
    if meta["highlights"]["adversarial_qa"] < 1:
        raise ValueError("Need at least 1 Adversarial QA")
    if meta["highlights"]["cross_session_qa"] < 2:
        raise ValueError("Need cross-session QA coverage")
    for qa in sample["qa"]:
        ev_sess = _evidence_sessions(qa.get("evidence"))
        max_sess = meta["session_count"]
        if any(s > max_sess or s < 1 for s in ev_sess):
            raise ValueError(f"QA evidence out of range: {qa['question'][:50]}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build locomo60test.json (50–60 files)")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--output", default=str(OUTPUT))
    args = parser.parse_args()

    sample = build_merged_sample()
    verify_sample(sample)
    meta = sample["test_suite_meta"]

    out_path = Path(args.output)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump([sample], f, indent=2, ensure_ascii=False)

    manifest_path = out_path.with_suffix(".manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({"_suite_meta": meta, "samples": [sample]}, f, indent=2, ensure_ascii=False)

    print(f"Built {out_path}")
    print(f"  sample_id:     {sample['sample_id']}")
    print(f"  sessions:      {meta['session_count']} (from 10 convs)")
    print(f"  QA:            {meta['qa_count']}")
    print(f"  est. files:    {meta['estimated_memory_files']}  "
          f"(target {TARGET_FILES_MIN}–{TARGET_FILES_MAX})")
    print(f"  highlights:    {meta['highlights']}")
    print(f"  categories:    {meta['categories']}")
    if args.verify:
        print("Verification OK")


if __name__ == "__main__":
    main()
