/**
 * Episodic Memory module for storing and querying event-based memories.
 * Supports time-range queries, participant-based queries, and event consolidation.
 */

import { Memory, MemoryType, EpisodicEvent } from './types.js';
import { createMemory } from './memory.js';

/**
 * EpisodicMemory manages event-based memories representing specific experiences
 * or occurrences. Each event includes a description, timestamps, participants,
 * and optional emotion annotation.
 */
export class EpisodicMemory {
  private memories: Memory[] = [];

  /**
   * Store an episodic event as a Memory object.
   * Validates that required fields (description, occurredAt) are present.
   *
   * @param event - The episodic event to store
   * @param sourceAgent - The name of the agent storing this event
   * @returns The created Memory object
   * @throws Error if required fields are missing or empty
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
   * Query episodic memories within a time range.
   * Returns events where occurredAt is between start and end (inclusive),
   * sorted by occurredAt ascending.
   *
   * @param start - Start of the time range
   * @param end - End of the time range
   * @returns Array of Memory objects sorted by occurredAt ascending
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
   * Query episodic memories by participant.
   * Returns all events where the given participant is in the participants array.
   *
   * @param participant - The participant name to search for
   * @returns Array of Memory objects involving the given participant
   */
  async queryByParticipant(participant: string): Promise<Memory[]> {
    return this.memories.filter((memory) => {
      const participants: string[] = memory.metadata?.participants ?? [];
      return participants.includes(participant);
    });
  }

  /**
   * Consolidate multiple events into a single summary record.
   * Merges the descriptions of the specified events into one combined Memory.
   *
   * @param eventIds - Array of memory IDs to consolidate
   * @returns A new Memory object containing the consolidated summary
   * @throws Error if no matching events are found
   */
  async consolidateEvents(eventIds: string[]): Promise<Memory> {
    const events = this.memories.filter((m) => eventIds.includes(m.id));

    if (events.length === 0) {
      throw new Error('No matching events found for consolidation');
    }

    // Sort events by occurredAt for chronological summary
    const sorted = events.sort((a, b) => {
      const aTime = new Date(a.metadata?.occurredAt).getTime();
      const bTime = new Date(b.metadata?.occurredAt).getTime();
      return aTime - bTime;
    });

    // Combine descriptions into a summary
    const descriptions = sorted.map((m) => m.metadata?.description ?? m.content);
    const summaryContent = descriptions.join('; ');

    // Collect all unique participants
    const allParticipants = new Set<string>();
    for (const event of sorted) {
      const participants: string[] = event.metadata?.participants ?? [];
      for (const p of participants) {
        allParticipants.add(p);
      }
    }

    // Use the earliest occurredAt and latest endedAt/occurredAt
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
   * Get all stored episodic memories.
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
    this.memories.splice(index, 1);
    return true;
  }
}
