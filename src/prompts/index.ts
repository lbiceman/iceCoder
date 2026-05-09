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
} from './sections.js';
