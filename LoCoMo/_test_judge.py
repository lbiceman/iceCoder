"""Quick test of the LLM judge."""
import sys
sys.path.insert(0, "LoCoMo")
from evaluator_judge import judge_qa, judge_adversarial, _get_config

cfg = _get_config()
print(f"Config: model={cfg['model']}, base_url={cfg['base_url']}")
print(f"API key: {cfg['api_key'][:8]}...{cfg['api_key'][-4:]}")
print()

# Test 1: Correct answer
print("--- Test 1: Correct match ---")
r = judge_qa("When did Caroline go to the LGBTQ support group?",
             "7 May 2023",
             "Caroline went to the LGBTQ support group on May 7th, 2023.",
             cfg=cfg)
print(f"  verdict={r['verdict']}, confidence={r['confidence']}, reason={r['reason']}")

# Test 2: Wrong answer
print("\n--- Test 2: Wrong answer ---")
r = judge_qa("When did Caroline go to the LGBTQ support group?",
             "7 May 2023",
             "I think it was sometime in December 2022.",
             cfg=cfg)
print(f"  verdict={r['verdict']}, confidence={r['confidence']}, reason={r['reason']}")

# Test 3: Adversarial - model refuses (good)
print("\n--- Test 3: Adversarial - model refuses ---")
r = judge_adversarial(
    question="What did Caroline realize after her charity race?",
    response="I don't have enough information to answer that question.",
    adversarial_answer="self-care is important",
    correct_answer=None,
    cfg=cfg,
)
print(f"  verdict={r['verdict']}, confidence={r['confidence']}, reason={r['reason']}")

# Test 4: Adversarial - model gives wrong answer (bad)
print("\n--- Test 4: Adversarial - model gives adversarial answer ---")
r = judge_adversarial(
    question="What did Caroline realize after her charity race?",
    response="Caroline realized that self-care is important.",
    adversarial_answer="self-care is important",
    correct_answer=None,
    cfg=cfg,
)
print(f"  verdict={r['verdict']}, confidence={r['confidence']}, reason={r['reason']}")

print("\nAll judge tests completed!")
