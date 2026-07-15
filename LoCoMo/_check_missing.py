"""Check how many QA items depend on missing sessions."""
import json

d = json.load(open("LoCoMo/locomo10.json", "r", encoding="utf-8"))
s = [x for x in d if x["sample_id"] == "conv-26"][0]
qa = s.get("qa", [])

# Keywords from missing sessions
keywords = [
    "oscar", "guinea pig", "bailey", "activist", "connected lgbtq",
    "biking", "pet", "horse", "carrot", "slipper", "bone",
    "yellow leaves", "roasted", "creating art", "how long",
]

print("=== QA items potentially affected by missing sessions (s10, s13, s16) ===\n")
count = 0
for i, q in enumerate(qa):
    question = q.get("question", "").lower()
    answer = str(q.get("answer", "")).lower()
    cat = q.get("category", 0)
    for kw in keywords:
        if kw in answer or kw in question:
            print(f"  Q{i} (cat{cat}): {q['question'][:80]}")
            print(f"    A: {answer[:120]}")
            count += 1
            break

print(f"\nTotal potentially affected by keyword match: {count}")

# Also check the v12 results for tool_call responses (model tried to call tools instead of answering)
r = json.load(open("LoCoMo/result_official_v12_test.json", "r", encoding="utf-8"))
tool_call_count = 0
for detail in r.get("details", []):
    for item in detail.get("qa_results", []):
        resp = item.get("response", "")
        if "<tool_call>" in resp or "read_file" in resp:
            tool_call_count += 1

print(f"\nResponses containing tool_call/read_file: {tool_call_count}/199")
