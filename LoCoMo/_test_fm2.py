"""Test with 3 dashes in file."""

content = """---
name: test
type: session_summary
confidence: 0.9
tags: a, b
createdAt: 2026-01-01
---

# Body

Some content here.

---
*Footer line*
"""

print("Original:")
print(content)
print(f"--- count: {content.count('---')}")

# Simulate updateRecallMetadata
updated = content

# Insert recallCount (doesn't exist)
fm_start = updated.index('---')
fm_end = updated.index('---', fm_start + 3)
print(f"First ---: pos {fm_start}, Second ---: pos {fm_end}")
updated = updated[:fm_end] + 'recallCount: 1\n' + updated[fm_end:]

# Insert lastRecalledAt (doesn't exist)
fm_start2 = updated.index('---')
fm_end2 = updated.index('---', fm_start2 + 3)
print(f"After insert - First ---: pos {fm_start2}, Second ---: pos {fm_end2}")
updated = updated[:fm_end2] + 'lastRecalledAt: 2026-04-30\n' + updated[fm_end2:]

print("\nResult:")
print(updated)

# Verify
lines = updated.split('\n')
assert lines[0] == '---', f"First line should be ---, got: {lines[0]}"
# Find closing ---
fm_close = None
for i in range(1, len(lines)):
    if lines[i] == '---':
        fm_close = i
        break
assert fm_close is not None, "No closing --- found"
print(f"Frontmatter closes at line {fm_close}")
assert 'recallCount: 1' in '\n'.join(lines[1:fm_close])
assert 'lastRecalledAt: 2026-04-30' in '\n'.join(lines[1:fm_close])
assert '# Body' in updated
assert '*Footer line*' in updated
print("\nALL CHECKS PASSED!")
