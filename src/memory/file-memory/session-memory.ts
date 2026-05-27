/**
 * 会话记忆（Session Memory）。
 *
 * 独立于持久化记忆的会话级笔记系统：
 * - 维护一个结构化的 Markdown 文件，记录当前会话的关键信息
 * - 在上下文压缩后仍能保持会话连续性
 * - 由后台子代理定期更新，不打断主对话流
 *
 * 10 个叙事 section + 1 个机器维护 section（Runtime Evidence）：
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
import type {
  TaskIntent,
  TaskPhase,
  TaskStateSnapshot,
  VerificationStatus,
  RepoContextSnapshot,
  PersistedRuntimeV1,
} from '../../types/runtime-snapshot.js';
import { PERSIST_RUNTIME_SCHEMA_VERSION } from '../../types/runtime-snapshot.js';
import { getSessionMemoryConfig } from './memory-remote-config.js';

/** 单个 section 最大 token 数 */
const SESSION_MAX_SECTION_TOKENS = 2000;
/** 会话记忆总 token 上限 */
const SESSION_MAX_TOTAL_TOKENS = 12000;
/** 内容验证最小长度 */
const SESSION_VALIDATION_MIN_LENGTH = 50;

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

# Runtime Evidence (auto)
_本节标题必须保留。正文由系统在写入文件时根据 Harness 快照与 package.json 自动覆盖；更新笔记时请勿在本节下撰写会与 tools/package.json 相矛盾的项目事实（例如把假设中的迁移目标写成当前已用栈）。_

