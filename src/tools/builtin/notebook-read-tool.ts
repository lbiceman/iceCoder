/**
 * Jupyter Notebook 读取工具。
 * 解析 .ipynb JSON 格式，提取代码和 Markdown 单元格。
 * 支持输出包含或不包含执行结果。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

/** ipynb cell 结构 */
interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[];
  outputs?: Array<{
    output_type: string;
    text?: string[];
    data?: Record<string, string[]>;
  }>;
  execution_count?: number | null;
}

/** ipynb 文件结构 */
interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, any>;
  nbformat?: number;
  nbformat_minor?: number;
}

/**
 * 格式化单个 cell 的输出结果。
 */
function formatOutputs(outputs: NotebookCell['outputs']): string {
  if (!outputs || outputs.length === 0) return '';
  const lines: string[] = [];

  for (const output of outputs) {
    if (output.output_type === 'stream') {
      lines.push((output.text || []).join(''));
    } else if (output.output_type === 'error') {
      lines.push(`[Error] ${(output.text || []).join('')}`);
    } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
      // 优先取 text/plain，其次取任意可用格式
      const data = output.data;
      if (data) {
        if (data['text/plain']) {
          lines.push(data['text/plain'].join(''));
        } else {
          const firstKey = Object.keys(data)[0];
          if (firstKey) lines.push(`[${firstKey}] ${data[firstKey].join('')}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * 创建 Notebook 读取工具。
 */
export function createNotebookReadTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'notebook_read',
      // 读取 Jupyter Notebook (.ipynb) 提取代码和 Markdown 单元格。
      description:
        'Read Jupyter Notebook (.ipynb) files. Extracts code cells and markdown cells in order. Returns cell type, source content, and execution counts.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Notebook file path (relative to work directory)',
          },
          includeOutputs: {
            type: 'boolean',
            description: 'Include cell execution outputs. Default: false.',
            default: false,
          },
          maxCells: {
            type: 'number',
            description: 'Maximum number of cells to read. Default: 100.',
            default: 100,
          },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const filePath = path.resolve(workDir, args.path);
      const includeOutputs = args.includeOutputs === true;
      const maxCells = (args.maxCells as number) || 100;

      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const notebook: Notebook = JSON.parse(raw);

        if (!notebook.cells || !Array.isArray(notebook.cells)) {
          return { success: false, output: '', error: 'Invalid notebook format: no cells array found.' };
        }

        const totalCells = notebook.cells.length;
        const cellsToRead = notebook.cells.slice(0, maxCells);

        const parts: string[] = [];
        parts.push(`Notebook: ${path.basename(filePath)}`);
        parts.push(`Format: nbformat ${notebook.nbformat || '?'}${notebook.nbformat_minor !== undefined ? `.${notebook.nbformat_minor}` : ''}`);
        parts.push(`Total cells: ${totalCells}${totalCells > maxCells ? ` (showing first ${maxCells})` : ''}`);
        parts.push('');

        for (let i = 0; i < cellsToRead.length; i++) {
          const cell = cellsToRead[i];
          const cellType = cell.cell_type;
          const source = (cell.source || []).join('');
          const execCount = cell.execution_count;

          let header = `[Cell ${i + 1} - ${cellType}]`;
          if (cellType === 'code' && execCount !== null && execCount !== undefined) {
            header += ` [In: ${execCount}]`;
          }

          parts.push(header);
          parts.push(source);

          if (includeOutputs && cellType === 'code' && cell.outputs) {
            const output = formatOutputs(cell.outputs);
            if (output) {
              parts.push(`[Output]`);
              parts.push(output);
            }
          }

          parts.push('');
        }

        return { success: true, output: parts.join('\n') };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ENOENT')) {
          return { success: false, output: '', error: `File not found: ${args.path}` };
        }
        if (message.includes('JSON')) {
          return { success: false, output: '', error: `Invalid notebook JSON: ${message}` };
        }
        return { success: false, output: '', error: `Notebook read failed: ${message}` };
      }
    },
  };
}
