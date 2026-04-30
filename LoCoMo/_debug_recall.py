"""Debug: simulate what the LLM sees during recall."""
import json, sys
sys.path.insert(0, "LoCoMo")
from evaluator_judge import _get_config
import requests

cfg = _get_config()

# Get memory file list
r = requests.get("http://127.0.0.1:3000/api/memory/files", timeout=10)
files = r.json().get("files", [])

print(f"Memory files: {len(files)}")
for f in files[:5]:
    print(f"  {f['filename']} type={f.get('type','?')} desc={f.get('description','')[:60]}")

# Simulate the manifest that LLM sees
print("\n--- Simulated Manifest ---")
for f in files:
    if f['filename'].startswith('locomo_'):
        tag = f"[{f.get('type','')}] " if f.get('type') else ''
        desc = f.get('description', '')
        print(f"- {tag}{f['filename']}: {desc}")

# Now call the recall API and see what happens
print("\n--- Recall Test ---")
queries = [
    "When did Caroline go to the LGBTQ support group?",
    "What did Caroline research?",
    "When did Melanie paint a sunrise?",
]
for q in queries:
    r = requests.post("http://127.0.0.1:3000/api/memory/recall",
                       json={"query": q, "topK": 10}, timeout=30)
    d = r.json()
    recalled = [f['filename'] for f in d.get('files', [])]
    print(f"Q: {q}")
    print(f"  recalled={d.get('recalled')} usedLLM={d.get('usedLLM')} files={recalled}")
    print()
