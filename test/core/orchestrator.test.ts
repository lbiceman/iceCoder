/**
 * Unit tests for slim Orchestrator (LLM + FileParser holder).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { LLMAdapter } from '../../src/llm/llm-adapter.js';
import { FileParser } from '../../src/parser/file-parser.js';

describe('Orchestrator', () => {
  let fileParser: FileParser;
  let llmAdapter: LLMAdapter;

  beforeEach(() => {
    fileParser = new FileParser();
    llmAdapter = new LLMAdapter();
  });

  it('getLLMAdapter returns the adapter passed to constructor', () => {
    const orchestrator = new Orchestrator(fileParser, llmAdapter, { outputDir: '/out' });
    expect(orchestrator.getLLMAdapter()).toBe(llmAdapter);
  });

  it('getFileParser returns the parser passed to constructor', () => {
    const orchestrator = new Orchestrator(fileParser, llmAdapter);
    expect(orchestrator.getFileParser()).toBe(fileParser);
  });

  it('getConfig returns a readonly snapshot of config', () => {
    const orchestrator = new Orchestrator(fileParser, llmAdapter, {
      outputDir: '/tmp/out',
      sessionDir: '/tmp/sess',
    });
    expect(orchestrator.getConfig()).toEqual({ outputDir: '/tmp/out', sessionDir: '/tmp/sess' });
  });
});
