/**
 * 会话记忆（Session Memory）。
 *
 * 独立于持久化记忆的会话级笔记系统：
 * - 维护一个结构化的 Markdown 文件，记录当前会话的关键信息
 * - 在上下文压缩后仍能保持会话连续性
 * - 由后台子代理定期更新，不打断主对话流
 *
 * 10 个固定 section：
 * 1. Session Title — 会话标题
 * 2. Current State — 当前工作状态
 * 3. Task Specification — 用户要求构建什么
 * 4. Files and Functions — 重要文件
 * 5. Workflow — 常用命令
 * 6. Errors & Corrections — 错误和修正
 * 7. Codebase Documentation — 系统组件
 * 8. Learnings — 经验教训
 * 9. Key Results — 关键输出
 * 10. Worklog — 工作日志
 *
 * 触发条件（同时满足）：
 * - token 阈值：上下文窗口增长超过 minTokensBetweenUpdate
 * - 工具调用阈值：自上次更新以来工具调用数 >= toolCallsBetweenUpdates
 * - 或：上一轮 assistant 没有工具调用（自然对话断点）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UnifiedMessage, LLMAdapterInterface } from '../../llm/types.js';
import { getSessionMemoryConfig } from './memory-remote-config.js';

// ─── 模板 ───

export const SESSION_MEMORY_TEMPLATE = `# Session Title
_简短而独特的 5-10 词描述性标题，信息密集，无填充词_

# Current State
_当前正在做什么？尚未完成的待办任务。下一步计划。_

# Task Specification
_用户要求构建什么？设计决策或其他解释性上下文_

# Files and Functions
_重要文件有哪些？简要说明它们包含什么以及为什么相关_

# Workflow
_通常运行哪些命令，按什么顺序？如果输出不明显，如何解读？_

# Errors & Corrections
_遇到的错误及修复方式。用户纠正了什么？哪些方法失败了不应再尝试？_

# Codebase Documentation
_重要的系统组件有哪些？它们如何工作/配合？_

# Learnings
_什么效果好？什么效果不好？应该避免什么？不要与其他 section 重复_

# Key Results
_如果用户要求特定输出（如问题的答案、表格或其他文档），在此重复完整结果_

# Worklog
_逐步记录尝试了什么、做了什么？每步非常简短的摘要_
`;

const MAX_SECTION_LENGTH = 2000;
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000;

/**
 * 会话笔记必须包含的核心 section 标题。
 * 至少要有这 3 个才算有效（其余 section 可以为空但标题不能丢）。
 */
const REQUIRED_SECTION_HEADERS = [
  '# Session Title',
  '# Current State',
  '# Worklog',
];

/**
 * 所有 10 个 section 标题（用于完整性检查）。
 */
const ALL_SECTION_HEADERS = [
  '# Session Title',
  '# Current State',
  '# Task Specification',
  '# Files and Functions',
  '# Workflow',
  '# Errors & Corrections',
  '# Codebase Documentation',
  '# Learnings',
  '# Key Results',
  '# Worklog',
];

// ─── 状态管理（闭包隔离） ───

export interface SessionMemoryState {
  /** 是否已初始化（达到 minTokensToInit） */
  initialized: boolean;
  /** 上次提取时的 token 数 */
  tokensAtLastExtraction: number;
  /** 上次处理到的消息 UUID/索引 */
  lastProcessedIndex: number;
  /** 是否正在提取 */
  extractionInProgress: boolean;
  /** 会话笔记文件路径 */
  notesPath: string;
}

/**
 * 创建会话记忆状态（闭包隔离，每个会话独立）。
 */
export function initSessionMemoryState(sessionDir: string): SessionMemoryState {
  return {
    initialized: false,
    tokensAtLastExtraction: 0,
    lastProcessedIndex: 0,
    extractionInProgress: false,
    notesPath: path.join(sessionDir, 'session-notes.md'),
  };
}

// ─── 核心逻辑 ───

/**
 * 判断是否应该更新会话记忆。
 */
