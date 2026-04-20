/**
 * Requirement Analysis Agent
 * Analyzes parsed text content and generates a structured requirements Markdown document.
 * Includes sections: functional requirements, non-functional requirements, constraints, and priority annotations.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';
import { MemoryType } from '../memory/types.js';

export class RequirementAnalysisAgent extends BaseAgent {
  constructor() {
    super('RequirementAnalysis');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const text = context.inputData.text;

    // Validate input text
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Input text is empty or undefined. Cannot extract requirements.',
        error: 'Input text contains no identifiable requirements',
      };
    }

    // Construct prompt for LLM to analyze text and generate structured requirements
    const prompt = `You are a professional requirements analyst. Analyze the following text content and generate a structured requirements document in Markdown format.

The document MUST include the following sections:
1. **Functional Requirements** - A numbered list of functional requirements extracted from the text
2. **Non-Functional Requirements** - A numbered list of non-functional requirements (performance, security, scalability, etc.)
3. **Constraints** - A list of technical, business, or resource constraints identified in the text
4. **Priority Annotations** - For each requirement, annotate its priority level (High/Medium/Low) based on the context

If the text does not contain any identifiable requirements, respond with exactly: "NO_REQUIREMENTS_FOUND"

Format the output as a clean Markdown document with proper headings and lists.

--- Input Text ---
${text}
--- End of Input Text ---`;

    // Call LLM to analyze the text
    const result = await this.callLLM(prompt, context);

    // Check if LLM determined no requirements could be found
    if (result.trim() === 'NO_REQUIREMENTS_FOUND') {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Input text contains no identifiable requirements.',
        error: 'Input text contains no identifiable requirements',
      };
    }

    // Save the requirements document to the output directory
    const savedPath = await this.saveDocument(result, 'requirements.md', context.outputDir);

    // Store the result in episodic memory for future reference
    await this.storeMemory(
      `Generated requirements document from input text. Output saved to ${savedPath}`,
      MemoryType.EPISODIC,
      context,
    );

    return {
      success: true,
      outputData: { requirements: result },
      artifacts: [savedPath],
      summary: `Successfully analyzed input text and generated structured requirements document at ${savedPath}`,
    };
  }
}
