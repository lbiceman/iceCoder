/**
 * Unit tests for core type definitions and validation.
 * Validates: Requirements 10.2, 10.3
 */

import { describe, it, expect } from 'vitest';
import { MemoryType } from '../memory/types.js';
import type { AgentContext, AgentResult, StageStatus } from './types.js';

describe('MemoryType enum', () => {
  it('should contain exactly 5 memory types', () => {
    const values = Object.values(MemoryType);
    expect(values).toHaveLength(5);
  });

  it('should have SHORT_TERM with value "short_term"', () => {
    expect(MemoryType.SHORT_TERM).toBe('short_term');
  });

  it('should have LONG_TERM with value "long_term"', () => {
    expect(MemoryType.LONG_TERM).toBe('long_term');
  });

  it('should have EPISODIC with value "episodic"', () => {
    expect(MemoryType.EPISODIC).toBe('episodic');
  });

  it('should have SEMANTIC with value "semantic"', () => {
    expect(MemoryType.SEMANTIC).toBe('semantic');
  });

  it('should have PROCEDURAL with value "procedural"', () => {
    expect(MemoryType.PROCEDURAL).toBe('procedural');
  });

  it('should contain all expected string values', () => {
    const values = Object.values(MemoryType);
    expect(values).toContain('short_term');
    expect(values).toContain('long_term');
    expect(values).toContain('episodic');
    expect(values).toContain('semantic');
    expect(values).toContain('procedural');
  });
});

describe('AgentContext structure', () => {
  it('should allow creation with all required fields', () => {
    const mockMemoryManager = {
      store: async () => ({}),
      retrieve: async () => [],
      delete: async () => true,
      update: async () => ({}),
      consolidate: async () => 0,
      decay: async () => 0,
    };

    const mockLLMAdapter = {
      chat: async () => ({}),
      stream: async () => ({}),
      countTokens: async () => 0,
    };

    const context: AgentContext = {
      executionId: 'exec-123',
      inputData: { text: 'sample input' },
      config: { temperature: 0.7 },
      memoryManager: mockMemoryManager,
      llmAdapter: mockLLMAdapter,
      outputDir: '/output/exec-123',
    };

    expect(context.executionId).toBe('exec-123');
    expect(context.inputData).toEqual({ text: 'sample input' });
    expect(context.config).toEqual({ temperature: 0.7 });
    expect(context.memoryManager).toBeDefined();
    expect(context.llmAdapter).toBeDefined();
    expect(context.outputDir).toBe('/output/exec-123');
  });

  it('should support empty inputData and config', () => {
    const context: AgentContext = {
      executionId: 'exec-456',
      inputData: {},
      config: {},
      memoryManager: {
        store: async () => ({}),
        retrieve: async () => [],
        delete: async () => true,
        update: async () => ({}),
        consolidate: async () => 0,
        decay: async () => 0,
      },
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
    expect(result.outputData).toEqual({});
    expect(result.artifacts).toEqual([]);
    expect(result.summary).toBe('Failed to generate requirements');
    expect(result.error).toBe('Input text contains no identifiable requirements');
  });

  it('should allow creation with multiple artifacts', () => {
    const result: AgentResult = {
      success: true,
      outputData: { files: ['main.ts', 'utils.ts'] },
      artifacts: ['/output/main.ts', '/output/utils.ts', '/output/index.ts'],
      summary: 'Generated 3 source files',
    };

    expect(result.artifacts).toHaveLength(3);
  });
});

describe('StageStatus structure', () => {
  it('should support "pending" status', () => {
    const stage: StageStatus = {
      name: 'requirement_analysis',
      status: 'pending',
    };

    expect(stage.status).toBe('pending');
    expect(stage.startTime).toBeUndefined();
    expect(stage.endTime).toBeUndefined();
    expect(stage.error).toBeUndefined();
  });

  it('should support "running" status with startTime', () => {
    const now = new Date();
    const stage: StageStatus = {
      name: 'design',
      status: 'running',
      startTime: now,
    };

    expect(stage.status).toBe('running');
    expect(stage.startTime).toBe(now);
  });

  it('should support "completed" status with startTime and endTime', () => {
    const start = new Date('2024-01-01T10:00:00Z');
    const end = new Date('2024-01-01T10:05:00Z');
    const stage: StageStatus = {
      name: 'task_generation',
      status: 'completed',
      startTime: start,
      endTime: end,
    };

    expect(stage.status).toBe('completed');
    expect(stage.startTime).toEqual(start);
    expect(stage.endTime).toEqual(end);
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

  it('should only allow valid status literal types', () => {
    const validStatuses: StageStatus['status'][] = ['pending', 'running', 'completed', 'failed'];
    expect(validStatuses).toHaveLength(4);
    expect(validStatuses).toContain('pending');
    expect(validStatuses).toContain('running');
    expect(validStatuses).toContain('completed');
    expect(validStatuses).toContain('failed');
  });
});
