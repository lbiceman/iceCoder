"""Test the frontmatter update logic in Python to verify correctness."""

def update_recall_metadata(content: str, new_count: int, now: str) -> str:
    """Mirror the TypeScript logic exactly."""
    updated = content

    # Update or insert recallCount
    if 'recallCount:' in updated:
        import re
        updated = re.sub(r'recallCount:\s*\d+', f'recallCount: {new_count}', updated)
    else:
        fm_start = updated.index('---')
        fm_end = updated.index('---', fm_start + 3)
        if fm_end > 0:
            updated = updated[:fm_end] + f'recallCount: {new_count}\n' + updated[fm_end:]

    # Update or insert lastRecalledAt
    if 'lastRecalledAt:' in updated:
        import re
        updated = re.sub(r'lastRecalledAt:\s*\S+', f'lastRecalledAt: {now}', updated)
    else:
        fm_start = updated.index('---')
        fm_end = updated.index('---', fm_start + 3)
        if fm_end > 0:
            updated = updated[:fm_end] + f'lastRecalledAt: {now}\n' + updated[fm_end:]

    return updated


# Test 1: Both fields already exist
print("=== Test 1: Both exist ===")
content1 = """---
name: test
recallCount: 3
lastRecalledAt: 2026-01-01T00:00:00.000Z
---

Body content here.
"""
result1 = update_recall_metadata(content1, 4, "2026-04-30T12:00:00.000Z")
print(result1)
assert 'recallCount: 4' in result1
assert 'lastRecalledAt: 2026-04-30T12:00:00.000Z' in result1
assert result1.startswith('---\n')
print("PASS\n")

# Test 2: Neither field exists
print("=== Test 2: Neither exists ===")
content2 = """---
name: test
type: session_summary
confidence: 0.9
---

Body content here.
"""
result2 = update_recall_metadata(content2, 1, "2026-04-30T12:00:00.000Z")
print(result2)
assert 'recallCount: 1' in result2
assert 'lastRecalledAt: 2026-04-30T12:00:00.000Z' in result2
assert result2.startswith('---\n')
# Verify frontmatter is still valid (starts with --- and has closing ---)
lines = result2.strip().split('\n')
assert lines[0] == '---'
fm_end_idx = None
for i in range(1, len(lines)):
    if lines[i] == '---':
        fm_end_idx = i
        break
assert fm_end_idx is not None, "No closing --- found"
print("PASS\n")

# Test 3: Only recallCount exists
print("=== Test 3: Only recallCount exists ===")
content3 = """---
name: test
recallCount: 5
---

Body.
"""
result3 = update_recall_metadata(content3, 6, "2026-04-30T12:00:00.000Z")
print(result3)
assert 'recallCount: 6' in result3
assert 'lastRecalledAt: 2026-04-30T12:00:00.000Z' in result3
assert result3.startswith('---\n')
print("PASS\n")

# Test 4: Real locomo file format
print("=== Test 4: Real locomo file ===")
content4 = """---
name: conv-26 session 1 summary
description: Structured summary of conv-26 session 1
type: session_summary
source: locomo_eval_llm
confidence: 0.9
tags: conv-26, session_1, Caroline, Melanie
createdAt: 2026-04-30T02:24:23.000Z
recallCount: 0
---

# conv-26 — Session 1
Caroline attended LGBTQ support group on 7 May 2023.
"""
result4 = update_recall_metadata(content4, 1, "2026-04-30T12:00:00.000Z")
print(result4)
assert result4.startswith('---\n')
assert 'recallCount: 1' in result4
assert 'lastRecalledAt: 2026-04-30T12:00:00.000Z' in result4
# Verify body is intact
assert 'Caroline attended LGBTQ' in result4
print("PASS\n")

print("ALL TESTS PASSED!")
