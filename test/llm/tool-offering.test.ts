import { describe, expect, it } from 'vitest';
import { prepareToolsForChatCompletions } from '../../src/llm/tool-offering.js';
import type { ToolDefinition } from '../../src/llm/types.js';

describe('prepareToolsForChatCompletions', () => {
  const toolA: ToolDefinition = {
    name: 'z_last',
    description: 'ZZZ',
    parameters: { type: 'object', properties: {} },
  };
  const toolB: ToolDefinition = {
    name: 'a_first',
    description: 'AAA',
    parameters: { type: 'object', properties: {} },
  };

  it('sorts tools by name', () => {
    const out = prepareToolsForChatCompletions([toolA, toolB])!;
    expect(out.map((t) => t.name)).toEqual(['a_first', 'z_last']);
  });

  it('returns undefined for empty input', () => {
    expect(prepareToolsForChatCompletions(undefined)).toBe(undefined);
    expect(prepareToolsForChatCompletions([])).toEqual([]);
  });
});
