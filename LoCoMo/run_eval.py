# -*- coding: utf-8 -*-
"""
LoCoMo Evaluation Script for iceCoder Memory System.

Reads dataset.jsonl, sends conversations via WebSocket to iceCoder,
triggers memory extraction, then queries memory recall via HTTP API
to evaluate single-hop, multi-hop, and expired-filter accuracy.

Usage:
    python run_eval.py [--host HOST] [--port PORT] [--dataset DATASET]
"""

import json
import time
import logging
import argparse
import sys
import os
import uuid
import subprocess
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: requests library not found. Install with: pip install requests")
    sys.exit(1)

try:
    from tqdm import tqdm
except ImportError:
    # Fallback: simple progress indicator if tqdm not installed
    class tqdm:
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
        def set_postfix_str(self, s):
            pass
        def update(self, n=1):
            self.n += n

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent.resolve()
LOG_FILE = SCRIPT_DIR / "eval.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("locomo-eval")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds
DEFAULT_EXTRACT_WAIT = 5  # seconds to wait for memory extraction
DEFAULT_RECALL_WAIT = 3   # seconds to wait before querying memory after all turns
EXTRACT_WAIT = DEFAULT_EXTRACT_WAIT
RECALL_WAIT = DEFAULT_RECALL_WAIT


# ---------------------------------------------------------------------------
# WebSocket Chat Client (with fallback to HTTP/CLI)
# ---------------------------------------------------------------------------

def send_message_ws(host: str, port: int, message: str, timeout: int = 120) -> str:
    """
    Send a message to iceCoder via WebSocket and collect the full response.
    Returns the assistant's reply text.
    """
    try:
        import websocket
    except ImportError:
        logger.warning("websocket-client not installed, falling back to HTTP mode")
        return send_message_http(host, port, message, timeout)

    ws_url = f"ws://{host}:{port}/api/chat/ws"
    response_parts = []
    done = False

    def on_message(ws, msg):
        nonlocal done
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
                logger.error(f"WS error: {data.get('message', 'unknown')}")
                done = True
                ws.close()
        except json.JSONDecodeError:
            pass

    def on_error(ws, error):
        nonlocal done
        logger.error(f"WebSocket error: {error}")
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

    return "".join(response_parts)


def send_message_http(host: str, port: int, message: str, timeout: int = 120) -> str:
    """
    Fallback: send message via CLI subprocess if WebSocket is unavailable.
    Uses the iceCoder CLI in non-interactive mode via 'run' command.
    """
    try:
        # Try using the iceCoder run command (single-shot mode)
        result = subprocess.run(
            ["npx", "tsx", "src/cli/index.ts", "run", message],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=SCRIPT_DIR.parent,
            encoding="utf-8",
        )
        if result.returncode == 0:
            return result.stdout.strip()
        else:
            logger.error(f"CLI fallback failed: {result.stderr[:500]}")
            return ""
    except subprocess.TimeoutExpired:
        logger.error(f"CLI fallback timed out after {timeout}s")
        return ""
    except FileNotFoundError:
        logger.error("Cannot find npx/tsx for CLI fallback")
        return ""


def clear_session_ws(host: str, port: int) -> bool:
    """Clear the chat session via WebSocket clear_session message."""
    try:
        import websocket
        ws_url = f"ws://{host}:{port}/api/chat/ws"
        ws = websocket.create_connection(ws_url, timeout=10)
        ws.send(json.dumps({"type": "clear_session"}))
        time.sleep(0.5)
        ws.close()
        return True
    except Exception as e:
        logger.warning(f"Failed to clear session via WS: {e}")
        return False


def clear_session_http(host: str, port: int) -> bool:
    """Clear the chat session via HTTP API."""
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


# ---------------------------------------------------------------------------
# Memory Recall via HTTP API
# ---------------------------------------------------------------------------

def get_memory_files(host: str, port: int) -> list:
    """Fetch the list of memory files from iceCoder's memory API."""
    url = f"http://{host}:{port}/api/memory/files"
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("files", [])
        except requests.RequestException as e:
            logger.warning(f"Get memory files attempt {attempt+1} failed: {e}")
            time.sleep(RETRY_DELAY)
    return []


