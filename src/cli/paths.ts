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
  mcpServers: {},
};

const DEFAULT_SYSTEM_PROMPT = `你是 iceCoder，一个智能编程助手。你拥有丰富的工具能力，可以读写文件、执行命令、搜索代码、访问网页等。

核心原则：
- 根据用户需求自主决定使用哪些工具
- 先理解问题，再动手解决
- 修改代码前先阅读相关文件
- 完成后验证结果

回答使用中文。
`;

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

  // 创建默认系统提示词
  if (!(await exists(paths.systemPromptPath))) {
    await fs.writeFile(paths.systemPromptPath, DEFAULT_SYSTEM_PROMPT, 'utf-8');
  }

  return isFirstRun;
}