export function shouldUpdateSessionMemory(
  state: SessionMemoryState,
  currentTokenCount: number,
  toolCallsSinceLastUpdate: number,
  hasToolCallsInLastTurn: boolean,
): boolean {
  const config = getSessionMemoryConfig();

  if (!config.enabled) return false;

  // 初始化检查
  if (!state.initialized) {
    if (currentTokenCount < config.minTokensToInit) return false;
    state.initialized = true;
  }

  // token 增长检查
  const tokenGrowth = currentTokenCount - state.tokensAtLastExtraction;
  const hasMetTokenThreshold = tokenGrowth >= config.minTokensBetweenUpdate;

  // 工具调用检查
  const hasMetToolCallThreshold = toolCallsSinceLastUpdate >= config.toolCallsBetweenUpdates;

  // 触发条件：
  // 1. token 阈值 AND 工具调用阈值 都满足
  // 2. token 阈值满足 AND 上一轮没有工具调用（自然断点）
  return (
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLastTurn)
  );
}

/**
 * 设置会话笔记文件（如果不存在则创建模板）。
 */
export async function setupSessionMemoryFile(state: SessionMemoryState): Promise<string> {
  const dir = path.dirname(state.notesPath);
  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.writeFile(state.notesPath, SESSION_MEMORY_TEMPLATE, { flag: 'wx' });
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
  }

  return fs.readFile(state.notesPath, 'utf-8');
}

/**
 * 构建会话记忆更新提示词。
 */
export function buildSessionMemoryUpdatePrompt(
  currentNotes: string,
  notesPath: string,
): string {
  const sectionSizes = analyzeSectionSizes(currentNotes);
  const totalTokens = Math.ceil(currentNotes.length / 4);
  const sectionReminders = generateSectionReminders(sectionSizes, totalTokens);

  return `重要：此消息和这些指令不是实际用户对话的一部分。不要在笔记内容中包含任何关于"笔记记录"或这些更新指令的引用。

根据上面的用户对话（不包括此笔记记录指令消息以及系统提示词），更新会话笔记文件。

文件 ${notesPath} 的当前内容：
<current_notes_content>
${currentNotes}
</current_notes_content>

你的唯一任务是使用 write_file 工具更新笔记文件，然后停止。

关键编辑规则：
- 文件必须保持其精确结构，所有 section 标题和斜体描述保持不变
- 绝不修改、删除或添加 section 标题（以 '#' 开头的行）
- 绝不修改或删除斜体 _section 描述_ 行
- 只更新每个 section 中斜体描述下方的实际内容
- 写入详细、信息密集的内容——包括文件路径、函数名、错误消息、确切命令等具体信息
- 每个 section 保持在 ~${MAX_SECTION_LENGTH} token 以内
- 始终更新 "Current State" 以反映最近的工作——这对压缩后的连续性至关重要
- 如果某个 section 没有实质性新信息，可以跳过不更新${sectionReminders}`;
}

/**
 * 截断会话记忆中过长的 section（用于注入压缩后的上下文）。
 */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string;
  wasTruncated: boolean;
} {
  const lines = content.split('\n');
  const maxCharsPerSection = MAX_SECTION_LENGTH * 4;
  const outputLines: string[] = [];
  let currentSectionLines: string[] = [];
  let currentSectionHeader = '';
  let wasTruncated = false;

  for (const line of lines) {
    if (line.startsWith('# ')) {
      const result = flushSection(currentSectionHeader, currentSectionLines, maxCharsPerSection);
      outputLines.push(...result.lines);
      wasTruncated = wasTruncated || result.wasTruncated;
      currentSectionHeader = line;
      currentSectionLines = [];
    } else {
      currentSectionLines.push(line);
    }
  }

  const result = flushSection(currentSectionHeader, currentSectionLines, maxCharsPerSection);
  outputLines.push(...result.lines);
  wasTruncated = wasTruncated || result.wasTruncated;

  return { truncatedContent: outputLines.join('\n'), wasTruncated };
}

/**
 * 检查会话记忆内容是否为空（仅包含模板）。
 */
export function isSessionMemoryEmpty(content: string): boolean {
  return content.trim() === SESSION_MEMORY_TEMPLATE.trim();
}

