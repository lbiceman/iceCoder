/**
 * Report Generator
 * Generates Markdown reports for individual pipeline stages and overall pipeline summaries.
 * Saves reports to the designated output directory with a consistent naming convention.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import type { StageStatus, AgentResult, PipelineState } from './types.js';

/**
 * ReportGenerator produces Markdown reports for pipeline stage executions
 * and overall pipeline summaries.
 */
export class ReportGenerator {
  /**
   * Generates a Markdown report for a single pipeline stage.
   * Includes stage name, start time, end time, duration, status, and output summary.
   *
   * @param stageStatus - The status object for the completed stage
   * @param agentResult - The result produced by the agent for this stage
   * @param executionId - The unique pipeline execution ID
   * @returns A Markdown-formatted string containing the stage report
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
   * Generates a summary Markdown report for the entire pipeline execution.
   * Includes an overview of all stages and a final conclusion.
   *
   * @param pipelineState - The complete pipeline state after execution
   * @returns A Markdown-formatted string containing the pipeline summary
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
   * Saves report content to a file in the specified output directory.
   * Creates the output directory if it does not exist.
   *
   * @param content - The report content to write
   * @param filename - The filename for the report
   * @param outputDir - The directory to save the report in
   * @returns The full path to the saved report file
   */
  async saveReport(content: string, filename: string, outputDir: string): Promise<string> {
    const filePath = join(outputDir, filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Generates a report filename following the naming convention:
   * {executionId}_{stageName}_report.md
   *
   * @param executionId - The pipeline execution ID
   * @param stageName - The name of the stage
   * @returns The formatted filename string
   */
  getReportFilename(executionId: string, stageName: string): string {
    return `${executionId}_${stageName}_report.md`;
  }
}
