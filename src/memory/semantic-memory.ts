/**
 * 语义记忆模块，用于以三元组和概念形式存储和查询知识。
 * 支持主语-谓语-宾语三元组、概念定义和知识图谱遍历。
 */

import { Memory, MemoryType, Triple, Concept } from './types.js';
import { createMemory } from './memory.js';

/**
 * SemanticMemory 管理基于事实和概念的知识。
 * 以主语-谓语-宾语三元组和概念定义的形式存储知识，
 * 支持按主语、谓语查询以及深度限制的知识图谱遍历。
 */
export class SemanticMemory {
  private memories: Memory[] = [];

  /**
   * 将主语-谓语-宾语三元组存储为 Memory 对象。
   * 验证 subject、predicate 和 object 均非空。
   *
   * @param triple - 要存储的三元组
   * @param sourceAgent - 存储此三元组的智能体名称
   * @returns 创建的 Memory 对象
   * @throws 如果 subject、predicate 或 object 为空则抛出错误
   */
  async storeTriple(triple: Triple, sourceAgent: string): Promise<Memory> {
    if (!triple.subject || triple.subject.trim() === '') {
      throw new Error('Missing required field: subject');
    }

    if (!triple.predicate || triple.predicate.trim() === '') {
      throw new Error('Missing required field: predicate');
    }

    if (!triple.object || triple.object.trim() === '') {
      throw new Error('Missing required field: object');
    }

    const content = `${triple.subject} ${triple.predicate} ${triple.object}`;

    const memory = createMemory({
      content,
      type: MemoryType.SEMANTIC,
      sourceAgent,
      tags: [triple.subject, triple.predicate, triple.object],
      metadata: {
        kind: 'triple',
        subject: triple.subject,
        predicate: triple.predicate,
        object: triple.object,
      },
    });

    this.memories.push(memory);
    return memory;
  }

  /**
   * 将概念定义存储为 Memory 对象。
   *
   * @param concept - 要存储的概念
   * @param sourceAgent - 存储此概念的智能体名称
   * @returns 创建的 Memory 对象
   */
  async storeConcept(concept: Concept, sourceAgent: string): Promise<Memory> {
    const content = `${concept.name}: ${concept.definition}`;

    const memory = createMemory({
      content,
      type: MemoryType.SEMANTIC,
      sourceAgent,
      tags: [concept.name, ...concept.attributes],
      metadata: {
        kind: 'concept',
        name: concept.name,
        definition: concept.definition,
        attributes: concept.attributes,
        relations: concept.relations,
      },
    });

    this.memories.push(memory);
    return memory;
  }

  /**
   * 查询所有 subject 匹配给定值的三元组。
   *
   * @param subject - 要搜索的主语
   * @returns 匹配主语的 Triple 对象数组
   */
  async queryBySubject(subject: string): Promise<Triple[]> {
    return this.memories
      .filter(
        (memory) =>
          memory.metadata?.kind === 'triple' &&
          memory.metadata?.subject === subject
      )
      .map((memory) => ({
        subject: memory.metadata!.subject as string,
        predicate: memory.metadata!.predicate as string,
        object: memory.metadata!.object as string,
      }));
  }

  /**
   * 查询所有 predicate 匹配给定值的三元组。
   *
   * @param predicate - 要搜索的谓语
   * @returns 匹配谓语的 Triple 对象数组
   */
  async queryByPredicate(predicate: string): Promise<Triple[]> {
    return this.memories
      .filter(
        (memory) =>
          memory.metadata?.kind === 'triple' &&
          memory.metadata?.predicate === predicate
      )
      .map((memory) => ({
        subject: memory.metadata!.subject as string,
        predicate: memory.metadata!.predicate as string,
        object: memory.metadata!.object as string,
      }));
  }

  /**
   * 从一个概念开始查询知识图谱，使用 BFS 遍历关系直到指定的最大深度。
   *
   * @param startConcept - 开始遍历的概念名称
   * @param maxDepth - 最大遍历深度（0 仅返回起始概念）
   * @returns 在 maxDepth 内可达的 Concept 对象数组
   */
  async queryKnowledgeGraph(
    startConcept: string,
    maxDepth: number
  ): Promise<Concept[]> {
    const visited = new Set<string>();
    const result: Concept[] = [];

    // BFS 队列：每个条目为 [conceptName, currentDepth]
    const queue: [string, number][] = [[startConcept, 0]];

    while (queue.length > 0) {
      const [conceptName, depth] = queue.shift()!;

      if (visited.has(conceptName)) {
        continue;
      }

      visited.add(conceptName);

      // 查找概念记忆
      const conceptMemory = this.memories.find(
        (memory) =>
          memory.metadata?.kind === 'concept' &&
          memory.metadata?.name === conceptName
      );

      if (!conceptMemory) {
        continue;
      }

      const concept: Concept = {
        name: conceptMemory.metadata!.name as string,
        definition: conceptMemory.metadata!.definition as string,
        attributes: conceptMemory.metadata!.attributes as string[],
        relations: conceptMemory.metadata!.relations as {
          target: string;
          type: string;
        }[],
      };

      result.push(concept);

      // 如果未达到最大深度，将相关概念加入队列
      if (depth < maxDepth) {
        for (const relation of concept.relations) {
          if (!visited.has(relation.target)) {
            queue.push([relation.target, depth + 1]);
          }
        }
      }
    }

    return result;
  }

  /**
   * 获取所有存储的语义记忆。
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
