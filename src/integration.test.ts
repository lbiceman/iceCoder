/**
 * Integration tests for end-to-end pipeline flow.
 *
 * Tests:
 * 1. Full pipeline execution from HTML file upload through all 6 stages to final report
 * 2. SSE events are emitted at each stage transition
 * 3. Config save and reload affects LLM adapter behavior
 * 4. Cross-agent memory sharing during pipeline execution
 *
 * Requirements: 2.1, 2.2, 2.5, 9.3, 18.4, 19.5
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Orchestrator, OrchestratorConfig } from './core/orchestrator.js';
import { BaseAgent } from './core/base-agent.js';
import { FileParser } from './parser/file-parser.js';
import { HtmlParserStrategy } from './parser/html-strategy.js';
import { LLMAdapter } from './llm/llm-adapter.js';
import type {
  AgentContext,
  AgentResult,
  PipelineState,
  StageStatus,
} from './core/types.js';
import type { ProviderAdapter, LLMOptions, LLMResponse, StreamCallback, UnifiedMessage } from './llm/types.js';

// --- Mock Agent that produces realistic output ---

class IntegrationMockAgent extends BaseAgent {
  constructor(name: string) {
    super(name);
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    // Store a summary to episodic memory via the context's memoryManager
    await context.memoryManager.store(
      `${this.name} processed input and produced output`,
      'short_term' as any,
      { sourceAgent: this.name, executionId: context.executionId, stage: this.name },
    );

    return {
      success: true,
      outputData: {
        [`${this.name}_result`]: `Output from ${this.name}`,
        content: `Generated content by ${this.name}`,
      },
      artifacts: [`${this.name.toLowerCase()}_output.md`],
      summary: `${this.name} completed successfully`,
    };
  }
}

// --- Mock LLM Provider Adapter ---

class MockProviderAdapter implements ProviderAdapter {
  name: string;
  callCount = 0;

  constructor(name: string) {
    this.name = name;
  }

  async chat(messages: UnifiedMessage[], options: LLMOptions): Promise<LLMResponse> {
    this.callCount++;
    return {
      content: `Mock response from ${this.name}`,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: this.name },
      finishReason: 'stop',
    };
  }

  async stream(messages: UnifiedMessage[], callback: StreamCallback, options: LLMOptions): Promise<LLMResponse> {
    callback('Mock stream chunk', true);
    return {
      content: 'Mock stream response',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: this.name },
      finishReason: 'stop',
    };
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }
}

// --- Helpers ---

let tempDirs: string[] = [];

function createTempDir(): string {
  const dir = path.join(os.tmpdir(), `integration-test-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

const STAGE_NAMES = [
  'RequirementAnalysis',
  'Design',
  'TaskGeneration',
  'CodeWriting',
  'Testing',
  'RequirementVerification',
];

function createSampleHtmlBuffer(): Buffer {
  return Buffer.from(`
    <html>
      <body>
        <h1>Project Requirements</h1>
        <p>The system shall support user authentication.</p>
        <h2>Functional Requirements</h2>
        <ul>
          <li>Login with email and password</li>
          <li>Password reset via email</li>
        </ul>
        <h2>Non-Functional Requirements</h2>
        <p>Response time under 200ms for all API endpoints.</p>
      </body>
    </html>
  `);
}

function createFullOrchestrator(): {
  orchestrator: Orchestrator;
  outputDir: string;
  memoryDir: string;
  llmAdapter: LLMAdapter;
} {
  const outputDir = createTempDir();
  const memoryDir = createTempDir();

  // Real FileParser with HTML strategy
  const fileParser = new FileParser();
  fileParser.registerStrategy(new HtmlParserStrategy());

  // Mock LLM adapter
  const llmAdapter = new LLMAdapter();
  const mockProvider = new MockProviderAdapter('openai');
  llmAdapter.registerProvider(mockProvider);
  llmAdapter.setDefaultProvider('openai');

  const config: OrchestratorConfig = {
    outputDir,
    memoryConfig: {
      longTerm: { dbPath: memoryDir },
    },
  };

  const orchestrator = new Orchestrator(fileParser, llmAdapter, config);

  // Register all 6 agents
  for (const name of STAGE_NAMES) {
    orchestrator.registerAgent(new IntegrationMockAgent(name));
  }

  return { orchestrator, outputDir, memoryDir, llmAdapter };
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

// --- Integration Tests ---

describe('Integration: Full Pipeline Execution', () => {
  it('executes all 6 stages from HTML file upload to final report', async () => {
    const { orchestrator, outputDir } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    const state = await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    // All 6 stages should be present and completed
    expect(state.stages.length).toBe(6);
    for (let i = 0; i < STAGE_NAMES.length; i++) {
      expect(state.stages[i].name).toBe(STAGE_NAMES[i]);
      expect(state.stages[i].status).toBe('completed');
    }

    // Pipeline should have start and end times
    expect(state.startTime).toBeInstanceOf(Date);
    expect(state.endTime).toBeInstanceOf(Date);

    // Execution ID should be a valid UUID-like string
    expect(state.executionId).toBeTruthy();
    expect(typeof state.executionId).toBe('string');

    // Stage outputs should be stored for all 6 stages plus the __parsed__ pseudo-stage
    expect(state.stageOutputs.size).toBeGreaterThanOrEqual(6);

    // Reports should be generated in the output directory
    const files = await fs.readdir(outputDir);
    // 6 stage reports + 1 pipeline summary = 7 files
    expect(files.length).toBe(7);

    // Verify each stage has a report file
    for (const stageName of STAGE_NAMES) {
      const reportFile = files.find(f => f.includes(stageName) && f.endsWith('_report.md'));
      expect(reportFile).toBeDefined();
    }

    // Verify pipeline summary exists
    const summaryFile = files.find(f => f.includes('pipeline_summary'));
    expect(summaryFile).toBeDefined();

    // Verify report content is non-empty
    const firstReport = files.find(f => f.includes('RequirementAnalysis'))!;
    const reportContent = await fs.readFile(path.join(outputDir, firstReport), 'utf-8');
    expect(reportContent.length).toBeGreaterThan(0);
    expect(reportContent).toContain('RequirementAnalysis');
  });

  it('chains stage outputs correctly through the pipeline', async () => {
    const { orchestrator } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    const state = await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    // Verify each stage produced output data
    for (const stageName of STAGE_NAMES) {
      const output = state.stageOutputs.get(stageName);
      expect(output).toBeDefined();
      expect(output!.success).toBe(true);
      expect(output!.summary).toContain(stageName);
    }

    // Verify parsed content was stored
    const parsedOutput = state.stageOutputs.get('__parsed__');
    expect(parsedOutput).toBeDefined();
    expect(parsedOutput!.outputData.content).toBeTruthy();
  });
});

describe('Integration: SSE Events During Pipeline', () => {
  it('emits stage_change events for each stage transition', async () => {
    const { orchestrator } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    const stageChanges: StageStatus[] = [];
    orchestrator.onStageChange((stage) => {
      stageChanges.push({ ...stage });
    });

    await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    // Each of the 6 stages should emit at least 2 events: running + completed
    expect(stageChanges.length).toBeGreaterThanOrEqual(12);

    // Verify running events for all stages
    const runningEvents = stageChanges.filter(s => s.status === 'running');
    expect(runningEvents.length).toBe(6);
    for (const stageName of STAGE_NAMES) {
      expect(runningEvents.some(e => e.name === stageName)).toBe(true);
    }

    // Verify completed events for all stages
    const completedEvents = stageChanges.filter(s => s.status === 'completed');
    expect(completedEvents.length).toBe(6);
    for (const stageName of STAGE_NAMES) {
      expect(completedEvents.some(e => e.name === stageName)).toBe(true);
    }

    // Verify ordering: for each stage, running comes before completed
    for (const stageName of STAGE_NAMES) {
      const runningIdx = stageChanges.findIndex(s => s.name === stageName && s.status === 'running');
      const completedIdx = stageChanges.findIndex(s => s.name === stageName && s.status === 'completed');
      expect(runningIdx).toBeLessThan(completedIdx);
    }
  });

  it('emits pipeline_complete event with final state', async () => {
    const { orchestrator } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    let completedState: PipelineState | null = null;
    orchestrator.onPipelineComplete((state) => {
      completedState = state;
    });

    await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    expect(completedState).not.toBeNull();
    expect(completedState!.endTime).toBeDefined();
    expect(completedState!.stages.length).toBe(6);
    expect(completedState!.stages.every(s => s.status === 'completed')).toBe(true);
  });

  it('emits stage_change events with timing information', async () => {
    const { orchestrator } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    const stageChanges: StageStatus[] = [];
    orchestrator.onStageChange((stage) => {
      stageChanges.push({ ...stage });
    });

    await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    // Completed events should have both startTime and endTime
    const completedEvents = stageChanges.filter(s => s.status === 'completed');
    for (const event of completedEvents) {
      expect(event.startTime).toBeInstanceOf(Date);
      expect(event.endTime).toBeInstanceOf(Date);
    }
  });
});

describe('Integration: Cross-Agent Memory Sharing', () => {
  it('agents store memories during pipeline execution that are retrievable', async () => {
    const { orchestrator } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    // Each agent should have its own MemoryManager with stored memories
    const memoryManagers = orchestrator.getMemoryManagers();
    expect(memoryManagers.size).toBe(6);

    for (const stageName of STAGE_NAMES) {
      const mm = memoryManagers.get(stageName);
      expect(mm).toBeDefined();

      // The agent stored a short-term memory during execution
      const memories = await mm!.retrieve(stageName);
      // Should find at least the memory stored by the agent + the episodic memory from orchestrator
      expect(memories.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('cross-agent memory retrieval works after pipeline execution', async () => {
    const { orchestrator } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    // RequirementAnalysis agent's memory should be accessible from another agent
    const results = await orchestrator.crossAgentMemoryRetrieve(
      'Design',
      'RequirementAnalysis',
      'processed',
    );
    expect(Array.isArray(results)).toBe(true);
    // The IntegrationMockAgent stores a memory containing "processed"
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('cross-agent memory retrieval fails for non-existent agent', async () => {
    const { orchestrator } = createFullOrchestrator();
    const htmlBuffer = createSampleHtmlBuffer();

    await orchestrator.executePipeline(htmlBuffer, 'requirements.html');

    await expect(
      orchestrator.crossAgentMemoryRetrieve('Design', 'NonExistentAgent', 'query'),
    ).rejects.toThrow('Target agent "NonExistentAgent" does not exist');
  });

  it('shared memory space is accessible', async () => {
    const { orchestrator } = createFullOrchestrator();

    const sharedMemory = orchestrator.getSharedMemory();
    expect(sharedMemory).toBeDefined();

    // Store something in shared memory
    await sharedMemory.store('shared knowledge item', 'short_term' as any, {
      sourceAgent: 'system',
    });

    const results = await sharedMemory.retrieve('shared knowledge');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Integration: Config Reload Affects LLM Adapter', () => {
  it('LLM adapter uses the configured default provider', async () => {
    const llmAdapter = new LLMAdapter();
    const providerA = new MockProviderAdapter('providerA');
    const providerB = new MockProviderAdapter('providerB');

    llmAdapter.registerProvider(providerA);
    llmAdapter.registerProvider(providerB);
    llmAdapter.setDefaultProvider('providerA');

    // Call chat - should use providerA
    const response = await llmAdapter.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toContain('providerA');
    expect(response.usage.provider).toBe('providerA');
    expect(providerA.callCount).toBe(1);
    expect(providerB.callCount).toBe(0);
  });

  it('switching default provider changes which adapter handles requests', async () => {
    const llmAdapter = new LLMAdapter();
    const providerA = new MockProviderAdapter('providerA');
    const providerB = new MockProviderAdapter('providerB');

    llmAdapter.registerProvider(providerA);
    llmAdapter.registerProvider(providerB);

    // Start with providerA
    llmAdapter.setDefaultProvider('providerA');
    await llmAdapter.chat([{ role: 'user', content: 'Hello' }]);
    expect(providerA.callCount).toBe(1);
    expect(providerB.callCount).toBe(0);

    // Switch to providerB (simulates config reload)
    llmAdapter.setDefaultProvider('providerB');
    const response = await llmAdapter.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toContain('providerB');
    expect(response.usage.provider).toBe('providerB');
    expect(providerA.callCount).toBe(1); // unchanged
    expect(providerB.callCount).toBe(1);
  });

  it('re-registering a provider updates the adapter instance', async () => {
    const llmAdapter = new LLMAdapter();
    const originalProvider = new MockProviderAdapter('openai');
    llmAdapter.registerProvider(originalProvider);
    llmAdapter.setDefaultProvider('openai');

    await llmAdapter.chat([{ role: 'user', content: 'test' }]);
    expect(originalProvider.callCount).toBe(1);

    // Re-register with a new instance (simulates config reload with new API key/model)
    const updatedProvider = new MockProviderAdapter('openai');
    llmAdapter.registerProvider(updatedProvider);

    await llmAdapter.chat([{ role: 'user', content: 'test' }]);
    // The new provider instance should handle the call
    expect(updatedProvider.callCount).toBe(1);
    // The old provider should not receive new calls
    expect(originalProvider.callCount).toBe(1);
  });

  it('setting a non-registered provider as default throws an error', () => {
    const llmAdapter = new LLMAdapter();
    const provider = new MockProviderAdapter('openai');
    llmAdapter.registerProvider(provider);

    expect(() => llmAdapter.setDefaultProvider('nonexistent')).toThrow(
      'Provider adapter "nonexistent" is not registered',
    );
  });
});
