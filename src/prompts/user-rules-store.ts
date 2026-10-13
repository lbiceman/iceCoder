/**
 * 用户级全局规则落盘：`{dataDir}/user-rules.json`，与工作区无关。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRuntimeDataDir } from '../cli/paths.js';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';
import {
  type UserRule,
  UserRuleValidationError,
  validateRuleContent,
  validateRuleSet,
} from './user-rules.js';

interface UserRulesFile {
  version: 1;
  rules: UserRule[];
}

export function getUserRulesPath(): string {
  return path.join(getRuntimeDataDir(), 'user-rules.json');
}

function normalizeRule(raw: unknown): UserRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.content !== 'string') return null;
  const now = new Date().toISOString();
  return {
    id: r.id,
    content: r.content,
    enabled: r.enabled !== false,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
  };
}

export async function readUserRules(filePath = getUserRulesPath()): Promise<UserRule[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UserRulesFile>;
    const list = Array.isArray(parsed.rules) ? parsed.rules : [];
    return list.map(normalizeRule).filter((r): r is UserRule => r !== null);
  } catch (err) {
    console.warn(`[user-rules] ${filePath} 解析失败，按无规则处理:`, err);
    return [];
  }
}

async function writeUserRules(rules: UserRule[], filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: UserRulesFile = { version: 1, rules };
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function userRulesFingerprint(filePath = getUserRulesPath()): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

export class UserRuleNotFoundError extends Error {}

export interface UserRulePatch {
  content?: unknown;
  enabled?: unknown;
}

/** 读-改-写串行化，避免并发保存互相覆盖。 */
export class UserRulesStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string = getUserRulesPath()) {}

  list(): Promise<UserRule[]> {
    return readUserRules(this.filePath);
  }

  private mutate<T>(fn: (rules: UserRule[]) => { rules: UserRule[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await readUserRules(this.filePath);
      const { rules, result } = fn(current);
      validateRuleSet(rules);
      await writeUserRules(rules, this.filePath);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  create(input: UserRulePatch): Promise<UserRule> {
    const content = validateRuleContent(input.content);
    const enabled = input.enabled !== false;
    return this.mutate((rules) => {
      const now = new Date().toISOString();
      const rule: UserRule = { id: randomUUID(), content, enabled, createdAt: now, updatedAt: now };
      return { rules: [...rules, rule], result: rule };
    });
  }

  update(id: string, patch: UserRulePatch): Promise<UserRule> {
    const content = patch.content === undefined ? undefined : validateRuleContent(patch.content);
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
      return Promise.reject(new UserRuleValidationError('enabled 必须是布尔值'));
    }
    return this.mutate((rules) => {
      const idx = rules.findIndex((r) => r.id === id);
      if (idx < 0) throw new UserRuleNotFoundError(`规则不存在: ${id}`);
      const next: UserRule = {
        ...rules[idx],
        ...(content !== undefined ? { content } : {}),
        ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
        updatedAt: new Date().toISOString(),
      };
      const copy = rules.slice();
      copy[idx] = next;
      return { rules: copy, result: next };
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((rules) => {
      if (!rules.some((r) => r.id === id)) throw new UserRuleNotFoundError(`规则不存在: ${id}`);
      return { rules: rules.filter((r) => r.id !== id), result: undefined };
    });
  }
}
