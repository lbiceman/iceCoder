import type { UnifiedMessage, ToolCall, ToolDefinition } from '../llm/types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import { getToolMetadata } from '../tools/tool-metadata.js';
import { getMaxToolOutputChars } from '../tools/tool-output-limits.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import { toolExecutionUserHint } from './harness-llm-log.js';
import {
  formatConfirmToolName,
  resolveToolPermission,
  toolCallSignature,
} from './harness-permission-runtime.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { RepoContext } from './repo-context.js';
import {
  formatSubAgentResult,
  SubAgentRunner,
} from './sub-agent-runner.js';
import { StreamingToolExecutor } from './streaming-tool-executor.js';
import type { TaskState } from './task-state.js';
import type { ChatFunction, HarnessStepEvent, ToolPermissionRule } from './types.js';
import type { RuntimeTelemetry } from './runtime-telemetry.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import {
  extractRunCommand,
  extractToolTargetPath,
} from './branch-budget-tool-path.js';
import { checkWorkspacePathViolation } from './workspace-path-guard.js';

export interface ToolExecutorDeps {
  toolExecutor: ToolExecutor;
  loopController: LoopController;
  permissionRules: ToolPermissionRule[];
  onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  workspaceRoot: string;
  lockedWorkspaceRoot?: string;
  referenceReads?: string[];
  runtimeTelemetry?: RuntimeTelemetry;
  /** Resilience v2：超限时硬拦截 write / 失败命令重试。 */
  branchBudget?: BranchBudgetTracker;
}

function formatToolFailureOutput(error: string | undefined, rawOutput: string): string {
  const message = error ?? 'Unknown error';
  const body = rawOutput.trim();
  if (body) return `工具执行错误: ${message}\n\n${body}`;
  return `工具执行错误: ${message}`;
}

export interface ExecuteToolCallsStreamingArgs {
  toolCalls: ToolCall[];
  messages: UnifiedMessage[];
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  harnessAbortSignal?: AbortSignal;
  taskState?: TaskState;
  repoContext?: RepoContext;
  chatFn?: ChatFunction;
  currentTools?: ToolDefinition[];
}

/**
 * 使用 StreamingToolExecutor 执行工具调用。
 *
 * 并行安全的工具（isConcurrencySafe）并行执行，
 * 非并行安全的工具串行执行。
 * 每个工具执行前检查权限和用户中断。
 * 中断时为未完成的 tool_use 补齐错误 tool_result。
 *
 * @returns 工具执行统计（用于连续失败熔断判断）
 */
