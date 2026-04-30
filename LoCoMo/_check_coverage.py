import json
d = json.load(open("LoCoMo/locomo10.json", encoding="utf-8"))
s = d[0]
count = 0
for q in s["qa"]:
    evs = q.get("evidence", [])
    if any(e.startswith("D1:") for e in evs) and count < 5:
        ans = q.get("answer", q.get("adversarial_answer", "N/A"))
        print(f"Q: {q['question']}")
        print(f"A: {ans}  (cat={q['category']}, evidence={evs})")
        print()
        count += 1
