/**
 * ChatPage 的 WS 恢复/确认事件处理（从 chat-page.js 拆分，2026-08-11）。
 * 职责：confirm / confirm_resolved / confirm_timeout / harness_state / checkpoint_message_ids /
 *       checkpoint_captured / runtime_restored / restore_failed / message_deleted / delete_message_failed。
 * 共享状态（activeConfirmId / activeConfirmResolved）保留在本模块闭包；
 * 跨域状态（runtimeRestoreInFlight / isStreaming / userStopped / remoteToken / sessionPet）
 * 留在 chat-page.js，经 ctx.get/set 与专用访问器读写；共享函数（refreshChatHistoryAfterTurn /
 * syncSidebarWorkspace / notifyUser / clearSessionExecutionFlow 等）由 chat-page.js
 * 经 buildRestoreHandlerCtx() 注入，避免双实现分叉。
 * 依赖：window.ChatSession、window.ChatUI、window.Modal、window.ChatExecutionPlan、
 *       window.ChatExecutionPlanBridge、window.ChatExecutionFlowStore。
 * 暴露：window.ChatWsRestoreHandlers.bind(WS, ctx)。
 */

/* exported ChatWsRestoreHandlers */

window.ChatWsRestoreHandlers = (function () {
  'use strict';

  function bind(WS, ctx) {
    var Session = window.ChatSession;
    var UI = window.ChatUI;
    var get = ctx.get;
    var set = ctx.set;

    // ---- confirm 域（模块私有状态） ----
    var activeConfirmId = null;
    var activeConfirmResolved = false;

    function dismissActiveConfirmModal(approved) {
      if (window.Modal && typeof Modal.dismissActive === 'function') {
        Modal.dismissActive(approved);
      }
    }

    function onConfirm(data) {
      var sessionPet = ctx.getSessionPet();
      if (sessionPet) {
        sessionPet.setState('alert');
        sessionPet.setBubbleText('请在弹窗中确认危险操作');
      }
      activeConfirmId = data.confirmId || null;
      activeConfirmResolved = false;

      var isShellMandatory = data.confirmKind === 'shell_mandatory';
      var shellInfo = data.shellMandatory || null;
      var modalOpts;

      if (isShellMandatory && shellInfo) {
        var lines = [
          'Session: ' + (shellInfo.sessionId || ''),
          '命令: ' + (shellInfo.command || ''),
          '命中规则: ' + (shellInfo.matchedPattern || ''),
          '风险类别: ' + (shellInfo.category || ''),
          '影响: ' + (shellInfo.impact || ''),
          '',
          '此确认不会被「自动执行」设置跳过。',
        ];
        modalOpts = {
          title: 'Shell 敏感命令确认',
          message: lines.join('\n'),
          type: 'danger',
          dangerConfirm: true,
          confirmText: '确认执行',
          cancelText: '取消',
          defaultFocus: 'cancel',
        };
      } else {
        var argsText = data.args ? JSON.stringify(data.args) : '';
        modalOpts = {
          title: '危险操作确认',
          message: '工具: ' + data.toolName + '\n参数: ' + argsText,
          type: 'danger',
          dangerConfirm: true,
          confirmText: '允许',
          cancelText: '拒绝',
        };
      }

      Modal.confirm(modalOpts).then(function (ok) {
        if (activeConfirmResolved) {
          activeConfirmId = null;
          activeConfirmResolved = false;
          if (sessionPet) {
            sessionPet.setState(get('isStreaming') || WS.isProcessing() ? 'read' : 'idle');
            sessionPet.setBubbleText('');
          }
          return;
        }
        WS.sendConfirmReply(ok, activeConfirmId);
        activeConfirmId = null;
        var confirmMsg = { role: 'agent', content: ok ? '[ok] 用户已确认: ' + data.toolName : '[denied] 用户已拒绝: ' + data.toolName };
        Session.appendMessage(confirmMsg);
        UI.appendMessageEl(confirmMsg, Session.stripStatusTag);
        Session.saveMessages();
        if (sessionPet) {
          sessionPet.setState(get('isStreaming') || WS.isProcessing() ? 'read' : 'idle');
          sessionPet.setBubbleText('');
        }
      });
    }

    function onConfirmResolved(data) {
      if (!data) return;
      // 其它端 first-win 后关闭本地弹窗，避免 PC/移动端各弹各的
      if (!activeConfirmId || data.confirmId === activeConfirmId) {
        activeConfirmResolved = true;
        dismissActiveConfirmModal(!!data.approved);
      }
    }

    function onConfirmTimeout(data) {
      if (!data) return;
      if (!activeConfirmId || data.confirmId === activeConfirmId) {
        activeConfirmResolved = true;
        dismissActiveConfirmModal(false);
      }
    }

    // ---- checkpoint / harness 域 ----
    function onHarnessState(data) {
      if (!data) return;
      ctx.applyHarnessRestoreUi(!!data.canRestore, data.checkpointMessageIds);
      ctx.refreshSnapshotTimelinePanel();
    }

    function onCheckpointMessageIds(data) {
      if (!data || !UI || typeof UI.setCheckpointMessageIds !== 'function') return;
      UI.setCheckpointMessageIds(data.ids || []);
      ctx.refreshSnapshotTimelinePanel();
    }

    // ---- 恢复 / 删除域 ----
    function onRuntimeRestored() {
      set('runtimeRestoreInFlight', false);
      set('isStreaming', false);
      set('userStopped', false);
      WS.setProcessing(false);
      UI.setStreamingState(false);
      UI.clearReasoningStream();
      ctx.clearSessionExecutionFlow();
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
      if (Session.invalidateStructuredCache) Session.invalidateStructuredCache();
      ctx.refreshChatHistoryAfterTurn(true, null, { force: true });
      ctx.syncSidebarWorkspace({ sessionId: Session.getActiveId ? Session.getActiveId() : 'default' });
      ctx.refreshSnapshotTimelinePanel();
      ctx.notifySnapshotRestoreAvailability();
    }

    function onRestoreFailed(data) {
      set('runtimeRestoreInFlight', false);
      ctx.notifySnapshotRestoreAvailability();
      var msg = (data && data.error) ? data.error : '回滚失败，运行时状态未改变。';
      ctx.notifyUser(msg, 'error', { duration: 5000 });
      ctx.refreshSnapshotTimelinePanel();
    }

    function onMessageDeleted() {
      set('isStreaming', false);
      UI.setStreamingState(false);
      UI.clearReasoningStream();
      ctx.clearSessionExecutionFlow();
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
      if (Session.invalidateStructuredCache) Session.invalidateStructuredCache();
      ctx.refreshChatHistoryAfterTurn(true);
      ctx.syncSidebarWorkspace({ sessionId: Session.getActiveId ? Session.getActiveId() : 'default' });
    }

    function onDeleteMessageFailed(data) {
      var msg = (data && data.error) ? data.error : '删除消息失败。';
      if (data && data.code === 'DELETE_MESSAGE_NOT_FOUND') {
        ctx.pullServerChatSnapshotAuthoritative(function (synced) {
          if (synced) {
            ctx.notifyUser('该消息已不在服务端记录中，界面已同步。', 'info', { duration: 4000 });
            return;
          }
          ctx.notifyUser(msg, 'error', { duration: 5000 });
        });
        return;
      }
      ctx.notifyUser(msg, 'error', { duration: 5000 });
    }

    WS.on('confirm', onConfirm);
    WS.on('confirm_resolved', onConfirmResolved);
    WS.on('confirm_timeout', onConfirmTimeout);
    WS.on('harness_state', onHarnessState);
    WS.on('checkpoint_message_ids', onCheckpointMessageIds);
    WS.on('checkpoint_captured', ctx.refreshSnapshotTimelinePanel);
    WS.on('runtime_restored', onRuntimeRestored);
    WS.on('restore_failed', onRestoreFailed);
    WS.on('message_deleted', onMessageDeleted);
    WS.on('delete_message_failed', onDeleteMessageFailed);
  }

  return { bind: bind };
})();
