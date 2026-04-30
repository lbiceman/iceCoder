"""Quick test: extract memories from one session."""
import json, sys
sys.path.insert(0, "LoCoMo")
from evaluator_judge import extract_memories_from_session, _get_config

cfg = _get_config()
d = json.load(open("LoCoMo/locomo10.json", encoding="utf-8"))
s = d[0]  # conv-26
conv = s["conversation"]

# Session 1
turns = conv["session_1"]
transcript = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns if t.get("text"))
dt = conv.get("session_1_date_time", "")

print(f"Session 1 ({len(turns)} turns, dt={dt})")
print(f"Transcript length: {len(transcript)} chars")
print()

memories = extract_memories_from_session(
    transcript=transcript,
    datetime_str=dt,
    speaker_a=conv["speaker_a"],
    speaker_b=conv["speaker_b"],
    cfg=cfg,
)

print(f"Extracted {len(memories)} memory items:\n")
for i, m in enumerate(memories):
    print(f"  [{i+1}] {m.get('name', 'N/A')}")
    print(f"      {m.get('description', 'N/A')}")
    print(f"      tags: {m.get('tags', [])}")
    print()
