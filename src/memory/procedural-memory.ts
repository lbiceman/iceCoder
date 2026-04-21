/**
 * 程序性记忆模块，用于存储和管理技能与习惯。
 * 跟踪技能熟练度、使用次数和掌握状态。
 * 熟练度随成功执行而提升，随失败而下降。
 */

import { Memory, MemoryType, Skill } from './types.js';
import { createMemory } from './memory.js';

/**
 * 技能执行历史的内部跟踪数据。
 */
interface SkillExecutionData {
  totalExecutions: number;
  successfulExecutions: number;
}

/**
 * ProceduralMemory 管理基于技能的记忆，表示已学习的程序、习惯和技术。
 * 每个技能跟踪熟练度 (0-1)、使用次数和掌握状态（熟练度 >= 0.8 时标记为已掌握）。
 */
export class ProceduralMemory {
  private memories: Memory[] = [];
  private executionData: Map<string, SkillExecutionData> = new Map();

  /**
   * 将新技能存储为 Memory 对象。
   * 设置初始熟练度为 0.1，usageCount 为 0，mastered 为 false。
   *
   * @param skill - 要存储的技能（name、steps、lastUsedAt）
   * @returns 创建的 Memory 对象
   */
  async store(
    skill: Omit<Skill, 'proficiency' | 'usageCount' | 'mastered'>
  ): Promise<Memory> {
    const memory = createMemory({
      content: `Skill: ${skill.name}`,
      type: MemoryType.PROCEDURAL,
      sourceAgent: 'procedural-memory',
      tags: [skill.name],
      metadata: {
        name: skill.name,
        steps: skill.steps,
        proficiency: 0.1,
        usageCount: 0,
        lastUsedAt: skill.lastUsedAt.toISOString(),
        mastered: false,
      },
    });

    this.memories.push(memory);
    this.executionData.set(skill.name, {
      totalExecutions: 0,
      successfulExecutions: 0,
    });

    return memory;
  }

  /**
   * 记录技能的一次执行，更新使用次数和熟练度。
   * 熟练度通过混合成功率和当前熟练度来计算。
   * 当熟练度达到 0.8 时标记为已掌握。
   *
   * @param skillName - 被执行的技能名称
   * @param success - 执行是否成功
   * @returns 更新后的 Skill 数据
   * @throws 如果技能未找到则抛出错误
   */
  async recordExecution(skillName: string, success: boolean): Promise<Skill> {
    const memory = this.memories.find(
      (m) => m.metadata?.name === skillName
    );

    if (!memory) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // 更新执行跟踪数据
    let execData = this.executionData.get(skillName);
    if (!execData) {
      execData = { totalExecutions: 0, successfulExecutions: 0 };
      this.executionData.set(skillName, execData);
    }

    execData.totalExecutions += 1;
    if (success) {
      execData.successfulExecutions += 1;
    }

    // 增加使用次数
    const usageCount = (memory.metadata!.usageCount as number) + 1;
    memory.metadata!.usageCount = usageCount;

    // 计算新熟练度：混合成功率和当前熟练度
    const successRate = execData.successfulExecutions / execData.totalExecutions;
    const currentProficiency = memory.metadata!.proficiency as number;
    const newProficiency = 0.5 * successRate + 0.5 * currentProficiency;
    memory.metadata!.proficiency = newProficiency;

    // 当熟练度 >= 0.8 时标记为已掌握
    memory.metadata!.mastered = newProficiency >= 0.8;

    // 更新 lastUsedAt
    memory.metadata!.lastUsedAt = new Date().toISOString();

    return {
      name: memory.metadata!.name as string,
      steps: memory.metadata!.steps as string[],
      proficiency: memory.metadata!.proficiency as number,
      usageCount: memory.metadata!.usageCount as number,
      lastUsedAt: new Date(memory.metadata!.lastUsedAt as string),
      mastered: memory.metadata!.mastered as boolean,
    };
  }

  /**
   * 按名称查询技能。
   *
   * @param skillName - 要查找的技能名称
   * @returns 如果找到返回 Skill 数据，否则返回 null
   */
  async queryByName(skillName: string): Promise<Skill | null> {
    const memory = this.memories.find(
      (m) => m.metadata?.name === skillName
    );

    if (!memory) {
      return null;
    }

    return {
      name: memory.metadata!.name as string,
      steps: memory.metadata!.steps as string[],
      proficiency: memory.metadata!.proficiency as number,
      usageCount: memory.metadata!.usageCount as number,
      lastUsedAt: new Date(memory.metadata!.lastUsedAt as string),
      mastered: memory.metadata!.mastered as boolean,
    };
  }

  /**
   * 列出所有技能，按熟练度降序排列。
   *
   * @returns 按熟练度降序排列的所有 Skill 对象数组
   */
  async listByProficiency(): Promise<Skill[]> {
    return this.memories
      .map((memory) => ({
        name: memory.metadata!.name as string,
        steps: memory.metadata!.steps as string[],
        proficiency: memory.metadata!.proficiency as number,
        usageCount: memory.metadata!.usageCount as number,
        lastUsedAt: new Date(memory.metadata!.lastUsedAt as string),
        mastered: memory.metadata!.mastered as boolean,
      }))
      .sort((a, b) => b.proficiency - a.proficiency);
  }

  /**
   * 获取所有存储的程序性记忆。
   *
   * @returns 所有存储的 Memory 对象数组
   */
  async getAll(): Promise<Memory[]> {
    return [...this.memories];
  }

  /**
   * 按 ID 移除记忆。
   *
   * @param memoryId - 要移除的记忆 ID
   * @returns 如果找到并移除了记忆返回 true，否则返回 false
   */
  async remove(memoryId: string): Promise<boolean> {
    const index = this.memories.findIndex((m) => m.id === memoryId);
    if (index === -1) {
      return false;
    }
    const memory = this.memories[index];
    const skillName = memory.metadata?.name as string;
    this.memories.splice(index, 1);
    this.executionData.delete(skillName);
    return true;
  }
}