# Worklog
_逐步记录尝试了什么、做了什么？每步非常简短的摘要_
`;


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
  '# Runtime Evidence (auto)',
  '# Worklog',
];

/** 机器维护节标题（写入后覆盖正文） */
export const SESSION_RUNTIME_EVIDENCE_HEADER = '# Runtime Evidence (auto)';

/** package.json 中与测试栈相关的可验证事实 */
export interface PackageJsonTestFacts {
  /** 解析所用路径（便于排查） */
  resolvedPath: string;
  /** scripts.test 原文 */
  testScript: string | null;
  devDependenciesHasVitest: boolean;
  devDependenciesHasJest: boolean;
  dependenciesHasVitest: boolean;
  dependenciesHasJest: boolean;
}

/** 供 Runtime Evidence 节的结构化输入（与 harness 快照字段对齐） */
export interface SessionRuntimeEvidenceInput {
  task: {
    goal: string;
    intent: string;
    phase: string;
    filesRead: string[];
    filesChanged: string[];
    commandsRun: string[];
    verificationRequired: boolean;
    verificationStatus: string;
  };
  repo: {
    filesRead: string[];
    filesChanged: string[];
    commandsRun: string[];
    testCommands: string[];
    recentDiagnostics: string[];
  };
}

/** fenced code block 语言标记，用于嵌入可解析的 TaskState + RepoContext */
export const ICECODER_RUNTIME_FENCE_LANG = 'icecoder-runtime';

const MAX_PERSIST_PATHS = 64;
const MAX_PERSIST_TASK_CMDS = 32;
const MAX_PERSIST_REPO_CMDS = 24;
const MAX_PERSIST_TEST_CMDS = 8;
const MAX_PERSIST_DIAG = 8;

const TASK_INTENTS = new Set<string>([
  'question', 'inspect', 'edit', 'debug', 'test', 'refactor', 'docs',
]);
const TASK_PHASES = new Set<string>(['intent', 'context', 'editing', 'verification', 'final']);
const VERIFICATION_STATUSES = new Set<string>([
  'not_required', 'required', 'passed', 'failed',
]);

function capPaths(paths: string[]): string[] {
  return paths.slice(0, MAX_PERSIST_PATHS);
}

function capTaskSnapshot(t: TaskStateSnapshot): TaskStateSnapshot {
  return {
    ...t,
    filesRead: capPaths(t.filesRead),
    filesChanged: capPaths(t.filesChanged),
    commandsRun: t.commandsRun.slice(-MAX_PERSIST_TASK_CMDS),
  };
}

function capRepoSnapshot(r: RepoContextSnapshot): RepoContextSnapshot {
  return {
    filesRead: capPaths(r.filesRead),
    filesChanged: capPaths(r.filesChanged),
    commandsRun: r.commandsRun.slice(-MAX_PERSIST_REPO_CMDS),
    testCommands: r.testCommands.slice(-MAX_PERSIST_TEST_CMDS),
    recentDiagnostics: r.recentDiagnostics.slice(-MAX_PERSIST_DIAG),
  };
}

function inputToTaskSnapshot(input: SessionRuntimeEvidenceInput['task']): TaskStateSnapshot {
  return {
    goal: input.goal,
    intent: input.intent as TaskIntent,
    phase: input.phase as TaskPhase,
    filesRead: [...input.filesRead],
    filesChanged: [...input.filesChanged],
    commandsRun: [...input.commandsRun],
    verificationRequired: input.verificationRequired,
    verificationStatus: input.verificationStatus as VerificationStatus,
  };
}

function inputToRepoSnapshot(input: SessionRuntimeEvidenceInput['repo']): RepoContextSnapshot {
  return {
    filesRead: [...input.filesRead],
    filesChanged: [...input.filesChanged],
    commandsRun: [...input.commandsRun],
    testCommands: [...input.testCommands],
    recentDiagnostics: [...input.recentDiagnostics],
  };
}

/**
 * 生成供写入 session-notes 的持久化 JSON（含体积上限，避免单文件过大）。
 */
export function serializePersistedRuntime(
  task: TaskStateSnapshot,
  repo: RepoContextSnapshot,
): string {
  const payload: PersistedRuntimeV1 = {
    version: PERSIST_RUNTIME_SCHEMA_VERSION,
    task: capTaskSnapshot(task),
    repo: capRepoSnapshot(repo),
  };
  return JSON.stringify(payload);
}

/**
 * 从 session-notes 全文解析持久化运行时快照（取最后一个 fence，以支持多次写入）。
 */
export function parsePersistedRuntime(notes: string): {
  task: TaskStateSnapshot;
  repo: RepoContextSnapshot;
} | null {
  const open = `\`\`\`${ICECODER_RUNTIME_FENCE_LANG}`;
  let idx = notes.lastIndexOf(open);
  if (idx === -1) return null;
  const start = idx + open.length;
  const close = notes.indexOf('```', start);
  if (close === -1) return null;
  const raw = notes.slice(start, close).trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.version !== PERSIST_RUNTIME_SCHEMA_VERSION) return null;
  const task = o.task;
  const repo = o.repo;
  if (!task || typeof task !== 'object' || !repo || typeof repo !== 'object') return null;
  const tt = task as Record<string, unknown>;
  const rr = repo as Record<string, unknown>;
  if (typeof tt.goal !== 'string' || !tt.goal.trim()) return null;
  if (typeof tt.intent !== 'string' || !TASK_INTENTS.has(tt.intent)) return null;
  if (typeof tt.phase !== 'string' || !TASK_PHASES.has(tt.phase)) return null;
  if (typeof tt.verificationRequired !== 'boolean') return null;
  if (typeof tt.verificationStatus !== 'string' || !VERIFICATION_STATUSES.has(tt.verificationStatus)) {
    return null;
  }
  if (!Array.isArray(tt.filesRead) || !Array.isArray(tt.filesChanged) || !Array.isArray(tt.commandsRun)) {
    return null;
  }
  if (!Array.isArray(rr.filesRead) || !Array.isArray(rr.filesChanged) || !Array.isArray(rr.commandsRun)) {
    return null;
  }
  if (!Array.isArray(rr.testCommands) || !Array.isArray(rr.recentDiagnostics)) return null;

  const outTask: TaskStateSnapshot = {
    goal: tt.goal,
    intent: tt.intent as TaskIntent,
    phase: tt.phase as TaskPhase,
    filesRead: tt.filesRead.filter((x): x is string => typeof x === 'string'),
    filesChanged: tt.filesChanged.filter((x): x is string => typeof x === 'string'),
    commandsRun: tt.commandsRun.filter((x): x is string => typeof x === 'string'),
    verificationRequired: tt.verificationRequired,
    verificationStatus: tt.verificationStatus as VerificationStatus,
  };
  const outRepo: RepoContextSnapshot = {
    filesRead: rr.filesRead.filter((x): x is string => typeof x === 'string'),
    filesChanged: rr.filesChanged.filter((x): x is string => typeof x === 'string'),
    commandsRun: rr.commandsRun.filter((x): x is string => typeof x === 'string'),
    testCommands: rr.testCommands.filter((x): x is string => typeof x === 'string'),
    recentDiagnostics: rr.recentDiagnostics.filter((x): x is string => typeof x === 'string'),
  };
  return { task: capTaskSnapshot(outTask), repo: capRepoSnapshot(outRepo) };
}

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
 * 计算指定会话的 session-notes 路径。
 *
 * 多会话模式下每个会话独立存放（断点恢复需按会话隔离 runtime/plan fence）。
 * 旧路径 `data/sessions/session-notes.md`（全局共享）由迁移逻辑迁到
 * `data/sessions/default.session-notes.md`。
 */
