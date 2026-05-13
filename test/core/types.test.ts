/**
 * Unit tests for core type definitions (LLMAdapter shape).
 */

import { describe, it, expect } from 'vitest';
import type { LLMAdapter } from '../../src/core/types.js';

describe('LLMAdapter interface', () => {
  it('accepts minimal implementation with chat and stream', () => {
    const adapter: LLMAdapter = {
      chat: async () => ({}),
      stream: async () => ({}),
    };
    expect(adapter.chat).toBeDefined();
    expect(adapter.stream).toBeDefined();
  });

  it('optional setAbortSignal is allowed', () => {
    const adapter: LLMAdapter = {
      chat: async () => ({}),
      stream: async () => ({}),
      setAbortSignal: () => {},
    };
    adapter.setAbortSignal?.(new AbortController().signal);
    expect(true).toBe(true);
  });
});
