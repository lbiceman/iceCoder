/**
 * 提示词组装器 — 将各段落组装成完整的系统提示词。
 *
 * 提示词拼接流程：
 *
 * 1. 收集所有段落（静态 + 自选动态段如 memories）
 * 2. 按优先级排序
 * 3. 过滤掉未启用的段落与 removeSection 禁用的默认段
 * 4. 拼接稳定 system（不含 environment、append、memories、preferences）
 * 5. 易变项经 harnessOverlay 与 userContext 进入首轮 `<system-context>`
 */

import type {
  PromptSection,
  PromptAssemblyConfig,
  AssembledPrompt,
  UserContext,
  SystemContext,
  EnvironmentInfo,
  HarnessPromptOverlay,
  HarnessDynamicContextSlice,
} from './types.js';
import { getDefaultSections } from './sections.js';

/**
 * EnvironmentInfo → 扁平键值，供 ContextAssembler.environment 使用。
 */
export function environmentInfoToRecord(env: EnvironmentInfo): Record<string, string> {
  const r: Record<string, string> = {
    workingDirectory: env.workingDirectory,
    platform: env.platform,
    currentDate: env.currentDate,
  };
  if (env.shell) r.shell = env.shell;
  if (env.osVersion) r.osVersion = env.osVersion;
  if (env.isGitRepo !== undefined) r.gitRepo = env.isGitRepo ? 'yes' : 'no';
  if (env.modelName) r.model = env.modelName;
  return r;
}

/**
 * 将 assemble 产出的 harnessOverlay 映射到 Harness 上下文片段。
 * 合并 `AssembledPrompt.userContext`（如 memories）与 overlay 中的项目说明。
 */
export function harnessOverlayToContextFields(ap: AssembledPrompt): HarnessDynamicContextSlice {
  const o = ap.harnessOverlay;
  const out: HarnessDynamicContextSlice = {};

  if (o?.environment && Object.keys(o.environment).length > 0) {
    out.environment = o.environment;
  }
  if (o?.language?.trim()) {
    out.language = o.language.trim();
  }

  const uc: Record<string, string> = {};
  if (ap.userContext) Object.assign(uc, ap.userContext);
  if (o?.projectMarkdown?.trim()) {
    uc.project_instructions = o.projectMarkdown.trim();
  }
  if (Object.keys(uc).length > 0) {
    out.userContext = uc;
  }

  return out;
}

/**
 * 提示词组装器。
 *
 * 使用方式：
 * ```ts
 * const assembler = new PromptAssembler();
 * const result = assembler.assemble({
 *   environment: { workingDirectory: '/project', platform: 'darwin', currentDate: '2026-05-09' },
 *   memories: ['optional — goes to dynamic userContext, not static system'],
 * });
 * console.log(result.systemPrompt);
 * ```
 */
export class PromptAssembler {
  private customSections: PromptSection[] = [];
  private disabledDefaultSectionIds = new Set<string>();

  /**
   * 禁用默认段落（含 getDefaultSections 中的 id）。
   */
  removeSection(id: string): void {
    this.disabledDefaultSectionIds.add(id);
    this.customSections = this.customSections.filter(s => s.id !== id);
  }

  /**
   * 添加自定义段落。
   */
  addSection(section: PromptSection): void {
    this.customSections.push(section);
  }

