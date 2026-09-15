/**
 * 用脚本 LLM 驱动真实 Harness + 内置工具，跑新增 agent-eval case。
 * 不打外部 API；用来锁住失败日志尾巴 / 多轮 Runtime 跳过 / 改完再测。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { agentEvalCases, type AgentEvalCase } from '../../scripts/agent-eval-cases.js';
import { runAgentEvalCase } from '../../scripts/agent-eval-runner.js';
import type { ChatFunction } from '../../src/harness/types.js';
import type { LLMResponse, UnifiedMessage } from '../../src/llm/types.js';

function caseById(id: string): AgentEvalCase {
  const found = agentEvalCases.find(c => c.id === id);
  if (!found) throw new Error(`missing agent-eval case: ${id}`);
  return found;
}

function usage() {
  return { inputTokens: 40, outputTokens: 20, totalTokens: 60, provider: 'eval' };
}

function finalResponse(content: string): LLMResponse {
  return { content, usage: usage(), finishReason: 'stop' };
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id, name, arguments: args }],
    usage: usage(),
    finishReason: 'tool_calls',
  };
}

function hasRuntime(msgs: UnifiedMessage[]): boolean {
  const last = msgs.at(-1);
  return typeof last?.content === 'string' && last.content.includes('[System Runtime State]');
}

function isPrimaryEvalChat(msgs: UnifiedMessage[]): boolean {
  return msgs.some(m =>
    typeof m.content === 'string' && m.content.includes('isolated local eval workspace'),
  );
}

function toolById(msgs: UnifiedMessage[], id: string): string {
  const found = msgs.find(m => m.role === 'tool' && m.toolCallId === id);
  return typeof found?.content === 'string' ? found.content : '';
}

describe('agent-eval sandbox (scripted LLM + real tools)', () => {
  afterEach(() => {
    delete process.env.ICE_EVAL_MODE;
  });

  it('noisy-test-failure-fix keeps the assertion at the end of noisy npm test output', async () => {
    process.env.ICE_EVAL_MODE = '1';
    let step = 0;
    const chatFn: ChatFunction = async (msgs) => {
      if (!isPrimaryEvalChat(msgs)) return finalResponse('side-query noop');
      step += 1;
      if (step === 1) {
        return toolCall('fail-test', 'run_command', { command: 'npm test' });
      }
      if (step === 2) {
        const failed = toolById(msgs, 'fail-test');
        expect(failed).toContain('setup-noise-0');
        expect(failed).toMatch(/AssertionError|strictly equal|99\.8/);
        expect(failed).toContain('80');
        return toolCall('read-score', 'read_file', { path: 'src/score.js' });
      }
      if (step === 3) {
        return toolCall('edit-score', 'edit_file', {
          path: 'src/score.js',
          search: 'return price - rate;',
          replace: 'return price * (1 - rate);',
        });
      }
      if (step === 4) {
        return toolCall('pass-test', 'run_command', { command: 'npm test' });
      }
      return finalResponse('Fixed applyScore to price * (1 - rate) and npm test passed.');
    };

    const result = await runAgentEvalCase(caseById('noisy-test-failure-fix'), { chatFn });
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.metrics.verification_rate).toBe(1);
  }, 90_000);

  it('multi-round-runtime-stable-edit skips unchanged Runtime JSON then finishes the edit', async () => {
    process.env.ICE_EVAL_MODE = '1';
    let step = 0;
    const chatFn: ChatFunction = async (msgs) => {
      if (!isPrimaryEvalChat(msgs)) return finalResponse('side-query noop');
      step += 1;
      if (step === 1) {
        return toolCall('read-1', 'read_file', { path: 'src/label.js' });
      }
      if (step === 2) {
        expect(hasRuntime(msgs)).toBe(true);
        return toolCall('read-2', 'read_file', { path: 'src/label.js' });
      }
      if (step === 3) {
        expect(hasRuntime(msgs)).toBe(false);
        return toolCall('edit-label', 'edit_file', {
          path: 'src/label.js',
          search: "return 'draft';",
          replace: "return 'ok';",
        });
      }
      if (step === 4) {
        return toolCall('verify', 'run_command', { command: 'npm test' });
      }
      return finalResponse('Updated text() to return ok and npm test passed.');
    };

    const result = await runAgentEvalCase(caseById('multi-round-runtime-stable-edit'), { chatFn });
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.metrics.verification_rate).toBe(1);
  }, 90_000);
});
