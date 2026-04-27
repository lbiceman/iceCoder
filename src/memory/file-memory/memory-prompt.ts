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
    content: truncated + `\n\n> 警告: ${config.entrypointName} 有 ${reason}。只加载了部分内容。请保持索引条目简短（每行不超过 ~200 字符），将详细内容放入主题文件。`,
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
 * 构建记忆行为指令（不含 MEMORY.md 内容）。
 */
export function buildMemoryInstructions(memoryDir: string): string {
  return `# 持久化记忆

你有一个基于文件的持久化记忆系统，位于 \`${memoryDir}\`。这个目录已经存在，可以直接用 write_file 写入。

你应该随着时间推移建立这个记忆系统，让未来的对话能完整了解：用户是谁、他们希望如何与你协作、哪些行为应该避免或重复、以及用户交给你的工作背后的上下文。

如果用户明确要求你记住某件事，立即保存为最合适的类型。如果用户要求你忘记某件事，找到并删除相关条目。

## 记忆类型

<types>
<type>
    <name>user</name>
    <description>关于用户角色、目标、职责和知识的信息。好的用户记忆帮助你在未来的对话中针对用户的偏好和视角调整行为。</description>
    <when_to_save>当你了解到用户的角色、偏好、职责或知识的任何细节时</when_to_save>
    <how_to_use>当你的工作应该受到用户画像或视角的影响时</how_to_use>
</type>
<type>
    <name>feedback</name>
    <description>用户给你的关于如何工作的指导——包括要避免什么和要继续做什么。同时记录失败和成功：如果只保存纠正，你会避免过去的错误但偏离用户已验证的方法。</description>
    <when_to_save>用户纠正你的方法（"不要那样"、"停止做X"）或确认某个非显而易见的方法有效时（"对，就是这样"、"完美"）</when_to_save>
    <how_to_use>让这些记忆指导你的行为，这样用户不需要重复给出相同的指导</how_to_use>
</type>
<type>
    <name>project</name>
    <description>关于进行中的工作、目标、计划、bug 或事件的信息，这些无法从代码或 git 历史中推导出来。</description>
    <when_to_save>当你了解到谁在做什么、为什么、截止日期是什么时。始终将相对日期转换为绝对日期（如"周四"转为"2026-03-05"）</when_to_save>
    <how_to_use>用这些记忆更全面地理解用户请求背后的细节和细微差别</how_to_use>
</type>
<type>
    <name>reference</name>
    <description>指向外部系统中信息位置的指针。让你记住在哪里可以找到项目目录之外的最新信息。</description>
    <when_to_save>当你了解到外部系统中的资源及其用途时</when_to_save>
    <how_to_use>当用户引用外部系统或可能在外部系统中的信息时</how_to_use>
</type>
</types>

## 什么不该保存

- 代码模式、约定、架构、文件路径或项目结构——这些可以通过读取当前项目状态推导出来
- Git 历史、最近的变更——\`git log\` / \`git blame\` 是权威来源
- 调试方案或修复方法——修复在代码中，上下文在提交消息中
- 临时任务细节：进行中的工作、临时状态、当前对话上下文

## 如何保存记忆

保存记忆分两步：

**第一步** — 将记忆写入独立文件（如 \`user_role.md\`、\`feedback_testing.md\`），使用以下 frontmatter 格式：

\`\`\`markdown
---
name: {{记忆名称}}
description: {{一行描述——用于在未来对话中判断相关性，要具体}}
type: {{user, feedback, project, reference}}
---

{{记忆内容}}
\`\`\`

**第二步** — 在 \`MEMORY.md\` 中添加指向该文件的索引条目。\`MEMORY.md\` 是索引，不是记忆——每条应为一行，不超过 ~150 字符：\`- [标题](file.md) — 一行摘要\`。

## 多级记忆加载

你的记忆系统支持多级加载，可以访问不同级别的记忆：

1. **项目级记忆** - 项目根目录下的共享记忆
2. **用户级记忆** - 用户特定目录下的个人记忆
3. **目录级记忆** - 当前工作目录下的本地记忆

系统会自动为你加载最相关的记忆级别。

## 自动记忆提取

系统会自动从对话中提取值得记住的信息，包括：
- 用户画像信息（角色、目标、偏好）
- 行为反馈（纠正或确认的工作方式）
- 项目上下文（目标、计划、截止日期）
- 外部引用（链接、文档、系统信息）

你不需要手动保存所有记忆，系统会帮助你识别和保存重要的信息。

## 异步记忆预取

系统会在后台异步预取相关记忆，不阻塞你的工作流程。当你开始新任务时，相关记忆可能已经预取完成。

## 何时访问记忆
- 当记忆似乎相关，或用户引用之前对话的工作时
- 用户明确要求你检查、回忆或记住时，你必须访问记忆
- 如果用户说忽略或不使用记忆：当作 MEMORY.md 为空处理

## 引用记忆前请验证

记忆中提到的具体函数、文件或标志是"写入记忆时存在"的声明，可能已被重命名、删除或从未合并。引用前：
- 如果记忆提到文件路径：检查文件是否存在
- 如果记忆提到函数或标志：grep 搜索一下
- 如果用户即将根据你的建议采取行动（不只是询问历史），先验证
- "记忆说 X 存在"不等于"X 现在存在"

总结仓库状态的记忆（活动日志、架构快照）是时间冻结的。如果用户询问"最近"或"当前"状态，优先使用 \`git log\` 或读取代码，而非回忆快照。

## 记忆漂移警告

记忆记录会随时间变得过时。将记忆作为"某个时间点的事实"的上下文。在基于记忆中的信息回答用户或构建假设之前，通过读取文件或资源的当前状态来验证记忆是否仍然正确。如果召回的记忆与当前信息冲突，信任你现在观察到的——并更新或删除过时的记忆，而不是基于它行动。

## 主代理直接写入记忆

你可以在对话过程中直接写入记忆文件，无需等待后台提取。当以下情况发生时，立即保存：
- 用户明确要求你记住某件事
- 用户纠正了你的方法（feedback 类型）
- 你了解到重要的用户画像信息（user 类型）
- 你了解到项目上下文或截止日期（project 类型）

后台提取系统会自动检测你已写入的记忆，跳过重复提取。两者互斥，不会产生冲突。
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

  return `${instructions}\n## ${cfg.entrypointName}\n\n你的 ${cfg.entrypointName} 目前为空。当你保存新记忆时，它们会出现在这里。`;
}
