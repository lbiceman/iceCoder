/**
 * PC / Remote WebSocket / CLI 共用的聊天提示词加载。
 * 不注入固定自然语言偏好，由用户消息自行决定回复语言。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'path';
import type { AssembledPrompt } from './types.js';
import { PromptAssembler } from './prompt-assembler.js';
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
      await fsPromises.writeFile(memoryMdPath, '# 项目记忆\n', 'utf-8');
      console.log(`${prefix} 已创建 .iceCoder/memory.md 模板文件`);
    } catch { /* ignore */ }
  }

  const evalAppend = isEvalMode
    ? `## 评测模式（EVALUATION MODE）

你正在接受记忆系统的标准化评测。请严格遵守以下规则：

1. **直接回答问题**。不要调用任何工具、不要输出特殊字符、不要尝试读取文件。你没有工具可用。
2. **只使用系统注入的记忆**。你的回答必须完全基于 <system-reminder> 中提供的记忆内容。
3. **基于记忆推理**。如果记忆中没有直接答案但可以推理，给出推理结果并说明依据。只在完全没有相关信息时才说"不知道"。
4. **回答要简洁精准**。直接给出答案，不需要长篇解释。
5. **语言**：可选用与题目一致或与内容相匹配的语言作答；评测不强制「必须与题干语种完全相同」——以答案正确、依据清晰为准。
6. **部分正确优于完全放弃**。如果你知道部分答案，给出你确定的部分，对不确定的部分明确标注。`
    : undefined;

  const appendParts = [projectMemory, evalAppend].filter(Boolean);
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

  return assembler.assemble({
    customSystemPrompt,
    environment: {
      workingDirectory: getDefaultWorkDir(),
      platform: process.platform === 'win32' ? 'win32' : process.platform,
      currentDate: new Date().toISOString().slice(0, 10),
    },
    appendSystemPrompt: appendPrompt,
  });
}
