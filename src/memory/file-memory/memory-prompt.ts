/**
 * 记忆提示词构建器。
 *
 * 构建注入到系统提示词中的记忆指令，告诉模型：
 * - 记忆目录在哪里
 * - 如何保存记忆（frontmatter 格式 + MEMORY.md 索引）
 * - 四种记忆类型及其使用场景
 * - 什么不该保存
 * - 何时访问记忆
 * - 如何验证记忆的新鲜度
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileMemoryConfig, EntrypointTruncation } from './types.js';
import { DEFAULT_FILE_MEMORY_CONFIG } from './memory-config.js';

/**
 * 截断 MEMORY.md 索引内容。
 * 先按行数截断（自然边界），再按字节截断（在最后一个换行符处切断，不切断行中间）。
 */
export function truncateEntrypointContent(
  raw: string,
  config: FileMemoryConfig = DEFAULT_FILE_MEMORY_CONFIG,
): EntrypointTruncation {
  const trimmed = raw.trim();
  const contentLines = trimmed.split('\n');
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > config.maxEntrypointLines;
  const wasByteTruncated = byteCount > config.maxEntrypointBytes;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, config.maxEntrypointLines).join('\n')
    : trimmed;

  if (truncated.length > config.maxEntrypointBytes) {
    const cutAt = truncated.lastIndexOf('\n', config.maxEntrypointBytes);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : config.maxEntrypointBytes);
  }

  const reason = wasByteTruncated && !wasLineTruncated
    ? `${byteCount} 字节（上限: ${config.maxEntrypointBytes}）— 索引条目过长`
    : wasLineTruncated && !wasByteTruncated
      ? `${lineCount} 行（上限: ${config.maxEntrypointLines}）`
      : `${lineCount} 行，${byteCount} 字节`;

  return {
    content: truncated + `\n\n> Warning: ${config.entrypointName} has ${reason}. Only partial content was loaded. Please keep index entries concise (no more than ~200 characters per line) and place detailed content in topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

/**
 * 确保记忆目录存在。幂等操作。
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  try {
    await fs.mkdir(memoryDir, { recursive: true });
  } catch (e) {
    console.log(`[memory] 创建记忆目录失败: ${memoryDir}`, e);
  }
}

/**
 * 构建记忆行为指令（纯英文，不含 MEMORY.md 内容）。
 *
 * 中文说明（供开发者阅读）：
 * - 持久化记忆系统：位于 memoryDir，模型可直接 write_file 写入
 * - 四种记忆类型：user（用户画像）、feedback（行为纠正/确认）、project（项目上下文）、reference（外部引用）
 * - 保存方式：写独立 .md 文件 + 在 MEMORY.md 中添加索引
 * - 多级加载：用户（全局）→ 项目（共享）→ 目录（私有），冲突以私有为准
 * - 验证规则：仅 stale/expired 记忆需要验证，fresh 记忆直接使用；不重复读已读文件
 */
export function buildMemoryInstructions(memoryDir: string): string {
  return `# Persistent Memory

You have a file-based persistent memory system at \`${memoryDir}\`. Use it as background context, not as a replacement for the user's current task.

**Do NOT write long-term memory files** unless the user explicitly asks you to remember something (e.g. "记住", "remember"). Install/deploy/download/config progress, command transcripts, and one-off task state belong in **session-notes** only — not in \`${memoryDir}\`.

Remove the entry when asked to forget. If told to ignore memory, treat MEMORY.md as empty.

## Memory Types (whitelist)

- **user**: Stable habits — comms, code style, Git, tests — only when explicit or repeated. Mentioning a tool once is NOT a habit.
- **feedback**: Reusable troubleshooting patterns — user corrections ("when X, expect Y"). NOT this session's error log.
- **project**: ONE overview per project — goals, architecture, intent not in README. NOT install paths/versions or command lists from package.json.

## How to Save (explicit request only)

Write a .md file with frontmatter, then add an index line in MEMORY.md:

\`\`\`markdown
---
name: {{memory name}}
description: {{one-line, specific, used for relevance matching}}
type: {{user | feedback | project}}
memoryCategory: {{stable_preference | explicit_rule | recurring_mistake | project_convention}}
---

{{content}}
\`\`\`

MEMORY.md index: one line per entry, ≤150 chars — \`- [Title](file.md) — summary\`

For ordinary coding/debugging/ops tasks, focus on the task. Background extraction handles incidental durable memories after the response; do not pause implementation to maintain memory files.

## Multi-level Memory

Three levels: user (global) → project (shared) → directory (private). On conflict, directory-level wins.

## Verify Before Citing

Memory entries are point-in-time snapshots — files may be renamed, deleted, or never merged.

- Only verify when a memory is marked "stale" or "expired". Fresh memories can be used directly.
- Do NOT re-read files you have already read in this conversation. Use what you already know.
- Stale memory conflicts with observation → trust observation, update or delete the stale entry.
`;
}

/**
 * 加载完整的记忆提示词（指令 + MEMORY.md 内容）。
 */
export async function loadMemoryPrompt(
  config: Partial<FileMemoryConfig> = {},
): Promise<string | null> {
  const cfg = { ...DEFAULT_FILE_MEMORY_CONFIG, ...config };

  await ensureMemoryDirExists(cfg.memoryDir);

  const instructions = buildMemoryInstructions(cfg.memoryDir);
  const entrypointPath = path.join(cfg.memoryDir, cfg.entrypointName);

  let entrypointContent = '';
  try {
    entrypointContent = await fs.readFile(entrypointPath, 'utf-8');
  } catch {
    // 还没有记忆文件
  }

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent, cfg);
    return `${instructions}\n## ${cfg.entrypointName}\n\n${t.content}`;
  }

  return `${instructions}\n## ${cfg.entrypointName}\n\nYour ${cfg.entrypointName} is currently empty. Memories you save will appear here.`;
}
