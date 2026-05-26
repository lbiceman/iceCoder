import { describe, expect, it } from 'vitest';
import {
  buildWrappedArgumentFormatHint,
  isUnexpandedStringWrapper,
  normalizeToolArguments,
} from '../../src/tools/tool-arguments-normalizer.js';

describe('normalizeToolArguments', () => {
  it('passes through standard write_file args unchanged', () => {
    const args = {
      path: 'src/game/scenes/GameOverScene.ts',
      content: "import Phaser from 'phaser';",
    };
    expect(normalizeToolArguments(args)).toEqual(args);
  });

  it('unwraps raw JSON string with path and content', () => {
    const inner = {
      path: 'E:\\test\\proj\\GameScene.ts',
      content: "import Phaser from 'phaser';\n",
    };
    const args = { raw: JSON.stringify(inner) };

    expect(normalizeToolArguments(args)).toEqual(inner);
  });

  it('unwraps arguments/input wrapper keys generically', () => {
    const inner = { path: 'a.ts', content: 'x' };
    expect(normalizeToolArguments({ arguments: JSON.stringify(inner) })).toEqual(inner);
    expect(normalizeToolArguments({ input: JSON.stringify({ command: 'npm test' }) })).toEqual({ command: 'npm test' });
  });

  it('applies filePath and cmd aliases after unwrap', () => {
    expect(normalizeToolArguments({
      raw: JSON.stringify({ filePath: 'a.ts', content: 'x' }),
    })).toEqual({ filePath: 'a.ts', content: 'x', path: 'a.ts' });

    expect(normalizeToolArguments({
      input: JSON.stringify({ cmd: 'npm test' }),
    })).toEqual({ cmd: 'npm test', command: 'npm test' });
  });

  it('does not unwrap when wrapper is not the only key', () => {
    const args = {
      raw: JSON.stringify({ path: 'a.ts', content: 'x' }),
      path: 'fallback.ts',
    };

    expect(normalizeToolArguments(args)).toEqual({
      ...args,
      path: 'fallback.ts',
    });
  });

  it('keeps truncated wrapper JSON unchanged when inner parse fails', () => {
    const args = { raw: '{"path":"a.ts","content":"unclosed' };
    expect(normalizeToolArguments(args)).toEqual(args);
    expect(isUnexpandedStringWrapper(args)).toBe(true);
  });

  it('handles empty or invalid input', () => {
    expect(normalizeToolArguments(null as unknown as Record<string, unknown>)).toEqual({});
    expect(normalizeToolArguments(undefined as unknown as Record<string, unknown>)).toEqual({});
    expect(normalizeToolArguments([] as unknown as Record<string, unknown>)).toEqual({});
  });

  it('buildWrappedArgumentFormatHint is provider-neutral', () => {
    expect(buildWrappedArgumentFormatHint()).toMatch(/top-level JSON fields/);
    expect(buildWrappedArgumentFormatHint()).not.toMatch(/minimax/i);
  });
});
