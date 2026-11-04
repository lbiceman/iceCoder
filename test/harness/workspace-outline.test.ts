import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
import { appendWorkspaceOutlineOnce } from '../../src/harness/workspace-outline.js';

describe('workspace outline', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('appends one frozen outline and leaves history unchanged the second time', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ice-outline-'));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"name":"demo"}\n', 'utf8');
    await writeFile(path.join(dir, 'src', 'a.ts'), 'export const n = 1;\n', 'utf8');

    const messages: UnifiedMessage[] = [{ role: 'user', content: 'fix the bug' }];
    expect(await appendWorkspaceOutlineOnce(messages, dir)).toBe(true);
    expect(messages[0].content).toBe('fix the bug');
    const outline = String(messages[1].content);
    expect(outline.startsWith('<system-reminder>')).toBe(true);
    expect(outline).toContain('[Workspace Outline]');
    expect(outline).toContain('package.json');
    expect(outline).toContain('src/a.ts');
    expect(messages[1].preserveOnCompaction).toBe(true);

    expect(await appendWorkspaceOutlineOnce(messages, dir)).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe(outline);
  });
});
