/**
 * POST /api/screen-ping/ask — 桌面问号轮盘把 200×200 截图换成一句回答。
 */

import { Router, type Request, type Response } from 'express';
import type { LLMAdapterInterface } from '../../llm/types.js';
import { answerScreenPing, parseScreenPingBody, ScreenPingAskError } from '../screen-ping-ask.js';
import { recordScreenPingTurn } from '../screen-ping-session.js';

export function createScreenPingRouter(llm: LLMAdapterInterface): Router {
  const router = Router();

  router.post('/ask', async (req: Request, res: Response) => {
    let input: ReturnType<typeof parseScreenPingBody> | null = null;
    try {
      input = parseScreenPingBody(req.body);
      const result = await answerScreenPing(llm, input);
      await recordScreenPingTurn(input, result.text).catch((err) => {
        console.warn('[screen-ping] 写入会话失败:', err instanceof Error ? err.message : err);
      });
      res.json(result);
    } catch (err) {
      const status = err instanceof ScreenPingAskError ? err.status : 502;
      const message = err instanceof Error ? err.message : String(err);
      if (input) {
        await recordScreenPingTurn(input, message.slice(0, 240)).catch(() => {});
      }
      res.status(status).json({ error: message.slice(0, 240) });
    }
  });

  return router;
}
