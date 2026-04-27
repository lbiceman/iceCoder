/**
 * Unit tests for BaseAgent and all 6 sub-agents.
 * Tests execute() methods with mock LLM responses and error handling for invalid inputs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentContext } from '../core/types.js';
import { BaseAgent } from '../core/base-agent.js';
import { RequirementAnalysisAgent } from './requirement-analysis.js';
import { DesignAgent } from './design.js';
import { TaskGenerationAgent } from './task-generation.js';
import { CodeWritingAgent } from './code-writing.js';
import { TestingAgent } from './testing.js';
import { RequirementVerificationAgent } from './requirement-verification.js';

function createMockContext(inputData: Record<string, any> = {}): AgentContext {
  return {
    executionId: 'test-exec-123',
    inputData,
    config: {},
    llmAdapter: {
      chat: vi.fn().mockResolvedValue({
        content: 'Mock LLM response',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'mock' },
        finishReason: 'stop',
      }),
      stream: vi.fn().mockResolvedValue({}),
      countTokens: vi.fn().mockResolvedValue(10),
    },
    outputDir: path.join(os.tmpdir(), `agent-test-${randomUUID()}`),
  };
}

// Track output dirs for cleanup
const outputDirs: string[] = [];

afterEach(async () => {
  for (const dir of outputDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  outputDirs.length = 0;
});

describe('BaseAgent', () => {
  // Create a concrete subclass for testing
  class TestAgent extends BaseAgent {
    public doExecuteImpl: ((context: AgentContext) => Promise<any>) | null = null;

    constructor(name: string = 'TestAgent') {
      super(name);
    }

    protected async doExecute(context: AgentContext): Promise<any> {
      if (this.doExecuteImpl) {
        return this.doExecuteImpl(context);
      }
      return { success: true, outputData: {}, artifacts: [], summary: 'done' };
    }
  }

  it('getName() returns the agent name', () => {
    const agent = new TestAgent('MyAgent');
    expect(agent.getName()).toBe('MyAgent');
  });

  it('execute() catches errors and returns failure result', async () => {
    const agent = new TestAgent('FailAgent');
    agent.doExecuteImpl = async () => {
      throw new Error('Something went wrong');
    };

    const ctx = createMockContext();
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');
    expect(result.summary).toContain('FailAgent');
    expect(result.summary).toContain('Something went wrong');
  });

  it('saveDocument creates file in output directory', async () => {
    const agent = new TestAgent('SaveAgent');
    agent.doExecuteImpl = async (context: AgentContext) => {
      const filePath = await (agent as any).saveDocument('hello world', 'test.md', context.outputDir);
      return { success: true, outputData: { filePath }, artifacts: [filePath], summary: 'saved' };
    };

    const ctx = createMockContext();
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);

    const filePath = result.outputData.filePath;
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });
});

describe('RequirementAnalysisAgent', () => {
  it('succeeds with valid text input', async () => {
    const agent = new RequirementAnalysisAgent();
    const ctx = createMockContext({ text: 'The system shall support user authentication and role-based access control.' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.outputData.requirements).toBe('Mock LLM response');
    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0]).toContain('requirements.md');
    expect(ctx.llmAdapter.chat).toHaveBeenCalledTimes(1);
  });

  it('fails with empty text input', async () => {
    const agent = new RequirementAnalysisAgent();
    const ctx = createMockContext({ text: '' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no identifiable requirements');
    expect(ctx.llmAdapter.chat).not.toHaveBeenCalled();
  });

  it('fails with undefined text input', async () => {
    const agent = new RequirementAnalysisAgent();
    const ctx = createMockContext({});
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no identifiable requirements');
  });
});

describe('DesignAgent', () => {
  it('succeeds with valid requirements input', async () => {
    const agent = new DesignAgent();
    const ctx = createMockContext({ requirements: '# Requirements\n1. User login\n2. Dashboard' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.outputData.design).toBe('Mock LLM response');
    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0]).toContain('design.md');
    expect(ctx.llmAdapter.chat).toHaveBeenCalledTimes(1);
  });

  it('fails with empty requirements input', async () => {
    const agent = new DesignAgent();
    const ctx = createMockContext({ requirements: '' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty or undefined');
    expect(ctx.llmAdapter.chat).not.toHaveBeenCalled();
  });
});

describe('TaskGenerationAgent', () => {
  it('succeeds with valid design input', async () => {
    const agent = new TaskGenerationAgent();
    const ctx = createMockContext({ design: '# Design\n## Architecture\nMicroservices pattern' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.outputData.tasks).toBe('Mock LLM response');
    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0]).toContain('tasks.md');
    expect(ctx.llmAdapter.chat).toHaveBeenCalledTimes(1);
  });

  it('fails with empty design input', async () => {
    const agent = new TaskGenerationAgent();
    const ctx = createMockContext({ design: '' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty or undefined');
    expect(ctx.llmAdapter.chat).not.toHaveBeenCalled();
  });
});

describe('CodeWritingAgent', () => {
  it('succeeds with valid tasks input', async () => {
    const agent = new CodeWritingAgent();
    const ctx = createMockContext({ tasks: '# Tasks\nT-001: Implement auth module' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.outputData.code).toBeDefined();
    // 无工具系统时回退到单次 LLM 调用，不会写入文件
    expect(ctx.llmAdapter.chat).toHaveBeenCalled();
  });

  it('fails with empty tasks input', async () => {
    const agent = new CodeWritingAgent();
    const ctx = createMockContext({ tasks: '' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty or undefined');
    expect(ctx.llmAdapter.chat).not.toHaveBeenCalled();
  });
});

describe('TestingAgent', () => {
  it('succeeds with valid requirements input', async () => {
    const agent = new TestingAgent();
    const ctx = createMockContext({
      requirements: '# Requirements\n1. User login\n2. Dashboard',
      design: '# Design\nMicroservices',
      tasks: '# Tasks\nT-001: Auth',
    });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.outputData.testReport).toBeDefined();
    expect(result.artifacts.length).toBeGreaterThanOrEqual(1); // test-report.md
    expect(ctx.llmAdapter.chat).toHaveBeenCalled();
  });

  it('fails with empty requirements input', async () => {
    const agent = new TestingAgent();
    const ctx = createMockContext({ requirements: '' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty or undefined');
    expect(ctx.llmAdapter.chat).not.toHaveBeenCalled();
  });
});

describe('RequirementVerificationAgent', () => {
  it('succeeds with valid requirements and testResults input', async () => {
    const agent = new RequirementVerificationAgent();
    const ctx = createMockContext({
      requirements: '# Requirements\n1. User login\n2. Dashboard',
      testResults: '# Test Report\nAll tests passed. TC-001: Pass',
    });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(true);
    expect(result.outputData.verificationReport).toBe('Mock LLM response');
    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0]).toContain('verification-report.md');
    expect(ctx.llmAdapter.chat).toHaveBeenCalledTimes(1);
  });

  it('fails with empty requirements input', async () => {
    const agent = new RequirementVerificationAgent();
    const ctx = createMockContext({ requirements: '', testResults: 'some results' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty or undefined');
    expect(ctx.llmAdapter.chat).not.toHaveBeenCalled();
  });

  it('fails with empty testResults input', async () => {
    const agent = new RequirementVerificationAgent();
    const ctx = createMockContext({ requirements: 'some requirements', testResults: '' });
    outputDirs.push(ctx.outputDir);

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty or undefined');
    expect(ctx.llmAdapter.chat).not.toHaveBeenCalled();
  });
});
