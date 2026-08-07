import { describe, expect, it } from 'vitest';
import { summarizeToolCalls } from '../../src/harness/checkpoint.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import {
  REDACTED_TOOL_ARGUMENT,
  redactToolArguments,
  redactToolCalls,
} from '../../src/tools/tool-argument-redaction.js';

describe('interactive_shell write argument redaction', () => {
  const secret = 'pw-rm -rf /-secret';
  const writeCall = {
    id: 'call-write',
    name: 'interactive_shell',
    arguments: {
      action: 'write',
      task_id: 'ish_test',
      input: secret,
    },
  };

  it('为 checkpoint / structured history 生成脱敏副本且不修改执行参数', () => {
    const redacted = redactToolCalls([writeCall])!;

    expect(redacted[0].arguments.input).toBe(REDACTED_TOOL_ARGUMENT);
    expect(redacted[0].arguments.task_id).toBe('ish_test');
    expect(writeCall.arguments.input).toBe(secret);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(summarizeToolCalls([writeCall]).join('\n')).not.toContain(secret);
    expect(summarizeToolCalls([writeCall]).join('\n')).toContain(REDACTED_TOOL_ARGUMENT);
  });

  it('Harness 工具日志不记录 write input 明文', () => {
    const logger = new HarnessLogger();
    logger.toolCall(writeCall.name, writeCall.arguments);

    const serialized = JSON.stringify(logger.getEntries());
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(REDACTED_TOOL_ARGUMENT);
  });

  it('不修改其他 action 或其他工具参数', () => {
    const readArgs = { action: 'read', input: secret };
    const otherArgs = { action: 'write', input: secret };

    expect(redactToolArguments('interactive_shell', readArgs)).toBe(readArgs);
    expect(redactToolArguments('another_tool', otherArgs)).toBe(otherArgs);
  });

  it('失败签名与 resilience 键不包含 write 凭证明文', () => {
    const signature = toolCallSignature(writeCall);
    expect(signature).toContain(REDACTED_TOOL_ARGUMENT);
    expect(signature).not.toContain(secret);
  });
});
