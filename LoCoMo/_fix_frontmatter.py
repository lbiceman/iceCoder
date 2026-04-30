"""Fix broken frontmatter in memory files — merge double frontmatter blocks."""
import re
from pathlib import Path

memory_dir = Path("data/memory-files")
fixed = 0

for f in sorted(memory_dir.glob("locomo_*.md")):
    content = f.read_text(encoding="utf-8")
    
    # Detect double frontmatter: ---\nfield\n---\nfield\n---
    # Merge all frontmatter fields into one block
    lines = content.split("\n")
    
    fm_fields = []
    body_start = 0
    in_fm = False
    fm_count = 0
    
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "---":
            fm_count += 1
            if fm_count == 1:
                in_fm = True
            elif in_fm:
                # Check if next line is also a frontmatter field (double block)
                if i + 1 < len(lines) and ":" in lines[i + 1] and not lines[i + 1].startswith("#"):
                    continue  # Skip this middle ---
                else:
                    in_fm = False
                    body_start = i + 1
                    break
        elif in_fm and ":" in stripped:
            fm_fields.append(line)
    
    if fm_count < 2:
        continue  # Not a frontmatter file
    
    # Deduplicate fields (keep last value for each key)
    seen = {}
    for field in fm_fields:
        key = field.split(":")[0].strip()
        seen[key] = field
    
    # Rebuild file
    body = "\n".join(lines[body_start:])
    new_content = "---\n" + "\n".join(seen.values()) + "\n---\n" + body
    
    if new_content != content:
        f.write_text(new_content, encoding="utf-8")
        fixed += 1
        print(f"  Fixed: {f.name} ({len(seen)} fields)")

print(f"\nFixed {fixed} files")