export function sessionNotesPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.session-notes.md`);
}

/**
 * 创建会话记忆状态（闭包隔离，每个会话独立）。
 *
 * @param sessionDir 会话数据目录（默认 `data/sessions`）
 * @param sessionId 会话 id（多会话隔离；未提供时回退 `default`，兼容老调用方）
 */
export function initSessionMemoryState(
  sessionDir: string,
  sessionId: string = 'default',
): SessionMemoryState {
  return {
    initialized: false,
    tokensAtLastExtraction: 0,
    lastProcessedIndex: 0,
    extractionInProgress: false,
    notesPath: sessionNotesPath(sessionDir, sessionId),
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
  force = false,
): boolean {
  const config = getSessionMemoryConfig();

  if (!config.enabled) return false;

  if (force) {
    state.initialized = true;
    return true;
  }

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

你的唯一任务是只返回完整更新后的 Markdown 内容。不要调用工具，不要解释，不要包裹代码块。

关键编辑规则：
- 文件必须保持其精确结构，所有 section 标题和斜体描述保持不变
- 绝不修改、删除或添加 section 标题（以 '#' 开头的行）
- 绝不修改或删除斜体 _section 描述_ 行
- 只更新每个 section 中斜体描述下方的实际内容
- 写入详细、信息密集的内容——包括文件路径、函数名、错误消息、确切命令等具体信息
- 每个 section 保持在 ~${SESSION_MAX_SECTION_TOKENS} token 以内
- 始终更新 "Current State" 以反映最近的工作——这对压缩后的连续性至关重要
- 禁止将对话中的「假设性迁移 / 反事实分析」里的**目标**技术栈写成当前仓库**已采用**的事实（例如用户只要求评估「若迁到 Jest」时，不得写「项目已使用 Jest」）。
- 涉及测试框架、npm 依赖、package.json 的 \`scripts.test\` 时：仅写用户原话或工具输出中**已出现**的信息；未出现时写「未验证」或省略，不要推测。
- 「# Runtime Evidence (auto)」节：保留节标题与紧跟的一条斜体说明行即可，**该节正文请留空**（系统写入文件时会用运行时快照与 \`icecoder-runtime\` 持久化块自动覆盖本节正文，模型无需生成该区域）。
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
  const maxCharsPerSection = SESSION_MAX_SECTION_TOKENS * 4;
  const outputLines: string[] = [];
  let currentSectionLines: string[] = [];
  let currentSectionHeader = '';
  let wasTruncated = false;

  for (const line of lines) {
    if (line.startsWith('# ')) {
      const sectionLimit =
        currentSectionHeader.trim() === SESSION_RUNTIME_EVIDENCE_HEADER
          ? Number.MAX_SAFE_INTEGER
          : maxCharsPerSection;
      const result = flushSection(currentSectionHeader, currentSectionLines, sectionLimit);
      outputLines.push(...result.lines);
      wasTruncated = wasTruncated || result.wasTruncated;
      currentSectionHeader = line;
      currentSectionLines = [];
    } else {
      currentSectionLines.push(line);
    }
  }

  const lastSectionLimit =
    currentSectionHeader.trim() === SESSION_RUNTIME_EVIDENCE_HEADER
      ? Number.MAX_SAFE_INTEGER
      : maxCharsPerSection;
  const result = flushSection(currentSectionHeader, currentSectionLines, lastSectionLimit);
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
  const overBudget = totalTokens > SESSION_MAX_TOTAL_TOKENS;
  const oversizedSections = Object.entries(sectionSizes)
    .filter(([_, tokens]) => tokens > SESSION_MAX_SECTION_TOKENS)
    .sort(([, a], [, b]) => b - a)
    .map(([section, tokens]) => `- "${section}" 约 ${tokens} token（上限: ${SESSION_MAX_SECTION_TOKENS}）`);

  if (oversizedSections.length === 0 && !overBudget) return '';

  const parts: string[] = [];
  if (overBudget) {
    parts.push(
      `\n\n关键：会话记忆文件当前约 ${totalTokens} token，超过上限 ${SESSION_MAX_TOTAL_TOKENS}。必须精简。`,
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
 * 验证 LLM 返回的会话笔记内容是否符合含 Runtime Evidence 的模板格式。
 *
 * 验证规则（宽松模式，兼容 DeepSeek 等指令遵循较弱的模型）：
 * 1. 内容不能为空或过短（< 50 字符）
 * 2. 必须包含至少 2/3 个核心 section 标题（Session Title, Current State, Worklog）
 * 3. 至少包含 7/11 个 section 标题
 *
 * @returns 验证结果：valid=true 表示可以写入，否则返回拒绝原因
 */
export function validateSessionMemoryContent(content: string): {
  valid: boolean;
  reason?: string;
  missingSections?: string[];
} {
  if (!content || content.trim().length < SESSION_VALIDATION_MIN_LENGTH) {
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

  // 检查整体完整性（至少 7/11 个 section）
  const presentCount = ALL_SECTION_HEADERS.filter(
    header => content.includes(header),
  ).length;
  if (presentCount < 7) {
    const missing = ALL_SECTION_HEADERS.filter(h => !content.includes(h));
    return {
      valid: false,
      reason: `Only ${presentCount}/11 sections present (minimum 7)`,
      missingSections: missing,
    };
  }

  return { valid: true };
}

const MAX_LIST = 15;
const MAX_LINE_CHARS = 120;

function truncateLine(s: string, max = MAX_LINE_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 读取 package.json 中与测试相关的可验证字段（仅用于会话笔记锚定，失败返回 null）。
 */
export async function readPackageJsonTestFacts(workspaceRoot: string): Promise<PackageJsonTestFacts | null> {
  const fp = path.join(workspaceRoot, 'package.json');
  try {
    const raw = await fs.readFile(fp, 'utf-8');
    const j = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const testScript = j.scripts?.test ?? null;
    const dd = j.devDependencies ?? {};
    const dep = j.dependencies ?? {};
    return {
      resolvedPath: fp,
      testScript,
      devDependenciesHasVitest: 'vitest' in dd,
      devDependenciesHasJest: 'jest' in dd || '@types/jest' in dd,
      dependenciesHasVitest: 'vitest' in dep,
      dependenciesHasJest: 'jest' in dep,
    };
  } catch {
    return null;
  }
}

function formatBulletList(items: string[], lineMax: number): string {
  return items.slice(0, MAX_LIST).map(i => `- \`${truncateLine(i, lineMax)}\``).join('\n')
    + (items.length > MAX_LIST ? `\n- _… +${items.length - MAX_LIST} more_` : '');
}

