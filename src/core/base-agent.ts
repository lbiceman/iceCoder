/**
 * BaseAgent abstract class providing common functionality for all agents.
 * Implements the Agent interface with error-handling wrapper and helper methods
 * for LLM calls, memory operations, and document saving.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Agent, AgentContext, AgentResult } from './types.js';
import { MemoryType, Memory } from '../memory/types.js';
import { UnifiedMessage } from '../llm/types.js';

/**
 * Abstract base class for all agents in the system.
 * Provides:
 * - Automatic error handling via execute() wrapping doExecute()
 * - Helper methods for LLM interaction, memory operations, and file I/O
 */
export abstract class BaseAgent implements Agent {
  protected name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Returns the agent's name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Public execute method that wraps doExecute() with try-catch.
   * All agents automatically get error handling through this pattern.
   * Concrete agents implement doExecute() instead of execute() directly.
   */
  async execute(context: AgentContext): Promise<AgentResult> {
    try {
      return await this.doExecute(context);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: `Agent "${this.name}" failed with error: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  /**
   * Abstract method that concrete agents must implement.
   * Contains the actual agent logic without needing to handle errors.
   */
  protected abstract doExecute(context: AgentContext): Promise<AgentResult>;

  /**
   * Helper to call the LLM with a prompt string.
   * Creates a UnifiedMessage with role='user' and sends it via the LLM adapter.
   *
   * @param prompt - The prompt text to send to the LLM
   * @param context - The agent execution context containing the LLM adapter
   * @returns The LLM response content string
   */
  protected async callLLM(prompt: string, context: AgentContext): Promise<string> {
    const message: UnifiedMessage = {
      role: 'user',
      content: prompt,
    };

    const response = await context.llmAdapter.chat([message]);
    return response.content;
  }

  /**
   * Helper to store content in the agent's memory system.
   *
   * @param content - The content to store as a memory
   * @param type - The type of memory (short_term, long_term, episodic, etc.)
   * @param context - The agent execution context containing the memory manager
   */
  protected async storeMemory(content: string, type: MemoryType, context: AgentContext): Promise<void> {
    await context.memoryManager.store(content, type, { sourceAgent: this.name });
  }

  /**
   * Helper to retrieve relevant memories from the agent's memory system.
   *
   * @param query - The search query to find relevant memories
   * @param context - The agent execution context containing the memory manager
   * @returns Array of matching Memory objects
   */
  protected async retrieveMemory(query: string, context: AgentContext): Promise<Memory[]> {
    return await context.memoryManager.retrieve(query);
  }

  /**
   * Helper to save content to a file in the output directory.
   * Creates the directory if it doesn't exist.
   *
   * @param content - The content to write to the file
   * @param filename - The name of the file to create
   * @param outputDir - The directory to write the file in
   * @returns The full path of the saved file
   */
  protected async saveDocument(content: string, filename: string, outputDir: string): Promise<string> {
    await fs.mkdir(outputDir, { recursive: true });
    const fullPath = path.join(outputDir, filename);
    await fs.writeFile(fullPath, content, 'utf-8');
    return fullPath;
  }
}
