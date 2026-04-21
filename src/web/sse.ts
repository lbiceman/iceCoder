/**
 * SSE（服务器推送事件）管理器。
 * 按执行 ID 管理 SSE 连接并向已连接的客户端推送事件。
 */

import type { Response } from 'express';
import type { SSEEvent } from './types.js';

/**
 * 管理用于实时流水线更新的服务器推送事件连接。
 */
export class SSEManager {
  private connections: Map<string, Response[]> = new Map();

  /**
   * 为给定执行 ID 添加 SSE 连接。
   * 在响应上设置正确的 SSE 头。
   */
  addConnection(executionId: string, res: Response): void {
    // 设置 SSE 头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const existing = this.connections.get(executionId) ?? [];
    existing.push(res);
    this.connections.set(executionId, existing);

    // 客户端断开时移除连接
    res.on('close', () => {
      this.removeConnection(executionId, res);
    });
  }

  /**
   * 移除指定执行 ID 的特定 SSE 连接。
   */
  removeConnection(executionId: string, res?: Response): void {
    if (!res) {
      // 移除此执行 ID 的所有连接
      const connections = this.connections.get(executionId);
      if (connections) {
        for (const conn of connections) {
          conn.end();
        }
      }
      this.connections.delete(executionId);
      return;
    }

    const connections = this.connections.get(executionId);
    if (connections) {
      const filtered = connections.filter((conn) => conn !== res);
      if (filtered.length === 0) {
        this.connections.delete(executionId);
      } else {
        this.connections.set(executionId, filtered);
      }
    }
  }

  /**
   * 向给定执行 ID 的所有连接推送 SSE 事件。
   */
  push(executionId: string, event: SSEEvent): void {
    const connections = this.connections.get(executionId);
    if (!connections || connections.length === 0) {
      return;
    }

    const eventData = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

    for (const res of connections) {
      res.write(eventData);
    }
  }

  /**
   * 返回指定执行 ID 的活跃连接数。
   */
  getConnectionCount(executionId: string): number {
    return this.connections.get(executionId)?.length ?? 0;
  }

  /**
   * 返回所有有连接的活跃执行 ID。
   */
  getActiveExecutionIds(): string[] {
    return Array.from(this.connections.keys());
  }
}
