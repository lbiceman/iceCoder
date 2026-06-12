import { describe, expect, it } from 'vitest';
import {
  formatGrepContentBlocks,
  parseRipgrepJsonMatches,
} from '../../src/tools/builtin/ripgrep-runner.js';

describe('ripgrep json parser', () => {
  it('parses match lines with Windows-style paths', () => {
    const stdout = [
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/tools/foo.ts' },
          lines: { text: 'export const x = 1;' },
          line_number: 10,
        },
      }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'C:/proj/bar.ts' },
          lines: { text: 'function main() {}' },
          line_number: 3,
        },
      }),
    ].join('\n');

    const blocks = parseRipgrepJsonMatches(stdout, 10);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].path).toBe('src/tools/foo.ts');
    expect(blocks[1].path).toBe('C:/proj/bar.ts');
    const formatted = formatGrepContentBlocks(blocks, 10);
    expect(formatted).toContain('src/tools/foo.ts:10');
    expect(formatted).toContain('C:/proj/bar.ts:3');
  });
});
