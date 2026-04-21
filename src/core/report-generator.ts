/**
 * 报告生成器
 * 为单个流水线阶段和整体流水线摘要生成 Markdown 报告。
 * 使用一致的命名规范将报告保存到指定的输出目录。
 */

import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import type { StageStatus, AgentResult, PipelineState } from './types.js';

/**
 * ReportGenerator 为流水线阶段执行和整体流水线摘要生成 Markdown 报告。
 */
export class ReportGenerator {
  /**
   * 为单个流水线阶段生成 Markdown 报告。
   * 包含阶段名称、开始时间、结束时间、持续时间、状态和输出摘要。
   *
   * @param stageStatus - 已完成阶段的状态对象
   * @param agentResult - 该阶段智能体产生的结果
   * @param executionId - 唯一的流水线执行 ID
   * @returns 包含阶段报告的 Markdown 格式字符串
   */
  generateStageReport(stageStatus: StageStatus, agentResult: AgentResult, executionId: string): string {
    const startTime = stageStatus.startTime ?? new Date();
    const endTime = stageStatus.endTime ?? new Date();
    const duration = endTime.getTime() - startTime.getTime();

    const lines: string[] = [
      `# Stage Report: ${stageStatus.name}`,
      '',
      `**Execution ID:** ${executionId}`,
      '',
      '## Execution Details',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Stage Name | ${stageStatus.name} |`,
      `| Status | ${stageStatus.status} |`,
      `| Start Time | ${startTime.toISOString()} |`,
      `| End Time | ${endTime.toISOString()} |`,
      `| Duration | ${duration}ms |`,
      '',
    ];

    if (stageStatus.error) {
      lines.push('## Error');
      lines.push('');
      lines.push(stageStatus.error);
      lines.push('');
    }

    lines.push('## Output Summary');
    lines.push('');
    lines.push(agentResult.summary || 'No summary available.');
    lines.push('');

    if (agentResult.artifacts.length > 0) {
      lines.push('## Generated Artifacts');
      lines.push('');
      for (const artifact of agentResult.artifacts) {
        lines.push(`- ${artifact}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 为整个流水线执行生成摘要 Markdown 报告。
   * 包含所有阶段的概览和最终结论。
   *
   * @param pipelineState - 执行后的完整流水线状态
   * @returns 包含流水线摘要的 Markdown 格式字符串
   */
  generatePipelineSummary(pipelineState: PipelineState): string {
    const startTime = pipelineState.startTime;
    const endTime = pipelineState.endTime ?? new Date();
    const totalDuration = endTime.getTime() - startTime.getTime();

    const completedStages = pipelineState.stages.filter(s => s.status === 'completed').length;
    const failedStages = pipelineState.stages.filter(s => s.status === 'failed').length;
    const totalStages = pipelineState.stages.length;

    const overallStatus = failedStages > 0 ? 'Failed' : completedStages === totalStages ? 'Completed' : 'Partial';

    const lines: string[] = [
      `# Pipeline Summary Report`,
      '',
      `**Execution ID:** ${pipelineState.executionId}`,
      '',
      '## Overview',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Total Stages | ${totalStages} |`,
      `| Completed | ${completedStages} |`,
      `| Failed | ${failedStages} |`,
      `| Overall Status | ${overallStatus} |`,
      `| Start Time | ${startTime.toISOString()} |`,
      `| End Time | ${endTime.toISOString()} |`,
      `| Total Duration | ${totalDuration}ms |`,
      '',
      '## Stages Overview',
      '',
      '| # | Stage | Status | Duration |',
      '|---|-------|--------|----------|',
    ];

    pipelineState.stages.forEach((stage, index) => {
      const stageStart = stage.startTime;
      const stageEnd = stage.endTime;
      let stageDuration = 'N/A';
      if (stageStart && stageEnd) {
        stageDuration = `${stageEnd.getTime() - stageStart.getTime()}ms`;
      }
      lines.push(`| ${index + 1} | ${stage.name} | ${stage.status} | ${stageDuration} |`);
    });

    lines.push('');
    lines.push('## Stage Details');
    lines.push('');

    for (const stage of pipelineState.stages) {
      lines.push(`### ${stage.name}`);
      lines.push('');
      lines.push(`- **Status:** ${stage.status}`);

      if (stage.startTime) {
        lines.push(`- **Start Time:** ${stage.startTime.toISOString()}`);
      }
      if (stage.endTime) {
        lines.push(`- **End Time:** ${stage.endTime.toISOString()}`);
      }
      if (stage.error) {
        lines.push(`- **Error:** ${stage.error}`);
      }

      const output = pipelineState.stageOutputs.get(stage.name);
      if (output) {
        lines.push(`- **Summary:** ${output.summary}`);
        if (output.artifacts.length > 0) {
          lines.push(`- **Artifacts:** ${output.artifacts.join(', ')}`);
        }
      }

      lines.push('');
    }

    lines.push('## Conclusion');
    lines.push('');

    if (overallStatus === 'Completed') {
      lines.push('All pipeline stages completed successfully. The full development workflow has been executed from requirement analysis through requirement verification.');
    } else if (overallStatus === 'Failed') {
      const failedStage = pipelineState.stages.find(s => s.status === 'failed');
      lines.push(`Pipeline execution failed at stage "${failedStage?.name}". ${failedStage?.error ?? 'No error details available.'}`);
    } else {
      lines.push('Pipeline execution completed partially. Not all stages were executed.');
    }

    lines.push('');

    return lines.join('\n');
  }

  /**
   * 将报告内容保存到指定输出目录中的文件。
   * 如果输出目录不存在则自动创建。
   *
   * @param content - 要写入的报告内容
   * @param filename - 报告的文件名
   * @param outputDir - 保存报告的目录
   * @returns 保存的报告文件的完整路径
   */
  async saveReport(content: string, filename: string, outputDir: string): Promise<string> {
    const filePath = join(outputDir, filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * 按照命名规范生成报告文件名：
   * {executionId}_{stageName}_report.md
   *
   * @param executionId - 流水线执行 ID
   * @param stageName - 阶段名称
   * @returns 格式化的文件名字符串
   */
  getReportFilename(executionId: string, stageName: string): string {
    return `${executionId}_${stageName}_report.md`;
  }
}
