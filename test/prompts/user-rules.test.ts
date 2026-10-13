import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  USER_RULES_LIMITS,
  type UserRule,
  UserRuleValidationError,
  enabledUserRulesChars,
  estimateUserRulesTokens,
  formatUserRulesList,
  userRulesOverheadTokens,
  validateRuleContent,
} from '../../src/prompts/user-rules.js';
import {
  UserRuleNotFoundError,
  UserRulesStore,
  getUserRulesPath,
  readUserRules,
  userRulesFingerprint,
} from '../../src/prompts/user-rules-store.js';
import { harnessOverlayToContextFields, loadAssembledChatPrompt } from '../../src/prompts/index.js';
import { getOrLoadAssembledChatPrompt, resetAssembledChatPromptCache } from '../../src/web/chat-ws-prewarm.js';

function rule(content: string, enabled = true): UserRule {
  return { id: content, content, enabled, createdAt: '', updatedAt: '' };
}

describe('用户规则：格式化与估算', () => {
  it('只输出启用且非空的规则，按顺序编号，多行续行缩进', () => {
    const list = formatUserRulesList([
      rule('始终使用简体中文回复'),
      rule('停用的规则', false),
      rule('   '),
      rule('提交前：\n1. 跑单测\n2. 跑 lint'),
    ]);
    expect(list).toBe('1. 始终使用简体中文回复\n2. 提交前：\n   1. 跑单测\n   2. 跑 lint');
  });

  it('无启用规则时估算为 0，有规则时 = 固定开销 + 内容', () => {
    expect(estimateUserRulesTokens([])).toBe(0);
    expect(estimateUserRulesTokens([rule('停用', false)])).toBe(0);

    const overhead = userRulesOverheadTokens();
    const zh = estimateUserRulesTokens([rule('中'.repeat(100))]);
    expect(zh).toBeGreaterThanOrEqual(overhead + 100);
    expect(zh).toBeLessThanOrEqual(overhead + 102);

    // 英文约 4 字符 / token
    const en = estimateUserRulesTokens([rule('a'.repeat(400))]);
    expect(en).toBeGreaterThanOrEqual(overhead + 100);
    expect(en).toBeLessThanOrEqual(overhead + 102);
  });

  it('启用字数只统计启用规则的去空白内容', () => {
    expect(enabledUserRulesChars([rule('  abc  '), rule('xxxx', false)])).toBe(3);
  });
});

describe('用户规则：内容校验', () => {
  it('去除首尾空白后返回', () => {
    expect(validateRuleContent('  规则  ')).toBe('规则');
  });

  it.each([
    [undefined, '必须是文本'],
    [123, '必须是文本'],
    ['   ', '不能为空'],
    ['x'.repeat(USER_RULES_LIMITS.maxEnabledTotalChars + 1), `最多 ${USER_RULES_LIMITS.maxEnabledTotalChars} 字`],
  ])('非法内容 %#', (input, message) => {
    expect(() => validateRuleContent(input)).toThrow(UserRuleValidationError);
    expect(() => validateRuleContent(input)).toThrow(message);
  });

  it('单条没有独立上限，可一条写满总额度', () => {
    const max = USER_RULES_LIMITS.maxEnabledTotalChars;
    expect(validateRuleContent('x'.repeat(max))).toHaveLength(max);
  });

  it('包含密钥时拒绝并提示类型，不回显密钥', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    let message = '';
    try {
      validateRuleContent(`用这个 token: ${token}`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('GitHub PAT');
    expect(message).not.toContain(token);
  });
});

describe('UserRulesStore', () => {
  let dir: string;
  let file: string;
  let store: UserRulesStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-user-rules-'));
    file = path.join(dir, 'user-rules.json');
    store = new UserRulesStore(file);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('文件不存在时为空；增改删后落盘', async () => {
    expect(await store.list()).toEqual([]);

    const a = await store.create({ content: '规则 A' });
    expect(a).toMatchObject({ content: '规则 A', enabled: true });
    const b = await store.create({ content: '规则 B', enabled: false });

    const updated = await store.update(a.id, { content: '规则 A2', enabled: false });
    expect(updated).toMatchObject({ id: a.id, content: '规则 A2', enabled: false });

    await store.remove(b.id);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.rules.map((r: UserRule) => r.content)).toEqual(['规则 A2']);
  });

  it('不存在的 id 报 NotFound', async () => {
    await expect(store.update('nope', { enabled: true })).rejects.toBeInstanceOf(UserRuleNotFoundError);
    await expect(store.remove('nope')).rejects.toBeInstanceOf(UserRuleNotFoundError);
  });

  it('enabled 非布尔值拒绝', async () => {
    const a = await store.create({ content: 'x' });
    await expect(store.update(a.id, { enabled: 'yes' })).rejects.toBeInstanceOf(UserRuleValidationError);
  });

  it('不限条数：50 条合计 2999 字时，第 51 条只能写 1 个字', async () => {
    const max = USER_RULES_LIMITS.maxEnabledTotalChars;
    // 49 条 × 60 字 + 1 条 59 字 = 2999 字
    for (let i = 0; i < 49; i++) await store.create({ content: 'x'.repeat(60) });
    await store.create({ content: 'y'.repeat(59) });
    expect(enabledUserRulesChars(await store.list())).toBe(max - 1);

    await expect(store.create({ content: '两字' })).rejects.toThrow('启用规则合计');
    await expect(store.create({ content: '一' })).resolves.toMatchObject({ content: '一' });
    expect(await store.list()).toHaveLength(51);
    await expect(store.create({ content: '满' })).rejects.toThrow('启用规则合计');
    // 停用规则不占额度，额度满了也能存
    await expect(store.create({ content: '备用', enabled: false })).resolves.toMatchObject({ enabled: false });
  });

  it('启用合计超限时拒绝新增 / 启用 / 加长，停用规则不计入', async () => {
    const per = 1000;
    const fits = USER_RULES_LIMITS.maxEnabledTotalChars / per;
    for (let i = 0; i < fits; i++) await store.create({ content: String(i).padEnd(per, 'x') });

    await expect(store.create({ content: 'y' })).rejects.toThrow('启用规则合计');
    const off = await store.create({ content: 'y', enabled: false });
    await expect(store.update(off.id, { enabled: true })).rejects.toThrow('启用规则合计');

    const [first] = await store.list();
    await store.update(first.id, { content: 'short' });
    await expect(store.update(off.id, { enabled: true })).resolves.toMatchObject({ enabled: true });
    await expect(store.update(first.id, { content: 'z'.repeat(per) })).rejects.toThrow('启用规则合计');
  });

  it('并发写入串行化，不丢规则', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.create({ content: `c${i}` })));
    const contents = (await store.list()).map((r) => r.content).sort();
    expect(contents).toEqual(Array.from({ length: 10 }, (_, i) => `c${i}`).sort());
  });

  it('文件损坏时按无规则处理，不抛错', async () => {
    await fs.writeFile(file, '{not json', 'utf-8');
    expect(await readUserRules(file)).toEqual([]);
  });

  it('指纹随写入变化', async () => {
    const before = await userRulesFingerprint(file);
    expect(before).toBe('missing');
    await store.create({ content: 'x' });
    expect(await userRulesFingerprint(file)).not.toBe(before);
  });
});