  /**
   * 组装完整的提示词。
   */
  assemble(config: PromptAssemblyConfig = {}): AssembledPrompt {
    // 自定义 system：正文仅 custom；appendSystemPrompt → overlay（与默认路径一致）
    if (config.customSystemPrompt) {
      const systemPrompt = config.customSystemPrompt.trim();
      const baseOverlay = this.buildHarnessOverlay({
        ...config,
        appendSystemPrompt: undefined,
      });
      let harnessOverlay: HarnessPromptOverlay | undefined = baseOverlay;
      if (config.appendSystemPrompt?.trim()) {
        harnessOverlay = {
          ...(baseOverlay ?? {}),
          projectMarkdown: config.appendSystemPrompt.trim(),
        };
      }
      const hasOverlay = !!(
        harnessOverlay
        && (harnessOverlay.environment
          || harnessOverlay.language
          || harnessOverlay.projectMarkdown)
      );

      return {
        systemPromptSections: [{
          id: 'custom',
          title: '自定义提示词',
          content: systemPrompt,
          isStatic: false,
          priority: 0,
          enabled: true,
        }],
        systemPrompt,
        harnessOverlay: hasOverlay ? harnessOverlay : undefined,
        userContext: this.nonEmptyUserContext(config),
        systemContext: this.buildSystemContext(config),
      };
    }

    const baseSections: PromptSection[] = [
      ...getDefaultSections().filter(s => !this.disabledDefaultSectionIds.has(s.id)),
      ...this.customSections.filter(s => !this.disabledDefaultSectionIds.has(s.id)),
    ];

    const sections: PromptSection[] = [...baseSections];

    const enabledSections = sections
      .filter(s => s.enabled)
      .sort((a, b) => a.priority - b.priority);

    let systemPrompt = enabledSections
      .map(s => s.content)
      .join('\n\n');

    const harnessOverlay = this.buildHarnessOverlay(config);
    const systemContext = this.buildSystemContext(config);

    return {
      systemPromptSections: enabledSections,
      systemPrompt,
      harnessOverlay,
      userContext: this.nonEmptyUserContext(config),
      systemContext: Object.keys(systemContext).length > 0 ? systemContext : undefined,
    };
  }

  private buildHarnessOverlay(config: PromptAssemblyConfig): HarnessPromptOverlay | undefined {
    const overlay: HarnessPromptOverlay = {};

    if (config.environment) {
      overlay.environment = environmentInfoToRecord(config.environment);
    }

    if (config.language?.trim()) {
      overlay.language = config.language.trim();
    }

    if (config.appendSystemPrompt?.trim()) {
      overlay.projectMarkdown = config.appendSystemPrompt.trim();
    }

    const hasAny = overlay.environment
      || overlay.language
      || overlay.projectMarkdown;

    return hasAny ? overlay : undefined;
  }

  private nonEmptyUserContext(config: PromptAssemblyConfig): UserContext | undefined {
    const u = this.buildUserContext(config);
    return Object.keys(u).length > 0 ? u : undefined;
  }

  /**
   * 构建用户上下文（注入首轮 `<system-context>` # 小节，不写入静态 system）。
   */
  private buildUserContext(config: PromptAssemblyConfig): UserContext {
    const context: UserContext = {};

    if (config.memories && config.memories.length > 0) {
      context.projectMemory = `# Project Memory\n${config.memories.join('\n\n')}`;
    }

    if (config.userPreferences && Object.keys(config.userPreferences).length > 0) {
      const lines = Object.entries(config.userPreferences)
        .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
        .join('\n');
      context.user_preferences = `# User Preferences\n${lines}`;
    }

    return context;
  }

  /**
   * 构建系统上下文。
   *
   * 包含 git 状态等实时信息，追加到系统提示词末尾。
   */
  private buildSystemContext(_config: PromptAssemblyConfig): SystemContext {
    return {};
  }
}

/**
 * 将用户上下文格式化为 <system-reminder> 消息。
 *
 * 将用户上下文包裹在 <system-reminder> 标签中，
 * 作为第一条 user 消息注入到对话历史。
 */
export function formatUserContextMessage(userContext: UserContext): string {
  if (Object.keys(userContext).length === 0) return '';

  const sections = Object.entries(userContext)
    .map(([key, value]) => `# ${key}\n${value}`)
    .join('\n\n');

  return `<system-reminder>
以下上下文信息可能与你的任务相关，也可能无关。
不要主动回应这些上下文，除非它与当前任务高度相关。

${sections}
</system-reminder>`;
}

/**
 * 将系统上下文追加到系统提示词。
 */
export function appendSystemContext(
  systemPrompt: string,
  systemContext: SystemContext,
): string {
  if (Object.keys(systemContext).length === 0) return systemPrompt;

  const contextStr = Object.entries(systemContext)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  return `${systemPrompt}\n\n${contextStr}`;
}
