/**
 * 移动端聊天详情页：子 Tab + 复用 ChatPage Core。
 */

/* exported MobileChatPage */

window.MobileChatPage = (function () {
  'use strict';

  var Store = window.ChatSessionStore;
  var mounted = false;
  var rootEl = null;
  var currentSessionId = null;
  var activeSubTab = 'chat';

  function render(parentEl, sessionId) {
    rootEl = parentEl;
    parentEl.className = 'page-root page-root-workChat mobile-page-root';

    if (mounted && sessionId === currentSessionId) {
      updateTopBar(sessionId);
      attachChatCore();
      onActivate();
      return;
    }

    currentSessionId = sessionId;

    if (!mounted) {
      mounted = true;
      parentEl.innerHTML =
        '<div class="mobile-chat-page">' +
          '<div class="mobile-chat-subtabs" role="tablist">' +
            '<button type="button" class="mobile-chat-subtab is-active" data-tab="chat" role="tab" aria-selected="true">对话</button>' +
            '<button type="button" class="mobile-chat-subtab" data-tab="files" role="tab" aria-selected="false">文件</button>' +
            '<button type="button" class="mobile-chat-subtab" data-tab="skills" role="tab" aria-selected="false">技能</button>' +
          '</div>' +
          '<div class="mobile-chat-body">' +
            '<div class="mobile-chat-core" id="mobile-chat-core"></div>' +
            '<div class="mobile-chat-panel mobile-chat-panel-files hidden" data-panel="files">' +
              '<p class="mobile-chat-panel-placeholder">文件面板（V1 占位）</p>' +
            '</div>' +
            '<div class="mobile-chat-panel mobile-chat-panel-skills hidden" data-panel="skills">' +
              '<p class="mobile-chat-panel-placeholder">技能面板（V1 占位）</p>' +
            '</div>' +
          '</div>' +
        '</div>';

      var subtabs = parentEl.querySelectorAll('.mobile-chat-subtab');
      for (var i = 0; i < subtabs.length; i++) {
        (function (btn) {
          btn.addEventListener('click', function () {
            setSubTab(btn.getAttribute('data-tab'));
          });
        })(subtabs[i]);
      }
    }

    updateTopBar(sessionId);
    mountChatCore(sessionId);
  }

  function attachChatCore() {
    if (!rootEl || !window.MobileComposerHost) return;
    var coreEl = rootEl.querySelector('#mobile-chat-core');
    if (coreEl) window.MobileComposerHost.attachToChatCore(coreEl);
  }

  function updateTopBar(sessionId) {
    if (!window.MobileShell) return;
    var sessions = Store.getSessions();
    var title = '会话';
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) {
        title = sessions[i].title || '未命名';
        break;
      }
    }
    window.MobileShell.setTopBarMode('workChat', { title: title });
  }

  function setSubTab(tab) {
    activeSubTab = tab || 'chat';
    if (!rootEl) return;

    var btns = rootEl.querySelectorAll('.mobile-chat-subtab');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var on = btn.getAttribute('data-tab') === activeSubTab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }

    var core = rootEl.querySelector('.mobile-chat-core');
    var panels = rootEl.querySelectorAll('.mobile-chat-panel');
    if (core) core.classList.toggle('hidden', activeSubTab !== 'chat');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('hidden', panels[j].getAttribute('data-panel') !== activeSubTab);
    }
  }

  function mountChatCore(sessionId) {
    var coreEl = rootEl && rootEl.querySelector('#mobile-chat-core');
    if (!coreEl || !window.ChatPage) return;

    if (window.MobileComposerHost) {
      window.MobileComposerHost.attachToChatCore(coreEl);
    }

    var wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;

    Store.switchSession(sessionId, wsSend, function (ok, runningTurn) {
      if (!ok) return;

      if (window.ChatPage.isMounted && !window.ChatPage.isMounted()) {
        var host = window.MobileComposerHost ? window.MobileComposerHost.getHost() : coreEl;
        window.ChatPage.render(host || coreEl);
      }

      if (window.ChatPage.onSessionSwitched) {
        window.ChatPage.onSessionSwitched(sessionId, runningTurn);
      } else if (window.ChatPage.onActivate) {
        window.ChatPage.onActivate();
      }

      if (window.MobileComposerHost && typeof window.MobileComposerHost.tryPendingSend === 'function') {
        window.MobileComposerHost.tryPendingSend();
      }
      updateTopBar(sessionId);
    });
  }

  function onActivate() {
    if (!currentSessionId) return;
    attachChatCore();
    if (window.ChatPage && typeof window.ChatPage.onActivate === 'function') {
      window.ChatPage.onActivate();
    }
    updateTopBar(currentSessionId);
  }

  return {
    render: render,
    onActivate: onActivate,
  };
})();
