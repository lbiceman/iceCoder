# -*- coding: utf-8 -*-
"""
LoCoMo Official Dataset Evaluation Script for iceCoder Memory System.

Reads the official locomo10.json (10 samples, ~1986 QA pairs),
injects conversations as memory files into iceCoder, then evaluates
QA accuracy using LLM-as-Judge (DeepSeek V4 Flash).

Usage:
    # Start iceCoder in eval mode (saves ~70% tokens):
    #   Windows PowerShell:
    #     $env:ICE_EVAL_MODE="1"; $env:ICE_DISABLE_TOOLS="1"; npm run iceCoder
    #   Linux/Mac:
    #     ICE_EVAL_MODE=1 ICE_DISABLE_TOOLS=1 npm run iceCoder

    python run_locomo_official.py [options]

    # Run first 5 QA only (quick test)
    python run_locomo_official.py --max-qa 5

    # Run specific samples
    python run_locomo_official.py --sample-ids conv-26 conv-27

    # Run specific categories only
    python run_locomo_official.py --categories 1 2 3

    # Full run
    python run_locomo_official.py
"""

import json
import time
import logging
import argparse
import sys
import re
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None  # Will be checked at runtime when needed

try:
    from tqdm import tqdm
except ImportError:
    class tqdm:
        """Minimal fallback progress bar."""
        def __init__(self, iterable=None, total=None, desc="", **kwargs):
            self.iterable = iterable
            self.total = total or (len(iterable) if iterable else 0)
            self.desc = desc
            self.n = 0
        def __iter__(self):
            for item in self.iterable:
                yield item
                self.n += 1
                pct = int(self.n / self.total * 100) if self.total else 0
                print(f"\r{self.desc}: {self.n}/{self.total} ({pct}%)", end="", flush=True)
            print()
        def set_postfix_str(self, s): pass
        def update(self, n=1): self.n += n
        def close(self): pass

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent.resolve()
LOG_FILE = SCRIPT_DIR / "eval_official.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8", mode="w"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("locomo-official")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_RETRIES = 3
RETRY_DELAY = 2          # seconds between retries
MSG_INTERVAL = 0.3       # seconds between QA queries
QA_TIMEOUT = 180         # seconds timeout for QA query

# Category names from LoCoMo paper
CATEGORY_NAMES = {
    1: "Single-hop QA",
    2: "Multi-hop QA",
    3: "Open-ended QA",
    4: "Temporal QA",
    5: "Adversarial QA",
}


# ---------------------------------------------------------------------------
# WebSocket Communication
# ---------------------------------------------------------------------------

def send_message_ws(host: str, port: int, message: str, timeout: int = 120) -> str:
    """Send a message to iceCoder via WebSocket, return the full response."""
    try:
        import websocket
    except ImportError:
        logger.warning("websocket-client not installed, falling back to HTTP")
        return send_message_http(host, port, message, timeout)

    ws_url = f"ws://{host}:{port}/api/chat/ws"
    response_parts = []
    done = False
    error_msg = None

    def on_message(ws, msg):
        nonlocal done, error_msg
        try:
            data = json.loads(msg)
            msg_type = data.get("type", "")
            if msg_type == "stream":
                delta = data.get("delta", "")
                if delta:
                    response_parts.append(delta)
            elif msg_type == "response":
                content = data.get("content", "")
                if content and not response_parts:
                    response_parts.append(content)
                done = True
                ws.close()
            elif msg_type == "stream_end":
                done = True
                ws.close()
            elif msg_type == "error":
                error_msg = data.get("message", "unknown error")
                done = True
                ws.close()
        except json.JSONDecodeError:
            pass

    def on_error(ws, error):
        nonlocal done, error_msg
        error_msg = str(error)
        done = True

    def on_open(ws):
        payload = json.dumps({"type": "message", "content": message})
        ws.send(payload)

    ws = websocket.WebSocketApp(
        ws_url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=lambda ws, code, msg: None,
    )

    import threading
    wst = threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 30})
    wst.daemon = True
    wst.start()
    wst.join(timeout=timeout)

    if not done:
        ws.close()
        logger.warning(f"WebSocket timed out after {timeout}s")

    if error_msg:
        logger.warning(f"WebSocket error: {error_msg}")

    return "".join(response_parts)


