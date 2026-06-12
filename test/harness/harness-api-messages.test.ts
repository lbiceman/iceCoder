import { describe, expect, it } from 'vitest';
import { buildMessagesForLlm, mergeEphemeralIntoView } from '../../src/harness/harness-api-messages.js';
import {
  isSubAgentSealed,
  isToolBudgetSealed,
  sealSubAgentResultsForApi,
  sealToolResultsForApi,
  TOOL_RESULT_BUDGET_TRUNCATION_MARKER,
  truncateOldSubAgentResult,
} from '../../src/harness/harness-message-budget.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { TOOL_RESULT_BUDGET_PER_MESSAGE, TOOL_RESULT_KEEP_RECENT } from '../../src/harness/harness-constants.js';

function makeAssistantToolRound(i: number, contentLen: number): UnifiedMessage[] {
  const tcId = `tc-${i}`;
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: tcId, name: 'read_file', arguments: {} }],
    },
    {
      role: 'tool',
      content: `tool-${i}:${'x'.repeat(contentLen)}`,
      toolCallId: tcId,
    },
  ];
}

function makeToolMessages(count: number, contentLen: number): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: 'tool',
      content: `tool-${i}:${'x'.repeat(contentLen)}`,
      toolCallId: `tc-${i}`,
    });
  }
  return msgs;
}

describe('sealToolResultsForApi', () => {
  it('does not modify content on canonical messages', () => {
    const msgs = makeToolMessages(TOOL_RESULT_KEEP_RECENT + 2, TOOL_RESULT_BUDGET_PER_MESSAGE + 500);
    const originalContent = msgs[0].content as string;

    sealToolResultsForApi(msgs);

    expect(msgs[0].content).toBe(originalContent);
    expect(msgs[0].apiSealedContent).toBeDefined();
    expect(msgs[0].apiSealedBy).toBe('toolBudget');
    expect((msgs[0].apiSealedContent as string).length).toBeLessThan(originalContent.length);
  });

  it('keeps recent tool messages unsealed when under budget', () => {
    const msgs = makeToolMessages(TOOL_RESULT_KEEP_RECENT + 2, 100);
    sealToolResultsForApi(msgs);

    const recent = msgs.slice(-TOOL_RESULT_KEEP_RECENT);
    for (const msg of recent) {
      expect(msg.apiSealedContent).toBeUndefined();
    }
  });

  it('never changes apiSealedContent once tool budget sealed', () => {
    const msgs = makeToolMessages(TOOL_RESULT_KEEP_RECENT + 3, TOOL_RESULT_BUDGET_PER_MESSAGE + 100);
    sealToolResultsForApi(msgs);
    const firstSeal = msgs[0].apiSealedContent;
    expect(firstSeal).toContain(TOOL_RESULT_BUDGET_TRUNCATION_MARKER);

    msgs.push({
      role: 'tool',
      content: 'y'.repeat(TOOL_RESULT_BUDGET_PER_MESSAGE + 200),
      toolCallId: 'tc-new',
    });
    sealToolResultsForApi(msgs);

    expect(msgs[0].apiSealedContent).toBe(firstSeal);
    expect(msgs[0].apiSealedBy).toBe('toolBudget');
  });

  it('does not re-seal legacy tool budget without apiSealedBy when marker matches', () => {
    const legacySeal = 'x'.repeat(100) + TOOL_RESULT_BUDGET_TRUNCATION_MARKER + '原始长度 999 字符]';
    const msgs = makeToolMessages(TOOL_RESULT_KEEP_RECENT + 2, TOOL_RESULT_BUDGET_PER_MESSAGE + 500);
    msgs[0] = { ...msgs[0], apiSealedContent: legacySeal };

    sealToolResultsForApi(msgs);

    expect(msgs[0].apiSealedContent).toBe(legacySeal);
    expect(msgs[0].apiSealedBy).toBeUndefined();
    expect(isToolBudgetSealed(msgs[0])).toBe(true);
  });

  it('does not seal short tools in crop zone when under budget', () => {
    const msgs = makeToolMessages(TOOL_RESULT_KEEP_RECENT + 2, 100);
    sealToolResultsForApi(msgs);

    expect(msgs[0].apiSealedContent).toBeUndefined();
    expect(msgs[0].apiSealedBy).toBeUndefined();
    expect(msgs[1].apiSealedContent).toBeUndefined();
    expect(msgs[1].apiSealedBy).toBeUndefined();
  });

  it('does not count sub-agent tools toward KEEP_RECENT window', () => {
    const long = TOOL_RESULT_BUDGET_PER_MESSAGE + 500;
    const msgs: UnifiedMessage[] = [
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-0' },
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-1' },
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-2' },
      {
        role: 'tool',
        content: '[SubAgent Result]\nshort',
        toolCallId: 'sub-0',
        apiSealedContent: 'sealed-sub',
        apiSealedBy: 'subAgent',
      },
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-3' },
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-4' },
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-5' },
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-6' },
      { role: 'tool', content: 'x'.repeat(long), toolCallId: 'reg-7' },
    ];

    sealToolResultsForApi(msgs);

    // 8 条普通 tool → cutoff=2，仅 reg-0/reg-1 进裁剪区；中间的 sub 不占槽
    expect(msgs[0].apiSealedContent).toBeDefined();
    expect(msgs[1].apiSealedContent).toBeDefined();
    expect(msgs[2].apiSealedContent).toBeUndefined();
    expect(msgs[3].apiSealedContent).toBe('sealed-sub');
  });

  it('ignores sub-agent tools in sealToolResultsForApi', () => {
    const msgs = makeToolMessages(2, 100);
    msgs[0] = {
      role: 'tool',
      content: '[SubAgent Result]\n' + 'x'.repeat(TOOL_RESULT_BUDGET_PER_MESSAGE + 500),
      toolCallId: 'sub-0',
      apiSealedContent: 'y'.repeat(TOOL_RESULT_BUDGET_PER_MESSAGE + 500),
      apiSealedBy: 'subAgent',
    };

    sealToolResultsForApi(msgs);

    expect(msgs[0].apiSealedContent).toBe('y'.repeat(TOOL_RESULT_BUDGET_PER_MESSAGE + 500));
    expect(msgs[0].apiSealedContent).not.toContain(TOOL_RESULT_BUDGET_TRUNCATION_MARKER);
  });
});

