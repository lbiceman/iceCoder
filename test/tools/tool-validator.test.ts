import { describe, expect, it } from 'vitest';

import { ToolValidator, createDefaultValidationRules } from '../../src/tools/tool-validator.js';

function validatorWithDefaults(): ToolValidator {
  const validator = new ToolValidator();
  for (const rule of createDefaultValidationRules()) {
    validator.addGlobalRule(rule);
  }
  return validator;
}

describe('createDefaultValidationRules — run_command', () => {
  const validator = validatorWithDefaults();

  it('allows action:"check" without command', () => {
    const result = validator.validate({
      id: '1',
      name: 'run_command',
      arguments: { action: 'check', task_id: 'bg_abc123' },
    });
    expect(result.valid).toBe(true);
  });

  it('allows action:"list" without command', () => {
    const result = validator.validate({
      id: '2',
      name: 'run_command',
      arguments: { action: 'list' },
    });
    expect(result.valid).toBe(true);
  });

  it('allows action:"stop" without command', () => {
    const result = validator.validate({
      id: '3',
      name: 'run_command',
      arguments: { action: 'stop', task_id: 'bg_abc123' },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects missing command when no management action', () => {
    const result = validator.validate({
      id: '4',
      name: 'run_command',
      arguments: {},
    });
    expect(result.valid).toBe(false);
    expect(result.message).toBe('命令不能为空');
  });

  it('accepts cmd alias for command', () => {
    const result = validator.validate({
      id: '5',
      name: 'run_command',
      arguments: { cmd: 'npm test' },
    });
    expect(result.valid).toBe(true);
  });
});
