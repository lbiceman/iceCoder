/**
 * 需求分析智能体
 * 分析解析后的文本内容并生成结构化的需求 Markdown 文档。
 * 包含章节：功能需求、非功能需求、约束条件和优先级标注。
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';
import { MemoryType } from '../memory/types.js';

export class RequirementAnalysisAgent extends BaseAgent {
  constructor() {
    super('RequirementAnalysis');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const text = context.inputData.text || context.inputData.content;

    // 验证输入文本
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Input text is empty or undefined. Cannot extract requirements.',
        error: 'Input text contains no identifiable requirements',
      };
    }

    // 构建提示让 LLM 分析文本并生成结构化需求
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

    // 调用 LLM 分析文本
    const result = await this.callLLM(prompt, context);

    // 检查 LLM 是否判定无法找到需求
    if (result.trim() === 'NO_REQUIREMENTS_FOUND') {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Input text contains no identifiable requirements.',
        error: 'Input text contains no identifiable requirements',
      };
    }

    // 将需求文档保存到输出目录
    const savedPath = await this.saveDocument(result, 'requirements.md', context.outputDir);

    // 将结果存储到情景记忆以供将来参考
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
