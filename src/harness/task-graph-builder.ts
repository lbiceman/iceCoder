/**
 * TaskGraph Builder — 规则驱动的图构建器。
 *
 * 职责：
 *   1. RepoShapeDiscovery — 读取 package.json 推断仓库形态
 *   2. TaskComplexityEstimator — 纯启发式复杂度评分
 *   3. PreflightScanner — 路径存在性验证
 *   4. TemplateRanker — 基于条件筛选 + 历史评分排序
 *   5. GraphBuilder — 组合上述模块，输出 TaskGraph
 *
 * v1：纯规则驱动，不使用 LLM。
 * 依赖：Phase 1 (types), Phase 2 (createTaskGraph)
 *
 * 设计文档：docs/任务图规划-设计文档.md §7, §29-§32
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  TaskNode,
  RepoShape,
  TaskComplexity,
  ComplexityLevel,
  PreflightResult,
  GraphTemplate,
} from '../types/task-graph.js';
import type { TaskIntent } from '../types/runtime-snapshot.js';
import { createTaskGraph } from './task-graph.js';
import type { TaskGraph as TaskGraphData } from '../types/task-graph.js';

// ═══════════════════════════════════════════════
// GraphBuildInput
// ═══════════════════════════════════════════════

export interface GraphBuildInput {
  goal: string;
  intent: TaskIntent;
  workspaceRoot?: string;
  repoShape?: RepoShape;
  complexity?: TaskComplexity;
  preflight?: PreflightResult;
  now?: () => number;
  graphId?: string;
}

// ═══════════════════════════════════════════════
// RepoShapeDiscovery
// ═══════════════════════════════════════════════

export function discoverRepoShape(workspaceRoot: string): RepoShape {
  const shape: RepoShape = {
    type: 'unknown', packageManager: 'none', isMonorepo: false,
    topLevelDirs: [], testFramework: 'none', typeSystem: 'javascript',
    lintTool: 'none', buildTool: 'none', estimatedFileCount: 0, recentChangeCount: 0,
  };

  let pkg: Record<string, unknown> | null = null;
  try {
    const raw = readFileSync(resolve(workspaceRoot, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw);
  } catch {
    return shape;
  }

  const _pkg = pkg as Record<string, unknown>;

  const scripts = (_pkg.scripts ?? {}) as Record<string, string>;
  const testScript = scripts.test ?? '';
  if (/vitest/.test(testScript)) shape.testFramework = 'vitest';
  else if (/jest/.test(testScript)) shape.testFramework = 'jest';
  else if (/mocha/.test(testScript)) shape.testFramework = 'mocha';

  const devDeps: Record<string, string> = (_pkg.devDependencies ?? {}) as Record<string, string>;
  const deps: Record<string, string> = (_pkg.dependencies ?? {}) as Record<string, string>;
  const allDeps = { ...deps, ...devDeps };

  if ('typescript' in allDeps) shape.typeSystem = 'typescript';
  if ('eslint' in allDeps) shape.lintTool = 'eslint';
  else if ('@biomejs/biome' in allDeps) shape.lintTool = 'biome';
  if ('vite' in allDeps) shape.buildTool = 'vite';
  else if ('webpack' in allDeps) shape.buildTool = 'webpack';
  else if (testScript.includes('tsc') || 'typescript' in allDeps) shape.buildTool = 'tsc';

  const wv = _pkg.workspaces;
  if (Array.isArray(wv) || (typeof wv === 'object' && wv !== null && Array.isArray((wv as Record<string, unknown>).packages)) || typeof wv === 'string') {
    shape.isMonorepo = true;
  }

  try {
    if (existsSync(resolve(workspaceRoot, 'pnpm-lock.yaml'))) shape.packageManager = 'pnpm';
    else if (existsSync(resolve(workspaceRoot, 'yarn.lock'))) shape.packageManager = 'yarn';
    else if (existsSync(resolve(workspaceRoot, 'package-lock.json'))) shape.packageManager = 'npm';
  } catch { /* ignore */ }

  try {
    const ents = readdirSync(workspaceRoot, { withFileTypes: true });
    shape.topLevelDirs = ents.filter(e => e.isDirectory()).map(e => e.name);
  } catch { /* ignore */ }

  const dirs = new Set(shape.topLevelDirs.map(d => d.toLowerCase()));
  const hasFrontend = dirs.has('src') || dirs.has('public') || dirs.has('pages') || dirs.has('components');
  const hasBackend = dirs.has('server') || dirs.has('api') || dirs.has('routes') || dirs.has('controllers');
  if (hasFrontend && hasBackend) shape.type = 'fullstack';
  else if (hasFrontend) shape.type = 'frontend';
  else if (hasBackend) shape.type = 'backend';
  if (_pkg.bin) shape.type = 'cli_tool';
  if (shape.type === 'unknown' && !_pkg.bin && !hasFrontend && !hasBackend) shape.type = 'library';

  return shape;
}

