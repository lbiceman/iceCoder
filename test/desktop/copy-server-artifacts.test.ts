import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '../..');
const script = readFileSync(
  path.join(repoRoot, 'desktop/scripts/copy-server-artifacts.cjs'),
  'utf-8',
);
const publicJs = path.join(repoRoot, 'src/public/js');

describe('copy-server-artifacts 悬浮冰豆静态资源', () => {
  it('按 session-pet*.js 收集浮窗脚本，覆盖 harness 表情模块', () => {
    expect(script).toContain('collectPetStaticJsFiles');
    expect(script).toMatch(/session-pet.*\\.js/);
    const names = readdirSync(publicJs).filter((name) => /^session-pet.*\.js$/.test(name));
    expect(names).toContain('session-pet.js');
    expect(names).toContain('session-pet-palette.js');
    expect(names).toContain('session-pet-harness-expr.js');
  });

  it('session-pet 的相对 import 都是 session-pet*.js，能被复制 glob 覆盖', () => {
    const src = readFileSync(path.join(publicJs, 'session-pet.js'), 'utf-8');
    const imports = [...src.matchAll(/from ['"]\.\/([^'"]+\.js)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const file of imports) {
      expect(file).toMatch(/^session-pet.*\.js$/);
    }
  });
});
