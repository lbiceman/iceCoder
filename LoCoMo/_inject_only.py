"""Inject memories only (no QA evaluation)."""
import sys
import json
import time
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from run_locomo_official import (
    inject_conversations, clear_session, clear_memory_files,
    load_dataset, check_server,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

HOST = "127.0.0.1"
PORT = 3001
DATASET = str(Path(__file__).parent / "locomo10.json")
SAMPLE_ID = "conv-26"

def main():
    logger.info("=== Inject Only Mode ===")
    
    # Health check
    if not check_server(HOST, PORT):
        logger.error(f"Cannot reach iceCoder at {HOST}:{PORT}")
        sys.exit(1)
    logger.info("Server is healthy.")

    # Load dataset
    samples = load_dataset(DATASET)
    samples = [s for s in samples if s.get("sample_id") == SAMPLE_ID]
    if not samples:
        logger.error(f"Sample {SAMPLE_ID} not found")
        sys.exit(1)

    sample = samples[0]
    logger.info(f"Sample: {SAMPLE_ID}")

    # Clear
    logger.info("Clearing session and memory...")
    clear_session(HOST, PORT)
    clear_memory_files(HOST, PORT)
    time.sleep(1)

    # Inject
    logger.info("Injecting conversations...")
    t0 = time.time()
    file_count = inject_conversations(HOST, PORT, sample)
    elapsed = round(time.time() - t0, 1)
    logger.info(f"Done! {file_count} memory files written in {elapsed}s")

if __name__ == "__main__":
    main()
