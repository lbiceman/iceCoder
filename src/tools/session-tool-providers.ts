/**
 * 会话级工具提供者：依赖运行时服务（如 Web 端定时任务）的工具不进 initializeToolSystem，
 * 由宿主在启动时注册提供者，每轮重建会话 ToolSystem 时按 sessionId 生成并合并进 registry。
 *
 * 未注册任何提供者时（CLI chat / run）不产生工具。
 */

import type { RegisteredTool } from './types.js';

export interface SessionToolProviderContext {
  sessionId: string;
}

export type SessionToolProvider = (
  ctx: SessionToolProviderContext,
) => RegisteredTool[] | Promise<RegisteredTool[]>;

const providers = new Set<SessionToolProvider>();

/** 返回注销函数。 */
export function registerSessionToolProvider(provider: SessionToolProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/** 单个提供者失败只跳过它的工具，不影响本轮其它工具。 */
export async function collectSessionProvidedTools(ctx: SessionToolProviderContext): Promise<RegisteredTool[]> {
  const out: RegisteredTool[] = [];
  for (const provider of providers) {
    try {
      out.push(...(await provider(ctx)));
    } catch (err) {
      console.warn('[tools] 会话工具提供者出错，本轮跳过:', err);
    }
  }
  return out;
}
