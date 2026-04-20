import { describe, it, expect } from 'vitest';
import { createMemory, calculateImportanceScore, CreateMemoryOptions } from './memory.js';
import { MemoryType } from './types.js';

describe('calculateImportanceScore', () => {
  it('should return a score in [0, 1] range', () => {
    const score = calculateImportanceScore('hello world', MemoryType.SHORT_TERM, 'system_generated', 0);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('should give higher score for longer content', () => {
    const shortScore = calculateImportanceScore('hi', MemoryType.SHORT_TERM, 'system_generated', 0);
    const longScore = calculateImportanceScore('a'.repeat(1000), MemoryType.SHORT_TERM, 'system_generated', 0);
    expect(longScore).toBeGreaterThan(shortScore);
  });

  it('should cap content length factor at 1.0 for content >= 1000 chars', () => {
    const score1000 = calculateImportanceScore('a'.repeat(1000), MemoryType.SHORT_TERM, 'system_generated', 0);
    const score2000 = calculateImportanceScore('a'.repeat(2000), MemoryType.SHORT_TERM, 'system_generated', 0);
    expect(score1000).toEqual(score2000);
  });

  it('should give higher score for content with emotion keywords', () => {
    const neutralScore = calculateImportanceScore('this is a regular message', MemoryType.SHORT_TERM, 'system_generated', 0);
    const emotionalScore = calculateImportanceScore('this is a critical emergency', MemoryType.SHORT_TERM, 'system_generated', 0);
    expect(emotionalScore).toBeGreaterThan(neutralScore);
  });

  it('should give higher score for user_input interaction type', () => {
    const systemScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 0);
    const userScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'user_input', 0);
    expect(userScore).toBeGreaterThan(systemScore);
  });

  it('should give correct scores for different interaction types', () => {
    const userScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'user_input', 0);
    const agentScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'agent_transfer', 0);
    const systemScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 0);
    expect(userScore).toBeGreaterThan(agentScore);
    expect(agentScore).toBeGreaterThan(systemScore);
  });

  it('should give higher score for procedural memory type', () => {
    const shortTermScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 0);
    const proceduralScore = calculateImportanceScore('test', MemoryType.PROCEDURAL, 'system_generated', 0);
    expect(proceduralScore).toBeGreaterThan(shortTermScore);
  });

  it('should give higher score for higher access count', () => {
    const lowAccessScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 0);
    const highAccessScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 10);
    expect(highAccessScore).toBeGreaterThan(lowAccessScore);
  });

  it('should cap repetition frequency factor at 1.0 for accessCount >= 10', () => {
    const score10 = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 10);
    const score20 = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 20);
    expect(score10).toEqual(score20);
  });

  it('should default interactionType to system_generated', () => {
    const score = calculateImportanceScore('test', MemoryType.SHORT_TERM);
    const explicitScore = calculateImportanceScore('test', MemoryType.SHORT_TERM, 'system_generated', 0);
    expect(score).toEqual(explicitScore);
  });

  it('should produce correct weighted calculation', () => {
    // Content: 'a'.repeat(500) => contentLengthFactor = 0.5
    // No emotion keywords => emotionIntensityFactor = 0
    // interactionType = 'user_input' => interactionTypeFactor = 1.0
    // memoryType = SEMANTIC => memoryTypeFactor = 0.8
    // accessCount = 5 => repetitionFrequencyFactor = 0.5
    const content = 'a'.repeat(500);
    const expected = 0.15 * 0.5 + 0.20 * 0 + 0.25 * 1.0 + 0.20 * 0.8 + 0.20 * 0.5;
    const score = calculateImportanceScore(content, MemoryType.SEMANTIC, 'user_input', 5);
    expect(score).toBeCloseTo(expected, 10);
  });
});

describe('createMemory', () => {
  it('should create a memory with a unique ID', () => {
    const memory = createMemory({
      content: 'test content',
      type: MemoryType.SHORT_TERM,
      sourceAgent: 'test-agent',
    });
    expect(memory.id).toBeDefined();
    expect(memory.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should generate different IDs for different memories', () => {
    const memory1 = createMemory({
      content: 'test 1',
      type: MemoryType.SHORT_TERM,
      sourceAgent: 'agent-1',
    });
    const memory2 = createMemory({
      content: 'test 2',
      type: MemoryType.SHORT_TERM,
      sourceAgent: 'agent-1',
    });
    expect(memory1.id).not.toEqual(memory2.id);
  });

  it('should set createdAt and lastAccessedAt to current time', () => {
    const before = new Date();
    const memory = createMemory({
      content: 'test',
      type: MemoryType.EPISODIC,
      sourceAgent: 'agent',
    });
    const after = new Date();

    expect(memory.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(memory.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(memory.lastAccessedAt).toEqual(memory.createdAt);
  });

  it('should calculate initial importance score', () => {
    const memory = createMemory({
      content: 'this is a critical issue that needs urgent attention',
      type: MemoryType.PROCEDURAL,
      sourceAgent: 'agent',
      interactionType: 'user_input',
    });
    expect(memory.importanceScore).toBeGreaterThan(0);
    expect(memory.importanceScore).toBeLessThanOrEqual(1);
  });

  it('should set content, type, and sourceAgent correctly', () => {
    const memory = createMemory({
      content: 'my content',
      type: MemoryType.SEMANTIC,
      sourceAgent: 'design-agent',
    });
    expect(memory.content).toBe('my content');
    expect(memory.type).toBe(MemoryType.SEMANTIC);
    expect(memory.sourceAgent).toBe('design-agent');
  });

  it('should set tags to empty array by default', () => {
    const memory = createMemory({
      content: 'test',
      type: MemoryType.SHORT_TERM,
      sourceAgent: 'agent',
    });
    expect(memory.tags).toEqual([]);
  });

  it('should set provided tags', () => {
    const memory = createMemory({
      content: 'test',
      type: MemoryType.SHORT_TERM,
      sourceAgent: 'agent',
      tags: ['tag1', 'tag2'],
    });
    expect(memory.tags).toEqual(['tag1', 'tag2']);
  });

  it('should set metadata when provided', () => {
    const metadata = { key: 'value', nested: { a: 1 } };
    const memory = createMemory({
      content: 'test',
      type: MemoryType.LONG_TERM,
      sourceAgent: 'agent',
      metadata,
    });
    expect(memory.metadata).toEqual(metadata);
  });

  it('should leave metadata undefined when not provided', () => {
    const memory = createMemory({
      content: 'test',
      type: MemoryType.SHORT_TERM,
      sourceAgent: 'agent',
    });
    expect(memory.metadata).toBeUndefined();
  });
});
