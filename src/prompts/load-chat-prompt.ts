/**
 * PC / Remote WebSocket / CLI 共用的聊天提示词加载。
 * 不注入固定自然语言偏好，由用户消息自行决定回复语言。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'path';
import type { AssembledPrompt } from './types.js';
import { PromptAssembler } from './prompt-assembler.js';
import { applyEvaluationModePromptOverlay } from './evaluation-mode-prompt.js';
import { getDefaultWorkDir } from '../cli/paths.js';

export interface LoadChatPromptOptions {
  /** 日志前缀，如 '[chat-ws]' */
  logPrefix?: string;
  /** 兼容旧配置：用户显式编辑过的 system-prompt.md 可作为 custom system */
  systemPromptPath?: string;
  /** 默认 system-prompt.md 内容；内容与默认值一致时忽略 */
  defaultSystemPrompt?: string;
}

export function shouldDisableRuntimeTools(): boolean {
  return process.env.ICE_EVAL_MODE === '1' || process.env.ICE_DISABLE_TOOLS === '1';
}

/**
 * 加载 .iceCoder/memory.md、评测附加段，组装稳定 system + harnessOverlay。
 */
export async function loadAssembledChatPrompt(options: LoadChatPromptOptions = {}): Promise<AssembledPrompt> {
  const prefix = options.logPrefix ?? '[prompt]';
  const isEvalMode = process.env.ICE_EVAL_MODE === '1';
  const isToolsDisabled = process.env.ICE_DISABLE_TOOLS === '1';

  const assembler = new PromptAssembler();

  if (isEvalMode || isToolsDisabled) {
    assembler.removeSection('tool_usage');
    assembler.removeSection('shell_guide');
    assembler.removeSection('doing_tasks');
    assembler.removeSection('actions');
  }

  const iceCoderDir = path.resolve('.iceCoder');
  const memoryMdPath = path.join(iceCoderDir, 'memory.md');
  let projectMemory = '';
  try {
    projectMemory = (await fsPromises.readFile(memoryMdPath, 'utf-8')).trim();
    if (projectMemory) {
      console.log(`${prefix} 已加载项目指令 (.iceCoder/memory.md, ${projectMemory.length} 字符)`);
    }
  } catch {
    try {
      await fsPromises.mkdir(iceCoderDir, { recursive: true });
      await fsPromises.writeFile(memoryMdPath, '# Project Memory\n', 'utf-8');
      console.log(`${prefix} 已创建 .iceCoder/memory.md 模板文件`);
    } catch { /* ignore */ }
  }

  const appendParts = [projectMemory].filter(Boolean);
  const appendPrompt = appendParts.length > 0 ? appendParts.join('\n\n') : undefined;
  const systemPromptPath = options.systemPromptPath ?? process.env.ICE_SYSTEM_PROMPT_PATH;
  let customSystemPrompt: string | undefined;
  if (systemPromptPath) {
    try {
      const raw = (await fsPromises.readFile(systemPromptPath, 'utf-8')).trim();
      const defaultPrompt = options.defaultSystemPrompt?.trim();
      const isExplicitEnvPath = !!process.env.ICE_SYSTEM_PROMPT_PATH;
      if (raw && (isExplicitEnvPath || !defaultPrompt || raw !== defaultPrompt)) {
        customSystemPrompt = raw;
        console.log(`${prefix} 已加载自定义系统提示词 (${systemPromptPath}, ${raw.length} 字符)`);
      }
    } catch { /* optional legacy prompt */ }
  }

  const assembled = assembler.assemble({
    customSystemPrompt,
    environment: {
      workingDirectory: getDefaultWorkDir(),
      platform: process.platform === 'win32' ? 'win32' : process.platform,
      currentDate: new Date().toISOString().slice(0, 10),
    },
    appendSystemPrompt: appendPrompt,
  });
  return isEvalMode
    ? applyEvaluationModePromptOverlay(assembled)
    : assembled;
}
