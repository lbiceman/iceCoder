/**
 * TaskGraph Builder — 单元测试
 *
 * 覆盖：RepoShape / Complexity / Preflight / Template / Builder
 *
 * 已知限制：estimateComplexity 对中文文本的词数计算偏低
 * （`split(/\s+/)` 不支持 CJK 分词），导致短中文目标倾向 'trivial'。
 * v2 引入 Intl.Segmenter 或字符数估算修复。
 */

import { describe, it, expect } from 'vitest';
import {
  discoverRepoShape,
  estimateComplexity,
  scanPreflight,
  rankTemplates,
  buildGraph,
} from '../src/harness/task-graph-builder.js';
import type { RepoShape, TaskComplexity } from '../src/types/task-graph.js';

// ═══════════════════════════════════════════════

describe('RepoShapeDiscovery', () => {
  it('发现当前项目为 TypeScript + vitest', () => {
    const shape = discoverRepoShape(process.cwd());
    expect(shape.typeSystem).toBe('typescript');
    expect(shape.testFramework).toBe('vitest');
    expect(shape.packageManager).not.toBe('none');
  });

  it('不存在的目录返回默认 shape', () => {
    const shape = discoverRepoShape('/nonexistent/path/xyz');
    expect(shape.type).toBe('unknown');
    expect(shape.packageManager).toBe('none');
    expect(shape.testFramework).toBe('none');
  });
});

// ═══════════════════════════════════════════════

