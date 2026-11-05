/**
 * 用户 Agent 落在数据目录 `agents/<id>.json`。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { applyRuntimeDataEnvDefaults, REPO_DATA_DIR, resolvePackagedDataDir } from '../cli/paths.js';
import {
  AgentWriteError,
  isAgentProfile,
  parseAgentDraft,
  type AgentDraft,
  type AgentProfile,
} from './agent-profile.js';

export function getAgentsDir(): string {
  applyRuntimeDataEnvDefaults();
  const configured = process.env.ICE_AGENTS_DIR?.trim();
  if (configured) return path.resolve(configured);
  const dataDir = process.env.ICE_DATA_DIR?.trim();
  if (!dataDir) throw new Error('ICE_DATA_DIR is required for agents');
  return path.join(path.resolve(dataDir), 'agents');
}

function fileFor(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

async function readProfileFile(file: string): Promise<AgentProfile | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
    if (!isAgentProfile(parsed)) return null;
    return {
      id: parsed.id,
      name: parsed.name.trim(),
      description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
      prompt: parsed.prompt.trim(),
      tools: parsed.tools.map((name) => name.trim()).filter(Boolean),
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export async function listAgents(dir = getAgentsDir()): Promise<AgentProfile[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const agents: AgentProfile[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const profile = await readProfileFile(path.join(dir, name));
    if (profile && profile.id === name.slice(0, -'.json'.length)) agents.push(profile);
  }
  agents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return agents;
}

export async function readAgent(id: string, dir = getAgentsDir()): Promise<AgentProfile | null> {
  return readProfileFile(fileFor(dir, id));
}

async function writeProfile(dir: string, profile: AgentProfile): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = fileFor(dir, profile.id);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(profile, null, 2)}\n`, 'utf-8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

export async function createAgent(body: AgentDraft, dir = getAgentsDir()): Promise<AgentProfile> {
  const draft = parseAgentDraft(body);
  const existing = await readAgent(draft.id, dir);
  if (existing) throw new AgentWriteError(`命令「${draft.id}」已存在`, 409);
  const now = new Date().toISOString();
  const profile: AgentProfile = { ...draft, createdAt: now, updatedAt: now };
  await writeProfile(dir, profile);
  return profile;
}

export async function updateAgent(
  id: string,
  body: AgentDraft,
  dir = getAgentsDir(),
): Promise<AgentProfile> {
  const current = await readAgent(id, dir);
  if (!current) throw new AgentWriteError(`Agent 不存在：${id}`, 404);
  const draft = parseAgentDraft(body, id);
  const profile: AgentProfile = {
    ...draft,
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeProfile(dir, profile);
  return profile;
}

export const PLAN_AGENT_ID = 'plan';

const PLAN_AGENT_TOOLS = [
  'read_file',
  'glob',
  'grep',
  'file_info',
  'list_drives',
  'browse_directory',
  'open_file',
  'fetch_url',
  'web_search',
  'parse_document',
  'parse_pptx_deep',
  'parse_xlsx_deep',
  'parse_xmind_deep',
  'parse_doc_legacy',
  'notebook_read',
  'image_read',
  'env_info',
  'diff_files',
  'write_file',
  'edit_file',
  'append_file',
  'patch_file',
  'batch_edit_file',
] as const;

const PLAN_AGENT_PROMPT = `You are in planning mode. Do not modify application or source code.

You may read and search the repository, browse files, fetch docs, and parse documents.
You may write or update documentation only: .md, .markdown, .mdx, .txt, .rst, .adoc, .asciidoc.
Do not edit code or config. Do not run commands.

How to work:
1. If the goal, constraints, current gaps, or acceptance criteria are missing, ask the user before inventing them.
2. Propose or reuse a document path (for example docs/plan-<topic>.md) and keep the plan there.
3. Structure the document: Goal, Current state / gaps, Proposed steps, Acceptance criteria, Open questions.
4. When the document is good enough, tell the user to leave this agent (the chip ×, or /plan exit) and then continue in the default agent to implement from that document.

If the user asks you to implement, refactor, run commands, or commit: refuse, explain the restriction, and point them to the document plus leaving this agent.`;

const BUNDLED_PLAN_FILE = 'agents/plan.json';

async function readBundledPlanFile(): Promise<string | null> {
  const candidates = [
    resolvePackagedDataDir(BUNDLED_PLAN_FILE),
    path.join(REPO_DATA_DIR, BUNDLED_PLAN_FILE),
  ];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf-8');
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/** 包内 plan.json 可用时原样复制。文件缺失或内容不合法时，用内置定义补上。 */
async function defaultPlanAgentText(): Promise<string> {
  const bundled = await readBundledPlanFile();
  if (bundled) {
    try {
      const parsed: unknown = JSON.parse(bundled);
      if (isAgentProfile(parsed) && parsed.id === PLAN_AGENT_ID) {
        return bundled.endsWith('\n') ? bundled : `${bundled}\n`;
      }
    } catch {
      /* 落到内置定义 */
    }
  }
  const now = new Date().toISOString();
  const profile: AgentProfile = {
    id: PLAN_AGENT_ID,
    name: 'Plan',
    description: '只读仓库并编写方案文档，不改代码、不执行命令',
    prompt: PLAN_AGENT_PROMPT,
    tools: [...PLAN_AGENT_TOOLS],
    createdAt: now,
    updatedAt: now,
  };
  return `${JSON.stringify(profile, null, 2)}\n`;
}

/** 首次没有 plan.json 时从包内模板写入。用户删掉之后不再补回。 */
export async function ensureDefaultPlanAgent(dir = getAgentsDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = fileFor(dir, PLAN_AGENT_ID);
  try {
    await fs.access(file);
    return;
  } catch {
    /* 不存在才写入 */
  }
  await fs.writeFile(file, await defaultPlanAgentText(), 'utf-8');
}

export async function deleteAgent(id: string, dir = getAgentsDir()): Promise<void> {
  try {
    await fs.unlink(fileFor(dir, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentWriteError(`Agent 不存在：${id}`, 404);
    }
    throw error;
  }
}