export async function executeToolCallsStreaming(
  deps: ToolExecutorDeps,
  args: ExecuteToolCallsStreamingArgs,
): Promise<{ failedCount: number; totalCount: number; failedSignatures: string[] }> {
  const {
    toolCalls,
    messages,
    logger,
    onStep,
    harnessAbortSignal,
    taskState,
    repoContext,
    chatFn,
    currentTools,
  } = args;

  const streamingExecutor = new StreamingToolExecutor(
    deps.toolExecutor,
    onStep ? (toolCallId, toolName, chunk) => {
      onStep({
        type: 'tool_output',
        toolName,
        content: chunk,
      });
    } : undefined,
    harnessAbortSignal,
  );
  const iteration = deps.loopController.getState().currentRound;
  let directFailedCount = 0;
  let directTotalCount = 0;
  const directFailedSignatures: string[] = [];

  // 第一遍：权限检查 + 提交到流式执行器
  const submittedIds = new Set<string>();
  for (const tc of toolCalls) {
    // 检查用户中断
    if (deps.loopController.isAborted()) {
      yieldMissingToolResults(toolCalls, submittedIds, messages);
      break;
    }

    if (tc.name === 'delegate_to_subagent') {
      logger.toolCall(tc.name, tc.arguments);
      onStep?.({ type: 'tool_call', iteration, toolName: tc.name, toolArgs: tc.arguments });
      onStep?.({
        type: 'tool_progress',
        iteration,
        phase: 'running',
        toolName: tc.name,
        content: '正在委派只读子代理探索代码库…',
      });

      let output: string;
      let success = true;
      let error: string | undefined;
      try {
        if (!chatFn || !currentTools) {
          throw new Error('delegate_to_subagent requires Harness chat function and tool definitions');
        }
        const runner = new SubAgentRunner({
          toolExecutor: deps.toolExecutor,
          toolDefinitions: currentTools,
          chatFn,
          workspaceRoot: deps.workspaceRoot,
        });
        const result = await runner.run({
          task: String(tc.arguments.task ?? ''),
          context: typeof tc.arguments.context === 'string' ? tc.arguments.context : undefined,
        });
        output = formatSubAgentResult(result);
        success = result.status !== 'error';
        error = result.error;
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
        output = `工具执行错误: ${error}`;
      }

      directTotalCount++;
      if (!success) {
        directFailedCount++;
        directFailedSignatures.push(toolCallSignature(tc));
      }
      logger.toolResult(tc.name, success, output.length, error);
      deps.runtimeTelemetry?.recordTool({
        round: iteration,
        toolName: tc.name,
        success,
        outputLength: output.length,
      });
      onStep?.({
        type: 'tool_result',
        iteration,
        toolName: tc.name,
        toolSuccess: success,
        toolOutput: output.substring(0, 500),
        toolError: success ? undefined : error,
      });
      messages.push({
        role: 'tool',
        content: output,
        toolCallId: tc.id,
      });
      taskState?.recordToolResult(tc, { success, output, error });
      repoContext?.recordToolResult(tc, { success, output, error });
      if (taskState && repoContext) {
        // currentPlanTracker.onToolResult removed (Phase 11)
      }
      deps.loopController.recordToolCalls(1);
      submittedIds.add(tc.id);
      continue;
    }

    // ── 权限检查：显式规则优先，破坏性工具兜底确认 ──
    const permission = resolveToolPermission(tc, deps.permissionRules);
    if (permission.permission === 'deny') {
      logger.toolResult(tc.name, false, 0, permission.reason ?? 'Tool denied by policy');
      onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
      messages.push({
        role: 'tool',
        content: `Tool ${tc.name} denied by policy${permission.reason ? `: ${permission.reason}` : ''}. Please use a different approach or ask the user.`,
        toolCallId: tc.id,
      });
      submittedIds.add(tc.id);
      continue;
    }

    if (permission.permission === 'confirm' && !deps.onConfirm) {
      const reason = permission.reason ?? 'Confirmation required but no confirmation handler is configured';
      logger.toolResult(tc.name, false, 0, reason);
      onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
      messages.push({
        role: 'tool',
        content: `Tool ${tc.name} requires confirmation but no confirmation handler is configured${permission.reason ? `: ${permission.reason}` : ''}. Please use a different approach or ask the user.`,
        toolCallId: tc.id,
      });
      submittedIds.add(tc.id);
      continue;
    }

    if (permission.permission === 'confirm' && deps.onConfirm) {
      const confirmToolName = formatConfirmToolName(tc);
      onStep?.({ type: 'tool_confirm', iteration, toolName: confirmToolName, toolArgs: tc.arguments });
      const allowed = await deps.onConfirm(confirmToolName, tc.arguments);
      if (!allowed) {
        logger.toolResult(tc.name, false, 0, 'User denied execution');
        onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
        messages.push({
          role: 'tool',
          content: `User denied tool ${tc.name}. Please try a different approach to complete the task, or ask the user.`,
          toolCallId: tc.id,
        });
        submittedIds.add(tc.id);
        continue;
      }
    }

    const workspaceBlock = checkWorkspacePathViolation(
      tc.name,
      tc.arguments,
      deps.lockedWorkspaceRoot ?? '',
      deps.referenceReads ?? [],
    );
    if (workspaceBlock) {
      logger.toolResult(tc.name, false, workspaceBlock.length, 'Workspace lock block');
      onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
      messages.push({
        role: 'tool',
        content: workspaceBlock,
        toolCallId: tc.id,
      });
      directTotalCount++;
      directFailedCount++;
      directFailedSignatures.push(toolCallSignature(tc));
      deps.runtimeTelemetry?.recordTool({
        round: iteration,
        toolName: tc.name,
        success: false,
        outputLength: workspaceBlock.length,
      });
      onStep?.({
        type: 'tool_result',
        iteration,
        toolName: tc.name,
        toolSuccess: false,
        toolOutput: workspaceBlock.substring(0, 500),
        toolError: 'Workspace lock block',
      });
      taskState?.recordToolResult(tc, { success: false, output: workspaceBlock, error: 'Workspace lock block' });
      repoContext?.recordToolResult(tc, { success: false, output: workspaceBlock, error: 'Workspace lock block' });
      deps.loopController.recordToolCalls(1);
      submittedIds.add(tc.id);
      continue;
    }

    // BranchBudget 拦截：工具未真正执行。telemetry/toolStats 的 success:false 是策略拒绝，
    // 不是 edit_file/write_file 引擎故障；长任务里多在 npm test 反复失败后、forced 段出现。
    const branchBlock = deps.branchBudget?.checkToolBlock(
      tc.name,
      tc.arguments,
      extractToolTargetPath,
      extractRunCommand,
    );
    if (branchBlock?.blocked) {
      const blockMessage = branchBlock.message ?? '[BranchBudget / Blocked] Tool execution denied.';
      logger.toolResult(tc.name, false, blockMessage.length, 'Branch budget block');
      onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
      messages.push({
        role: 'tool',
        content: blockMessage,
        toolCallId: tc.id,
      });
      directTotalCount++;
      directFailedCount++;
      directFailedSignatures.push(toolCallSignature(tc));
      deps.runtimeTelemetry?.recordTool({
        round: iteration,
        toolName: tc.name,
        success: false,
        outputLength: blockMessage.length,
      });
      onStep?.({
        type: 'tool_result',
        iteration,
        toolName: tc.name,
        toolSuccess: false,
        toolOutput: blockMessage.substring(0, 500),
        toolError: 'Branch budget block',
      });
      taskState?.recordToolResult(tc, { success: false, output: blockMessage, error: 'Branch budget block' });
      repoContext?.recordToolResult(tc, { success: false, output: blockMessage, error: 'Branch budget block' });
      deps.loopController.recordToolCalls(1);
      submittedIds.add(tc.id);
      continue;
    }

    // ── 提交到流式执行器 ──
    logger.toolCall(tc.name, tc.arguments);
    onStep?.({ type: 'tool_call', iteration, toolName: tc.name, toolArgs: tc.arguments });
    onStep?.({
      type: 'tool_progress',
      iteration,
      phase: 'running',
      toolName: tc.name,
      content: toolExecutionUserHint(tc.name),
    });
    streamingExecutor.submit(tc);
    submittedIds.add(tc.id);
  }

  // 第二遍：等待所有已提交的工具完成，收集结果
  const results = await streamingExecutor.flush();
  const processedIds = new Set<string>();
  let failedCount = directFailedCount;
  const failedSignatures: string[] = [...directFailedSignatures];

  for (const sr of results) {
    // 中断后跳过剩余结果处理
    if (deps.loopController.isAborted()) break;

    const { toolCall: tc, result } = sr;
    const output = result.success
      ? result.output
      : formatToolFailureOutput(result.error, result.output);

    if (!result.success) {
      failedCount++;
      failedSignatures.push(toolCallSignature(tc));
    }

    logger.toolResult(tc.name, result.success, output.length, result.error);
    deps.runtimeTelemetry?.recordTool({
      round: iteration,
      toolName: tc.name,
      success: result.success,
      outputLength: output.length,
    });
    onStep?.({
      type: 'tool_result',
      iteration,
      toolName: tc.name,
      toolSuccess: result.success,
      toolOutput: output.substring(0, 500),
      toolError: result.success ? undefined : result.error,
    });

    const toolMeta = getToolMetadata(tc.name);
    const maxCap = getMaxToolOutputChars();
    const maxOutput = toolMeta.maxResultSizeChars === Infinity ? maxCap : Math.min(toolMeta.maxResultSizeChars, maxCap);
    const truncatedOutput = output.length > maxOutput
      ? output.substring(0, maxOutput) + `\n\n[输出已截断，原始长度: ${output.length} 字符]`
      : output;

    messages.push({
      role: 'tool',
      content: truncatedOutput,
      toolCallId: tc.id,
    });

    taskState?.recordToolResult(tc, result);
    repoContext?.recordToolResult(tc, result);
    if (taskState && repoContext) {
      // currentPlanTracker.onToolResult removed (Phase 11)
    }

    processedIds.add(tc.id);
    deps.loopController.recordToolCalls(1);
  }

  // 如果中断发生，为未处理的工具补齐 tool_result
  if (deps.loopController.isAborted()) {
    yieldMissingToolResults(toolCalls, processedIds, messages);
  }

  return { failedCount, totalCount: results.length + directTotalCount, failedSignatures };
}

/**
 * 为未完成的 tool_use 补齐错误 tool_result。
 *
 * 中断或错误时，API 要求每个 tool_use 都有对应的 tool_result，
 * 否则下一轮调用会报错。
 */
export function yieldMissingToolResults(
  toolCalls: ToolCall[],
  completedIds: Set<string>,
  messages: UnifiedMessage[],
): void {
  for (const tc of toolCalls) {
    if (completedIds.has(tc.id)) continue;
    // 检查消息中是否已有此 tool_result（权限拒绝等情况）
    const hasResult = messages.some(m => m.role === 'tool' && m.toolCallId === tc.id);
    if (hasResult) continue;

    messages.push({
      role: 'tool',
      content: 'Tool execution was interrupted.',
      toolCallId: tc.id,
    });
  }
}
