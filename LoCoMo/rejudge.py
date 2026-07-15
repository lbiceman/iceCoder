"""Re-judge an existing result file using the updated evaluator_judge.py.

Usage:
    python LoCoMo/rejudge.py LoCoMo/result_official_v12_test.json LoCoMo/result_official_v12_rejudged.json
"""
import json
import sys
import time
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Add parent dir so evaluator_judge can find data/config.json
sys.path.insert(0, str(Path(__file__).parent))
from evaluator_judge import judge_qa, judge_adversarial, _get_config, _load_deepseek_config, _load_provider_config

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

THRESHOLD = 0.6
MAX_WORKERS = 8


def rejudge_item(item: dict, cfg: dict) -> dict:
    """Re-judge a single QA item."""
    cat = item.get("category", 0)
    question = item["question"]
    response = item["response"]
    answer = item.get("answer", "")

    if cat == 5:
        # Adversarial
        result = judge_qa(question, answer, response, cfg=cfg)
    else:
        result = judge_qa(question, answer, response, cfg=cfg)

    verdict = result.get("verdict", "incorrect")
    confidence = result.get("confidence", 0.0)
    reason = result.get("reason", "")
    passed = (verdict == "correct" and confidence >= THRESHOLD)

    item_copy = dict(item)
    item_copy["judge_verdict"] = verdict
    item_copy["judge_confidence"] = confidence
    item_copy["reason"] = reason
    item_copy["passed"] = passed
    item_copy["score"] = confidence if verdict == "correct" else 0.0
    return item_copy


def main():
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <input.json> [output.json] [--judge deepseek|mimo]")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    
    # Parse --judge flag
    judge_provider = None
    remaining_args = []
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--judge" and i + 1 < len(sys.argv):
            judge_provider = sys.argv[i + 1]
            i += 2
        else:
            remaining_args.append(sys.argv[i])
            i += 1

    output_path = Path(remaining_args[0]) if remaining_args else input_path.with_name(
        input_path.stem + "_rejudged.json"
    )

    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Select judge config
    if judge_provider == "deepseek":
        cfg = _load_deepseek_config()
        if not cfg:
            logger.error("No deepseek provider found in config.json")
            sys.exit(1)
    elif judge_provider == "mimo":
        cfg = _load_provider_config("mimo")
        if not cfg:
            logger.error("No mimo provider found in config.json")
            sys.exit(1)
    else:
        cfg = _get_config()
    logger.info(f"Judge model: {cfg.get('model', 'unknown')}")
    logger.info(f"Judge base_url: {cfg.get('base_url', 'unknown')}")

    # Collect all QA items
    all_items = []
    for detail in data.get("details", []):
        for item in detail.get("qa_results", []):
            all_items.append(item)

    logger.info(f"Re-judging {len(all_items)} items with {MAX_WORKERS} workers...")
    start = time.time()

    rejudged = [None] * len(all_items)
    done_count = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(rejudge_item, item, cfg): i for i, item in enumerate(all_items)}
        for future in as_completed(futures):
            idx = futures[future]
            try:
                rejudged[idx] = future.result()
            except Exception as e:
                logger.error(f"Item {idx} failed: {e}")
                rejudged[idx] = all_items[idx]
            done_count += 1
            if done_count % 20 == 0 or done_count == len(all_items):
                passed_so_far = sum(1 for r in rejudged[:done_count] if r and r.get("passed"))
                logger.info(f"  Progress: {done_count}/{len(all_items)}, passed so far: {passed_so_far}")

    elapsed = round(time.time() - start, 1)
    logger.info(f"Re-judging completed in {elapsed}s")

    # Rebuild results
    item_idx = 0
    for detail in data.get("details", []):
        qa_results = detail.get("qa_results", [])
        new_results = []
        for _ in qa_results:
            new_results.append(rejudged[item_idx])
            item_idx += 1
        detail["qa_results"] = new_results
        detail["total_qa"] = len(new_results)

    # Recompute summary
    total = 0
    passed = 0
    by_cat = {}
    by_sample = []

    for detail in data.get("details", []):
        sample_total = 0
        sample_passed = 0
        for item in detail.get("qa_results", []):
            cat = str(item.get("category", 0))
            if cat not in by_cat:
                by_cat[cat] = {"total": 0, "passed": 0}
            by_cat[cat]["total"] += 1
            total += 1
            sample_total += 1
            if item.get("passed"):
                by_cat[cat]["passed"] += 1
                passed += 1
                sample_passed += 1
        by_sample.append({
            "sample_id": detail.get("sample_id", ""),
            "total": sample_total,
            "passed": sample_passed,
            "accuracy": round(sample_passed / sample_total, 4) if sample_total else 0,
        })

    cat_names = {
        "1": "Single-hop QA", "2": "Multi-hop QA", "3": "Open-ended QA",
        "4": "Temporal QA", "5": "Adversarial QA",
    }

    data["summary"] = {
        "total_questions": total,
        "passed": passed,
        "failed": total - passed,
        "overall_accuracy": round(passed / total, 4) if total else 0,
    }
    data["by_category"] = {
        cat: {
            "name": cat_names.get(cat, f"Category {cat}"),
            "total": info["total"],
            "passed": info["passed"],
            "accuracy": round(info["passed"] / info["total"], 4) if info["total"] else 0,
        }
        for cat, info in sorted(by_cat.items())
    }
    data["by_sample"] = by_sample
    data["metadata"]["rejudge_elapsed_seconds"] = elapsed

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # Print summary
    print(f"\n{'='*50}")
    print(f"Re-judge Results: {passed}/{total} = {data['summary']['overall_accuracy']*100:.2f}%")
    print(f"{'='*50}")
    for cat in sorted(by_cat.keys()):
        info = by_cat[cat]
        acc = info['passed'] / info['total'] * 100 if info['total'] else 0
        print(f"  Cat {cat} ({cat_names.get(cat, '?'):15s}): {info['passed']:3d}/{info['total']:3d} = {acc:.1f}%")
    print(f"{'='*50}")
    print(f"Saved to: {output_path}")


if __name__ == "__main__":
    main()
