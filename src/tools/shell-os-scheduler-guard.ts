/**
 * run_command 拦截「创建系统计划任务」的命令（schtasks /create、Register-ScheduledTask、写 crontab、
 * launchctl load、systemd timer），提示模型改用内置 scheduled_task 工具。
 *
 * 只在宿主提供 scheduled_task 时开启（serve.ts）；CLI 没有内置任务功能，不拦截。
 * scheduled_task 按意图携带，本轮可能没带：拦截时回调宿主，让该会话下一条消息起携带它。
 * 用户明确要系统级计划任务时，同一会话原样重试同一命令即放行。
 */

const OS_SCHEDULER_CREATE_PATTERNS: RegExp[] = [
  /\bschtasks(?:\.exe)?\b[^\n]*?\s[/-]create\b/i,
  /\bRegister-Scheduled(?:Task|Job)\b/i,
  /\|\s*crontab\b/,
  /\bcrontab\s+(?:-u\s+\S+\s+)?(?:-e\b|-(?=\s|$)|(?!-)\S)/,
  />\s*\/etc\/cron(?:tab\b|\.d\/)/,
  /\blaunchctl\s+(?:load|bootstrap)\b/,
  /\bsystemctl\b[^\n]*\benable\b[^\n]*\.timer\b/,
];

/** 每个会话最多记住的已拦截命令数（只用于「原样重试放行」）。 */
const MAX_REMEMBERED_PER_SESSION = 20;

export const OS_SCHEDULER_GUARD_MESSAGE = [
  '[Scheduled task guard] This command creates an OS-level scheduled job.',
  'iceCoder has a built-in scheduler: use the scheduled_task tool (action:"create") instead,',
  'so the task appears on the app\'s 定时任务 page and each run goes through the AI in its own session.',
  'If scheduled_task is not in your tools this turn, tell the user it will be available on their next message and ask them to resend the request.',
  'Only if the user explicitly asked for an OS-level job (Windows Task Scheduler / cron / launchd / systemd),',
  're-run exactly the same command to proceed.',
].join(' ');

export interface OsSchedulerGuardOptions {
  /** 拦截时回调（宿主据此让该会话下一轮携带 scheduled_task）。 */
  onBlocked?: (sessionId: string) => void;
}

const guards = new Set<OsSchedulerGuardOptions>();
const blockedOnce = new Map<string, string[]>();

/** 返回关闭函数；可重复开启，全部关闭后才停用。 */
export function enableOsSchedulerGuard(options: OsSchedulerGuardOptions = {}): () => void {
  const entry = { ...options };
  guards.add(entry);
  return () => {
    if (!guards.delete(entry)) return;
    if (guards.size === 0) blockedOnce.clear();
  };
}

export function isOsSchedulerCreateCommand(command: string): boolean {
  return OS_SCHEDULER_CREATE_PATTERNS.some((re) => re.test(command));
}

/** 需要拦截时返回提示文本，否则 null。 */
export function checkOsSchedulerCommand(command: string, sessionId: string): string | null {
  if (guards.size === 0) return null;
  const trimmed = command.trim();
  if (!isOsSchedulerCreateCommand(trimmed)) return null;
  const seen = blockedOnce.get(sessionId) ?? [];
  if (seen.includes(trimmed)) return null;
  seen.push(trimmed);
  if (seen.length > MAX_REMEMBERED_PER_SESSION) seen.shift();
  blockedOnce.set(sessionId, seen);
  for (const guard of guards) {
    try {
      guard.onBlocked?.(sessionId);
    } catch (err) {
      console.warn('[scheduled-task-guard] onBlocked 回调出错:', err);
    }
  }
  return OS_SCHEDULER_GUARD_MESSAGE;
}
