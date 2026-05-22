import { describe, expect, it } from 'vitest';

import { inferTaskDomain } from '../../src/harness/task-domain.js';

describe('inferTaskDomain', () => {
  it('maps executable intents to critical_* domains', () => {
    expect(inferTaskDomain('edit')).toBe('critical_edit');
    expect(inferTaskDomain('debug')).toBe('critical_debug');
    expect(inferTaskDomain('test')).toBe('critical_test');
    expect(inferTaskDomain('refactor')).toBe('critical_refactor');
  });

  it('maps read-only intents to non-critical domains', () => {
    expect(inferTaskDomain('inspect')).toBe('non_critical_read');
    expect(inferTaskDomain('question')).toBe('non_critical_explain');
    expect(inferTaskDomain('docs')).toBe('non_critical_docs');
  });
});
