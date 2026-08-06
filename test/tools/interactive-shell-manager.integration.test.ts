/**
 * InteractiveShellManager 真实 PTY 集成测试（任务 1.5）
 *
 * 依赖 node-pty 真实 spawn；CI Windows 无控制台时 skip（需求 §12 Phase 1）。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InteractiveShellManager,
  getInteractiveShellManagerFor,
  __resetInteractiveShellManagers,
} from '../../src/tools/interactive-shell-manager.js';

const isCiWindows = process.env.CI === 'true' && process.platform === 'win32';

afterEach(() => {
  __resetInteractiveShellManagers();
});

describe.skipIf(isCiWindows)('InteractiveShellManager — integration (real pty)', () => {
  describe('start / stop lifecycle', () => {
    it('真实 PTY start 后 getActiveTask 可用', async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-int-start-'));
      const mgr = getInteractiveShellManagerFor('sess-ish-int', workDir);

      const result = mgr.start({ label: 'integration shell' });
      expect(result.error).toBeUndefined();
      expect(result.taskId).toMatch(/^ish_/);

      await new Promise((r) => setTimeout(r, 300));
      expect(mgr.getActiveTask()?.status).toBe('running');

      mgr.stop(result.taskId);
      expect(mgr.getTask(result.taskId)?.status).toBe('killed');
    }, 15_000);
  });

  describe('read / cursor (real output)', () => {
    let workDir: string;
    let mgr: InteractiveShellManager;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'ice-ish-int-read-'));
      mgr = new InteractiveShellManager(workDir, 'ish-int-read');
    });

    afterEach(() => {
      mgr.dispose();
    });

    async function waitForReadOutput(taskId: string, pattern: RegExp, since = 0): Promise<void> {
      await expect.poll(
        () => mgr.read(taskId, since)?.output ?? '',
        { timeout: 12_000, interval: 50 },
      ).toMatch(pattern);
    }

    it('node 脚本输出可被 read 增量读取', async () => {
      writeFileSync(
        join(workDir, 'printer.cjs'),
        'for (let i = 1; i <= 5; i++) console.log("line " + i);\n',
        'utf-8',
      );
      const { taskId } = mgr.start({ command: 'node printer.cjs' });
      expect(taskId).toBeTruthy();

      await waitForReadOutput(taskId, /line 5/);

      const result = mgr.read(taskId, 0);
      expect(result!.output).toMatch(/line 1/);
      expect(result!.output).toMatch(/line 5/);
      expect(result!.cursor).toBeGreaterThan(0);

      mgr.stop(taskId);
    }, 15_000);

    it('since=cursor 无新输出', async () => {
      writeFileSync(
        join(workDir, 'printer2.cjs'),
        'for (let i = 1; i <= 3; i++) console.log("line " + i);\n',
        'utf-8',
      );
      const { taskId } = mgr.start({ command: 'node printer2.cjs' });
      await waitForReadOutput(taskId, /line 3/);

      const first = mgr.read(taskId, 0);
      const second = mgr.read(taskId, first!.cursor);
      expect(second!.output).toBe('');
      expect(second!.cursor).toBe(first!.cursor);

      mgr.stop(taskId);
    }, 15_000);
  });
});
