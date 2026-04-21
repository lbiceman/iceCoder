/**
 * 编排器 - 多智能体流水线的主协调器。
 * 管理智能体注册、流水线执行、跨智能体记忆访问以及 SSE 集成的事件发射。
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
} from './types.js';
import { PipelineStateManager } from './pipeline-state.js';
import { ReportGenerator } from './report-generator.js';
import { FileParser } from '../parser/file-parser.js';
import { MemoryManager } from '../memory/memory-manager.js';
import type { MemoryManagerConfig } from '../memory/memory-manager.js';

/**
 * 编排器的配置。
 */
export interface OrchestratorConfig {
  outputDir: string;
  memoryConfig?: MemoryManagerConfig;
  /** 阶段失败时的最大重试次数 */
  stageMaxRetries?: number;
  /** 阶段重试基础延迟（毫秒） */
  stageRetryDelay?: number;
}

/**
 * 传递给 executePipeline 的配置。
 */
export interface PipelineConfig {
  [key: string]: any;
}

/**
 * Orchestrator 协调多智能体流水线的执行。
 * - 动态注册/注销智能体
 * - 为每个智能体创建独立的 MemoryManager 实例
 * - 维护所有智能体可访问的共享记忆空间
 * - 按固定顺序执行流水线阶段，将输出链接为输入
 * - 发射事件用于 SSE 集成（stage_change、pipeline_complete）
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
   * 注册一个智能体并为其创建独立的 MemoryManager。
   * @param agent - 要注册的智能体
   */
  registerAgent(agent: Agent): void {
    const name = agent.getName();
    this.agents.set(name, agent);
    this.memoryManagers.set(name, new MemoryManager(this.config.memoryConfig));
  }

  /**
   * 注销一个智能体并移除其 MemoryManager。
   * @param name - 要注销的智能体名称
   */
  unregisterAgent(name: string): void {
    this.agents.delete(name);
    this.memoryManagers.delete(name);
  }

  /**
   * 返回流水线的阶段定义。
   * 每个阶段映射到一个智能体，并定义如何从流水线状态派生其输入。
   */
  private getStageDefinitions(): StageDefinition[] {
    return [
      {
        name: 'RequirementAnalysis',
        agent: this.agents.get('RequirementAnalysis')!,
        inputMapper: (state: PipelineState) => {
          // 第一个阶段：接收解析后的文件内容
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
   * 启动 Pipeline 并立即返回 executionId，Pipeline 在后台异步执行。
   * 用于 HTTP 接口快速响应，前端通过 SSE 获取实时进度。
   */
  startPipeline(
    input: Buffer,
    filename: string,
    pipelineConfig?: PipelineConfig,
  ): string {
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

    // 后台异步执行 Pipeline
    this.runPipeline(input, filename, stateManager, pipelineConfig).catch((err) => {
      console.error(`Pipeline 执行失败 (${state.executionId}):`, err);
    });

    return state.executionId;
  }

  /**
   * 内部方法：实际执行 Pipeline 的全部阶段
   */
  private async runPipeline(
    input: Buffer,
    filename: string,
    stateManager: PipelineStateManager,
    pipelineConfig?: PipelineConfig,
  ): Promise<void> {
    const state = stateManager.getState();

    // 第一步：解析输入文件
    const parseResult = await this.fileParser.parse(input, filename);
    if (!parseResult.success) {
      stateManager.startStage('RequirementAnalysis');
      const error = `文件解析失败: ${parseResult.error}`;
      stateManager.failStage('RequirementAnalysis', error);
      stateManager.complete();
      this.emitStageChange(stateManager.getState().stages[0]);
      this.emitPipelineComplete(stateManager.getState());
      return;
    }

    // 存储解析内容作为伪阶段输出
    state.stageOutputs.set('__parsed__', {
      success: true,
      outputData: { content: parseResult.content, metadata: parseResult.metadata },
      artifacts: [],
      summary: '文件解析成功',
    });

    // 第二步：按顺序执行各阶段
    const stageDefinitions = this.getStageDefinitions();

    for (const stageDef of stageDefinitions) {
      if (!stageDef.agent) {
        const error = `阶段 "${stageDef.name}" 的 Agent 未注册`;
        stateManager.startStage(stageDef.name);
        stateManager.failStage(stageDef.name, error);
        stateManager.complete();
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);
        this.emitPipelineComplete(stateManager.getState());
        return;
      }

      stateManager.startStage(stageDef.name);
      this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);

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

      let result: AgentResult;
      const maxRetries = this.config.stageMaxRetries ?? 1;
      const retryDelay = this.config.stageRetryDelay ?? 3000;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await stageDef.agent.execute(context);

          // 如果成功或者是非可重试错误，跳出重试循环
          if (result.success || attempt >= maxRetries) break;

          // Agent 返回失败但未抛异常，尝试重试
          console.warn(
            `阶段 "${stageDef.name}" 执行失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${result.error}. 重试中...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (attempt >= maxRetries) {
            result = {
              success: false,
              outputData: {},
              artifacts: [],
              summary: `阶段 "${stageDef.name}" 在 ${maxRetries + 1} 次尝试后仍然失败`,
              error: errorMessage,
            };
            break;
          }

          console.warn(
            `阶段 "${stageDef.name}" 抛出异常 (尝试 ${attempt + 1}/${maxRetries + 1}): ${errorMessage}. 重试中...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
          result = undefined as any; // will be set in next iteration
        }
      }

      // 如果结果从未被设置的回退处理（不应发生）
      if (!result!) {
        result = {
          success: false,
          outputData: {},
          artifacts: [],
          summary: `阶段 "${stageDef.name}" 执行异常`,
          error: '未知错误',
        };
      }

      if (result.success) {
        stateManager.completeStage(stageDef.name, result);
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);

        if (agentMemory) {
          try {
            await agentMemory.store(
              result.summary,
              'episodic' as any,
              { executionId: state.executionId, stage: stageDef.name },
            );
          } catch {
            // 非关键操作，不影响 Pipeline
          }
        }

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
        const error = result.error ?? '未知错误';
        stateManager.failStage(stageDef.name, error);
        stateManager.complete();
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);
        this.emitPipelineComplete(stateManager.getState());
        return;
      }
    }

    // 第三步：生成 Pipeline 汇总报告
    stateManager.complete();
    const summaryContent = this.reportGenerator.generatePipelineSummary(stateManager.getState());
    const summaryFilename = `${state.executionId}_pipeline_summary.md`;
    await this.reportGenerator.saveReport(summaryContent, summaryFilename, this.config.outputDir);

    this.emitPipelineComplete(stateManager.getState());
  }

  /**
   * 执行完整流水线：解析输入文件，然后按顺序运行每个阶段。
   * 如果任何阶段失败则停止并记录失败。
   * 每个阶段完成后生成阶段报告，最后生成流水线摘要。
   * 发射阶段变更和流水线完成事件。
   *
   * @param input - 要处理的文件缓冲区
   * @param filename - 输入文件的名称
   * @param pipelineConfig - 可选的流水线配置
   * @returns 最终的流水线状态
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

    // 第一步：解析输入文件
    const parseResult = await this.fileParser.parse(input, filename);
    if (!parseResult.success) {
      // 如果解析失败则标记第一个阶段为失败
      stateManager.startStage('RequirementAnalysis');
      const error = `File parsing failed: ${parseResult.error}`;
      stateManager.failStage('RequirementAnalysis', error);
      stateManager.complete();
      this.emitStageChange(stateManager.getState().stages[0]);
      this.emitPipelineComplete(stateManager.getState());
      return stateManager.getState();
    }

    // 存储解析内容作为伪阶段输出，用于输入映射
    state.stageOutputs.set('__parsed__', {
      success: true,
      outputData: { content: parseResult.content, metadata: parseResult.metadata },
      artifacts: [],
      summary: 'File parsed successfully',
    });

    // 第二步：按顺序执行各阶段
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

      // 启动阶段
      stateManager.startStage(stageDef.name);
      this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);

      // 构建智能体上下文
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

      // 使用阶段级重试执行智能体
      let result: AgentResult;
      const maxRetries = this.config.stageMaxRetries ?? 1;
      const retryDelay = this.config.stageRetryDelay ?? 3000;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          result = await stageDef.agent.execute(context);
          if (result.success || attempt >= maxRetries) break;

          console.warn(
            `Stage "${stageDef.name}" failed (attempt ${attempt + 1}/${maxRetries + 1}): ${result.error}. Retrying...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (attempt >= maxRetries) {
            result = {
              success: false,
              outputData: {},
              artifacts: [],
              summary: `Stage "${stageDef.name}" failed after ${maxRetries + 1} attempts`,
              error: errorMessage,
            };
            break;
          }

          console.warn(
            `Stage "${stageDef.name}" threw exception (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage}. Retrying...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
          result = undefined as any;
        }
      }

      if (!result!) {
        result = {
          success: false,
          outputData: {},
          artifacts: [],
          summary: `Stage "${stageDef.name}" execution error`,
          error: 'Unknown error',
        };
      }

      if (result.success) {
        // 完成阶段
        stateManager.completeStage(stageDef.name, result);
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);

        // 将关键输出存储到智能体的情景记忆中
        if (agentMemory) {
          try {
            await agentMemory.store(
              result.summary,
              'episodic' as any,
              { executionId: state.executionId, stage: stageDef.name },
            );
          } catch {
            // 非关键操作：记忆存储失败不影响流水线
          }
        }

        // 生成并保存阶段报告
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
        // 标记阶段失败并停止流水线
        const error = result.error ?? 'Unknown error';
        stateManager.failStage(stageDef.name, error);
        stateManager.complete();
        this.emitStageChange(this.findStage(stateManager.getState(), stageDef.name)!);
        this.emitPipelineComplete(stateManager.getState());
        return stateManager.getState();
      }
    }

    // 第三步：生成流水线摘要
    stateManager.complete();
    const summaryContent = this.reportGenerator.generatePipelineSummary(stateManager.getState());
    const summaryFilename = `${state.executionId}_pipeline_summary.md`;
    await this.reportGenerator.saveReport(summaryContent, summaryFilename, this.config.outputDir);

    // 发射流水线完成事件
    this.emitPipelineComplete(stateManager.getState());

    return stateManager.getState();
  }

  /**
   * 返回给定执行 ID 的流水线状态。
   * @param executionId - 流水线执行 ID
   */
  getPipelineStatus(executionId: string): PipelineState | undefined {
    return this.pipelines.get(executionId);
  }

  /**
   * 注册阶段变更事件的回调。
   * @param callback - 阶段状态变更时调用的函数
   */
  onStageChange(callback: (stage: StageStatus) => void): void {
    this.eventEmitter.on('stage_change', callback);
  }

  /**
   * 注册流水线完成事件的回调。
   * @param callback - 流水线完成时调用的函数
   */
  onPipelineComplete(callback: (state: PipelineState) => void): void {
    this.eventEmitter.on('pipeline_complete', callback);
  }

  /**
   * 从目标智能体的 MemoryManager 中检索记忆。
   * 在检索前验证目标智能体是否存在。
   *
   * @param requestingAgent - 发起请求的智能体名称
   * @param targetAgent - 要访问其记忆的智能体名称
   * @param query - 搜索查询
   * @returns 匹配的记忆数组
   * @throws 如果目标智能体不存在则抛出错误
   */
  async crossAgentMemoryRetrieve(
    _requestingAgent: string,
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
   * 返回所有智能体可访问的共享记忆空间。
   */
  getSharedMemory(): MemoryManager {
    return this.sharedMemory;
  }

  /**
   * 返回 LLM 适配器，用于直接聊天。
   */
  getLLMAdapter(): LLMAdapter {
    return this.llmAdapter;
  }

  /**
   * 返回文件解析器，用于直接解析上传的文件。
   */
  getFileParser(): FileParser {
    return this.fileParser;
  }

  /**
   * 返回已注册的智能体映射。
   */
  getAgents(): Map<string, Agent> {
    return this.agents;
  }

  /**
   * 返回记忆管理器映射。
   */
  getMemoryManagers(): Map<string, MemoryManager> {
    return this.memoryManagers;
  }

  // --- 私有辅助方法 ---

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