/**
 * 生成 Runtime Evidence 节正文（不含「# Runtime Evidence (auto)」标题行）。
 */
export function buildRuntimeEvidenceSection(
  input: SessionRuntimeEvidenceInput,
  pkg: PackageJsonTestFacts | null,
): string {
  const lines: string[] = [
    '_自动维护：以下内容来自 Harness 运行时快照与磁盘 package.json；若与其他 section 矛盾，以本节为准。_',
    '',
    '## package.json (verified)',
  ];
  if (pkg) {
    lines.push(`- path: \`${pkg.resolvedPath}\``);
    lines.push(`- scripts.test: ${pkg.testScript ? `\`${truncateLine(pkg.testScript, 100)}\`` : '_(none)_'}`);
    lines.push(
      `- devDependencies: vitest=${pkg.devDependenciesHasVitest}, jest/@types-jest=${pkg.devDependenciesHasJest}`,
    );
    lines.push(
      `- dependencies: vitest=${pkg.dependenciesHasVitest}, jest=${pkg.dependenciesHasJest}`,
    );
  } else {
    lines.push('- _(package.json not read or parse failed — skip anchoring)_');
  }

  lines.push('', '## Harness TaskState');
  lines.push(`- goal: ${truncateLine(input.task.goal, 200)}`);
  lines.push(`- intent/phase: ${input.task.intent} / ${input.task.phase}`);
  lines.push(`- verification: required=${input.task.verificationRequired}, status=${input.task.verificationStatus}`);
  lines.push('', '### filesRead (task)');
  lines.push(input.task.filesRead.length ? formatBulletList(input.task.filesRead, 200) : '- _(none)_');
  lines.push('', '### filesChanged (task)');
  lines.push(input.task.filesChanged.length ? formatBulletList(input.task.filesChanged, 200) : '- _(none)_');
  lines.push('', '### commandsRun (task)');
  lines.push(
    input.task.commandsRun.length
      ? formatBulletList(input.task.commandsRun.map(c => truncateLine(c, 200)), 200)
      : '- _(none)_',
  );

  lines.push('', '## RepoContext');
  lines.push('', '### filesRead (repo)');
  lines.push(input.repo.filesRead.length ? formatBulletList(input.repo.filesRead, 200) : '- _(none)_');
  lines.push('', '### filesChanged (repo)');
  lines.push(input.repo.filesChanged.length ? formatBulletList(input.repo.filesChanged, 200) : '- _(none)_');
  lines.push('', '### commandsRun (repo, recent)');
  lines.push(
    input.repo.commandsRun.length
      ? formatBulletList(input.repo.commandsRun.map(c => truncateLine(c, 200)), 200)
      : '- _(none)_',
  );
  lines.push('', '### testCommands');
  lines.push(
    input.repo.testCommands.length
      ? formatBulletList(input.repo.testCommands.map(c => truncateLine(c, 200)), 200)
      : '- _(none)_',
  );
  lines.push('', '### recentDiagnostics');
  lines.push(
    input.repo.recentDiagnostics.length
      ? formatBulletList(input.repo.recentDiagnostics.map(c => truncateLine(c, 200)), 200)
      : '- _(none)_',
  );

  const taskSnap = capTaskSnapshot(inputToTaskSnapshot(input.task));
  const repoSnap = capRepoSnapshot(inputToRepoSnapshot(input.repo));
  const json = serializePersistedRuntime(taskSnap, repoSnap);
  lines.push(
    '',
    '## Persisted runtime (machine)',
    '_以下 JSON 由系统自动写入，用于进程/页面重启后恢复 TaskState 与 RepoContext；请勿删除 fenced 块。_',
    '',
    `\`\`\`${ICECODER_RUNTIME_FENCE_LANG}`,
    json,
    '```',
  );

  return lines.join('\n');
}