// ═══════════════════════════════════════════════
// TaskComplexityEstimator
// ═══════════════════════════════════════════════

/** CJK 字符范围（中日韩统一表意文字 + 扩展 A） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

/** CJK 感知的单词数：CJK 按每 2 个字≈1 词估算，非 CJK 部分用 whitespace split */
function countWords(text: string): number {
  const cjkMatches = text.match(CJK_RE);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  // 去掉 CJK 字符后按空格分词
  const nonCjk = text.replace(CJK_RE, ' ').trim();
  const nonCjkWords = nonCjk ? nonCjk.split(/\s+/).length : 0;
  return Math.max(1, Math.round(cjkChars / 2) + nonCjkWords);
}

export function estimateComplexity(
  goal: string,
  repoShape?: RepoShape,
  changedFiles?: string[],
): TaskComplexity {
  const goalLen = goal.length;
  const goalWords = countWords(goal);
  const hasMultistep = /并且|同时|然后|接着|之后|以及|also|then|after|and also/i.test(goal);
  const hasDeep = /重构|迁移|重写|架构|系统|refactor|migrate|rewrite|architecture|system/i.test(goal);

  const goalScore = Math.min(40,
    (goalLen > 30 ? 10 : Math.round(goalLen / 3)) +
    (goalWords > 10 ? 15 : Math.round(goalWords * 1.5)) +
    (hasMultistep ? 8 : 0) +
    (hasDeep ? 7 : 0),
  );

  let repoScore = 0;
  if (repoShape) {
    repoScore = Math.min(30,
      (repoShape.isMonorepo ? 10 : 0) +
      (repoShape.estimatedFileCount > 500 ? 10 : repoShape.estimatedFileCount > 100 ? 5 : 0) +
      (repoShape.type === 'fullstack' ? 10 : repoShape.type === 'backend' ? 6 : 0),
    );
  }

  const fileScore = Math.min(30, (changedFiles?.length ?? 0) * 6);

  const total = Math.min(100, goalScore + repoScore + fileScore);

  const level: ComplexityLevel =
    total <= 15 ? 'trivial' : total <= 30 ? 'simple' :
    total <= 55 ? 'moderate' : total <= 75 ? 'complex' : 'hard';

  return {
    level,
    score: total,
    dimensions: { goalComplexity: goalScore, repoComplexity: repoScore, fileScopeComplexity: fileScore },
    estimatedNodeCount: level === 'trivial' ? 3 : level === 'simple' ? 4 : level === 'moderate' ? 5 : level === 'complex' ? 6 : 8,
    suggestedMaxRetries: level === 'trivial' || level === 'simple' ? 1 : level === 'moderate' || level === 'complex' ? 2 : 3,
    needsDelegate: level === 'complex' || level === 'hard',
    suggestedFallbackCount: level === 'trivial' || level === 'simple' ? 0 : level === 'moderate' ? 1 : level === 'complex' ? 2 : 3,
  };
}

// ═══════════════════════════════════════════════
// PreflightScanner
// ═══════════════════════════════════════════════

const FILE_PATH_RE = /(?:^|\s)([a-zA-Z0-9_\-./]+\.(?:ts|js|tsx|jsx|json|md|css|html|vue|svelte))(?:$|\s|[;,:)])/g;
const SYMBOL_RE = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;

