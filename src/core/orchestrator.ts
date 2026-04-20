/**
 * Orchestrator - Main coordinating agent for the multi-agent pipeline.
 * Manages agent registration, pipeline execution, cross-agent memory access,
 * and event emission for SSE integration.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 10.4, 18.1, 18.5, 18.6
 */

import { EventEmitter } from 'node:events';
import type {
  Agent,
  AgentContext,
  AgentResult,
  PipelineState,
  StageDefinition,
  StageStatus,
  LLMAdapter,
  MemoryManager as MemoryManagerInterface,
} from './types.js';
import { PipelineStateManager } from './pipeline-state.js';
import { ReportGenerator } from './report-generator.js';
import { FileParser } from '../parser/file-parser.js';
import { MemoryManager } from '../memory/memory-manager.js';
import type { MemoryManagerConfig } from '../memory/memory-manager.js';

/**
 * Configuration for the Orchestrator.
 */
export interface OrchestratorConfig {
  outputDir: string;
  memoryConfig?: MemoryManagerConfig;
}

/**
 * Configuration passed to executePipeline.
 */
export interface PipelineConfig {
  [key: string]: any;
}

/**
 * Orchestrator coordinates the multi-agent pipeline execution.
 * - Registers/unregisters agents dynamically
 * - Creates independent MemoryManager instances per agent
 * - Maintains a shared memory space accessible by all agents
 * - Executes pipeline stages in fixed order, chaining outputs as inputs
 * - Emits events for SSE integration (stage_change, pipeline_complete)
 */
export class Orchestrator {
  private agents: Map<string, Agent> = new Map();
  private memoryManagers: Map<string, MemoryManager> = new Map();
  private sharedMemory: MemoryManager;
  private fileParser: FileParser;
  private llmAdapter: LLMAdapter;
  private reportGenerator: ReportGenerator;
  private eventEmitter: EventEmitter;
  private config: OrchestratorConfig;
  private pipelines: Map<string, PipelineState> = new Map();

  constructor(
    fileParser: FileParser,
    llmAdapter: LLMAdapter,
    config: OrchestratorConfig,
  ) {
    this.fileParser = fileParser;
    this.llmAdapter = llmAdapter;
    this.config = config;
    this.reportGenerator = new ReportGenerator();
    this.eventEmitter = new EventEmitter();
    this.sharedMemory = new MemoryManager(config.memoryConfig);
  }

  /**
   * Registers an agent and creates an independent MemoryManager for it.
   * @param agent - The agent to register
   */
  registerAgent(agent: Agent): void {
    const name = agent.getName();
    this.agents.set(name, agent);
    this.memoryManagers.set(name, new MemoryManager(this.config.memoryConfig));
  }

  /**
   * Unregisters an agent and removes its MemoryManager.
   * @param name - The name of the agent to unregister
   */
  unregisterAgent(name: string): void {
    this.agents.delete(name);
    this.memoryManagers.delete(name);
  }

  /**
   * Returns the stage definitions for the pipeline.
   * Each stage maps to an agent and defines how to derive its input from the pipeline state.
   */
  private getStageDefinitions(): StageDefinition[] {
    return [
      {
        name: 'RequirementAnalysis',
        agent: this.agents.get('RequirementAnalysis')!,
        inputMapper: (state: PipelineState) => {
          // First stage: receives parsed file content
          return state.stageOutputs.get('__parsed__')?.outputData ?? {};
        },
      },
      {
        name: 'Design',
        agent: this.agents.get('Design')!,
        inputMapper: (state: PipelineState) => {
          const reqResult = state.stageOutputs.get('RequirementAnalysis');
          return reqResult?.outputData ?? {};
        },
      },
      {
        name: 'TaskGeneration',
        agent: this.agents.get('TaskGeneration')!,
        inputMapper: (state: PipelineState) => {
          const designResult = state.stageOutputs.get('Design');
          return designResult?.outputData ?? {};
        },
      },
      {
        name: 'CodeWriting',
        agent: this.agents.get('CodeWriting')!,
        inputMapper: (state: PipelineState) => {
          const taskResult = state.stageOutputs.get('TaskGeneration');
          return taskResult?.outputData ?? {};
        },
      },
      {
        name: 'Testing',
        agent: this.agents.get('Testing')!,
        inputMapper: (state: PipelineState) => {
          const reqResult = state.stageOutputs.get('RequirementAnalysis');
          const designResult = state.stageOutputs.get('Design');
          const taskResult = state.stageOutputs.get('TaskGeneration');
          return {
            requirements: reqResult?.outputData ?? {},
            design: designResult?.outputData ?? {},
            tasks: taskResult?.outputData ?? {},
          };
        },
      },
      {
        name: 'RequirementVerification',
        agent: this.agents.get('RequirementVerification')!,
        inputMapper: (state: PipelineState) => {
          const reqResult = state.stageOutputs.get('RequirementAnalysis');
          const testResult = state.stageOutputs.get('Testing');
          return {
            requirements: reqResult?.outputData ?? {},
            testResults: testResult?.outputData ?? {},
          };
        },
      },
    ];
  }

