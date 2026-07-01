import type { FileParser } from '../parser/file-parser.js';
import type { LLMAdapterInterface, ToolDefinition } from '../llm/types.js';
import type { MCPManager } from '../mcp/mcp-manager.js';
import { registerMcpToolsOnRegistry } from '../mcp/start-mcp-background.js';
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
  /** 传入后会把已就绪的 MCP 工具合并进本次 run 的 registry */
  mcpManager?: MCPManager;
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

  if (params.mcpManager) {
    await params.mcpManager.whenReady();
    registerMcpToolsOnRegistry(toolSystem.registry, params.mcpManager);
  }

  return {
    workspace,
    effectiveWorkspaceRoot,
    toolExecutor: toolSystem.executor,
    toolRegistry: toolSystem.registry,
    toolDefs: toolSystem.registry.getDefinitions(),
  };
}