/**
 * 读取会话记忆内容（如果存在）。
 */
export async function getSessionMemoryContent(state: SessionMemoryState): Promise<string | null> {
  try {
    return await fs.readFile(state.notesPath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── 内部工具 ───

function analyzeSectionSizes(content: string): Record<string, number> {
  const sections: Record<string, number> = {};
  const lines = content.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentSection && currentContent.length > 0) {
        sections[currentSection] = Math.ceil(currentContent.join('\n').trim().length / 4);
      }
      currentSection = line;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection && currentContent.length > 0) {
    sections[currentSection] = Math.ceil(currentContent.join('\n').trim().length / 4);
  }

  return sections;
}

function generateSectionReminders(
  sectionSizes: Record<string, number>,
  totalTokens: number,
): string {
  const overBudget = totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS;
  const oversizedSections = Object.entries(sectionSizes)
    .filter(([_, tokens]) => tokens > MAX_SECTION_LENGTH)
    .sort(([, a], [, b]) => b - a)
    .map(([section, tokens]) => `- "${section}" 约 ${tokens} token（上限: ${MAX_SECTION_LENGTH}）`);

  if (oversizedSections.length === 0 && !overBudget) return '';

  const parts: string[] = [];
  if (overBudget) {
    parts.push(
      `\n\n关键：会话记忆文件当前约 ${totalTokens} token，超过上限 ${MAX_TOTAL_SESSION_MEMORY_TOKENS}。必须精简。`,
    );
  }
  if (oversizedSections.length > 0) {
    parts.push(`\n\n以下 section 超过单节上限，必须精简：\n${oversizedSections.join('\n')}`);
  }
  return parts.join('');
}

function flushSection(
  header: string,
  lines: string[],
  maxChars: number,
): { lines: string[]; wasTruncated: boolean } {
  if (!header) return { lines, wasTruncated: false };

  const content = lines.join('\n');
  if (content.length <= maxChars) {
    return { lines: [header, ...lines], wasTruncated: false };
  }

  let charCount = 0;
  const keptLines: string[] = [header];
  for (const line of lines) {
    if (charCount + line.length + 1 > maxChars) break;
    keptLines.push(line);
    charCount += line.length + 1;
  }
  keptLines.push('\n[... section 因长度截断 ...]');
  return { lines: keptLines, wasTruncated: true };
}


// ─── 响应验证 ───

/**
 * 验证 LLM 返回的会话笔记内容是否符合 10-section 模板格式。
 *
 * 验证规则（宽松模式，兼容 DeepSeek 等指令遵循较弱的模型）：
 * 1. 内容不能为空或过短（< 50 字符）
 * 2. 必须包含至少 2/3 个核心 section 标题（Session Title, Current State, Worklog）
 * 3. 至少包含 5/10 个 section 标题
 *
 * @returns 验证结果：valid=true 表示可以写入，否则返回拒绝原因
 */
export function validateSessionMemoryContent(content: string): {
  valid: boolean;
  reason?: string;
  missingSections?: string[];
} {
  if (!content || content.trim().length < 50) {
    return { valid: false, reason: 'Content too short or empty' };
  }

  // 检查核心 section 标题（至少 2/3 个即可，兼容模型偶尔丢失一个）
  const presentRequired = REQUIRED_SECTION_HEADERS.filter(
    header => content.includes(header),
  );
  if (presentRequired.length < 2) {
    const missing = REQUIRED_SECTION_HEADERS.filter(h => !content.includes(h));
    return {
      valid: false,
      reason: `Missing required sections: ${missing.join(', ')}`,
      missingSections: missing,
    };
  }

  // 检查整体完整性（至少 5/10 个 section）
  const presentCount = ALL_SECTION_HEADERS.filter(
    header => content.includes(header),
  ).length;
  if (presentCount < 5) {
    const missing = ALL_SECTION_HEADERS.filter(h => !content.includes(h));
    return {
      valid: false,
      reason: `Only ${presentCount}/10 sections present (minimum 5)`,
      missingSections: missing,
    };
  }

  return { valid: true };
}
