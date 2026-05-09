/**
 * Requirement Verification Agent
 * Receives original requirements and test results, then verifies each requirement.
 * Marks each requirement as: satisfied, partially satisfied, or not satisfied.
 * Includes gap descriptions for partially satisfied or unsatisfied requirements.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class RequirementVerificationAgent extends BaseAgent {
  constructor() {
    super('RequirementVerification');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const requirements = context.inputData.requirements;
    const testResults = context.inputData.testResults;

    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot verify requirements.',
        error: 'Requirements input is empty or undefined',
      };
    }

    if (!testResults || typeof testResults !== 'string' || testResults.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Test results input is empty or undefined. Cannot verify requirements.',
        error: 'Test results input is empty or undefined',
      };
    }

    // 需求验证提示词：指导 LLM 根据测试结果验证每个需求的满足状态
    /*
    中文版本：
    你是一名专业的需求验证专家。请根据原始需求文档和测试结果报告，验证每个需求的满足状态。

    对每个需求，请提供：
    1. **需求 ID/名称**：需求标识符
    2. **状态**：以下之一：
       - ✅ **已满足** — 根据测试结果，需求已完全满足
       - ⚠️ **部分满足** — 需求部分满足，存在差距
       - ❌ **未满足** — 需求未满足
    3. **证据**：验证该需求的测试用例引用
    4. **差距描述**（针对部分满足或未满足的需求）：详细说明缺失或不完整的内容

    输出格式：
    - 生成 Markdown 格式的验证报告
    - 顶部包含已满足、部分满足和未满足需求的计数汇总表
    - 后续为每个需求的详细分析

    --- 原始需求文档 ---
    ${requirements}
    --- 原始需求文档结束 ---

    --- 测试结果报告 ---
    ${testResults}
    --- 测试结果报告结束 ---
    */
    const prompt = `You are a professional requirements verification expert. Based on the original requirements document and test results report, verify the fulfillment status of each requirement.

For each requirement, provide:
1. **Requirement ID/Name**: Requirement identifier
2. **Status**: One of the following:
   - ✅ **Satisfied** — Requirement is fully satisfied based on test results
   - ⚠️ **Partially Satisfied** — Requirement is partially satisfied with gaps
   - ❌ **Not Satisfied** — Requirement is not satisfied
3. **Evidence**: Test case references that verify this requirement
4. **Gap Description** (for partially satisfied or unsatisfied): Detailed explanation of what is missing or incomplete

Output format:
- Generate a Markdown verification report
- Include a summary table at the top with counts of satisfied, partially satisfied, and unsatisfied requirements
- Follow with detailed analysis for each requirement

--- Original Requirements Document ---
${requirements}
--- End of Requirements Document ---

--- Test Results Report ---
${testResults}
--- End of Test Results Report ---`;

    const harnessResult = await this.runWithHarness(prompt, context, {
      // 需求验证智能体的系统提示词
      // 中文版本：你是 RequirementVerification 智能体，一名专业的需求验证专家。你可以使用文件操作工具读取项目源代码和测试结果，以更准确地验证需求满足情况。完成后请提供验证报告。
      systemPrompt: 'You are the RequirementVerification agent, a professional requirements verification expert. You can use file operation tools to read project source code and test results to more accurately verify requirement fulfillment. Provide a verification report when done.',
    });
    const result = harnessResult.content;

    const savedPath = await this.saveDocument(result, 'verification-report.md', context.outputDir);

    return {
      success: true,
      outputData: { verificationReport: result },
      artifacts: [savedPath],
      summary: `Successfully generated requirement verification report at ${savedPath}`,
    };
  }
}
