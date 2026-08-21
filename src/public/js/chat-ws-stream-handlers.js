/**
 * ChatPage 的 WS 流式事件处理（从 chat-page.js 拆分，2026-08-11）。
 * 职责：stream / reasoning_stream / stream_end / response / step / status / error / tool_output。
 * 共享状态（isStreaming / userStopped / streamFinalized / streamChunksReceived /
 * visibleStreamChunksReceived / pendingTurnTokenUsage / streamingDiffBuffer）留在 chat-page.js
 * 闭包中，经 ctx.get/set 与专用访问器读写。
 * 依赖：window.ChatSession、window.ChatUI、window.ChatPetBridge、window.ChatExecutionPlanBridge、
 *       window.ToolTraceFormat、window.ToolDisplayHistory、window.DiffViewer、window.BgTaskChip。
 * 暴露：window.ChatWsStreamHandlers.bind(WS, ctx)。
 */

/* exported ChatWsStreamHandlers */

window.ChatWsStreamHandlers = (function () {
  'use strict';

  function bind(WS, ctx) {
    var Session = window.ChatSession;
    var UI = window.ChatUI;
    var Pet = window.ChatPetBridge;
    var get = ctx.get;
    var set = ctx.set;

    function isForeignSessionEvent(data) {
      if (!data || !data.sessionId) return false;
      var active = Session.getActiveId ? Session.getActiveId() : '';
      return data.sessionId !== active;
    }

    function onReasoningStream(data) {
      if (isForeignSessionEvent(data)) return;
      if (get('userStopped')) return;
      if (!get('isStreaming')) {
        set('isStreaming', true);
        UI.setStreamingState(true);
      }
      var pet = ctx.getSessionPet();
      if (pet) {
        pet.setState(Pet.isToolUseActive && Pet.isToolUseActive() ? 'tool_calling' : 'running');
      }
      UI.appendReasoningStreamChunk(data.delta || '');
      ctx.syncWelcomeState();
    }

    function onStream(data) {
      if (isForeignSessionEvent(data)) return;
      if (get('userStopped')) return;
      set('streamChunksReceived', true);
      if (!get('isStreaming')) {
        set('isStreaming', true);
        UI.setStreamingState(true);
      }
      // 多轮工具任务期间 stream_delta 多为中间推理，进 Thinking 块；已调工具则保持扳手
      if (WS.isProcessing()) {
        var pet = ctx.getSessionPet();
        if (pet) {
          pet.setState(Pet.isToolUseActive && Pet.isToolUseActive() ? 'tool_calling' : 'running');
        }
        UI.appendReasoningStreamChunk(data.delta || '');
        ctx.syncWelcomeState();
        return;
      }
      set('visibleStreamChunksReceived', true);
      var petRead = ctx.getSessionPet();
      if (petRead) petRead.setState('streaming');
      UI.appendStreamChunk(data.delta, Session.getMessages(), Session.stripStatusTag);
      ctx.syncWelcomeState();
    }

    function onStreamEnd(data) {
      if (isForeignSessionEvent(data)) return;
      if (!get('userStopped')) {
        UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
        if (get('streamChunksReceived')) {
          set('streamFinalized', true);
          // 任务结束：过程思考仅作流式展示，最终答复由 refresh / response 写入 Assistant
          UI.clearReasoningStream();
        }
      }
      set('streamChunksReceived', false);
      set('isStreaming', false);
      UI.setStreamingState(false);
      ctx.syncWelcomeState();
    }

    function onResponse(data) {
      if (isForeignSessionEvent(data)) return;
      ctx.endTransparencyTurnTimer();
      if (get('userStopped')) {
        set('userStopped', false);
        return;
      }
      if (get('streamFinalized') && get('visibleStreamChunksReceived')) {
        set('streamFinalized', false);
        set('visibleStreamChunksReceived', false);
        scheduleRefreshAfterTurn();
        return;
      }
      set('streamFinalized', false);
      set('visibleStreamChunksReceived', false);
      UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
      UI.clearReasoningStream();
      var msg = { role: 'agent', content: Session.stripStatusTag(data.content || '') };
      Session.appendMessage(msg);
      var pending = ctx.getPendingTurnTokenUsage();
      if (pending) {
        if (pending.messageId && !msg.id) {
          msg.id = pending.messageId;
        }
        msg.turnTokenUsage = pending.usage || pending;
        ctx.setPendingTurnTokenUsage(null);
      }
      Session.flushToolBatchLocal();
      UI.appendMessageEl(msg, Session.stripStatusTag);
      if (msg.turnTokenUsage && UI.updateMessageTokenUsage) {
        UI.updateMessageTokenUsage(msg);
      }
      Session.saveMessages();
      UI.enableAutoScroll();
      ctx.syncWelcomeState();
      scheduleRefreshAfterTurn();
    }

    function scheduleRefreshAfterTurn() {
      setTimeout(function () {
        if (!ctx.shouldSkipServerSnapshotSync()) {
          ctx.refreshChatHistoryAfterTurn('force');
        }
      }, 50);
    }

    function forwardExecutionRoundMarker(type, step) {
      try {
        if (!window.ChatExecutionPlanBridge
          || typeof window.ChatExecutionPlanBridge.handleStep !== 'function') return;
        // 只转发轮次与终止原因；严禁把 thinking/content/delta 带入透明层。
        window.ChatExecutionPlanBridge.handleStep({
          type: type,
          iteration: step && step.iteration,
          stopReason: step && step.stopReason,
          ts: Date.now(),
        });
      } catch (_e) { /* observer must not affect chat */ }
    }

    function onStep(data) {
      if (isForeignSessionEvent(data)) return;
      var step = data.step;
      if (!step) return;

      // P3 — 用户已点 Stop：后端 harness 还在收尾（写 checkpoint / drain memory）期间会继续推
      // step / stream_delta，UI 不再据此切冰豆状态，否则会出现「按钮变 Send 了但冰豆还在动」。
      // userStopped 会在 status:idle 或下一次 sendMessage 时被清掉。
      if (get('userStopped')) return;

      if (step.type === 'thinking' && typeof step.iteration === 'number') {
        forwardExecutionRoundMarker('model_round_start', step);
      } else if (step.type === 'context_usage' && typeof step.iteration === 'number') {
        forwardExecutionRoundMarker('model_round_end', step);
      } else if (step.type === 'final') {
        forwardExecutionRoundMarker('model_task_final', step);
      }

      if (step.totalTokenUsage) {
        ctx.applyTotalTokenUsageFromStep(step.totalTokenUsage);
      }
      if ((step.totalTokenUsage !== undefined || step.totalToolCalls !== undefined)
        && window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.applyRuntimeStats === 'function') {
        window.ChatExecutionPlan.applyRuntimeStats({
          totalTokenUsage: step.totalTokenUsage,
          totalToolCalls: step.totalToolCalls,
        });
      }
      if (step.iteration) {
        Pet.updateTurnCounter(step.iteration, get('isStreaming'), WS.isProcessing());
      }
      if (step.type === 'tool_progress' && step.content) {
        Pet.setLastToolProgressHint(step.content);
        WS.setLastToolProgressHint(step.content);
        Pet.updateStatusText(step.content, get('isStreaming'), WS.isProcessing());
      }
      if (step.type === 'thinking') {
        UI.promoteAssistantBubbleToThinking(Session.stripStatusTag);
        if (step.content) {
          UI.appendReasoningStreamIfAbsent(Session.stripStatusTag(step.content));
        }
        var msgsThink = Session.getMessages();
        for (var mti = msgsThink.length - 1; mti >= 0; mti--) {
          if (msgsThink[mti].role === 'agent' && msgsThink[mti]._streaming) {
            msgsThink.splice(mti, 1);
            break;
          }
        }
      }
      if (step.type === 'tool_call') {
        UI.promoteAssistantBubbleToThinking(Session.stripStatusTag);
        var msgs = Session.getMessages();
        for (var mi = msgs.length - 1; mi >= 0; mi--) {
          if (msgs[mi].role === 'agent' && msgs[mi]._streaming) {
            msgs.splice(mi, 1);
            break;
          }
        }
      }
      if (step.type === 'tool_call' && step.toolName) {
        if (WS.isProcessing() && UI.isLiveToolRoundActive && !UI.isLiveToolRoundActive()) {
          UI.setLiveToolRoundActive(true);
        }
        var fmt = window.ToolTraceFormat;
        var detail = fmt
          ? fmt.formatToolArgsDetailPreview(step.toolName, step.toolArgs)
          : (step.toolArgs && (step.toolArgs.path || step.toolArgs.file || step.toolArgs.command || step.toolArgs.query)) || '';
        if (!detail && step.toolArgs) {
          var argsStr = JSON.stringify(step.toolArgs);
          detail = argsStr.length > 80 ? argsStr.substring(0, 80) + '…' : argsStr;
        }
        var callStatus = fmt && fmt.resolveToolCallInitialStatus
          ? fmt.resolveToolCallInitialStatus(step.toolName, step.toolArgs)
          : 'pending';
        var toolCallId = step.toolCallId || '';
        var diffFromArgs = (window.ToolDisplayHistory && step.toolArgs)
          ? window.ToolDisplayHistory.extractDiffSource(step.toolName, null, step.toolArgs)
          : null;
        UI.appendToolAction(step.toolName, detail, callStatus, toolCallId, diffFromArgs);
        Session.pushToolBatch({
          toolName: step.toolName,
          detail: detail,
          status: callStatus,
          toolCallId: toolCallId,
        });
        if (toolCallId) {
          ctx.setStreamingDiffBuffer({ toolCallId: toolCallId, text: '' });
        }
      }
      if (step.type === 'tool_result' && step.toolName) {
        var fmtResult = window.ToolTraceFormat;
        var resultStatus = fmtResult
          ? fmtResult.resolveToolTraceResultStatus(
            step.toolName,
            step.toolSuccess,
            step.toolOutcome,
            step.toolOutput,
          )
          : (step.toolOutcome === 'policy_block'
            ? 'warn'
            : (step.toolSuccess ? 'success' : 'error'));
        UI.updateToolActionByCallId(step.toolCallId || '', step.toolName, resultStatus);
        Session.updateToolBatchStatus(step.toolName, resultStatus, step.toolCallId || '');
        if (fmtResult && step.toolName === 'run_command' && window.BgTaskChip && ctx.getElMessages()) {
          var checkInfo = fmtResult.parseCheckTaskResult(step.toolOutput);
          if (checkInfo && fmtResult.isTerminalBackgroundStatus(checkInfo.status)) {
            window.BgTaskChip.markConfirmedViaCheck(ctx.getElMessages(), checkInfo.taskId);
          }
        }
        if (window.ToolDisplayHistory) {
          var diffSource = window.ToolDisplayHistory.extractDiffSource(
            step.toolName,
            step.toolOutput,
            step.toolArgs,
          );
          if (!diffSource && window.DiffViewer && step.toolOutput) {
            diffSource = window.DiffViewer.extractUnifiedDiff(step.toolOutput);
          }
          tryMountToolDiff(step.toolCallId || '', diffSource);
        }
        ctx.setStreamingDiffBuffer({ toolCallId: '', text: '' });
      }
      if (window.ChatExecutionPlanBridge
        && (step.type === 'execution_plan_init'
          || step.type === 'execution_plan_update'
          || step.type === 'execution_plan_clear'
          || step.type === 'task_graph_init'
          || step.type === 'task_graph_node'
          || step.type === 'task_graph_update'
          || step.type === 'task_graph_branch'
          || step.type === 'task_graph_done'
          || step.type === 'execution_mode_enter'
          || step.type === 'execution_mode_exit'
          // Phase 5：工具事件用于推导 LLM 当前动作（面板内只读 toolName / 到达状态）
          || step.type === 'tool_call'
          || step.type === 'tool_result')) {
        window.ChatExecutionPlanBridge.handleStep(step);
      }
      Pet.applyHarnessStepToPet(step, get('isStreaming'), WS.isProcessing());
    }

    function onStatus(data) {
      if (isForeignSessionEvent(data)) return;
      var processing = data.status === 'processing';
      WS.setProcessing(processing);
      ctx.notifySnapshotRestoreAvailability();
      if (!processing) {
        ctx.endTransparencyTurnTimer();
        // 用户主动 Stop 后 handleStop 已更新本地消息/DOM；idle 时再 authoritative 拉服务端
        // 快照可能拿到空数组（会话文件读写竞态 / sessionId 未对齐），会把整页聊天记录清掉。
        var skipRefreshAfterUserStop = get('userStopped');
        if (get('userStopped')) set('userStopped', false);
        set('isStreaming', false);
        Pet.removeThinking(get('isStreaming'), WS.isProcessing());
        if (Session.clearLiveToolBatch) Session.clearLiveToolBatch();
        if (UI.repairLiveToolGroupFold) UI.repairLiveToolGroupFold();
        // turn_complete 时 session_updated 可能仍在 processing 中被跳过；idle 时强制从 structured 重绘 diff
        if (!skipRefreshAfterUserStop) {
          ctx.refreshChatHistoryAfterTurn('force');
        }
      } else if (!get('userStopped')) {
        var pet = ctx.getSessionPet();
        if (pet) {
          pet.setState(Pet.isToolUseActive && Pet.isToolUseActive() ? 'tool_calling' : 'running');
        }
      }
      ctx.syncSendButtonWithWorkload();
    }

    function onError(data) {
      if (isForeignSessionEvent(data)) return;
      ctx.endTransparencyTurnTimer();
      UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
      var msg = { role: 'agent', content: '[err] ' + data.message };
      Session.appendMessage(msg);
      UI.appendMessageEl(msg, Session.stripStatusTag);
      Session.saveMessages();
      Pet.removeThinking(get('isStreaming'), WS.isProcessing());
    }

    function tryMountToolDiff(toolCallId, diffSource) {
      if (!toolCallId || !diffSource || !UI.mountDiffForToolCallId) return;
      UI.mountDiffForToolCallId(toolCallId, diffSource);
    }

    /** run_command 流式输出：按 toolCallId 累积并实时预览 */
    function onToolOutput(data) {
      if (isForeignSessionEvent(data)) return;
      if (!data || !data.content || !data.toolCallId) return;
      var buf = ctx.getStreamingDiffBuffer();
      if (buf.toolCallId && buf.toolCallId !== data.toolCallId) {
        buf = { toolCallId: data.toolCallId, text: '' };
      }
      if (!buf.toolCallId) buf.toolCallId = data.toolCallId;
      buf.text += data.content;
      // 与拆分前一致：无论是否命中 diff，都把累积 buffer 写回共享状态
      ctx.setStreamingDiffBuffer(buf);
      var diffSource = null;
      if (window.DiffViewer && typeof window.DiffViewer.extractUnifiedDiff === 'function') {
        diffSource = window.DiffViewer.extractUnifiedDiff(buf.text);
      } else if (window.DiffViewer && typeof window.DiffViewer.looksLikeUnifiedDiffText === 'function') {
        if (!window.DiffViewer.looksLikeUnifiedDiffText(buf.text)) return;
        diffSource = buf.text;
      } else if (!/^@@\s/m.test(buf.text) && !/^diff --git /m.test(buf.text)) {
        return;
      } else {
        diffSource = buf.text;
      }
      if (!diffSource) return;
      tryMountToolDiff(buf.toolCallId, diffSource);
    }

    WS.on('stream', onStream);
    WS.on('reasoning_stream', onReasoningStream);
    WS.on('stream_end', onStreamEnd);
    WS.on('response', onResponse);
    WS.on('step', onStep);
    WS.on('status', onStatus);
    WS.on('error', onError);
    WS.on('tool_output', onToolOutput);
  }

  return { bind: bind };
})();
