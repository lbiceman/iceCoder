import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskQueueManager, resetTaskQueueManagerForTests } from '../../src/session/task-queue.js';

describe('TaskQueueManager', () => {
  let tempDir: string;
  let manager: TaskQueueManager;

  beforeEach(async () => {
    resetTaskQueueManagerForTests();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-queue-'));
    manager = new TaskQueueManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('enqueue ×3 preserves FIFO order with stable ids', async () => {
    await manager.enqueue('s1', { text: 'A', source: 'implicit' });
    await manager.enqueue('s1', { text: 'B', source: 'explicit' });
    await manager.enqueue('s1', { text: 'C', source: 'implicit' });

    const items = await manager.list('s1');
    expect(items.map((item) => item.text)).toEqual(['A', 'B', 'C']);
    expect(items.every((item) => typeof item.id === 'string' && item.id.length > 0)).toBe(true);
  });

  it('dequeue returns head and shortens queue', async () => {
    await manager.enqueue('s1', { text: 'A', source: 'implicit' });
    await manager.enqueue('s1', { text: 'B', source: 'implicit' });

    const first = await manager.dequeue('s1');
    expect(first?.text).toBe('A');

    const remaining = await manager.list('s1');
    expect(remaining.map((item) => item.text)).toEqual(['B']);
  });

  it('removeById removes only the requested item', async () => {
    const a = await manager.enqueue('s1', { text: 'A', source: 'implicit' });
    await manager.enqueue('s1', { text: 'B', source: 'implicit' });

    const removed = await manager.removeById('s1', a.id);
    expect(removed?.text).toBe('A');
    expect(await manager.list('s1')).toEqual([
      expect.objectContaining({ text: 'B' }),
    ]);
    expect(await manager.removeById('s1', 'missing')).toBeUndefined();
  });

  it('insertAt inserts at original index and clamps out-of-range', async () => {
    await manager.enqueue('s1', { text: 'A', source: 'implicit' });
    await manager.enqueue('s1', { text: 'C', source: 'implicit' });

    await manager.insertAt('s1', 1, { text: 'B', source: 'implicit' });
    expect((await manager.list('s1')).map((item) => item.text)).toEqual(['A', 'B', 'C']);

    await manager.insertAt('s1', 99, { text: 'D', source: 'explicit' });
    expect((await manager.list('s1')).map((item) => item.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('persists queue to disk and restores in a new manager instance', async () => {
    await manager.enqueue('s1', { text: 'persist me', source: 'implicit', messageId: 'm1' });

    const file = path.join(tempDir, 's1.task-queue.json');
    const raw = await fs.readFile(file, 'utf-8');
    expect(JSON.parse(raw)).toEqual([
      expect.objectContaining({ text: 'persist me', messageId: 'm1', source: 'implicit' }),
    ]);

    const restored = new TaskQueueManager(tempDir);
    expect((await restored.list('s1')).map((item) => item.text)).toEqual(['persist me']);
  });

  it('starts from empty queue when file does not exist', async () => {
    expect(await manager.list('new-session')).toEqual([]);
  });

  it('clearSession removes memory and disk state', async () => {
    await manager.enqueue('s1', { text: 'A', source: 'implicit' });
    await manager.clearSession('s1');
    expect(await manager.list('s1')).toEqual([]);
    await expect(fs.access(path.join(tempDir, 's1.task-queue.json'))).rejects.toThrow();
  });
});
