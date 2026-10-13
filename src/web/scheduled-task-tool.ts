/**
 * 聊天工具 scheduled_task：让 AI 通过本软件的定时任务功能（而不是 schtasks / crontab / 循环脚本）
 * 创建与管理周期任务。仅 Web 服务注册（见 serve.ts 的会话工具提供者），增删改走 scheduled-task-service。
 *
 * 定时任务专属会话里禁止 create：任务提示词若要求「再建一个任务」会无限增殖。
 * 同名任务已存在时拒绝 create：模型重复调用时不会堆出一串重复任务，而是连续失败触发熔断。
 */

import { getSkillRegistry } from '../core/skill-registry.js';
import type {
  ScheduledTask,
  ScheduledTaskIntervalUnit,
  ScheduledTaskScheduleKind,
} from '../session/scheduled-task-store.js';
import type { RegisteredTool, ToolResult } from '../tools/types.js';
import type { ScheduledTaskInput, ScheduledTaskService } from './scheduled-task-service.js';

export const SCHEDULED_TASK_TOOL_NAME = 'scheduled_task';

export const SCHEDULED_TASK_CREATE_IN_TASK_SESSION_MESSAGE =
  '定时任务会话中不能创建新任务（避免任务无限增殖）。如需新任务，请让用户在普通会话中提出。';

export interface ScheduledTaskDataPaths {
  dataDir: string;
  sessionsDir: string;
  outputDir: string;
}

export interface ScheduledTaskToolDeps {
  service: ScheduledTaskService;
  /** 当前会话是某个定时任务的专属会话。 */
  inTaskSession: boolean;
  listSkillFilenames?: () => Promise<Set<string>>;
  formatTime?: (ts: number) => string;
  /** 写进工具说明，让模型写任务提示词时不必翻目录 / 源码找数据位置。 */
  dataPaths?: ScheduledTaskDataPaths;
  /** 任务执行时的起始工作目录。 */
  defaultWorkDir?: string;
}

const ACTIONS = ['list', 'create', 'update', 'toggle', 'delete', 'run'] as const;

const UNIT_LABELS: Record<ScheduledTaskIntervalUnit, string> = {
  second: '秒',
  minute: '分钟',
  hour: '小时',
  day: '天',
};

const STATUS_LABELS: Record<ScheduledTask['lastStatus'], string> = {
  idle: '未执行',
  queued: '排队中',
  success: '成功',
  error: '失败',
};

const UNIT_ALIASES: Record<string, ScheduledTaskIntervalUnit> = {
  s: 'second', sec: 'second', second: 'second', seconds: 'second', 秒: 'second',
  m: 'minute', min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute', 分: 'minute', 分钟: 'minute',
  h: 'hour', hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour', 时: 'hour', 小时: 'hour',
  d: 'day', day: 'day', days: 'day', 天: 'day', 日: 'day',
};

const SCHEDULE_KIND_ALIASES: Record<string, ScheduledTaskScheduleKind> = {
  interval: 'interval', every: 'interval', 间隔: 'interval',
  daily: 'daily', day: 'daily', everyday: 'daily', 每天: 'daily', 每日: 'daily',
  weekly: 'weekly', week: 'weekly', 每周: 'weekly',
  monthly: 'monthly', month: 'monthly', 每月: 'monthly',
};

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const WEEKDAY_ALIASES: Record<string, number> = {};
[
  ['sun', 'sunday', '日', '天'],
  ['mon', 'monday', '一'],
  ['tue', 'tuesday', '二'],
  ['wed', 'wednesday', '三'],
  ['thu', 'thursday', '四'],
  ['fri', 'friday', '五'],
  ['sat', 'saturday', '六'],
].forEach(([short, long, ...zh], day) => {
  WEEKDAY_ALIASES[short!] = day;
  WEEKDAY_ALIASES[long!] = day;
  for (const c of zh) {
    for (const prefix of ['周', '星期', '礼拜']) WEEKDAY_ALIASES[prefix + c] = day;
  }
});

const INPUT_FIELDS = [
  'name', 'prompt', 'scheduleKind', 'intervalValue', 'intervalUnit', 'timeOfDay', 'weekdays', 'monthDays', 'once', 'enabled', 'skillFilenames',
] as const;

