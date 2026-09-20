import path from 'node:path';

/** 持久化 / run-state 共用的工作区锁定状态。 */
export interface SessionWorkspaceState {
  lockedRoot?: string;
  referenceReads: string[];
  changeCount: number;
  lockedAt?: string;
}

export type WorkspaceDetectionReason =
  | 'initial_lock'
  | 'workspace_change'
  | 'reference_only'
  | 'none';

export interface WorkspaceDetectionResult {
  lockedRoot?: string;
  referenceReads: string[];
  changed: boolean;
  reason: WorkspaceDetectionReason;
  changeNotice?: string;
}

export function emptySessionWorkspaceState(): SessionWorkspaceState {
  return { referenceReads: [], changeCount: 0 };
}

const WIN_PATH =
  /[A-Za-z]:[/\\]{1,2}(?:[^\s<>"'`|，。；；\n]+[/\\])*[^\s<>"'`|，。；；\n]*/g;

const WIN_UNC_PATH =
  /\\\\[^\s<>"'`|，。；；\n]+(?:[/\\][^\s<>"'`|，。；；\n]+)*/g;

const UNIX_PATH = /(?:^|[^\w])((?:\/[\w.-]+)+)/g;

const FILE_EXT =
  /\.(md|markdown|rst|txt|log|yaml|yml|json|jsonc|toml|ini|cfg|conf|env|properties|lock|csv|tsv|xml|sql|ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|php|java|kt|kts|swift|scala|dart|lua|c|cc|cpp|cxx|h|hpp|hh|cs|m|mm|sh|bash|zsh|bat|cmd|ps1|gradle|html|htm|css|scss|sass|less|unity|prefab|asset|mat|shader|shadergraph|anim|controller|meta|scene|uasset|umap|png|jpe?g|gif|svg|webp|ico|pdf|docx?|xlsx?|pptx?)$/i;

const EXPLICIT_MARKER = /(?:工作目录|Workspace|仓库路径)\s*[:：]\s*/i;

/** 仅认明确换工作区的说法。不要把「换到下一关 / 转到这个文件」当成切仓库。 */
const WORKSPACE_CHANGE =
  /(?:工作目录改为|工作区改为|切换工作目录|切换工作区|现在工作在|换工作目录|仓库(?:改|换)为)/;

const WORKSPACE_KEYWORDS =
  /(?:中实现|里实现|内实现|项目中|项目里|仓库里|开始写|写代码|落地|开发|实现|增加|添加|新增|扩展|模块|编写|创建)/;

const WORKSPACE_INLINE_ACTION =
  /(?:实现|开发|增加|添加|新增|写代码|落地|模块|扩展|编写|创建|继续)/;

const REFERENCE_KEYWORDS =
  /(?:获取|读取|读|打开|参考|中的功能|需求文档|按.*实现|文档里|说明书)/;

interface PathCandidate {
  raw: string;
  normalized: string;
  index: number;
  isFile: boolean;
}

/** 容错 `D;//`（盘符后误写分号代替冒号）与 `D:;/` 等变体。 */
function fixDriveLetterSemicolonTypo(text: string): string {
  return text
    .replace(/([A-Za-z]);([/\\])/gi, '$1:$2')
    .replace(/([A-Za-z]):;([/\\])/gi, '$1:$2');
}

/** 将 `D;//foo/bar` 等写法规范化为绝对路径。 */
export function normalizeDetectedPath(raw: string): string {
  const trimmed = fixDriveLetterSemicolonTypo(raw.trim().replace(/[，。；；,.]+$/, ''));
  const withBackslashes = trimmed.replace(/\//g, '\\');
  return path.win32.normalize(withBackslashes);
}

const UNIX_WORKSPACE_PREFIXES = [
  '/home/',
  '/Users/',
  '/mnt/',
  '/opt/',
  '/var/',
  '/tmp/',
  '/root/',
  '/data/',
  '/workspace/',
  '/projects/',
  '/work/',
  '/srv/',
  '/Volumes/',
];

function toPosixPath(normalized: string): string {
  return normalized.replace(/\\/g, '/');
}

function hasWindowsDrive(normalized: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(normalized);
}

function isUncPath(normalized: string): boolean {
  return normalized.startsWith('\\\\');
}

function isPlausibleUnixWorkspace(asPosix: string): boolean {
  if (!asPosix.startsWith('/')) return false;
  const withSlash = asPosix.endsWith('/') ? asPosix : `${asPosix}/`;
  if (!UNIX_WORKSPACE_PREFIXES.some((prefix) => withSlash.startsWith(prefix))) return false;
  return asPosix.split('/').filter(Boolean).length >= 2;
}

/**
 * 像不像「用户指定的工程根」。
 * `/src/core`、`\src\core` 这种仓库内相对路径不能当工作区根。
 */
export function isPlausibleWorkspaceRoot(normalized: string): boolean {
  if (!normalized) return false;
  if (isUncPath(normalized)) {
    return normalized.split('\\').filter(Boolean).length >= 2;
  }
  if (hasWindowsDrive(normalized)) {
    return normalized.replace(/^[A-Za-z]:[\\/]+/, '').length > 0;
  }
  return isPlausibleUnixWorkspace(toPosixPath(normalized));
}

/** Windows 上 `/src/core`、`\src\core`：相对当前盘根，不是新工程。 */
function isDriveRelativeOrProjectPath(normalized: string): boolean {
  if (hasWindowsDrive(normalized) || isUncPath(normalized)) return false;
  const asPosix = toPosixPath(normalized);
  if (isPlausibleUnixWorkspace(asPosix)) return false;
  return asPosix.startsWith('/') || normalized.startsWith('\\');
}

function resolveLockCandidate(normalized: string, prevRoot?: string): string | undefined {
  if (prevRoot && isDriveRelativeOrProjectPath(normalized)) {
    const rel = normalized.replace(/^[\\/]+/, '');
    return rel ? path.win32.join(prevRoot, rel) : prevRoot;
  }
  return isPlausibleWorkspaceRoot(normalized) ? normalized : undefined;
}

function unixPathOverlapsWindows(unixRaw: string, windows: PathCandidate[]): boolean {
  const tail = toPosixPath(normalizeDetectedPath(unixRaw)).replace(/^\/+/, '').toLowerCase();
  if (!tail) return true;
  return windows.some((candidate) => {
    const win = toPosixPath(candidate.normalized).toLowerCase();
    return win.endsWith(`/${tail}`) || win.endsWith(tail) || win.includes(`/${tail}/`);
  });
}

/** 技能注入只保留 `[User Request]` 之后的用户原文，避免技能正文里的路径改写锁定。 */
function textForWorkspaceDetection(text: string): string {
  const marker = '[User Request]';
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return text;
  return text.slice(idx + marker.length);
}

/** 路径检测前对用户文本做容错（分号盘符、统一换行）。 */
export function preprocessWorkspaceMessage(text: string): string {
  return fixDriveLetterSemicolonTypo(textForWorkspaceDetection(text));
}

function isFileLikePath(normalized: string): boolean {
  const base = path.win32.basename(normalized);
  return FILE_EXT.test(base);
}

function extractPathCandidates(text: string): PathCandidate[] {
  const seen = new Set<string>();
  const out: PathCandidate[] = [];

  const add = (raw: string, index: number) => {
    const normalized = normalizeDetectedPath(raw);
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    out.push({ raw, normalized, index, isFile: isFileLikePath(normalized) });
  };

  for (const match of text.matchAll(WIN_PATH)) {
    if (match.index != null) add(match[0], match.index);
  }

  for (const match of text.matchAll(WIN_UNC_PATH)) {
    if (match.index != null) add(match[0], match.index);
  }

  const windowsCandidates = out.slice();
  for (const match of text.matchAll(UNIX_PATH)) {
    const candidate = match[1];
    if (!candidate || match.index == null) continue;
    if (unixPathOverlapsWindows(candidate, windowsCandidates)) continue;
    add(candidate, match.index + match[0].indexOf(candidate));
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes(' ')) continue;
    if (/^[A-Za-z]:[/\\]/.test(trimmed) || trimmed.startsWith('/')) {
      add(trimmed, text.indexOf(line) + line.indexOf(trimmed));
    }
  }

  return out;
}

function localContext(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + length + 80);
  return text.slice(start, end);
}

/** 取包含该路径的子句，避免前半句路径吃到后半句「实现」等关键词。 */
function clauseContextForPath(text: string, index: number): string {
  const clauses: Array<{ start: number; end: number; text: string }> = [];
  const pattern = /[，。；;\n]|(?:\s去\s)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const splitAt = match.index ?? 0;
    clauses.push({ start: cursor, end: splitAt, text: text.slice(cursor, splitAt) });
    cursor = splitAt + match[0].length;
  }
  clauses.push({ start: cursor, end: text.length, text: text.slice(cursor) });

  for (const clause of clauses) {
    if (index >= clause.start && index < clause.end) return clause.text;
  }
  return localContext(text, index, 40);
}

function scoreWorkspace(context: string, candidate: PathCandidate): number {
  let score = 0;
  if (WORKSPACE_KEYWORDS.test(context)) score += 3;
  if (/在[\s\S]{0,40}(中|里|内)(实现|开发|写|增加|添加|新增)/.test(context)) score += 2;
  if (EXPLICIT_MARKER.test(context)) score += 5;
  if (!candidate.isFile) score += 1;
  if (candidate.isFile) score -= 2;
  return score;
}

function scoreReference(context: string, candidate: PathCandidate): number {
  let score = 0;
  if (candidate.isFile) score += 3;
  if (REFERENCE_KEYWORDS.test(context)) score += 2;
  if (/\.md\b/i.test(candidate.normalized)) score += 2;
  if (WORKSPACE_KEYWORDS.test(context) && !candidate.isFile) score -= 2;
  return score;
}

function extractExplicitMarkerPath(text: string): string | undefined {
  const markerMatch = text.match(
    new RegExp(`${EXPLICIT_MARKER.source}([A-Za-z]:[/\\\\][^\\s\\n]+|/[^\\s\\n]+)`, 'i'),
  );
  if (!markerMatch?.[1]) return undefined;
  return normalizeDetectedPath(markerMatch[1]);
}

function extractFilenameReferences(text: string, dirCandidate: PathCandidate): string[] {
  const context = localContext(text, dirCandidate.index, dirCandidate.raw.length);
  const refs: string[] = [];
  const filePatterns = [
    /(?:获取|读取|读|打开)\s*([\w.-]+\.(?:md|txt|yaml|yml|json))/gi,
    /([\w.-]+\.(?:md|txt|yaml|yml|json))\s*中的功能/gi,
  ];
  for (const pattern of filePatterns) {
    for (const match of context.matchAll(pattern)) {
      const file = match[1];
      if (!file) continue;
      refs.push(path.win32.join(dirCandidate.normalized, file));
    }
  }
  return refs;
}

function extractPathLineWithInlineAction(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Za-z]:[/\\][^\s]+(?:[/\\][^\s]+)*)\s+\S.*(?:实现|开发|增加|添加|新增|写代码|落地|模块|扩展|编写|创建)/,
    );
    if (match?.[1]) return normalizeDetectedPath(match[1]);
  }
  return undefined;
}

