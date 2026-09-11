import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/etl-chronicle.js'),
  'utf-8',
);

function loadChronicle() {
  const context: Record<string, unknown> = { window: {}, console };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return (context.window as {
    EtlChronicle: {
      assemble: (input: Record<string, unknown>) => { chapters: Array<Record<string, unknown>> };
      fromLive: (input: Record<string, unknown>) => Record<string, unknown>;
      PREVIEW_MAX: number;
    };
  }).EtlChronicle;
}

describe('EtlChronicle.assemble', () => {
  it('无用户消息 → 空数组', () => {
    const Chronicle = loadChronicle();
    expect(Chronicle.assemble({}).chapters).toEqual([]);
    expect(Chronicle.assemble({ uiMessages: [], structured: [] }).chapters).toEqual([]);
  });

  it('两句用户话 → 两章；第二句不吞第一句的工具', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [
        { role: 'user', id: 'u1', content: '补测试并跑 vitest', sentAt: 1000 },
        { role: 'assistant', content: '好的' },
        { role: 'user', id: 'u2', content: '登录失败时不要清掉表单', sentAt: 2000 },
      ],
      structured: [
        { role: 'user', content: '补测试并跑 vitest' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 't1', name: 'read_file', arguments: { path: 'src/a.ts' } },
            { id: 't2', name: 'write_file', arguments: { path: 'src/a.test.ts' } },
          ],
        },
        { role: 'assistant', content: '测过了' },
        { role: 'user', content: '登录失败时不要清掉表单' },
        {
          role: 'assistant',
          toolCalls: [{ id: 't3', name: 'edit_file', arguments: { path: 'src/LoginForm.tsx' } }],
        },
      ],
    });

    expect(chapters).toHaveLength(2);
    expect(chapters[0].messageId).toBe('u1');
    expect(chapters[0].preview).toContain('补测试');
    expect(chapters[0].roundCount).toBe(2);
    const firstTools = (chapters[0].rounds as Array<{ tools: Array<{ toolCallId: string }> }>)[0].tools
      .map((t) => t.toolCallId);
    expect(firstTools).toEqual(['t1', 't2']);
    expect(chapters[0].filesChangedCount).toBe(1);

    expect(chapters[1].messageId).toBe('u2');
    const secondTools = (chapters[1].rounds as Array<{ tools: Array<{ toolCallId: string; toolName: string }> }>)[0]
      .tools;
    expect(secondTools.map((t) => t.toolCallId)).toEqual(['t3']);
    expect(secondTools[0].toolName).toBe('edit_file');
    expect(firstTools).not.toContain('t3');
  });

  it('短问答：1 章 1 轮、无写文件字段', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [{ role: 'user', id: 'q1', content: '这段报错是什么意思' }],
      structured: [
        { role: 'user', content: '这段报错是什么意思' },
        { role: 'assistant', content: '这是空指针' },
      ],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].roundCount).toBe(1);
    expect(chapters[0].filesChangedCount).toBe(0);
    expect(chapters[0].status).toBe('done');
    const round = (chapters[0].rounds as Array<{ title: string; tools: unknown[] }>)[0];
    expect(round.title).toBe('整理结论');
    expect(round.tools).toEqual([]);
  });

  it('一章两轮：第 1 轮有工具，第 2 轮是整理结论', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [{ role: 'user', id: 'm1', content: '把空态文案改短一点' }],
      structured: [
        { role: 'user', content: '把空态文案改短一点' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 'r1', name: 'read_file', arguments: { path: 'src/public/js/chat-ui.js' } },
            { id: 'r2', name: 'edit_file', arguments: { path: 'src/public/js/chat-ui.js' } },
          ],
        },
        { role: 'assistant', content: '改好了' },
      ],
    });
    const rounds = chapters[0].rounds as Array<{ title: string; tools: unknown[]; isFinal: boolean }>;
    expect(rounds).toHaveLength(2);
    expect(rounds[0].title).toBe('实施修改');
    expect(rounds[0].tools).toHaveLength(2);
    expect(rounds[0].isFinal).toBe(false);
    expect(rounds[1].title).toBe('整理结论');
    expect(rounds[1].tools).toHaveLength(0);
    expect(rounds[1].isFinal).toBe(true);
  });

  it('只说过话、还没有 assistant：章 running、rounds 空', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [{ role: 'user', id: 'live', content: '开始改吧' }],
      structured: [{ role: 'user', content: '开始改吧' }],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].status).toBe('running');
    expect(chapters[0].rounds).toEqual([]);
  });

  it('工具预览截断，不出现大段命令输出', () => {
    const Chronicle = loadChronicle();
    const huge = 'npx vitest run ' + 'x'.repeat(400);
    const { chapters } = Chronicle.assemble({
      uiMessages: [{ role: 'user', id: 'c1', content: '跑测试' }],
      structured: [
        { role: 'user', content: '跑测试' },
        {
          role: 'assistant',
          toolCalls: [{ id: 'cmd', name: 'run_command', arguments: { command: huge } }],
        },
      ],
    });
    const tool = (chapters[0].rounds as Array<{ tools: Array<{ preview: string; intent: string }> }>)[0].tools[0];
    expect(tool.preview.length).toBeLessThanOrEqual(41);
    expect(tool.preview).not.toContain('x'.repeat(80));
    expect(tool.intent).not.toContain('x'.repeat(80));
  });

  it('摘要去掉技能标签墙，写类工具计入 filesChangedCount', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [{
        role: 'user',
        id: 's1',
        content: '[Active Skill: examLogin/skill.md]\n登录失败时不要清掉表单',
      }],
      structured: [
        { role: 'user', content: '登录失败时不要清掉表单' },
        {
          role: 'assistant',
          toolCalls: [
            { id: 'a', name: 'read_file', arguments: { path: 'src/a.ts' } },
            { id: 'b', name: 'write_file', arguments: { path: 'src/a.ts' } },
            { id: 'c', name: 'edit_file', arguments: { path: 'src/b.ts' } },
            { id: 'd', name: 'grep', arguments: { pattern: 'form' } },
          ],
        },
      ],
    });
    expect(String(chapters[0].preview)).not.toMatch(/Active Skill/i);
    expect(chapters[0].preview).toContain('登录失败');
    expect(chapters[0].filesChangedCount).toBe(2);
  });

  it('alsoNote 与技能注入用户句不单独成章', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [
        { role: 'user', id: 'u1', content: '真正的问题' },
        { role: 'user', id: 'note', content: '顺便改一下', alsoNote: true },
      ],
      structured: [
        { role: 'user', content: '真正的问题' },
        { role: 'user', content: '[System: Skill File Guide]\n真正的问题\n...' },
        { role: 'assistant', toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      ],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].messageId).toBe('u1');
    expect(chapters[0].roundCount).toBe(1);
  });

  it('session toolTraces 能补上 structured 里被丢掉的工具', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [
        { role: 'user', id: 'u1', content: '新增一个2.txt文件' },
        { role: 'agent', id: 'a1', content: '已创建' },
        { role: 'user', id: 'u5', content: '修改1.txt文件，内容随便一首诗' },
        { role: 'agent', id: 'a5', content: '已改为《江雪》' },
      ],
      structured: [
        { role: 'user', content: '新增一个2.txt文件' },
        { role: 'assistant', content: '已创建' },
        { role: 'user', content: '修改1.txt文件，内容随便一首诗' },
        { role: 'assistant', content: '已改为《江雪》' },
      ],
      toolTraces: {
        a1: [{ toolName: 'write_file', detail: '2.txt', status: 'done', toolCallId: 'w2' }],
        a5: [
          { toolName: 'read_file', detail: '1.txt', status: 'done', toolCallId: 'r1' },
          { toolName: 'write_file', detail: '1.txt', status: 'done', toolCallId: 'w1' },
        ],
      },
    });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].status).toBe('done');
    expect(chapters[0].filesChangedCount).toBe(1);
    expect(chapters[0].toolCount).toBe(1);
    expect(chapters[1].status).toBe('done');
    expect(chapters[1].toolCount).toBe(2);
    expect(chapters[1].filesChangedCount).toBe(1);
    const lastTools = (chapters[1].rounds as Array<{ tools: Array<{ toolName: string }> }>)
      .flatMap((r) => r.tools)
      .map((t) => t.toolName);
    expect(lastTools).toEqual(['read_file', 'write_file']);
  });

  it('聊天区已有完成回复时，末章不得判成进行中', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [
        { role: 'user', id: 'live', content: '修改1.txt' },
        { role: 'agent', id: 'a1', content: '改好了' },
      ],
      structured: [{ role: 'user', content: '修改1.txt' }],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].status).toBe('done');
    expect(chapters[0].roundCount).toBe(1);
  });

  it('没有 UI 消息时用检查点时间轴反推章节', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      checkpointEntries: [
        { messageId: 'cp1', preview: '新增一个2.txt文件', userMessageTime: 1000 },
        { messageId: 'cp2', preview: '修改1.txt文件', userMessageTime: 2000 },
      ],
      structured: [
        { role: 'user', content: '新增一个2.txt文件' },
        { role: 'assistant', toolCalls: [{ id: 't1', name: 'write_file', arguments: { path: '2.txt' } }] },
        { role: 'user', content: '修改1.txt文件' },
        { role: 'assistant', toolCalls: [{ id: 't2', name: 'write_file', arguments: { path: '1.txt' } }] },
      ],
    });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].messageId).toBe('cp1');
    expect(chapters[0].filesChangedCount).toBe(1);
    expect(chapters[1].messageId).toBe('cp2');
    expect(chapters[1].status).toBe('done');
  });

  it('当前任务图只挂在最后一章', () => {
    const Chronicle = loadChronicle();
    const { chapters } = Chronicle.assemble({
      uiMessages: [
        { role: 'user', id: 'u1', content: '第一问' },
        { role: 'user', id: 'u2', content: '第二问' },
      ],
      structured: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '好' },
        { role: 'user', content: '第二问' },
        { role: 'assistant', content: '好' },
      ],
      currentPlan: { goal: '修登录失败清空表单', phase: 'editing', progress: 40, intent: 'edit' },
    });
    expect(chapters[0].goal).toBe('');
    expect(chapters[1].goal).toBe('修登录失败清空表单');
    expect(chapters[1].phase).toBe('editing');
  });
});
