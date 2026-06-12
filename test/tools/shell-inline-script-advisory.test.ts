import { describe, expect, it } from 'vitest';
import { analyzeInlineScriptCommand } from '../../src/tools/shell-inline-script-advisory.js';

describe('analyzeInlineScriptCommand', () => {
  it('returns null for simple node -e', () => {
    expect(analyzeInlineScriptCommand('node -e "console.log(1)"')).toBeNull();
  });

  it('blocks complex node -e on Windows', () => {
    if (process.platform !== 'win32') return;

    const cmd = String.raw`node -e "const fs=require('fs'); console.log(fs.readdirSync('src'))"`;
    const result = analyzeInlineScriptCommand(cmd);
    expect(result?.block).toBe(true);
    expect(result?.message).toMatch(/scripts\//);
  });

  it('blocks very long one-line commands on Windows', () => {
    if (process.platform !== 'win32') return;

    const cmd = 'echo ' + 'x'.repeat(700);
    const result = analyzeInlineScriptCommand(cmd);
    expect(result?.block).toBe(true);
    expect(result?.message).toMatch(/scripts\//);
  });

  it('advises but does not block long node -e on non-Windows', () => {
    if (process.platform === 'win32') return;

    const payload = 'console.log(' + "'".repeat(200) + ')';
    const cmd = `node -e "${payload}"`;
    const result = analyzeInlineScriptCommand(cmd);
    expect(result?.block).toBe(false);
    expect(result?.message).toMatch(/advisory/i);
  });
});
