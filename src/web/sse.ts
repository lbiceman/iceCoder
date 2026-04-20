/**
 * SSE (Server-Sent Events) Manager.
 * Manages SSE connections by execution ID and pushes events to connected clients.
 */

import type { Response } from 'express';
import type { SSEEvent } from './types.js';

/**
 * Manages Server-Sent Event connections for real-time pipeline updates.
 */
export class SSEManager {
  private connections: Map<string, Response[]> = new Map();

  /**
   * Adds an SSE connection for a given execution ID.
   * Sets proper SSE headers on the response.
   */
  addConnection(executionId: string, res: Response): void {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const existing = this.connections.get(executionId) ?? [];
    existing.push(res);
    this.connections.set(executionId, existing);

    // Remove connection on client disconnect
    res.on('close', () => {
      this.removeConnection(executionId, res);
    });
  }

  /**
   * Removes a specific SSE connection for an execution ID.
   */
  removeConnection(executionId: string, res?: Response): void {
    if (!res) {
      // Remove all connections for this execution ID
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
   * Pushes an SSE event to all connections for a given execution ID.
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
   * Returns the number of active connections for an execution ID.
   */
  getConnectionCount(executionId: string): number {
    return this.connections.get(executionId)?.length ?? 0;
  }

  /**
   * Returns all active execution IDs with connections.
   */
  getActiveExecutionIds(): string[] {
    return Array.from(this.connections.keys());
  }
}
