/**
 * ChatPage 的 WS 后台任务 + 协作事件处理（从 chat-page.js 拆分，2026-08-11）。
 * 职责：bg_task_update / bg_task_stop_result / task_queue_updated /
 *       also_note_appended / also_rejected / shell_collab_entered。
 * 共享状态（pendingAlsoMessageIds）留在 chat-page.js 闭包，经 ctx.get/set 共享对象引用；
 * 共享函数（appendAlsoNoteBubble / notifyShellCollabState / syncWelcomeState）由 chat-page.js
 * 经 buildBgTaskHandlerCtx() 注入，避免双实现分叉。
 * 依赖：window.ChatSession、window.ChatUI、window.ChatShellDock、window.BgTaskChip、
 *       window.EtlShellDock、window.ChatTaskQueue。
 * 暴露：window.ChatWsBgTaskHandlers.bind(WS, ctx)。
 */

/* exported ChatWsBgTaskHandlers */

window.ChatWsBgTaskHandlers = (function () {
  'use strict';

  function bind(WS, ctx) {
    var Session = window.ChatSession;
    var UI = window.ChatUI;
    var get = ctx.get;
    var set = ctx.set;

    function onTaskQueueUpdated(data) {
      if (!window.ChatTaskQueue || typeof window.ChatTaskQueue.setItems !== 'function') return;
      if (data && data.sessionId && data.sessionId !== Session.getActiveId()) return;
      window.ChatTaskQueue.setItems(data && data.items ? data.items : []);
    }

    function onBgTaskStopResult(payload) {
      if (!payload || payload.ok) return;
      if (window.BgTaskChip && window.BgTaskChip.resetStopPending && payload.taskId) {
        window.BgTaskChip.resetStopPending(payload.taskId);
      }
      if (window.EtlShellDock && window.EtlShellDock.resetStopPending && payload.taskId) {
        window.EtlShellDock.resetStopPending(payload.taskId);
      }
    }

    function onBgTaskUpdate(payload) {
      var activeId = (Session && typeof Session.getActiveId === 'function')
        ? Session.getActiveId()
        : '';
      if (payload && Array.isArray(payload.tasks)
        && (!payload.sessionId || payload.sessionId === activeId)) {
        if (window.ChatShellDock) window.ChatShellDock.mergeTasks(payload.tasks);
      }
      var elMessages = ctx.getElMessages();
      if (window.BgTaskChip && elMessages) {
        window.BgTaskChip.handleUpdate(elMessages, payload, activeId);
      }
      if (window.EtlShellDock && typeof window.EtlShellDock.handleUpdate === 'function') {
        if (window.ChatShellDock) window.ChatShellDock.tryMount();
        window.EtlShellDock.handleUpdate(payload, activeId);
      }
      if (window.BgTaskChip && elMessages) {
        UI.scheduleScrollIfSticky();
      }
    }

    // ---- also / shell 协作域 ----

    function appendShellCollabAgentMessage(data) {
      if (!data || !data.message) return;
      if (data.sessionId && Session.getActiveId && data.sessionId !== Session.getActiveId()) return;
      var msg = data.message;
      if (!msg || msg.role !== 'agent') return;
      if (msg.id && Session.getMessages) {
        var msgs = Session.getMessages();
        for (var i = 0; i < msgs.length; i++) {
          if (msgs[i].id === msg.id) return;
        }
      }
      Session.appendMessage(msg);
      UI.appendMessageEl(msg, Session.stripStatusTag);
      Session.saveMessages();
      ctx.syncWelcomeState();
      UI.scheduleScrollIfSticky();
    }

    function onShellCollabEntered(data) {
      ctx.notifyShellCollabState(data);
      if (!data || data.idempotent) return;
      appendShellCollabAgentMessage(data);
    }

    function removeAlsoNoteFromUi(messageId) {
      if (!messageId) return;
      var pending = get('pendingAlsoMessageIds');
      if (pending) delete pending[messageId];
      Session.removeMessageById(messageId);
      UI.removeMessageElById(messageId);
      Session.saveMessages();
      ctx.syncWelcomeState();
    }

    function appendSystemAgentMessage(content) {
      var msg = { role: 'agent', content: content || '', statusTag: 'system' };
      if (window.ChatSession && typeof window.ChatSession.stampMessageTimestamps === 'function') {
        window.ChatSession.stampMessageTimestamps(msg);
      }
      Session.appendMessage(msg);
      UI.appendMessageEl(msg, Session.stripStatusTag);
      Session.saveMessages();
    }

    function onAlsoNoteAppended(data) {
      if (data && data.sessionId && data.sessionId !== Session.getActiveId()) return;
      var msg = data && data.message;
      if (!msg || !msg.id) return;
      var pending = get('pendingAlsoMessageIds');
      if (pending && pending[msg.id]) {
        delete pending[msg.id];
        return;
      }
      ctx.appendAlsoNoteBubble(msg.content, msg.id);
    }

    function onAlsoRejected(data) {
      if (data && data.sessionId && data.sessionId !== Session.getActiveId()) return;
      var pending = get('pendingAlsoMessageIds') || {};
      var ids = Object.keys(pending);
      for (var i = 0; i < ids.length; i++) {
        removeAlsoNoteFromUi(ids[i]);
      }
      appendSystemAgentMessage((data && data.message) || '/also 未生效');
    }

    WS.on('bg_task_update', onBgTaskUpdate);
    WS.on('bg_task_stop_result', onBgTaskStopResult);
    WS.on('task_queue_updated', onTaskQueueUpdated);
    WS.on('also_note_appended', onAlsoNoteAppended);
    WS.on('also_rejected', onAlsoRejected);
    WS.on('shell_collab_entered', onShellCollabEntered);
  }

  return { bind: bind };
})();