describe('buildMessagesForLlm', () => {
  it('maps apiSealedContent to content in API view only', () => {
    const canonical: UnifiedMessage[] = [
      { role: 'user', content: 'hi' },
      ...makeToolMessages(TOOL_RESULT_KEEP_RECENT + 1, TOOL_RESULT_BUDGET_PER_MESSAGE + 200),
    ];
    const fullContent = canonical[1].content as string;

    const apiView = buildMessagesForLlm(canonical, {});

    expect(canonical[1].content).toBe(fullContent);
    const sealedTool = apiView.find(m => m.role === 'tool' && m.toolCallId === 'tc-0');
    expect(sealedTool).toBeDefined();
    expect(sealedTool!.content).not.toBe(fullContent);
    expect(String(sealedTool!.content)).toContain('工具结果已裁剪');
  });

  it('appends ephemeral blocks at the end without mutating canonical', () => {
    const canonical: UnifiedMessage[] = [{ role: 'user', content: 'task' }];
    const beforeLen = canonical.length;

    const apiView = buildMessagesForLlm(canonical, {
      blocks: ['[System Runtime State]\nstate\n[/System Runtime State]'],
    });

    expect(canonical.length).toBe(beforeLen);
    const runtimeInView = apiView.find(m =>
      typeof m.content === 'string' && m.content.includes('[System Runtime State]'),
    );
    expect(runtimeInView).toBeDefined();
  });

  it('keeps ephemeral separate from trailing canonical user for cache-friendly tail', () => {
    const canonical: UnifiedMessage[] = [
      { role: 'user', content: '<system-reminder>Recalled Memories\nstable memory</system-reminder>' },
    ];
    const apiView = buildMessagesForLlm(canonical, {
      blocks: ['[System Runtime State]\nrt\n[/System Runtime State]'],
    });

    expect(apiView).toHaveLength(2);
    expect(apiView[0].content).toBe('<system-reminder>Recalled Memories\nstable memory</system-reminder>');
    expect(String(apiView[1].content)).toContain('[System Runtime State]');
    expect(String(apiView[0].content)).not.toContain('[System Runtime State]');
  });

  it('produces identical API view for same canonical and ephemeral inputs', () => {
    const canonical: UnifiedMessage[] = [
      { role: 'user', content: 'task' },
      ...makeToolMessages(TOOL_RESULT_KEEP_RECENT + 2, TOOL_RESULT_BUDGET_PER_MESSAGE + 500),
    ];
    const ephemeral = { blocks: ['[Workspace Anchor]\nroot\n[/Workspace Anchor]'] };

    const a = buildMessagesForLlm(canonical, ephemeral);
    const b = buildMessagesForLlm(canonical.map(m => ({ ...m })), ephemeral);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('preserves sealed tool bytes when canonical grows with same ephemeral', () => {
    const ephemeral = { blocks: ['[System Runtime State]\nstatic\n[/System Runtime State]'] };
    const long = TOOL_RESULT_BUDGET_PER_MESSAGE + 500;
    let canonical: UnifiedMessage[] = [
      { role: 'user', content: 'task' },
      ...Array.from({ length: TOOL_RESULT_KEEP_RECENT + 2 }, (_, i) => makeAssistantToolRound(i, long)).flat(),
    ];

    const round1 = buildMessagesForLlm(canonical, ephemeral);
    const sealedToolRound1 = round1.find(m => m.toolCallId === 'tc-0');

    canonical = [
      ...canonical,
      ...makeAssistantToolRound(TOOL_RESULT_KEEP_RECENT + 2, 100),
    ];

    const round2 = buildMessagesForLlm(canonical, ephemeral);
    const sealedToolRound2 = round2.find(m => m.toolCallId === 'tc-0');
    const firstTool = canonical.find(m => m.toolCallId === 'tc-0')!;

    expect(sealedToolRound2!.content).toBe(sealedToolRound1!.content);
    expect(firstTool.apiSealedContent).toBeDefined();
    expect(firstTool.content).toBe(`tool-0:${'x'.repeat(long)}`);
  });

  it('merges multiple ephemeral blocks into a single trailing user message', () => {
    const view: UnifiedMessage[] = [
      { role: 'assistant', content: 'done' },
    ];
    mergeEphemeralIntoView(view, {
      blocks: [
        '[System Runtime State]\na\n[/System Runtime State]',
        '[Workspace Anchor]\nb\n[/Workspace Anchor]',
      ],
    });

    expect(view).toHaveLength(2);
    expect(view[1].role).toBe('user');
    expect(view[1].content).toContain('[System Runtime State]');
    expect(view[1].content).toContain('[Workspace Anchor]');
  });
});

describe('truncateOldSubAgentResult', () => {
  it('preserves header before summary marker', () => {
    const content = `header\nsummary:\n${'s'.repeat(500)}`;
    const truncated = truncateOldSubAgentResult(content);
    expect(truncated).toContain('header\nsummary:\n');
  });
});

describe('sealSubAgentResultsForApi', () => {
  it('writes apiSealedContent without changing content', () => {
    const body = `agent\nsummary:\n${'s'.repeat(500)}`;
    const content = `[SubAgent Result]\n${body}`;
    const msgs: UnifiedMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'tool' as const,
      content: `[SubAgent Result]\nitem-${i}\n${body}`,
      toolCallId: `sub-${i}`,
    }));

    sealSubAgentResultsForApi(msgs);

    expect(msgs[0].content).toContain('[SubAgent Result]');
    expect(msgs[0].apiSealedContent).toBeDefined();
    expect(msgs[0].apiSealedBy).toBe('subAgent');
    expect(msgs[0].apiSealedContent).not.toBe(msgs[0].content);
  });

  it('skips sub-agent when already tool-budget sealed (legacy migration)', () => {
    const legacy = 'truncated' + TOOL_RESULT_BUDGET_TRUNCATION_MARKER + '原始长度 1 字符]';
    const msgs: UnifiedMessage[] = [{
      role: 'tool',
      content: `[SubAgent Result]\n${'s'.repeat(500)}`,
      toolCallId: 'sub-0',
      apiSealedContent: legacy,
      apiSealedBy: 'toolBudget',
    }];

    sealSubAgentResultsForApi(msgs);

    expect(msgs[0].apiSealedContent).toBe(legacy);
    expect(msgs[0].apiSealedBy).toBe('toolBudget');
  });

  it('detects legacy sub-agent seal via content marker', () => {
    const legacy = 'head\n...[旧子代理摘要已裁剪，原始长度 9 字符]';
    const msg: UnifiedMessage = {
      role: 'tool',
      content: '[SubAgent Result]\nfull',
      toolCallId: 'sub-0',
      apiSealedContent: legacy,
    };
    expect(isSubAgentSealed(msg)).toBe(true);
    expect(isToolBudgetSealed(msg)).toBe(false);
  });
});
