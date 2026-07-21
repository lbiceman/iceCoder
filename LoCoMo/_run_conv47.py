# -*- coding: utf-8 -*-
"""Run LoCoMo official eval for conv-47 only.

Prerequisites (PowerShell):
    $env:ICE_EVAL_MODE="1"
    $env:ICE_DISABLE_TOOLS="1"
    npx tsx src/index.ts

Then:
    py LoCoMo/_run_conv47.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from evaluator_judge import _get_config

cfg = _get_config()
print(f"[conv-47] MiMo config: model={cfg['model']}, base_url={cfg['base_url']}, key={'set' if cfg['api_key'] else 'MISSING'}")

sys.argv = [
    "run_locomo_official.py",
    "--sample-ids", "conv-47",
    "--port", "1024",
    "--output", str(Path(__file__).parent / "result_conv47.json"),
]
import run_locomo_official
run_locomo_official.main()
