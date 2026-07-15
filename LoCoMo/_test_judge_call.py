"""Test a single judge call through the actual evaluator_judge module."""
import sys
import logging
sys.path.insert(0, "LoCoMo")

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s [%(levelname)s] %(message)s")

from evaluator_judge import judge_qa, _get_config

cfg = _get_config()
print(f"Config: model={cfg['model']}, base_url={cfg['base_url']}")

result = judge_qa(
    question="When did Caroline go to the LGBTQ support group?",
    answer="7 May 2023",
    response="Caroline went to the LGBTQ support group on 7 May 2023.",
    cfg=cfg,
)
print(f"\nResult: {result}")
