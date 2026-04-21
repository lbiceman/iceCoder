/**
 * 工具注册表实现。
 * 管理所有可用工具的注册、查找和列举。
 */

import type { ToolDefinition } from '../llm/types.js';
import type { RegisteredTool, ToolRegistry as IToolRegistry } from './types.js';

export class ToolRegistry implements IToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * 注册一个工具。如果同名工具已存在，则覆盖。
   */
  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  /**
   * 根据名称获取已注册的工具。
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册的工具。
   */
  getAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取所有工具的定义（用于传递给 LLM）。
   */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => t.definition);
  }

  /**
   * 检查是否存在指定名称的工具。
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }
}
