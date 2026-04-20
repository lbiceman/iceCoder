/**
 * Memory data structure factory and importance score calculation.
 * Provides creation of Memory objects with auto-generated IDs, timestamps,
 * and importance score calculation based on weighted factors.
 */

import { v4 as uuidv4 } from 'uuid';
import { Memory, MemoryType } from './types.js';

/**
 * Weights for importance score calculation.
 */
const WEIGHTS = {
  contentLength: 0.15,
  emotionIntensity: 0.20,
  interactionType: 0.25,
  memoryType: 0.20,
  repetitionFrequency: 0.20,
};

/**
 * Emotion keywords used for emotion intensity detection.
 */
const EMOTION_KEYWORDS: Record<string, number> = {
  // High intensity (1.0)
  'critical': 1.0,
  'urgent': 1.0,
  'emergency': 1.0,
  'fatal': 1.0,
  'catastrophic': 1.0,
  // Medium-high intensity (0.8)
  'important': 0.8,
  'significant': 0.8,
  'essential': 0.8,
  'crucial': 0.8,
  'severe': 0.8,
  // Medium intensity (0.6)
  'warning': 0.6,
  'concern': 0.6,
  'notable': 0.6,
  'attention': 0.6,
  'issue': 0.6,
  // Low-medium intensity (0.4)
  'minor': 0.4,
  'note': 0.4,
  'info': 0.4,
  'update': 0.4,
  // Low intensity (0.2)
  'routine': 0.2,
  'normal': 0.2,
  'standard': 0.2,
};

/**
 * Interaction type factor values.
 */
const INTERACTION_TYPE_FACTORS: Record<string, number> = {
  user_input: 1.0,
  agent_transfer: 0.7,
  system_generated: 0.4,
};

/**
 * Memory type factor values.
 */
const MEMORY_TYPE_FACTORS: Record<MemoryType, number> = {
  [MemoryType.PROCEDURAL]: 0.9,
  [MemoryType.SEMANTIC]: 0.8,
  [MemoryType.EPISODIC]: 0.7,
  [MemoryType.LONG_TERM]: 0.6,
  [MemoryType.SHORT_TERM]: 0.3,
};

/**
 * Calculate the content length factor.
 * Normalized to [0, 1] using min(content.length / 1000, 1.0).
 */
function calculateContentLengthFactor(content: string): number {
  return Math.min(content.length / 1000, 1.0);
}

/**
 * Calculate the emotion intensity factor based on keyword matching.
 * Returns the highest matching emotion keyword intensity, or 0 if none match.
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
 * Calculate the interaction type factor.
 * Defaults to 'system_generated' (0.4) if type is not recognized.
 */
function calculateInteractionTypeFactor(interactionType: string): number {
  return INTERACTION_TYPE_FACTORS[interactionType] ?? 0.4;
}

/**
 * Calculate the memory type factor.
 */
function calculateMemoryTypeFactor(memoryType: MemoryType): number {
  return MEMORY_TYPE_FACTORS[memoryType] ?? 0.3;
}

/**
 * Calculate the repetition frequency factor.
 * Normalized to [0, 1] using min(accessCount / 10, 1.0).
 */
function calculateRepetitionFrequencyFactor(accessCount: number): number {
  return Math.min(accessCount / 10, 1.0);
}

/**
 * Calculate the importance score for a memory based on weighted factors.
 * Result is normalized to [0, 1] range.
 *
 * Formula:
 * ImportanceScore = w1 * contentLengthFactor + w2 * emotionIntensityFactor
 *                 + w3 * interactionTypeFactor + w4 * memoryTypeFactor
 *                 + w5 * repetitionFrequencyFactor
 *
 * @param content - The memory content text
 * @param memoryType - The type of memory
 * @param interactionType - The interaction type (user_input, agent_transfer, system_generated)
 * @param accessCount - Number of times the memory has been accessed
 * @returns Importance score normalized to [0, 1]
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

  // Normalize to [0, 1] range (clamp)
  return Math.max(0, Math.min(1, score));
}

/**
 * Options for creating a new Memory.
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
 * Factory function to create a new Memory object.
 * Auto-generates a unique ID, sets creation/access timestamps,
 * and calculates the initial importance score.
 *
 * @param options - Memory creation options
 * @returns A fully initialized Memory object
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
