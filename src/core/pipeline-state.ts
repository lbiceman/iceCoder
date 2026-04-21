/**
 * 流水线状态管理器
 * 管理流水线运行的执行状态，包括阶段状态、输出、计时和唯一执行 ID 生成。
 */

import { v4 as uuidv4 } from 'uuid';
import type { PipelineState, StageStatus, AgentResult } from './types.js';

/**
 * PipelineStateManager 管理单次流水线执行的生命周期和状态。
 * 跟踪阶段状态（pending、running、completed、failed）、阶段输出、
 * 开始/结束时间以及当前阶段索引。
 */
export class PipelineStateManager {
  private state: PipelineState;

  /**
   * 创建新的 PipelineStateManager，生成唯一执行 ID 并将所有阶段初始化为 pending。
   * @param stageNames - 流水线中阶段名称的有序列表
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
   * 将阶段标记为运行中并记录其开始时间。
   * 同时更新 currentStageIndex 指向该阶段。
   * @param name - 要启动的阶段名称
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
   * 将阶段标记为已完成，记录其结束时间并存储输出结果。
   * @param name - 要完成的阶段名称
   * @param result - 该阶段产生的 AgentResult
   */
  completeStage(name: string, result: AgentResult): void {
    const stage = this.findStage(name);
    stage.status = 'completed';
    stage.endTime = new Date();
    this.state.stageOutputs.set(name, result);
  }

  /**
   * 将阶段标记为失败并记录错误信息。
   * @param name - 失败的阶段名称
   * @param error - 导致失败的错误描述
   */
  failStage(name: string, error: string): void {
    const stage = this.findStage(name);
    stage.status = 'failed';
    stage.endTime = new Date();
    stage.error = error;
  }

  /**
   * 返回当前流水线状态。
   */
  getState(): PipelineState {
    return this.state;
  }

  /**
   * 返回当前阶段的名称（基于 currentStageIndex）。
   */
  getCurrentStage(): string {
    return this.state.stages[this.state.currentStageIndex].name;
  }

  /**
   * 通过设置结束时间将流水线标记为完成。
   */
  complete(): void {
    this.state.endTime = new Date();
  }

  /**
   * 按名称查找阶段。如果阶段不存在则抛出错误。
   */
  private findStage(name: string): StageStatus {
    const stage = this.state.stages.find((s) => s.name === name);
    if (!stage) {
      throw new Error(`Stage "${name}" not found in pipeline`);
    }
    return stage;
  }
}
