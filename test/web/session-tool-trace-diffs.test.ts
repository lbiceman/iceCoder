import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAddedFileUnifiedDiff,
  collectWorkspaceRoots,
  persistToolTraceDiff,
  readToolTraceDiffIndex,
  resolveToolDiffForSession,
} from '../../src/web/session-tool-trace-diffs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('session-tool-trace-diffs', () => {
  it('buildAddedFileUnifiedDiff formats new file diff', () => {
    const diff = buildAddedFileUnifiedDiff('src/a.ts', 'line1\nline2');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ src/a.ts');
    expect(diff).toContain('+line1');
  });

  it('persist and read tool trace diff index', async () => {
    const dir = path.join(__dirname, '../tmp-tool-diffs');
    await fs.mkdir(dir, { recursive: true });
    const sessionId = 'test-diff-idx';
    await persistToolTraceDiff(dir, sessionId, 'call_1', '--- a\n+++ b\n@@\n+x');
    const index = await readToolTraceDiffIndex(dir, sessionId);
    expect(index.call_1).toContain('+x');
  });

  it('collectWorkspaceRoots infers root from fs_operation when workspace.json missing', async () => {
    const dir = path.join(__dirname, '../tmp-tool-diffs-fsop');
    const sessionId = 'fsop1';
    const root = path.join(dir, 'workspace');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${sessionId}.json`),
      JSON.stringify([
        {
          role: 'tool_trace',
          parentId: 'a1',
          toolName: 'fs_operation',
          detail: root,
          status: 'success',
        },
      ]),
      'utf-8',
    );
    const roots = await collectWorkspaceRoots(dir, sessionId, path.join(dir, 'wrong-cwd'));
    expect(roots).toContain(path.resolve(root));
  });

  it('resolveToolDiffForSession reads workspace file for write_file path', async () => {
    const dir = path.join(__dirname, '../tmp-tool-diffs-ws');
    const sessionId = 'ws1';
    const root = path.join(dir, 'workspace');
    const rel = 'proj/hello.txt';
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), 'hello\n', 'utf-8');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${sessionId}.workspace.json`),
      JSON.stringify({ lockedRoot: root }),
      'utf-8',
    );
    const diff = await resolveToolDiffForSession({
      sessionsDir: dir,
      sessionId,
      defaultWorkDir: root,
      relPath: rel,
      toolName: 'write_file',
    });
    expect(diff).toContain('+hello');
  });
});
