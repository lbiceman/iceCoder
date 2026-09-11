/**
 * 提示词系统入口。
 *
 * 提供结构化的提示词组装能力。
 */

export { loadAssembledChatPrompt, shouldDisableRuntimeTools } from './load-chat-prompt.js';

export {
  PromptAssembler,
  formatUserContextMessage,
  appendSystemContext,
  environmentInfoToRecord,
  harnessOverlayToContextFields,
  alignPromptWithAvailableTools,
} from './prompt-assembler.js';

export type {
  PromptSection,
  PromptAssemblyConfig,
  AssembledPrompt,
  HarnessPromptOverlay,
  HarnessDynamicContextSlice,
  EnvironmentInfo,
  UserContext,
  SystemContext,
} from './types.js';

export {
  getDefaultSections,
  createIntroSection,
  createWorkStyleSection,
  createSystemSection,
  createDoingTasksSection,
  createActionsSection,
  createToolUsageSection,
  createShellGuideSection,
  createToneSection,
  createActionFirstSection,
  createOutputEfficiencySection,
  createEnvironmentSection,
  createLanguageSection,
  createMemorySection,
  createPreferencesSection,
  createToolResultClearingSection,
  createEvaluationModeSection,
  createPlanModeSection,
  PLAN_MODE_REMOVED_SECTION_IDS,
  createShellCopilotSection,
  SHELL_COLLAB_REMOVED_SECTION_IDS,
} from './sections.js';

export { applyEvaluationModePromptOverlay } from './evaluation-mode-prompt.js';
export { applyRuntimeModePrompt } from './runtime-mode-prompt.js';
export type { RuntimePromptMode } from './runtime-mode-prompt.js';

export {
  applyPlanModePromptOverlay,
  assemblePlanModePrompt,
} from './plan-mode-prompt.js';

export {
  applyShellCollabPromptOverlay,
  assembleShellCollabPrompt,
} from './shell-collab-prompt.js';
