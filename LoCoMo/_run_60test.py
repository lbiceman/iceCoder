# -*- coding: utf-8 -*-
"""Run LoCoMo 60test — 10 条 conv 合并为一次注入，目标 50–60 记忆文件。

环境变量（本脚本会自动设置较长超时，避免记忆注入/QA 中途过期）：
  ICE_EVAL_MODE=1 / ICE_DISABLE_TOOLS=1  — 需在 iceCoder 服务端同样设置
  LOCOMO_TARGET_FILES=60                 — bundled 注入，约 5 文件/session
  LOCOMO_EXTRACT_TIMEOUT=600  — 每 session 记忆提取（秒）
  LOCOMO_QA_TIMEOUT=600        — 每道 QA WebSocket（秒）
  LOCOMO_JUDGE_TIMEOUT=120     — Judge API（秒）
  ICE_OPENAI_REQUEST_TIMEOUT_MS=600000 — iceCoder LLM 请求（毫秒）

单次注入 `60test-cap55`：10 conv 精选 12 session + 20 道特色 QA
（跨 session 军事 aptitude、long-gap 慈善统计、Single-hop、Adversarial 等），约 60 文件。

Prerequisites (PowerShell):
    $env:ICE_EVAL_MODE="1"
    $env:ICE_DISABLE_TOOLS="1"
    npx tsx src/index.ts

Build / refresh dataset:
    py LoCoMo/build_locomo60test.py --verify

Run:
    py LoCoMo/_run_60test.py

Full documentation: LoCoMo/60test.md
"""
import json
import os
import sys
from pathlib import Path

# 长超时：记忆注入 + QA 评测耗时长，避免 requests/WebSocket 提前断开
os.environ.setdefault("LOCOMO_EXTRACT_TIMEOUT", "600")
os.environ.setdefault("LOCOMO_QA_TIMEOUT", "600")
os.environ.setdefault("LOCOMO_JUDGE_TIMEOUT", "120")
# 12 session × 5 files/session ≈ 60 记忆文件（bundled 注入，每文件含多条 fact）
os.environ.setdefault("LOCOMO_TARGET_FILES", "60")

SCRIPT_DIR = Path(__file__).parent.resolve()
DATASET = SCRIPT_DIR / "locomo60test.json"
MANIFEST = SCRIPT_DIR / "locomo60test.manifest.json"

sys.path.insert(0, str(SCRIPT_DIR))

if not DATASET.exists():
    print(f"Dataset missing: {DATASET}")
    print("Run: py LoCoMo/build_locomo60test.py --verify")
    sys.exit(1)

if MANIFEST.exists():
    with open(MANIFEST, "r", encoding="utf-8") as f:
        suite = json.load(f).get("_suite_meta", {})
    est = suite.get("estimated_memory_files", "?")
    print(f"[60test] 1 sample, {suite.get('qa_count', '?')} QA, "
          f"~{est} files target ({suite.get('target_files_min',50)}–{suite.get('target_files_max',60)})")
else:
    with open(DATASET, "r", encoding="utf-8") as f:
        n = len(json.load(f))
    print(f"[60test] {n} sub-samples (manifest missing, run build script)")

from evaluator_judge import _get_config

cfg = _get_config()
print(
    f"[60test] Judge/extract: model={cfg['model']}, "
    f"base_url={cfg['base_url']}, key={'set' if cfg['api_key'] else 'MISSING'}"
)

sys.argv = [
    "run_locomo_official.py",
    "--dataset", str(DATASET),
    "--sample-ids", "60test-cap55",
    "--port", "1024",
    "--output", str(SCRIPT_DIR / "result_60test.json"),
]
import run_locomo_official

run_locomo_official.main()