const LIST_PROMPT_PREVIEW_CHARS = 80;

async function defaultListSkillFilenames(): Promise<Set<string>> {
  const skills = await getSkillRegistry().listSkills();
  return new Set(skills.map((s) => s.filename));
}

function defaultFormatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 模型常写 "minutes" / "min" / "小时"；无法识别的原样交给服务校验报错。 */
export function normalizeIntervalUnit(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  return UNIT_ALIASES[raw.trim().toLowerCase()] ?? raw;
}

export function normalizeScheduleKind(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  return SCHEDULE_KIND_ALIASES[raw.trim().toLowerCase()] ?? raw;
}

/** 接受 [5] / ["5"] / "fri" / "周一,周三"；7 按周日处理（cron 与 ISO 习惯）。无法识别的原样交给服务校验报错。 */
export function normalizeWeekdays(raw: unknown): unknown {
  const items = typeof raw === 'string' ? raw.split(/[,，、\s]+/).filter(Boolean)
    : typeof raw === 'number' ? [raw]
    : Array.isArray(raw) ? raw
    : null;
  if (!items) return raw;
  return items.map((item: unknown) => {
    const text = typeof item === 'string' ? item.trim().toLowerCase() : item;
    const day = typeof text === 'string' && /^\d+$/.test(text) ? Number(text)
      : typeof text === 'string' ? WEEKDAY_ALIASES[text] ?? item
      : text;
    return day === 7 ? 0 : day;
  });
}

/** 接受 [1, 15] / ["15"] / "1,15" / "15号"；无法识别的原样交给服务校验报错。 */
export function normalizeMonthDays(raw: unknown): unknown {
  const items = typeof raw === 'string' ? raw.split(/[,，、\s]+/).filter(Boolean)
    : typeof raw === 'number' ? [raw]
    : Array.isArray(raw) ? raw
    : null;
  if (!items) return raw;
  return items.map((item: unknown) => {
    const m = typeof item === 'string' ? /^(\d+)\s*[号日]?$/.exec(item.trim()) : null;
    return m ? Number(m[1]) : item;
  });
}

function pickInput(args: Record<string, unknown>): ScheduledTaskInput {
  const input: ScheduledTaskInput = {};
  for (const key of INPUT_FIELDS) {
    if (args[key] !== undefined && args[key] !== null) input[key] = args[key];
  }
  if (input.scheduleKind !== undefined) input.scheduleKind = normalizeScheduleKind(input.scheduleKind);
  if (input.intervalUnit !== undefined) input.intervalUnit = normalizeIntervalUnit(input.intervalUnit);
  if (input.weekdays !== undefined) input.weekdays = normalizeWeekdays(input.weekdays);
  if (input.monthDays !== undefined) input.monthDays = normalizeMonthDays(input.monthDays);
  if (typeof input.once === 'string') input.once = input.once === 'true';
  if (typeof input.enabled === 'string') input.enabled = input.enabled === 'true';
  return input;
}

/**
 * 工具说明即完整用法：只在按意图携带本工具的轮次发送，不必压缩篇幅。
 * 说明不全时模型会去读本软件源码或 scheduled-tasks.json 自行摸索。
 */
