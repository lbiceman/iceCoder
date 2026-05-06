/**
 * 撤销编辑工具。
 * 维护一个全局编辑历史栈，支持撤销最近的 write_file/edit_file/batch_edit_file 操作。
 * 最多保存 20 条历史记录。
 */

import { promises as fs } from 'node:fs';
import type { RegisteredTool } from '../types.js';

/** 编辑历史条目 */
interface EditHistoryEntry {
  filePath: string;
  originalContent: string | null; // null 表示文件之前不存在（新建）
  timestamp: number;
  toolName: string;
}

/** 最大历史记录数 */
const MAX_HISTORY = 20;

/**
 * 全局编辑历史单例。
 * 在 write_file/edit_file/batch_edit_file 执行前调用 saveSnapshot() 保存原内容。
 * 在 undo_edit 执行时调用 popSnapshot() 恢复。
 */
class EditHistory {
  private stack: EditHistoryEntry[] = [];

  /**
   * 保存文件快照（在编辑操作前调用）。
   */
  async saveSnapshot(filePath: string, toolName: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.push(filePath, content, toolName);
    } catch {
      // 文件不存在（新建场景）
      this.push(filePath, null, toolName);
    }
  }

  private push(filePath: string, content: string | null, toolName: string): void {
    this.stack.push({
      filePath,
      originalContent: content,
      timestamp: Date.now(),
      toolName,
    });
    // 限制栈大小
    if (this.stack.length > MAX_HISTORY) {
      this.stack.shift();
    }
  }

  /**
   * 弹出最近的快照并恢复文件。
   * @param steps - 撤销步数
   * @returns 恢复的文件路径列表
   */
  async popAndRestore(steps: number): Promise<{ restored: string[]; errors: string[] }> {
    const restored: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < steps; i++) {
      const entry = this.stack.pop();
      if (!entry) {
        errors.push('No more edit history to undo.');
        break;
      }

      try {
        if (entry.originalContent === null) {
          // 文件之前不存在 → 删除
          try {
            await fs.unlink(entry.filePath);
            restored.push(`${entry.filePath} (deleted, was created by ${entry.toolName})`);
          } catch {
            // 文件已经不存在了，也算成功
            restored.push(`${entry.filePath} (already deleted)`);
          }
        } else {
          // 恢复原内容
          await fs.writeFile(entry.filePath, entry.originalContent, 'utf-8');
          restored.push(`${entry.filePath} (restored, modified by ${entry.toolName})`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to restore ${entry.filePath}: ${message}`);
      }
    }

    return { restored, errors };
  }

  /**
   * 查看当前历史栈（不弹出）。
   */
  peek(): Array<{ filePath: string; toolName: string; age: string }> {
    return this.stack.map(entry => ({
      filePath: entry.filePath,
      toolName: entry.toolName,
      age: formatAge(Date.now() - entry.timestamp),
    }));
  }

  get size(): number {
    return this.stack.length;
  }
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

/** 进程级单例 */
let instance: EditHistory | null = null;

export function getEditHistory(): EditHistory {
  if (!instance) {
    instance = new EditHistory();
  }
  return instance;
}

/**
 * 创建撤销编辑工具。
 */
export function createUndoEditTool(): RegisteredTool {
  return {
    definition: {
      name: 'undo_edit',
      // 撤销最近的文件编辑操作。最多保存 20 条历史。
      description:
        'Undo the most recent file edit. Restores the original content before the last edit_file/write_file/batch_edit_file operation. Supports undoing multiple times (up to 20 history entries).',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'number',
            description: 'Number of edits to undo. Default: 1. Max: 20.',
            default: 1,
          },
          listHistory: {
            type: 'boolean',
            description: 'If true, just list the edit history without undoing. Default: false.',
            default: false,
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const history = getEditHistory();
      const listHistory = args.listHistory === true;

      if (listHistory) {
        const entries = history.peek();
        if (entries.length === 0) {
          return { success: true, output: 'No edit history available.' };
        }
        const lines = entries.map(
          (e, i) => `${i + 1}. ${e.filePath} (${e.toolName}, ${e.age})`,
        );
        return {
          success: true,
          output: `Edit history (${entries.length} entries):\n${lines.join('\n')}`,
        };
      }

      const steps = Math.min(Math.max(1, (args.steps as number) || 1), 20);

      if (history.size === 0) {
        return { success: false, output: '', error: 'No edit history to undo.' };
      }

      const { restored, errors } = await history.popAndRestore(steps);

      const output: string[] = [];
      if (restored.length > 0) {
        output.push(`Undone ${restored.length} edit(s):`);
        restored.forEach(r => output.push(`  ✓ ${r}`));
      }
      if (errors.length > 0) {
        output.push(`Errors:`);
        errors.forEach(e => output.push(`  ✗ ${e}`));
      }

      return {
        success: errors.length === 0,
        output: output.join('\n'),
        error: errors.length > 0 ? errors.join('; ') : undefined,
      };
    },
  };
}
