/**
 * PC / Remote WebSocket / CLI 共用的聊天提示词加载。
 * 不注入固定自然语言偏好，由用户消息自行决定回复语言。
 */

import { promises as fsPromises } from 'node:fs';
import type { AssembledPrompt } from './types.js';
import { PromptAssembler } from './prompt-assembler.js';
import { applyEvaluationModePromptOverlay } from './evaluation-mode-prompt.js';
import { LEGACY_PROJECT_INSTRUCTION_RELATIVE_PATH, loadProjectInstructions } from './project-instructions.js';
import { getDefaultWorkDir } from '../cli/paths.js';
import { enabledUserRules, estimateUserRulesTokens, formatUserRulesList } from './user-rules.js';
import { readUserRules } from './user-rules-store.js';

export interface LoadChatPromptOptions {
  /** 日志前缀，如 '[chat-ws]' */
  logPrefix?: string;
  /** 被操作工程的根目录，从这里查找 AGENTS.md；默认运行时默认工作区 */
  workspaceRoot?: string;
  /** 兼容旧配置：用户显式编辑过的 system-prompt.md 可作为 custom system */
  systemPromptPath?: string;
  /** 默认 system-prompt.md 内容；内容与默认值一致时忽略 */
  defaultSystemPrompt?: string;
}

export function shouldDisableRuntimeTools(): boolean {
  return process.env.ICE_EVAL_MODE === '1' || process.env.ICE_DISABLE_TOOLS === '1';
}

/**
 * 加载工程 AGENTS.md（见 project-instructions.ts）、评测附加段，组装稳定 system + harnessOverlay。
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

  const workspaceRoot = options.workspaceRoot ?? getDefaultWorkDir();
  const projectInstructions = await loadProjectInstructions(workspaceRoot);
  if (projectInstructions.content) {
    console.log(`${prefix} 已加载项目指令 (${projectInstructions.sources.join(', ')}, ${projectInstructions.content.length} 字符)`);
    if (projectInstructions.sources.some((s) => s.endsWith(LEGACY_PROJECT_INSTRUCTION_RELATIVE_PATH))) {
      console.log(`${prefix} .iceCoder/memory.md 已弃用，建议迁移到工程根目录 AGENTS.md`);
    }
  }
  if (projectInstructions.ignored.length > 0) {
    console.warn(`${prefix} 已忽略低优先级项目指令（同级已有 AGENTS.md / 新格式文件）: ${projectInstructions.ignored.join(', ')}`);
  }

  // 评测需可复现，不受个人规则影响
  const userRules = isEvalMode ? [] : enabledUserRules(await readUserRules());
  const userRulesList = formatUserRulesList(userRules);
  if (userRules.length > 0) {
    console.log(`${prefix} 已加载用户规则 (${userRules.length} 条, 约 ${estimateUserRulesTokens(userRules)} tokens)`);
  }

  const appendParts = [projectInstructions.content].filter(Boolean);
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
    userRules: userRulesList || undefined,
  });
  return isEvalMode
    ? applyEvaluationModePromptOverlay(assembled)
    : assembled;
}
