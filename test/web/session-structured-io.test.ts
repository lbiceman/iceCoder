/**
 * 多会话 .structured.json 读写与同步刷盘辅助
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  structuredSessionPath,
  writeStructuredMessagesFile,
  readStructuredMessagesFile,
  flushStructuredSessionToDisk,
} from '../../src/web/session-structured-io.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('session-structured-io', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'structured-io-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes and reads structured messages for a session id', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    await writeStructuredMessagesFile(tempDir, 'sess-a', messages);
    const file = structuredSessionPath(tempDir, 'sess-a');
    const raw = await fs.readFile(file, 'utf-8');
    expect(JSON.parse(raw)).toHaveLength(2);

    const loaded = await readStructuredMessagesFile(tempDir, 'sess-a');
    expect(loaded).toEqual(messages);
  });

  it('isolates different session files', async () => {
    await writeStructuredMessagesFile(tempDir, 'one', [{ role: 'user', content: '1' }]);
    await writeStructuredMessagesFile(tempDir, 'two', [{ role: 'user', content: '2' }]);
    const a = await readStructuredMessagesFile(tempDir, 'one');
    const b = await readStructuredMessagesFile(tempDir, 'two');
    expect(a?.[0]?.content).toBe('1');
    expect(b?.[0]?.content).toBe('2');
  });

  it('returns undefined for missing or empty structured file', async () => {
    expect(await readStructuredMessagesFile(tempDir, 'missing')).toBeUndefined();
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(structuredSessionPath(tempDir, 'empty'), '[]', 'utf-8');
    expect(await readStructuredMessagesFile(tempDir, 'empty')).toBeUndefined();
  });

  it('flushStructuredSessionToDisk writes immediately and invokes cancelPendingTimer', async () => {
    let timerCancelled = false;
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'flush-now' }];
    await flushStructuredSessionToDisk(tempDir, 'flush-sess', messages, () => {
      timerCancelled = true;
    });
    expect(timerCancelled).toBe(true);
    const loaded = await readStructuredMessagesFile(tempDir, 'flush-sess');
    expect(loaded?.[0]?.content).toBe('flush-now');
  });
});
