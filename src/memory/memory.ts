/**
 * Memory 数据结构工厂和重要性评分计算。
 * 提供带自动生成 ID、时间戳的 Memory 对象创建，
 * 以及基于加权因子的重要性评分计算。
 */

import { v4 as uuidv4 } from 'uuid';
import { Memory, MemoryType } from './types.js';

/**
 * 重要性评分计算的权重。
 */
const WEIGHTS = {
  contentLength: 0.15,
  emotionIntensity: 0.20,
  interactionType: 0.25,
  memoryType: 0.20,
  repetitionFrequency: 0.20,
};

/**
 * 用于情感强度检测的情感关键词。
 */
const EMOTION_KEYWORDS: Record<string, number> = {
  // 高强度 (1.0)
  'critical': 1.0,
  'urgent': 1.0,
  'emergency': 1.0,
  'fatal': 1.0,
  'catastrophic': 1.0,
  // 中高强度 (0.8)
  'important': 0.8,
  'significant': 0.8,
  'essential': 0.8,
  'crucial': 0.8,
  'severe': 0.8,
  // 中等强度 (0.6)
  'warning': 0.6,
  'concern': 0.6,
  'notable': 0.6,
  'attention': 0.6,
  'issue': 0.6,
  // 中低强度 (0.4)
  'minor': 0.4,
  'note': 0.4,
  'info': 0.4,
  'update': 0.4,
  // 低强度 (0.2)
  'routine': 0.2,
  'normal': 0.2,
  'standard': 0.2,
};

/**
 * 交互类型因子值。
 */
const INTERACTION_TYPE_FACTORS: Record<string, number> = {
  user_input: 1.0,
  agent_transfer: 0.7,
  system_generated: 0.4,
};

/**
 * 记忆类型因子值。
 */
const MEMORY_TYPE_FACTORS: Record<MemoryType, number> = {
  [MemoryType.PROCEDURAL]: 0.9,
  [MemoryType.SEMANTIC]: 0.8,
  [MemoryType.EPISODIC]: 0.7,
  [MemoryType.LONG_TERM]: 0.6,
  [MemoryType.SHORT_TERM]: 0.3,
};

/**
 * 计算内容长度因子。
 * 归一化到 [0, 1]，使用 min(content.length / 1000, 1.0)。
 */
function calculateContentLengthFactor(content: string): number {
  return Math.min(content.length / 1000, 1.0);
}

/**
 * 基于关键词匹配计算情感强度因子。
 * 返回匹配的最高情感关键词强度，如果没有匹配则返回 0。
 */
function calculateEmotionIntensityFactor(content: string): number {
  const lowerContent = content.toLowerCase();
  let maxIntensity = 0;

  for (const [keyword, intensity] of Object.entries(EMOTION_KEYWORDS)) {
    if (lowerContent.includes(keyword)) {
      maxIntensity = Math.max(maxIntensity, intensity);
    }
  }

  return maxIntensity;
}

/**
 * 计算交互类型因子。
 * 如果类型未识别，默认为 'system_generated' (0.4)。
 */
function calculateInteractionTypeFactor(interactionType: string): number {
  return INTERACTION_TYPE_FACTORS[interactionType] ?? 0.4;
}

/**
 * 计算记忆类型因子。
 */
function calculateMemoryTypeFactor(memoryType: MemoryType): number {
  return MEMORY_TYPE_FACTORS[memoryType] ?? 0.3;
}

/**
 * 计算重复频率因子。
 * 归一化到 [0, 1]，使用 min(accessCount / 10, 1.0)。
 */
function calculateRepetitionFrequencyFactor(accessCount: number): number {
  return Math.min(accessCount / 10, 1.0);
}

/**
 * 基于加权因子计算记忆的重要性评分。
 * 结果归一化到 [0, 1] 范围。
 *
 * 公式：
 * ImportanceScore = w1 * contentLengthFactor + w2 * emotionIntensityFactor
 *                 + w3 * interactionTypeFactor + w4 * memoryTypeFactor
 *                 + w5 * repetitionFrequencyFactor
 *
 * @param content - 记忆内容文本
 * @param memoryType - 记忆类型
 * @param interactionType - 交互类型（user_input、agent_transfer、system_generated）
 * @param accessCount - 记忆被访问的次数
 * @returns 归一化到 [0, 1] 的重要性评分
 */
export function calculateImportanceScore(
  content: string,
  memoryType: MemoryType,
  interactionType: string = 'system_generated',
  accessCount: number = 0
): number {
  const contentLengthFactor = calculateContentLengthFactor(content);
  const emotionIntensityFactor = calculateEmotionIntensityFactor(content);
  const interactionTypeFactor = calculateInteractionTypeFactor(interactionType);
  const memoryTypeFactor = calculateMemoryTypeFactor(memoryType);
  const repetitionFrequencyFactor = calculateRepetitionFrequencyFactor(accessCount);

  const score =
    WEIGHTS.contentLength * contentLengthFactor +
    WEIGHTS.emotionIntensity * emotionIntensityFactor +
    WEIGHTS.interactionType * interactionTypeFactor +
    WEIGHTS.memoryType * memoryTypeFactor +
    WEIGHTS.repetitionFrequency * repetitionFrequencyFactor;

  // 归一化到 [0, 1] 范围（截断）
  return Math.max(0, Math.min(1, score));
}

/**
 * 创建新 Memory 的选项。
 */
export interface CreateMemoryOptions {
  content: string;
  type: MemoryType;
  sourceAgent: string;
  tags?: string[];
  metadata?: Record<string, any>;
  interactionType?: string;
}

/**
 * 创建新 Memory 对象的工厂函数。
 * 自动生成唯一 ID，设置创建/访问时间戳，并计算初始重要性评分。
 *
 * @param options - Memory 创建选项
 * @returns 完全初始化的 Memory 对象
 */
export function createMemory(options: CreateMemoryOptions): Memory {
  const {
    content,
    type,
    sourceAgent,
    tags = [],
    metadata,
    interactionType = 'system_generated',
  } = options;

  const now = new Date();

  const importanceScore = calculateImportanceScore(
    content,
    type,
    interactionType,
    0 // initial access count is 0
  );

  return {
    id: uuidv4(),
    content,
    type,
    createdAt: now,
    lastAccessedAt: now,
    importanceScore,
    sourceAgent,
    tags,
    metadata,
  };
}