def send_message_http(host: str, port: int, message: str, timeout: int = 120) -> str:
    """Fallback: send message via iceCoder CLI subprocess."""
    import subprocess
    try:
        result = subprocess.run(
            ["npx", "tsx", "src/cli/index.ts", "run", message],
            capture_output=True, text=True, timeout=timeout,
            cwd=str(SCRIPT_DIR.parent), encoding="utf-8",
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception as e:
        logger.error(f"HTTP fallback failed: {e}")
        return ""


def send_message_with_retry(host: str, port: int, message: str,
                            timeout: int = 120, retries: int = MAX_RETRIES) -> str:
    """Send message with retry logic."""
    for attempt in range(retries):
        try:
            resp = send_message_ws(host, port, message, timeout)
            if resp:
                return resp
            if attempt < retries - 1:
                logger.warning(f"Empty response, retrying ({attempt+1}/{retries})...")
                time.sleep(RETRY_DELAY)
        except Exception as e:
            logger.warning(f"Send failed (attempt {attempt+1}/{retries}): {e}")
            if attempt < retries - 1:
                time.sleep(RETRY_DELAY)
    return ""


# ---------------------------------------------------------------------------
# Session Management
# ---------------------------------------------------------------------------

def clear_session(host: str, port: int) -> bool:
    """Clear iceCoder chat session via WebSocket + HTTP fallback."""
    # Try WebSocket first
    try:
        import websocket
        ws_url = f"ws://{host}:{port}/api/chat/ws"
        ws = websocket.create_connection(ws_url, timeout=10)
        ws.send(json.dumps({"type": "clear_session"}))
        time.sleep(0.5)
        ws.close()
        return True
    except Exception:
        pass

    # HTTP fallback
    url = f"http://{host}:{port}/api/sessions/default"
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.put(url, json={"messages": []}, timeout=10)
            if resp.status_code == 200:
                return True
        except requests.RequestException as e:
            logger.warning(f"Clear session attempt {attempt+1} failed: {e}")
            time.sleep(RETRY_DELAY)
    return False


def clear_memory_files(host: str, port: int) -> bool:
    """Clear all memory files to start fresh for each sample (local filesystem)."""
    memory_dir = SCRIPT_DIR.parent / "data" / "memory-files"
    try:
        if not memory_dir.exists():
            return True
        for f in memory_dir.iterdir():
            if f.is_file() and f.name != "MEMORY.md" and f.name != ".consolidate-lock":
                f.unlink()
                logger.debug(f"    Deleted memory file: {f.name}")
        # Reset MEMORY.md index
        index_file = memory_dir / "MEMORY.md"
        index_file.write_text("# 记忆索引\n", encoding="utf-8")
        return True
    except Exception as e:
        logger.warning(f"Failed to clear memory files: {e}")
        return False


# ---------------------------------------------------------------------------
# Data Loading & Preprocessing
# ---------------------------------------------------------------------------

def load_dataset(path: str) -> list:
    """Load locomo10.json and return the list of samples."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"Expected a JSON array, got {type(data).__name__}")
    logger.info(f"Loaded {len(data)} samples from {path}")
    return data


def extract_sessions(conversation: dict) -> list:
    """
    Extract ordered sessions from the conversation dict.
    Returns list of (session_key, datetime_str, turns).
    """
    sessions = []
    # Find all session keys (session_1, session_2, ...)
    sess_keys = sorted(
        [k for k in conversation if re.match(r"^session_\d+$", k)],
        key=lambda k: int(k.split("_")[1])
    )
    for sk in sess_keys:
        dt_key = f"{sk}_date_time"
        dt_str = conversation.get(dt_key, "")
        turns = conversation[sk]
        sessions.append((sk, dt_str, turns))
    return sessions


# ---------------------------------------------------------------------------
# LLM-as-Judge Evaluation (via evaluator_judge.py)
# ---------------------------------------------------------------------------

from evaluator_judge import judge_qa, judge_adversarial, _get_config as get_judge_config


def evaluate_qa(response: str, qa_item: dict, threshold: float = 0.6,
                judge_cfg: dict = None) -> dict:
    """
    Evaluate a single QA pair using LLM-as-Judge.
    Returns dict with score, passed, and details.
    """
    category = qa_item.get("category", 0)
    question = qa_item.get("question", "")

    # Category 5 (Adversarial): special handling
    if category == 5:
        return evaluate_adversarial(response, qa_item, threshold, judge_cfg)

    answer = str(qa_item.get("answer", ""))
    if not answer:
        return {
            "question": question,
            "category": category,
            "answer": answer,
            "response": response[:500],
            "score": 0.0,
            "passed": False,
            "reason": "No answer provided in dataset",
        }

    # Call LLM judge
    judge_result = judge_qa(question, answer, response, cfg=judge_cfg)
    passed = judge_result["verdict"] == "correct"
    score = judge_result["confidence"] if passed else (1.0 - judge_result["confidence"])

    return {
        "question": question,
        "category": category,
        "answer": answer,
        "response": response[:500],
        "score": round(score, 4),
        "passed": passed,
        "reason": judge_result["reason"],
        "judge_verdict": judge_result["verdict"],
        "judge_confidence": judge_result["confidence"],
    }


def evaluate_adversarial(response: str, qa_item: dict, threshold: float = 0.6,
                         judge_cfg: dict = None) -> dict:
    """
    Evaluate adversarial QA (category 5) using LLM-as-Judge.
    """
    question = qa_item.get("question", "")
    adversarial = str(qa_item.get("adversarial_answer", ""))
    correct_answer = qa_item.get("answer")

    judge_result = judge_adversarial(
        question=question,
        response=response,
        adversarial_answer=adversarial,
        correct_answer=str(correct_answer) if correct_answer else None,
        cfg=judge_cfg,
    )
    passed = judge_result["verdict"] == "correct"
    score = judge_result["confidence"] if passed else 0.0

    return {
        "question": question,
        "category": 5,
        "answer": str(correct_answer) if correct_answer else None,
        "adversarial_answer": adversarial,
        "response": response[:500],
        "score": round(score, 4),
        "passed": passed,
        "reason": judge_result["reason"],
        "judge_verdict": judge_result["verdict"],
        "judge_confidence": judge_result["confidence"],
    }


# ---------------------------------------------------------------------------
# Core Evaluation Pipeline
# ---------------------------------------------------------------------------

MEMORY_DIR = SCRIPT_DIR.parent / "data" / "memory-files"


def inject_conversations(host: str, port: int, sample: dict,
                         batch_size: int = 0) -> int:
    """
    Inject conversations by writing memory files directly to disk.

    This bypasses the slow WebSocket → LLM Harness pipeline entirely.
    Each session is written as a memory file in iceCoder's memory format,
    making the conversations immediately available for recall during QA.

    Returns total number of memory files written.
    """
    conversation = sample.get("conversation", {})
    sample_id = sample.get("sample_id", "unknown")
    speaker_a = conversation.get("speaker_a", "Speaker A")
    speaker_b = conversation.get("speaker_b", "Speaker B")
    sessions = extract_sessions(conversation)

    total_turns = sum(len(turns) for _, _, turns in sessions)
    file_count = 0

    logger.info(f"  Injecting {len(sessions)} sessions, {total_turns} turns "
                f"(direct file write mode)")

    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    index_lines = ["# 记忆索引\n"]

    pbar = tqdm(sessions, desc="    Writing memory files", unit="sess", leave=False)

    for sess_key, dt_str, turns in pbar:
        pbar.set_postfix_str(f"{sess_key}")

        # Build conversation transcript
        lines = []
        for turn in turns:
            speaker = turn.get("speaker", "unknown")
            text = turn.get("text", "")
            if text:
                lines.append(f"**{speaker}**: {text}")

        if not lines:
            continue

        transcript = "\n\n".join(lines)

        # Create memory file
        sess_num = sess_key.split("_")[1]
        filename = f"locomo_{sample_id}_{sess_key}.md"
        now_iso = datetime.now(tz=__import__('datetime').timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

        description = (f"LoCoMo conversation {sample_id} {sess_key} "
                       f"between {speaker_a} and {speaker_b}")
        if dt_str:
            description += f" at {dt_str}"

        content = f"""---
name: {sample_id} {sess_key}
description: {description}
type: conversation
source: locomo_eval
confidence: 1
tags: locomo, {sample_id}, {sess_key}
createdAt: {now_iso}
recallCount: 0
---

## Conversation: {sample_id} — Session {sess_num}
**Participants**: {speaker_a} and {speaker_b}
"""
        if dt_str:
            content += f"**Time**: {dt_str}\n"

        content += f"\n{transcript}\n\n---\n*Injected for LoCoMo evaluation: {now_iso}*\n"

        filepath = MEMORY_DIR / filename
        filepath.write_text(content, encoding="utf-8")
        file_count += 1

        # Add to index
        index_lines.append(
            f"- [{sample_id} {sess_key}]({filename}) — "
            f"{description}\n"
        )

    pbar.close()

    # Write MEMORY.md index
    index_file = MEMORY_DIR / "MEMORY.md"
    index_file.write_text("".join(index_lines), encoding="utf-8")

    logger.info(f"  Written {file_count} memory files ({total_turns} turns) "
                f"to {MEMORY_DIR}")
    return file_count


def run_qa_evaluation(host: str, port: int, qa_list: list,
                      threshold: float = 0.6) -> list:
    """
    Run QA evaluation: send each question, get response, score via LLM judge.
    Clears session before each QA to ensure the model relies on memory recall
    rather than accumulated conversation history.

    Uses a background thread pool to run Judge scoring in parallel with the
    next iceCoder query, roughly halving total wall time.

    Returns list of result dicts.
    """
    from concurrent.futures import ThreadPoolExecutor, Future

    results: list = [None] * len(qa_list)  # pre-allocate for ordered results
    judge_cfg = get_judge_config()
    logger.info(f"    Judge model: {judge_cfg['model']}")

    # Thread pool for async judge scoring (IO-bound, safe to parallelize)
    judge_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="judge")
    pending_futures: list[tuple[int, Future]] = []

    def _collect_done_futures():
        """Collect completed judge futures into results."""
        still_pending = []
        for idx, fut in pending_futures:
            if fut.done():
                try:
                    results[idx] = fut.result()
                except Exception as e:
                    logger.warning(f"  Judge future {idx} failed: {e}")
                    results[idx] = {"index": idx, "passed": False, "score": 0.0,
                                    "reason": f"Judge error: {e}"}
            else:
                still_pending.append((idx, fut))
        pending_futures.clear()
        pending_futures.extend(still_pending)

    pbar = tqdm(qa_list, desc="    Evaluating QA", unit="q")

    for i, qa_item in enumerate(pbar):
        question = qa_item.get("question", "")
        category = qa_item.get("category", 0)
        pbar.set_postfix_str(f"cat={category}")

        # Collect any finished judge results
        _collect_done_futures()

        # Clear session before each QA to isolate memory recall
        clear_session(host, port)

        # Send question to iceCoder (blocking — this is the slow part)
        response = send_message_with_retry(host, port, question, timeout=QA_TIMEOUT)

        # Submit judge scoring to background thread (non-blocking)
        def _judge_task(idx, resp, qa, thr, cfg):
            result = evaluate_qa(resp, qa, thr, judge_cfg=cfg)
            result["index"] = idx
            status = "PASS" if result["passed"] else "FAIL"
            logger.debug(f"  QA[{idx}] cat={qa.get('category',0)} {status} "
                         f"score={result['score']:.3f}")
            return result

        fut = judge_pool.submit(_judge_task, i, response, qa_item, threshold, judge_cfg)
        pending_futures.append((i, fut))

    pbar.close()

    # Wait for all remaining judge futures
    for idx, fut in pending_futures:
        try:
            results[idx] = fut.result(timeout=30)
        except Exception as e:
            logger.warning(f"  Judge future {idx} timed out: {e}")
            results[idx] = {"index": idx, "passed": False, "score": 0.0,
                            "reason": f"Judge timeout: {e}"}

    judge_pool.shutdown(wait=False)

    # Log summary
    passed = sum(1 for r in results if r and r.get("passed"))
    logger.info(f"    QA done: {passed}/{len(qa_list)} passed")

    return [r for r in results if r]  # filter out any None


def evaluate_sample(host: str, port: int, sample: dict, sample_idx: int,
                    total_samples: int, categories: list = None,
                    max_qa: int = None, threshold: float = 0.6) -> dict:
    """
    Full evaluation pipeline for one sample:
    1. Clear session & memory
    2. Inject conversations
    3. Run QA evaluation
    """
    sample_id = sample.get("sample_id", f"sample-{sample_idx}")
    qa_list = sample.get("qa", [])

    # Filter by category
    if categories:
        qa_list = [q for q in qa_list if q.get("category") in categories]

    # Limit QA count
    if max_qa is not None and max_qa > 0:
        qa_list = qa_list[:max_qa]

    logger.info(f"\n{'='*60}")
    logger.info(f"[{sample_idx+1}/{total_samples}] Sample: {sample_id}")
    logger.info(f"  QA to evaluate: {len(qa_list)}")
    logger.info(f"{'='*60}")

    result = {
        "sample_id": sample_id,
        "total_qa": len(qa_list),
        "qa_results": [],
        "error": None,
        "timing": {},
    }

    if not qa_list:
        logger.info(f"  No QA items to evaluate, skipping")
        return result

    try:
        # Step 1: Clear session and memory
        logger.info(f"  Step 1: Clearing session and memory...")
        clear_session(host, port)
        clear_memory_files(host, port)
        time.sleep(1)

        # Step 2: Inject conversations
        logger.info(f"  Step 2: Injecting conversations...")
        t0 = time.time()
        msg_count = inject_conversations(host, port, sample)
        inject_time = round(time.time() - t0, 1)
        result["timing"]["inject_seconds"] = inject_time
        result["timing"]["messages_sent"] = msg_count
        logger.info(f"  Injection completed in {inject_time}s")

        # Step 3: Run QA evaluation
        logger.info(f"  Step 3: Running QA evaluation ({len(qa_list)} questions)...")
        t0 = time.time()
        qa_results = run_qa_evaluation(host, port, qa_list, threshold)
        qa_time = round(time.time() - t0, 1)
        result["timing"]["qa_seconds"] = qa_time
        result["qa_results"] = qa_results
        logger.info(f"  QA evaluation completed in {qa_time}s")

        # Quick summary
        passed = sum(1 for r in qa_results if r["passed"])
        logger.info(f"  Result: {passed}/{len(qa_results)} passed "
                     f"({passed/len(qa_results)*100:.1f}%)")

    except Exception as e:
        logger.error(f"  Error evaluating {sample_id}: {e}", exc_info=True)
        result["error"] = str(e)

    return result


# ---------------------------------------------------------------------------
# Metrics & Reporting
# ---------------------------------------------------------------------------

def compute_metrics(sample_results: list) -> dict:
    """Compute aggregate metrics from all sample results."""
    all_qa = []
    for sr in sample_results:
        for qr in sr.get("qa_results", []):
            qr["sample_id"] = sr["sample_id"]
            all_qa.append(qr)

    total = len(all_qa)
    passed = sum(1 for q in all_qa if q["passed"])

    # Per-category breakdown
    cat_stats = {}
    for cat_id, cat_name in CATEGORY_NAMES.items():
        subset = [q for q in all_qa if q["category"] == cat_id]
        if subset:
            cat_passed = sum(1 for q in subset if q["passed"])
            avg_score = sum(q["score"] for q in subset) / len(subset)
            cat_stats[cat_id] = {
                "name": cat_name,
                "total": len(subset),
                "passed": cat_passed,
                "accuracy": round(cat_passed / len(subset) * 100, 2),
                "avg_score": round(avg_score, 4),
            }

    # Per-sample breakdown
    sample_stats = []
    for sr in sample_results:
        qa = sr.get("qa_results", [])
        if qa:
            sp = sum(1 for q in qa if q["passed"])
            sample_stats.append({
                "sample_id": sr["sample_id"],
                "total": len(qa),
                "passed": sp,
                "accuracy": round(sp / len(qa) * 100, 2),
                "error": sr.get("error"),
            })

    return {
        "summary": {
            "total_questions": total,
            "passed": passed,
            "failed": total - passed,
            "overall_accuracy": round(passed / total * 100, 2) if total > 0 else 0.0,
        },
        "by_category": cat_stats,
        "by_sample": sample_stats,
    }


def print_summary(metrics: dict) -> None:
    """Print a formatted summary to console."""
    s = metrics["summary"]
    print(f"\n{'='*60}")
    print("LOCOMO OFFICIAL EVALUATION SUMMARY")
    print(f"{'='*60}")
    print(f"  Total questions:    {s['total_questions']}")
    print(f"  Passed:             {s['passed']}")
    print(f"  Failed:             {s['failed']}")
    print(f"  Overall accuracy:   {s['overall_accuracy']}%")

    print(f"\n{'─'*60}")
    print("BY CATEGORY:")
    print(f"{'─'*60}")
    for cat_id in sorted(metrics["by_category"]):
        c = metrics["by_category"][cat_id]
        bar_len = int(c["accuracy"] / 100 * 20)
        bar = "█" * bar_len + "░" * (20 - bar_len)
        print(f"  Cat {cat_id} ({c['name']:20s}): "
              f"{c['passed']:3d}/{c['total']:3d} = {c['accuracy']:6.2f}%  "
              f"|{bar}|  avg={c['avg_score']:.3f}")

    print(f"\n{'─'*60}")
    print("BY SAMPLE:")
    print(f"{'─'*60}")
    for ss in metrics["by_sample"]:
        err = " [ERROR]" if ss["error"] else ""
        print(f"  {ss['sample_id']:12s}: "
              f"{ss['passed']:3d}/{ss['total']:3d} = {ss['accuracy']:6.2f}%{err}")

    print(f"{'='*60}\n")


# ---------------------------------------------------------------------------
# Health Check
# ---------------------------------------------------------------------------

def check_server(host: str, port: int) -> bool:
    """Check if iceCoder server is reachable."""
    url = f"http://{host}:{port}/api/memory/stats"
    try:
        resp = requests.get(url, timeout=5)
        return resp.status_code == 200
    except requests.RequestException:
        return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="LoCoMo Official Dataset Evaluation for iceCoder",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_locomo_official.py --max-qa 5          # Quick test: 5 QA only
  python run_locomo_official.py --sample-ids conv-26 conv-27
  python run_locomo_official.py --categories 1 2 3
  python run_locomo_official.py                     # Full run
        """,
    )
    parser.add_argument("--host", default="127.0.0.1",
                        help="iceCoder host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=3000,
                        help="iceCoder port (default: 3000)")
    parser.add_argument("--dataset", default=str(SCRIPT_DIR / "locomo10.json"),
                        help="Path to locomo10.json")
    parser.add_argument("--output", default=str(SCRIPT_DIR / "result_official.json"),
                        help="Output result file path")
    parser.add_argument("--sample-ids", nargs="+", default=None,
                        help="Only evaluate specific sample IDs (e.g. conv-26 conv-27)")
    parser.add_argument("--categories", nargs="+", type=int, default=None,
                        help="Only evaluate specific categories (1-5)")
    parser.add_argument("--max-qa", type=int, default=None,
                        help="Max QA questions per sample (for quick testing)")
    parser.add_argument("--threshold", type=float, default=0.6,
                        help="Fuzzy match threshold (default: 0.6)")
    parser.add_argument("--skip-health-check", action="store_true",
                        help="Skip server health check")
    parser.add_argument("--skip-inject", action="store_true",
                        help="Skip conversation injection (assume memory already loaded)")
    args = parser.parse_args()

    if requests is None:
        print("ERROR: requests not found. Install: pip install requests")
        sys.exit(1)

    logger.info("=" * 60)
    logger.info("LoCoMo Official Dataset Evaluation")
    logger.info(f"  Server:     {args.host}:{args.port}")
    logger.info(f"  Dataset:    {args.dataset}")
    logger.info(f"  Output:     {args.output}")
    logger.info(f"  Samples:    {args.sample_ids or 'all'}")
    logger.info(f"  Categories: {args.categories or 'all'}")
    logger.info(f"  Max QA:     {args.max_qa or 'unlimited'}")
    logger.info(f"  Threshold:  {args.threshold}")
    logger.info("=" * 60)

    # Health check
    if not args.skip_health_check:
        logger.info("Checking server health...")
        if not check_server(args.host, args.port):
            logger.error(
                f"Cannot reach iceCoder at {args.host}:{args.port}. "
                "Start it with: npm run dev:api"
            )
            sys.exit(1)
        logger.info("Server is healthy.")

    # Load dataset
    dataset_path = Path(args.dataset)
    if not dataset_path.exists():
        logger.error(f"Dataset not found: {dataset_path}")
        sys.exit(1)

    samples = load_dataset(str(dataset_path))

    # Filter samples
    if args.sample_ids:
        samples = [s for s in samples if s.get("sample_id") in args.sample_ids]
        logger.info(f"Filtered to {len(samples)} samples: {args.sample_ids}")

    if not samples:
        logger.error("No samples to evaluate")
        sys.exit(1)

    # Run evaluation
    start_time = time.time()
    sample_results = []

    for idx, sample in enumerate(samples):
        if args.skip_inject:
            # Skip injection, go straight to QA
            sample_id = sample.get("sample_id", f"sample-{idx}")
            qa_list = sample.get("qa", [])
            if args.categories:
                qa_list = [q for q in qa_list if q.get("category") in args.categories]
            if args.max_qa:
                qa_list = qa_list[:args.max_qa]

            logger.info(f"\n[{idx+1}/{len(samples)}] {sample_id} — QA only ({len(qa_list)} questions)")
            qa_results = run_qa_evaluation(args.host, args.port, qa_list, args.threshold)
            sample_results.append({
                "sample_id": sample_id,
                "total_qa": len(qa_list),
                "qa_results": qa_results,
                "error": None,
                "timing": {},
            })
        else:
            result = evaluate_sample(
                args.host, args.port, sample, idx, len(samples),
                categories=args.categories,
                max_qa=args.max_qa,
                threshold=args.threshold,
            )
            sample_results.append(result)

    elapsed = round(time.time() - start_time, 1)
    logger.info(f"\nTotal evaluation time: {elapsed}s")

    # Compute metrics
    metrics = compute_metrics(sample_results)
    metrics["metadata"] = {
        "timestamp": datetime.now().isoformat(),
        "host": args.host,
        "port": args.port,
        "dataset": str(dataset_path),
        "elapsed_seconds": elapsed,
        "threshold": args.threshold,
        "sample_ids": args.sample_ids,
        "categories": args.categories,
        "max_qa": args.max_qa,
    }
    metrics["details"] = sample_results

    # Save results
    output_path = Path(args.output)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)
    logger.info(f"Results saved to {output_path}")

    # Print summary
    print_summary(metrics)
    print(f"Detailed results: {output_path}")
    print(f"Log file: {LOG_FILE}")


if __name__ == "__main__":
    main()
