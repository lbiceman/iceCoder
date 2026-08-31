/**
 * chat-ws 一轮对话：拼 Harness、跑循环、推 step、落盘。
 * 本文件是 chat-ws 目录里唯一允许 `new Harness` 的模块。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Harness } from '../harness/harness.js';
import { buildTotalTokenUsageWithContext } from '../harness/context-usage-display.js';
import { evaluateIncompleteTaskStopHook } from '../harness/incomplete-task-stop-hook.js';
import type { HarnessConfig, StopReason } from '../harness/types.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MCPManager } from '../mcp/mcp-manager.js';
import { resolveSessionHarnessToolContext } from '../session/session-tool-policy.js';
import {
  selectToolsForOffering,
  lazyToolOfferingLogEnabled,
  DEFERRED_TOOLS,
  buildAvailableDocToolsContext,
} from '../tools/tool-offering-selector.js';
import { addSessionReferenceReads } from '../harness/session-workspace-store.js';
import { loadMemoryPrompt } from '../memory/file-memory/index.js';
import { resolveFileReferences } from './routes/upload.js';
import { shouldDisableRuntimeTools } from '../prompts/load-chat-prompt.js';
import { assembleShellCollabPrompt } from '../prompts/shell-collab-prompt.js';
import { harnessOverlayToContextFields } from '../prompts/prompt-assembler.js';
import {
  getHarnessMaxRoundsFromEnv,
  getHarnessTimeoutMsFromEnv,
  getHarnessTokenBudget,
} from '../harness/token-budget-config.js';
import { readSkipPermissionChecksFromMainConfig } from '../config/main-config-supervisor-mode.js';
import { readVerificationExemptDirsFromMainConfig } from '../harness/verification-exempt-config.js';
import { resolveDefaultChatModelMeta, resolveDefaultSupportsVision } from './routes/config.js';
import {
  buildUserMessageWithImages,
  persistInlineImages,
  persistUploadedImageFiles,
  buildSessionImageApiUrl,
  resolveSessionImageFile,
} from './images-cache.js';
import {
  detectFileBrowserOpen,
  looksLikeFileAnalysisIntent,
  tryDirectFileBrowserTurn,
} from './file-browser-direct.js';
import { getDefaultWorkDir } from '../cli/paths.js';
import { getSkillRegistry } from '../core/skill-registry.js';
import { setActiveAlsoRun, clearPendingNoteForRun } from '../session/pending-note.js';
import { resolveShellCollabActive } from '../session/shell-collab-store.js';
import { stopForegroundShellWorkForSession } from '../tools/session-shell-control.js';
import { extractDiffSource } from './tool-display-extract.js';
import { resolveToolCallInitialStatus } from './tool-trace-format.js';
import { capToolTraceDiffSource, resolveToolDiffForSession } from './session-tool-trace-diffs.js';
import { applyFirstPromptSessionTitle } from './session-title.js';
import { buildUserMessageDisplayFields } from './user-message-display.js';
import {
  captureIntentCheckpoint,
  readUiSessionMessages,
} from '../harness/intent-checkpoint-capture.js';
import {
  beginIntentCheckpointTurn,
  finalizeIntentCheckpointTurn,
} from '../harness/intent-checkpoint-turn-snapshot.js';
import { flushStructuredSessionToDisk } from './session-structured-io.js';
import { isSessionImageApiUrl, stripReferencePathLinesForWorkspaceLock } from './chat-ws-helpers.js';
import {
  broadcastSessionUpdated,
  broadcastToSession,
  isWsSubscribedTo,
} from './chat-ws-broadcast.js';
import { createShellMandatoryConfirmHandler, createToolConfirmHandler } from './chat-ws-confirm.js';
import { rebindBgTaskPusher } from './chat-ws-bg-tasks.js';
import {
  appendMessages,
  broadcastHarnessState,
  ensureMemoryInitialized,
  getGlobalFileMemoryManager,
  getPriorTrackedPaths,
  loadAssembledPrompt,
  saveStructuredMessages,
} from './chat-ws-persist.js';
import {
  clearRunningTurn,
  ensureRunningTurn,
  foldStepIntoRunningTurn,
  getRunningTurn,
  recordPersistedToolTraceDiff,
  toolArgsDetailPreview,
  toolResultStatusPreview,
} from './chat-ws-running-turn.js';
import {
  DEFAULT_WORK_DIR,
  MAIN_CONFIG_PATH,
  MEMORY_DIR,
  SESSIONS_DIR,
  getCachedMessages,
  getFileBrowserState,
  getSessionDeferredToolCalls,
  getSupervisorRuntime,
  isSessionTombstoned,
  recordSessionDeferredToolCall,
  sessionAbortControllers,
  setCachedMessages,
} from './chat-ws-runtime.js';

export interface ToolTraceBatchEntry {
  toolName: string;
  detail: string;
  status: string;
  toolCallId?: string;
  /** 供刷新后 UI 还原 diff 面板（不依赖 .structured.json 对齐） */
  diffSource?: string | null;
}

