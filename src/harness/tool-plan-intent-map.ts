import type { TaskIntent } from '../types/runtime-snapshot.js';

/**
 * 意图 → 建议下一轮优先使用的工具名（与内置注册工具对齐）。
 * 可按任务类型扩展；映射表与 tool-planner 解耦便于审阅与调整。
 */
export const INTENT_TOOL_SUGGESTIONS: Record<TaskIntent, readonly string[]> = {
  debug: ['read_file', 'run_command', 'grep'],
  edit: ['read_file', 'edit_file', 'run_command'],
  test: ['run_command', 'read_file', 'grep'],
  refactor: ['glob', 'grep', 'read_file', 'edit_file'],
  inspect: ['glob', 'grep', 'read_file', 'file_info'],
  docs: ['read_file', 'glob', 'grep', 'edit_file'],
  question: ['glob', 'grep', 'read_file'],
};
