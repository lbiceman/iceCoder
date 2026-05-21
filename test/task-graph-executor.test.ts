/**
 * GraphExecutor — 单元测试
 *
 * 覆盖：initGraph / getCurrentNodeContext / checkToolCall / recordToolResult / evaluateRound / advanceOrComplete / snapshot / resetGraph
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphExecutor } from '../src/harness/task-graph-executor.js';

// ═══════════════════════════════════════════════

describe('GraphExecutor', () => {
  let ex: GraphExecutor;

  beforeEach(() => {
    ex = new GraphExecutor();
  });

  // ── Lifecycle ──

  it('初始状态无 graph', () => {
    expect(ex.hasGraph()).toBe(false);
    expect(ex.isTerminal()).toBe(false);
    expect(ex.shouldForceStop()).toBe(false);
    expect(ex.getCurrentNodeContext()).toBeNull();
    expect(ex.toSnapshot()).toBeNull();
  });

  it('initGraph 创建 graph', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    expect(ex.hasGraph()).toBe(true);
    expect(ex.isTerminal()).toBe(false);
  });

  it('resetGraph 清除 graph', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    ex.resetGraph();
    expect(ex.hasGraph()).toBe(false);
  });

  it('hasPendingImplementNode: 无 graph 返回 false', () => {
    expect(ex.hasPendingImplementNode()).toBe(false);
  });

  it('hasPendingImplementNode: edit intent 下的 graph 存在 pending edit 节点 → true', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    expect(ex.hasPendingImplementNode()).toBe(true);
  });

  // ── getCurrentNodeContext ──

  it('getCurrentNodeContext 返回节点信息', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    const ctx = ex.getCurrentNodeContext();
    expect(ctx).toBeTruthy();
    expect(ctx).toContain('[TaskGraph]');
    expect(ctx).toContain('进度');
  });

  // ── checkToolCall ──

  it('无 graph 时 checkToolCall 返回 allow', () => {
    const r = ex.checkToolCall('read_file');
    expect(r.action).toBe('allow');
  });

  it('有 graph 时 checkToolCall 通过', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    const r = ex.checkToolCall('read_file');
    expect(r.action).toBe('allow');
  });

  it('checkToolCall track=false 不污染本轮工具状态', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    for (let i = 0; i < 6; i++) {
      expect(ex.checkToolCall('read_file', { track: false }).action).toBe('allow');
    }

    expect(ex.checkToolCall('read_file').action).toBe('allow');
  });

  it('recordToolResult 不抛异常', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    ex.checkToolCall('read_file');
    ex.recordToolResult('read_file', true, 'file_read');
  });

  // ── evaluateRound ──

  it('evaluateRound 无 graph 返回 none', () => {
    const r = ex.evaluateRound(1);
    expect(r.action).toBe('none');
  });

  it('evaluateRound 有 graph 返回正常', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    ex.checkToolCall('read_file');
    const r = ex.evaluateRound(1);
    expect(r.action).toBe('none');
  });

  // ── advanceOrComplete ──

  it('advanceOrComplete 完成当前节点并推进', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    const snapshot1 = ex.toSnapshot();
    expect(snapshot1?.status).toBe('ready');

    const r = ex.advanceOrComplete();
    // 节点至少推进或完成
    expect(r.advanced || r.graphDone).toBe(true);
  });

  it('多次 advanceOrComplete 最终 graph done', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    let allDone = false;
    for (let i = 0; i < 10; i++) {
      const r = ex.advanceOrComplete();
      if (r.graphDone) { allDone = true; break; }
    }
    expect(allDone).toBe(true);
    expect(ex.isTerminal()).toBe(true);
    expect(ex.shouldForceStop()).toBe(true);
  });

  // ── Snapshot ──

  it('toSnapshot 返回快照', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    const snap = ex.toSnapshot();
    expect(snap).toBeTruthy();
    expect(snap!.goal).toBe('修复登录bug');
    expect(snap!.intent).toBe('edit');
    expect(snap!.status).toBe('ready');
  });

  it('applySnapshot 恢复状态', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    const snap = ex.toSnapshot()!;
    snap.status = 'done';
    ex.applySnapshot(snap);
    expect(ex.isTerminal()).toBe(true);
  });

  // ── classifyFailure ──

  it('classifyFailure 分类错误', () => {
    ex.initGraph({ goal: '修复登录bug', intent: 'edit' });
    const f = ex.classifyFailure('ENOENT: no such file', 'read_file');
    expect(f.category).toBe('hallucinated_path');
  });

  // ── intent 变化 ──

  it('question intent 创建图', () => {
    ex.initGraph({ goal: 'taskGraph是什么', intent: 'question' });
    expect(ex.hasGraph()).toBe(true);
    const ctx = ex.getCurrentNodeContext();
    expect(ctx).toContain('[TaskGraph]');
  });
});
