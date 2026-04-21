/**
 * 流水线状态和 SSE 端点路由。
 * 通过 SSE 提供实时流水线更新和流水线状态查询。
 */

import { Router, type Request, type Response } from 'express';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { SSEManager } from '../sse.js';
import type { SSEEvent } from '../types.js';

/**
 * 创建流水线路由的选项。
 */
export interface PipelineRouterOptions {
  orchestrator: Orchestrator;
  sseManager: SSEManager;
}

/**
 * 创建流水线 API 路由。
 * 提供 SSE 流式传输、流水线状态和阶段报告端点。
 */
export function createPipelineRouter(options: PipelineRouterOptions): Router {
  const { orchestrator, sseManager } = options;
  const router = Router();

  /**
   * GET /api/chat/stream/:id - 建立用于流水线更新的 SSE 连接。
   * 推送 stage_update、message、pipeline_complete 和 error 事件。
   */
  router.get('/chat/stream/:id', (req: Request, res: Response): void => {
    const executionId = req.params.id as string;

    if (!executionId) {
      res.status(400).json({ error: 'Execution ID is required' });
      return;
    }

    // 注册 SSE 连接
    sseManager.addConnection(executionId, res);

    // 发送初始连接确认
    const connectEvent: SSEEvent = {
      type: 'message',
      data: { content: 'SSE connection established' },
    };
    sseManager.push(executionId, connectEvent);
  });

  /**
   * GET /api/pipeline/:id - 返回当前流水线状态。
   */
  router.get('/pipeline/:id', (req: Request, res: Response): void => {
    const executionId = req.params.id as string;

    if (!executionId) {
      res.status(400).json({ error: 'Execution ID is required' });
      return;
    }

    const state = orchestrator.getPipelineStatus(executionId);

    if (!state) {
      res.status(404).json({ error: `Pipeline not found: ${executionId}` });
      return;
    }

    // 序列化流水线状态（Map -> Object 用于 JSON）
    const serializedState = {
      executionId: state.executionId,
      stages: state.stages,
      currentStageIndex: state.currentStageIndex,
      stageOutputs: Object.fromEntries(state.stageOutputs),
      startTime: state.startTime,
      endTime: state.endTime,
    };

    res.json(serializedState);
  });

  /**
   * GET /api/pipeline/:id/report/:stage - 返回阶段报告内容。
   */
  router.get('/pipeline/:id/report/:stage', async (req: Request, res: Response): Promise<void> => {
    const executionId = req.params.id as string;
    const stageName = req.params.stage as string;

    if (!executionId || !stageName) {
      res.status(400).json({ error: 'Execution ID and stage name are required' });
      return;
    }

    const state = orchestrator.getPipelineStatus(executionId);

    if (!state) {
      res.status(404).json({ error: `Pipeline not found: ${executionId}` });
      return;
    }

    const stageOutput = state.stageOutputs.get(stageName);

    if (!stageOutput) {
      res.status(404).json({ error: `Stage report not found: ${stageName}` });
      return;
    }

    res.json({
      executionId,
      stageName,
      result: stageOutput,
    });
  });

  return router;
}

/**
 * 将编排器事件连接到 SSE 管理器以实现实时更新。
 */
export function wireOrchestratorToSSE(orchestrator: Orchestrator, sseManager: SSEManager): void {
  orchestrator.onStageChange((stage) => {
    // Push stage update to all connections that might be listening
    // We need to find the execution ID from the stage context
    // Since stages don't carry executionId, we broadcast to all active connections
    const activeIds = sseManager.getActiveExecutionIds();
    const event: SSEEvent = {
      type: 'stage_update',
      data: { stageStatus: stage },
    };
    for (const id of activeIds) {
      sseManager.push(id, event);
    }
  });

  orchestrator.onPipelineComplete((state) => {
    const event: SSEEvent = {
      type: 'pipeline_complete',
      data: { pipelineState: state },
    };
    sseManager.push(state.executionId, event);

    // 流水线完成后清理 SSE 连接
    setTimeout(() => {
      sseManager.removeConnection(state.executionId);
    }, 5000);
  });
}
