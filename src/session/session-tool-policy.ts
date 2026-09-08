/**
 * 按 session Shell 协作状态选择 Harness ToolSystem。
 *
 * 普通 session 沿用完整 Workspace ToolSystem；Shell 协作 session 使用独立的
 * Registry + Executor，避免普通内置工具和 MCP 工具进入当前轮。
 */

import {
  resolveWorkspaceToolContext,
  type ResolveWorkspaceToolContextParams,
  type ResolvedWorkspaceToolContext,
} from '../harness/workspace-run-context.js';
import { applyUserMessageWorkspaceLock } from '../harness/session-workspace-store.js';
import { buildMcpRuntimeContext } from '../mcp/mcp-runtime-context.js';
import {
  SHELL_COLLAB_TOOL_NAMES,
  createShellCollabTools,
  shellCollabDefinitionsMatchWhitelist,
} from '../tools/shell-collab-tools.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolValidator, createDefaultValidationRules } from '../tools/tool-validator.js';
import { getShellCollabState, loadForSession } from './shell-collab-store.js';
import { getPlanModeState, loadPlanModeForSession } from './plan-mode-store.js';
import { filterPlanModeToolDefinitions } from './plan-mode-tool-policy.js';

export interface ResolvedSessionHarnessToolContext extends ResolvedWorkspaceToolContext {
  shellCollabActive: boolean;
  planModeActive: boolean;
  enableRequestAnalysis: boolean;
  mcpRuntimeContext: Record<string, string>;
}

export async function resolveSessionHarnessToolContext(
  params: ResolveWorkspaceToolContextParams,
): Promise<ResolvedSessionHarnessToolContext> {
  await loadForSession(params.sessionId, params.sessionDir);
  await loadPlanModeForSession(params.sessionId, params.sessionDir);
  const shellCollabActive = getShellCollabState(params.sessionId)?.active === true;
  const planModeActive = !shellCollabActive && getPlanModeState(params.sessionId)?.active === true;

  if (!shellCollabActive) {
    const wsCtx = await resolveWorkspaceToolContext(params);
    const toolDefs = planModeActive
      ? filterPlanModeToolDefinitions(wsCtx.toolDefs)
      : wsCtx.toolDefs;
    return {
      ...wsCtx,
      toolDefs,
      shellCollabActive: false,
      planModeActive,
      enableRequestAnalysis: !planModeActive,
      mcpRuntimeContext: planModeActive
        ? {}
        : buildMcpRuntimeContext(
            params.mcpManager,
            toolDefs.map((tool) => tool.name),
          ),
    };
  }

  const workspace = await applyUserMessageWorkspaceLock({
    sessionDir: params.sessionDir,
    sessionId: params.sessionId,
    userMessage: params.userMessage,
  });
  const effectiveWorkspaceRoot = workspace.state.lockedRoot ?? params.defaultWorkDir;

  const tools = createShellCollabTools({
    sessionId: params.sessionId,
    cwd: effectiveWorkspaceRoot,
  });
  if (!shellCollabDefinitionsMatchWhitelist(tools)) {
    throw new Error(
      `Shell collaboration tool factory must return exactly: ${SHELL_COLLAB_TOOL_NAMES.join(', ')}`,
    );
  }

  const toolRegistry = new ToolRegistry();
  for (const tool of tools) {
    toolRegistry.register(tool);
  }

  const validator = new ToolValidator();
  for (const rule of createDefaultValidationRules()) {
    validator.addGlobalRule(rule);
  }
  const toolExecutor = new ToolExecutor(toolRegistry, undefined, validator);
  const toolDefs = toolRegistry.getDefinitions();

  return {
    workspace,
    effectiveWorkspaceRoot,
    toolExecutor,
    toolRegistry,
    toolDefs,
    shellCollabActive: true,
    planModeActive: false,
    enableRequestAnalysis: false,
    mcpRuntimeContext: {},
  };
}
