import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  createToolResultClearingSection,
  loadAssembledChatPrompt,
  shouldDisableRuntimeTools,
} from '../../src/prompts/index.js';

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('prompt assembly safeguards', () => {
  it('保留工具结果清理 section 的公共导出', () => {
    const section = createToolResultClearingSection();
    expect(section.id).toBe('tool_result_clearing');
    expect(section.content).toContain('Tool results may be trimmed');
  });

  it('ICE_EVAL_MODE 和 ICE_DISABLE_TOOLS 都会禁用运行时工具', () => {
    process.env.ICE_EVAL_MODE = '1';
    expect(shouldDisableRuntimeTools()).toBe(true);

    delete process.env.ICE_EVAL_MODE;
    process.env.ICE_DISABLE_TOOLS = '1';
    expect(shouldDisableRuntimeTools()).toBe(true);
  });

  it('只在旧 system-prompt.md 被用户改过时作为 custom system 生效', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `prompt-test-${randomUUID()}`));
    const promptPath = path.join(tempDir, 'system-prompt.md');
    const defaultPrompt = '默认系统提示词';

    await fs.writeFile(promptPath, defaultPrompt, 'utf-8');
    const unchanged = await loadAssembledChatPrompt({
      logPrefix: '[test]',
      systemPromptPath: promptPath,
      defaultSystemPrompt: defaultPrompt,
    });
    expect(unchanged.systemPrompt).not.toBe(defaultPrompt);

    await fs.writeFile(promptPath, '自定义系统提示词', 'utf-8');
    const customized = await loadAssembledChatPrompt({
      logPrefix: '[test]',
      systemPromptPath: promptPath,
      defaultSystemPrompt: defaultPrompt,
    });
    expect(customized.systemPrompt).toBe('自定义系统提示词');
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
