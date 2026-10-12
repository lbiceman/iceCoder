/**
 * 聊天工具 scheduled_task：让 AI 通过本软件的定时任务功能（而不是 schtasks / crontab / 循环脚本）
 * 创建与管理周期任务。仅 Web 服务注册（见 serve.ts 的会话工具提供者），增删改走 scheduled-task-service。
 *
 * 定时任务专属会话里禁止 create：任务提示词若要求「再建一个任务」会无限增殖。
 * 同名任务已存在时拒绝 create：模型重复调用时不会堆出一串重复任务，而是连续失败触发熔断。
 */

import { getSkillRegistry } from '../core/skill-registry.js';
import type { ScheduledTask, ScheduledTaskIntervalUnit } from '../session/scheduled-task-store.js';
import type { RegisteredTool, ToolResult } from '../tools/types.js';
import type { ScheduledTaskInput, ScheduledTaskService } from './scheduled-task-service.js';

export const SCHEDULED_TASK_TOOL_NAME = 'scheduled_task';

export const SCHEDULED_TASK_CREATE_IN_TASK_SESSION_MESSAGE =
  '定时任务会话中不能创建新任务（避免任务无限增殖）。如需新任务，请让用户在普通会话中提出。';

export interface ScheduledTaskToolDeps {
  service: ScheduledTaskService;
  /** 当前会话是某个定时任务的专属会话。 */
  inTaskSession: boolean;
  listSkillFilenames?: () => Promise<Set<string>>;
  formatTime?: (ts: number) => string;
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

const INPUT_FIELDS = ['name', 'prompt', 'intervalValue', 'intervalUnit', 'once', 'enabled', 'skillFilenames'] as const;

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

function pickInput(args: Record<string, unknown>): ScheduledTaskInput {
  const input: ScheduledTaskInput = {};
  for (const key of INPUT_FIELDS) {
    if (args[key] !== undefined && args[key] !== null) input[key] = args[key];
  }
  if (input.intervalUnit !== undefined) input.intervalUnit = normalizeIntervalUnit(input.intervalUnit);
  if (typeof input.once === 'string') input.once = input.once === 'true';
  if (typeof input.enabled === 'string') input.enabled = input.enabled === 'true';
  return input;
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
      // 管理本软件内置的定时任务；周期/延时执行一律用它，不要建系统计划任务或常驻循环脚本。
      description: [
        'iceCoder\'s built-in scheduled tasks. Use for anything to run periodically or after a delay; never create OS schedulers (schtasks/crontab) or sleep-loop scripts.',
        'Each run sends prompt to the AI in the task\'s own session, which cannot see this chat: make it self-contained.',
        'Schedule is a fixed interval (first run one interval after enabling) or once:true (run once, then disable).',
        'Clock times and cron are unsupported: say so and offer an interval.',
        'id is required except for list/create. create is refused in a task\'s own session and for an existing name.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          id: { type: 'string' },
          name: { type: 'string' },
          prompt: { type: 'string' },
          intervalValue: { type: 'integer', minimum: 1 },
          intervalUnit: { type: 'string', enum: ['second', 'minute', 'hour', 'day'] },
          once: { type: 'boolean' },
          enabled: { type: 'boolean' },
          skillFilenames: { type: 'array', items: { type: 'string' } },
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
