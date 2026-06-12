import { describe, expect, it } from 'vitest';
import {
  containsEmbeddedToolCalls,
  parseEmbeddedToolCallsFromText,
  prepareAssistantContentForHistory,
  stripEmbeddedToolCalls,
} from '../../src/harness/text-format-tool-call-parsers.js';
import {
  parseTextFormatToolCalls,
  salvageTextToolCallsInResponse,
  sanitizeAssistantContentForUser,
  stripTextFormatToolCalls,
  TextToolCallStreamFilter,
} from '../../src/harness/text-tool-call-salvage.js';

const XML_SAMPLE = `前缀说明
<tool_call>
<function=read_file>
<parameter=path>E:\\test\\main.ts</parameter>
</function>
</tool_call>
<tool_call>
<function=write_file>
<parameter=path>E:\\test\\out.ts</parameter>
<parameter=content>hello</parameter>
</function>
</tool_call>`;

const JSON_SAMPLE = `计划如下：
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
结束`;

const FENCED_SAMPLE = '调用工具：\n```json\n{"tool": "run_command", "parameters": {"command": "npm test"}}\n```';

describe('embedded tool call parsers', () => {
  it('parses XML tag blocks', () => {
    const { calls } = parseEmbeddedToolCallsFromText(XML_SAMPLE);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments.path).toBe('E:\\test\\main.ts');
    expect(calls[1].name).toBe('write_file');
    expect(calls[1].arguments.content).toBe('hello');
  });

  it('parses inline JSON tool objects', () => {
    const { calls } = parseEmbeddedToolCallsFromText(JSON_SAMPLE);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments.path).toBe('src/index.ts');
  });

  it('parses fenced JSON blocks', () => {
    const { calls } = parseEmbeddedToolCallsFromText(FENCED_SAMPLE);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('run_command');
    expect(calls[0].arguments.command).toBe('npm test');
  });

  it('parses unclosed XML tail blocks', () => {
    const tail = '继续读取<tool_call><function=read_file><parameter=path>a.ts</parameter></function>';
    const { calls } = parseEmbeddedToolCallsFromText(tail);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('strips all embedded formats from display text', () => {
    expect(stripEmbeddedToolCalls(XML_SAMPLE)).toBe('前缀说明');
    expect(stripEmbeddedToolCalls(JSON_SAMPLE)).toBe('计划如下：\n结束');
    expect(prepareAssistantContentForHistory(XML_SAMPLE)).toBe('前缀说明');
  });
});

const CHANNEL_BRACKET_SAMPLE = `[调用工具: run_command]]<]minimax[>[<task_id>bg_46rq7i]<]minimax[>[</task_id>]<]minimax[>[<action>check]<]minimax[>[</action>]<]minimax[>[<since>0]<]minimax[>[</since>]<]minimax[>[</invoke>]<]minimax[>[</tool_call>`;

describe('channel-delimiter / bracket-param tool markup', () => {
  it('parses bracket-param run_command check from tail fragment', () => {
    const { calls } = parseEmbeddedToolCallsFromText(CHANNEL_BRACKET_SAMPLE);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.name).toBe('run_command');
    expect(calls[0]?.arguments.task_id).toBe('bg_46rq7i');
    expect(calls[0]?.arguments.action).toBe('check');
  });

  it('strips channel-delimiter markup from display text', () => {
    expect(stripEmbeddedToolCalls(CHANNEL_BRACKET_SAMPLE)).toBe('');
    expect(prepareAssistantContentForHistory(CHANNEL_BRACKET_SAMPLE)).toBe('');
  });
});

describe('text-tool-call-salvage orchestration', () => {
  it('backward-compatible aliases work', () => {
    expect(parseTextFormatToolCalls(XML_SAMPLE)).toHaveLength(2);
    expect(stripTextFormatToolCalls(XML_SAMPLE)).toBe('前缀说明');
    expect(containsEmbeddedToolCalls(XML_SAMPLE)).toBe(true);
  });

  it('strips embedded markup when native tool_calls already present', () => {
    const out = salvageTextToolCallsInResponse({
      content: CHANNEL_BRACKET_SAMPLE,
      toolCalls: [{ id: 'tc-native', name: 'run_command', arguments: { task_id: 'bg_46rq7i', action: 'check' } }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
    });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.content).toBe('');
  });

  it('salvageTextToolCallsInResponse attaches toolCalls and strips content', () => {
    const out = salvageTextToolCallsInResponse({
      content: XML_SAMPLE,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
    });
    expect(out.toolCalls).toHaveLength(2);
    expect(out.finishReason).toBe('tool_calls');
    expect(out.content).toBe('前缀说明');
  });

  it('salvage works for JSON embedded calls', () => {
    const out = salvageTextToolCallsInResponse({
      content: JSON_SAMPLE,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
    });
    expect(out.toolCalls?.[0]?.name).toBe('read_file');
    expect(out.content).toBe('计划如下：\n结束');
  });

  it('sanitize for user display', () => {
    expect(sanitizeAssistantContentForUser(XML_SAMPLE)).toBe('前缀说明');
    expect(sanitizeAssistantContentForUser('{"name":"read_file","arguments":{"path":"a"}}'))
      .toContain('已尝试解析');
  });

  it('TextToolCallStreamFilter strips incrementally', () => {
    const filter = new TextToolCallStreamFilter();
    expect(filter.feed('继续读取')).toBe('继续读取');
    expect(filter.feed('<tool_call><function=read_file>')).toBe('');
    expect(filter.feed('<parameter=path>a.ts</parameter></function></tool_call>')).toBe('');
    expect(filter.flush()).toBe('');

    const jsonFilter = new TextToolCallStreamFilter();
    expect(jsonFilter.feed('x {"name": "read_file"')).toBe('x ');
    expect(jsonFilter.feed(', "arguments": {"path": "a.ts"}}')).toBe('');
    expect(jsonFilter.flush()).toBe('');
  });
});
