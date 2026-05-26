import { describe, expect, it } from 'vitest';
import { normalizeToolArguments } from '../../src/tools/tool-arguments-normalizer.js';

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

  it('unwraps raw JSON string with command for run_command', () => {
    const inner = { command: 'npm test', timeout: 60_000 };
    const args = { raw: JSON.stringify(inner) };

    expect(normalizeToolArguments(args)).toEqual(inner);
  });

  it('does not unwrap when raw is not the only key', () => {
    const args = {
      raw: JSON.stringify({ path: 'a.ts', content: 'x' }),
      path: 'fallback.ts',
    };

    expect(normalizeToolArguments(args)).toEqual(args);
  });

  it('does not unwrap when raw is not a string', () => {
    const args = { raw: { path: 'a.ts' }, content: 'x' };
    expect(normalizeToolArguments(args)).toEqual(args);
  });

  it('keeps truncated raw JSON unchanged when inner parse fails', () => {
    const args = { raw: '{"path":"a.ts","content":"unclosed' };
    expect(normalizeToolArguments(args)).toEqual(args);
  });

  it('handles empty or invalid input', () => {
    expect(normalizeToolArguments(null as unknown as Record<string, unknown>)).toEqual({});
    expect(normalizeToolArguments(undefined as unknown as Record<string, unknown>)).toEqual({});
    expect(normalizeToolArguments([] as unknown as Record<string, unknown>)).toEqual({});
  });
});
