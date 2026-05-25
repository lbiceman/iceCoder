import { describe, expect, it } from 'vitest';

import {
  extractRunCommandsFromDelegateTask,
  VerificationOutputBuffer,
} from '../../src/harness/verification-output-buffer.js';
import { findLastFailedVerification } from '../../src/harness/rebuild-escalation.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('verification-output-buffer', () => {
  it('records and retrieves recent failed verification output', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed(
      'npm run build 2>&1',
      '工具执行错误: Command failed (exit code: 1)\n\nsrc/foo.ts(1,1): error TS2304: Cannot find name \'Phaser\'',
    );

    const entry = buffer.findLastFailed('npm run build 2>&1');
    expect(entry?.outputBody).toMatch(/error TS2304/);
  });

  it('findLastFailedVerification falls back to buffer when chat only has BranchBudget block', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed(
      'npm run build 2>&1',
      '工具执行错误: exit 1\n\nsrc/scenes/MapSelectScene.ts(10,1): error TS1005',
    );

    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'run_command', arguments: { command: 'npm run build 2>&1' } }],
      },
      {
        role: 'tool',
        toolCallId: 'tc1',
        content: '[BranchBudget / Blocked] 工具未执行：该命令已失败 2 次（拦截阈值 2）。',
      },
    ];

    const found = findLastFailedVerification(messages, buffer);
    expect(found?.command).toBe('npm run build 2>&1');
    expect(found?.outputBody).toMatch(/error TS1005/);
  });

  it('extractRunCommandsFromDelegateTask finds build commands in task text', () => {
    const commands = extractRunCommandsFromDelegateTask(
      'Run npm run build 2>&1 then npm run test:e2e',
    );
    expect(commands.some(c => /npm run build/.test(c))).toBe(true);
  });

  it('snapshot and restore roundtrip preserves failed verification tail', () => {
    const buffer = new VerificationOutputBuffer();
    buffer.recordFailed('npm run build 2>&1', '工具执行错误: exit 1\n\nerror TS2304');
    buffer.recordFailed('npm run test:e2e', '工具执行错误: exit 1\n\ne2e failed');

    const snapshot = buffer.snapshot();
    const restored = new VerificationOutputBuffer();
    restored.restore(snapshot);

    expect(restored.findLastFailed('npm run test:e2e')?.outputBody).toMatch(/e2e failed/);
    expect(restored.findLastFailed('npm run build 2>&1')?.outputBody).toMatch(/error TS2304/);
  });
});
