/**
 * 远程控制路由模块。
 * 提供会话创建、验证和 WebSocket 连接，
 * 支持手机扫码远程控制桌面端。
 *
 * 会话长期有效，直到下一次生成新二维码时旧会话才失效。
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import os from 'os';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { ToolExecutor } from '../../tools/tool-executor.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';

// ---- 类型定义 ----

export interface RemoteSession {
  sessionId: string;
  token: string;
  createdAt: number;
  connected: boolean;
}

export interface RemoteRouterOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
}

// ---- 会话存储 ----

const sessions: Map<string, RemoteSession> = new Map();

/** 获取本机局域网 IP */
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * 尝试从 cloudflared 获取公网隧道 URL。
 * cloudflared quick tunnel 会在 metrics 端口暴露隧道信息。
 */
let cachedTunnelUrl: string | null = null;
let tunnelCheckTime = 0;

async function getTunnelUrl(): Promise<string | null> {
  // 环境变量优先
  if (process.env.TUNNEL_URL) {
    return process.env.TUNNEL_URL;
  }

  // 缓存 30 秒
  if (cachedTunnelUrl && Date.now() - tunnelCheckTime < 30_000) {
    return cachedTunnelUrl;
  }

  try {
    // cloudflared metrics 默认在 127.0.0.1:20241
    const res = await fetch('http://127.0.0.1:20241/quicktunnel', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json() as { hostname?: string };
      if (data.hostname) {
        cachedTunnelUrl = `https://${data.hostname}`;
        tunnelCheckTime = Date.now();
        return cachedTunnelUrl;
      }
    }
  } catch {
    // cloudflared 未运行或不可达
  }

  cachedTunnelUrl = null;
  tunnelCheckTime = Date.now();
  return null;
}

/**
 * 清除所有现有会话。
 * 每次生成新二维码时调用，使旧链接失效。
 */
function invalidateAllSessions(): void {
  sessions.clear();
}

// ---- 导出：获取活跃会话（供 WebSocket 升级使用） ----

export function getSession(token: string): RemoteSession | undefined {
  return sessions.get(token);
}

export function markSessionConnected(token: string): void {
  const session = sessions.get(token);
  if (session) {
    session.connected = true;
  }
}

export function removeSession(token: string): void {
  sessions.delete(token);
}

// ---- 路由 ----

export function createRemoteRouter(_options: RemoteRouterOptions): Router {
  const router = Router();

  /**
   * POST /api/remote/session - 创建远程控制会话
   * 会清除所有旧会话，新会话长期有效直到下次生成。
   */
  router.post('/session', async (_req: Request, res: Response): Promise<void> => {
    // 使所有旧会话失效
    invalidateAllSessions();

    const sessionId = randomUUID();
    const token = randomUUID();
    const now = Date.now();

    const session: RemoteSession = {
      sessionId,
      token,
      createdAt: now,
      connected: false,
    };

    sessions.set(token, session);

    // 获取访问 URL（优先公网隧道，回退局域网）
    const localIP = getLocalIP();
    const port = process.env.PORT ?? '3000';
    const tunnelUrl = await getTunnelUrl();
    const baseUrl = tunnelUrl || `http://${localIP}:${port}`;
    const url = `${baseUrl}/?token=${token}`;

    // 生成二维码 data URL
    let qrDataUrl = '';
    try {
      const QRCode = await import('qrcode');
      qrDataUrl = await QRCode.default.toDataURL(url, {
        width: 280,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch {
      // 二维码生成失败，前端可以回退显示链接
    }

    res.json({
      success: true,
      sessionId,
      token,
      url,
      qrDataUrl,
      localIP,
      port,
      tunnel: !!tunnelUrl,
    });
  });

  /**
   * GET /api/remote/verify - 验证 token 有效性（手机端调用）
   */
  router.get('/verify', (req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ valid: false, error: '缺少 token' });
      return;
    }

    const session = getSession(token);
    if (!session) {
      res.status(401).json({ valid: false, error: 'token 无效或已过期' });
      return;
    }

    res.json({
      valid: true,
      sessionId: session.sessionId,
    });
  });

  return router;
}
