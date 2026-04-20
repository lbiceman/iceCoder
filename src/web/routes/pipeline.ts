/**
 * Pipeline status and SSE endpoint routes.
 * Provides real-time pipeline updates via SSE and pipeline state queries.
 */

import { Router, type Request, type Response } from 'express';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { SSEManager } from '../sse.js';
import type { SSEEvent } from '../types.js';

/**
 * Options for creating the pipeline router.
 */
export interface PipelineRouterOptions {
  orchestrator: Orchestrator;
  sseManager: SSEManager;
}

/**
 * Creates the pipeline API router.
 * Provides SSE streaming, pipeline state, and stage report endpoints.
 */
export function createPipelineRouter(options: PipelineRouterOptions): Router {
  const { orchestrator, sseManager } = options;
  const router = Router();

  /**
   * GET /api/chat/stream/:id - Establish SSE connection for pipeline updates.
   * Pushes stage_update, message, pipeline_complete, and error events.
   */
  router.get('/chat/stream/:id', (req: Request, res: Response): void => {
    const executionId = req.params.id as string;

    if (!executionId) {
      res.status(400).json({ error: 'Execution ID is required' });
      return;
    }

    // Register SSE connection
    sseManager.addConnection(executionId, res);

    // Send initial connection confirmation
    const connectEvent: SSEEvent = {
      type: 'message',
      data: { content: 'SSE connection established' },
    };
    sseManager.push(executionId, connectEvent);
  });

  /**
   * GET /api/pipeline/:id - Return current pipeline state.
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

    // Serialize the pipeline state (Map -> Object for JSON)
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
   * GET /api/pipeline/:id/report/:stage - Return stage report content.
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
 * Wires Orchestrator events to the SSE manager for real-time updates.
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

    // Clean up SSE connections after pipeline completes
    setTimeout(() => {
      sseManager.removeConnection(state.executionId);
    }, 5000);
  });
}
