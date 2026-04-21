/**
 * 权限系统 — 负责"不能做什么"。
 *
 * 职责：
 * - 工具调用前的权限检查（canUseTool）
 * - 基于规则的工具分类（allow / confirm / deny）
 * - 危险操作拦截
 */

import type { ToolPermissionRule, PermissionCheckResult, ToolPermission } from './types.js';

/**
 * 默认的危险工具模式 — 这些工具默认需要确认。
 */
const DEFAULT_CONFIRM_PATTERNS = [
  'execute_shell_command',
  'write_file',
];

/**
 * PermissionManager 在工具执行前进行权限检查。
 * 对应 Harness 文档中的"不能做什么（权限系统）"。
 *
 * 检查流程：
 * 1. 遍历用户配置的规则，按顺序匹配
 * 2. 如果没有匹配的规则，检查默认危险模式
 * 3. 如果都没匹配，默认允许
 */
export class PermissionManager {
  private rules: ToolPermissionRule[];

  constructor(rules?: ToolPermissionRule[]) {
    this.rules = rules ?? [];
  }

  /**
   * 检查工具是否允许执行。
   *
   * @param toolName - 要检查的工具名称
   * @returns 权限检查结果
   */
  canUseTool(toolName: string): PermissionCheckResult {
    // 1. 检查用户配置的规则（按顺序，第一个匹配的生效）
    for (const rule of this.rules) {
      if (this.matchPattern(toolName, rule.pattern)) {
        return {
          allowed: rule.permission === 'allow',
          permission: rule.permission,
          rule,
          message: rule.reason,
        };
      }
    }

    // 2. 检查默认危险模式
    for (const pattern of DEFAULT_CONFIRM_PATTERNS) {
      if (this.matchPattern(toolName, pattern)) {
        return {
          allowed: false,
          permission: 'confirm',
          message: `工具 "${toolName}" 需要确认后才能执行`,
        };
      }
    }

    // 3. 默认允许
    return {
      allowed: true,
      permission: 'allow',
    };
  }

  /**
   * 添加权限规则。
   */
  addRule(rule: ToolPermissionRule): void {
    this.rules.push(rule);
  }

  /**
   * 设置工具为自动允许（跳过确认）。
   */
  allowTool(toolName: string): void {
    // 移除已有的同名规则
    this.rules = this.rules.filter(r => r.pattern !== toolName);
    this.rules.unshift({
      pattern: toolName,
      permission: 'allow',
      reason: '用户已授权',
    });
  }

  /**
   * 设置工具为拒绝。
   */
  denyTool(toolName: string, reason?: string): void {
    this.rules = this.rules.filter(r => r.pattern !== toolName);
    this.rules.unshift({
      pattern: toolName,
      permission: 'deny',
      reason: reason ?? '已被禁止',
    });
  }

  /**
   * 获取所有规则。
   */
  getRules(): ToolPermissionRule[] {
    return [...this.rules];
  }

  /**
   * 模式匹配：支持精确匹配和通配符 *。
   */
  private matchPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === toolName) return true;

    // 简单通配符：parse_* 匹配 parse_document, parse_pptx_deep 等
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(toolName);
    }

    return false;
  }
}
