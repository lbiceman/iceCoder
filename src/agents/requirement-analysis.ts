/**
 * 需求分析智能体
 * 分析解析后的文本内容并生成结构化的需求 Markdown 文档。
 * 包含章节：功能需求、非功能需求、约束条件和优先级标注。
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

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
    const prompt = `你是一名专业的需求分析师。分析以下文本内容，生成结构化的需求文档（Markdown 格式）。

文档必须包含以下章节：
1. **功能需求** — 从文本中提取的功能需求编号列表
2. **非功能需求** — 非功能需求编号列表（性能、安全、可扩展性等）
3. **约束条件** — 文本中识别出的技术、业务或资源约束
4. **优先级标注** — 根据上下文为每个需求标注优先级（高/中/低）

如果文本中没有可识别的需求，请回复："NO_REQUIREMENTS_FOUND"

输出格式为规范的 Markdown 文档，使用正确的标题和列表。

--- 输入文本 ---
${text}
--- 输入文本结束 ---`;

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

    return {
      success: true,
      outputData: { requirements: result },
      artifacts: [savedPath],
      summary: `Successfully analyzed input text and generated structured requirements document at ${savedPath}`,
    };
  }
}
