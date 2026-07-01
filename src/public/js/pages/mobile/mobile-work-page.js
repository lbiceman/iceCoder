/**
 * 移动端工作 Tab 首页：Dashboard + 底部输入区（复用 ChatPage Composer）。
 * 远程扫码（/m/chat?token=）在同一 Shell 内展示全屏聊天，不进入二级页。
 */

/* exported MobileWorkPage */

window.MobileWorkPage = (function () {
  'use strict';

  var mounted = false;
  var rootEl = null;

  function isRemoteEntry() {
    return !!new URLSearchParams(window.location.search || '').get('token');
  }

  function render(parentEl) {
    rootEl = parentEl;
    parentEl.className = 'page-root page-root-work mobile-page-root';
    parentEl.classList.toggle('mobile-work-remote', isRemoteEntry());

    if (window.MobileShell) {
      window.MobileShell.setTopBarMode('work');
      if (typeof window.MobileShell.syncBottomNavActive === 'function') {
        window.MobileShell.syncBottomNavActive();
      }
    }

    if (!mounted) {
      mounted = true;
      if (isRemoteEntry()) {
        parentEl.innerHTML =
          '<div class="mobile-work-page mobile-work-page--remote">' +
            '<div class="mobile-work-chat-core" id="mobile-work-chat-core"></div>' +
          '</div>';
      } else {
        parentEl.innerHTML =
          '<div class="mobile-work-page">' +
            '<div class="mobile-work-scroll">' +
              '<div class="mobile-work-dashboard" id="mobile-work-dashboard"></div>' +
            '</div>' +
            '<div class="mobile-composer-slot" id="mobile-composer-slot"></div>' +
          '</div>';

        var dashboard = parentEl.querySelector('#mobile-work-dashboard');
        if (dashboard && window.ChatWelcome && typeof window.ChatWelcome.buildDashboardMarkup === 'function') {
          dashboard.innerHTML = window.ChatWelcome.buildDashboardMarkup(false);
          if (typeof window.ChatWelcome.bindDashboardEvents === 'function') {
            window.ChatWelcome.bindDashboardEvents(dashboard, handlePromptSelect);
          }
        }
      }
    }

    if (isRemoteEntry()) {
      attachRemoteChat();
    } else {
      attachComposer();
      syncDashboard();
      syncChatActivity();
    }
  }

  function attachComposer() {
    if (!rootEl || !window.MobileComposerHost) return;
    var slot = rootEl.querySelector('#mobile-composer-slot');
    if (slot) window.MobileComposerHost.attachToSlot(slot);
  }

  function attachRemoteChat() {
    if (!rootEl || !window.MobileComposerHost) return;
    var core = rootEl.querySelector('#mobile-work-chat-core');
    if (core) window.MobileComposerHost.attachToChatCore(core);
    if (window.ChatPage && typeof window.ChatPage.onActivate === 'function') {
      window.ChatPage.onActivate();
    }
  }

  function syncDashboard() {
    if (!rootEl || isRemoteEntry()) return;
    var dashboard = rootEl.querySelector('#mobile-work-dashboard');
    if (!dashboard || !window.ChatWelcome || typeof window.ChatWelcome.syncDashboard !== 'function') return;

    var shell = window.AppShell;
    window.ChatWelcome.syncDashboard(dashboard, {
      supervisorMode: shell && typeof shell.getSupervisorMode === 'function' ? shell.getSupervisorMode() : 'adaptive',
      connectionState: shell && typeof shell.getConnectionState === 'function' ? shell.getConnectionState() : 'disconnected',
      setupRequired: window.AppRouter && typeof window.AppRouter.isSetupRequired === 'function' ? window.AppRouter.isSetupRequired() : false,
    });
  }

  function handlePromptSelect(value) {
    if (!value) return;
    attachComposer();
    if (window.ChatUI && typeof window.ChatUI.setInputValue === 'function') {
      window.ChatUI.setInputValue(value);
      if (typeof window.ChatUI.autoResizeInput === 'function') window.ChatUI.autoResizeInput();
      if (typeof window.ChatUI.focusInput === 'function') window.ChatUI.focusInput();
    } else {
      var input = document.getElementById('chat-input');
      if (input) {
        input.value = value;
        input.focus();
      }
    }
  }

  function syncChatActivity() {
    if (!rootEl || isRemoteEntry()) return;
    var scroll = rootEl.querySelector('.mobile-work-scroll');
    if (!scroll) return;
    var msgCount = 0;
    if (window.ChatSession && typeof window.ChatSession.getMessages === 'function') {
      msgCount = window.ChatSession.getMessages().length;
    }
    var busy = window.ChatPage && typeof window.ChatPage.isWorkloadActive === 'function'
      && window.ChatPage.isWorkloadActive();
    var hide = msgCount > 0 || busy;
    scroll.classList.toggle('is-collapsed', hide);
    rootEl.classList.toggle('mobile-work-has-chat', hide);
  }

  function onActivate() {
    if (window.MobileShell) {
      window.MobileShell.setTopBarMode('work');
    }
    if (isRemoteEntry()) {
      attachRemoteChat();
      return;
    }
    attachComposer();
    syncDashboard();
    syncChatActivity();
  }

  return {
    render: render,
    onActivate: onActivate,
    syncChatActivity: syncChatActivity,
  };
})();
