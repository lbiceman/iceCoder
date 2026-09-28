// @ts-nocheck
/**
 * 移动端会话列表抽屉：复用 ChatSessionStore，UI 对齐桌面侧栏会话区。
 */

/* exported MobileSessionDrawer */

export const MobileSessionDrawer = (() => {

  const Store = window.ChatSessionStore;
  let panelEl = null;

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
    Store.onChange(() => { renderList(); });
    Store.fetchSessions(() => { renderList(); });
  }

  function formatRelativeTime(ts) {
    if (!ts) return '';
    const now = Date.now();
    const diff = Math.max(0, now - Number(ts));
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < day * 2) return '昨天';
    if (diff < day * 7) return `${Math.floor(diff / day)}天前`;
    const d = new Date(Number(ts));
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function renderList() {
    if (!panelEl) return;
    const list = panelEl.querySelector('.mobile-drawer-list');
    if (!list) return;
    list.innerHTML = '';

    const sessions = Store.getSessions();
    const activeId = Store.getActiveSessionId();

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const isActive = s.id === activeId;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mobile-drawer-item' + (isActive ? ' is-active' : '');
      item.setAttribute('data-id', s.id);

      const runPhase = Store.getRunPhase ? Store.getRunPhase(s.id) : '';
      let runDotHtml = '';
      if (runPhase === 'running' || runPhase === 'done' || runPhase === 'error') {
        item.setAttribute('data-run-phase', runPhase);
        item.classList.add('has-run-dot');
        const label = runPhase === 'running' ? '任务进行中' : runPhase === 'done' ? '任务已完成' : '任务失败';
        runDotHtml = `<span class="mobile-drawer-item-run-dot is-${runPhase}" aria-label="${label}"></span>`;
      }

      item.innerHTML =
        `${runDotHtml}<span class="mobile-drawer-item-title">${escapeHtml(s.title || '未命名')}</span><span class="mobile-drawer-item-time">${formatRelativeTime(s.updatedAt)}</span>`;

      ((sid) => {
        item.addEventListener('click', () => {
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
    Store.createSession('新会话', (session) => {
      if (!session) return;
      renderList();
      selectSession(session.id);
    });
  }

  function selectSession(sessionId) {
    if (!sessionId) return;

    if (window.MobileShell && typeof window.MobileShell.closeDrawer === 'function') {
      window.MobileShell.closeDrawer();
    }

    // 已在当前会话：只关抽屉（桌面侧栏同理直接 return）
    if (sessionId === Store.getActiveSessionId()) return;

    const wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;
    const Router = window.AppRouter;

    Store.switchSession(sessionId, wsSend, (ok, runningTurn, _workspace, _degraded, bgTasks, runtime) => {
      if (!ok) return;
      renderList();

      const isMobile = Router && typeof Router.getShell === 'function' && Router.getShell() === 'mobile';
      if (!isMobile) {
        if (Router && typeof Router.navigateWorkChat === 'function') {
          Router.navigateWorkChat(sessionId);
        }
        return;
      }

      // 移动端主 Shell：留在工作 Tab 切换会话，不进入 workChat 二级页
      const path = String(window.location.pathname || '').replace(/\/+$/, '') || '/';
      const page = document.body.dataset.page;
      if (path.startsWith('/m/work/') || page === 'workChat') {
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
        window.ChatPage.onSessionSwitched(sessionId, runningTurn, { bgTasks, ...(runtime || {}) });
      }
      if (window.MobileWorkPage && typeof window.MobileWorkPage.syncChatActivity === 'function') {
        window.MobileWorkPage.syncChatActivity();
      }
    });
  }

  function onOpen() {
    renderList();
  }

  return {
    mount,
    onOpen,
    renderList,
  };
})();

if (typeof window !== 'undefined') {
  window.MobileSessionDrawer = MobileSessionDrawer;
}
