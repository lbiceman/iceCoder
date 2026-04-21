/**
 * 情景记忆模块，用于存储和查询基于事件的记忆。
 * 支持时间范围查询、参与者查询和事件合并。
 */

import { Memory, MemoryType, EpisodicEvent } from './types.js';
import { createMemory } from './memory.js';

/**
 * EpisodicMemory 管理基于事件的记忆，表示具体的经历或事件。
 * 每个事件包含描述、时间戳、参与者和可选的情感标注。
 */
export class EpisodicMemory {
  private memories: Memory[] = [];

  /**
   * 将情景事件存储为 Memory 对象。
   * 验证必填字段（description、occurredAt）是否存在。
   *
   * @param event - 要存储的情景事件
   * @param sourceAgent - 存储此事件的智能体名称
   * @returns 创建的 Memory 对象
   * @throws 如果必填字段缺失或为空则抛出错误
   */
  async store(event: EpisodicEvent, sourceAgent: string): Promise<Memory> {
    if (!event.description || event.description.trim() === '') {
      throw new Error('Missing required field: description');
    }

    if (!event.occurredAt) {
      throw new Error('Missing required field: occurredAt');
    }

    const memory = createMemory({
      content: event.description,
      type: MemoryType.EPISODIC,
      sourceAgent,
      tags: event.participants ?? [],
      metadata: {
        description: event.description,
        occurredAt: event.occurredAt.toISOString(),
        endedAt: event.endedAt?.toISOString() ?? null,
        participants: event.participants ?? [],
        emotion: event.emotion ?? null,
      },
    });

    this.memories.push(memory);
    return memory;
  }

  /**
   * 查询指定时间范围内的情景记忆。
   * 返回 occurredAt 在 start 和 end 之间（含）的事件，
   * 按 occurredAt 升序排列。
   *
   * @param start - 时间范围的开始
   * @param end - 时间范围的结束
   * @returns 按 occurredAt 升序排列的 Memory 对象数组
   */
  async queryByTimeRange(start: Date, end: Date): Promise<Memory[]> {
    const filtered = this.memories.filter((memory) => {
      const occurredAt = new Date(memory.metadata?.occurredAt);
      return occurredAt >= start && occurredAt <= end;
    });

    return filtered.sort((a, b) => {
      const aTime = new Date(a.metadata?.occurredAt).getTime();
      const bTime = new Date(b.metadata?.occurredAt).getTime();
      return aTime - bTime;
    });
  }

  /**
   * 按参与者查询情景记忆。
   * 返回给定参与者在 participants 数组中的所有事件。
   *
   * @param participant - 要搜索的参与者名称
   * @returns 涉及给定参与者的 Memory 对象数组
   */
  async queryByParticipant(participant: string): Promise<Memory[]> {
    return this.memories.filter((memory) => {
      const participants: string[] = memory.metadata?.participants ?? [];
      return participants.includes(participant);
    });
  }

  /**
   * 将多个事件合并为单个摘要记录。
   * 将指定事件的描述合并为一个组合 Memory。
   *
   * @param eventIds - 要合并的记忆 ID 数组
   * @returns 包含合并摘要的新 Memory 对象
   * @throws 如果没有找到匹配的事件则抛出错误
   */
  async consolidateEvents(eventIds: string[]): Promise<Memory> {
    const events = this.memories.filter((m) => eventIds.includes(m.id));

    if (events.length === 0) {
      throw new Error('No matching events found for consolidation');
    }

    // 按 occurredAt 排序以生成按时间顺序的摘要
    const sorted = events.sort((a, b) => {
      const aTime = new Date(a.metadata?.occurredAt).getTime();
      const bTime = new Date(b.metadata?.occurredAt).getTime();
      return aTime - bTime;
    });

    // 将描述合并为摘要
    const descriptions = sorted.map((m) => m.metadata?.description ?? m.content);
    const summaryContent = descriptions.join('; ');

    // 收集所有唯一参与者
    const allParticipants = new Set<string>();
    for (const event of sorted) {
      const participants: string[] = event.metadata?.participants ?? [];
      for (const p of participants) {
        allParticipants.add(p);
      }
    }

    // 使用最早的 occurredAt 和最晚的 endedAt/occurredAt
    const earliestOccurredAt = sorted[0].metadata?.occurredAt;
    const latestTime = sorted[sorted.length - 1].metadata?.endedAt
      ?? sorted[sorted.length - 1].metadata?.occurredAt;

    const consolidatedMemory = createMemory({
      content: summaryContent,
      type: MemoryType.EPISODIC,
      sourceAgent: sorted[0].sourceAgent,
      tags: Array.from(allParticipants),
      metadata: {
        description: summaryContent,
        occurredAt: earliestOccurredAt,
        endedAt: latestTime,
        participants: Array.from(allParticipants),
        emotion: null,
        consolidatedFrom: eventIds,
      },
    });

    this.memories.push(consolidatedMemory);
    return consolidatedMemory;
  }

  /**
   * 获取所有存储的情景记忆。
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
    this.memories.splice(index, 1);
    return true;
  }
}
