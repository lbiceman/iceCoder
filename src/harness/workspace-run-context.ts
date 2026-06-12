import path from 'node:path';

import type { FileParser } from '../parser/file-parser.js';
import type { LLMAdapterInterface, ToolDefinition } from '../llm/types.js';
import { initializeToolSystem } from '../tools/index.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import {
  applyUserMessageWorkspaceLock,
  type ApplyWorkspaceLockResult,
} from './session-workspace-store.js';

export interface ResolveWorkspaceToolContextParams {
  sessionDir: string;
  sessionId: string;
  userMessage: string;
  defaultWorkDir: string;
  defaultToolExecutor: ToolExecutor;
  defaultToolRegistry: ToolRegistry;
  fileParser: FileParser;
  llmAdapter?: LLMAdapterInterface;
}

export interface ResolvedWorkspaceToolContext {
  workspace: ApplyWorkspaceLockResult;
  effectiveWorkspaceRoot: string;
  toolExecutor: ToolExecutor;
  toolRegistry: ToolRegistry;
  toolDefs: ToolDefinition[];
}

/** Web/CLI 共用：解析锁定目录并按需重建 ToolSystem（cwd 与 guard 一致）。 */
export async function resolveWorkspaceToolContext(
  params: ResolveWorkspaceToolContextParams,
): Promise<ResolvedWorkspaceToolContext> {
  const workspace = await applyUserMessageWorkspaceLock({
    sessionDir: params.sessionDir,
    sessionId: params.sessionId,
    userMessage: params.userMessage,
  });

  const effectiveWorkspaceRoot = workspace.state.lockedRoot ?? params.defaultWorkDir;
  const toolSystem = initializeToolSystem({
    workDir: effectiveWorkspaceRoot,
    sessionId: params.sessionId,
    fileParser: params.fileParser,
    llmAdapter: params.llmAdapter,
  });

  return {
    workspace,
    effectiveWorkspaceRoot,
    toolExecutor: toolSystem.executor,
    toolRegistry: toolSystem.registry,
    toolDefs: toolSystem.registry.getDefinitions(),
  };
}
