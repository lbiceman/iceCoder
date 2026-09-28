/**
 * chat-ws 子 Agent：事件分流推送、派发器构造、停止。
 *
 * 子 Agent 的事件不走主 Agent 的 stream / response 通道：
 * - agent_update：卡片状态
 * - agent_stream：子 Agent 的正文 / 思考流（子会话抽屉用）
 * - step（带 agentId）：工具调用 / 结果 / 确认等，前端按 agentId 分流
 * - tool_output（带 agentId）：命令实时输出
 */

import type { HarnessStepEvent } from '../harness/types.js';
import type { LLMAdapterInterface as LLMAdapter } from '../llm/types.js';
import type { ReasoningEffort } from '../llm/reasoning-effort.js';
import { AgentSpawner, type AgentHarnessFactory } from '../harness/agents/agent-spawner.js';
import { broadcastToSession } from './chat-ws-broadcast.js';
import {
  createAgentShellMandatoryConfirmHandler,
  createAgentToolConfirmHandler,
} from './chat-ws-confirm.js';
import { SESSIONS_DIR, getSessionAgentSpawner } from './chat-ws-runtime.js';

export function broadcastAgentStep(sessionId: string, event: HarnessStepEvent): void {
  const agentId = event.agentId;
  if (!agentId) return;
  switch (event.type) {
    case 'agent_update':
      if (event.agent) broadcastToSession(sessionId, { type: 'agent_update', sessionId, agent: event.agent });
      return;
    case 'stream_delta':
    case 'reasoning_stream_delta':
      if (event.delta) {
        broadcastToSession(sessionId, {
          type: 'agent_stream',
          agentId,
          kind: event.type === 'stream_delta' ? 'text' : 'reasoning',
          delta: event.delta,
        });
      }
      return;
    case 'stream_retry_discard':
      broadcastToSession(sessionId, { type: 'agent_stream', agentId, kind: 'discard', delta: '' });
      return;
    case 'tool_output':
      if (event.content) {
        broadcastToSession(sessionId, {
          type: 'tool_output',
          agentId,
          toolCallId: event.toolCallId || '',
          toolName: event.toolName,
          content: event.content,
        });
      }
      return;
    default:
      broadcastToSession(sessionId, { type: 'step', step: event });
  }
}

export interface CreateWebAgentSpawnerInput {
  sessionId: string;
  messageId: string;
  llmAdapter: LLMAdapter;
  reasoningEffort?: ReasoningEffort;
  harnessFactory: AgentHarnessFactory;
}

export function createWebAgentSpawner(input: CreateWebAgentSpawnerInput): AgentSpawner {
  const { sessionId, llmAdapter, reasoningEffort } = input;
  return new AgentSpawner({
    parentSessionId: sessionId,
    sessionsDir: SESSIONS_DIR,
    messageId: input.messageId,
    harnessFactory: input.harnessFactory,
    createLlm: ({ agentId, agentType, signal }) => {
      const extra = {
        signal,
        sessionId,
        agentId,
        agentType,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
      return {
        chat: (msgs, opts) => llmAdapter.chat(msgs, { usageSource: 'sub_agent', ...opts, ...extra }),
        stream: (msgs, callback, opts) =>
          llmAdapter.stream(msgs, callback, { usageSource: 'sub_agent', ...opts, ...extra }),
      };
    },
    onConfirm: createAgentToolConfirmHandler(sessionId),
    onShellMandatoryConfirm: createAgentShellMandatoryConfirmHandler(sessionId),
  });
}

/** 停止一个运行中的子 Agent；不在本进程运行时返回 false。 */
export function stopSessionAgent(sessionId: string, agentId: string): boolean {
  return getSessionAgentSpawner(sessionId)?.stop(agentId) ?? false;
}
