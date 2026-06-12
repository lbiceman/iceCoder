const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'patch_file',
  'batch_edit_file',
]);

/** 从 write/edit 类工具参数中提取目标文件路径。 */
export function extractToolTargetPath(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!FILE_WRITE_TOOLS.has(toolName)) return undefined;
  const raw = args.path ?? args.file_path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** 从 run_command 参数中提取命令字符串。 */
export function extractRunCommand(args: Record<string, unknown>): string | undefined {
  const raw = args.command;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName);
}
