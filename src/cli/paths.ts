/**
 * 统一路径解析模块。
 *
 * 运行时数据根目录规则：
 * - **全局 / tgz 安装**（`node_modules/ice-coder/dist/cli/` 入口）：`~/.iceCoder/`，与启动 cwd 无关
 * - **源码本地开发**（`tsx src/cli/index.ts`、`npm run dev` 等）：当前项目下的 `data/`
 * - **`NODE_ENV=production`**（如 `npm start`）：`~/.iceCoder/`
 *
 * 显式设置 `ICE_DATA_DIR` 等环境变量时始终优先。
 * 模块加载时会调用 `applyRuntimeDataEnvDefaults()`，保证 Web/CLI 子模块读到一致路径。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { IceCoderConfigFile } from '../web/types.js';
import { DEFAULT_SHELL_BLACKLIST_PATTERNS } from '../tools/shell-sandbox.js';

/** 用户主目录下的 iceCoder 数据目录（生产环境） */
export const USER_DATA_DIR = path.join(os.homedir(), '.iceCoder');

/** 当前工作目录下的 data 目录（开发环境） */
export const LOCAL_DATA_DIR = path.resolve('data');

/** 生产环境：NODE_ENV=production */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** 从 `npm install -g` / tgz 安装的 `iceCoder` CLI 入口（含 npm link 到包目录）。 */
export function isPackagedCliEntry(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
  return entry.includes('/node_modules/ice-coder/dist/cli/');
}

/** Electron 打包应用内嵌 server（由主进程设置 ICE_ELECTRON=1）。 */
export function isElectronRuntime(): boolean {
  return process.env.ICE_ELECTRON === '1';
}

/** 数据根使用 `~/.iceCoder`（全局安装或 production），否则用项目 `data/`。 */
export function usesUserDataRoot(): boolean {
  return isProductionRuntime() || isPackagedCliEntry() || isElectronRuntime();
}

function defaultDataDirForRuntime(): string {
  return usesUserDataRoot() ? USER_DATA_DIR : LOCAL_DATA_DIR;
}

/**
 * 在未显式指定时，同步写入 ICE_* 环境变量。
 * 须在依赖 `data/` 硬编码路径的模块 import 之前加载本文件。
 */
export function applyRuntimeDataEnvDefaults(): void {
  if (!process.env.ICE_DATA_DIR?.trim()) {
    process.env.ICE_DATA_DIR = defaultDataDirForRuntime();
  }

  const dataDir = path.resolve(process.env.ICE_DATA_DIR);

  if (!process.env.ICE_CONFIG_PATH?.trim()) {
    process.env.ICE_CONFIG_PATH = path.join(dataDir, 'config.json');
  }
  if (!process.env.ICE_SESSIONS_DIR?.trim()) {
    process.env.ICE_SESSIONS_DIR = path.join(dataDir, 'sessions');
  }
  if (!process.env.ICE_MEMORY_DIR?.trim()) {
    process.env.ICE_MEMORY_DIR = path.join(dataDir, 'memory-files');
  }
  if (!process.env.ICE_OUTPUT_DIR?.trim()) {
    process.env.ICE_OUTPUT_DIR = path.join(dataDir, 'output');
  }
  if (!process.env.ICE_USER_MEMORY_DIR?.trim()) {
    process.env.ICE_USER_MEMORY_DIR = path.join(dataDir, 'user-memory');
  }
  if (!process.env.ICE_SKILLS_DIR?.trim()) {
    process.env.ICE_SKILLS_DIR = path.join(dataDir, 'skills');
  }
  if (!process.env.ICE_MCP_CONFIG_PATH?.trim()) {
    process.env.ICE_MCP_CONFIG_PATH = path.join(dataDir, 'mcp.json');
  }
  if (!process.env.ICE_SUPERVISOR_CONFIG_PATH?.trim()) {
    process.env.ICE_SUPERVISOR_CONFIG_PATH = path.join(dataDir, 'supervisor-config.json');
  }
}

export function getRuntimeDataDir(): string {
  applyRuntimeDataEnvDefaults();
  return path.resolve(process.env.ICE_DATA_DIR!);
}

