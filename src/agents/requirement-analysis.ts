/**
 * Requirement Analysis Agent
 * Analyzes parsed text content and generates a structured requirements Markdown document.
 * Sections: functional requirements, non-functional requirements, constraints, and priority annotations.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class RequirementAnalysisAgent extends BaseAgent {
  constructor() {
    super('RequirementAnalysis');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const text = context.inputData.text || context.inputData.content;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Input text is empty or undefined. Cannot extract requirements.',
        error: 'Input text contains no identifiable requirements',
      };
    }

    // 需求分析提示词：指导 LLM 从文本中提取结构化需求
    /*
    中文版本：
    你是一名专业的需求分析师。请分析以下文本内容，生成一份结构化的需求文档（Markdown 格式）。

    文档必须包含以下章节：
    1. **功能需求** — 从文本中提取的功能需求编号列表
    2. **非功能需求** — 非功能需求编号列表（性能、安全性、可扩展性等）
    3. **约束条件** — 文本中识别到的技术、业务或资源约束
    4. **优先级标注** — 根据上下文为每个需求标注优先级（高/中/低）

    如果文本中没有可识别的需求，请回复："NO_REQUIREMENTS_FOUND"

    输出格式良好的 Markdown 文档，包含适当的标题和列表。

    --- 输入文本 ---
    ${text}
    --- 输入文本结束 ---
    */
    const prompt = `You are a professional requirements analyst. Analyze the following text content and generate a structured requirements document (Markdown format).

The document must include the following sections:
1. **Functional Requirements** — Numbered list of functional requirements extracted from the text
2. **Non-Functional Requirements** — Numbered list of non-functional requirements (performance, security, scalability, etc.)
3. **Constraints** — Technical, business, or resource constraints identified in the text
4. **Priority Annotations** — Priority level (High/Medium/Low) for each requirement based on context

If no identifiable requirements are found in the text, reply: "NO_REQUIREMENTS_FOUND"

Output a well-formatted Markdown document with proper headings and lists.

--- Input Text ---
${text}
--- End of Input Text ---`;

    const harnessResult = await this.runWithHarness(prompt, context, {
      // 需求分析智能体的系统提示词
      // 中文版本：你是 RequirementAnalysis 智能体，一名专业的需求分析师。你可以使用文件操作工具读取现有项目文档和代码，以更好地理解上下文。分析完成后请提供结构化的需求文档。
      systemPrompt: 'You are the RequirementAnalysis agent, a professional requirements analyst. You can use file operation tools to read existing project documents and code to better understand the context. Provide a structured requirements document when analysis is complete.',
    });
    const result = harnessResult.content;

    if (result.trim() === 'NO_REQUIREMENTS_FOUND') {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Input text contains no identifiable requirements.',
        error: 'Input text contains no identifiable requirements',
      };
    }

    const savedPath = await this.saveDocument(result, 'requirements.md', context.outputDir);

    return {
      success: true,
      outputData: { requirements: result },
      artifacts: [savedPath],
      summary: `Successfully analyzed input text and generated structured requirements document at ${savedPath}`,
    };
  }
}
