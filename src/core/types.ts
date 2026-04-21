/**
 * 多智能体编排器的核心类型定义。
 * 定义 Agent 接口、执行上下文、结果以及流水线状态类型。
 */

/**
 * 在执行上下文中传递的智能体配置。
 */
export interface AgentConfig {
  [key: string]: any;
}

/**
 * MemoryManager 的前向引用接口，用于避免循环依赖。
 * 完整实现位于 src/memory/memory-manager.ts。
 */
export interface MemoryManager {
  store(content: string, type: string, metadata?: Record<string, any>): Promise<any>;
  retrieve(query: string, type?: string, limit?: number): Promise<any[]>;
}

/**
 * LLMAdapter 的前向引用接口，用于避免循环依赖。
 * 完整实现位于 src/llm/llm-adapter.ts。
 */
export interface LLMAdapter {
  chat(messages: any[], options?: any): Promise<any>;
}

/**
 * 智能体执行上下文，包含执行期间所需的所有资源。
 */
export interface AgentContext {
  executionId: string;
  inputData: Record<string, any>;
  config: AgentConfig;
  memoryManager: MemoryManager;
  llmAdapter: LLMAdapter;
  outputDir: string;
}

/**
 * 智能体执行后返回的结果。
 */
export interface AgentResult {
  success: boolean;
  outputData: Record<string, any>;
  artifacts: string[];
  summary: string;
  error?: string;
}

/**
 * Agent 接口 - 所有智能体必须实现此接口。
 */
export interface Agent {
  getName(): string;
  execute(context: AgentContext): Promise<AgentResult>;
}

/**
 * 流水线阶段定义，将智能体映射到其输入转换函数。
 */
export interface StageDefinition {
  name: string;
  agent: Agent;
  inputMapper: (pipelineState: PipelineState) => Record<string, any>;
}

/**
 * 流水线整体执行状态。
 */
export interface PipelineState {
  executionId: string;
  stages: StageStatus[];
  currentStageIndex: number;
  stageOutputs: Map<string, AgentResult>;
  startTime: Date;
  endTime?: Date;
}

/**
 * 单个流水线阶段的状态。
 */
export interface StageStatus {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  error?: string;
}
