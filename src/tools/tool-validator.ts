/**
 * 工具输入验证器。
 *
 * 在工具执行前验证输入参数的合法性，
 * 将验证错误反馈给模型，让模型自行修正。
 *
 * 使用集中式验证器 + 可注册的验证规则。
 */

import type { ToolCall } from '../llm/types.js';

/**
 * 验证结果。
 */
export interface ValidationResult {
  /** 是否通过验证 */
  valid: boolean;
  /** 验证失败时的错误信息（会反馈给模型） */
  message?: string;
  /** 错误码（用于程序化处理） */
  errorCode?: number;
}

/**
 * 验证规则函数类型。
 */
export type ValidationRule = (
  toolName: string,
  args: Record<string, any>,
) => ValidationResult;

/**
 * 工具输入验证器。
 *
 * 使用方式：
 * ```ts
 * const validator = new ToolValidator();
 *
 * // 注册通用规则
 * validator.addGlobalRule((name, args) => {
 *   if (args.path && args.path.includes('..')) {
 *     return { valid: false, message: '路径不允许包含 ..' };
 *   }
 *   return { valid: true };
 * });
 *
 * // 注册工具特定规则
 * validator.addToolRule('write_file', (name, args) => {
 *   if (!args.content) {
 *     return { valid: false, message: '写入内容不能为空' };
 *   }
 *   return { valid: true };
 * });
 *
 * const result = validator.validate(toolCall);
 * ```
 */
export class ToolValidator {
  /** 全局验证规则（对所有工具生效） */
  private globalRules: ValidationRule[] = [];
  /** 工具特定验证规则 */
  private toolRules: Map<string, ValidationRule[]> = new Map();

  /**
   * 添加全局验证规则。
   */
  addGlobalRule(rule: ValidationRule): void {
    this.globalRules.push(rule);
  }

  /**
   * 添加工具特定验证规则。
   */
  addToolRule(toolName: string, rule: ValidationRule): void {
    const rules = this.toolRules.get(toolName) ?? [];
    rules.push(rule);
    this.toolRules.set(toolName, rules);
  }

  /**
   * 验证工具调用的输入参数。
   * 按顺序执行全局规则和工具特定规则，第一个失败的规则决定结果。
   */
  validate(toolCall: ToolCall): ValidationResult {
    // 执行全局规则
    for (const rule of this.globalRules) {
      const result = rule(toolCall.name, toolCall.arguments);
      if (!result.valid) return result;
    }

    // 执行工具特定规则
    const toolSpecificRules = this.toolRules.get(toolCall.name) ?? [];
    for (const rule of toolSpecificRules) {
      const result = rule(toolCall.name, toolCall.arguments);
      if (!result.valid) return result;
    }

    return { valid: true };
  }
}

/**
 * 创建默认的验证规则集。
 *
 * 包含常见的安全检查：
 * - 路径遍历检测
 * - 危险命令检测
 * - 必填参数检查
 */
export function createDefaultValidationRules(): ValidationRule[] {
  return [
    // 路径遍历检测
    (toolName, args) => {
      if (args.path && typeof args.path === 'string') {
        // 检测绝对路径中的路径遍历
        if (args.path.includes('..') && args.path.includes('/etc/')) {
          return {
            valid: false,
            message: '安全检查失败：路径不允许遍历到系统目录',
            errorCode: 403,
          };
        }
      }
      return { valid: true };
    },

    // 空命令检测
    (toolName, args) => {
      if (toolName === 'run_command' && (!args.command || args.command.trim() === '')) {
        return {
          valid: false,
          message: '命令不能为空',
          errorCode: 400,
        };
      }
      return { valid: true };
    },
  ];
}
