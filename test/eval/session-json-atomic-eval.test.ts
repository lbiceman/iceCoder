/**
 * 会话 JSON 落盘 eval：坏文件不能被覆盖，并发追加不能丢消息，空的结构化写入不能清掉损坏文件。
 * 不打外部 API。完整会话流里的同名 case 在 session-flow-eval 中再跑一遍。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendMessagesAtPath } from '../../src/web/chat-ws-persist.js';
import { setJsonArrayFileBeforeReadForTests } from '../../src/web/session-json-file.js';
import {
  readStructuredMessagesFile,
  structuredSessionPath,
  writeStructuredMessagesFile,
} from '../../src/web/session-structured-io.js';

describe('eval: session json atomic persist', () => {
  let dir: string;

  afterEach(async () => {
    setJsonArrayFileBeforeReadForTests(null);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps a torn UI transcript and still stores two concurrent appends on a healthy file', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-json-eval-'));
    const tornFile = path.join(dir, 'torn.json');
    const torn = '[{"role":"user","id":"u1","content":"keep-me"}';
    await fs.writeFile(tornFile, torn, 'utf-8');
    await expect(appendMessagesAtPath(tornFile, [{ role: 'user', id: 'u2', content: 'new' }])).resolves.toBe(false);
    expect(await fs.readFile(tornFile, 'utf-8')).toBe(torn);

    const healthy = path.join(dir, 'healthy.json');
    setJsonArrayFileBeforeReadForTests(() => new Promise((resolve) => setTimeout(resolve, 20)));
    const [first, second] = await Promise.all([
      appendMessagesAtPath(healthy, [{ role: 'user', id: 'a', content: 'one' }]),
      appendMessagesAtPath(healthy, [{ role: 'user', id: 'b', content: 'two' }]),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    const saved = JSON.parse(await fs.readFile(healthy, 'utf-8')) as Array<{ id: string }>;
    expect(saved.map((item) => item.id).sort()).toEqual(['a', 'b']);
  });

  it('leaves a corrupt structured file in place until an explicit clear', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-structured-eval-'));
    const sessionId = 'torn';
    const file = structuredSessionPath(dir, sessionId);
    const torn = '[{"role":"user","content":"history"';
    await fs.writeFile(file, torn, 'utf-8');
    await writeStructuredMessagesFile(dir, sessionId, []);
    expect(await fs.readFile(file, 'utf-8')).toBe(torn);
    expect(await readStructuredMessagesFile(dir, sessionId)).toBeUndefined();
    await writeStructuredMessagesFile(dir, sessionId, [{ role: 'user', content: 'resumed' }]);
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual([{ role: 'user', content: 'resumed' }]);
  });
});
