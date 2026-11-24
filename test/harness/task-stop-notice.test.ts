import { describe, expect, it } from 'vitest';
import {
  backgroundTaskNotifyDecision,
  describeTaskStopNotice,
  joinStopNotice,
  phaseAfterTaskStop,
} from '../../src/harness/task-stop-notice.js';

describe('describeTaskStopNotice', () => {
  it('正常完成不留停因', () => {
    expect(describeTaskStopNotice({
      stopReason: 'model_done',
      completionStatus: 'completed',
      completionReason: 'verification_passed',
    })).toBeNull();
  });

  it('用户自己停、暂停等人，不留停因', () => {
    expect(describeTaskStopNotice({ stopReason: 'user_abort' })).toBeNull();
    expect(describeTaskStopNotice({ stopReason: 'user_checkpoint' })).toBeNull();
    expect(describeTaskStopNotice({ stopReason: 'completion_paused' })).toBeNull();
  });

  it('熔断、轮次用尽写明停因和下一步', () => {
    const circuit = describeTaskStopNotice({ stopReason: 'circuit_breaker' });
    expect(circuit?.summary).toBe('连续工具失败，已熔断');
    expect(circuit?.line).toContain('下一步：');
    expect(circuit?.line).toContain('继续');

    const rounds = describeTaskStopNotice({ stopReason: 'max_rounds' });
    expect(rounds?.summary).toBe('轮次已用尽');
    expect(rounds?.line.startsWith('已停下：')).toBe(true);
  });

  it('验收命令失败即使停因是 model_done 也要说命令失败', () => {
    const notice = describeTaskStopNotice({
      stopReason: 'model_done',
      completionStatus: 'failed',
      completionReason: 'verification_failed',
    });
    expect(notice?.summary).toBe('验收命令失败');
    expect(notice?.line).toContain('命令输出');
  });

  it('未标成硬失败的验收命令同样留停因', () => {
    const notice = describeTaskStopNotice({
      stopReason: 'model_done',
      completionStatus: 'completed_unverified',
      completionReason: 'verification_failed',
    });
    expect(notice?.summary).toBe('验收命令失败');
  });

  it('写入或命令失败优先于笼统的收尾失败', () => {
    const notice = describeTaskStopNotice({
      stopReason: 'completion_failed',
      completionStatus: 'failed',
      completionReason: 'operation_write_failed',
    });
    expect(notice?.summary).toBe('写入或命令失败');
  });
});

describe('joinStopNotice', () => {
  it('接在回复后面，空回复时这一句就是正文', () => {
    const notice = describeTaskStopNotice({ stopReason: 'max_rounds' });
    expect(joinStopNotice('还差最后一步。', notice)).toBe(`还差最后一步。\n\n${notice?.line}`);
    expect(joinStopNotice('  ', notice)).toBe(notice?.line);
    expect(joinStopNotice('done', null)).toBe('done');
  });

  it('正常完成不裁剪原文空白', () => {
    expect(joinStopNotice('  保留两边空白  \n', null)).toBe('  保留两边空白  \n');
    expect(joinStopNotice(undefined, null)).toBe('');
  });

  it('所有通知摘要都不超过桌面通知的 30 字', () => {
    const cases = [
      { stopReason: 'circuit_breaker' },
      { stopReason: 'max_rounds' },
      { stopReason: 'token_budget' },
      { stopReason: 'timeout' },
      { stopReason: 'max_output_tokens' },
      { stopReason: 'error' },
      { stopReason: 'completion_failed' },
      { stopReason: 'stop_hook' },
      { stopReason: 'model_done', completionReason: 'verification_failed' },
      { stopReason: 'completion_failed', completionReason: 'operation_write_failed' },
      { stopReason: 'completion_failed', completionReason: 'operation_failed' },
      { stopReason: 'model_done', completionStatus: 'failed' },
    ];
    for (const input of cases) {
      const notice = describeTaskStopNotice(input);
      expect(notice, JSON.stringify(input)).not.toBeNull();
      expect(notice!.summary.length).toBeLessThanOrEqual(30);
      expect(notice!.line.startsWith(`已停下：${notice!.summary}`)).toBe(true);
      expect(notice!.line).toContain('下一步：');
    }
  });

  it('用户中止优先于命令失败，不留停因', () => {
    expect(describeTaskStopNotice({
      stopReason: 'user_abort',
      completionReason: 'verification_failed',
      completionStatus: 'failed',
    })).toBeNull();
  });

  it('同一句不重复接', () => {
    const notice = describeTaskStopNotice({ stopReason: 'error' });
    const once = joinStopNotice('出错了', notice);
    expect(joinStopNotice(once, notice)).toBe(once);
  });
});

describe('后台通知和侧栏', () => {
  it('别的会话命令失败时通知为失败，而不是完成', () => {
    const decision = backgroundTaskNotifyDecision({
      phase: 'done',
      stopReason: 'model_done',
      completionReason: 'verification_failed',
    });
    expect(decision).toEqual({ success: false, summary: '验收命令失败' });
  });

  it('别的会话正常完成仍是成功通知', () => {
    expect(backgroundTaskNotifyDecision({
      phase: 'done',
      stopReason: 'model_done',
    })).toEqual({ success: true, summary: '' });
  });

  it('命令失败把 done 收成 error，其它阶段不动', () => {
    expect(phaseAfterTaskStop('done', {
      stopReason: 'model_done',
      completionReason: 'verification_failed',
    })).toBe('error');
    expect(phaseAfterTaskStop('done', { stopReason: 'model_done' })).toBe('done');
    expect(phaseAfterTaskStop('idle', { stopReason: 'user_abort' })).toBe('idle');
  });
});
