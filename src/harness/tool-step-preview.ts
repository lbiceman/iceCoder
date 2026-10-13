/**
 * WebSocket step 事件中的 toolOutput 预览长度。
 * UI diff 需要比默认 500 字更长的 output；LLM 上下文仍走 messages 完整截断逻辑。
 */

import { looksLikeUnifiedDiffText } from '../web/tool-display-extract.js';

export const STEP_OUTPUT_PREVIEW_DEFAULT = 500;
export const STEP_OUTPUT_PREVIEW_DIFF = 32_768;
/** 结果用于 UI 展开查看（web_search / fetch_url），比默认预览更长但仍受限 */
export const STEP_OUTPUT_PREVIEW_RESULT = 16_384;

const DIFF_CAPABLE_TOOLS = new Set([
  'run_command',
  'git',
  'diff_files',
  'patch_file',
  'write_file',
  'append_file',
  'edit_file',
  'batch_edit_file',
]);

/** 结果正文用于 UI 展开查看的工具（点击工具名看搜到的内容/提取结果） */
const RESULT_PREVIEW_TOOLS = new Set([
  'web_search',
  'fetch_url',
]);

/** 供 onStep tool_result 的 toolOutput 字段使用 */
export function stepToolOutputPreview(toolName: string, output: string): string {
  const limit = DIFF_CAPABLE_TOOLS.has(toolName) || looksLikeUnifiedDiffText(output)
    ? STEP_OUTPUT_PREVIEW_DIFF
    : (RESULT_PREVIEW_TOOLS.has(toolName) ? STEP_OUTPUT_PREVIEW_RESULT : STEP_OUTPUT_PREVIEW_DEFAULT);
  if (output.length <= limit) return output;
  return `${output.substring(0, limit)}\n…[UI preview truncated, ${output.length} chars total]`;
}
