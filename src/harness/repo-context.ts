import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import { extractDeletedPathsFromCommand, isMissingFileToolResult, missingChangedFilePaths } from './document-deliverable.js';
import type { RepoContextSnapshot } from '../types/runtime-snapshot.js';

export type { RepoContextSnapshot } from '../types/runtime-snapshot.js';

const READ_TOOLS = new Set(['read_file', 'open_file', 'file_info']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'batch_edit_file', 'patch_file']);

export class RepoContext {
  private filesRead = new Set<string>();
  private filesChanged = new Set<string>();
  private commandsRun: string[] = [];
  private testCommands: string[] = [];
  private recentDiagnostics: string[] = [];

  recordToolResult(toolCall: ToolCall, result: ToolResult): void {
    const path = extractPathLikeArg(toolCall.arguments);

    if (path && READ_TOOLS.has(toolCall.name)) {
      if (result.success) {
        this.filesRead.add(path);
      } else if (isMissingFileToolResult(result)) {
        this.removeChangedFile(path);
      }
    }
    if (path && WRITE_TOOLS.has(toolCall.name)) this.filesChanged.add(path);

    if (toolCall.name === 'fs_operation') {
      const op = String(toolCall.arguments?.operation ?? '');
      if (op === 'delete' && result.success && path) {
        this.removeChangedFile(path);
      }
    }

    if (toolCall.name === 'run_command') {
      const command = String(toolCall.arguments?.command ?? '');
      if (command) {
        this.commandsRun.push(command);
        if (looksLikeTestCommand(command)) this.testCommands.push(command);
        if (result.success) {
          for (const deletedPath of extractDeletedPathsFromCommand(command)) {
            this.removeChangedFile(deletedPath);
          }
        }
      }
    }

    if (!result.success && result.error) {
      this.recentDiagnostics.push(`${toolCall.name}: ${result.error}`.slice(0, 300));
      this.recentDiagnostics = this.recentDiagnostics.slice(-5);
    }
  }

  snapshot(): RepoContextSnapshot {
    return {
      filesRead: [...this.filesRead],
      filesChanged: [...this.filesChanged],
      commandsRun: this.commandsRun.slice(-10),
      testCommands: this.testCommands.slice(-5),
      recentDiagnostics: [...this.recentDiagnostics],
    };
  }

  /** 从会话笔记中的 JSON 快照恢复 */
  applySnapshot(snapshot: RepoContextSnapshot): void {
    this.filesRead = new Set(snapshot.filesRead);
    this.filesChanged = new Set(snapshot.filesChanged);
    this.commandsRun = [...snapshot.commandsRun];
    this.testCommands = [...snapshot.testCommands];
    this.recentDiagnostics = [...snapshot.recentDiagnostics];
  }

  hasContent(): boolean {
    const s = this.snapshot();
    return s.filesRead.length > 0
      || s.filesChanged.length > 0
      || s.commandsRun.length > 0
      || s.recentDiagnostics.length > 0;
  }

  /** 同步已删除的变更路径（与 TaskState.reconcileMissingChangedFiles 对齐）。 */
  reconcileMissingChangedFiles(workspaceRoot?: string): number {
    const missing = missingChangedFilePaths([...this.filesChanged], workspaceRoot);
    let removed = 0;
    for (const path of missing) {
      const before = this.filesChanged.size;
      this.removeChangedFile(path);
      if (this.filesChanged.size < before) removed++;
    }
    return removed;
  }

  private removeChangedFile(path: string): void {
    for (const changed of [...this.filesChanged]) {
      if (normalizeRepoPath(changed) === normalizeRepoPath(path)) {
        this.filesChanged.delete(changed);
      }
    }
  }
}

function normalizeRepoPath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function extractPathLikeArg(args: Record<string, any>): string | undefined {
  for (const key of ['path', 'filePath', 'file_path', 'target_file', 'targetFile']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function looksLikeTestCommand(command: string): boolean {
  const c = command.toLowerCase();
  return /\b(test|vitest|jest|mocha|pytest|go test|cargo test|tsc|lint|typecheck)\b/.test(c);
}
