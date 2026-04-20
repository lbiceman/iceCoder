/**
 * Procedural Memory module for storing and managing skills and habits.
 * Tracks skill proficiency, usage count, and mastery status.
 * Proficiency improves with successful executions and degrades with failures.
 */

import { Memory, MemoryType, Skill } from './types.js';
import { createMemory } from './memory.js';

/**
 * Internal tracking data for skill execution history.
 */
interface SkillExecutionData {
  totalExecutions: number;
  successfulExecutions: number;
}

/**
 * ProceduralMemory manages skill-based memories representing learned procedures,
 * habits, and techniques. Each skill tracks proficiency (0-1), usage count,
 * and mastery status (mastered when proficiency >= 0.8).
 */
export class ProceduralMemory {
  private memories: Memory[] = [];
  private executionData: Map<string, SkillExecutionData> = new Map();

  /**
   * Store a new skill as a Memory object.
   * Sets initial proficiency to 0.1, usageCount to 0, and mastered to false.
   *
   * @param skill - The skill to store (name, steps, lastUsedAt)
   * @returns The created Memory object
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
   * Record an execution of a skill, updating usage count and proficiency.
   * Proficiency is calculated by blending the success rate with the current proficiency.
   * A skill is marked as mastered when proficiency reaches 0.8.
   *
   * @param skillName - The name of the skill that was executed
   * @param success - Whether the execution was successful
   * @returns The updated Skill data
   * @throws Error if the skill is not found
   */
  async recordExecution(skillName: string, success: boolean): Promise<Skill> {
    const memory = this.memories.find(
      (m) => m.metadata?.name === skillName
    );

    if (!memory) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    // Update execution tracking data
    let execData = this.executionData.get(skillName);
    if (!execData) {
      execData = { totalExecutions: 0, successfulExecutions: 0 };
      this.executionData.set(skillName, execData);
    }

    execData.totalExecutions += 1;
    if (success) {
      execData.successfulExecutions += 1;
    }

    // Increment usage count
    const usageCount = (memory.metadata!.usageCount as number) + 1;
    memory.metadata!.usageCount = usageCount;

    // Calculate new proficiency: blend success rate with current proficiency
    const successRate = execData.successfulExecutions / execData.totalExecutions;
    const currentProficiency = memory.metadata!.proficiency as number;
    const newProficiency = 0.5 * successRate + 0.5 * currentProficiency;
    memory.metadata!.proficiency = newProficiency;

    // Mark as mastered when proficiency >= 0.8
    memory.metadata!.mastered = newProficiency >= 0.8;

    // Update lastUsedAt
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
   * Query a skill by its name.
   *
   * @param skillName - The name of the skill to find
   * @returns The Skill data if found, null otherwise
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
   * List all skills sorted by proficiency in descending order.
   *
   * @returns Array of all Skill objects sorted by proficiency descending
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
   * Get all stored procedural memories.
   *
   * @returns Array of all stored Memory objects
   */
  async getAll(): Promise<Memory[]> {
    return [...this.memories];
  }

  /**
   * Remove a memory by its ID.
   *
   * @param memoryId - The ID of the memory to remove
   * @returns true if the memory was found and removed, false otherwise
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
