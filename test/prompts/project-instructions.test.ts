import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listProjectInstructionCandidates,
  loadProjectInstructions,
  projectInstructionsFingerprint,
} from '../../src/prompts/project-instructions.js';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-agents-md-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(tempRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

describe('project instructions (AGENTS.md)', () => {
  it('读取工作区根目录的 AGENTS.md', async () => {
    await write('AGENTS.md', '# Rules\nuse pnpm');
    const loaded = await loadProjectInstructions(tempRoot);
    expect(loaded.sources).toEqual([path.join(tempRoot, 'AGENTS.md')]);
    expect(loaded.content).toContain('use pnpm');
  });

  it('git 仓库内从仓库根到工作区逐级合并，越近越靠后', async () => {
    await fs.mkdir(path.join(tempRoot, '.git'));
    await write('AGENTS.md', 'root rule');
    await write('packages/app/AGENTS.md', 'app rule');
    const workspace = path.join(tempRoot, 'packages', 'app');

    const loaded = await loadProjectInstructions(workspace);
    expect(loaded.sources).toEqual([
      path.join(tempRoot, 'AGENTS.md'),
      path.join(workspace, 'AGENTS.md'),
    ]);
    expect(loaded.content.indexOf('root rule')).toBeLessThan(loaded.content.indexOf('app rule'));
  });

  it('不在 git 仓库内时不向上查找父目录', async () => {
    await write('AGENTS.md', 'parent rule');
    await write('child/AGENTS.md', 'child rule');
    const loaded = await loadProjectInstructions(path.join(tempRoot, 'child'));
    expect(loaded.content).toContain('child rule');
    expect(loaded.content).not.toContain('parent rule');
  });

  it('同目录无 AGENTS.md 时回退 CLAUDE.md，两者都有时只取 AGENTS.md 并记录被忽略的 CLAUDE.md', async () => {
    await write('CLAUDE.md', 'claude rule');
    expect((await loadProjectInstructions(tempRoot)).content).toContain('claude rule');

    await write('AGENTS.md', 'agents rule');
    const loaded = await loadProjectInstructions(tempRoot);
    expect(loaded.content).toContain('agents rule');
    expect(loaded.content).not.toContain('claude rule');
    expect(loaded.ignored).toEqual([path.join(tempRoot, 'CLAUDE.md')]);
  });

  it('空的 AGENTS.md 不遮挡同级 CLAUDE.md', async () => {
    await write('AGENTS.md', '  \n');
    await write('CLAUDE.md', 'claude rule');
    const loaded = await loadProjectInstructions(tempRoot);
    expect(loaded.sources).toEqual([path.join(tempRoot, 'CLAUDE.md')]);
    expect(loaded.ignored).toEqual([]);
  });

  it('无 AGENTS.md / CLAUDE.md 时兼容旧版 .iceCoder/memory.md，有新文件时旧版被忽略并记录', async () => {
    await write('.iceCoder/memory.md', 'legacy rule');
    const loaded = await loadProjectInstructions(tempRoot);
    expect(loaded.sources).toEqual([path.join(tempRoot, '.iceCoder', 'memory.md')]);
    expect(loaded.content).toContain('legacy rule');

    await write('AGENTS.md', 'agents rule');
    const preferred = await loadProjectInstructions(tempRoot);
    expect(preferred.content).not.toContain('legacy rule');
    expect(preferred.ignored).toEqual([path.join(tempRoot, '.iceCoder', 'memory.md')]);
  });

  it('旧版自动生成的空模板 .iceCoder/memory.md 视为无内容', async () => {
    await write('.iceCoder/memory.md', '# Project Memory\n');
    expect(await loadProjectInstructions(tempRoot)).toEqual({ content: '', sources: [], ignored: [] });

    await write('AGENTS.md', 'agents rule');
    expect((await loadProjectInstructions(tempRoot)).ignored).toEqual([]);
  });

  it('多份文件合并时附带优先级说明，单份时不附带', async () => {
    await write('AGENTS.md', 'only rule');
    expect((await loadProjectInstructions(tempRoot)).content).not.toContain('later (more specific) file wins');

    await fs.mkdir(path.join(tempRoot, '.git'));
    await write('sub/CLAUDE.md', 'sub rule');
    const merged = await loadProjectInstructions(path.join(tempRoot, 'sub'));
    expect(merged.sources).toEqual([
      path.join(tempRoot, 'AGENTS.md'),
      path.join(tempRoot, 'sub', 'CLAUDE.md'),
    ]);
    expect(merged.content.startsWith('Files are ordered from the repository root')).toBe(true);
  });

  it('空文件与缺失文件不产生内容，也不会自动创建模板', async () => {
    await write('AGENTS.md', '   \n');
    const loaded = await loadProjectInstructions(tempRoot);
    expect(loaded).toEqual({ content: '', sources: [], ignored: [] });
    await expect(fs.access(path.join(tempRoot, '.iceCoder'))).rejects.toThrow();
  });

  it('工作区不存在时返回空结果而不抛错', async () => {
    const loaded = await loadProjectInstructions(path.join(tempRoot, 'missing'));
    expect(loaded).toEqual({ content: '', sources: [], ignored: [] });
  });

  it('指纹随 AGENTS.md 新增与修改变化', async () => {
    const before = await projectInstructionsFingerprint(tempRoot);
    await write('AGENTS.md', 'one');
    const created = await projectInstructionsFingerprint(tempRoot);
    await write('AGENTS.md', 'a longer second value');
    const modified = await projectInstructionsFingerprint(tempRoot);
    expect(created).not.toBe(before);
    expect(modified).not.toBe(created);
  });

  it('候选路径包含逐级 AGENTS.md / CLAUDE.md 与旧版路径', async () => {
    await fs.mkdir(path.join(tempRoot, '.git'));
    const workspace = path.join(tempRoot, 'sub');
    await fs.mkdir(workspace);
    const candidates = await listProjectInstructionCandidates(workspace);
    expect(candidates).toEqual([
      path.join(tempRoot, 'AGENTS.md'),
      path.join(tempRoot, 'CLAUDE.md'),
      path.join(workspace, 'AGENTS.md'),
      path.join(workspace, 'CLAUDE.md'),
      path.join(workspace, '.iceCoder', 'memory.md'),
    ]);
  });
});
