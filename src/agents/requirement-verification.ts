/**
 * 需求验证智能体
 * 接收原始需求和测试结果，然后验证每个需求。
 * 将每个需求标记为：已满足、部分满足或未满足。
 * 对部分满足/未满足的需求包含差距描述。
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

    // 验证输入需求
    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot verify requirements.',
        error: 'Requirements input is empty or undefined',
      };
    }

    // 验证测试结果
    if (!testResults || typeof testResults !== 'string' || testResults.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Test results input is empty or undefined. Cannot verify requirements.',
        error: 'Test results input is empty or undefined',
      };
    }

    // 构建提示让 LLM 验证需求
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

    // 调用 LLM 验证需求
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