export function buildScheduledTaskDescription(
  deps: Pick<ScheduledTaskToolDeps, 'dataPaths' | 'defaultWorkDir'> = {},
): string {
  const { dataPaths, defaultWorkDir } = deps;
  const lines = [
    'iceCoder\'s built-in scheduled tasks. This description is the complete, authoritative usage guide: do NOT read iceCoder source code, scheduled-tasks.json or other config files to learn how scheduling works. Use action:"list" to see existing tasks.',
    '',
    'When to use: anything the user wants run periodically or after a delay (reminders, polling, monitoring, daily reports/summaries). Never create OS schedulers (schtasks/crontab/launchctl/systemd timers) or sleep-loop scripts.',
    '',
    'How a run works:',
    '- At each due time the task prompt is sent as a new user message to the task\'s own session. That session is created on the first run and reused by later runs (earlier runs\' replies stay visible there); it is replaced by a fresh session once it grows past ~20 MB.',
    '- The task session cannot see this chat. Write the prompt as a complete brief for a stranger: goal, absolute paths, data sources/URLs, steps, output format and absolute output path, and what to do when there is nothing to report. Look up any paths or facts the prompt needs before calling create; do not leave them for the run to guess.',
    '- Runs are unattended: every confirmation is auto-approved. State hard limits in the prompt (read-only sources, which files may be written, never delete).',
    defaultWorkDir
      ? `- Runs start in iceCoder's default working directory (currently ${defaultWorkDir}); always use absolute paths in the prompt.`
      : '- Runs start in iceCoder\'s default working directory, not this chat\'s workspace; always use absolute paths in the prompt.',
    '- Results only go to the task session (sidebar group "任务会话") and the task status on the 定时任务 page. Nothing is posted back to this chat and the user is not notified; if the user wants a deliverable, the prompt must write a file.',
    '- skillFilenames attaches skills (file names such as "review.md") to every run; unknown names are ignored with a warning. This tool cannot set image/file attachments: reference files by absolute path in the prompt, or ask the user to attach them on the 定时任务 page.',
    '',
    'Scheduling rules (scheduleKind):',
    '- interval (default): runs every intervalValue x intervalUnit (second | minute | hour | day). The first run is one interval after the task is created or enabled.',
    '- daily: runs every day at timeOfDay ("HH:mm", 24-hour, local time of the machine running iceCoder). "Every day at midnight / 24:00" is timeOfDay "00:00".',
    '- weekly: runs at timeOfDay on every day in weekdays (0=Sunday, 1=Monday, ... 5=Friday, 6=Saturday). "Every Friday at 10:00" = scheduleKind "weekly", weekdays [5], timeOfDay "10:00"; "workdays at 9:00" = weekdays [1,2,3,4,5].',
    '- monthly: runs at timeOfDay on every day-of-month in monthDays (1-31). A day the month does not have (e.g. 31 in April, 30 in February) runs on that month\'s last day instead, so monthDays [31] means "the last day of every month". "The 1st and 15th of every month at 9:00" = scheduleKind "monthly", monthDays [1,15], timeOfDay "09:00".',
    '- once:true: interval runs once one interval after enabling; daily/weekly/monthly run once at the next matching time. Then the task disables itself. Use for "remind me in 10 minutes" / "tomorrow at 8:00".',
    '- One task has exactly one schedule. Different times (e.g. "every day at 00:00" and "every Friday at 10:00") need separate tasks with distinct names. Rules like "the second Monday of the month", specific calendar dates in a year and cron expressions are NOT supported: translate cron into the kinds above when possible, otherwise say plainly what cannot be expressed and offer the nearest schedule.',
    '- Changing schedule fields (scheduleKind, intervalValue/intervalUnit, timeOfDay, weekdays, monthDays) or re-enabling restarts the countdown from now (clock schedules: the next matching time after now). Editing name/prompt/skillFilenames keeps the schedule.',
    '- If the previous run of the task is still going, a recurring trigger is skipped and action:"run" fails as busy. Runs missed while the service was stopped are not caught up; a missed once-task is disabled.',
    '',
    'Actions:',
    '- list: every task with id, schedule, enabled state, next/last run, last status and a prompt preview.',
    '- create: name, prompt and a schedule are required (interval: intervalValue + intervalUnit; daily: timeOfDay; weekly: weekdays + timeOfDay; monthly: monthDays + timeOfDay); optional scheduleKind (default interval, inferred from timeOfDay/weekdays/monthDays when omitted), once (default false), enabled (default true), skillFilenames. Refused when the name already exists (use update) and inside a task\'s own session.',
    '- update: id plus only the fields to change.',
    '- toggle: id; enabled:true/false, or omit enabled to flip.',
    '- run: id; runs once now in the task session, schedule unchanged.',
    '- delete: id; the user is asked to confirm; the task session is kept.',
    'Get ids from list. After create/update, tell the user the task name, the schedule and the next run time exactly as returned.',
  ];
  if (dataPaths) {
    lines.push(
      '',
      'iceCoder data locations (for prompts that work on iceCoder\'s own data, e.g. "summarize today\'s sessions"):',
      `- Data dir: ${dataPaths.dataDir}`,
      `- Sessions: ${dataPaths.sessionsDir}. index.json lists sessions as [{id, title, createdAt, updatedAt, messageCount, scheduledTaskId?}] (ms timestamps; scheduledTaskId marks scheduled-task sessions). <id>.json is the visible transcript: [{role: "user" | "agent" | "tool_trace" | "system", content, sentAt | completedAt, ...}]; tool_trace items carry toolName/detail. <id>.session-notes.md, when present, is a short running note. Other <id>.* files, *.tmp/*.bak files and per-session subfolders are internal; skip them.`,
      `- Default place for generated files when the user names none: ${dataPaths.outputDir}`,
    );
  }
  return lines.join('\n');
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error };
}

