"""Pre-flight check: verify all dependencies and config before running."""
import sys
sys.path.insert(0, "LoCoMo")

print("=" * 50)
print("PRE-FLIGHT CHECK")
print("=" * 50)

# 1. Dependencies
print("\n[1] Dependencies:")
deps = {}
for mod in ["requests", "tqdm", "websocket"]:
    try:
        m = __import__(mod)
        deps[mod] = getattr(m, "__version__", "ok")
        print(f"  ✓ {mod} {deps[mod]}")
    except ImportError:
        print(f"  ✗ {mod} NOT FOUND")
        deps[mod] = None

# 2. Judge config
print("\n[2] Judge config:")
from evaluator_judge import _get_config
cfg = _get_config()
print(f"  model:    {cfg['model']}")
print(f"  base_url: {cfg['base_url']}")
print(f"  api_key:  {cfg['api_key'][:8]}...{cfg['api_key'][-4:]}")

# 3. Dataset
print("\n[3] Dataset:")
import json
from pathlib import Path
ds_path = Path("LoCoMo/locomo10.json")
if ds_path.exists():
    data = json.load(open(ds_path, encoding="utf-8"))
    total_qa = sum(len(s["qa"]) for s in data)
    sample_ids = [s["sample_id"] for s in data]
    print(f"  ✓ {len(data)} samples, {total_qa} QA pairs")
    print(f"  IDs: {', '.join(sample_ids)}")
else:
    print(f"  ✗ {ds_path} NOT FOUND")

# 4. Memory dir
print("\n[4] Memory directory:")
mem_dir = Path("data/memory-files")
if mem_dir.exists():
    files = [f.name for f in mem_dir.iterdir() if f.is_file()]
    print(f"  ✓ {mem_dir} exists, {len(files)} files")
else:
    print(f"  ✗ {mem_dir} NOT FOUND")

# 5. Quick judge API test
print("\n[5] Judge API connectivity:")
from evaluator_judge import judge_qa
try:
    r = judge_qa("What color is the sky?", "blue", "The sky is blue.", cfg=cfg)
    print(f"  ✓ verdict={r['verdict']}, confidence={r['confidence']}")
except Exception as e:
    print(f"  ✗ {e}")

print("\n" + "=" * 50)
print("PRE-FLIGHT COMPLETE")
print("=" * 50)

# Summary
issues = []
for mod, ver in deps.items():
    if ver is None:
        issues.append(f"Missing dependency: {mod}")
if not ds_path.exists():
    issues.append("Dataset not found")
if not cfg["api_key"]:
    issues.append("No API key configured")

if issues:
    print("\n⚠ ISSUES:")
    for i in issues:
        print(f"  - {i}")
else:
    print("\n✓ All checks passed. Ready to run:")
    print(f'  python LoCoMo/run_locomo_official.py')
    print(f'  python LoCoMo/run_locomo_official.py --max-qa 5  # quick test')
