/**
 * iceCoder 的核心类型定义。
 * 定义 Agent 接口、执行上下文、结果以及流水线状态类型。
 */

/**
 * 在执行上下文中传递的智能体配置。
 */
export interface AgentConfig {
  [key: string]: any;
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
  llmAdapter: LLMAdapter;
  outputDir: string;
  /** 工具执行器（可选，启用后 Agent 可通过 Harness 使用工具） */
  toolExecutor?: any;
  /** 可用工具定义列表（可选，与 toolExecutor 配合使用） */
  toolDefinitions?: any[];
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
