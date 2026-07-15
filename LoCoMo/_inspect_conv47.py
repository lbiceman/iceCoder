# -*- coding: utf-8 -*-
import json
import sys

with open('LoCoMo/locomo10.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

conv47 = None
for s in data:
    if s.get('sample_id') == 'conv-47':
        conv47 = s
        break

if not conv47:
    print("conv-47 not found!")
    sys.exit(1)

print("=== conv-47 Sample ===")
print(f"Keys: {list(conv47.keys())}")

conv = conv47.get('conversation', {})
print(f"\nConversation keys: {list(conv.keys())[:15]}")
print(f"speaker_a: {conv.get('speaker_a')}")
print(f"speaker_b: {conv.get('speaker_b')}")

# Count sessions
sess_keys = [k for k in conv if k.startswith('session_') and not k.endswith('_date_time')]
print(f"Sessions: {len(sess_keys)}")

# First session date
print(f"session_1_date_time: {conv.get('session_1_date_time', 'N/A')}")

# First session content preview
if 'session_1' in conv:
    turns = conv['session_1']
    print(f"\nSession 1: {len(turns)} turns")
    for t in turns[:3]:
        print(f"  {t.get('speaker')}: {t.get('text','')[:100]}")

# QA stats
qa_list = conv47.get('qa', [])
print(f"\n=== QA ===")
print(f"Total QA: {len(qa_list)}")

# Category distribution
from collections import Counter
cat_counts = Counter(q.get('category', 0) for q in qa_list)
print(f"By category: {dict(cat_counts)}")

# First few QA
for q in qa_list[:5]:
    print(f"  cat={q.get('category')} Q={q.get('question','')[:80]}")
    print(f"    A={str(q.get('answer',''))[:80]}")