export function createScheduledTaskTool(deps: ScheduledTaskToolDeps): RegisteredTool {
  const { service, inTaskSession } = deps;
  const listSkillFilenames = deps.listSkillFilenames ?? defaultListSkillFilenames;
  const formatTime = deps.formatTime ?? defaultFormatTime;

  function scheduleText(task: ScheduledTask): string {
    if (task.scheduleKind === 'monthly') {
      const days = task.monthDays.map((d) => `${d} 日`).join('、');
      return task.once ? `一次性，在下一个 ${days} ${task.timeOfDay} 执行` : `每月 ${days} ${task.timeOfDay} 执行一次`;
    }
    if (task.scheduleKind === 'daily' || task.scheduleKind === 'weekly') {
      const days = task.scheduleKind === 'daily' ? '天' : task.weekdays.map((d) => WEEKDAY_LABELS[d]).join('、');
      return task.once ? `一次性，在下一个${task.scheduleKind === 'daily' ? '' : days} ${task.timeOfDay} 执行` : `每${days} ${task.timeOfDay} 执行一次`;
    }
    const every = `${task.intervalValue} ${UNIT_LABELS[task.intervalUnit]}`;
    return task.once ? `一次性，启用 ${every}后执行` : `每 ${every}执行一次`;
  }

  function describe(task: ScheduledTask, withPrompt: boolean): string {
    const lines = [
      `- 「${task.name}」 id=${task.id}`,
      `  调度：${scheduleText(task)}；${task.enabled ? '已启用' : '已停用'}`,
      `  下次执行：${task.nextRunAt ? formatTime(task.nextRunAt) : '无'}`,
    ];
    if (task.lastRunAt) {
      const status = task.lastStatus === 'error'
        ? `失败（${task.lastError ?? '未知错误'}）`
        : STATUS_LABELS[task.lastStatus];
      lines.push(`  上次执行：${formatTime(task.lastRunAt)}，${status}`);
    }
    if (task.skillFilenames.length > 0) lines.push(`  技能：${task.skillFilenames.join(', ')}`);
    if (withPrompt) {
      const prompt = task.prompt.length > LIST_PROMPT_PREVIEW_CHARS
        ? `${task.prompt.slice(0, LIST_PROMPT_PREVIEW_CHARS)}…`
        : task.prompt;
      lines.push(`  提示词：${prompt.replace(/\s+/g, ' ')}`);
    }
    return lines.join('\n');
  }

  async function unknownSkillsNote(input: ScheduledTaskInput): Promise<string> {
    const requested = Array.isArray(input.skillFilenames)
      ? input.skillFilenames.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : [];
    if (requested.length === 0) return '';
    const known = await listSkillFilenames();
    const unknown = requested.filter((s) => !known.has(s.trim()));
    if (unknown.length === 0) return '';
    const available = [...known].join(', ') || '（无）';
    return `\n注意：以下技能不存在，执行时会被忽略：${unknown.join(', ')}。可用技能：${available}`;
  }

  function requireId(args: Record<string, unknown>): string {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('缺少 id：先用 action:"list" 查到任务 id');
    return id;
  }

  return {
    definition: {
      name: SCHEDULED_TASK_TOOL_NAME,
      description: buildScheduledTaskDescription(deps),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS], description: 'list | create | update | toggle | delete | run.' },
          id: { type: 'string', description: 'Task id from action:"list". Required for update/toggle/delete/run.' },
          name: { type: 'string', description: 'Short unique task name shown on the 定时任务 page.' },
          prompt: {
            type: 'string',
            description: 'Self-contained instructions sent to the AI on every run, in the user\'s language. The run cannot see this chat: include absolute paths, steps, output location and limits.',
          },
          scheduleKind: {
            type: 'string',
            enum: ['interval', 'daily', 'weekly', 'monthly'],
            description: 'interval (default): every intervalValue x intervalUnit. daily: every day at timeOfDay. weekly: at timeOfDay on each of weekdays. monthly: at timeOfDay on each of monthDays.',
          },
          intervalValue: { type: 'integer', minimum: 1, description: 'interval only. Positive integer; with intervalUnit gives the repeat interval (or the delay when once:true).' },
          intervalUnit: { type: 'string', enum: ['second', 'minute', 'hour', 'day'] },
          timeOfDay: { type: 'string', description: 'daily/weekly/monthly only. "HH:mm", 24-hour local time; midnight is "00:00".' },
          weekdays: {
            type: 'array',
            items: { type: 'integer', minimum: 0, maximum: 6 },
            description: 'weekly only. 0=Sunday, 1=Monday, ... 5=Friday, 6=Saturday.',
          },
          monthDays: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: 31 },
            description: 'monthly only. Days of the month 1-31; a day the month lacks runs on its last day (31 = last day of every month).',
          },
          once: { type: 'boolean', description: 'true = run once (after one interval, or at the next matching clock time), then disable. Default false.' },
          enabled: { type: 'boolean', description: 'create/update: default true. toggle: target state; omit to flip.' },
          skillFilenames: { type: 'array', items: { type: 'string' }, description: 'Skill file names (e.g. "review.md") loaded on every run.' },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      const action = typeof args.action === 'string' ? args.action.trim() : '';
      try {
        switch (action) {
          case 'list': {
            const tasks = await service.list();
            if (tasks.length === 0) return ok('当前没有定时任务。');
            return ok(`共 ${tasks.length} 个定时任务：\n${tasks.map((t) => describe(t, true)).join('\n')}`);
          }
          case 'create': {
            if (inTaskSession) return fail(SCHEDULED_TASK_CREATE_IN_TASK_SESSION_MESSAGE);
            const input = pickInput(args);
            if (input.scheduleKind === undefined && input.timeOfDay !== undefined) {
              input.scheduleKind = input.monthDays !== undefined ? 'monthly' : input.weekdays !== undefined ? 'weekly' : 'daily';
            }
            const name = typeof input.name === 'string' ? input.name.trim() : '';
            const existing = name ? (await service.list()).find((t) => t.name === name) : undefined;
            if (existing) {
              return fail(`已存在同名定时任务「${name}」（id=${existing.id}）。要修改它请用 action:"update"；确需另建请换一个名称。`);
            }
            const task = await service.create(input);
            return ok(
              `已创建定时任务：\n${describe(task, false)}\n`
              + '用户可在定时任务页查看、修改；首次执行时会自动创建该任务的专属会话，之后每次执行的结果都写在里面。'
              + (await unknownSkillsNote(input)),
            );
          }
          case 'update': {
            const id = requireId(args);
            const input = pickInput(args);
            if (Object.keys(input).length === 0) return fail('没有要修改的字段');
            const task = await service.update(id, input);
            return ok(`已更新定时任务：\n${describe(task, false)}${await unknownSkillsNote(input)}`);
          }
          case 'toggle': {
            const id = requireId(args);
            const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
            const task = await service.toggle(id, enabled);
            return ok(`已${task.enabled ? '启用' : '停用'}定时任务：\n${describe(task, false)}`);
          }
          case 'delete': {
            const id = requireId(args);
            const task = await service.get(id);
            await service.remove(id);
            return ok(`已删除定时任务「${task.name}」（其专属会话保留）。`);
          }
          case 'run': {
            const id = requireId(args);
            const task = await service.runNow(id);
            return ok(`已触发执行「${task?.name ?? id}」，结果见该任务的专属会话。`);
          }
          default:
            return fail(`未知 action「${action}」，可选：${ACTIONS.join(' / ')}`);
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