/** 生产环境：OS 用户缓存根（与 ~/.iceCoder 数据目录分离） */
export function getUserCacheDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'iceCoder', 'cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'iceCoder');
  }
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(xdg, 'iceCoder');
}

/** 聊天粘贴图落盘根：与 `getRuntimeDataDir()` 一致（`{dataDir}/imagesCache/...`）。 */
export function getImagesCacheStorageRoot(): string {
  applyRuntimeDataEnvDefaults();
  return getRuntimeDataDir();
}

/** `{storageRoot}/imagesCache/{sessionId}` */
export function getImagesCacheSessionDir(sessionId: string): string {
  return path.join(getImagesCacheStorageRoot(), 'imagesCache', sessionId);
}

/** `{dataDir}/memory` 下的子路径（telemetry、dream-state 等） */
export function getRuntimeMemoryAuxPath(...segments: string[]): string {
  return path.join(getRuntimeDataDir(), 'memory', ...segments);
}

/**
 * 所有数据路径。
 */
export interface DataPaths {
  dataDir: string;
  configPath: string;
  supervisorConfigPath: string;
  systemPromptPath: string;
  sessionsDir: string;
  memoryDir: string;
  memoryFilesDir: string;
  outputDir: string;
  userMemoryDir: string;
  skillsDir: string;
  mcpConfigPath: string;
}

/** npm pack / 全局安装包内 `data/` 示例文件（相对 dist/cli/paths.js → ../../data/） */
export function resolvePackagedDataExamplePath(filename: string): string {
  return resolvePackagedDataDir(filename);
}

/** npm pack / 全局安装包内 `data/` 下的文件或子目录 */
export function resolvePackagedDataDir(relativePath: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../data', relativePath);
}

export function resolveSupervisorConfigPath(): string {
  applyRuntimeDataEnvDefaults();
  return path.resolve(process.env.ICE_SUPERVISOR_CONFIG_PATH!);
}

/**
 * 解析所有数据路径。
 */
