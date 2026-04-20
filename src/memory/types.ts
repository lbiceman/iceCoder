/**
 * 记忆系统的类型定义。
 * 定义记忆类型、数据结构以及专用记忆事件类型。
 */

/**
 * 支持的记忆类型枚举。
 */
export enum MemoryType {
  SHORT_TERM = 'short_term',
  LONG_TERM = 'long_term',
  EPISODIC = 'episodic',
  SEMANTIC = 'semantic',
  PROCEDURAL = 'procedural'
}

/**
 * 核心记忆数据结构，包含内容和元数据。
 */
export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  createdAt: Date;
  lastAccessedAt: Date;
  importanceScore: number;
  sourceAgent: string;
  tags: string[];
  metadata?: Record<string, any>;
}

/**
 * 情景记忆事件，表示一次具体的经历或事件。
 */
export interface EpisodicEvent {
  description: string;
  occurredAt: Date;
  endedAt?: Date;
  participants: string[];
  emotion?: string;
}

/**
 * 语义记忆知识表示中的主语-谓语-宾语三元组。
 */
export interface Triple {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * 语义记忆知识图谱中的概念定义。
 */
export interface Concept {
  name: string;
  definition: string;
  attributes: string[];
  relations: { target: string; type: string }[];
}

/**
 * 程序性记忆中的技能定义。
 */
export interface Skill {
  name: string;
  steps: string[];
  proficiency: number;
  usageCount: number;
  lastUsedAt: Date;
  mastered: boolean;
}
