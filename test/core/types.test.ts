/**
 * Unit tests for core type definitions and validation.
 */

import { describe, it, expect } from 'vitest';
import type { AgentContext, AgentResult, StageStatus } from './types.js';

describe('AgentContext structure', () => {
  it('should allow creation with all required fields', () => {
    const mockLLMAdapter = {
      chat: async () => ({}),
      stream: async () => ({}),
      countTokens: async () => 0,
    };

    const context: AgentContext = {
      executionId: 'exec-123',
      inputData: { text: 'sample input' },
      config: { temperature: 0.7 },
      llmAdapter: mockLLMAdapter,
      outputDir: '/output/exec-123',
    };

    expect(context.executionId).toBe('exec-123');
    expect(context.inputData).toEqual({ text: 'sample input' });
    expect(context.config).toEqual({ temperature: 0.7 });
    expect(context.llmAdapter).toBeDefined();
    expect(context.outputDir).toBe('/output/exec-123');
  });

  it('should support empty inputData and config', () => {
    const context: AgentContext = {
      executionId: 'exec-456',
      inputData: {},
      config: {},
      llmAdapter: {
        chat: async () => ({}),
        stream: async () => ({}),
        countTokens: async () => 0,
      },
      outputDir: '/output',
    };

    expect(context.inputData).toEqual({});
    expect(context.config).toEqual({});
  });
});

describe('AgentResult structure', () => {
  it('should allow creation with success state', () => {
    const result: AgentResult = {
      success: true,
      outputData: { document: 'requirements.md' },
      artifacts: ['/output/requirements.md'],
      summary: 'Successfully generated requirements document',
    };

    expect(result.success).toBe(true);
    expect(result.outputData).toEqual({ document: 'requirements.md' });
    expect(result.artifacts).toEqual(['/output/requirements.md']);
    expect(result.summary).toBe('Successfully generated requirements document');
    expect(result.error).toBeUndefined();
  });

  it('should allow creation with failure state and error message', () => {
    const result: AgentResult = {
      success: false,
      outputData: {},
      artifacts: [],
      summary: 'Failed to generate requirements',
      error: 'Input text contains no identifiable requirements',
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Input text contains no identifiable requirements');
  });
});

describe('StageStatus structure', () => {
  it('should support all valid status values', () => {
    const validStatuses: StageStatus['status'][] = ['pending', 'running', 'completed', 'failed'];
    expect(validStatuses).toHaveLength(4);
  });

  it('should support "failed" status with error message', () => {
    const stage: StageStatus = {
      name: 'code_writing',
      status: 'failed',
      startTime: new Date(),
      error: 'LLM call timed out',
    };

    expect(stage.status).toBe('failed');
    expect(stage.error).toBe('LLM call timed out');
  });
});
