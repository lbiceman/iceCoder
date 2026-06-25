import { describe, expect, it } from 'vitest';
import { resolveOpenAiApiMode } from '../../src/llm/openai-responses-bridge.js';
import { OpenAIAdapter } from '../../src/llm/openai-adapter.js';

describe('resolveOpenAiApiMode', () => {
  it('auto-detects Bedrock GPT-5.5 for responses API', () => {
    expect(resolveOpenAiApiMode('openai.gpt-5.5')).toBe('responses');
    expect(resolveOpenAiApiMode('openai.gpt-5.4')).toBe('responses');
  });

  it('keeps chat_completions for typical OpenAI models', () => {
    expect(resolveOpenAiApiMode('gpt-4o')).toBe('chat_completions');
    expect(resolveOpenAiApiMode('deepseek-chat')).toBe('chat_completions');
  });

  it('respects explicit apiMode override', () => {
    expect(resolveOpenAiApiMode('gpt-4o', 'responses')).toBe('responses');
    expect(resolveOpenAiApiMode('openai.gpt-5.5', 'chat_completions')).toBe('chat_completions');
  });
});

describe('OpenAIAdapter apiMode wiring', () => {
  it('uses responses mode for openai.gpt-5.5 without explicit config', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test-key', model: 'openai.gpt-5.5' });
    expect((adapter as unknown as { apiMode: string }).apiMode).toBe('responses');
  });
});
