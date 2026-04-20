/**
 * Unit tests for Orchestrator and pipeline execution.
 * Tests agent registration/unregistration, pipeline stage ordering,
 * failure handling, output chaining, report generation, cross-agent memory,
 * and event emission.
 *
 * Requirements: 2.1, 2.2, 2.4, 10.4, 18.4, 18.7
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Orchestrator, OrchestratorConfig } from './orchestrator.js';
import { BaseAgent } from './base-agent.js';
import { FileParser } from '../parser/file-parser.js';
import type { AgentContext, AgentResult, LLMAdapter, PipelineState, StageStatus } from './types.js';

// --- Mock Agent ---

class MockAgent extends BaseAgent {
  constructor(name: string, private shouldFail: boolean = false) {
    super(name);
  }
  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    if (this.shouldFail) {
      return { success: false, outputData: {}, artifacts: [], summary: 'Failed', error: 'Mock failure' };
    }
    return {
      success: true,
      outputData: { [this.name.toLowerCase()]: `${this.name} output` },
      artifacts: [],
      summary: `${this.name} completed`,
    };
  }
}

// --- Mock FileParser ---

function createMockFileParser(shouldSucceed: boolean = true): FileParser {
  const parser = new FileParser();
  // Register a mock strategy for 'txt' extension
  parser.registerStrategy({
    supportedExtensions: ['txt'],
    parse: async (buffer: Buffer, filename: string) => {
      if (!shouldSucceed) {
        return { success: false, content: '', metadata: { filename, format: 'txt' }, error: 'Parse failed' };
      }
      return {
        success: true,
        content: buffer.toString('utf-8'),
        metadata: { filename, format: 'txt' },
      };
    },
  });
  return parser;
}

// --- Mock LLM Adapter ---

function createMockLLMAdapter(): LLMAdapter {
  return {
    chat: vi.fn().mockResolvedValue({
      content: 'Mock LLM response',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'mock' },
      finishReason: 'stop',
    }),
    stream: vi.fn().mockResolvedValue({}),
    countTokens: vi.fn().mockResolvedValue(10),
  };
}

// --- Helpers ---

let tempDirs: string[] = [];

function createTempDir(): string {
  const dir = path.join(os.tmpdir(), `orchestrator-test-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

function createOrchestrator(opts?: { fileParserSuccess?: boolean }): Orchestrator {
  const outputDir = createTempDir();
  const memoryDir = createTempDir();
  const fileParser = createMockFileParser(opts?.fileParserSuccess ?? true);
  const llmAdapter = createMockLLMAdapter();
  const config: OrchestratorConfig = {
    outputDir,
    memoryConfig: {
      longTerm: { dbPath: memoryDir },
    },
  };
  return new Orchestrator(fileParser, llmAdapter, config);
}

function registerAllAgents(orchestrator: Orchestrator, failingAgent?: string): void {
  const agentNames = [
    'RequirementAnalysis',
    'Design',
    'TaskGeneration',
    'CodeWriting',
    'Testing',
    'RequirementVerification',
  ];
  for (const name of agentNames) {
    orchestrator.registerAgent(new MockAgent(name, name === failingAgent));
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tempDirs = [];
});

// --- Tests ---

describe('Orchestrator - Agent Registration', () => {
  it('registerAgent adds agent and creates MemoryManager', () => {
    const orchestrator = createOrchestrator();
    const agent = new MockAgent('TestAgent');

    orchestrator.registerAgent(agent);

    expect(orchestrator.getAgents().has('TestAgent')).toBe(true);
    expect(orchestrator.getMemoryManagers().has('TestAgent')).toBe(true);
  });

  it('unregisterAgent removes agent and MemoryManager', () => {
    const orchestrator = createOrchestrator();
    const agent = new MockAgent('TestAgent');

    orchestrator.registerAgent(agent);
    expect(orchestrator.getAgents().has('TestAgent')).toBe(true);

    orchestrator.unregisterAgent('TestAgent');
    expect(orchestrator.getAgents().has('TestAgent')).toBe(false);
    expect(orchestrator.getMemoryManagers().has('TestAgent')).toBe(false);
  });
});

describe('Orchestrator - Pipeline Execution', () => {
  it('executePipeline runs all 6 stages in order when all succeed', async () => {
    const orchestrator = createOrchestrator();
    registerAllAgents(orchestrator);

    const input = Buffer.from('Test requirement content');
    const state = await orchestrator.executePipeline(input, 'test.txt');

    expect(state.stages.length).toBe(6);
    expect(state.stages[0].name).toBe('RequirementAnalysis');
    expect(state.stages[1].name).toBe('Design');
    expect(state.stages[2].name).toBe('TaskGeneration');
    expect(state.stages[3].name).toBe('CodeWriting');
    expect(state.stages[4].name).toBe('Testing');
    expect(state.stages[5].name).toBe('RequirementVerification');

    // All stages should be completed
    for (const stage of state.stages) {
      expect(stage.status).toBe('completed');
    }

    // Pipeline should have an end time
    expect(state.endTime).toBeDefined();
  });

  it('executePipeline stops on first stage failure', async () => {
    const orchestrator = createOrchestrator();
    registerAllAgents(orchestrator, 'Design'); // Design agent will fail

    const input = Buffer.from('Test requirement content');
    const state = await orchestrator.executePipeline(input, 'test.txt');

    // RequirementAnalysis should succeed
    expect(state.stages[0].status).toBe('completed');
    // Design should fail
    expect(state.stages[1].status).toBe('failed');
    expect(state.stages[1].error).toBe('Mock failure');
    // Remaining stages should still be pending
    expect(state.stages[2].status).toBe('pending');
    expect(state.stages[3].status).toBe('pending');
    expect(state.stages[4].status).toBe('pending');
    expect(state.stages[5].status).toBe('pending');

    // Pipeline should have an end time
    expect(state.endTime).toBeDefined();
  });

  it('stage outputs are chained as inputs to next stages', async () => {
    const orchestrator = createOrchestrator();

    // Use spied agents to verify input data
    const executedInputs: Record<string, Record<string, any>> = {};

    class SpyAgent extends BaseAgent {
      constructor(name: string) {
        super(name);
      }
      protected async doExecute(context: AgentContext): Promise<AgentResult> {
        executedInputs[this.name] = { ...context.inputData };
        return {
          success: true,
          outputData: { [`${this.name.toLowerCase()}_key`]: `${this.name} data` },
          artifacts: [],
          summary: `${this.name} completed`,
        };
      }
    }

    const agentNames = [
      'RequirementAnalysis',
      'Design',
      'TaskGeneration',
      'CodeWriting',
      'Testing',
      'RequirementVerification',
    ];
    for (const name of agentNames) {
      orchestrator.registerAgent(new SpyAgent(name));
    }

    const input = Buffer.from('Test content');
    await orchestrator.executePipeline(input, 'test.txt');

    // RequirementAnalysis receives parsed content
    expect(executedInputs['RequirementAnalysis']).toHaveProperty('content');

    // Design receives RequirementAnalysis output
    expect(executedInputs['Design']).toHaveProperty('requirementanalysis_key');

    // TaskGeneration receives Design output
    expect(executedInputs['TaskGeneration']).toHaveProperty('design_key');

    // CodeWriting receives TaskGeneration output
    expect(executedInputs['CodeWriting']).toHaveProperty('taskgeneration_key');

    // Testing receives requirements, design, and tasks
    expect(executedInputs['Testing']).toHaveProperty('requirements');
    expect(executedInputs['Testing']).toHaveProperty('design');
    expect(executedInputs['Testing']).toHaveProperty('tasks');

    // RequirementVerification receives requirements and testResults
    expect(executedInputs['RequirementVerification']).toHaveProperty('requirements');
    expect(executedInputs['RequirementVerification']).toHaveProperty('testResults');
  });

  it('reports are generated for each completed stage', async () => {
    const orchestrator = createOrchestrator();
    registerAllAgents(orchestrator);

    const input = Buffer.from('Test requirement content');
    const state = await orchestrator.executePipeline(input, 'test.txt');

    // Check that report files were created in the output directory
    const outputDir = (orchestrator as any).config.outputDir;
    const files = await fs.readdir(outputDir);

    // Should have 6 stage reports + 1 pipeline summary = 7 files
    expect(files.length).toBe(7);

    // Verify stage report naming convention
    const stageNames = [
      'RequirementAnalysis',
      'Design',
      'TaskGeneration',
      'CodeWriting',
      'Testing',
      'RequirementVerification',
    ];
    for (const stageName of stageNames) {
      const reportFile = files.find(f => f.includes(stageName) && f.endsWith('_report.md'));
      expect(reportFile).toBeDefined();
    }

    // Verify pipeline summary exists
    const summaryFile = files.find(f => f.includes('pipeline_summary'));
    expect(summaryFile).toBeDefined();
  });
});

describe('Orchestrator - Cross-Agent Memory', () => {
  it('crossAgentMemoryRetrieve returns memories from target agent', async () => {
    const orchestrator = createOrchestrator();
    const agent = new MockAgent('TargetAgent');
    orchestrator.registerAgent(agent);

    // Store something in the target agent's memory
    const targetMemory = orchestrator.getMemoryManagers().get('TargetAgent');
    expect(targetMemory).toBeDefined();
    await targetMemory!.store('important fact', 'short_term', { sourceAgent: 'TargetAgent' });

    // Cross-agent retrieval should work
    const results = await orchestrator.crossAgentMemoryRetrieve('RequestingAgent', 'TargetAgent', 'important');
    expect(Array.isArray(results)).toBe(true);
  });

  it('crossAgentMemoryRetrieve throws error for non-existent target agent', async () => {
    const orchestrator = createOrchestrator();

    await expect(
      orchestrator.crossAgentMemoryRetrieve('RequestingAgent', 'NonExistentAgent', 'query')
    ).rejects.toThrow('Target agent "NonExistentAgent" does not exist');
  });
});

describe('Orchestrator - Event Emission', () => {
  it('emits stage_change events during pipeline execution', async () => {
    const orchestrator = createOrchestrator();
    registerAllAgents(orchestrator);

    const stageChanges: StageStatus[] = [];
    orchestrator.onStageChange((stage) => {
      stageChanges.push({ ...stage });
    });

    const input = Buffer.from('Test content');
    await orchestrator.executePipeline(input, 'test.txt');

    // Each stage emits at least 2 events: running and completed
    // 6 stages * 2 = 12 minimum events
    expect(stageChanges.length).toBeGreaterThanOrEqual(12);

    // Verify we see both 'running' and 'completed' statuses
    const runningEvents = stageChanges.filter(s => s.status === 'running');
    const completedEvents = stageChanges.filter(s => s.status === 'completed');
    expect(runningEvents.length).toBe(6);
    expect(completedEvents.length).toBe(6);
  });

  it('emits pipeline_complete event when pipeline finishes', async () => {
    const orchestrator = createOrchestrator();
    registerAllAgents(orchestrator);

    let completedState: PipelineState | null = null;
    orchestrator.onPipelineComplete((state) => {
      completedState = state;
    });

    const input = Buffer.from('Test content');
    await orchestrator.executePipeline(input, 'test.txt');

    expect(completedState).not.toBeNull();
    expect(completedState!.endTime).toBeDefined();
    expect(completedState!.stages.every(s => s.status === 'completed')).toBe(true);
  });

  it('emits pipeline_complete event on failure', async () => {
    const orchestrator = createOrchestrator();
    registerAllAgents(orchestrator, 'TaskGeneration');

    let completedState: PipelineState | null = null;
    orchestrator.onPipelineComplete((state) => {
      completedState = state;
    });

    const input = Buffer.from('Test content');
    await orchestrator.executePipeline(input, 'test.txt');

    expect(completedState).not.toBeNull();
    expect(completedState!.endTime).toBeDefined();
    // Should have a failed stage
    const failedStage = completedState!.stages.find(s => s.status === 'failed');
    expect(failedStage).toBeDefined();
    expect(failedStage!.name).toBe('TaskGeneration');
  });
});
