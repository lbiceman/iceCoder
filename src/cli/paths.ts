/**
 * 统一路径解析模块。
 *
 * 路径查找优先级：
 * 1. 环境变量（ICE_CONFIG_PATH 等）
 * 2. 当前工作目录下的 data/（开发模式）
 * 3. ~/.iceCoder/（全局安装模式）
 *
 * 首次运行时自动创建 ~/.iceCoder/ 并生成默认配置文件。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 用户主目录下的 iceCoder 数据目录 */
const USER_DATA_DIR = path.join(os.homedir(), '.iceCoder');

/** 当前工作目录下的 data 目录 */
const LOCAL_DATA_DIR = path.resolve('data');

/**
 * 判断文件是否存在。
 */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析数据目录：优先本地 data/，回退 ~/.iceCoder/。
 */
async function resolveDataDir(): Promise<string> {
  // 环境变量优先
  if (process.env.ICE_DATA_DIR) {
    return path.resolve(process.env.ICE_DATA_DIR);
  }

  // 本地 data/ 存在（开发模式）
  if (await exists(path.join(LOCAL_DATA_DIR, 'config.json'))) {
    return LOCAL_DATA_DIR;
  }

  // 回退到 ~/.iceCoder/
  return USER_DATA_DIR;
}

/**
 * 所有数据路径。
 */
export interface DataPaths {
  dataDir: string;
  configPath: string;
  systemPromptPath: string;
  sessionsDir: string;
  memoryDir: string;
  memoryFilesDir: string;
  outputDir: string;
}

/**
 * 解析所有数据路径。
 */
export async function resolveDataPaths(): Promise<DataPaths> {
  const dataDir = await resolveDataDir();

  return {
    dataDir,
    configPath: process.env.ICE_CONFIG_PATH ?? path.join(dataDir, 'config.json'),
    systemPromptPath: process.env.ICE_SYSTEM_PROMPT_PATH ?? path.join(dataDir, 'system-prompt.md'),
    sessionsDir: process.env.ICE_SESSIONS_DIR ?? path.join(dataDir, 'sessions'),
    memoryDir: path.join(dataDir, 'memory'),
    memoryFilesDir: process.env.ICE_MEMORY_DIR ?? path.join(dataDir, 'memory-files'),
    outputDir: process.env.ICE_OUTPUT_DIR ?? path.join(dataDir, 'output'),
  };
}

// ── 默认配置文件内容 ──

/** 与 data/config.example.json 一致的 MCP 占位（默认全部 disabled，避免误连网/误启进程） */
export const MCP_SERVERS_TEMPLATE: Record<string, Record<string, unknown>> = {
  memory: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: { MEMORY_FILE_PATH: 'data/mcp-memory.jsonl' },
    disabled: true,
  },
  filesystem: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    disabled: true,
  },
  fetch: {
    command: 'uvx',
    args: ['mcp-server-fetch'],
    disabled: true,
  },
};

const DEFAULT_CONFIG = {
  providers: [
    {
      id: 'default',
      providerName: 'openai',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-your-api-key-here',
      modelName: 'gpt-4o',
      parameters: {
        temperature: 0.7,
        maxTokens: 8192,
      },
      isDefault: true,
    },
  ],
};

export const DEFAULT_SYSTEM_PROMPT = `你是 iceCoder，一个智能编程助手，具备读写文件、执行命令、搜索代码等工具能力。

核心原则：根据任务自主选用工具；修改代码前先看相关文件；完成后按需验证。

自然语言由你与用户共同选择，无强制回复语种。`;

/** MCP 独立配置文件路径（相对当前工作目录，可用 ICE_MCP_CONFIG_PATH 覆盖） */
export function resolveMcpConfigPath(): string {
  if (process.env.ICE_MCP_CONFIG_PATH?.trim()) {
    return path.resolve(process.env.ICE_MCP_CONFIG_PATH.trim());
  }
  return path.join(process.cwd(), '.iceCoder', 'mcp.json');
}

/**
 * 若不存在则创建 `.iceCoder/mcp.json`。
 * 首次创建时：若 `mainConfigPath`（如 data/config.json）中仍有 `mcpServers`，则迁移至该文件；否则写入占位模板。
 */
export async function ensureMcpConfigFile(mainConfigPath?: string): Promise<void> {
  const mcpPath = resolveMcpConfigPath();
  const dir = path.dirname(mcpPath);
  await fs.mkdir(dir, { recursive: true });
  if (await exists(mcpPath)) return;

  if (mainConfigPath && (await exists(mainConfigPath))) {
    try {
      const raw = await fs.readFile(mainConfigPath, 'utf-8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && Object.keys(parsed.mcpServers).length > 0) {
        await fs.writeFile(mcpPath, `${JSON.stringify({ mcpServers: parsed.mcpServers }, null, 2)}\n`, 'utf-8');
        console.log(`[iceCoder] 已从主配置迁移 mcpServers 至 ${mcpPath}`);
        return;
      }
    } catch {
      /* 使用下方占位 */
    }
  }

  const initial = { mcpServers: { ...MCP_SERVERS_TEMPLATE } };
  await fs.writeFile(mcpPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8');
}

/**
 * 首次运行初始化：创建 ~/.iceCoder/ 及默认配置。
 * 返回 true 表示是首次初始化（需要提示用户配置 API Key）。
 */
export async function ensureDataDir(paths: DataPaths): Promise<boolean> {
  let isFirstRun = false;

  // 创建数据目录
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(paths.memoryFilesDir, { recursive: true });
  await fs.mkdir(paths.outputDir, { recursive: true });

  // 创建默认配置文件
  if (!(await exists(paths.configPath))) {
    await fs.writeFile(paths.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    isFirstRun = true;
  }

  await ensureMcpConfigFile(paths.configPath);

  // 创建默认系统提示词
  if (!(await exists(paths.systemPromptPath))) {
    await fs.writeFile(paths.systemPromptPath, DEFAULT_SYSTEM_PROMPT, 'utf-8');
  }

  return isFirstRun;
}
