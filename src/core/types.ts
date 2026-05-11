/**
 * iceCoder 核心类型定义（LLM 抽象等）。
 */

/**
 * LLMAdapter 的前向引用接口，用于避免循环依赖。
 * 完整实现位于 src/llm/llm-adapter.ts。
 */
export interface LLMAdapter {
  chat(messages: any[], options?: any): Promise<any>;
  stream(messages: any[], callback: (chunk: string, done: boolean) => void, options?: any): Promise<any>;
  setAbortSignal?(signal: AbortSignal | null): void;
}
