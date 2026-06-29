/**
 * 移动端会话列表抽屉：复用 ChatSessionStore，UI 对齐桌面侧栏会话区。
 */

/* exported MobileSessionDrawer */

window.MobileSessionDrawer = (function () {
  'use strict';

  var Store = window.ChatSessionStore;
  var panelEl = null;

  function mount(panel) {
    panelEl = panel;
    if (!panelEl) return;

    panelEl.innerHTML =
      '<div class="mobile-drawer-header">' +
        '<span class="mobile-drawer-title">会话</span>' +
        '<button type="button" class="mobile-drawer-new-btn" aria-label="新建会话">' +
          '<span aria-hidden="true">+</span> 新建会话' +
        '</button>' +
      '</div>' +
      '<div class="mobile-drawer-list"></div>';

    panelEl.querySelector('.mobile-drawer-new-btn').addEventListener('click', handleNewSession);
    Store.onChange(function () { renderList(); });
    Store.fetchSessions(function () { renderList(); });
  }

  function isSwitchLocked() {
    if (window.ChatPage && typeof window.ChatPage.isWorkloadActive === 'function') {
      return window.ChatPage.isWorkloadActive();
    }
    var WS = window.ChatWebSocket;
    return !!(WS && typeof WS.isProcessing === 'function' && WS.isProcessing());
  }

  function formatRelativeTime(ts) {
    if (!ts) return '';
    var now = Date.now();
    var diff = Math.max(0, now - Number(ts));
    var min = 60 * 1000;
    var hour = 60 * min;
    var day = 24 * hour;
    if (diff < min) return '刚刚';
    if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
    if (diff < day) return Math.floor(diff / hour) + ' 小时前';
    if (diff < day * 2) return '昨天';
    if (diff < day * 7) return Math.floor(diff / day) + '天前';
    var d = new Date(Number(ts));
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function renderList() {
    if (!panelEl) return;
    var list = panelEl.querySelector('.mobile-drawer-list');
    if (!list) return;
    list.innerHTML = '';

    var sessions = Store.getSessions();
    var activeId = Store.getActiveSessionId();
    var locked = isSwitchLocked();

    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var isActive = s.id === activeId;
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'mobile-drawer-item' + (isActive ? ' is-active' : '');
      item.setAttribute('data-id', s.id);
      item.disabled = locked;

      item.innerHTML =
        '<span class="mobile-drawer-item-title">' + escapeHtml(s.title || '未命名') + '</span>' +
        '<span class="mobile-drawer-item-time">' + formatRelativeTime(s.updatedAt) + '</span>';

      (function (sid) {
        item.addEventListener('click', function () {
          selectSession(sid);
        });
      })(s.id);

      list.appendChild(item);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function handleNewSession() {
    if (isSwitchLocked()) return;
    Store.createSession('新会话', function (session) {
      if (!session) return;
      renderList();
      selectSession(session.id);
    });
  }

  function selectSession(sessionId) {
    if (!sessionId || isSwitchLocked()) return;

    if (window.MobileShell && typeof window.MobileShell.closeDrawer === 'function') {
      window.MobileShell.closeDrawer();
    }

    var wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;
    var Router = window.AppRouter;

    Store.switchSession(sessionId, wsSend, function (ok, runningTurn) {
      if (!ok) return;
      renderList();

      var isMobile = Router && typeof Router.getShell === 'function' && Router.getShell() === 'mobile';
      if (!isMobile) {
        if (Router && typeof Router.navigateWorkChat === 'function') {
          Router.navigateWorkChat(sessionId);
        }
        return;
      }

      // 移动端主 Shell：留在工作 Tab 切换会话，不进入 workChat 二级页
      var path = String(window.location.pathname || '').replace(/\/+$/, '') || '/';
      var page = document.body.dataset.page;
      if (path.indexOf('/m/work/') === 0 || page === 'workChat') {
        if (Router && typeof Router.navigate === 'function') {
          Router.navigate('work');
        }
      } else if (page !== 'work') {
        if (Router && typeof Router.navigate === 'function') {
          Router.navigate('work');
        }
      }

      if (window.MobileWorkPage && typeof window.MobileWorkPage.onActivate === 'function') {
        window.MobileWorkPage.onActivate();
      }
      if (window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
        window.ChatPage.onSessionSwitched(sessionId, runningTurn);
      }
      if (window.MobileWorkPage && typeof window.MobileWorkPage.syncChatActivity === 'function') {
        window.MobileWorkPage.syncChatActivity();
      }
    });
  }

  function syncSwitchLockState() {
    if (!panelEl) return;
    renderList();
  }

  function onOpen() {
    renderList();
  }

  return {
    mount: mount,
    onOpen: onOpen,
    renderList: renderList,
    syncSwitchLockState: syncSwitchLockState,
  };
})();