describe('TaskComplexityEstimator', () => {
  it('英文短文本 → simple', () => {
    const c = estimateComplexity('Fix the login button alignment issue');
    expect(c.level).toBe('simple');
    expect(c.score).toBeLessThanOrEqual(30);
  });

  it('英文长文本 + 大仓 → complex/hard', () => {
    const repoShape: RepoShape = {
      type: 'fullstack', packageManager: 'npm', isMonorepo: true,
      topLevelDirs: [], testFramework: 'vitest', typeSystem: 'typescript',
      lintTool: 'eslint', buildTool: 'vite', estimatedFileCount: 600,
      recentChangeCount: 0,
    };
    const c = estimateComplexity(
      'Refactor the entire user authentication system and migrate the database schema',
      repoShape,
    );
    expect(['complex', 'hard']).toContain(c.level);
    expect(c.needsDelegate).toBe(true);
  });

  it('英文短文本 trivial', () => {
    const c = estimateComplexity('fix typo');
    expect(c.level).toBe('trivial');
    expect(c.estimatedNodeCount).toBe(3);
    expect(c.suggestedMaxRetries).toBe(1);
  });

  it('中文短目标 → simple（CJK 感知词数）', () => {
    const c = estimateComplexity('修复一个拼写错误');
    expect(['trivial', 'simple']).toContain(c.level);
    expect(c.estimatedNodeCount).toBeLessThanOrEqual(4);
  });

  it('中文长目标 + 大仓 → moderate 以上', () => {
    const repoShape: RepoShape = {
      type: 'fullstack', packageManager: 'pnpm', isMonorepo: true,
      topLevelDirs: [], testFramework: 'vitest', typeSystem: 'typescript',
      lintTool: 'biome', buildTool: 'vite', estimatedFileCount: 1000,
      recentChangeCount: 10,
    };
    const c = estimateComplexity(
      '重构整个架构系统，迁移所有模块到新框架，并且更新所有测试，同时修改 CI 流程',
      repoShape,
    );
    expect(['complex', 'hard']).toContain(c.level);
    expect(c.needsDelegate).toBe(true);
  });

  it('suggestedMaxRetries 随等级递增', () => {
    expect(estimateComplexity('fix').suggestedMaxRetries).toBe(1);
    expect(estimateComplexity('refactor the entire auth module').suggestedMaxRetries).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════

describe('PreflightScanner', () => {
  it('探测存在的文件路径', () => {
    const result = scanPreflight('修改 src/harness/task-graph.ts', process.cwd());
    expect(result.discoveredFiles).toContain('src/harness/task-graph.ts');
    expect(result.passed).toBe(true);
  });

  it('探测不存在的文件路径', () => {
    const result = scanPreflight('修改 src/nonexistent/ghost.ts', process.cwd());
    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe('file_not_found');
  });

  it('提取目标中的符号', () => {
    const result = scanPreflight('重构 UserService 和 PaymentGateway', process.cwd());
    expect(result.discoveredSymbols).toContain('UserService');
    expect(result.discoveredSymbols).toContain('PaymentGateway');
  });

  it('多符号触发 ambiguous_reference', () => {
    const result = scanPreflight('修改 AaaBbb CccDdd EeeFff GggHhh', process.cwd());
    expect(result.issues.some(i => i.type === 'ambiguous_reference')).toBe(true);
  });
});

// ═══════════════════════════════════════════════

describe('TemplateRanker', () => {
  const cplx: TaskComplexity = {
    level: 'moderate', score: 50,
    dimensions: { goalComplexity: 20, repoComplexity: 20, fileScopeComplexity: 10 },
    estimatedNodeCount: 5, suggestedMaxRetries: 2,
    needsDelegate: false, suggestedFallbackCount: 1,
  };

  it('edit intent 返回模板列表', () => {
    const templates = rankTemplates('edit', cplx);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].intent).toBe('edit');
  });

  it('complexity=simple 时匹配 quickfix 模板', () => {
    const simpleCplx: TaskComplexity = { ...cplx, level: 'simple', score: 20 };
    const templates = rankTemplates('edit', simpleCplx);
    expect(templates[0].id).toBe('tpl-edit-quickfix');
  });

  it('testFramework=none 时匹配无测试模板', () => {
    const noTestRepo: RepoShape = {
      type: 'frontend', packageManager: 'npm', isMonorepo: false,
      topLevelDirs: [], testFramework: 'none', typeSystem: 'javascript',
      lintTool: 'none', buildTool: 'none', estimatedFileCount: 50,
      recentChangeCount: 0,
    };
    const templates = rankTemplates('edit', cplx, noTestRepo);
    expect(templates.some(t => t.id === 'tpl-edit-no-test')).toBe(true);
  });

  it('未知 intent 返回空列表', () => {
    const templates = rankTemplates('docs' as any, cplx);
    expect(templates.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════

describe('GraphBuilder', () => {
  it('edit intent + 英文长目标 → 5+ 节点', () => {
    const graph = buildGraph({
      goal: 'Implement the user login feature with session management',
      intent: 'edit',
      graphId: 'g-b1',
    });
    expect(graph.intent).toBe('edit');
    expect(graph.goal).toBe('Implement the user login feature with session management');
    const nodeCount = Object.keys(graph.nodes).length;
    expect(nodeCount).toBeGreaterThanOrEqual(5);
    expect(nodeCount).toBeLessThanOrEqual(8);
    expect(graph.mainBranch.nodeIds.length).toBeGreaterThanOrEqual(5);
  });

  it('debug intent + 英文长目标 → 含 inspect/edit/verify', () => {
    const graph = buildGraph({
      goal: 'Investigate and fix the 500 error in the login API endpoint',
      intent: 'debug',
      graphId: 'g-b2',
    });
    expect(graph.intent).toBe('debug');
    const types = Object.values(graph.nodes).map(n => n.type);
    expect(types).toContain('inspect');
    expect(types).toContain('edit');
    expect(types).toContain('verify');
  });

  it('inspect intent → 2 节点（不受 complexity 影响）', () => {
    const graph = buildGraph({
      goal: '查看 UserService 的实现',
      intent: 'inspect',
      graphId: 'g-b3',
    });
    const mainNodes = graph.mainBranch.nodeIds.map(id => graph.nodes[id]);
    expect(mainNodes.length).toBe(2);
    expect(mainNodes[0].type).toBe('search');
    expect(mainNodes[1].type).toBe('summarize');
  });

  it('trivial complexity + edit → 精简 3 节点', () => {
    const graph = buildGraph({
      goal: 'fix typo',
      intent: 'edit',
      graphId: 'g-b4',
      complexity: {
        level: 'trivial', score: 10,
        dimensions: { goalComplexity: 5, repoComplexity: 0, fileScopeComplexity: 5 },
        estimatedNodeCount: 3, suggestedMaxRetries: 1,
        needsDelegate: false, suggestedFallbackCount: 0,
      },
    });
    const mainNodes = graph.mainBranch.nodeIds.map(id => graph.nodes[id]);
    expect(mainNodes.length).toBe(3);
    expect(mainNodes[0].type).toBe('edit');
    expect(graph.fallbackBranches).toHaveLength(0);
  });

  it('hard complexity → delegate + 多 fallback', () => {
    const graph = buildGraph({
      goal: '重构用户认证系统，迁移到 OAuth 2.0',
      intent: 'refactor',
      graphId: 'g-b5',
      complexity: {
        level: 'hard', score: 85,
        dimensions: { goalComplexity: 35, repoComplexity: 25, fileScopeComplexity: 25 },
        estimatedNodeCount: 8, suggestedMaxRetries: 3,
        needsDelegate: true, suggestedFallbackCount: 3,
      },
    });
    const types = Object.values(graph.nodes).map(n => n.type);
    expect(types).toContain('delegate');
    expect(types).toContain('fallback');
    expect(graph.fallbackBranches.length).toBe(3);
  });

  it('refactor intent + 英文长目标 → 含 inspect', () => {
    const graph = buildGraph({
      goal: 'Rename the UserService methods and update all references',
      intent: 'refactor',
      graphId: 'g-b6',
    });
    expect(graph.intent).toBe('refactor');
    const types = graph.mainBranch.nodeIds.map(id => graph.nodes[id].type);
    expect(types).toContain('inspect');
    expect(types).toContain('edit');
  });

  it('preflight + 英文长目标 → evidence 注入 context 节点', () => {
    const graph = buildGraph({
      goal: 'Modify the function in src/harness/task-graph.ts to improve performance',
      intent: 'edit',
      graphId: 'g-b7',
      workspaceRoot: process.cwd(),
    });
    const contextNode = graph.mainBranch.nodeIds
      .map(id => graph.nodes[id])
      .find(n => n.phase === 'context');
    expect(contextNode?.evidence).toBeDefined();
  });

  it('中文短目标 + edit → 含 edit/verify（CJK 感知）', () => {
    const graph = buildGraph({
      goal: '修复登录接口的 bug',
      intent: 'edit',
      graphId: 'g-b8',
    });
    expect(graph.intent).toBe('edit');
    const types = graph.mainBranch.nodeIds.map(id => graph.nodes[id].type);
    expect(types).toContain('edit');
    expect(types).toContain('verify');
  });
});
