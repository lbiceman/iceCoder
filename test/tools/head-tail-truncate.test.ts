import { describe, expect, it } from 'vitest';
import { HeadTailCharBuffer, truncateHeadTail } from '../../src/tools/head-tail-truncate.js';

describe('truncateHeadTail', () => {
  it('returns short text unchanged', () => {
    expect(truncateHeadTail('hello', 100)).toBe('hello');
  });

  it('keeps head and tail so errors at the end survive', () => {
    const text = `HEAD-START${'x'.repeat(8000)}TAIL-ERROR-STACK`;
    const out = truncateHeadTail(text, 200, { headRatio: 0.2 });
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('HEAD-START');
    expect(out).toContain('TAIL-ERROR-STACK');
    expect(out).toContain('omitted from middle');
  });

  it('appends spill path when provided', () => {
    const text = 'A'.repeat(5000);
    const out = truncateHeadTail(text, 200, { spillPath: 'C:\\\\logs\\\\fail.log' });
    expect(out).toContain('Full output saved to:');
    expect(out).toContain('fail.log');
  });
});

describe('HeadTailCharBuffer', () => {
  it('keeps the tail after overflowing the cap', () => {
    const buf = new HeadTailCharBuffer(100, 0.25);
    buf.push('HEAD');
    buf.push('m'.repeat(200));
    buf.push('TAIL-END');
    const out = buf.toString();
    expect(buf.truncated).toBe(true);
    expect(out).toContain('HEAD');
    expect(out).toContain('TAIL-END');
    expect(out).toContain('omitted from middle');
  });

  it('returns the full stream when under cap', () => {
    const buf = new HeadTailCharBuffer(1000);
    buf.push('abc');
    buf.push('def');
    expect(buf.truncated).toBe(false);
    expect(buf.toString()).toBe('abcdef');
  });
});