/**
 * 将 Runtime Evidence 节正文合并进完整笔记（保留节标题与斜体说明行，替换其下正文）。
 */
export function mergeRuntimeEvidenceIntoNotes(notes: string, sectionBody: string): string {
  const lines = notes.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === SESSION_RUNTIME_EVIDENCE_HEADER);
  if (startIdx === -1) {
    return `${notes.trimEnd()}\n\n${SESSION_RUNTIME_EVIDENCE_HEADER}\n_本节由系统自动维护。_\n${sectionBody}\n`;
  }
  let bodyStart = startIdx + 1;
  // 保留紧跟节标题的斜体说明行（可有多行以 `_` 包裹）
  while (bodyStart < lines.length) {
    const t = lines[bodyStart].trim();
    if (t.startsWith('_') && t.endsWith('_') && t.length > 2) {
      bodyStart++;
      continue;
    }
    break;
  }
  let endIdx = lines.length;
  for (let j = bodyStart; j < lines.length; j++) {
    if (lines[j].startsWith('# ')) {
      endIdx = j;
      break;
    }
  }
  const head = lines.slice(0, bodyStart).join('\n');
  const tail = lines.slice(endIdx).join('\n');
  const mid = sectionBody.trimEnd();
  return [head, mid, tail].filter(s => s.length > 0).join('\n') + '\n';
}

