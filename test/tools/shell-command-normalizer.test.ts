import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  formatNormalizedCommandOutput,
  normalizeRunCommand,
} from '../../src/tools/builtin/shell-command-normalizer.js';

const workDir = 'D:\\work\\self\\iceCoder';

describe('normalizeRunCommand', () => {
  it('extracts quoted Windows cd prefix', () => {
    const raw = 'cd "E:\\test\\agentToolTest\\multi-file-order-pipeline-01" && npx vitest run 2>&1';
    const result = normalizeRunCommand(raw, { workDir });

    expect(result.command).toBe('npx vitest run 2>&1');
    expect(result.cwd).toBe(path.resolve('E:\\test\\agentToolTest\\multi-file-order-pipeline-01'));
    expect(result.fixes).toContain('removed quotes from cd path');
    expect(result.fixes).toContain('extracted cd → cwd=E:\\test\\agentToolTest\\multi-file-order-pipeline-01');
  });

  it('extracts unquoted cd prefix', () => {
    const raw = 'cd E:\\test\\proj && npm test';
    const result = normalizeRunCommand(raw, { workDir });

    expect(result.command).toBe('npm test');
    expect(result.cwd).toBe(path.resolve('E:\\test\\proj'));
    expect(result.fixes).toEqual(['extracted cd → cwd=E:\\test\\proj']);
  });

  it('extracts cd /d prefix', () => {
    const raw = 'cd /d D:\\proj && npm run build';
    const result = normalizeRunCommand(raw, { workDir });

    expect(result.command).toBe('npm run build');
    expect(result.cwd).toBe(path.resolve('D:\\proj'));
  });

  it('leaves commands without leading cd unchanged', () => {
    const raw = 'npm test';
    const result = normalizeRunCommand(raw, { workDir });

    expect(result).toEqual({ command: 'npm test', cwd: path.resolve(workDir), fixes: [] });
  });

  it('does not rewrite cd inside strings', () => {
    const raw = 'node -e "console.log(\'cd foo && bar\')"';
    const result = normalizeRunCommand(raw, { workDir });

    expect(result.command).toBe(raw);
    expect(result.cwd).toBe(path.resolve(workDir));
    expect(result.fixes).toEqual([]);
  });
});

describe('formatNormalizedCommandOutput', () => {
  it('prefixes auto-fix notes when fixes exist', () => {
    const output = formatNormalizedCommandOutput(['extracted cd → cwd=E:\\proj'], 'ok');
    expect(output).toBe('[auto-fix] extracted cd → cwd=E:\\proj\n\nok');
  });

  it('returns output unchanged when no fixes', () => {
    expect(formatNormalizedCommandOutput([], 'ok')).toBe('ok');
  });
});
