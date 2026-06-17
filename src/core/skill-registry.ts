/**
 * 技能注册表：统一管理磁盘技能与内置注册技能。
 */

import { applyRuntimeDataEnvDefaults } from '../cli/paths.js';
import type { SkillMeta } from '../skills/skill-loader.js';
import {
  scanSkillFiles,
  readSkillFile,
  readSkillBody,
  parseAllSkillRefsFromMessage,
  normalizeSkillFilename,
  wantsSkillCreation,
  prependSkillCreationGuide,
} from '../skills/skill-loader.js';

export type { SkillMeta };

export interface RegisteredSkill extends SkillMeta {
  source: 'disk' | 'builtin';
}

export interface SkillResolveResult {
  filename: string;
  displayText: string;
  augmentedText: string;
}

/** 技能注册表 */
export class SkillRegistry {
  private readonly skillsDir: string;
  private readonly builtins = new Map<string, RegisteredSkill>();
  private diskCache: RegisteredSkill[] | null = null;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  /** 注册内置技能（优先级高于同名磁盘技能）。 */
  register(skill: Omit<RegisteredSkill, 'source'> & { source?: 'builtin' }): void {
    const filename = normalizeSkillFilename(skill.filename);
    this.builtins.set(filename, { ...skill, filename, source: 'builtin' });
    this.diskCache = null;
  }

  invalidate(): void {
    this.diskCache = null;
  }

  private async loadDiskSkills(): Promise<RegisteredSkill[]> {
    if (this.diskCache) return this.diskCache;
    const scanned = await scanSkillFiles(this.skillsDir);
    this.diskCache = scanned.map(s => ({ ...s, source: 'disk' as const }));
    return this.diskCache;
  }

  /** 列出所有技能（内置覆盖同名磁盘项）。 */
  async listSkills(): Promise<RegisteredSkill[]> {
    const disk = await this.loadDiskSkills();
    const merged = new Map<string, RegisteredSkill>();
    for (const s of disk) merged.set(s.filename, s);
    for (const [k, v] of this.builtins) merged.set(k, v);
    return Array.from(merged.values()).sort(
      (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
    );
  }

  async getSkillMeta(filename: string): Promise<RegisteredSkill | null> {
    const key = normalizeSkillFilename(filename);
    const builtin = this.builtins.get(key);
    if (builtin) return builtin;
    const found = await readSkillFile(this.skillsDir, key);
    if (!found) return null;
    return { ...found.meta, source: 'disk' };
  }

  async getSkillContent(filename: string): Promise<string | null> {
    const key = normalizeSkillFilename(filename);
    const found = await readSkillFile(this.skillsDir, key);
    return found?.content ?? null;
  }

  async getSkillBody(filename: string): Promise<string | null> {
    const key = normalizeSkillFilename(filename);
    return readSkillBody(this.skillsDir, key);
  }

  /**
   * 若消息含 #skill.md 引用，将所有技能正文注入发给模型的文本。
   * 原始展示文本保持不变，仅 augmentedText 用于 Harness。
   */
  async resolveMessage(text: string): Promise<SkillResolveResult | null> {
    const filenames = parseAllSkillRefsFromMessage(text);
    if (!filenames.length) return null;

    const sections: string[] = [];
    const loaded: string[] = [];
    for (const filename of filenames) {
      const body = await this.getSkillBody(filename);
      if (body) {
        sections.push(`[Active Skill: ${filename}]\n${body}`);
        loaded.push(filename);
      }
    }
    if (!sections.length) return null;

    let userPart = text;
    for (const filename of filenames) {
      const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      userPart = userPart.replace(new RegExp(`(^|\\s)#${escaped}(?=\\s|$)`, 'g'), ' ');
    }
    userPart = userPart.replace(/\s+/g, ' ').trim();
    if (!userPart) {
      userPart = '请按上述技能指引执行任务。';
    }

    const augmentedText = [...sections, '', '[User Request]', userPart].join('\n');

    return {
      filename: loaded.join(', '),
      displayText: text,
      augmentedText,
    };
  }

  /** 若用户要创建/编辑/修改技能文件，在发往模型的文本前注入目录与格式指引。 */
  applyCreationGuideIfNeeded(harnessText: string, userText: string): string {
    if (!wantsSkillCreation(userText)) return harnessText;
    return prependSkillCreationGuide(harnessText, this.skillsDir);
  }
}

let globalRegistry: SkillRegistry | null = null;

/** 获取全局技能注册表（懒初始化）。 */
export function getSkillRegistry(): SkillRegistry {
  if (!globalRegistry) {
    applyRuntimeDataEnvDefaults();
    const skillsDir = process.env.ICE_SKILLS_DIR!;
    globalRegistry = new SkillRegistry(skillsDir);
  }
  return globalRegistry;
}

/** 测试或启动时替换全局实例。 */
export function setSkillRegistry(registry: SkillRegistry | null): void {
  globalRegistry = registry;
}
