import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../src/web');

function read(name: string): string {
  return readFileSync(path.join(ROOT, name), 'utf-8');
}

const MAIN = read('chat-ws.ts');
const RUNTIME = read('chat-ws-runtime.ts');
const INBOUND = read('chat-ws-inbound.ts');
const TURN = read('chat-ws-turn.ts');
const LOOP = read('chat-ws-loop.ts');
const PERSIST = read('chat-ws-persist.ts');
const BROADCAST = read('chat-ws-broadcast.ts');
const CONFIRM = read('chat-ws-confirm.ts');

const PUBLIC_EXPORTS = [
  'attachChatWebSocket',
  'cleanupChatResources',
  'broadcastMcpReady',
  'broadcastTunnelReady',
  'getActiveSessionId',
  'getProcessingSessionIds',
  'purgeSessionRuntimeCaches',
  'notifyTaskQueueUpdated',
  'getSessionsDir',
  'isSessionTombstoned',
  'ChatWSOptions',
];

const INBOUND_TYPES = [
  'ping',
  'clear_session',
  'confirm_reply',
  'stop',
  'bg_task_stop',
  'ack_session_run',
  'restore_runtime',
  'delete_user_message',
  'switch_session',
];

function chatWsModuleFiles(): string[] {
  return readdirSync(ROOT).filter((name) => /^chat-ws.*\.ts$/.test(name));
}

function localChatWsImports(source: string): string[] {
  const hits: string[] = [];
  const re = /from ['"]\.\/(chat-ws-[a-z0-9-]+)\.js['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) hits.push(m[1]);
  return hits;
}

