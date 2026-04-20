/**
 * Design Agent
 * Receives requirements Markdown and generates a structured design document.
 * Includes sections: system architecture overview, module breakdown, interface design, and data model design.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';
import { MemoryType } from '../memory/types.js';

export class DesignAgent extends BaseAgent {
  constructor() {
    super('Design');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const requirements = context.inputData.requirements;

    // Validate input requirements
    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot generate design document.',
        error: 'Requirements input is empty or undefined',
      };
    }

    // Construct prompt for LLM to generate design document
    const prompt = `You are a professional software architect. Based on the following requirements document, generate a comprehensive system design document in Markdown format.

The document MUST include the following sections:
1. **System Architecture Overview** - High-level architecture description, key design decisions, and technology choices
2. **Module Breakdown** - Detailed breakdown of system modules/components with responsibilities and interactions
3. **Interface Design** - API interfaces, data contracts, and communication protocols between modules
4. **Data Model Design** - Database schemas, data structures, and relationships

If the requirements are incomplete or ambiguous, annotate the gaps clearly with "[GAP]" markers and explain what additional information is needed.

Format the output as a clean Markdown document with proper headings, lists, and code blocks where appropriate.

--- Requirements Document ---
${requirements}
--- End of Requirements Document ---`;

    // Call LLM to generate the design document
    const result = await this.callLLM(prompt, context);

    // Save the design document to the output directory
    const savedPath = await this.saveDocument(result, 'design.md', context.outputDir);

    // Store the result in episodic memory for future reference
    await this.storeMemory(
      `Generated design document from requirements. Output saved to ${savedPath}`,
      MemoryType.EPISODIC,
      context,
    );

    return {
      success: true,
      outputData: { design: result },
      artifacts: [savedPath],
      summary: `Successfully generated system design document at ${savedPath}`,
    };
  }
}
