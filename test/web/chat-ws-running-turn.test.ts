import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRunningTurn,
  ensureRunningTurn,
  foldStepIntoRunningTurn,
  getProcessingSessionIds,
  getRunningTurn,
  hasBusySessionRun,
  snapshotRunningTurn,
} from '../../src/web/chat-ws-running-turn.js';
import {
  sessionAbortControllers,
  sessionProcessing,
} from '../../src/web/chat-ws-runtime.js';

afterEach(() => {
  for (const sid of ['rt-stream', 'rt-tool', 'rt-final', 'rt-busy', 'rt-plan']) {
    clearRunningTurn(sid);
    sessionProcessing.delete(sid);
    sessionAbortControllers.delete(sid);
  }
});

describe('chat-ws-running-turn', () => {
  it('fold stream_delta 累积文本并切 petState=read', () => {
    foldStepIntoRunningTurn('rt-stream', { type: 'stream_delta', delta: '你' });
    foldStepIntoRunningTurn('rt-stream', { type: 'stream_delta', delta: '好' });
    const snap = snapshotRunningTurn('rt-stream');
    expect(snap?.streamingText).toBe('你好');
    expect(snap?.petState).toBe('read');
  });

  it('fold reasoning_stream_delta 累积思考流并切 petState=thinking', () => {
    foldStepIntoRunningTurn('rt-stream', { type: 'reasoning_stream_delta', delta: '想' });
    foldStepIntoRunningTurn('rt-stream', { type: 'reasoning_stream_delta', delta: '一下' });
    expect(getRunningTurn('rt-stream')?.streamingReasoningText).toBe('想一下');
    expect(getRunningTurn('rt-stream')?.petState).toBe('thinking');
  });

  it('thinking / tool_progress 更新冰豆文案', () => {
    foldStepIntoRunningTurn('rt-stream', { type: 'thinking', content: '分析中' });
    expect(getRunningTurn('rt-stream')?.petBubble).toBe('分析中');
    foldStepIntoRunningTurn('rt-stream', { type: 'tool_progress', content: '写入文件' });
    expect(getRunningTurn('rt-stream')?.petState).toBe('working');
    expect(getRunningTurn('rt-stream')?.petStatusText).toBe('写入文件');
  });

  it('snapshot 是拷贝，改副本不影响原快照', () => {
    ensureRunningTurn('rt-stream');
    const a = snapshotRunningTurn('rt-stream');
    a!.toolTimeline.push({ toolName: 'x', detail: '', status: 'pending' });
    expect(getRunningTurn('rt-stream')?.toolTimeline).toEqual([]);
  });

  it('tool_call / tool_result 按 toolCallId 更新状态', () => {
    foldStepIntoRunningTurn('rt-tool', {
      type: 'tool_call',
      toolName: 'read_file',
      toolCallId: 'c1',
      toolArgs: { path: 'a.ts' },
    });
    foldStepIntoRunningTurn('rt-tool', {
      type: 'tool_result',
      toolName: 'read_file',
      toolCallId: 'c1',
      toolSuccess: true,
      toolOutput: 'ok',
    });
    const row = getRunningTurn('rt-tool')?.toolTimeline[0];
    expect(row?.status).toBe('success');
    expect(row?.toolCallId).toBe('c1');
  });

  it('final user_checkpoint / model_done 更新冰豆文案', () => {
    foldStepIntoRunningTurn('rt-final', { type: 'final', stopReason: 'user_checkpoint' });
    expect(getRunningTurn('rt-final')?.petState).toBe('crying');
    foldStepIntoRunningTurn('rt-final', { type: 'final', stopReason: 'model_done' });
    expect(getRunningTurn('rt-final')?.petState).toBe('success');
  });

  it('planEvents 超过 200 条会裁剪', () => {
    for (let i = 0; i < 205; i++) {
      foldStepIntoRunningTurn('rt-plan', { type: 'task_graph_update', i });
    }
    expect(getRunningTurn('rt-plan')?.planEvents.length).toBe(200);
  });

  it('hasBusySessionRun 覆盖 processing / abort / runningTurn 三路', () => {
    expect(hasBusySessionRun('rt-busy')).toBe(false);
    sessionProcessing.add('rt-busy');
    expect(hasBusySessionRun('rt-busy')).toBe(true);
    sessionProcessing.delete('rt-busy');
    sessionAbortControllers.set('rt-busy', new AbortController());
    expect(hasBusySessionRun('rt-busy')).toBe(true);
    sessionAbortControllers.delete('rt-busy');
    ensureRunningTurn('rt-busy');
    expect(hasBusySessionRun('rt-busy')).toBe(true);
    expect(getProcessingSessionIds()).toContain('rt-busy');
  });
});
