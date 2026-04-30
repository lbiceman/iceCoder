# -*- coding: utf-8 -*-
"""
Memory Recall-Only Test for iceCoder.

Tests ONLY the memory system's recall ability — no model answering.
Uses iceCoder's full recall pipeline (including LLM semantic selection)
via the /api/memory/recall endpoint.

For each QA question:
1. Call iceCoder's recall API → get recalled memory files
2. Use LLM Judge to check if the answer exists in recalled content
3. Report Recall@K accuracy

This isolates memory system performance from model answering ability.
"""

import json
import re
import sys
import time
import logging
import argparse
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

try:
    import requests
except ImportError:
    print("ERROR: requests not found"); sys.exit(1)

try:
    from tqdm import tqdm
except ImportError:
    class tqdm:
        def __init__(self, iterable=None, total=None, desc="", **kwargs):
            self.iterable = iterable; self.total = total or (len(iterable) if iterable else 0)
            self.desc = desc; self.n = 0
        def __iter__(self):
            for item in self.iterable:
                yield item; self.n += 1
                print(f"\r{self.desc}: {self.n}/{self.total}", end="", flush=True)
            print()
        def set_postfix_str(self, s): pass
        def close(self): pass

sys.path.insert(0, str(Path(__file__).parent))
from evaluator_judge import _get_config

SCRIPT_DIR = Path(__file__).parent.resolve()
LOG_FILE = SCRIPT_DIR / "eval_recall_only.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8", mode="w"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("recall-only")

CATEGORY_NAMES = {
    1: "Single-hop QA", 2: "Multi-hop QA", 3: "Open-ended QA",
    4: "Temporal QA", 5: "Adversarial QA",
}

# ---------------------------------------------------------------------------
# iceCoder Recall API
# ---------------------------------------------------------------------------

def recall_memories(host: str, port: int, query: str, top_k: int = 10) -> dict:
    """Call iceCoder's recall API to get recalled memory files."""
    url = f"http://{host}:{port}/api/memory/recall"
    for attempt in range(3):
        try:
            resp = requests.post(url, json={"query": query, "topK": top_k}, timeout=30)
            if resp.status_code == 200:
                return resp.json()
            logger.warning(f"Recall API returned {resp.status_code}: {resp.text[:200]}")
        except requests.RequestException as e:
            logger.warning(f"Recall API attempt {attempt+1} failed: {e}")
            if attempt < 2:
                time.sleep(1)
    return {"success": False, "files": [], "recalled": 0}

# ---------------------------------------------------------------------------
# Judge: is the answer in the recalled content?
# ---------------------------------------------------------------------------

RECALL_JUDGE_SYSTEM = """You are evaluating whether a piece of text CONTAINS the information needed to answer a question.
You are NOT answering the question yourself. You are checking if the answer EXISTS in the provided text.

Rules:
1. Check if the expected answer's key facts are present in the text.
2. Minor wording differences are OK (e.g., "7 May 2023" vs "May 7, 2023").
3. The information doesn't need to be a direct quote — semantic equivalence counts.
4. Return ONLY a JSON object."""

RECALL_JUDGE_USER = """Question: {question}
Expected Answer: {answer}

Text to search in:
{recalled_text}

Does this text contain the information needed to answer the question correctly?
Return a JSON object:
- "found": true or false
- "evidence": quote the relevant sentence if found, or "not found"
- "confidence": float 0.0-1.0"""