/**
 * 若笔记正文（排除 Runtime Evidence 节）出现「项目已用 Jest」类措辞，且与 package.json 锚定冲突，返回警告段落文本。
 */
export function buildTestStackContradictionWarning(
  notes: string,
  pkg: PackageJsonTestFacts | null,
): string | null {
  if (!pkg?.testScript && !pkg?.devDependenciesHasVitest && !pkg?.dependenciesHasVitest) return null;
  const hasVitestSignal =
    (pkg.testScript && /\bvitest\b/i.test(pkg.testScript)) ||
    pkg.devDependenciesHasVitest ||
    pkg.dependenciesHasVitest;
  const hasJestSignal =
    pkg.devDependenciesHasJest ||
    pkg.dependenciesHasJest ||
    (pkg.testScript && /\bjest\b/i.test(pkg.testScript));
  if (!hasVitestSignal || hasJestSignal) return null;

  const prose = stripRuntimeEvidenceSection(notes);
  if (
    /(?:已|当前|正在)使用\s*Jest/i.test(prose)
    || /项目(?:栈|使用).*Jest/i.test(prose)
    || /\bjest\s*[:：]?\s*\^?[\d.]+/i.test(prose)
  ) {
    return '⚠️ **Consistency warning**: 正文出现「项目已采用 Jest」等表述，但锚定的 package.json 显示测试链路与 Vitest 一致。压缩恢复时请忽略正文中的矛盾句，以 Runtime Evidence 中的 package.json 为准。';
  }
  return null;
}

function stripRuntimeEvidenceSection(notes: string): string {
  const lines = notes.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === SESSION_RUNTIME_EVIDENCE_HEADER);
  if (startIdx === -1) return notes;
  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j].startsWith('# ')) {
      endIdx = j;
      break;
    }
  }
  return [...lines.slice(0, startIdx), ...lines.slice(endIdx)].join('\n');
}

// ═══════════════════════════════════════════════
// TaskGraph Fence Helpers (Phase 6)
// ═══════════════════════════════════════════════

export const ICECODER_GRAPH_FENCE_LANG = 'icecoder-graph';
export const ICECODER_METRICS_FENCE_LANG = 'icecoder-metrics';
export const ICECODER_DEBUG_FENCE_LANG = 'icecoder-debug';

/** 将 TaskGraph 快照写入 session notes（追加 fence block） */
export function writeGraphFence(notes: string, fence: string): string {
  return notes.trimEnd() + '\n\n' + fence + '\n';
}

/** 将 GraphMetrics 写入 session notes */
export function writeMetricsFence(notes: string, fence: string): string {
  return notes.trimEnd() + '\n\n' + fence + '\n';
}

/** 将 GraphDebugDump 写入 session notes */
export function writeDebugFence(notes: string, fence: string): string {
  return notes.trimEnd() + '\n\n' + fence + '\n';
}
