import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  ASYNC_SUB_AGENT_SCHEMA_VERSION,
  DEFAULT_SUB_AGENT_WORKSPACE_LAYOUT,
  type AnalysisArtifact,
  type AsyncSubAgentTask,
  type SubAgentWorkspaceLayout,
} from '../types/async-sub-agent.js';

export interface AnalysisWorkspacePaths {
  /** Session-scoped root: `{sessionDir}/{sessionId}`. */
  rootDir: string;
  /** Absolute directory for Markdown analysis summaries. */
  analysisDir: string;
  /** Absolute directory for async sub-agent task metadata. */
  subtasksDir: string;
  /** Absolute directory for optional structured artifacts. */
  artifactsDir: string;
}

export type WriteAnalysisArtifactInput =
  Omit<AnalysisArtifact, 'version' | 'id' | 'relativePath' | 'createdAt'>
  & Partial<Pick<AnalysisArtifact, 'version' | 'id' | 'relativePath' | 'createdAt'>>;

type StoredTaskFile = AsyncSubAgentTask;

const MARKDOWN_EXT = '.md';
const META_EXT = '.meta.json';

function assertSafeSegment(name: string, label: string): void {
  if (!name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Invalid ${label}`);
  }
}

function toPosixPath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/');
}

function isUnderRoot(absPath: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeWorkspaceRelativePath(relativePath: string): string {
  const normalized = toPosixPath(path.posix.normalize(toPosixPath(relativePath)));
  if (
    !normalized
    || normalized.startsWith('../')
    || normalized === '..'
    || path.isAbsolute(normalized)
  ) {
    throw new Error('Analysis artifact path must stay inside the analysis workspace');
  }
  return normalized;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 10);
}

function slugPart(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'analysis';
}

function defaultArtifactRelativePath(input: WriteAnalysisArtifactInput): string {
  const slug = slugPart(`${input.kind}-${input.taskId}`);
  const hash = shortHash([
    input.sessionId,
    input.taskId,
    input.kind,
    input.summary,
    input.createdAt ?? '',
  ].join('\n'));
  return `${DEFAULT_SUB_AGENT_WORKSPACE_LAYOUT.analysisDir}/${slug}-${hash}${MARKDOWN_EXT}`;
}

function metaRelativePath(markdownRelativePath: string): string {
  if (markdownRelativePath.endsWith(MARKDOWN_EXT)) {
    return `${markdownRelativePath.slice(0, -MARKDOWN_EXT.length)}${META_EXT}`;
  }
  return `${markdownRelativePath}${META_EXT}`;
}

function taskRelativePath(taskId: string): string {
  assertSafeSegment(taskId, 'taskId');
  return `${DEFAULT_SUB_AGENT_WORKSPACE_LAYOUT.subtasksDir}/${taskId}.json`;
}

function resolveInside(rootDir: string, relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const absolute = path.resolve(rootDir, ...normalized.split('/'));
  if (!isUnderRoot(absolute, rootDir)) {
    throw new Error('Resolved path escapes analysis workspace');
  }
  return absolute;
}

function renderArtifactMarkdown(artifact: AnalysisArtifact): string {
  const files = artifact.filesRead.length > 0
    ? artifact.filesRead.map(file => `- ${file}`).join('\n')
    : '- (none)';

  return [
    `# ${artifact.kind} Analysis`,
    '',
    `taskId: ${artifact.taskId}`,
    `status: ${artifact.status}`,
    `createdAt: ${new Date(artifact.createdAt).toISOString()}`,
    '',
    '## Summary',
    '',
    artifact.summary || '(empty summary)',
    '',
    '## Files Read',
    '',
    files,
    '',
  ].join('\n');
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listJsonFiles<T>(dir: string, suffix: string): Promise<T[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const rows: T[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const row = await readJsonFile<T>(path.join(dir, entry));
    if (row !== null) rows.push(row);
  }
  return rows;
}

export function resolveAnalysisWorkspacePaths(
  sessionDir: string,
  sessionId: string,
  layout: SubAgentWorkspaceLayout = DEFAULT_SUB_AGENT_WORKSPACE_LAYOUT,
): AnalysisWorkspacePaths {
  assertSafeSegment(sessionId, 'sessionId');
  const rootDir = path.join(sessionDir, sessionId);
  return {
    rootDir,
    analysisDir: path.join(rootDir, layout.analysisDir),
    subtasksDir: path.join(rootDir, layout.subtasksDir),
    artifactsDir: path.join(rootDir, layout.artifactsDir),
  };
}

export async function ensureAnalysisWorkspace(
  sessionDir: string,
  sessionId: string,
  layout: SubAgentWorkspaceLayout = DEFAULT_SUB_AGENT_WORKSPACE_LAYOUT,
): Promise<AnalysisWorkspacePaths> {
  const paths = resolveAnalysisWorkspacePaths(sessionDir, sessionId, layout);
  await Promise.all([
    fs.mkdir(paths.analysisDir, { recursive: true }),
    fs.mkdir(paths.subtasksDir, { recursive: true }),
    fs.mkdir(paths.artifactsDir, { recursive: true }),
  ]);
  return paths;
}

export async function writeAnalysisArtifact(
  sessionDir: string,
  sessionId: string,
  input: WriteAnalysisArtifactInput,
): Promise<AnalysisArtifact> {
  const paths = await ensureAnalysisWorkspace(sessionDir, sessionId);
  const createdAt = input.createdAt ?? Date.now();
  const relativePath = normalizeWorkspaceRelativePath(
    input.relativePath ?? defaultArtifactRelativePath({ ...input, createdAt }),
  );

  const artifact: AnalysisArtifact = {
    version: input.version ?? ASYNC_SUB_AGENT_SCHEMA_VERSION,
    id: input.id ?? shortHash(`${sessionId}\n${input.taskId}\n${relativePath}`),
    relativePath,
    createdAt,
    kind: input.kind,
    taskId: input.taskId,
    sessionId: input.sessionId,
    summary: input.summary,
    filesRead: input.filesRead,
    status: input.status,
    ...(input.output ? { output: input.output } : {}),
    ...(input.consumedAt ? { consumedAt: input.consumedAt } : {}),
  };

  if (artifact.sessionId !== sessionId) {
    throw new Error('Artifact sessionId does not match target session');
  }

  const markdownPath = resolveInside(paths.rootDir, artifact.relativePath);
  const metaPath = resolveInside(paths.rootDir, metaRelativePath(artifact.relativePath));
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(markdownPath, renderArtifactMarkdown(artifact), 'utf-8');
  await fs.writeFile(metaPath, JSON.stringify(artifact, null, 2), 'utf-8');
  return artifact;
}

export async function readAnalysisArtifact(
  sessionDir: string,
  sessionId: string,
  relativePath: string,
): Promise<AnalysisArtifact | null> {
  const paths = resolveAnalysisWorkspacePaths(sessionDir, sessionId);
  const metaPath = resolveInside(paths.rootDir, metaRelativePath(relativePath));
  return readJsonFile<AnalysisArtifact>(metaPath);
}

export async function readAnalysisArtifactByTaskId(
  sessionDir: string,
  sessionId: string,
  taskId: string,
): Promise<AnalysisArtifact | null> {
  const artifacts = await listAnalysisArtifacts(sessionDir, sessionId);
  return artifacts.find(artifact => artifact.taskId === taskId) ?? null;
}

export async function listAnalysisArtifacts(
  sessionDir: string,
  sessionId: string,
): Promise<AnalysisArtifact[]> {
  const paths = resolveAnalysisWorkspacePaths(sessionDir, sessionId);
  const artifacts = await listJsonFiles<AnalysisArtifact>(paths.analysisDir, META_EXT);
  return artifacts.sort((a, b) => a.createdAt - b.createdAt);
}

export async function markArtifactConsumed(
  sessionDir: string,
  sessionId: string,
  taskId: string,
  consumedAt: number = Date.now(),
): Promise<AnalysisArtifact | null> {
  const current = await readAnalysisArtifactByTaskId(sessionDir, sessionId, taskId);
  if (!current) return null;
  return writeAnalysisArtifact(sessionDir, sessionId, { ...current, consumedAt });
}

export async function writeAsyncSubAgentTask(
  sessionDir: string,
  sessionId: string,
  task: AsyncSubAgentTask,
): Promise<AsyncSubAgentTask> {
  if (task.sessionId !== sessionId) {
    throw new Error('Task sessionId does not match target session');
  }

  const paths = await ensureAnalysisWorkspace(sessionDir, sessionId);
  const filePath = resolveInside(paths.rootDir, taskRelativePath(task.taskId));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const stored: StoredTaskFile = {
    ...task,
    version: task.version ?? ASYNC_SUB_AGENT_SCHEMA_VERSION,
  };
  await fs.writeFile(filePath, JSON.stringify(stored, null, 2), 'utf-8');
  return stored;
}

export async function readAsyncSubAgentTask(
  sessionDir: string,
  sessionId: string,
  taskId: string,
): Promise<AsyncSubAgentTask | null> {
  const paths = resolveAnalysisWorkspacePaths(sessionDir, sessionId);
  const filePath = resolveInside(paths.rootDir, taskRelativePath(taskId));
  return readJsonFile<AsyncSubAgentTask>(filePath);
}

export async function listPendingAnalysisTasks(
  sessionDir: string,
  sessionId: string,
): Promise<AsyncSubAgentTask[]> {
  const paths = resolveAnalysisWorkspacePaths(sessionDir, sessionId);
  const tasks = await listJsonFiles<AsyncSubAgentTask>(paths.subtasksDir, '.json');
  return tasks
    .filter(task => task.status === 'pending' || task.status === 'running')
    .sort((a, b) => a.createdAt - b.createdAt);
}
