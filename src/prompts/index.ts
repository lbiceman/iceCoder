/**
 * 提示词系统入口。
 *
 * 提供结构化的提示词组装能力。
 */

export { PromptAssembler, formatUserContextMessage, appendSystemContext } from './prompt-assembler.js';

export type {
  PromptSection,
  PromptAssemblyConfig,
  AssembledPrompt,
  EnvironmentInfo,
  UserContext,
  SystemContext,
} from './types.js';

export {
  getDefaultSections,
  createIntroSection,
  createSystemSection,
  createDoingTasksSection,
  createActionsSection,
  createToolUsageSection,
  createShellGuideSection,
  createToneSection,
  createEnvironmentSection,
  createLanguageSection,
  createMemorySection,
  createPreferencesSection,
  createToolResultClearingSection,
} from './sections.js';
