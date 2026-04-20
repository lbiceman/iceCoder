/**
 * Pipeline State Manager
 * Manages the execution state of a pipeline run, including stage statuses,
 * outputs, timing, and unique execution ID generation.
 */

import { v4 as uuidv4 } from 'uuid';
import type { PipelineState, StageStatus, AgentResult } from './types.js';

/**
 * PipelineStateManager manages the lifecycle and state of a single pipeline execution.
 * It tracks stage statuses (pending, running, completed, failed), stage outputs,
 * start/end times, and the current stage index.
 */
export class PipelineStateManager {
  private state: PipelineState;

  /**
   * Creates a new PipelineStateManager with a unique execution ID and
   * initializes all stages as pending.
   * @param stageNames - The ordered list of stage names in the pipeline
   */
  constructor(stageNames: string[]) {
    const stages: StageStatus[] = stageNames.map((name) => ({
      name,
      status: 'pending' as const,
    }));

    this.state = {
      executionId: uuidv4(),
      stages,
      currentStageIndex: 0,
      stageOutputs: new Map<string, AgentResult>(),
      startTime: new Date(),
    };
  }

  /**
   * Marks a stage as running and records its start time.
   * Also updates the currentStageIndex to point to this stage.
   * @param name - The name of the stage to start
   */
  startStage(name: string): void {
    const stage = this.findStage(name);
    stage.status = 'running';
    stage.startTime = new Date();

    const index = this.state.stages.findIndex((s) => s.name === name);
    if (index !== -1) {
      this.state.currentStageIndex = index;
    }
  }

  /**
   * Marks a stage as completed, records its end time, and stores the output result.
   * @param name - The name of the stage to complete
   * @param result - The AgentResult produced by this stage
   */
  completeStage(name: string, result: AgentResult): void {
    const stage = this.findStage(name);
    stage.status = 'completed';
    stage.endTime = new Date();
    this.state.stageOutputs.set(name, result);
  }

  /**
   * Marks a stage as failed and records the error message.
   * @param name - The name of the stage that failed
   * @param error - A description of the error that caused the failure
   */
  failStage(name: string, error: string): void {
    const stage = this.findStage(name);
    stage.status = 'failed';
    stage.endTime = new Date();
    stage.error = error;
  }

  /**
   * Returns the current pipeline state.
   */
  getState(): PipelineState {
    return this.state;
  }

  /**
   * Returns the name of the current stage (based on currentStageIndex).
   */
  getCurrentStage(): string {
    return this.state.stages[this.state.currentStageIndex].name;
  }

  /**
   * Marks the pipeline as complete by setting the end time.
   */
  complete(): void {
    this.state.endTime = new Date();
  }

  /**
   * Finds a stage by name. Throws an error if the stage does not exist.
   */
  private findStage(name: string): StageStatus {
    const stage = this.state.stages.find((s) => s.name === name);
    if (!stage) {
      throw new Error(`Stage "${name}" not found in pipeline`);
    }
    return stage;
  }
}
