import type { UnifiedMessage } from '../llm/types.js';
import { estimateMessagesTokens } from '../llm/token-estimator.js';
import { isAbortError } from '../llm/abort-error.js';
import type { LlmRoundLogMeta, LlmRoundTokenUsage } from './logger.js';

/** 工具调用阶段发往 UI 的一步提示文案（缓解长时间无 SSE 体感）。 */
export function toolExecutionUserHint(toolName: string): string {
  const hints: Record<string, string> = {
    read_file: '正在读取文件（大文件将自动截断）…',
    edit_file: '正在编辑文件, 请稍后...',
    glob: '正在按路径匹配文件…',
    grep: '正在搜索代码内容…',
    parse_document: '正在解析文档，较大文件可能较慢…',
    run_command: '正在执行命令…',
    fs_operation: '正在操作文件或目录…',
    fetch_url: '正在请求 URL…',
    web_search: '正在联网搜索…',
    git: '正在执行 git…',
    browse_directory: '正在浏览目录…',
    list_drives: '正在列出磁盘…',
    parse_pptx_deep: '正在深度解析 PPTX…',
    parse_xmind_deep: '正在解析 XMind…',
    image_read: '正在读取图片…',
  };
  return hints[toolName] ?? `正在执行「${toolName}」…`;
}

/** 构造 LLM 轮次日志字段（provider usage 分项 + 本地上下文估算）。 */
export function buildLlmRoundLogFields(
  messages: UnifiedMessage[],
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheMissTokens?: number;
  },
): { usage: LlmRoundTokenUsage; meta: LlmRoundLogMeta } {
  return {
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheMissTokens: usage?.cacheMissTokens,
    },
    meta: {
      messageCount: messages.length,
      estContextTokens: estimateMessagesTokens(messages),
    },
  };
}

/** 判断错误是否可重试（网络超时、限流、服务端错误） */
export function isRetryableError(error: unknown): boolean {
  // 用户主动中断不重试 — 否则 Stop 后还会等指数退避 sleep
  if (isAbortError(error)) return false;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // 网络错误（含 OpenAI / MiniMax 等流式 SDK 在 socket 断开时抛出的 "Connection error."）
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused')
      || msg.includes('econnaborted') || msg.includes('epipe') || msg.includes('etimedout')
      || msg.includes('enotfound') || msg.includes('socket hang up')
      || msg.includes('fetch failed') || msg.includes('network')
      || msg.includes('connection error') || msg.includes('connection reset')
      || msg.includes('connection closed') || msg.includes('connection aborted')) return true;
    // 限流
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) return true;
    // 服务端错误
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('overloaded')) return true;
  }
  return false;
}
