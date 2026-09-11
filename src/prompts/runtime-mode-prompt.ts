/**
 * Web 会话模式提示词选择。
 * 无工具/评测模式优先，避免叠加要求调用不存在工具的 Plan 或 Shell 提示。
 */

import type { AssembledPrompt } from './types.js';
import { assemblePlanModePrompt } from './plan-mode-prompt.js';
import { assembleShellCollabPrompt } from './shell-collab-prompt.js';

export interface RuntimePromptMode {
  toolsDisabled: boolean;
  shellCollabActive: boolean;
  planModeActive: boolean;
}

export function applyRuntimeModePrompt(
  assembled: AssembledPrompt,
  mode: RuntimePromptMode,
): AssembledPrompt {
  if (mode.toolsDisabled) return assembled;
  if (mode.shellCollabActive) return assembleShellCollabPrompt(assembled);
  if (mode.planModeActive) return assemblePlanModePrompt(assembled);
  return assembled;
}