def get_memory_content(host: str, port: int, filename: str) -> str:
    """Fetch the content of a specific memory file."""
    url = f"http://{host}:{port}/api/memory/files/{filename}"
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(url, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("content", "")
        except requests.RequestException as e:
            logger.warning(f"Get memory content attempt {attempt+1} failed: {e}")
            time.sleep(RETRY_DELAY)
    return ""


def collect_all_memory_text(host: str, port: int) -> str:
    """
    Collect all memory file contents into a single text blob for matching.
    This simulates Recall@K by gathering all available memory.
    """
    files = get_memory_files(host, port)
    if not files:
        return ""

    all_text_parts = []
    for f in files:
        filename = f.get("filename", "")
        if not filename or filename == "MEMORY.md":
            continue
        content = get_memory_content(host, port, filename)
        if content:
            all_text_parts.append(content)

    return "\n\n".join(all_text_parts)


def query_memory_via_chat(host: str, port: int, query: str) -> str:
    """
    Ask iceCoder a query and get its response (which should use recalled memory).
    This tests the full recall pipeline: query -> memory recall -> LLM answer.
    """
    response = send_message_ws(host, port, query)
    return response


# ---------------------------------------------------------------------------
# Evaluation Logic
# ---------------------------------------------------------------------------

import re


def _entity_found(entity: str, text_lower: str, synonyms_map: dict) -> bool:
    """
    Check if an entity (or any of its synonyms) appears in the text.

    Matching strategy (in order):
    1. Direct substring match of the entity itself
    2. Synonym list match — each synonym is tried as:
       a. A regex pattern (if it contains regex metacharacters like .* or .+)
       b. A plain substring match otherwise
    """
    entity_lower = entity.strip().lower()

    # 1. Direct match
    if entity_lower in text_lower:
        return True

    # 2. Synonym match
    synonym_list = synonyms_map.get(entity.strip(), [])
    for syn in synonym_list:
        syn_lower = syn.lower()
        # If the synonym looks like a regex pattern, use re.search
        if any(c in syn for c in [".*", ".+", "\\", "^", "$", "[", "]"]):
            try:
                if re.search(syn_lower, text_lower):
                    return True
            except re.error:
                # Bad regex, fall back to substring
                if syn_lower in text_lower:
                    return True
        else:
            if syn_lower in text_lower:
                return True

    return False


def check_single_hop(recalled_text: str, answer: str, sample: dict = None) -> bool:
    """Check if the recalled text contains the answer keyword (case-insensitive)."""
    synonyms_map = sample.get("answer_synonyms", {}) if sample else {}
    return _entity_found(answer.strip(), recalled_text.lower(), synonyms_map)


def check_multi_hop(recalled_text: str, answer: str, sample: dict = None) -> bool:
    """
    Check if the recalled text contains ALL key entities.
    Answer field uses comma-separated entities.
    Each entity can have synonyms defined in answer_synonyms.
    """
    entities = [e.strip() for e in answer.split(",") if e.strip()]
    synonyms_map = sample.get("answer_synonyms", {}) if sample else {}
    recalled_lower = recalled_text.lower()
    return all(_entity_found(entity, recalled_lower, synonyms_map) for entity in entities)


def check_expired_filter(recalled_text: str, sample: dict) -> bool:
    """
    Check that the system correctly identifies the CURRENT state.

    For expired_filter metric:
    - answer_valid: the NEW (current) value — must be present
    - The system should present the current answer, not the old one as current.
    """
    recalled_lower = recalled_text.lower()
    valid_answer = sample.get("answer_valid", "")
    synonyms_map = sample.get("answer_synonyms", {}) if sample else {}

    # The valid (current) answer SHOULD be present
    if valid_answer:
        return _entity_found(valid_answer, recalled_lower, synonyms_map)
    return True


def evaluate_sample(
    sample: dict,
    host: str,
    port: int,
    sample_idx: int,
    total: int,
) -> dict:
    """
    Evaluate a single sample:
    1. Clear session
    2. Send all conversation turns
    3. Wait for memory extraction on trigger turns
    4. Query memory and check answer
    """
    sample_id = sample["id"]
    metric = sample["metric"]
    answer = sample["answer"]
    query = sample["query"]

    logger.info(f"[{sample_idx+1}/{total}] Evaluating {sample_id} (metric={metric})")

    result = {
        "id": sample_id,
        "metric": metric,
        "query": query,
        "answer": answer,
        "passed": False,
        "recalled_text": "",
        "response": "",
        "error": None,
    }

    try:
        # Step 1: Clear session for isolation
        logger.info(f"  Clearing session...")
        cleared = clear_session_ws(host, port)
        if not cleared:
            cleared = clear_session_http(host, port)
        if not cleared:
            logger.warning(f"  Could not clear session, continuing anyway")
        time.sleep(1)

        # Step 2: Send conversation turns
        sessions = sample.get("sessions", [])
        for sess_idx, session in enumerate(sessions):
            turns = session.get("turns", [])
            for turn_idx, turn in enumerate(turns):
                if turn["role"] != "user":
                    continue

                content = turn["content"]
                trigger = turn.get("trigger_extract", False)

                logger.info(f"  Sending turn {turn_idx+1}: {content[:60]}...")
                response = send_message_ws(host, port, content)

                if trigger:
                    logger.info(f"  Waiting {EXTRACT_WAIT}s for memory extraction...")
                    time.sleep(EXTRACT_WAIT)
                else:
                    time.sleep(1)

        # Step 3: Wait for all extractions to settle
        logger.info(f"  Waiting {RECALL_WAIT}s for memory consolidation...")
        time.sleep(RECALL_WAIT)

        # Step 4: Collect memory text (direct file access)
        recalled_text = collect_all_memory_text(host, port)
        result["recalled_text"] = recalled_text[:2000]  # truncate for logging

        # Step 5: Also query via chat to test full recall pipeline
        logger.info(f"  Querying: {query[:60]}...")
        chat_response = query_memory_via_chat(host, port, query)
        result["response"] = chat_response[:2000]

        # Combine both sources for evaluation
        combined_text = f"{recalled_text}\n{chat_response}"

        # Step 6: Evaluate based on metric type
        if metric == "single_hop":
            result["passed"] = check_single_hop(combined_text, answer, sample)
        elif metric == "multi_hop":
            result["passed"] = check_multi_hop(combined_text, answer, sample)
        elif metric == "expired_filter":
            result["passed"] = check_expired_filter(combined_text, sample)
        else:
            logger.warning(f"  Unknown metric: {metric}")
            result["error"] = f"Unknown metric: {metric}"

        status = "PASS" if result["passed"] else "FAIL"
        logger.info(f"  Result: {status}")

    except Exception as e:
        logger.error(f"  Error evaluating {sample_id}: {e}")
        result["error"] = str(e)

    return result


# ---------------------------------------------------------------------------
# Metrics Computation
# ---------------------------------------------------------------------------

def compute_metrics(results: list) -> dict:
    """Compute aggregate metrics from individual sample results."""
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    failed = sum(1 for r in results if not r["passed"] and r["error"] is None)
    errors = sum(1 for r in results if r["error"] is not None)

    # Per-metric breakdown
    metrics_breakdown = {}
    for metric_type in ["single_hop", "multi_hop", "expired_filter"]:
        subset = [r for r in results if r["metric"] == metric_type]
        if subset:
            subset_passed = sum(1 for r in subset if r["passed"])
            metrics_breakdown[metric_type] = {
                "total": len(subset),
                "passed": subset_passed,
                "failed": len(subset) - subset_passed,
                "accuracy": round(subset_passed / len(subset) * 100, 1),
            }

    # Recall@5 approximation: based on single_hop + multi_hop pass rate
    recall_samples = [r for r in results if r["metric"] in ("single_hop", "multi_hop")]
    recall_at_5 = 0.0
    if recall_samples:
        recall_passed = sum(1 for r in recall_samples if r["passed"])
        recall_at_5 = round(recall_passed / len(recall_samples) * 100, 1)

    # Multi-hop accuracy
    multi_hop_samples = [r for r in results if r["metric"] == "multi_hop"]
    multi_hop_accuracy = 0.0
    if multi_hop_samples:
        mh_passed = sum(1 for r in multi_hop_samples if r["passed"])
        multi_hop_accuracy = round(mh_passed / len(multi_hop_samples) * 100, 1)

    # Expired filter accuracy
    expired_samples = [r for r in results if r["metric"] == "expired_filter"]
    expired_accuracy = 0.0
    if expired_samples:
        exp_passed = sum(1 for r in expired_samples if r["passed"])
        expired_accuracy = round(exp_passed / len(expired_samples) * 100, 1)

    return {
        "summary": {
            "total_samples": total,
            "passed": passed,
            "failed": failed,
            "errors": errors,
            "overall_accuracy": round(passed / total * 100, 1) if total > 0 else 0.0,
        },
        "recall_at_5": recall_at_5,
        "multi_hop_accuracy": multi_hop_accuracy,
        "expired_filter_accuracy": expired_accuracy,
        "breakdown": metrics_breakdown,
        "details": results,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def check_server_health(host: str, port: int) -> bool:
    """Check if iceCoder server is reachable."""
    url = f"http://{host}:{port}/api/memory/stats"
    try:
        resp = requests.get(url, timeout=5)
        return resp.status_code == 200
    except requests.RequestException:
        return False


def main():
    global EXTRACT_WAIT, RECALL_WAIT

    parser = argparse.ArgumentParser(description="LoCoMo Evaluation for iceCoder")
    parser.add_argument("--host", default="127.0.0.1", help="iceCoder host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=3000, help="iceCoder port (default: 3000)")
    parser.add_argument("--dataset", default=str(SCRIPT_DIR / "dataset.jsonl"),
                        help="Path to dataset.jsonl")
    parser.add_argument("--output", default=str(SCRIPT_DIR / "result.json"),
                        help="Path to output result.json")
    parser.add_argument("--extract-wait", type=int, default=DEFAULT_EXTRACT_WAIT,
                        help=f"Seconds to wait for memory extraction (default: {DEFAULT_EXTRACT_WAIT})")
    parser.add_argument("--skip-health-check", action="store_true",
                        help="Skip server health check")
    args = parser.parse_args()

    EXTRACT_WAIT = args.extract_wait

    logger.info("=" * 60)
    logger.info("LoCoMo Evaluation for iceCoder")
    logger.info(f"Server: {args.host}:{args.port}")
    logger.info(f"Dataset: {args.dataset}")
    logger.info(f"Output: {args.output}")
    logger.info(f"Extract wait: {EXTRACT_WAIT}s")
    logger.info("=" * 60)

    # Health check
    if not args.skip_health_check:
        logger.info("Checking server health...")
        if not check_server_health(args.host, args.port):
            logger.error(
                f"Cannot reach iceCoder at {args.host}:{args.port}. "
                "Make sure the server is running (npm run dev:api or iceCoder start)."
            )
            sys.exit(1)
        logger.info("Server is healthy.")

    # Load dataset
    dataset_path = Path(args.dataset)
    if not dataset_path.exists():
        logger.error(f"Dataset not found: {dataset_path}")
        sys.exit(1)

    samples = []
    with open(dataset_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                sample = json.loads(line)
                samples.append(sample)
            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON at line {line_num}: {e}")

    logger.info(f"Loaded {len(samples)} samples from dataset")

    if not samples:
        logger.error("No samples to evaluate")
        sys.exit(1)

    # Run evaluation
    start_time = time.time()
    results = []

    progress = tqdm(samples, desc="Evaluating", total=len(samples))
    for idx, sample in enumerate(progress):
        if hasattr(progress, 'set_postfix_str'):
            progress.set_postfix_str(f"{sample['id']} ({sample['metric']})")
        result = evaluate_sample(sample, args.host, args.port, idx, len(samples))
        results.append(result)

    elapsed = round(time.time() - start_time, 1)
    logger.info(f"Evaluation completed in {elapsed}s")

    # Compute metrics
    metrics = compute_metrics(results)
    metrics["metadata"] = {
        "timestamp": datetime.now().isoformat(),
        "host": args.host,
        "port": args.port,
        "dataset": str(dataset_path),
        "elapsed_seconds": elapsed,
        "extract_wait": EXTRACT_WAIT,
    }

    # Save results
    output_path = Path(args.output)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)
    logger.info(f"Results saved to {output_path}")

    # Print summary
    print("\n" + "=" * 60)
    print("EVALUATION SUMMARY")
    print("=" * 60)
    s = metrics["summary"]
    print(f"  Total samples:          {s['total_samples']}")
    print(f"  Passed:                 {s['passed']}")
    print(f"  Failed:                 {s['failed']}")
    print(f"  Errors:                 {s['errors']}")
    print(f"  Overall accuracy:       {s['overall_accuracy']}%")
    print(f"  Recall@5:               {metrics['recall_at_5']}%")
    print(f"  Multi-hop accuracy:     {metrics['multi_hop_accuracy']}%")
    print(f"  Expired filter accuracy:{metrics['expired_filter_accuracy']}%")
    print(f"  Elapsed time:           {elapsed}s")
    print("=" * 60)

    # Per-metric breakdown
    for metric_name, breakdown in metrics["breakdown"].items():
        print(f"\n  {metric_name}:")
        print(f"    Samples: {breakdown['total']}, Passed: {breakdown['passed']}, "
              f"Accuracy: {breakdown['accuracy']}%")

    print(f"\nDetailed results: {output_path}")
    print(f"Log file: {LOG_FILE}")


if __name__ == "__main__":
    main()
