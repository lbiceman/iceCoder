import { describe, expect, it } from 'vitest';

import {
  resolveLlmToolsForRound,
  shouldUseCasualLlmFastPath,
} from '../../src/harness/casual-mode.js';
import type { ToolDefinition } from '../../src/llm/types.js';

const DUMMY_TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
];

describe('shouldUseCasualLlmFastPath', () => {
  it('启用：纯寒暄 question', () => {
    expect(shouldUseCasualLlmFastPath('你好')).toBe(true);
    expect(shouldUseCasualLlmFastPath('  你好呀  ')).toBe(true);
    expect(shouldUseCasualLlmFastPath('你是谁？')).toBe(true);
    expect(shouldUseCasualLlmFastPath('谢谢')).toBe(true);
  });

  it('禁用：inspect 或工程诉求', () => {
    expect(shouldUseCasualLlmFastPath('查看 package.json 内容')).toBe(false);
    expect(shouldUseCasualLlmFastPath('解释一下 src/main.ts 这个函数')).toBe(false);
    expect(shouldUseCasualLlmFastPath('帮我修复 login 报错')).toBe(false);
    expect(shouldUseCasualLlmFastPath('运行 npm test')).toBe(false);
    expect(shouldUseCasualLlmFastPath('实现一个 todo 列表')).toBe(false);
  });

  it('禁用：空消息', () => {
    expect(shouldUseCasualLlmFastPath('')).toBe(false);
    expect(shouldUseCasualLlmFastPath('   ')).toBe(false);
  });
});

describe('resolveLlmToolsForRound', () => {
  it('始终返回全量 tools', () => {
    expect(resolveLlmToolsForRound(DUMMY_TOOLS, 1, '你好')).toEqual(DUMMY_TOOLS);
    expect(resolveLlmToolsForRound(DUMMY_TOOLS, 1, '修复 build 失败')).toEqual(DUMMY_TOOLS);
    expect(resolveLlmToolsForRound(DUMMY_TOOLS, 2, '你好')).toEqual(DUMMY_TOOLS);
  });
});
