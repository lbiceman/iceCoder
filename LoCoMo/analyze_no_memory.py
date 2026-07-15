import json

data = json.load(open('result_official_v13_full.json', 'r', encoding='utf-8'))

# Analyze no-memory responses by category
no_memory_by_cat = {}
total_by_cat = {}
for d in data['details']:
    for qa in d['qa_results']:
        c = qa['category']
        total_by_cat[c] = total_by_cat.get(c, 0) + 1
        resp = qa.get('response', '')
        if '没有' in resp or "don't" in resp.lower() or 'sorry' in resp.lower() or 'no memory' in resp.lower() or '抱歉' in resp or 'not sure' in resp.lower() or 'no information' in resp.lower() or 'no relevant' in resp.lower():
            no_memory_by_cat[c] = no_memory_by_cat.get(c, 0) + 1

print("=== No-memory responses by category ===")
for c in sorted(no_memory_by_cat.keys()):
    print(f"Cat {c}: {no_memory_by_cat[c]} / {total_by_cat[c]} ({no_memory_by_cat[c]/total_by_cat[c]*100:.1f}%)")

# Analyze failed questions that had memory but still failed
print("\n=== Failed questions WITH memory (score < 0.6 but not no-memory) ===")
failed_with_memory = []
for d in data['details']:
    for qa in d['qa_results']:
        if qa.get('score', 0) < 0.6:
            resp = qa.get('response', '')
            if not ('没有' in resp or "don't" in resp.lower() or 'sorry' in resp.lower() or 'no memory' in resp.lower() or '抱歉' in resp or 'not sure' in resp.lower() or 'no information' in resp.lower() or 'no relevant' in resp.lower()):
                failed_with_memory.append(qa)

print(f"Count: {len(failed_with_memory)}")

# Show some examples
print("\n=== Examples of failed questions WITH memory ===")
for i, qa in enumerate(failed_with_memory[:10]):
    print(f"\n--- Example {i+1} ---")
    print(f"Q: {qa['question']}")
    print(f"A: {qa['answer']}")
    print(f"R: {qa['response'][:200]}...")
    print(f"Score: {qa.get('score', 0)}")
    print(f"Reason: {qa.get('reason', 'N/A')[:200]}")
