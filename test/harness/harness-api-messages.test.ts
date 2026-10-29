import { describe, expect, it } from 'vitest';
import { buildMessagesForLlm, mergeEphemeralIntoView } from '../../src/harness/harness-api-messages.js';
import {
  isSubAgentSealed,
  isToolBudgetSealed,
  releaseLegacyToolBudgetSeals,
  sealSubAgentResultsForApi,
  TOOL_RESULT_BUDGET_TRUNCATION_MARKER,
  truncateOldSubAgentResult,
} from '../../src/harness/harness-message-budget.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

const KEEP_RECENT = 6;
const OLD_BUDGET = 3000;

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

describe('buildMessagesForLlm · tool results', () => {
  it('sends older long tool results in full instead of a 3000-char seal', () => {
    const canonical: UnifiedMessage[] = [
      { role: 'user', content: 'hi' },
      ...makeToolMessages(KEEP_RECENT + 4, OLD_BUDGET + 5_000),
    ];
    const fullContent = canonical[1].content as string;

    const apiView = buildMessagesForLlm(canonical, {});

    const oldest = apiView.find(m => m.role === 'tool' && m.toolCallId === 'tc-0');
    expect(oldest!.content).toBe(fullContent);
    expect(canonical[1].apiSealedContent).toBeUndefined();
  });

  it('keeps a theme section in the middle of an early file read visible', () => {
    const themes = ['dark', 'light', 'modern', 'fresh']
      .map(t => `[data-theme="${t}"] {\n${'  --token: #000;\n'.repeat(120)}}`)
      .join('\n\n');
    const canonical: UnifiedMessage[] = [
      { role: 'user', content: 'ui' },
      ...makeAssistantToolRound(0, 0).map(m => (m.role === 'tool' ? { ...m, content: themes } : m)),
      ...Array.from({ length: 10 }, (_, i) => makeAssistantToolRound(i + 1, 200)).flat(),
    ];

    const apiView = buildMessagesForLlm(canonical, {});

    const first = apiView.find(m => m.toolCallId === 'tc-0');
    expect(String(first!.content)).toContain('[data-theme="modern"]');
  });

  it('uses pressureClear seals as the API view without touching content', () => {
    const canonical: UnifiedMessage[] = [
      { role: 'user', content: 'task' },
      {
        role: 'tool',
        toolCallId: 'tc-old',
        content: 'FULL-BODY'.repeat(500),
        apiSealedContent: '[Old tool result cleared for context] tool=grep (~4500 chars removed)',
        apiSealedBy: 'pressureClear',
      },
    ];

    const apiView = buildMessagesForLlm(canonical, {});

    expect(apiView[1].content).toContain('[Old tool result cleared for context]');
    expect(canonical[1].content).toBe('FULL-BODY'.repeat(500));
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
      ...makeToolMessages(KEEP_RECENT + 2, OLD_BUDGET + 500),
    ];
    const ephemeral = { blocks: ['[Workspace Anchor]\nroot\n[/Workspace Anchor]'] };

    const a = buildMessagesForLlm(canonical, ephemeral);
    const b = buildMessagesForLlm(canonical.map(m => ({ ...m })), ephemeral);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps earlier tool bytes stable as canonical grows', () => {
    const ephemeral = { blocks: ['[System Runtime State]\nstatic\n[/System Runtime State]'] };
    let canonical: UnifiedMessage[] = [
      { role: 'user', content: 'task' },
      ...Array.from({ length: KEEP_RECENT + 2 }, (_, i) => makeAssistantToolRound(i, OLD_BUDGET + 500)).flat(),
    ];

    const round1 = buildMessagesForLlm(canonical, ephemeral);
    canonical = [...canonical, ...makeAssistantToolRound(KEEP_RECENT + 2, 100)];
    const round2 = buildMessagesForLlm(canonical, ephemeral);

    expect(round2.find(m => m.toolCallId === 'tc-0')!.content)
      .toBe(round1.find(m => m.toolCallId === 'tc-0')!.content);
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

describe('releaseLegacyToolBudgetSeals', () => {
  it('drops explicit and marker-only 3000-char seals from loaded history', () => {
    const shared: UnifiedMessage = {
      role: 'tool',
      toolCallId: 'a',
      content: 'A'.repeat(5_000),
      apiSealedContent: 'A'.repeat(100),
      apiSealedBy: 'toolBudget',
    };
    const msgs: UnifiedMessage[] = [
      shared,
      {
        role: 'tool',
        toolCallId: 'b',
        content: 'B'.repeat(5_000),
        apiSealedContent: `B${TOOL_RESULT_BUDGET_TRUNCATION_MARKER}原始长度 5000 字符]`,
      },
      {
        role: 'tool',
        toolCallId: 'c',
        content: '[SubAgent Result]\nfull',
        apiSealedContent: 'sealed-sub',
        apiSealedBy: 'subAgent',
      },
    ];

    expect(releaseLegacyToolBudgetSeals(msgs)).toBe(2);
    expect(msgs[0].apiSealedContent).toBeUndefined();
    expect(msgs[0].apiSealedBy).toBeUndefined();
    expect(msgs[1].apiSealedContent).toBeUndefined();
    expect(msgs[2].apiSealedContent).toBe('sealed-sub');
    expect(shared.apiSealedBy).toBe('toolBudget');
  });

  it('does not treat pressureClear or resultBudget as legacy seals', () => {
    const msgs: UnifiedMessage[] = [
      { role: 'tool', toolCallId: 'p', content: 'x', apiSealedContent: 'stub', apiSealedBy: 'pressureClear' },
      { role: 'tool', toolCallId: 'r', content: 'x', apiSealedContent: 'view', apiSealedBy: 'resultBudget' },
    ];
    expect(releaseLegacyToolBudgetSeals(msgs)).toBe(0);
    expect(isToolBudgetSealed(msgs[0])).toBe(false);
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

  it('skips sub-agent results that already carry another seal', () => {
    const msgs: UnifiedMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'tool' as const,
      content: `[SubAgent Result]\nitem-${i}\nagent\nsummary:\n${'s'.repeat(500)}`,
      toolCallId: `sub-${i}`,
    }));
    msgs[0] = { ...msgs[0], apiSealedContent: 'budget-view', apiSealedBy: 'resultBudget' };

    sealSubAgentResultsForApi(msgs);

    expect(msgs[0].apiSealedContent).toBe('budget-view');
    expect(msgs[0].apiSealedBy).toBe('resultBudget');
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
