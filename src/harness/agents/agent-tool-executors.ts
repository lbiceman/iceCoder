/**
 * 子 Agent 相关的 ToolExecutor 包装。
 *
 * - AgentAwareToolExecutor：主 Harness 本轮使用，拦截 `task` 调用交给 AgentSpawner；
 *   其它工具原样转发。`task` 标记为并发安全，同一回复里的多个 task 由 StreamingToolExecutor 并行执行。
 * - AgentRecordingToolExecutor：子 Harness 使用，转发到主会话同一个 ToolExecutor，
 *   并在执行前后回调记录写入与命令（结果汇总只采信这些记录）。
 */

import type { ToolCall } from '../../llm/types.js';
import { ToolExecutor } from '../../tools/tool-executor.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import type { ToolOutputCallback, ToolResult } from '../../tools/types.js';
import { TASK_TOOL_NAME } from './task-tool.js';

export type TaskToolHandler = (toolCall: ToolCall) => Promise<ToolResult>;

export class AgentAwareToolExecutor extends ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly onTask: TaskToolHandler,
  ) {
    super(new ToolRegistry());
  }

  override async executeTool(toolCall: ToolCall, onOutput?: ToolOutputCallback): Promise<ToolResult> {
    if (toolCall.name === TASK_TOOL_NAME) {
      try {
        return await this.onTask(toolCall);
      } catch (err) {
        return {
          success: false,
          output: '',
          error: `task failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return this.inner.executeTool(toolCall, onOutput);
  }
}

export interface AgentToolRecorder {
  beforeTool(toolCall: ToolCall): Promise<void>;
  afterTool(toolCall: ToolCall, result: ToolResult): void;
}

export class AgentRecordingToolExecutor extends ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly recorder: AgentToolRecorder,
  ) {
    super(new ToolRegistry());
  }

  override async executeTool(toolCall: ToolCall, onOutput?: ToolOutputCallback): Promise<ToolResult> {
    await this.recorder.beforeTool(toolCall);
    const result = await this.inner.executeTool(toolCall, onOutput);
    this.recorder.afterTool(toolCall, result);
    return result;
  }
}