def judge_recall(question: str, answer: str, recalled_text: str, cfg: dict) -> dict:
    """Ask Judge if the answer exists in the recalled text."""
    prompt = RECALL_JUDGE_USER.format(
        question=question, answer=answer, recalled_text=recalled_text[:4000],
    )
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"}
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": RECALL_JUDGE_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1, "max_tokens": 256,
    }
    for attempt in range(3):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
            if resp.status_code == 429:
                time.sleep(2 * (attempt + 1)); continue
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            if content.startswith("```"):
                content = re.sub(r"^```(?:json)?\s*", "", content)
                content = re.sub(r"\s*```$", "", content)
            result = json.loads(content)
            return {
                "found": bool(result.get("found", False)),
                "evidence": str(result.get("evidence", "")),
                "confidence": float(result.get("confidence", 0.0)),
            }
        except Exception as e:
            if attempt < 2: time.sleep(1)
            else: return {"found": False, "evidence": f"Judge error: {e}", "confidence": 0.0}
    return {"found": False, "evidence": "Judge failed", "confidence": 0.0}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Memory Recall-Only Test")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--dataset", default=str(SCRIPT_DIR / "locomo10.json"))
    parser.add_argument("--output", default=str(SCRIPT_DIR / "result_recall_only.json"))
    parser.add_argument("--sample-ids", nargs="+", default=None)
    parser.add_argument("--categories", nargs="+", type=int, default=None)
    parser.add_argument("--max-qa", type=int, default=None)
    parser.add_argument("--top-k", type=int, default=10)
    args = parser.parse_args()

    logger.info("=" * 60)
    logger.info("Memory Recall-Only Test (via iceCoder recall API)")
    logger.info(f"  Server:   {args.host}:{args.port}")
    logger.info(f"  Top-K:    {args.top_k}")
    logger.info(f"  Samples:  {args.sample_ids or 'all'}")
    logger.info("=" * 60)

    # Health check
    try:
        r = requests.get(f"http://{args.host}:{args.port}/api/memory/stats", timeout=5)
        assert r.status_code == 200
        logger.info("Server is healthy.")
    except Exception:
        logger.error("Cannot reach iceCoder. Start it first."); sys.exit(1)

    # Load dataset
    data = json.load(open(args.dataset, encoding="utf-8"))
    if args.sample_ids:
        data = [s for s in data if s.get("sample_id") in args.sample_ids]
    logger.info(f"Loaded {len(data)} samples")

    judge_cfg = _get_config()
    logger.info(f"Judge model: {judge_cfg['model']}")

    judge_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="judge")
    start_time = time.time()
    all_results = []

    for sample in data:
        sample_id = sample.get("sample_id", "unknown")
        qa_list = sample.get("qa", [])
        if args.categories:
            qa_list = [q for q in qa_list if q.get("category") in args.categories]
        if args.max_qa:
            qa_list = qa_list[:args.max_qa]

        logger.info(f"\n[{sample_id}] Testing {len(qa_list)} QA (top-{args.top_k})")

        futures = []
        pbar = tqdm(qa_list, desc=f"  {sample_id}", unit="q")

        for i, qa in enumerate(pbar):
            question = qa.get("question", "")
            category = qa.get("category", 0)
            answer = str(qa.get("answer", qa.get("adversarial_answer", "")))

            # Call iceCoder recall API (sequential — one at a time to avoid overload)
            recall_result = recall_memories(args.host, args.port, question, args.top_k)
            recalled_files = recall_result.get("files", [])
            recalled_text = "\n\n---\n\n".join(
                f"[{f['filename']}]\n{f.get('content', '')}" for f in recalled_files
            )
            recalled_filenames = [f["filename"] for f in recalled_files]
            used_llm = recall_result.get("usedLLM", False)

            pbar.set_postfix_str(f"cat={category}, recalled={len(recalled_files)}, llm={used_llm}")

            # Submit judge task (parallel)
            def _judge(idx, q, a, text, fnames, cat, qa_item, cfg):
                if cat == 5 and "answer" not in qa_item:
                    adv = qa_item.get("adversarial_answer", "")
                    r = judge_recall(q, f"The text should NOT confidently state: {adv}", text, cfg)
                    return {
                        "index": idx, "question": q, "category": cat,
                        "answer": None, "adversarial_answer": adv,
                        "found": r["found"], "evidence": r["evidence"],
                        "confidence": r["confidence"], "recalled_files": fnames,
                    }
                else:
                    r = judge_recall(q, a, text, cfg)
                    return {
                        "index": idx, "question": q, "category": cat,
                        "answer": a, "found": r["found"],
                        "evidence": r["evidence"], "confidence": r["confidence"],
                        "recalled_files": fnames,
                    }

            fut = judge_pool.submit(_judge, i, question, answer, recalled_text,
                                     recalled_filenames, category, qa, judge_cfg)
            futures.append((i, fut))

        pbar.close()

        # Collect results
        sample_results = [None] * len(futures)
        for idx, fut in futures:
            try:
                sample_results[idx] = fut.result(timeout=60)
            except Exception as e:
                sample_results[idx] = {"index": idx, "found": False, "evidence": f"Error: {e}", "confidence": 0.0}

        sample_results = [r for r in sample_results if r]
        found_count = sum(1 for r in sample_results if r["found"])
        logger.info(f"  Recall@{args.top_k}: {found_count}/{len(sample_results)} "
                     f"= {found_count/len(sample_results)*100:.1f}%")

        all_results.append({
            "sample_id": sample_id,
            "total": len(sample_results),
            "found": found_count,
            "recall_rate": round(found_count / len(sample_results) * 100, 2) if sample_results else 0,
            "details": sample_results,
        })

    elapsed = round(time.time() - start_time, 1)
    judge_pool.shutdown(wait=False)

    # Aggregate
    total_qa = sum(r["total"] for r in all_results)
    total_found = sum(r["found"] for r in all_results)

    cat_stats = defaultdict(lambda: {"total": 0, "found": 0})
    for sr in all_results:
        for d in sr["details"]:
            cat = d.get("category", 0)
            cat_stats[cat]["total"] += 1
            if d["found"]: cat_stats[cat]["found"] += 1

    output = {
        "summary": {
            "total_questions": total_qa,
            "answer_found_in_recall": total_found,
            "recall_rate": round(total_found / total_qa * 100, 2) if total_qa else 0,
            "top_k": args.top_k,
            "elapsed_seconds": elapsed,
        },
        "by_category": {
            cat_id: {
                "name": CATEGORY_NAMES.get(cat_id, f"Cat {cat_id}"),
                "total": stats["total"], "found": stats["found"],
                "recall_rate": round(stats["found"] / stats["total"] * 100, 2) if stats["total"] else 0,
            }
            for cat_id, stats in sorted(cat_stats.items())
        },
        "by_sample": [
            {"sample_id": r["sample_id"], "total": r["total"],
             "found": r["found"], "recall_rate": r["recall_rate"]}
            for r in all_results
        ],
        "details": all_results,
    }

    Path(args.output).write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info(f"\nResults saved to {args.output}")

    # Print summary
    print(f"\n{'='*60}")
    print(f"MEMORY RECALL-ONLY TEST (Recall@{args.top_k})")
    print(f"{'='*60}")
    print(f"  Total questions:  {total_qa}")
    print(f"  Answer found:     {total_found}")
    print(f"  Recall rate:      {total_found/total_qa*100:.2f}%")
    print(f"  Elapsed:          {elapsed}s")
    print(f"\nBY CATEGORY:")
    for cat_id in sorted(cat_stats):
        s = cat_stats[cat_id]
        name = CATEGORY_NAMES.get(cat_id, f"Cat {cat_id}")
        rate = s["found"] / s["total"] * 100 if s["total"] else 0
        print(f"  {cat_id} ({name:20s}): {s['found']:3d}/{s['total']:3d} = {rate:6.2f}%")
    print(f"\nBY SAMPLE:")
    for r in all_results:
        print(f"  {r['sample_id']:12s}: {r['found']:3d}/{r['total']:3d} = {r['recall_rate']:6.2f}%")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
