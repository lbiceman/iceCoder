"""Fix broken frontmatter in memory files."""
import re
from pathlib import Path

memory_dir = Path("data/memory-files")
fixed = 0

for f in sorted(memory_dir.glob("locomo_*.md")):
    content = f.read_text(encoding="utf-8")
    # Check if file starts without ---
    if not content.startswith("---"):
        # Find the first --- and prepend it
        content = "---\n" + content
        f.write_text(content, encoding="utf-8")
        fixed += 1
        print(f"  Fixed: {f.name}")

print(f"\nFixed {fixed} files")
