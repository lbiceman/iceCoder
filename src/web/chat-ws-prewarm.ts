/**
 * Web 聊天运行时预热：WS 连接后异步加载，避免首条用户消息承担冷启动。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AssembledPrompt } from '../prompts/types.js';
import { loadAssembledChatPrompt } from '../prompts/load-chat-prompt.js';

let assembledPromptPromise: Promise<AssembledPrompt> | null = null;
let assembledPromptFingerprint: string | null = null;

async function fileFingerprint(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * 只跟踪动态 overlay 与显式自定义 system 的输入。
 * 普通会话中指纹不变，静态 system 保持字节稳定，避免损害 provider 前缀缓存。
 */
async function resolvePromptInputFingerprint(): Promise<string> {
  const memoryPath = path.resolve('.iceCoder', 'memory.md');
  const customPath = process.env.ICE_SYSTEM_PROMPT_PATH
    ? path.resolve(process.env.ICE_SYSTEM_PROMPT_PATH)
    : '';
  const [memory, custom] = await Promise.all([
    fileFingerprint(memoryPath),
    customPath ? fileFingerprint(customPath) : Promise.resolve('none'),
  ]);
  return [
    new Date().toISOString().slice(0, 10),
    process.env.ICE_EVAL_MODE ?? '',
    process.env.ICE_DISABLE_TOOLS ?? '',
    memory,
    customPath,
    custom,
  ].join('|');
}

/** 输入未变化时复用；memory/date/custom 变化时重载动态 overlay。 */
export async function getOrLoadAssembledChatPrompt(logPrefix = '[chat-ws]'): Promise<AssembledPrompt> {
  const fingerprint = await resolvePromptInputFingerprint();
  if (assembledPromptPromise && assembledPromptFingerprint === fingerprint) {
    return assembledPromptPromise;
  }

  assembledPromptFingerprint = fingerprint;
  const pending = loadAssembledChatPrompt({ logPrefix });
  assembledPromptPromise = pending;
  try {
    return await pending;
  } catch (err) {
    if (assembledPromptPromise === pending) {
      assembledPromptPromise = null;
      assembledPromptFingerprint = null;
    }
    throw err;
  }
}

/** 测试专用：重置 prompt 缓存。 */
export function resetAssembledChatPromptCache(): void {
  assembledPromptPromise = null;
  assembledPromptFingerprint = null;
}

export interface ChatRuntimePrewarmHooks {
  ensureMemoryInitialized: () => Promise<void>;
  getSupervisorRuntime: () => Promise<unknown>;
  loadAssembledPrompt: () => Promise<AssembledPrompt>;
}

/**  fire-and-forget：记忆 / Supervisor / 提示词并行预热。 */
export function prewarmChatRuntime(hooks: ChatRuntimePrewarmHooks): void {
  void hooks.ensureMemoryInitialized().catch(() => {});
  void hooks.getSupervisorRuntime().catch(() => {});
  void hooks.loadAssembledPrompt().catch(() => {});
}
