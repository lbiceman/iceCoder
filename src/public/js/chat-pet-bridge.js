/**
 * 冰豆状态桥接模块
 * 负责：将 Harness StepEvent 映射到表情状态 + 气泡文案
 */

/* exported ChatPetBridge */

window.ChatPetBridge = (function () {
  'use strict';

  var sessionPet = null;
  var currentTurnCount = 0;
  var petUiSessionActive = false;
  var lastToolProgressHint = '';
  var memoryNoticeResetTimer = null;
  var MEMORY_NOTICE_MS = 5200;
  var mcpReadyResetTimer = null;
  var MCP_READY_NOTICE_MS = 5200;
  var tunnelReadyResetTimer = null;
  var TUNNEL_READY_NOTICE_MS = 5200;

  function init(pet) {
    sessionPet = pet;
  }

  function showThinking(withFile) {
    currentTurnCount = 0;
    petUiSessionActive = true;
    if (!sessionPet) return;
    sessionPet.setVisible(true);
    sessionPet.setState('thinking');
    sessionPet.setTurnLabel('');
    sessionPet.setBubbleText(withFile ? '解析文件中…' : '');
  }

  function updateTurnCounter(turn, isStreaming, wsProcessing) {
    if (turn > currentTurnCount) {
      currentTurnCount = turn;
    }
    if (sessionPet) {
      sessionPet.setTurnLabel(
        petUiSessionActive || wsProcessing || isStreaming
          ? currentTurnCount ? '第 ' + currentTurnCount + ' 轮' : ''
          : ''
      );
    }
  }

  function removeThinking(isStreaming, wsProcessing) {
    currentTurnCount = 0;
    lastToolProgressHint = '';
    petUiSessionActive = false;
    if (memoryNoticeResetTimer) {
      clearTimeout(memoryNoticeResetTimer);
      memoryNoticeResetTimer = null;
    }
    if (!sessionPet) return;
    sessionPet.setState('idle');
    sessionPet.setBubbleText('');
    sessionPet.setTurnLabel('');
  }

  function updateStatusText(text, isStreaming, wsProcessing) {
    if (!sessionPet) return;
    if (!petUiSessionActive && !wsProcessing && !isStreaming) return;
    sessionPet.setBubbleText(text || '');
  }

  function setLastToolProgressHint(hint) {
    lastToolProgressHint = hint || '';
  }

  function applyHarnessStepToPet(step, isStreaming, wsProcessing) {
    if (!sessionPet || !step) return;

    function recoverThinkingOrIdle() {
      sessionPet.setState(isStreaming || wsProcessing ? 'thinking' : 'idle');
    }

    function bubble(txt) {
      if (txt === undefined || txt === null) return;
      if (txt === '') {
        sessionPet.setBubbleText('');
        return;
      }
      if (!petUiSessionActive && !wsProcessing && !isStreaming) return;
      sessionPet.setBubbleText(String(txt));
    }

    switch (step.type) {
      case 'thinking':
        sessionPet.setState('thinking');
        if (step.content) bubble(step.content);
        break;
      case 'tool_call':
        sessionPet.setState('working');
        {
          var toolHint = step.toolName || '';
          if (step.toolArgs) {
            var argHint =
              step.toolArgs.path ||
              step.toolArgs.file ||
              step.toolArgs.command ||
              step.toolArgs.query ||
              '';
            if (argHint) toolHint = (toolHint ? toolHint + ' · ' : '') + argHint;
          }
          bubble(step.content || toolHint || '调用工具…');
        }
        break;
      case 'tool_result':
        if (step.toolSuccess === false) {
          sessionPet.setState('angry');
          bubble(step.toolError || step.content || '工具失败');
        } else {
          recoverThinkingOrIdle();
          var okMsg = lastToolProgressHint || step.content;
          if (okMsg) bubble(okMsg);
        }
        break;
      case 'tool_denied':
        sessionPet.setState('angry');
        bubble(step.content || '已拒绝工具');
        break;
      case 'tool_confirm':
        sessionPet.setState('shy');
        bubble(step.content || '待确认');
        break;
      case 'tool_progress':
        sessionPet.setState('working');
        bubble(step.content || '');
        break;
      case 'compaction':
        sessionPet.setState('focused');
        bubble(step.content || '整理上下文中…');
        break;
      case 'final':
        {
          var sr = step.stopReason;
          if (sr === 'error') {
            sessionPet.setState('weary');
            bubble(step.content || '出错了');
          } else if (sr === 'circuit_breaker') {
            sessionPet.setState('determined');
            bubble(step.content || '已熔断');
          } else if (sr === 'user_abort') {
            recoverThinkingOrIdle();
            sessionPet.setBubbleText('');
          } else if (sr === 'token_budget' || sr === 'max_output_tokens' || sr === 'timeout' || sr === 'max_rounds') {
            sessionPet.setState('weary');
            if (step.content) bubble(step.content);
          } else if (sr === 'task_recovery') {
            sessionPet.setState('dizzy');
            if (step.content) bubble(step.content);
          } else if (sr === 'stop_hook') {
            sessionPet.setState('alert');
            if (step.content) bubble(step.content);
          } else {
            sessionPet.setState('happy');
            if (step.content) bubble(step.content);
          }
        }
        break;
      case 'stream_delta':
        sessionPet.setState('read');
        break;
      case 'tool_output':
        break;
      case 'memory_event':
        {
          var mk = step.memoryKind;
          var memDefaults = {
            recall_hit: '想起了相关记忆',
            recall_coarse_hit: '预检索命中记忆',
            recall_empty: '未找到可注入的相关记忆',
            recall_skipped: '本轮未注入记忆',
            session_hydrate: '已恢复会话状态',
          };
          if (mk === 'recall_hit') {
            sessionPet.setState('love');
          } else if (mk === 'recall_coarse_hit') {
            sessionPet.setState('curious');
          } else if (mk === 'recall_empty') {
            sessionPet.setState('sad');
          } else if (mk === 'recall_skipped') {
            sessionPet.setState('anxious');
          } else if (mk === 'session_hydrate') {
            sessionPet.setState('surprised');
          } else {
            recoverThinkingOrIdle();
          }
          var memLine = step.memoryDetail || (mk ? memDefaults[mk] : '') || '';
          if (memLine) bubble(memLine);
        }
        break;
      default:
        break;
    }
  }

  function getSessionPet() {
    return sessionPet;
  }

  function isSessionActive() {
    return petUiSessionActive;
  }

  /**
   * MCP 后台加载完成（WebSocket mcp_ready）：表情 + 气泡，数秒后复原
   */
  function applyMcpReadyToPet(payload, ctx) {
    if (!sessionPet) return;
    ctx = ctx || {};
    if (mcpReadyResetTimer) {
      clearTimeout(mcpReadyResetTimer);
      mcpReadyResetTimer = null;
    }
    sessionPet.setVisible(true);
    var ok = payload && payload.ok !== false;
    var n = payload && typeof payload.toolCount === 'number' ? payload.toolCount : 0;
    var bubble;
    if (!ok) {
      sessionPet.setState('weary');
      var err = payload && payload.errorMessage ? String(payload.errorMessage) : '';
      bubble = err ? 'MCP 失败：' + err.slice(0, 22) : 'MCP 加载失败';
    } else if (n > 0) {
      sessionPet.setState('happy');
      bubble = 'MCP 就绪 · ' + n + ' 工具';
    } else {
      sessionPet.setState('playful');
      bubble = 'MCP 就绪（无扩展工具）';
    }
    sessionPet.setBubbleText(bubble);
    var wsProcessing = !!ctx.wsProcessing;
    var isStreaming = !!ctx.isStreaming;
    mcpReadyResetTimer = setTimeout(function () {
      mcpReadyResetTimer = null;
      if (!sessionPet || !sessionPet.isVisible()) return;
      sessionPet.setState(wsProcessing || isStreaming ? 'read' : 'idle');
      sessionPet.setBubbleText('');
    }, MCP_READY_NOTICE_MS);
  }

  /**
   * Cloudflare Quick Tunnel 就绪（WebSocket tunnel_ready）
   */
  function applyTunnelReadyToPet(payload, ctx) {
    if (!sessionPet || !payload || !payload.url) return;
    ctx = ctx || {};
    if (tunnelReadyResetTimer) {
      clearTimeout(tunnelReadyResetTimer);
      tunnelReadyResetTimer = null;
    }
    sessionPet.setVisible(true);
    sessionPet.setState('curious');
    var hostHint = '';
    try {
      var u = new URL(String(payload.url));
      hostHint = u.hostname;
      if (hostHint.length > 26) hostHint = hostHint.slice(0, 24) + '…';
    } catch (_e) {
      hostHint = String(payload.url).slice(0, 26);
    }
    sessionPet.setBubbleText('隧道就绪 · ' + hostHint);
    var wsProcessing = !!ctx.wsProcessing;
    var isStreaming = !!ctx.isStreaming;
    tunnelReadyResetTimer = setTimeout(function () {
      tunnelReadyResetTimer = null;
      if (!sessionPet || !sessionPet.isVisible()) return;
      sessionPet.setState(wsProcessing || isStreaming ? 'read' : 'idle');
      sessionPet.setBubbleText('');
    }, TUNNEL_READY_NOTICE_MS);
  }

  /**
   * 回合结束 passive 记忆提取（WebSocket memory_notice）：表情 + 气泡，数秒后复原
   */
  function applyMemoryNoticesToPet(notices, ctx) {
    if (!sessionPet || !notices || !notices.length) return;
    ctx = ctx || {};
    var isStreaming = !!ctx.isStreaming;
    var wsProcessing = !!ctx.wsProcessing;
    if (memoryNoticeResetTimer) {
      clearTimeout(memoryNoticeResetTimer);
      memoryNoticeResetTimer = null;
    }
    sessionPet.setVisible(true);
    var first = String(notices[0] || '');
    if (/💾|记住|已记录|已更新记忆/.test(first)) {
      sessionPet.setState('love');
    } else {
      sessionPet.setState('playful');
    }
    // 回合结束才推送，此时会话活跃标志往往已清空，仍应展示摘要气泡
    if (ctx.showBubble !== false) {
      sessionPet.setBubbleText(first || '已更新记忆');
    }
    memoryNoticeResetTimer = setTimeout(function () {
      memoryNoticeResetTimer = null;
      if (!sessionPet || !sessionPet.isVisible()) return;
      sessionPet.setState(wsProcessing || isStreaming ? 'read' : 'idle');
      sessionPet.setBubbleText('');
    }, MEMORY_NOTICE_MS);
  }

  return {
    init: init,
    showThinking: showThinking,
    updateTurnCounter: updateTurnCounter,
    removeThinking: removeThinking,
    updateStatusText: updateStatusText,
    setLastToolProgressHint: setLastToolProgressHint,
    applyHarnessStepToPet: applyHarnessStepToPet,
    applyMemoryNoticesToPet: applyMemoryNoticesToPet,
    applyMcpReadyToPet: applyMcpReadyToPet,
    applyTunnelReadyToPet: applyTunnelReadyToPet,
    getSessionPet: getSessionPet,
    isSessionActive: isSessionActive,
  };
})();
