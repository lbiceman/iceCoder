/**
 * ChatPage 的 WS 会话事件处理（从 chat-page.js 拆分，2026-08-11）。
 * 职责：connected / session_cleared / session_updated / sync / user_message_appended / workspace_updated。
 * 共享状态（isStreaming / remoteMode / initialHistoryPainted / pendingInitialPaint）留在
 * chat-page.js 闭包，经 ctx.get/set 读写；共享函数（syncMessages / syncSidebarWorkspace /
 * pullServerChatSnapshotAuthoritative / paintRemoteUserMessagesWithoutDom / applyRemoteUserMessage /
 * onSessionSwitched / paintInitialChatView / restoreFromRunningTurn 等）由 chat-page.js
 * 经 buildSessionHandlerCtx() 注入，避免双实现分叉。
 * 依赖：window.ChatSession、window.ChatUI、window.ChatSessionStore、window.ChatSessionSidebar、
 *       window.ChatShellDock、window.ChatExecutionPlanBridge。
 * 暴露：window.ChatWsSessionHandlers.bind(WS, ctx)。
 */

/* exported ChatWsSessionHandlers */

window.ChatWsSessionHandlers = (function () {
  'use strict';

  function bind(WS, ctx) {
    var Session = window.ChatSession;
    var UI = window.ChatUI;
    var get = ctx.get;
    var set = ctx.set;

    function syncActiveSessionFromServer(data) {
      if (!data) return false;
      var serverId = data.activeSessionId || data.sessionId;
      if (!serverId) return false;
      var clientId = Session.getActiveId ? Session.getActiveId() : 'default';
      if (window.ChatSessionStore && typeof window.ChatSessionStore.setActiveSessionId === 'function') {
        window.ChatSessionStore.setActiveSessionId(serverId);
      }
      if (serverId !== clientId) {
        set('pendingInitialPaint', false);
        ctx.onSessionSwitched(serverId, data.runningTurn || null, { bgTasks: data.bgTasks });
        return true;
      }
      if (get('remoteMode') && get('pendingInitialPaint') && !get('initialHistoryPainted')) {
        set('pendingInitialPaint', false);
        ctx.paintInitialChatView();
        return true;
      }
      return false;
    }

    function onConnected(data) {
      var skipHeavyFetch = ctx.shouldSkipWsConnectedHeavyFetch();
      var paintedFromSessionSync = syncActiveSessionFromServer(data || {});
      if (!ctx.applyModelContextFromWs(data)) {
        if (!skipHeavyFetch) ctx.loadModelConfig();
      } else if (data && (data.providers || data.modelName)) {
        ctx.syncChipModelLabelFromWs(data);
      } else if (!skipHeavyFetch) {
        ctx.loadModelConfig();
      }
      ctx.syncSidebarWorkspace(data);
      if (!skipHeavyFetch && window.ChatSessionStore && typeof window.ChatSessionStore.fetchSessions === 'function') {
        window.ChatSessionStore.fetchSessions();
      }
      var clientSid = Session.getActiveId ? Session.getActiveId() : 'default';
      var serverSid = data && (data.activeSessionId || data.sessionId);
      if (data && serverSid === clientSid) {
        ctx.restoreFromRunningTurn(data.runningTurn || null);
      } else if (data && data.runningTurn && data.runningTurn.isProcessing) {
        ctx.restoreFromRunningTurn(null);
      }
      if (data && data.mcpReady) {
        ctx.announceMcpReadyFromPayload(data.mcpReady);
      }
      if (data && data.tunnelReady) {
        ctx.announceTunnelReadyFromPayload(data.tunnelReady);
      }
      if (typeof data.canRestore === 'boolean') {
        ctx.applyHarnessRestoreUi(data.canRestore, data.checkpointMessageIds);
      }
      if (window.ChatExecutionPlanBridge && typeof window.ChatExecutionPlanBridge.notifyConnected === 'function') {
        if (!skipHeavyFetch) {
          window.ChatExecutionPlanBridge.notifyConnected(data || {});
        }
      }
      var dockSid = Session.getActiveId ? Session.getActiveId() : 'default';
      var connectedSid = data && (data.activeSessionId || data.sessionId);
      if (!connectedSid || connectedSid === dockSid) {
        if (window.ChatShellDock) window.ChatShellDock.hydrate(dockSid, data && data.bgTasks);
      } else if (window.ChatShellDock) {
        window.ChatShellDock.hydrate(dockSid, null);
      }
      if (window.ChatShellDock) window.ChatShellDock.scheduleResync();
      ctx.notifyShellCollabState(data || {});
      if (paintedFromSessionSync) return;
      var rt = data && data.runningTurn;
      if ((!rt || !rt.isProcessing) && !skipHeavyFetch) {
        ctx.syncMessages(ctx.needsInitialHistoryPaint());
      } else if (ctx.needsInitialHistoryPaint()) {
        ctx.syncMessages(true);
      }
    }

    function onSessionCleared(data) {
      if (!data || !data.ok) return;
      var activeId = Session.getActiveId ? Session.getActiveId() : 'default';
      var sid = data.sessionId || activeId;
      if (sid !== activeId) return;
      if (window.ChatShellDock) window.ChatShellDock.replaceTasks(Array.isArray(data.bgTasks) ? data.bgTasks : []);
    }

    function onUserMessageAppended(data) {
      if (!data || !data.message) return;
      if (data.sessionId && Session.getActiveId && data.sessionId !== Session.getActiveId()) return;
      ctx.applyRemoteUserMessage(data.message);
    }

    function onSessionUpdated(data) {
      if (data && data.sessionId && data.title && window.ChatSessionStore
          && typeof window.ChatSessionStore.patchSession === 'function') {
        window.ChatSessionStore.patchSession(data.sessionId, { title: data.title });
      }
      if (window.ChatExecutionPlanBridge && typeof window.ChatExecutionPlanBridge.notifySessionUpdated === 'function') {
        window.ChatExecutionPlanBridge.notifySessionUpdated();
      }
      if (data && data.reason === 'turn_complete') {
        if (!ctx.shouldSkipServerSnapshotSync()) {
          ctx.refreshChatHistoryAfterTurn('force');
        }
        return;
      }
      if (data && data.reason === 'message_deleted') {
        if (!ctx.shouldSkipServerSnapshotSync()) {
          ctx.refreshChatHistoryAfterTurn(true);
        }
        return;
      }
      if (data && data.reason === 'runtime_restored') {
        ctx.refreshChatHistoryAfterTurn(true, null, { force: true });
        ctx.refreshSnapshotTimelinePanel();
        return;
      }
      if (data && data.reason === 'user_message') {
        if (Session.fetchAndMergeRemoteUserMessages) {
          Session.fetchAndMergeRemoteUserMessages(function (added) {
            if (!added) return;
            ctx.paintRemoteUserMessagesWithoutDom(Session.getMessages());
            Session.saveMessages();
          });
        }
        return;
      }
      if (!data || !data.title) {
        ctx.pullServerChatSnapshotAuthoritative();
      }
    }

    WS.on('connected', onConnected);
    WS.on('session_cleared', onSessionCleared);
    WS.on('user_message_appended', onUserMessageAppended);
    WS.on('session_updated', onSessionUpdated);
    WS.on('workspace_updated', ctx.syncSidebarWorkspace);
    WS.on('sync', ctx.syncMessages);
  }

  return { bind: bind };
})();
