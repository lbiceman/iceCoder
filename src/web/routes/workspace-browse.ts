/**
 * 工作区目录浏览 API（供聊天 @ 文件引用）。
 *
 * GET /api/workspace/browse?sessionId=&dir=
 */

import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import { listWorkspaceDirectory, searchWorkspaceFiles } from '../workspace-browse.js';
import { resolveEffectiveWorkspaceRoot } from '../../harness/session-workspace-store.js';
import { rejectUnsafeSessionId } from '../session-id-guard.js';
import '../../cli/paths.js';
import { getRuntimeDataDir } from '../../cli/paths.js';

const DEFAULT_SESSION_ID = 'default';

function getSessionsDir(): string {
  return process.env.ICE_SESSIONS_DIR || path.join(getRuntimeDataDir(), 'sessions');
}

export function createWorkspaceBrowseRouter(): Router {
  const router = Router();

  router.get('/browse', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = String(req.query.sessionId || DEFAULT_SESSION_ID);
      if (rejectUnsafeSessionId(res, sessionId)) return;

      const dirQuery = typeof req.query.dir === 'string' ? req.query.dir : undefined;
      const defaultWorkDir = process.cwd();
      const { workspaceRoot } = await resolveEffectiveWorkspaceRoot(
        getSessionsDir(),
        sessionId,
        defaultWorkDir,
      );

      const result = await listWorkspaceDirectory(workspaceRoot, dirQuery);
      res.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('outside workspace') ? 403 : 400;
      res.status(status).json({ success: false, error: message });
    }
  });

  router.get('/search', async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = String(req.query.sessionId || DEFAULT_SESSION_ID);
      if (rejectUnsafeSessionId(res, sessionId)) return;

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!q) {
        res.json({ success: true, entries: [], total: 0 });
        return;
      }

      const defaultWorkDir = process.cwd();
      const { workspaceRoot } = await resolveEffectiveWorkspaceRoot(
        getSessionsDir(),
        sessionId,
        defaultWorkDir,
      );

      const entries = await searchWorkspaceFiles(workspaceRoot, q);
      res.json({
        success: true,
        entries: entries.entries,
        total: entries.entries.length,
        truncated: entries.truncated,
        scanned: entries.scanned,
        workspaceRoot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  return router;
}
