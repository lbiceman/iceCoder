import type { UnifiedMessage, ToolCall } from '../../llm/types.js';
import type { GateContext, ToolGate, ToolGateEntry, ToolGatePlan } from '../../types/supervisor.js';
import { toolCallSignature } from '../harness-permission-runtime.js';

export interface ExecuteToolCallsThroughGateArgs {
  toolCalls: ToolCall[];
  messages: UnifiedMessage[];
  ctx: GateContext;
  toolGate?: ToolGate;
}

export interface ToolGateExecutionResult {
  executableToolCalls: ToolCall[];
  skippedSignatures: Set<string>;
}

export class DefaultToolGate implements ToolGate {
  decide(calls: ToolCall[], ctx: GateContext): ToolGatePlan {
    if (ctx.executionMode !== 'forced') {
      return { entries: calls.map(tc => ({ toolCallId: tc.id, action: 'execute' })) };
    }

    return {
      entries: calls.map(tc => {
        const hint = ctx.graphHints.find(entry => entry.toolName === tc.name);
        if (hint?.action === 'block') {
          return {
            toolCallId: tc.id,
            action: 'skip',
            message: hint.message ?? `Tool ${tc.name} was blocked by the current forced step gate.`,
          };
        }
        return { toolCallId: tc.id, action: 'execute' };
      }),
    };
  }
}

export function executeToolCallsThroughGate(args: ExecuteToolCallsThroughGateArgs): ToolGateExecutionResult {
  const gate = args.toolGate ?? new DefaultToolGate();
  const plan = gate.decide(args.toolCalls, args.ctx);
  const entriesById = new Map(plan.entries.map(entry => [entry.toolCallId, entry]));
  const executableToolCalls: ToolCall[] = [];
  const skippedSignatures = new Set<string>();

  for (const tc of args.toolCalls) {
    const entry = entriesById.get(tc.id) ?? defaultExecuteEntry(tc.id);
    if (entry.action === 'execute') {
      executableToolCalls.push(tc);
      continue;
    }

    skippedSignatures.add(toolCallSignature(tc));
    args.messages.push({
      role: 'tool',
      toolCallId: tc.id,
      content: formatSkippedToolResult(tc, entry),
    });
  }

  return { executableToolCalls, skippedSignatures };
}

function defaultExecuteEntry(toolCallId: string): ToolGateEntry {
  return { toolCallId, action: 'execute' };
}

function formatSkippedToolResult(tc: ToolCall, entry: ToolGateEntry): string {
  const reason = entry.message ?? `Tool ${tc.name} was skipped by ToolGate.`;
  return `[ToolGate] ${reason} The tool was not executed.`;
}
