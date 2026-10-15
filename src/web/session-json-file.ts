/**
 * 会话 JSON 的读与原子写。
 * 同一路径上的读改写串行执行。文件损坏时不把空数组写回去。
 */

import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';

export type JsonArrayFileState =
  | { status: 'missing' }
  | { status: 'ok'; value: unknown[] }
  | { status: 'corrupt' };

const writeTails = new Map<string, Promise<void>>();

let beforeReadForTests: (() => Promise<void>) | null = null;

/** 测试用：读文件之前插入等待，用来制造并发交错。 */
export function setJsonArrayFileBeforeReadForTests(hook: (() => Promise<void>) | null): void {
  beforeReadForTests = hook;
}

export function enqueueFileWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = writeTails.get(filePath) ?? Promise.resolve();
  const run = previous.then(task, task);
  writeTails.set(filePath, run.then(() => undefined, () => undefined));
  return run;
}

export async function readJsonArrayFile(filePath: string): Promise<JsonArrayFileState> {
  if (beforeReadForTests) await beforeReadForTests();
  let data: string;
  try {
    data = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw err;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) return { status: 'corrupt' };
    return { status: 'ok', value: parsed };
  } catch {
    return { status: 'corrupt' };
  }
}

/**
 * 把数组写成完整 JSON。空数组遇到已损坏的文件时保留原文件，除非调用方明确要求替换。
 */
export async function writeJsonArrayAtomic(
  filePath: string,
  value: unknown[],
  options?: { replaceCorrupt?: boolean },
): Promise<'written' | 'skipped-corrupt'> {
  if (value.length === 0 && !options?.replaceCorrupt) {
    const existing = await readJsonArrayFile(filePath);
    if (existing.status === 'corrupt') return 'skipped-corrupt';
  }
  await writeFileAtomic(filePath, JSON.stringify(value));
  return 'written';
}