export function scanPreflight(goal: string, workspaceRoot: string): PreflightResult {
  const result: PreflightResult = {
    passed: true, issues: [], discoveredFiles: [], discoveredSymbols: [], suggestions: [], durationMs: 0,
  };
  const start = Date.now();

  let m: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;
  while ((m = FILE_PATH_RE.exec(goal)) !== null) {
    const fp = m[1];
    if (existsSync(resolve(workspaceRoot, fp))) {
      result.discoveredFiles.push(fp);
    } else {
      result.passed = false;
      result.issues.push({ severity: 'error', type: 'file_not_found', description: `文件不存在: ${fp}`, userText: fp });
    }
  }

  const seen = new Set<string>();
  SYMBOL_RE.lastIndex = 0;
  while ((m = SYMBOL_RE.exec(goal)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); result.discoveredSymbols.push(m[0]); }
  }

  if (result.discoveredSymbols.length >= 4) {
    result.issues.push({
      severity: 'warning', type: 'ambiguous_reference',
      description: `目标中包含 ${result.discoveredSymbols.length} 个可能的符号引用，建议指定具体文件`,
    });
    result.suggestions.push({ type: 'narrow_scope', message: '多个符号引用可能涉及不同文件，建议缩小范围。' });
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ═══════════════════════════════════════════════
// Intent → Template Mapping
// ═══════════════════════════════════════════════

type NodeSpec = Pick<TaskNode, 'type' | 'title' | 'phase' | 'requiresTool'> & { isVerification?: boolean };

/** 可执行意图（会被 complexity 调整） */
const EXEC_INTENTS: Set<TaskIntent> = new Set(['edit', 'debug', 'test', 'refactor', 'docs']);

function intentTemplates(intent: TaskIntent): NodeSpec[] {
  switch (intent) {
    case 'edit':
      return [
        { type: 'inspect', title: '理解目标', phase: 'intent', requiresTool: false },
        { type: 'search', title: '查阅相关内容', phase: 'context', requiresTool: true },
        { type: 'edit', title: '编写或修改代码', phase: 'editing', requiresTool: true },
        { type: 'verify', title: '运行验证命令', phase: 'verification', requiresTool: true, isVerification: true },
        { type: 'summarize', title: '总结变更', phase: 'final', requiresTool: false },
      ];
    case 'debug':
      return [
        { type: 'inspect', title: '明确问题与现象', phase: 'intent', requiresTool: false },
        { type: 'search', title: '查阅上下文与证据', phase: 'context', requiresTool: true },
        { type: 'edit', title: '以最小改动修复', phase: 'editing', requiresTool: true },
        { type: 'verify', title: '运行验证命令', phase: 'verification', requiresTool: true, isVerification: true },
        { type: 'summarize', title: '总结原因与变更', phase: 'final', requiresTool: false },
      ];
    case 'test':
      return [
        { type: 'inspect', title: '明确范围与目标', phase: 'intent', requiresTool: false },
        { type: 'search', title: '运行并查看输出', phase: 'context', requiresTool: true },
        { type: 'edit', title: '调整代码或测试', phase: 'editing', requiresTool: true },
        { type: 'verify', title: '运行验证命令', phase: 'verification', requiresTool: true, isVerification: true },
        { type: 'summarize', title: '总结测试与结论', phase: 'final', requiresTool: false },
      ];
    case 'refactor':
      return [
        { type: 'inspect', title: '明确目标与范围', phase: 'intent', requiresTool: false },
        { type: 'search', title: '查阅影响范围与依赖', phase: 'context', requiresTool: true },
        { type: 'edit', title: '应用重构改动', phase: 'editing', requiresTool: true },
        { type: 'verify', title: '运行验证命令', phase: 'verification', requiresTool: true, isVerification: true },
        { type: 'summarize', title: '总结影响与变更', phase: 'final', requiresTool: false },
      ];
    case 'docs':
      return [
        { type: 'inspect', title: '明确文档目标', phase: 'intent', requiresTool: false },
        { type: 'search', title: '查阅相关源码', phase: 'context', requiresTool: true },
        { type: 'edit', title: '编写文档', phase: 'editing', requiresTool: true },
        { type: 'summarize', title: '总结变更', phase: 'final', requiresTool: false },
      ];
    case 'inspect':
    case 'question':
    default:
      return [
        { type: 'search', title: '查阅相关代码', phase: 'context', requiresTool: true },
        { type: 'summarize', title: '总结发现', phase: 'final', requiresTool: false },
      ];
  }
}

// ═══════════════════════════════════════════════
// GraphTemplateRanker
// ═══════════════════════════════════════════════

const BUILTIN_TEMPLATES: GraphTemplate[] = [
  { id: 'tpl-edit-standard', intent: 'edit', name: '标准编辑', nodeTypes: ['inspect','search','edit','verify','summarize'], conditions: [], historicalScore: 0.82, usageCount: 0 },
  { id: 'tpl-edit-quickfix', intent: 'edit', name: '快速修复', nodeTypes: ['inspect','edit','verify','summarize'], conditions: [{ field: 'complexity', operator: 'in', value: ['trivial','simple'] }], historicalScore: 0.91, usageCount: 0 },
  { id: 'tpl-edit-large-repo', intent: 'edit', name: '大仓编辑', nodeTypes: ['delegate','inspect','edit','verify','verify','summarize'], conditions: [{ field: 'fileCount', operator: 'gt', value: 500 }], historicalScore: 0.74, usageCount: 0 },
  { id: 'tpl-edit-no-test', intent: 'edit', name: '无测试编辑', nodeTypes: ['inspect','search','edit','summarize'], conditions: [{ field: 'testFramework', operator: 'eq', value: 'none' }], historicalScore: 0.65, usageCount: 0 },
  { id: 'tpl-debug-standard', intent: 'debug', name: '标准排查', nodeTypes: ['inspect','search','edit','verify','summarize'], conditions: [], historicalScore: 0.80, usageCount: 0 },
  { id: 'tpl-test-standard', intent: 'test', name: '标准测试', nodeTypes: ['inspect','search','edit','verify','summarize'], conditions: [], historicalScore: 0.78, usageCount: 0 },
  { id: 'tpl-refactor-standard', intent: 'refactor', name: '标准重构', nodeTypes: ['inspect','search','edit','verify','summarize'], conditions: [], historicalScore: 0.79, usageCount: 0 },
  { id: 'tpl-inspect-standard', intent: 'inspect', name: '标准查阅', nodeTypes: ['search','summarize'], conditions: [], historicalScore: 0.85, usageCount: 0 },
];

export function rankTemplates(
  intent: TaskIntent,
  complexity: TaskComplexity,
  repoShape?: RepoShape,
): GraphTemplate[] {
  const all = BUILTIN_TEMPLATES.filter(t => t.intent === intent);
  const matched = all.filter(t => {
    if (t.conditions.length === 0) return true;
    return t.conditions.every(cond => {
      let actual: string | number;
      switch (cond.field) {
        case 'complexity': actual = complexity.level; break;
        case 'repoType': actual = repoShape?.type ?? 'unknown'; break;
        case 'testFramework': actual = repoShape?.testFramework ?? 'none'; break;
        case 'fileCount': actual = repoShape?.estimatedFileCount ?? 0; break;
        default: return false;
      }
      switch (cond.operator) {
        case 'eq': return actual === cond.value;
        case 'neq': return actual !== cond.value;
        case 'gt': return typeof actual === 'number' && actual > (cond.value as number);
        case 'lt': return typeof actual === 'number' && actual < (cond.value as number);
        case 'in': return Array.isArray(cond.value) && cond.value.includes(actual as string);
        default: return false;
      }
    });
  });

  const pool = matched.length > 0 ? matched : all.filter(t => t.conditions.length === 0);
  const maxUsage = Math.max(1, ...pool.map(t => t.usageCount));
  return [...pool].sort((a, b) =>
    (b.historicalScore * 0.8 + (b.usageCount / maxUsage) * 0.2) -
    (a.historicalScore * 0.8 + (a.usageCount / maxUsage) * 0.2)
  );
}

// ═══════════════════════════════════════════════
// GraphBuilder
// ═══════════════════════════════════════════════

export function buildGraph(input: GraphBuildInput): TaskGraphData {
  const { goal, intent, workspaceRoot, now, graphId } = input;

  const repoShape = input.repoShape ?? (workspaceRoot ? discoverRepoShape(workspaceRoot) : undefined);
  const complexity = input.complexity ?? estimateComplexity(goal, repoShape);
  const preflight = input.preflight ?? (workspaceRoot ? scanPreflight(goal, workspaceRoot) : undefined);

  let nodeSpecs = intentTemplates(intent);

  if (EXEC_INTENTS.has(intent)) {
    if (complexity.level === 'trivial') {
      nodeSpecs = [
        { type: 'edit', title: '修改代码', phase: 'editing', requiresTool: true },
        { type: 'verify', title: '运行验证', phase: 'verification', requiresTool: true, isVerification: true },
        { type: 'summarize', title: '总结', phase: 'final', requiresTool: false },
      ];
    } else if (complexity.level === 'hard') {
      nodeSpecs = [
        { type: 'delegate', title: '仓库探索', phase: 'context', requiresTool: true },
        ...nodeSpecs.filter(s => s.type !== 'fallback'),
      ];
    }
  }

  const nodes: TaskNode[] = nodeSpecs.map((s, i) => ({
    id: `node-${String(i + 1).padStart(2, '0')}`,
    type: s.type,
    title: s.title,
    phase: s.phase,
    requiresTool: s.requiresTool,
    status: 'pending' as const,
    retryCount: 0,
    maxRetries: complexity.suggestedMaxRetries,
    suggestedTools: s.type === 'verify' && repoShape?.testFramework !== 'none' ? ['run_command'] : undefined,
    evidence: s.phase === 'context' && preflight?.discoveredFiles.length ? preflight.discoveredFiles[0] : undefined,
    delegate: s.type === 'delegate'
      ? { task: `探索 ${goal} 相关的代码结构`, tools: ['glob', 'grep', 'read_file', 'fs_operation'], maxRounds: 6 }
      : undefined,
  }));

  for (let i = 0; i < complexity.suggestedFallbackCount; i++) {
    nodes.push({
      id: `node-fb${String(i + 1).padStart(2, '0')}`,
      type: 'fallback', title: `后备方案 ${i + 1}`, phase: 'editing', requiresTool: true,
      status: 'pending', retryCount: 0, maxRetries: 1,
    });
  }

  return createTaskGraph({ goal, intent, nodes, now, graphId });
}
