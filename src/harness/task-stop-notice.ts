/**
 * 写代码的任务没跑完时，给人看的一句停因和下一步。
 * 桌面通知用 summary（短），聊天记录用 line。
 * 用户主动停下、暂停等人、正常做完，都不在这里。
 */

export interface TaskStopNoticeInput {
  stopReason?: string;
  completionStatus?: string;
  completionReason?: string;
}

export interface TaskStopNotice {
  summary: string;
  line: string;
}

interface StopCopy {
  summary: string;
  next: string;
}

const STOP_COPY: Record<string, StopCopy> = {
  circuit_breaker: {
    summary: '连续工具失败，已熔断',
    next: '看最后一次报错，改完后发送「继续」。',
  },
  max_rounds: {
    summary: '轮次已用尽',
    next: '发送「继续」从当前进度接着做，或把任务拆小。',
  },
  token_budget: {
    summary: 'token 预算已用尽',
    next: '拆分任务，或新开会话后再试。',
  },
  timeout: {
    summary: '任务超时',
    next: '发送「继续」接着做。',
  },
  max_output_tokens: {
    summary: '输出达到上限',
    next: '拆成一次小的工具调用再发。',
  },
  error: {
    summary: '执行出错',
    next: '看上一条报错，处理后发送「继续」。',
  },
  completion_failed: {
    summary: '收尾没有通过',
    next: '看没做成的那一步，改完后发送「继续」。',
  },
  verification_failed: {
    summary: '验收命令失败',
    next: '看失败的命令输出，改完后发送「继续」。',
  },
  operation_write_failed: {
    summary: '写入或命令失败',
    next: '看失败的那一步，改完后发送「继续」。',
  },
  stop_hook: {
    summary: '收尾被拦住',
    next: '看停前的说明，补上缺口后发送「继续」。',
  },
};

function noticeFor(key: string): TaskStopNotice | null {
  const copy = STOP_COPY[key];
  if (!copy) return null;
  return {
    summary: copy.summary,
    line: `已停下：${copy.summary}。下一步：${copy.next}`,
  };
}

/**
 * 任务确实是失败停下时返回文案；正常完成和用户自己停则返回 null。
 * 验收命令失败时循环停因仍是 model_done，要看 completionReason。
 */
export function describeTaskStopNotice(input: TaskStopNoticeInput): TaskStopNotice | null {
  const stop = input.stopReason || '';
  const reason = input.completionReason || '';
  if (stop === 'user_abort' || stop === 'user_checkpoint') return null;
  if (reason === 'user_abort' || reason === 'user_checkpoint') return null;
  if (stop === 'completion_paused' || stop === 'task_recovery') return null;
  if (reason === 'verification_failed') return noticeFor('verification_failed');
  if (reason === 'operation_write_failed' || reason === 'operation_failed') {
    return noticeFor('operation_write_failed');
  }
  if (STOP_COPY[stop]) return noticeFor(stop);
  if (input.completionStatus === 'failed') return noticeFor('error');
  return null;
}

/** 把停因接在本轮回复后面。没有正文时，这一句就是回复。没有停因时原文不动。 */
export function joinStopNotice(content: string | undefined, notice: TaskStopNotice | null): string {
  const raw = content || '';
  if (!notice) return raw;
  const body = raw.trim();
  if (!body) return notice.line;
  if (body.includes(notice.line)) return raw;
  return `${body}\n\n${notice.line}`;
}

export interface BackgroundTaskNotifyDecision {
  success: boolean;
  summary: string;
}

/** 别的会话在后台结束时，用同一套停因决定通知是成功还是失败。 */
export function backgroundTaskNotifyDecision(
  input: TaskStopNoticeInput & { phase?: string },
): BackgroundTaskNotifyDecision | null {
  if (input.phase !== 'done' && input.phase !== 'error') return null;
  const notice = describeTaskStopNotice(input);
  const failed = !!notice || input.phase === 'error';
  return {
    success: !failed,
    summary: notice ? notice.summary : '',
  };
}

/** 命令失败时循环停因仍是 model_done，侧栏要标成失败。 */
export function phaseAfterTaskStop(phase: string, input: TaskStopNoticeInput): string {
  if (phase === 'done' && describeTaskStopNotice(input)) return 'error';
  return phase;
}

export const taskStopNoticeApi = {
  describe: describeTaskStopNotice,
  background: backgroundTaskNotifyDecision,
};