  /**
   * Executes the full pipeline: parses the input file, then runs each stage in order.
   * Stops and records failure if any stage fails.
   * Generates stage reports after each stage and a pipeline summary at the end.
   * Emits events for stage changes and pipeline completion.
   *
   * @param input - The file buffer to process
   * @param filename - The name of the input file
   * @param pipelineConfig - Optional pipeline configuration
   * @returns The final pipeline state
   */
  async executePipeline(
    input: Buffer,
    filename: string,
    pipelineConfig?: PipelineConfig,
  ): Promise<PipelineState> {
    const stageNames = [
      'RequirementAnalysis',
      'Design',
      'TaskGeneration',
      'CodeWriting',
      'Testing',
      'RequirementVerification',
    ];

    const stateManager = new PipelineStateManager(stageNames);
    const state = stateManager.getState();
    this.pipelines.set(state.executionId, state);

    // Step 1: Parse the input file
    const parseResult = await this.fileParser.parse(input, filename);
    if (!parseResult.success) {
      // Fail the first stage if parsing fails
      stateManager.startStage('RequirementAnalysis');
      const error = `File parsing failed: ${parseResult.error}`;
      stateManager.failStage('RequirementAnalysis', error);
      stateManager.complete();
      this.emitStageChange(stateManager.getState().stages[0]);
      this.emitPipelineComplete(stateManager.getState());
      return stateManager.getState();
    }

    // Store parsed content as a pseudo-stage output for input mapping
    state.stageOutputs.set('__parsed__', {
      success: true,
      outputData: { content: parseResult.content, metadata: parseResult.metadata },
      artifacts: [],
      summary: 'File parsed successfully',
    });

    // Step 2: Execute stages in order
    const stageDefinitions = this.getStageDefinitions();

    for (const stageDef of stageDefinitions) {
      if (!stageDef.agent) {
        const error = `Agent for stage "${stageDef.name}" is not registered`;
        stateManager.startStage(stageDef.name);
        stateManager.failStage(stageDef.name, error);
        stateManager.complete();
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);
        this.emitPipelineComplete(stateManager.getState());
        return stateManager.getState();
      }

      // Start stage
      stateManager.startStage(stageDef.name);
      this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);

      // Build agent context
      const agentMemory = this.memoryManagers.get(stageDef.agent.getName());
      const inputData = stageDef.inputMapper(stateManager.getState());

      const context: AgentContext = {
        executionId: state.executionId,
        inputData,
        config: pipelineConfig ?? {},
        memoryManager: agentMemory ?? this.sharedMemory,
        llmAdapter: this.llmAdapter,
        outputDir: this.config.outputDir,
      };

      // Execute agent
      let result: AgentResult;
      try {
        result = await stageDef.agent.execute(context);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = {
          success: false,
          outputData: {},
          artifacts: [],
          summary: `Stage "${stageDef.name}" threw an unhandled exception`,
          error: errorMessage,
        };
      }

      if (result.success) {
        // Complete stage
        stateManager.completeStage(stageDef.name, result);
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);

