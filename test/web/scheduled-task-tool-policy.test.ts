import { describe, expect, it } from 'vitest';
import { isDestructiveToolCall, resolveToolPermission } from '../../src/harness/harness-permission-runtime.js';
import { isToolExcludedForAllAgents } from '../../src/harness/agents/agent-types.js';
import { createToolUsageSection } from '../../src/prompts/sections.js';
import { filterPlanModeToolDefinitions } from '../../src/session/plan-mode-tool-policy.js';
import {
  buildAvailableDocToolsContext,
  looksLikeScheduleIntent,
  selectToolsForOffering,
  summarizeToolCategories,
  type ToolActivationInput,
} from '../../src/tools/tool-offering-selector.js';
import { isConcurrencySafe, isReadOnly } from '../../src/tools/tool-metadata.js';
import type { ToolDefinition } from '../../src/llm/types.js';

function call(action: string) {
  return { id: 'c1', name: 'scheduled_task', arguments: { action } };
}

describe('scheduled_task policy', () => {
  it('only delete needs confirmation', () => {
    expect(isDestructiveToolCall(call('delete'))).toBe(true);
    expect(resolveToolPermission(call('delete'), []).permission).toBe('confirm');
    for (const action of ['list', 'create', 'update', 'toggle', 'run']) {
      expect(resolveToolPermission(call(action), []).permission).toBe('allow');
    }
  });

  it('is registered as a serial, non-read-only tool', () => {
    expect(isConcurrencySafe('scheduled_task')).toBe(false);
    expect(isReadOnly('scheduled_task')).toBe(false);
  });

  it('is never handed to sub-agents', () => {
    expect(isToolExcludedForAllAgents('scheduled_task')).toBe(true);
  });

  it('is not offered in plan mode', () => {
    const defs = [{ name: 'scheduled_task' }, { name: 'read_file' }] as ToolDefinition[];
    expect(filterPlanModeToolDefinitions(defs).map((d) => d.name)).toEqual(['read_file']);
  });

  it('adds nothing to the system prompt (guidance lives in the tool description)', () => {
    expect(createToolUsageSection(['run_command', 'scheduled_task']).content)
      .toBe(createToolUsageSection(['run_command']).content);
  });
});

describe('looksLikeScheduleIntent', () => {
  it.each([
    '帮我每两小时检查一下依赖有没有安全更新',
    '每天汇报一次天气',
    '每隔 30 分钟看看服务还活着没',
    '每 5 分钟跑一次测试',
    '每个小时统计一下日志',
    '每周一提醒我写周报',
    '10分钟后提醒我开会',
    '半小时后帮我看看构建结果',
    '三天后检查证书',
    '设置一个定时任务',
    '定期清理临时目录',
    '把那个巡检任务停用',
    '删除刚才建的任务',
    '看看任务列表',
    '每晚备份数据库',
    '工作日早上发个提醒',
    'run this every 10 minutes',
    'check it every morning',
    'remind me in 2 hours',
    'set up a daily report',
    'schedule a backup',
    '用 crontab 每小时跑脚本',
    '隔一小时跑一下单元测试',
    '两小时一次，看看服务器磁盘还剩多少',
    '十分钟检查一次网站能不能打开',
    '明早九点叫我开会',
    '周日晚上备份一下数据库',
    '过一会儿帮我看看构建结果',
    '一直监控这个端口，有异常就通知我',
    '把巡检任务重新打开',
    '那个任务现在就跑一次',
    '那个任务别再跑了',
    'run nightly builds',
    'once an hour ping the server',
    'set a reminder for 5pm',
    'disable the weather task',
  ])('matches %s', (text) => {
    expect(looksLikeScheduleIntent(text)).toBe(true);
  });

  it.each([
    '帮我修一下登录页的 bug',
    '给每个文件都加上注释',
    '每一行末尾加分号',
    '分析一下这份 PDF',
    '这个任务做完了吗',
    '解释一下 setTimeout 的原理',
    'refactor the auth module',
    'add tests for every function',
    '帮我把 React 生命周期讲清楚',
    'setInterval 定时器没清掉导致内存泄漏',
    '写一个 cron 表达式解析函数',
    '删除这个任务相关的旧代码',
    '每周的 KPI 完成时间写 10 月 10 日',
    '统计一下这个月每天的提交数',
    '请求超时 10 秒后自动重试',
    '缓存 1 小时后过期，这个逻辑在哪',
    '把轮播间隔改成 5 秒',
    '这个任务队列的并发数改成 4',
    'explain how the scheduler in React works',
    'fix the daily-report template typo',
    'delete the unused task component',
  ])('ignores %s', (text) => {
    expect(looksLikeScheduleIntent(text)).toBe(false);
  });
});

describe('scheduled_task offering', () => {
  const defs = ['read_file', 'run_command', 'scheduled_task', 'parse_document']
    .map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })) as ToolDefinition[];

  function offered(overrides: Partial<ToolActivationInput>): string[] {
    return selectToolsForOffering(defs, {
      userMessage: '',
      uploadedFilePaths: [],
      explicitReferencePaths: [],
      sessionRecentToolCalls: [],
      shellCollabActive: false,
      hasInlineVisionImages: false,
      ...overrides,
    }).tools.map((d) => d.name);
  }

  it('is left out of ordinary turns', () => {
    expect(offered({ userMessage: '帮我修一下登录页的 bug' })).toEqual(['read_file', 'run_command']);
  });

  it('is offered when the message looks like a schedule request', () => {
    expect(offered({ userMessage: '每两小时检查一下依赖' })).toContain('scheduled_task');
  });

  it('stays offered once the session has used it (or the shell guard flagged it)', () => {
    expect(offered({ userMessage: '把间隔改成 3', sessionRecentToolCalls: ['scheduled_task'] })).toContain('scheduled_task');
  });

  it('does not count as a document tool', () => {
    const result = selectToolsForOffering(defs, {
      userMessage: '每天汇报',
      uploadedFilePaths: [],
      explicitReferencePaths: [],
      sessionRecentToolCalls: [],
      shellCollabActive: false,
      hasInlineVisionImages: false,
    });
    expect(result.tools.map((d) => d.name)).not.toContain('parse_document');
    expect(buildAvailableDocToolsContext([...result.activated].filter((n) => n === 'parse_document'))).toEqual({});
    expect(summarizeToolCategories(['scheduled_task', 'parse_document']).doc.count).toBe(1);
  });
});