export async function resolveDataPaths(): Promise<DataPaths> {
  applyRuntimeDataEnvDefaults();
  const dataDir = getRuntimeDataDir();

  return {
    dataDir,
    configPath: path.resolve(process.env.ICE_CONFIG_PATH!),
    supervisorConfigPath: resolveSupervisorConfigPath(),
    systemPromptPath: process.env.ICE_SYSTEM_PROMPT_PATH
      ? path.resolve(process.env.ICE_SYSTEM_PROMPT_PATH)
      : path.join(dataDir, 'system-prompt.md'),
    sessionsDir: path.resolve(process.env.ICE_SESSIONS_DIR!),
    memoryDir: path.join(dataDir, 'memory'),
    memoryFilesDir: path.resolve(process.env.ICE_MEMORY_DIR!),
    outputDir: path.resolve(process.env.ICE_OUTPUT_DIR!),
    userMemoryDir: path.resolve(process.env.ICE_USER_MEMORY_DIR!),
    skillsDir: path.resolve(process.env.ICE_SKILLS_DIR!),
    mcpConfigPath: resolveMcpConfigPath(),
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

const DEFAULT_CONFIG: IceCoderConfigFile = {
  supervisorMode: 'adaptive',
  shellBlacklist: [...DEFAULT_SHELL_BLACKLIST_PATTERNS],
  providers: [
    {
      id: 'default',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-your-api-key-here',
      modelName: 'gpt-4o',
      parameters: {
        temperature: 0.7,
        maxTokens: 16384,
      },
      isDefault: true,
    },
  ],
};

export const DEFAULT_SYSTEM_PROMPT = `你是 iceCoder，一个智能编程助手，具备读写文件、执行命令、搜索代码等工具能力。

核心原则：根据任务自主选用工具；修改代码前先看相关文件；完成后按需验证。

自然语言由你与用户共同选择，无强制回复语种。`;

/**
 * MCP 独立配置文件路径。
 * 开发/生产均落在数据根目录下的 `mcp.json`（可用 ICE_MCP_CONFIG_PATH 覆盖）。
 */
export function resolveMcpConfigPath(): string {
  applyRuntimeDataEnvDefaults();
  if (process.env.ICE_MCP_CONFIG_PATH?.trim()) {
    return path.resolve(process.env.ICE_MCP_CONFIG_PATH.trim());
  }
  return path.join(getRuntimeDataDir(), 'mcp.json');
}

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
 * 若不存在则创建 `mcp.json`。
 * 首次创建时：若主配置中仍有 `mcpServers`，则迁移；否则写入占位模板。
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
 * 首次运行初始化：创建数据目录及默认配置。
 * 返回 true 表示是首次初始化（需要提示用户配置 API Key）。
 */
export async function ensureDataDir(paths: DataPaths): Promise<boolean> {
  let isFirstRun = false;

  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(paths.memoryFilesDir, { recursive: true });
  await fs.mkdir(paths.userMemoryDir, { recursive: true });
  await fs.mkdir(paths.skillsDir, { recursive: true });
  await fs.mkdir(paths.outputDir, { recursive: true });
  await fs.mkdir(path.join(paths.dataDir, 'imagesCache'), { recursive: true });

  if (!(await exists(paths.configPath))) {
    await fs.writeFile(paths.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    isFirstRun = true;
  }

  await ensureMcpConfigFile(paths.configPath);

  if (!(await exists(paths.systemPromptPath))) {
    await fs.writeFile(paths.systemPromptPath, DEFAULT_SYSTEM_PROMPT, 'utf-8');
  }

  await ensureSupervisorConfigFile(paths.dataDir);
  await ensureDefaultSkillFiles(paths.skillsDir);

  return isFirstRun;
}

const SUPERVISOR_CONFIG_EXAMPLE = 'supervisor-config.example.json';

/**
 * 若不存在则从包内示例写入 `{dataDir}/supervisor-config.json`（全局安装 → ~/.iceCoder/）。
 */
export async function ensureSupervisorConfigFile(dataDir: string): Promise<void> {
  const target = path.join(dataDir, 'supervisor-config.json');
  if (await exists(target)) return;

  const bundled = resolvePackagedDataExamplePath(SUPERVISOR_CONFIG_EXAMPLE);
  let content: string;
  if (await exists(bundled)) {
    content = await fs.readFile(bundled, 'utf-8');
  } else {
    const localExample = path.join(LOCAL_DATA_DIR, SUPERVISOR_CONFIG_EXAMPLE);
    const localConfig = path.join(LOCAL_DATA_DIR, 'supervisor-config.json');
    if (await exists(localExample)) {
      content = await fs.readFile(localExample, 'utf-8');
    } else if (await exists(localConfig)) {
      content = await fs.readFile(localConfig, 'utf-8');
    } else {
      console.warn(
        `[iceCoder] 未找到 ${SUPERVISOR_CONFIG_EXAMPLE}，跳过写入 supervisor-config.json（将使用内置默认）`,
      );
      return;
    }
  }

  await fs.mkdir(path.join(dataDir, 'runtime'), { recursive: true });
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  await fs.writeFile(target, normalized, 'utf-8');
  console.log(`[iceCoder] 已初始化 ${target}`);
}

const BUNDLED_SKILLS_DIR = 'skills';
const DEFAULT_SKILL_FILE = '创建技能.md';

/**
 * 若不存在则从包内写入 `{skillsDir}/创建技能.md`（全局安装 → ~/.iceCoder/skills/）。
 */
export async function ensureDefaultSkillFiles(skillsDir: string): Promise<void> {
  await fs.mkdir(skillsDir, { recursive: true });

  const target = path.join(skillsDir, DEFAULT_SKILL_FILE);
  if (await exists(target)) return;

  const bundled = resolvePackagedDataDir(path.join(BUNDLED_SKILLS_DIR, DEFAULT_SKILL_FILE));
  const localBundled = path.join(LOCAL_DATA_DIR, BUNDLED_SKILLS_DIR, DEFAULT_SKILL_FILE);
  let content: string | null = null;
  if (await exists(bundled)) {
    content = await fs.readFile(bundled, 'utf-8');
  } else if (await exists(localBundled)) {
    content = await fs.readFile(localBundled, 'utf-8');
  } else {
    console.warn(
      `[iceCoder] 未找到 ${DEFAULT_SKILL_FILE}，跳过默认技能初始化`,
    );
    return;
  }

  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  await fs.writeFile(target, normalized, 'utf-8');
  console.log(`[iceCoder] 已初始化技能 ${target}`);
}

applyRuntimeDataEnvDefaults();
