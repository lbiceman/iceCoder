/**
 * Requirement Verification Agent
 * Receives original requirements and test results, then verifies each requirement.
 * Marks each requirement as: satisfied, partially satisfied, or unsatisfied.
 * Includes gap description for partially/unsatisfied requirements.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';
import { MemoryType } from '../memory/types.js';

export class RequirementVerificationAgent extends BaseAgent {
  constructor() {
    super('RequirementVerification');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const requirements = context.inputData.requirements;
    const testResults = context.inputData.testResults;

    // Validate input requirements
    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot verify requirements.',
        error: 'Requirements input is empty or undefined',
      };
    }

    // Validate test results
    if (!testResults || typeof testResults !== 'string' || testResults.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Test results input is empty or undefined. Cannot verify requirements.',
        error: 'Test results input is empty or undefined',
      };
    }

    // Construct prompt for LLM to verify requirements
    const prompt = `You are a professional requirements verification specialist. Based on the original requirements document and the test results report, verify each requirement and determine its satisfaction status.

For EACH requirement, provide:
1. **Requirement ID/Name**: The requirement identifier
2. **Status**: One of:
   - ✅ **Satisfied** - Requirement is fully met based on test results
   - ⚠️ **Partially Satisfied** - Requirement is partially met with gaps
   - ❌ **Unsatisfied** - Requirement is not met
3. **Evidence**: Reference to test cases that verify this requirement
4. **Gap Description** (for Partially Satisfied or Unsatisfied): Detailed explanation of what is missing or incomplete

Output format:
- Generate a Markdown verification report
- Include a summary table at the top with counts of satisfied, partially satisfied, and unsatisfied requirements
- Follow with detailed per-requirement analysis

--- Original Requirements Document ---
${requirements}
--- End of Requirements Document ---

--- Test Results Report ---
${testResults}
--- End of Test Results Report ---`;

    // Call LLM to verify requirements
    const result = await this.callLLM(prompt, context);

    // Save the verification report to the output directory
    const savedPath = await this.saveDocument(result, 'verification-report.md', context.outputDir);

    // Store the result in episodic memory for future reference
    await this.storeMemory(
      `Generated requirement verification report. Output saved to ${savedPath}`,
      MemoryType.EPISODIC,
      context,
    );

    return {
      success: true,
      outputData: { verificationReport: result },
      artifacts: [savedPath],
      summary: `Successfully generated requirement verification report at ${savedPath}`,
    };
  }
}
