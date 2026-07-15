import json

data = json.load(open('result_official_v13_full.json', 'r', encoding='utf-8'))

cats = {}
for d in data['details']:
    for qa in d['qa_results']:
        c = qa['category']
        if c not in cats:
            cats[c] = []
        cats[c].append(qa)

print("=== Failure Analysis by Category ===")
for c in sorted(cats.keys()):
    v = cats[c]
    total = len(v)
    passed = sum(1 for x in v if x.get('passed'))
    borderline = sum(1 for x in v if 0.3 <= x.get('score', 0) < 0.6)
    wrong = sum(1 for x in v if x.get('score', 0) < 0.3)
    print(f"Cat {c}: total={total}, passed={passed}, borderline={borderline}, completely_wrong={wrong}")

print("\n=== No-memory responses ===")
no_memory = 0
for d in data['details']:
    for qa in d['qa_results']:
        resp = qa.get('response', '')
        if '没有' in resp or "don't" in resp.lower() or 'sorry' in resp.lower() or 'no memory' in resp.lower() or '抱歉' in resp or 'not sure' in resp.lower() or 'no information' in resp.lower() or 'no relevant' in resp.lower():
            no_memory += 1
print(f"Total no-memory responses: {no_memory}")

print("\n=== Score distribution ===")
scores = [qa.get('score', 0) for d in data['details'] for qa in d['qa_results']]
print(f"Mean: {sum(scores)/len(scores):.3f}")
print(f"Median: {sorted(scores)[len(scores)//2]:.3f}")
print(f"Min: {min(scores):.3f}")
print(f"Max: {max(scores):.3f}")

print("\n=== Questions with score 0.0-0.1 (completely wrong) ===")
zero_score = []
for d in data['details']:
    for qa in d['qa_results']:
        if qa.get('score', 0) < 0.1:
            zero_score.append(qa)
print(f"Count: {len(zero_score)}")

print("\n=== Questions with score 0.1-0.3 (mostly wrong) ===")
low_score = []
for d in data['details']:
    for qa in d['qa_results']:
        if 0.1 <= qa.get('score', 0) < 0.3:
            low_score.append(qa)
print(f"Count: {len(low_score)}")

print("\n=== Questions with score 0.3-0.6 (borderline) ===")
borderline = []
for d in data['details']:
    for qa in d['qa_results']:
        if 0.3 <= qa.get('score', 0) < 0.6:
            borderline.append(qa)
print(f"Count: {len(borderline)}")

print("\n=== Questions with score 0.6-0.8 (mostly correct) ===")
mostly_correct = []
for d in data['details']:
    for qa in d['qa_results']:
        if 0.6 <= qa.get('score', 0) < 0.8:
            mostly_correct.append(qa)
print(f"Count: {len(mostly_correct)}")

print("\n=== Questions with score 0.8-1.0 (correct) ===")
correct = []
for d in data['details']:
    for qa in d['qa_results']:
        if 0.8 <= qa.get('score', 0) <= 1.0:
            correct.append(qa)
print(f"Count: {len(correct)}")
