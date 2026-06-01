/**
 * 未完成主配置时，限制除配置 API 与静态资源外的后端能力。
 */

import type { Request, Response, NextFunction } from 'express';

export interface SetupGateState {
  required: boolean;
}

export function createSetupGateMiddleware(isRequired: () => boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isRequired()) {
      next();
      return;
    }

    const path = req.path || req.url || '';
    if (path.startsWith('/api/config')) {
      next();
      return;
    }

    if (!path.startsWith('/api/')) {
      next();
      return;
    }

    res.status(503).json({
      error: '请先完成模型配置',
      setupRequired: true,
    });
  };
}
