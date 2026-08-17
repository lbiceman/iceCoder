import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const INDEX_SOURCE = readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');
const SERVE_SOURCE = readFileSync(path.join(__dirname, '../../src/cli/commands/serve.ts'), 'utf-8');
const BOOTSTRAP_SOURCE = readFileSync(path.join(__dirname, '../../src/cli/bootstrap.ts'), 'utf-8');
const PUBLIC_JS_DIR = path.join(__dirname, '../../src/public/js');

const REQUIRED_API_PREFIXES = [
  '/api/config',
  '/api/tools',
  '/api/remote',
  '/api/sessions',
  '/api/chat',
  '/api/memory/telemetry',
  '/api/supervisor/events',
  '/api/memory/files',
  '/api/skills',
  '/api/mcp',
  '/api/workspace',
  '/api/memory/dream',
  '/api/memory',
];

function mountedApiPaths(source: string): string[] {
  const paths = [...source.matchAll(/path:\s*'(\/api\/[^']+)'/g)].map((m) => m[1]);
  return [...new Set(paths)].sort();
}

function frontendApiPrefixes(): string[] {
  const prefixes = new Set<string>();
  for (const name of readdirSync(PUBLIC_JS_DIR)) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(path.join(PUBLIC_JS_DIR, name), 'utf-8');
    for (const match of source.matchAll(/['"`](\/api\/[A-Za-z0-9/_-]+)/g)) {
      const raw = match[1];
      const known = REQUIRED_API_PREFIXES.find((prefix) => raw === prefix || raw.startsWith(`${prefix}/`));
      prefixes.add(known ?? raw.replace(/\/[^/]+$/, ''));
    }
  }
  return [...prefixes].sort();
}

describe('tgz 与安装包共用同一套 Web 启动', () => {
  it('Electron/npm start 通过 startWebServer + bootstrap，不再手写一份路由', () => {
    expect(INDEX_SOURCE).toMatch(/from '\.\/cli\/bootstrap\.js'/);
    expect(INDEX_SOURCE).toMatch(/bootstrap\(\)/);
    expect(INDEX_SOURCE).toMatch(/startWebServer\(/);
    expect(INDEX_SOURCE).toMatch(/registerWebRuntimeShutdown\(/);
    expect(mountedApiPaths(INDEX_SOURCE)).toEqual([]);
  });

  it('iceCoder web/start 挂载完整 /api 前缀（含 MCP、技能、工作区）', () => {
    const servePaths = mountedApiPaths(SERVE_SOURCE);
    expect(servePaths).toEqual([...REQUIRED_API_PREFIXES].sort());
  });

  it('WebSocket 附加时传入 mcpManager，聊天才能注册 MCP 工具', () => {
    expect(SERVE_SOURCE).toMatch(/attachChatWebSocket\(server,\s*\{[\s\S]*mcpManager/);
  });

  it('前端 fetch 的 /api 前缀都被 startWebServer 挂载', () => {
    const servePaths = mountedApiPaths(SERVE_SOURCE);
    for (const prefix of frontendApiPrefixes()) {
      const covered = servePaths.some((mounted) => prefix === mounted || prefix.startsWith(`${mounted}/`));
      expect({ prefix, covered }).toEqual({ prefix, covered: true });
    }
  });
});

describe('CLI bootstrap 与安装包工具初始化对齐', () => {
  it('initializeToolSystem 传入 llmAdapter（image_read）与 getDefaultWorkDir', () => {
    expect(BOOTSTRAP_SOURCE).toMatch(/initializeToolSystem\(\{[\s\S]*llmAdapter/);
    expect(BOOTSTRAP_SOURCE).toMatch(/workDir:\s*getDefaultWorkDir\(\)/);
  });
});