function hasCycle(graph: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    if (visiting.has(node)) {
      const i = stack.indexOf(node);
      return [...stack.slice(i), node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cyc = dfs(next);
      if (cyc) return cyc;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cyc = dfs(node);
    if (cyc) return cyc;
  }
  return null;
}

describe('chat-ws 拆分', () => {
  it('chat-ws.ts 仍 export 对外 API', () => {
    for (const name of PUBLIC_EXPORTS) {
      expect(MAIN).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('chat-ws-runtime.ts 的 import 列表不含 ./chat-ws-', () => {
    const importLines = RUNTIME.split('\n').filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/from ['"]\.\/chat-ws-/);
    }
  });

  it('主文件不再含已迁出的入站 type 分支', () => {
    for (const type of INBOUND_TYPES) {
      expect(MAIN).not.toContain(`msg.type === '${type}'`);
    }
    expect(MAIN).not.toContain("msg.type === 'message'");
  });

  it('9 个入站 type 在 inbound 各出现一次', () => {
    for (const type of INBOUND_TYPES) {
      const matches = INBOUND.match(new RegExp(`msg\\.type === '${type}'`, 'g')) ?? [];
      expect(matches, type).toHaveLength(1);
    }
    const messageMatches = INBOUND.match(/msg\.type === 'message'/g) ?? [];
    expect(messageMatches).toHaveLength(1);
  });

  it('new Harness( 只出现在 chat-ws-turn.ts', () => {
    expect(TURN).toMatch(/new Harness\(/);
    expect(MAIN).not.toMatch(/new Harness\(/);
    expect(INBOUND).not.toMatch(/new Harness\(/);
    expect(LOOP).not.toMatch(/new Harness\(/);
  });

  it('主文件行数 ≤ 600', () => {
    const lines = MAIN.split('\n').length;
    expect(lines).toBeLessThanOrEqual(600);
  });

  it('appendMessages / broadcastToSession / resolveConfirm 各只有一处定义', () => {
    const files = chatWsModuleFiles();
    const counts = { appendMessages: 0, broadcastToSession: 0, resolveConfirm: 0 };
    for (const name of files) {
      const src = read(name);
      if (/(?:^|\n)export async function appendMessages\(/.test(src)) {
        counts.appendMessages += 1;
      }
      if (/(?:^|\n)export function broadcastToSession\(/.test(src)) {
        counts.broadcastToSession += 1;
      }
      if (/(?:^|\n)export function resolveConfirm\(/.test(src)) {
        counts.resolveConfirm += 1;
      }
    }
    expect(counts).toEqual({ appendMessages: 1, broadcastToSession: 1, resolveConfirm: 1 });
    expect(PERSIST).toMatch(/export async function appendMessages\(/);
    expect(BROADCAST).toMatch(/export function broadcastToSession\(/);
    expect(CONFIRM).toMatch(/export function resolveConfirm\(/);
  });

  it('chat-ws-* 模块 import 图无环', () => {
    const graph = new Map<string, string[]>();
    for (const file of chatWsModuleFiles()) {
      const id = file.replace(/\.ts$/, '');
      graph.set(id, localChatWsImports(read(file)));
    }
    expect(hasCycle(graph)).toBeNull();
  });

  it('purge 先杀 shell 再 abort harness', () => {
    const stopAt = MAIN.indexOf("stopAllShellWorkForSession(sessionId, 'session delete')");
    const abortAt = MAIN.indexOf('dropSessionRunLocks(sessionId)');
    expect(stopAt).toBeGreaterThan(0);
    expect(abortAt).toBeGreaterThan(stopAt);
  });

  it('出站 type 字符串不丢失', () => {
    const src = chatWsModuleFiles().map(read).join('\n');
    const types = new Set<string>();
    const re = /type:\s*'([a-zA-Z_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) types.add(m[1]);
    const required = [
      'connected', 'pong', 'status', 'error', 'info',
      'session_cleared', 'session_switched', 'session_updated',
      'sessions_index_updated',
      'restore_failed', 'runtime_restored',
      'delete_message_failed', 'message_deleted',
      'also_rejected', 'also_note_appended',
      'confirm', 'confirm_resolved', 'confirm_timeout',
      'bg_task_stop_result',
      'user_message_appended', 'task_queue_updated',
      'shell_collab_entered', 'shell_collab_resumed',
      'harness_state', 'workspace_updated',
      'checkpoint_captured', 'checkpoint_capture_failed',
      'step', 'stream', 'reasoning_stream', 'stream_end',
      'tool_output', 'response', 'tokenUsage', 'pulse',
      'memory_notice', 'mcp_ready', 'tunnel_ready',
    ];
    for (const t of required) {
      expect(types.has(t), t).toBe(true);
    }
  });

  it('saveStructuredMessages 写 structuredCache.set 而非 setCachedMessages', () => {
    const fn = PERSIST.slice(PERSIST.indexOf('export function saveStructuredMessages'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toContain('structuredCache.set(');
    expect(body).not.toContain('setCachedMessages(');
  });

  it('serve / bootstrap / sessions 只从 chat-ws.ts 公共入口导入', () => {
    const repo = path.join(__dirname, '../..');
    const serve = readFileSync(path.join(repo, 'src/cli/commands/serve.ts'), 'utf-8');
    const bootstrap = readFileSync(path.join(repo, 'src/cli/bootstrap.ts'), 'utf-8');
    const sessions = readFileSync(path.join(repo, 'src/web/routes/sessions.ts'), 'utf-8');
    expect(serve).toMatch(/from ['"][^'"]*web\/chat-ws\.js['"]/);
    expect(serve).not.toMatch(/chat-ws-/);
    expect(bootstrap).toMatch(/from ['"][^'"]*web\/chat-ws\.js['"]/);
    expect(bootstrap).not.toMatch(/chat-ws-/);
    expect(sessions).toMatch(/import\(['"]\.\.\/chat-ws\.js['"]\)/);
    expect(sessions).not.toMatch(/chat-ws-/);
  });

  it('file-browser 旁路在 new Harness 之前', () => {
    const directAt = TURN.indexOf('tryDirectFileBrowserTurn(');
    const harnessAt = TURN.indexOf('new Harness(');
    expect(directAt).toBeGreaterThan(0);
    expect(harnessAt).toBeGreaterThan(directAt);
  });
});