        // Store key output to agent's episodic memory
        if (agentMemory) {
          try {
            await agentMemory.store(
              result.summary,
              'episodic' as any,
              { executionId: state.executionId, stage: stageDef.name },
            );
          } catch {
            // Non-critical: don't fail pipeline if memory store fails
          }
        }

        // Generate and save stage report
        const stageStatus = this.findStage(stateManager.getState(), stageDef.name)!;
        const reportContent = this.reportGenerator.generateStageReport(
          stageStatus,
          result,
          state.executionId,
        );
        const reportFilename = this.reportGenerator.getReportFilename(
          state.executionId,
          stageDef.name,
        );
        await this.reportGenerator.saveReport(reportContent, reportFilename, this.config.outputDir);
      } else {
        // Fail stage and stop pipeline
        const error = result.error ?? 'Unknown error';
        stateManager.failStage(stageDef.name, error);
        stateManager.complete();
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);
        this.emitPipelineComplete(stateManager.getState());
        return stateManager.getState();
      }
    }

    // Step 3: Generate pipeline summary
    stateManager.complete();
    const summaryContent = this.reportGenerator.generatePipelineSummary(stateManager.getState());
    const summaryFilename = `${state.executionId}_pipeline_summary.md`;
    await this.reportGenerator.saveReport(summaryContent, summaryFilename, this.config.outputDir);

    // Emit pipeline complete event
    this.emitPipelineComplete(stateManager.getState());

    return stateManager.getState();
  }

  /**
   * Returns the pipeline state for a given execution ID.
   * @param executionId - The pipeline execution ID
   */
  getPipelineStatus(executionId: string): PipelineState | undefined {
    return this.pipelines.get(executionId);
  }

  /**
   * Registers a callback for stage change events.
   * @param callback - Function called when a stage status changes
   */
  onStageChange(callback: (stage: StageStatus) => void): void {
    this.eventEmitter.on('stage_change', callback);
  }

  /**
   * Registers a callback for pipeline completion events.
   * @param callback - Function called when the pipeline completes
   */
  onPipelineComplete(callback: (state: PipelineState) => void): void {
    this.eventEmitter.on('pipeline_complete', callback);
  }

  /**
   * Retrieves memories from a target agent's MemoryManager.
   * Validates that the target agent exists before retrieving.
   *
   * @param requestingAgent - Name of the agent making the request
   * @param targetAgent - Name of the agent whose memory to access
   * @param query - The search query
   * @returns Array of matching memories
   * @throws Error if target agent does not exist
   */
  async crossAgentMemoryRetrieve(
    requestingAgent: string,
    targetAgent: string,
    query: string,
  ): Promise<any[]> {
    const targetMemory = this.memoryManagers.get(targetAgent);
    if (!targetMemory) {
      throw new Error(`Target agent "${targetAgent}" does not exist`);
    }
    return targetMemory.retrieve(query);
  }

  /**
   * Returns the shared memory space accessible by all agents.
   */
  getSharedMemory(): MemoryManager {
    return this.sharedMemory;
  }

  /**
   * 返回最近创建的 Pipeline 的执行 ID
   */
  getLatestPipelineId(): string | undefined {
    const entries = Array.from(this.pipelines.keys());
    return entries.length > 0 ? entries[entries.length - 1] : undefined;
  }

  /**
   * Returns the LLM adapter for direct chat use.
   */
  getLLMAdapter(): LLMAdapter {
    return this.llmAdapter;
  }

  /**
   * Returns the registered agents map.
   */
  getAgents(): Map<string, Agent> {
    return this.agents;
  }

  /**
   * Returns the memory managers map.
   */
  getMemoryManagers(): Map<string, MemoryManager> {
    return this.memoryManagers;
  }

  // --- Private helpers ---

  private emitStageChange(stage: StageStatus): void {
    this.eventEmitter.emit('stage_change', stage);
  }

  private emitPipelineComplete(state: PipelineState): void {
    this.eventEmitter.emit('pipeline_complete', state);
  }

  private findStage(state: PipelineState, name: string): StageStatus | undefined {
    return state.stages.find((s) => s.name === name);
  }
}
