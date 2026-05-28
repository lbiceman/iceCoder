/**
 * Web 聊天运行时预热：WS 连接后异步加载，避免首条用户消息承担冷启动。
 */

import type { AssembledPrompt } from '../prompts/types.js';
import { loadAssembledChatPrompt } from '../prompts/load-chat-prompt.js';

let assembledPromptPromise: Promise<AssembledPrompt> | null = null;

/** 进程内单例缓存 assembled prompt；失败后可重试。 */
export function getOrLoadAssembledChatPrompt(logPrefix = '[chat-ws]'): Promise<AssembledPrompt> {
  if (!assembledPromptPromise) {
    assembledPromptPromise = loadAssembledChatPrompt({ logPrefix }).catch((err) => {
      assembledPromptPromise = null;
      throw err;
    });
  }
  return assembledPromptPromise;
}

/** 测试专用：重置 prompt 缓存。 */
export function resetAssembledChatPromptCache(): void {
  assembledPromptPromise = null;
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
