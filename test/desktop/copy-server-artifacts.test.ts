import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicJs = path.join(__dirname, '../../src/public/js');

describe('会话冰豆脚本依赖', () => {
  it('session-pet 的相对 import 都是 session-pet*.js', () => {
    const src = readFileSync(path.join(publicJs, 'session-pet.js'), 'utf-8');
    const imports = [...src.matchAll(/from ['"]\.\/([^'"]+\.js)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const file of imports) {
      expect(file).toMatch(/^session-pet.*\.js$/);
    }
  });
});