export interface HandleChatMessageInput {
  ws: WebSocket;
  message: string;
  runSessionId: string;
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  mcpManager?: MCPManager;
  images?: string[];
  referencePaths?: string[];
  clientMessageId?: string | null;
  skipUserMessageAppend?: boolean;
  source?: 'implicit' | 'explicit';
}

/** 目录列举确定性回合结束：更新结构化缓存、持久化、推送 WS（无 LLM） */
async function finalizeDirectBrowserTurn(
  ws: WebSocket,
  opts: {
    userStructuredContent: string;
    assistantContent: string;
    toolTraceBatch: ToolTraceBatchEntry[];
    syntheticTool?: { toolName: string; toolDetail: string; success: boolean };
    sessionId: string;
  },
): Promise<void> {
  const sid = opts.sessionId;
  const cached = getCachedMessages(sid);
  const base = cached ? [...cached] : [];
  base.push({ role: 'user', content: opts.userStructuredContent });
  base.push({ role: 'assistant', content: opts.assistantContent });
  setCachedMessages(sid, base);
  saveStructuredMessages(base, sid);

  const agentMsgId = randomUUID();
  const entries: Parameters<typeof appendMessages>[0] = [];
  for (const t of opts.toolTraceBatch) {
    entries.push({
      role: 'tool_trace',
      parentId: agentMsgId,
      toolName: t.toolName,
      detail: t.detail,
      status: t.status,
      toolCallId: t.toolCallId,
    });
  }
  entries.push({ role: 'agent', content: opts.assistantContent, id: agentMsgId });
  await appendMessages(entries, sid);
  broadcastSessionUpdated(
    'turn_complete',
    { sessionId: sid },
    isWsSubscribedTo(ws, sid) ? ws : undefined,
  );

  if (opts.syntheticTool) {
    broadcastToSession(sid, {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: opts.syntheticTool.toolName,
        toolArgs: opts.syntheticTool.toolDetail ? { path: opts.syntheticTool.toolDetail } : {},
      },
    });
    broadcastToSession(sid, {
      type: 'step',
      step: {
        type: 'tool_result',
        toolName: opts.syntheticTool.toolName,
        toolSuccess: opts.syntheticTool.success,
        toolOutput: opts.assistantContent.substring(0, 800),
      },
    });
  }

  broadcastToSession(sid, { type: 'stream_end' });
  broadcastToSession(sid, { type: 'response', content: opts.assistantContent });
  broadcastToSession(sid, {
    type: 'tokenUsage',
    inputTokens: 0,
    outputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
  clearRunningTurn(sid);
}

/**
 * 处理聊天消息，执行 AI 对话并实时推送进度。
 * PC 端和移动端共用此函数。
 */
export async function handleChatMessage(input: HandleChatMessageInput): Promise<StopReason | undefined> {
  const {
    ws,
    message,
    orchestrator,
    toolRegistry,
    toolExecutor,
    mcpManager,
    runSessionId,
  } = input;
  const inlineImages = input.images ?? [];
  const referencePaths = input.referencePaths ?? [];
  const clientMessageId = input.clientMessageId ?? null;
  const options = {
    skipUserMessageAppend: input.skipUserMessageAppend,
    source: input.source,
  };

  await rebindBgTaskPusher(runSessionId);
  const llmAdapter = orchestrator.getLLMAdapter();
  let toolDefs = toolRegistry.getDefinitions();
  const assembled = await loadAssembledPrompt();
  const harnessDynamic = harnessOverlayToContextFields(assembled);

  const { text: resolvedMessage, filePaths, imageUrls } = resolveFileReferences(message);

  let harnessMessageText = resolvedMessage;
  const skillRegistry = getSkillRegistry();
  const skillResolved = await skillRegistry.resolveMessage(resolvedMessage);
  if (skillResolved) {
    harnessMessageText = skillResolved.augmentedText;
  }
  harnessMessageText = skillRegistry.applyCreationGuideIfNeeded(harnessMessageText, resolvedMessage);

  const supportsVision = await resolveDefaultSupportsVision(MAIN_CONFIG_PATH);

  const apiImageUrls = inlineImages.filter(isSessionImageApiUrl);
  const rawDataUrls = inlineImages.filter((img) => !isSessionImageApiUrl(img));
  const persistedInline = await persistInlineImages(rawDataUrls, runSessionId);
  const persistedFromApi = apiImageUrls.flatMap((apiUrl) => {
    const tail = apiUrl.split('/images/')[1];
    if (!tail) return [];
    const fileName = decodeURIComponent(tail);
    const abs = resolveSessionImageFile(runSessionId, fileName);
    if (!abs) return [];
    const ext = path.extname(abs).toLowerCase();
    return [{
      absolutePath: abs,
      mimeType: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'image/png',
    }];
  });
  const persistedUploads = await persistUploadedImageFiles(imageUrls, runSessionId);
  const allPersistedImages = [...persistedFromApi, ...persistedInline, ...persistedUploads];
  const imageAbsolutePaths = allPersistedImages.map((p) => p.absolutePath);
  const explicitReferencePaths = referencePaths
    .map((p) => p.trim())
    .filter(Boolean);
  const referenceReadPaths = [...explicitReferencePaths, ...imageAbsolutePaths];

  if (referenceReadPaths.length > 0) {
    await addSessionReferenceReads({
      sessionDir: SESSIONS_DIR,
      sessionId: runSessionId,
      paths: referenceReadPaths,
    });
  }

  const uiImageUrls = [
    ...apiImageUrls,
    ...persistedInline.map((p) => buildSessionImageApiUrl(runSessionId, p.absolutePath)),
    ...persistedUploads.map((p) => buildSessionImageApiUrl(runSessionId, p.absolutePath)),
  ];

  const visionDataUrls: string[] = [...rawDataUrls];
  if (supportsVision) {
    for (const img of [...persistedFromApi, ...persistedUploads]) {
      try {
        const imgData = await fsPromises.readFile(img.absolutePath);
        const ext = path.extname(img.absolutePath).toLowerCase().replace('.', '');
        const mimeType = ext === 'jpg' ? 'jpeg' : ext;
        visionDataUrls.push(`data:image/${mimeType};base64,${imgData.toString('base64')}`);
      } catch (err) {
        console.error('[chat-ws] 读取图片失败:', err);
      }
    }
  }

  const { content: userMessageContent, harnessUserMessage: builtHarnessUserMessage } =
    buildUserMessageWithImages({
      userText: harnessMessageText,
      filePaths,
      imageAbsolutePaths,
      imageDataUrls: supportsVision ? visionDataUrls : [],
      supportsVision,
    });

  let harnessUserMessage = builtHarnessUserMessage;

  const fbs = getFileBrowserState(runSessionId);
  const opensBrowser = detectFileBrowserOpen(message);
  if (opensBrowser) {
    fbs.active = true;
    fbs.lastBrowsedPath = null;
  }

  await ensureMemoryInitialized();

  const existingMessages = getCachedMessages(runSessionId);

  const userMsgId = clientMessageId ?? randomUUID();
  const userSentAt = Date.now();
  const skipUserAppend = options.skipUserMessageAppend ?? false;
  if (!skipUserAppend) {
    const display = buildUserMessageDisplayFields(
      message,
      explicitReferencePaths,
    );
    const userPersisted = await appendMessages(
      [{
        role: 'user',
        content: display.content,
        id: userMsgId,
        sentAt: userSentAt,
        ...(display.shellCommand ? { shellCommand: display.shellCommand } : {}),
        ...(display.openCommand ? { openCommand: display.openCommand } : {}),
        ...(display.skills ? { skills: display.skills } : {}),
        ...(display.referencePaths ? { referencePaths: display.referencePaths } : {}),
        ...(uiImageUrls.length > 0 ? { images: uiImageUrls } : {}),
      }],
      runSessionId,
    );
    if (userPersisted) {
      const autoTitle = await applyFirstPromptSessionTitle(runSessionId, display.content || message);
      broadcastSessionUpdated(
        'user_message',
        autoTitle ? { sessionId: runSessionId, title: autoTitle } : { sessionId: runSessionId },
        ws,
      );
      broadcastToSession(runSessionId, {
        type: 'user_message_appended',
        sessionId: runSessionId,
        message: {
          role: 'user',
          id: userMsgId,
          content: display.content,
          sentAt: userSentAt,
          ...(display.shellCommand ? { shellCommand: display.shellCommand } : {}),
          ...(display.openCommand ? { openCommand: display.openCommand } : {}),
          ...(display.skills ? { skills: display.skills } : {}),
          ...(display.referencePaths ? { referencePaths: display.referencePaths } : {}),
          ...(uiImageUrls.length > 0 ? { images: uiImageUrls } : {}),
        },
      });
    }
  }

  const resolvedForDirect =
    typeof userMessageContent === 'string' ? userMessageContent : resolvedMessage;

  const shellCollabActiveForTurn = await resolveShellCollabActive(runSessionId, SESSIONS_DIR);
  if (!shellCollabActiveForTurn) {
    const direct = await tryDirectFileBrowserTurn({
      toolExecutor,
      resolvedText: resolvedForDirect,
      opensBrowser,
      lastBrowsedPath: fbs.lastBrowsedPath,
      platform: process.platform,
      hasImages: inlineImages.length > 0 || imageUrls.length > 0 || imageAbsolutePaths.length > 0,
      active: fbs.active,
    });

    if (direct.handled && direct.variant === 'deterministic') {
      fbs.lastBrowsedPath = direct.newLastBrowsedPath;
      console.log(`[chat-ws] file-browser-direct ${direct.toolName} ok=${direct.success}`);
      await finalizeDirectBrowserTurn(ws, {
        userStructuredContent: harnessUserMessage,
        assistantContent: direct.assistantMarkdown,
        toolTraceBatch: [
          {
            toolName: direct.toolName,
            detail: direct.toolDetail,
            status: direct.success ? 'success' : 'error',
          },
        ],
        syntheticTool: {
          toolName: direct.toolName,
          toolDetail: direct.toolDetail,
          success: direct.success,
        },
        sessionId: runSessionId,
      });
      return 'model_done';
    }

    if (direct.handled && direct.variant === 'harness_augment') {
      fbs.lastBrowsedPath = direct.newLastBrowsedPath;
      harnessUserMessage = direct.augmentedUserText;
      console.log('[chat-ws] file-browser-direct harness_augment (browse_directory output injected)');
    }
  }

  if (
    fbs.lastBrowsedPath
    && typeof harnessUserMessage === 'string'
    && looksLikeFileAnalysisIntent(message)
  ) {
    harnessUserMessage += `\n\n（服务端提示：最近一次列出的文件夹为 \`${fbs.lastBrowsedPath}\`。用户若只给出文件名，请与该路径拼接为完整绝对路径后调用 parse_document / parse_pptx_deep / open_file。）`;
  }

  const abortController = new AbortController();
  sessionAbortControllers.set(runSessionId, abortController);

  const supervisorRuntime = await getSupervisorRuntime();
  const skipPermissionChecks = await readSkipPermissionChecksFromMainConfig(MAIN_CONFIG_PATH);
  const verificationExemptDirs = await readVerificationExemptDirsFromMainConfig(MAIN_CONFIG_PATH);
  const modelMeta = await resolveDefaultChatModelMeta(MAIN_CONFIG_PATH);

  const workspaceMessage = stripReferencePathLinesForWorkspaceLock(message, explicitReferencePaths);
  const sessionToolCtx = await resolveSessionHarnessToolContext({
    sessionDir: SESSIONS_DIR,
    sessionId: runSessionId,
    userMessage: workspaceMessage,
    defaultWorkDir: getDefaultWorkDir(),
    defaultToolExecutor: toolExecutor,
    defaultToolRegistry: toolRegistry,
    fileParser: orchestrator.getFileParser(),
    llmAdapter,
    mcpManager,
  });
  toolDefs = sessionToolCtx.toolDefs;
  const effectiveWorkspace = sessionToolCtx.effectiveWorkspaceRoot;
  const runToolExecutor = sessionToolCtx.toolExecutor;

  const offeringResult = selectToolsForOffering(toolDefs, {
    userMessage: harnessMessageText,
    uploadedFilePaths: filePaths,
    explicitReferencePaths,
    sessionRecentToolCalls: getSessionDeferredToolCalls(runSessionId),
    lastBrowsedPath: getFileBrowserState(runSessionId).lastBrowsedPath ?? undefined,
    shellCollabActive: sessionToolCtx.shellCollabActive,
    hasInlineVisionImages: imageUrls.length > 0 || inlineImages.length > 0,
  });
  toolDefs = offeringResult.tools;
  if (lazyToolOfferingLogEnabled() && offeringResult.reasons.length > 0) {
    console.log(`[lazy-tools] session=${runSessionId.slice(0, 8)} reasons=${offeringResult.reasons.join(',')}`);
  }

  const effectiveAssembled = sessionToolCtx.shellCollabActive
    ? assembleShellCollabPrompt(assembled)
    : assembled;
  const mcpRuntimeContext = sessionToolCtx.mcpRuntimeContext;
  const docToolsContext = sessionToolCtx.shellCollabActive || shouldDisableRuntimeTools()
    ? {}
    : buildAvailableDocToolsContext(
        [...offeringResult.activated].filter((n) => DEFERRED_TOOLS.has(n)),
      );
  const mergedSystemContext = { ...docToolsContext, ...mcpRuntimeContext };
  const runNoteId = getRunningTurn(runSessionId)?.runId;
  if (runNoteId != null) {
    setActiveAlsoRun(runSessionId, runNoteId);
  }
  if (sessionToolCtx.workspace.detection.changed) {
    broadcastToSession(runSessionId, {
      type: 'workspace_updated',
      sessionId: runSessionId,
      workspaceRoot: effectiveWorkspace,
      defaultWorkDir: DEFAULT_WORK_DIR,
    });
  }

  const harnessConfig: HarnessConfig = {
    context: {
      systemPrompt: effectiveAssembled.systemPrompt,
      tools: shouldDisableRuntimeTools() ? [] : toolDefs,
      memoryPrompt: sessionToolCtx.shellCollabActive
        ? undefined
        : await loadMemoryPrompt({ memoryDir: MEMORY_DIR }) ?? undefined,
      ...harnessDynamic,
      ...(Object.keys(mergedSystemContext).length > 0 ? { systemContext: mergedSystemContext } : {}),
    },
    loop: {
      maxRounds: getHarnessMaxRoundsFromEnv(),
      timeout: getHarnessTimeoutMsFromEnv(),
      tokenBudget: getHarnessTokenBudget(),
      maxOutputTokens: modelMeta?.maxOutputTokens,
      signal: abortController.signal,
    },
    permissions: [
      { pattern: 'fs_operation', permission: 'confirm', reason: 'File system operations require confirmation' },
    ],
    skipPermissionChecks,
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    compactionEnableLLMSummary: true,
    memoryDir: MEMORY_DIR,
    fileMemoryManager: sessionToolCtx.shellCollabActive
      ? undefined
      : getGlobalFileMemoryManager() ?? undefined,
    sessionDir: SESSIONS_DIR,
    sessionId: runSessionId,
    workspaceRoot: effectiveWorkspace,
    verificationExemptDirs,
    supervisorConfig: supervisorRuntime.supervisorConfig,
    globalPolicy: supervisorRuntime.globalPolicy,
    enableRequestAnalysis: sessionToolCtx.enableRequestAnalysis,
    shellCollabActive: sessionToolCtx.shellCollabActive,
    onShellMandatoryConfirm: createShellMandatoryConfirmHandler(runSessionId),
    onConfirm: createToolConfirmHandler(runSessionId),
  };

  const harness = new Harness(harnessConfig, runToolExecutor);

  try {
    const priorTracked = await getPriorTrackedPaths(runSessionId);
    const uiMessages = await readUiSessionMessages(SESSIONS_DIR, runSessionId);
    const structuredBase = existingMessages ? [...existingMessages] : [];
    structuredBase.push({
      role: 'user',
      content: Array.isArray(userMessageContent) ? userMessageContent : harnessUserMessage,
    });
    const userUi = uiMessages.find((m) => m.id === userMsgId);
    await captureIntentCheckpoint({
      sessionDir: SESSIONS_DIR,
      sessionId: runSessionId,
      messageId: userMsgId,
      userMessageTime: userUi?.sentAt ?? Date.now(),
      workspaceRoot: effectiveWorkspace,
      workspaceState: sessionToolCtx.workspace.state,
      structuredMessages: structuredBase,
      uiMessages,
      priorTrackedPaths: priorTracked,
    });
    broadcastToSession(runSessionId, {
      type: 'checkpoint_captured',
      sessionId: runSessionId,
      messageId: userMsgId,
    });
    broadcastHarnessState(runSessionId);
  } catch (err) {
    console.error('[chat-ws] intent checkpoint capture failed:', err);
    broadcastToSession(runSessionId, {
      type: 'checkpoint_capture_failed',
      sessionId: runSessionId,
      messageId: userMsgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  harness.getStopHookManager().register(async (messages, lastContent) =>
    evaluateIncompleteTaskStopHook(messages, lastContent),
  );

  const toolTraceBatch: ToolTraceBatchEntry[] = [];

  ensureRunningTurn(runSessionId);

  beginIntentCheckpointTurn(runSessionId, userMsgId, effectiveWorkspace);

  const pulseTimer = setInterval(() => {
    broadcastToSession(runSessionId, { type: 'pulse', ts: Date.now() });
  }, 10_000);

  let stopReason: StopReason | undefined;
  try {
    const result = await harness.run(
      harnessUserMessage,
      (msgs, opts) => llmAdapter.chat(msgs, { ...opts, signal: abortController.signal }),
      (event) => {
        foldStepIntoRunningTurn(runSessionId, event);

        broadcastToSession(runSessionId, { type: 'step', step: event });

        if (event.type === 'stream_delta' && event.delta) {
          broadcastToSession(runSessionId, { type: 'stream', delta: event.delta });
        }
        if (event.type === 'reasoning_stream_delta' && event.delta) {
          broadcastToSession(runSessionId, { type: 'reasoning_stream', delta: event.delta });
        }

        if (event.type === 'tool_output' && event.content) {
          broadcastToSession(runSessionId, {
            type: 'tool_output',
            toolCallId: event.toolCallId || '',
            toolName: event.toolName,
            content: event.content,
          });
        }

        if (event.type === 'tool_call' && event.toolName) {
          const detail = toolArgsDetailPreview(event.toolName, event.toolArgs);
          const callStatus = resolveToolCallInitialStatus(event.toolName, event.toolArgs);
          toolTraceBatch.push({
            toolName: event.toolName,
            detail: detail || '',
            status: callStatus,
            toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : '',
            diffSource: capToolTraceDiffSource(extractDiffSource(
              String(event.toolName),
              undefined,
              event.toolArgs as Record<string, unknown> | undefined,
            )),
          });
          const argsPreview = event.toolArgs ? JSON.stringify(event.toolArgs) : '';
          const truncated = argsPreview.length > 100 ? argsPreview.substring(0, 100) + '…' : argsPreview;
          console.log(`[step] [call] ${event.toolName}(${truncated})`);
        } else if (event.type === 'tool_result' && event.toolName) {
          const resultStatus = toolResultStatusPreview(
            event.toolName,
            event.toolSuccess,
            event.toolOutcome,
            event.toolOutput,
          );
          for (let i = toolTraceBatch.length - 1; i >= 0; i--) {
            const row = toolTraceBatch[i];
            const idMatch = typeof event.toolCallId === 'string'
              && event.toolCallId
              && row.toolCallId === event.toolCallId;
            if (idMatch
              || (!event.toolCallId
                && row.toolName === event.toolName
                && (row.status === 'pending' || row.status === 'background'))) {
              toolTraceBatch[i].status = resultStatus;
              const fromOutput = extractDiffSource(
                String(event.toolName),
                typeof event.toolOutput === 'string' ? event.toolOutput : undefined,
                event.toolArgs as Record<string, unknown> | undefined,
              );
              if (fromOutput) {
                const capped = capToolTraceDiffSource(fromOutput);
                toolTraceBatch[i].diffSource = capped;
                recordPersistedToolTraceDiff(runSessionId, toolTraceBatch[i].toolCallId, capped);
              }
              break;
            }
          }
          const icon = resultStatus === 'error' ? '[err]' : resultStatus === 'background' ? '[bg]' : '[ok]';
          const preview = event.toolOutput ? event.toolOutput.substring(0, 150) : (event.toolError || '');
          console.log(`[step] ${icon} ${event.toolName} → ${preview.substring(0, 150)}`);

          if (event.toolSuccess && DEFERRED_TOOLS.has(String(event.toolName))) {
            recordSessionDeferredToolCall(runSessionId, String(event.toolName));
          }
        }
      },
      existingMessages,
      (msgs, callback, opts) => llmAdapter.stream(msgs, callback, { ...opts, signal: abortController.signal }),
      Array.isArray(userMessageContent) ? userMessageContent : undefined,
    );

    if (sessionAbortControllers.get(runSessionId) === abortController) {
      sessionAbortControllers.delete(runSessionId);
    }

    let turnAgentMsgId: string | undefined;
    if (!isSessionTombstoned(runSessionId)) {
      setCachedMessages(runSessionId, result.messages);
      await flushStructuredSessionToDisk(SESSIONS_DIR, runSessionId, result.messages);
      saveStructuredMessages(result.messages, runSessionId);

      const agentMsgId = randomUUID();
      const sessionEntries: any[] = [];

      for (const trace of toolTraceBatch) {
        if (trace.toolName !== 'write_file' || trace.diffSource || !trace.toolCallId || !trace.detail) {
          continue;
        }
        const synthesized = await resolveToolDiffForSession({
          sessionsDir: SESSIONS_DIR,
          sessionId: runSessionId,
          defaultWorkDir: getDefaultWorkDir(),
          toolCallId: trace.toolCallId,
          relPath: trace.detail,
          toolName: 'write_file',
        });
        if (!synthesized) continue;
        const capped = capToolTraceDiffSource(synthesized);
        trace.diffSource = capped;
        recordPersistedToolTraceDiff(runSessionId, trace.toolCallId, capped);
      }

      for (const trace of toolTraceBatch) {
        const entry: Record<string, unknown> = {
          role: 'tool_trace',
          parentId: agentMsgId,
          toolName: trace.toolName,
          detail: trace.detail,
          status: trace.status,
          toolCallId: trace.toolCallId,
        };
        if (trace.diffSource) entry.diffSource = trace.diffSource;
        sessionEntries.push(entry as (typeof sessionEntries)[number]);
      }

      const turnTokenUsage = {
        inputTokens: result.loopState.totalInputTokens,
        outputTokens: result.loopState.totalOutputTokens,
      };

      if (result.content) {
        sessionEntries.push({ role: 'agent', content: result.content, id: agentMsgId, turnTokenUsage });
        turnAgentMsgId = agentMsgId;
      } else if (toolTraceBatch.length > 0) {
        sessionEntries.push({
          role: 'agent',
          content: '（本轮仅有工具调用，无文字回复）',
          id: agentMsgId,
          turnTokenUsage,
        });
        turnAgentMsgId = agentMsgId;
      }

      if (sessionEntries.length > 0) {
        const persisted = await appendMessages(sessionEntries, runSessionId);
        if (persisted) {
          broadcastSessionUpdated(
            'turn_complete',
            { sessionId: runSessionId },
            isWsSubscribedTo(ws, runSessionId) ? ws : undefined,
          );
        }
      }
    }

    broadcastToSession(runSessionId, { type: 'stream_end' });

    const extractionNotices = harness.flushExtractionNotices();
    if (extractionNotices.length > 0) {
      broadcastToSession(runSessionId, { type: 'memory_notice', notices: extractionNotices });
    }

    if (result.content) {
      broadcastToSession(runSessionId, { type: 'response', content: result.content });
    }
    if (result.loopState.stopReason === 'user_abort') {
      broadcastToSession(runSessionId, { type: 'info', message: '任务已被用户中断' });
    } else if (result.loopState.totalToolCalls > 0) {
      broadcastToSession(runSessionId, { type: 'info', message: `共调用 ${result.loopState.totalToolCalls} 次工具` });
    }
    broadcastToSession(runSessionId, {
      type: 'tokenUsage',
      ...buildTotalTokenUsageWithContext(result.messages, harnessConfig.context.tools ?? [], {
        lastInputTokens: result.loopState.lastInputTokens,
        lastOutputTokens: result.loopState.lastOutputTokens,
      }),
      totalInputTokens: result.loopState.totalInputTokens,
      totalOutputTokens: result.loopState.totalOutputTokens,
      ...(turnAgentMsgId ? { messageId: turnAgentMsgId } : {}),
    });
    stopReason = result.loopState.stopReason;
  } finally {
    clearInterval(pulseTimer);
    if (!isSessionTombstoned(runSessionId)) {
      try {
        await finalizeIntentCheckpointTurn(SESSIONS_DIR, runSessionId, userMsgId);
      } catch (turnSnapErr) {
        console.error('[chat-ws] intent checkpoint turn snapshot finalize failed:', turnSnapErr);
      }
    }
    if (sessionAbortControllers.get(runSessionId) === abortController) {
      sessionAbortControllers.delete(runSessionId);
    }
    if (abortController.signal.aborted) {
      try { stopForegroundShellWorkForSession(runSessionId, 'turn abort'); } catch { /* ignore */ }
    }
    if (runNoteId != null) clearPendingNoteForRun(runSessionId, runNoteId);
    clearRunningTurn(runSessionId);
  }
  return stopReason;
}
