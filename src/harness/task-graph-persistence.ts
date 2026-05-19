/**
 * TaskGraph Persistence — 持久化辅助函数。
 *
 * 提供 TaskGraph 与 Session Notes 之间的 fence 格式读写，
 * 以及 checkpoint 持久化所需的序列化/反序列化。
 *
 * Fence 格式：```<lang>\n<json>\n```
 *
 * 依赖：Phase 1 (types), Phase 2 (snapshot)
 */

import type {
  TaskGraphSnapshot,
  GraphMetrics,
  GraphSession,
  GraphDebugDump,
} from '../types/task-graph.js';
import { TASK_GRAPH_SCHEMA_VERSION } from '../types/task-graph.js';

// ═══════════════════════════════════════════════
// Fence Lang Identifiers
// ═══════════════════════════════════════════════

export const ICECODER_GRAPH_FENCE_LANG = 'icecoder-graph';
export const ICECODER_METRICS_FENCE_LANG = 'icecoder-metrics';
export const ICECODER_DEBUG_FENCE_LANG = 'icecoder-debug';

// ═══════════════════════════════════════════════
// Serialization
// ═══════════════════════════════════════════════

export function serializeGraphSnapshot(snapshot: TaskGraphSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function serializeMetrics(metrics: GraphMetrics): string {
  return JSON.stringify(metrics, null, 2);
}

export function serializeDebugDump(dump: GraphDebugDump): string {
  return JSON.stringify(dump, null, 2);
}

// ═══════════════════════════════════════════════
// Deserialization
// ═══════════════════════════════════════════════

export function deserializeGraphSnapshot(json: string): TaskGraphSnapshot | null {
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object' || obj.version !== TASK_GRAPH_SCHEMA_VERSION) {
      return null;
    }
    return obj as TaskGraphSnapshot;
  } catch {
    return null;
  }
}

export function deserializeMetrics(json: string): GraphMetrics | null {
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    return obj as GraphMetrics;
  } catch {
    return null;
  }
}

export function deserializeDebugDump(json: string): GraphDebugDump | null {
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    return obj as GraphDebugDump;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════
// Fence Builders
// ═══════════════════════════════════════════════

export function buildGraphFence(snapshot: TaskGraphSnapshot): string {
  const json = serializeGraphSnapshot(snapshot);
  return `\`\`\`${ICECODER_GRAPH_FENCE_LANG}\n${json}\n\`\`\``;
}

export function buildMetricsFence(metrics: GraphMetrics): string {
  const json = serializeMetrics(metrics);
  return `\`\`\`${ICECODER_METRICS_FENCE_LANG}\n${json}\n\`\`\``;
}

export function buildDebugFence(dump: GraphDebugDump): string {
  const json = serializeDebugDump(dump);
  return `\`\`\`${ICECODER_DEBUG_FENCE_LANG}\n${json}\n\`\`\``;
}

// ═══════════════════════════════════════════════
// Fence Parsers (from Session Notes)
// ═══════════════════════════════════════════════

function extractFence(notes: string, lang: string): string | null {
  const pattern = new RegExp(
    `\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``,
    'i',
  );
  const match = notes.match(pattern);
  return match?.[1]?.trim() ?? null;
}

export function parseGraphFence(notes: string): TaskGraphSnapshot | null {
  const json = extractFence(notes, ICECODER_GRAPH_FENCE_LANG);
  if (!json) return null;
  return deserializeGraphSnapshot(json);
}

export function parseMetricsFence(notes: string): GraphMetrics | null {
  const json = extractFence(notes, ICECODER_METRICS_FENCE_LANG);
  if (!json) return null;
  return deserializeMetrics(json);
}

export function parseDebugFence(notes: string): GraphDebugDump | null {
  const json = extractFence(notes, ICECODER_DEBUG_FENCE_LANG);
  if (!json) return null;
  return deserializeDebugDump(json);
}

// ═══════════════════════════════════════════════
// Convenience: parse all from session notes
// ═══════════════════════════════════════════════

export interface PersistedTaskGraphData {
  graph: TaskGraphSnapshot | null;
  metrics: GraphMetrics | null;
  debug: GraphDebugDump | null;
}

export function parsePersistedTaskGraph(notes: string): PersistedTaskGraphData {
  return {
    graph: parseGraphFence(notes),
    metrics: parseMetricsFence(notes),
    debug: parseDebugFence(notes),
  };
}