describe('用户规则注入聊天提示词', () => {
  const OLD_ENV = { ...process.env };
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-user-rules-data-'));
    process.env.ICE_DATA_DIR = dataDir;
    delete process.env.ICE_EVAL_MODE;
    resetAssembledChatPromptCache();
  });

  afterEach(async () => {
    process.env = { ...OLD_ENV };
    resetAssembledChatPromptCache();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('规则存于数据目录 user-rules.json', () => {
    expect(getUserRulesPath()).toBe(path.join(dataDir, 'user-rules.json'));
  });

  it('启用规则进入 userContext.user_rules，不进入静态 system', async () => {
    const store = new UserRulesStore();
    await store.create({ content: 'Always answer in French.' });
    await store.create({ content: 'Disabled rule', enabled: false });

    const assembled = await loadAssembledChatPrompt({ logPrefix: '[test]', workspaceRoot: dataDir });
    expect(assembled.systemPrompt).not.toContain('Always answer in French.');
    const ctx = harnessOverlayToContextFields(assembled).userContext ?? {};
    expect(ctx.user_rules).toContain('# User Rules');
    expect(ctx.user_rules).toContain('1. Always answer in French.');
    expect(ctx.user_rules).not.toContain('Disabled rule');
  });

  it('自定义 system 时规则仍注入', async () => {
    await new UserRulesStore().create({ content: 'Rule with custom system' });
    const promptPath = path.join(dataDir, 'system-prompt.md');
    await fs.writeFile(promptPath, 'Custom system.', 'utf-8');

    const assembled = await loadAssembledChatPrompt({
      logPrefix: '[test]',
      workspaceRoot: dataDir,
      systemPromptPath: promptPath,
      defaultSystemPrompt: 'default',
    });
    expect(assembled.systemPrompt).toBe('Custom system.');
    expect(harnessOverlayToContextFields(assembled).userContext?.user_rules).toContain('Rule with custom system');
  });

  it('没有规则时不产生 user_rules', async () => {
    const assembled = await loadAssembledChatPrompt({ logPrefix: '[test]', workspaceRoot: dataDir });
    expect(harnessOverlayToContextFields(assembled).userContext?.user_rules).toBeUndefined();
  });

  it('评测模式不注入个人规则', async () => {
    await new UserRulesStore().create({ content: 'Personal rule' });
    process.env.ICE_EVAL_MODE = '1';
    const assembled = await loadAssembledChatPrompt({ logPrefix: '[test]', workspaceRoot: dataDir });
    expect(harnessOverlayToContextFields(assembled).userContext?.user_rules).toBeUndefined();
  });

  it('Web 预热缓存在规则变化后重新加载', async () => {
    const store = new UserRulesStore();
    await store.create({ content: 'First rule' });
    const first = await getOrLoadAssembledChatPrompt('[test]', dataDir);
    expect(harnessOverlayToContextFields(first).userContext?.user_rules).toContain('First rule');

    await store.create({ content: 'Second rule with different size' });
    const second = await getOrLoadAssembledChatPrompt('[test]', dataDir);
    expect(second).not.toBe(first);
    expect(harnessOverlayToContextFields(second).userContext?.user_rules).toContain('2. Second rule');
  });
});
