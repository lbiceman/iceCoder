// @ts-nocheck
/**
 * 移动端共享 Composer：复用 ChatPage 完整输入区（+ / 模型 / 命令 / @ / # / 附件）。
 * 通过 DOM  reparent 在工作首页与聊天详情间切换，不复制 Core 逻辑。
 */

/* exported MobileComposerHost */

export const MobileComposerHost = (() => {

  let hostEl = null;

  function ensureHost() {
    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.id = 'mobile-chat-host';
      hostEl.className = 'mobile-chat-host mobile-chat-host--work-mode';
    }
    return hostEl;
  }

  function ensureChatPageMounted() {
    const host = ensureHost();
    if (window.ChatPage && typeof window.ChatPage.isMounted === 'function' && !window.ChatPage.isMounted()) {
      window.ChatPage.render(host);
    }
    return host;
  }

  function attachToSlot(slotEl) {
    if (!slotEl) return;
    const host = ensureChatPageMounted();
    host.classList.add('mobile-chat-host--work-mode');
    if (host.parentElement !== slotEl) {
      slotEl.appendChild(host);
    }
    if (window.ChatPage && typeof window.ChatPage.onActivate === 'function') {
      window.ChatPage.onActivate();
    }
  }

  function attachToChatCore(coreEl) {
    if (!coreEl) return;
    const host = ensureChatPageMounted();
    host.classList.remove('mobile-chat-host--work-mode');
    if (host.parentElement !== coreEl) {
      coreEl.appendChild(host);
    }
  }

  function markPendingSend() {
    sessionStorage.setItem('mobile-pending-send', '1');
  }

  function tryPendingSend() {
    if (!sessionStorage.getItem('mobile-pending-send')) return;
    sessionStorage.removeItem('mobile-pending-send');
    setTimeout(() => {
      if (window.ChatPage && typeof window.ChatPage.triggerSend === 'function') {
        window.ChatPage.triggerSend();
      }
    }, 80);
  }

  /**
   * 工作首页发送：先确保会话并进入聊天详情，再触发 ChatPage.handleSend。
   * @returns {boolean} true 表示已拦截默认发送流程
   */
  function handleWorkPageSend() {
    const Store = window.ChatSessionStore;
    if (!Store) return false;

    markPendingSend();

    function finishSwitch() {
      if (window.MobileWorkPage && typeof window.MobileWorkPage.syncChatActivity === 'function') {
        window.MobileWorkPage.syncChatActivity();
      }
      tryPendingSend();
    }

    const activeId = Store.getActiveSessionId();
    if (activeId) {
      finishSwitch();
      return true;
    }

    Store.createSession('新会话', (session) => {
      if (!session) {
        sessionStorage.removeItem('mobile-pending-send');
        return;
      }
      const wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;
      Store.switchSession(session.id, wsSend, (ok) => {
        if (!ok) {
          sessionStorage.removeItem('mobile-pending-send');
          return;
        }
        finishSwitch();
      });
    });
    return true;
  }

  function getHost() {
    return hostEl;
  }

  return {
    attachToSlot,
    attachToChatCore,
    handleWorkPageSend,
    tryPendingSend,
    ensureChatPageMounted,
    getHost,
  };
})();

if (typeof window !== 'undefined') {
  window.MobileComposerHost = MobileComposerHost;
}