const WORKSPACE_SCORE_THRESHOLD = 3;
const WORKSPACE_SWITCH_SCORE_THRESHOLD = 2;
const REFERENCE_SCORE_THRESHOLD = 2;

function rootsEqual(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** candidate 是否位于 root 目录内部（严格子路径，不含 root 自身）。 */
function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = path.win32.relative(
    path.win32.resolve(root),
    path.win32.resolve(candidate),
  );
  if (!rel) return false;
  return !rel.startsWith('..') && !path.win32.isAbsolute(rel);
}

function workspaceScoreThreshold(previous?: Pick<SessionWorkspaceState, 'lockedRoot'>, candidatePath?: string): number {
  if (!previous?.lockedRoot || !candidatePath) return WORKSPACE_SCORE_THRESHOLD;
  if (!rootsEqual(previous.lockedRoot, candidatePath)) {
    return WORKSPACE_SWITCH_SCORE_THRESHOLD;
  }
  return WORKSPACE_SCORE_THRESHOLD;
}

/**
 * 从单条 user 消息检测工作区锁定意图（纯规则，不用 LLM）。
 */
export function detectWorkspaceFromUserMessage(
  text: string,
  previous?: Pick<SessionWorkspaceState, 'lockedRoot' | 'referenceReads'>,
): WorkspaceDetectionResult {
  const trimmed = preprocessWorkspaceMessage(text).trim();
  if (!trimmed) {
    return {
      referenceReads: previous?.referenceReads ?? [],
      changed: false,
      reason: 'none',
    };
  }

  const explicitPath = extractExplicitMarkerPath(trimmed);
  const candidates = extractPathCandidates(trimmed);
  const referenceReads = new Set<string>(previous?.referenceReads ?? []);
  let bestWorkspace: { path: string; score: number } | undefined;
  let workspaceChangeTarget: string | undefined;

  if (WORKSPACE_CHANGE.test(trimmed)) {
    let changeBest: { path: string; score: number } | undefined;
    for (const candidate of candidates) {
      const ctx = clauseContextForPath(trimmed, candidate.index);
      if (!WORKSPACE_CHANGE.test(ctx)) continue;
      const resolved = resolveLockCandidate(candidate.normalized, previous?.lockedRoot);
      if (!resolved) continue;
      const wsScore = scoreWorkspace(ctx, candidate) + 5;
      if (!changeBest || wsScore > changeBest.score) {
        changeBest = { path: resolved, score: wsScore };
      }
    }
    if (changeBest && changeBest.score >= 3) {
      workspaceChangeTarget = changeBest.path;
    }
  }

  for (const candidate of candidates) {
    const ctx = clauseContextForPath(trimmed, candidate.index);
    const wsScore = scoreWorkspace(ctx, candidate);
    const refScore = scoreReference(ctx, candidate);

    if (candidate.isFile && refScore >= REFERENCE_SCORE_THRESHOLD) {
      referenceReads.add(candidate.normalized);
    } else if (!candidate.isFile) {
      for (const ref of extractFilenameReferences(trimmed, candidate)) {
        referenceReads.add(ref);
      }
    }

    // 已锁定后不再凭「实现/开发」等普通关键词换根；只用于首次锁定。
    if (previous?.lockedRoot) continue;
    const resolved = resolveLockCandidate(candidate.normalized, previous?.lockedRoot);
    if (!resolved) continue;
    if (wsScore >= workspaceScoreThreshold(previous, resolved)
      && (!bestWorkspace || wsScore > bestWorkspace.score)) {
      bestWorkspace = { path: resolved, score: wsScore };
    }
  }

  const inlinePath = extractPathLineWithInlineAction(trimmed);
  if (inlinePath && WORKSPACE_INLINE_ACTION.test(trimmed)) {
    const resolved = resolveLockCandidate(inlinePath, previous?.lockedRoot);
    if (resolved) bestWorkspace = { path: resolved, score: 10 };
  }

  if (explicitPath) {
    const resolved = resolveLockCandidate(explicitPath, previous?.lockedRoot);
    if (resolved) bestWorkspace = { path: resolved, score: 10 };
  }

  const standaloneLinePath = candidates.find((c) => {
    const line = trimmed.split(/\r?\n/).find((l) => l.trim() === c.raw.trim());
    return !!line && !c.isFile;
  });
  if (standaloneLinePath && !previous?.lockedRoot) {
    const resolved = resolveLockCandidate(standaloneLinePath.normalized, previous?.lockedRoot);
    if (resolved) bestWorkspace = { path: resolved, score: 10 };
  }

  let nextLockedRoot = workspaceChangeTarget ?? bestWorkspace?.path;
  const prevRoot = previous?.lockedRoot;
  if (nextLockedRoot) {
    nextLockedRoot = resolveLockCandidate(nextLockedRoot, prevRoot);
  }

  // 已锁定工作区内部的路径（例如通过 @ 引用 `<lockedRoot>\Assets\x.unity`，
  // 或把 `/src/core` 当成仓库内目录）绝不应改写已锁定的工作区根。
  if (
    prevRoot
    && nextLockedRoot
    && !rootsEqual(prevRoot, nextLockedRoot)
    && isPathInsideRoot(prevRoot, nextLockedRoot)
  ) {
    const insideCandidate = candidates.find(
      (c) => rootsEqual(c.normalized, nextLockedRoot as string)
        || rootsEqual(resolveLockCandidate(c.normalized, prevRoot) ?? '', nextLockedRoot as string),
    );
    if (insideCandidate?.isFile) referenceReads.add(insideCandidate.normalized);
    nextLockedRoot = undefined;
  }

  const refs = [...referenceReads];

  if (!nextLockedRoot) {
    const refsChanged = refs.length !== (previous?.referenceReads?.length ?? 0)
      || refs.some((r, i) => r !== previous?.referenceReads?.[i]);
    return {
      lockedRoot: prevRoot,
      referenceReads: refs,
      changed: refsChanged,
      reason: refsChanged ? 'reference_only' : 'none',
    };
  }

  const rootChanged = !prevRoot
    || !rootsEqual(prevRoot, nextLockedRoot);

  if (!rootChanged && refs.length === (previous?.referenceReads?.length ?? 0)
    && refs.every((r, i) => r === previous?.referenceReads?.[i])) {
    return {
      lockedRoot: prevRoot,
      referenceReads: refs,
      changed: false,
      reason: 'none',
    };
  }

  let reason: WorkspaceDetectionReason = 'initial_lock';
  let changeNotice: string | undefined;
  if (prevRoot && rootChanged) {
    reason = 'workspace_change';
    changeNotice = [
      '[System / Workspace Change]',
      `工作目录已从 \`${prevRoot}\` 切换为 \`${nextLockedRoot}\`。`,
      '后续所有 write/edit/run 默认在新目录下执行。',
      '[/System / Workspace Change]',
    ].join('\n');
  } else if (!prevRoot) {
    reason = 'initial_lock';
  }

  return {
    lockedRoot: nextLockedRoot,
    referenceReads: refs,
    changed: true,
    reason,
    changeNotice,
  };
}

/** 合并检测结果并写入 session 状态。 */
export function mergeWorkspaceDetection(
  current: SessionWorkspaceState,
  detection: WorkspaceDetectionResult,
): SessionWorkspaceState {
  if (!detection.changed) {
    return {
      ...current,
      lockedRoot: detection.lockedRoot ?? current.lockedRoot,
      referenceReads: detection.referenceReads,
    };
  }

  const next: SessionWorkspaceState = {
    lockedRoot: detection.lockedRoot ?? current.lockedRoot,
    referenceReads: detection.referenceReads,
    changeCount: current.changeCount + (detection.reason === 'workspace_change' ? 1 : 0),
    lockedAt: current.lockedAt,
  };

  if (detection.reason === 'initial_lock' && detection.lockedRoot && !current.lockedRoot) {
    next.lockedAt = new Date().toISOString();
    next.changeCount = 0;
  }

  if (detection.reason === 'workspace_change' && detection.lockedRoot) {
    next.lockedAt = new Date().toISOString();
  }

  return next;
}
