import type { ProjectCheckpointV3 } from '../types/runtime-checkpoint.js';

/** Canonical aggregate crossing capture/restore boundaries. */
export type CheckpointSnapshot = ProjectCheckpointV3;

export type CheckpointSnapshotBoundary = 'capture' | 'restore';

export interface CheckpointSnapshotContext {
  reason?: string;
  signal?: AbortSignal;
}

/**
 * Captures the current aggregate only. Persistence, retention, and history are deliberately
 * outside this boundary.
 */
export interface CheckpointSnapshotProvider {
  capture(context?: CheckpointSnapshotContext): CheckpointSnapshot | Promise<CheckpointSnapshot>;
}

/**
 * Restores one validated aggregate into runtime components. Implementations should replace
 * component state rather than merge it so replaying the same snapshot remains idempotent.
 */
export interface CheckpointSnapshotRestorer {
  restore(
    checkpoint: CheckpointSnapshot,
    context?: CheckpointSnapshotContext,
  ): void | Promise<void>;
}

/** Short aliases for adapters that already carry "checkpoint" in their module name. */
export type SnapshotProvider = CheckpointSnapshotProvider;
export type SnapshotRestorer = CheckpointSnapshotRestorer;

export type CheckpointSnapshotEventType =
  | 'capture_started'
  | 'capture_completed'
  | 'capture_failed'
  | 'restore_started'
  | 'restore_completed'
  | 'restore_failed';

export interface CheckpointSnapshotEvent {
  type: CheckpointSnapshotEventType;
  boundary: CheckpointSnapshotBoundary;
  at: number;
  checkpointId?: string;
  durationMs?: number;
  error?: string;
}

export type CheckpointSnapshotEventListener = (event: CheckpointSnapshotEvent) => void;

export type LightweightSnapshotBoundary =
  | 'round_started'
  | 'tool_batch_completed'
  | 'gate_decision';

export interface LightweightSnapshotBoundaryEvent {
  boundary: LightweightSnapshotBoundary;
  at: number;
  sessionId?: string;
  round?: number;
  detail?: string;
}

export type LightweightSnapshotBoundaryListener = (
  event: LightweightSnapshotBoundaryEvent,
) => void;

export interface RoundSnapshotStore {
  capture(
    snapshot: CheckpointSnapshot,
    workspaceMaterial?: unknown,
  ): void | Promise<void>;
  get(roundId: string): CheckpointSnapshot | null | Promise<CheckpointSnapshot | null>;
  restore(roundId: string): CheckpointSnapshot | null | Promise<CheckpointSnapshot | null>;
  prune(policy?: { keep?: number }): void | Promise<void>;
}

const lightweightListeners = new Set<LightweightSnapshotBoundaryListener>();

/**
 * Process-local extension point only. It is intentionally inert by default and keeps no
 * history; consumers may use it to trigger an external snapshot policy later.
 */
export function onLightweightSnapshotBoundary(
  listener: LightweightSnapshotBoundaryListener,
): () => void {
  lightweightListeners.add(listener);
  return () => lightweightListeners.delete(listener);
}

export function emitLightweightSnapshotBoundary(
  event: Omit<LightweightSnapshotBoundaryEvent, 'at'> & { at?: number },
): void {
  if (lightweightListeners.size === 0) return;
  const normalized: LightweightSnapshotBoundaryEvent = {
    ...event,
    at: event.at ?? Date.now(),
  };
  for (const listener of lightweightListeners) {
    try {
      listener(normalized);
    } catch {
      // Snapshot observation must never change Harness execution.
    }
  }
}
