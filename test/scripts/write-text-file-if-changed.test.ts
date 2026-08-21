import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { writeTextFileIfChanged } = require('../../scripts/write-text-file-if-changed.cjs') as {
  writeTextFileIfChanged: (target: string, body: string) => boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('writeTextFileIfChanged', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmpFile(name: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ice-write-if-changed-'));
    dirs.push(dir);
    return path.join(dir, name);
  }

  it('内容相同则不写回', () => {
    const file = tmpFile('a.ts');
    writeFileSync(file, 'export const x = 1;\n', 'utf8');
    const wrote = writeTextFileIfChanged(file, 'export const x = 1;\n');
    expect(wrote).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('export const x = 1;\n');
  });

  it('内容不同则写入', () => {
    const file = tmpFile('b.ts');
    writeFileSync(file, 'old\n', 'utf8');
    const wrote = writeTextFileIfChanged(file, 'new\n');
    expect(wrote).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('new\n');
  });
});

describe('tunnel-pack-entry', () => {
  it('内容已是 stub 时脚本可重复执行', () => {
    const script = readFileSync(
      path.join(__dirname, '../../scripts/tunnel-pack-entry.cjs'),
      'utf-8',
    );
    expect(script).toContain('writeTextFileIfChanged');
    expect(script).toContain("export * from './tunnel-stubs/quicktunnel-url.js';");
  });
});
