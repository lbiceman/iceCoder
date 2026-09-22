// @ts-nocheck
/**
 * 会话侧栏组件
 * 职责：侧栏 DOM 创建与渲染、会话列表、新建按钮、编辑标题、选中高亮
 * 侧栏全站固定常驻，无窄屏抽屉/折叠
 */

/* exported ChatSessionSidebar */

export const ChatSessionSidebar = (() => {

  const Store = window.ChatSessionStore;
  let sidebar = null;

  function ic(name, width) {
    return window.AppIcon ? window.AppIcon.html(name, { width: width || 14 }) : '';
  }

  function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/').toLowerCase();
  }

  function compactPath(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const parts = norm.split('/').filter((x) =>  x && x !== '.');
    if (parts.length <= 2) return p || '';
    return `…/${parts.slice(-2).join('/')}`;
  }

  function formatWorkspaceSubtitle(sessionId) {
    const root = Store.getSessionWorkspace ? Store.getSessionWorkspace(sessionId) : '';
    const def = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
    if (!root && !def) return '';
    if (Store.isDefaultWorkspace && Store.isDefaultWorkspace(sessionId)) return '默认工作区';
    if (def && root && normalizePath(root) === normalizePath(def)) return '默认工作区';
    return compactPath(root || def);
  }

  function fullWorkspacePath(sessionId) {
    const root = Store.getSessionWorkspace ? Store.getSessionWorkspace(sessionId) : '';
    const def = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
    return root || def || '';
  }

  /** 销毁侧栏 DOM（仅重建时调用；切页不销毁，侧栏挂在 app-shell 上常驻） */
  function destroy() {
    if (sidebar) {
      sidebar.remove();
      sidebar = null;
    }
  }

  /** 创建侧栏 DOM（插入到 .app-shell 内、.app-main 之前，全站常驻） */
  function create(shellEl) {
    if (sidebar && sidebar.isConnected) return sidebar;
    destroy();

    const host = shellEl || document.querySelector('.app-shell');
    if (!host) return null;

    sidebar = document.createElement('aside');
    sidebar.className = 'chat-session-sidebar';
    sidebar.innerHTML =
      `<div class="chat-sidebar-brand"><span class="chat-sidebar-brand-icon ice-brand-logo" aria-hidden="true"></span><span class="chat-sidebar-brand-logo">IceCoder</span></div><nav class="chat-sidebar-nav" role="tablist" aria-label="主导航"><button class="chat-sidebar-nav-btn" data-page="chat" role="tab" aria-selected="true"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('work')}</span><span class="chat-sidebar-nav-btn-label">工作</span></button><button class="chat-sidebar-nav-btn" data-page="memory" role="tab" aria-selected="false"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('memory')}</span><span class="chat-sidebar-nav-btn-label">记忆</span></button><button class="chat-sidebar-nav-btn" data-page="skills" role="tab" aria-selected="false"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('skills')}</span><span class="chat-sidebar-nav-btn-label">技能</span></button><button class="chat-sidebar-nav-btn" data-page="stats" role="tab" aria-selected="false"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('stats')}</span><span class="chat-sidebar-nav-btn-label">统计</span></button></nav><div class="chat-sidebar-header"><div class="chat-sidebar-header-top"><span class="chat-sidebar-title">会话</span></div><button class="chat-sidebar-new-btn" title="新建会话"><span class="chat-sidebar-new-btn-icon" aria-hidden="true">${ic('plus', 14)}</span><span class="chat-sidebar-new-btn-label">新建会话</span></button></div><div class="chat-sidebar-list"></div><div class="chat-sidebar-footer"><button class="chat-sidebar-control chat-sidebar-settings-btn" type="button" title="设置"><span class="chat-sidebar-control-icon" aria-hidden="true">${ic('settings')}</span><span class="chat-sidebar-control-label">设置</span></button><button class="chat-sidebar-control chat-sidebar-mode-btn" type="button" data-mode="adaptive" title="点击切换监管模式"><span class="chat-sidebar-control-icon" aria-hidden="true">${ic('clock')}</span><span class="chat-sidebar-control-label">自适应</span></button><div class="chat-sidebar-control chat-sidebar-connection" data-state="disconnected" title="连接状态"><span class="chat-sidebar-control-icon" aria-hidden="true">${ic('wifi')}</span></div></div>`;

    const mainEl = host.querySelector('.app-main');
    if (mainEl) {
      host.insertBefore(sidebar, mainEl);
    } else {
      host.insertBefore(sidebar, host.firstChild);
    }
    bindEvents();
    if (window.AppIcon) window.AppIcon.hydrate(sidebar);
    Store.fetchSessions(() => { renderList(); });
    return sidebar;
  }

  function getRouteFromHash() {
    const h = String(window.location.hash || '').replace(/^#\/?/, '').split('/')[0];
    if (h === 'chat' || h === 'memory' || h === 'skills' || h === 'stats' || h === 'settings' || h === 'config') {
      return h === 'config' ? 'settings' : h;
    }
    return 'chat';
  }

  /** 记忆 / 技能 / 统计 / 设置：会话列表不当作当前页，点会话回到聊天 */
  function isAuxiliaryNavPage() {
    const route = getRouteFromHash();
    return route === 'memory' || route === 'skills' || route === 'stats' || route === 'settings';
  }

  function navigateToChatPage() {
    if (window.location.hash !== '#/chat') {
      window.location.hash = '#/chat';
    }
  }

  function syncSidebarSettingsActive() {
    if (!sidebar) return;
    const btn = sidebar.querySelector('.chat-sidebar-settings-btn');
    if (!btn) return;
    const onSettings = getRouteFromHash() === 'settings';
    btn.classList.toggle('is-active', onSettings);
    btn.setAttribute('aria-current', onSettings ? 'page' : 'false');
  }

  function syncSidebarNavActive() {
    if (!sidebar) return;
    const current = getRouteFromHash();
    const btns = sidebar.querySelectorAll('.chat-sidebar-nav-btn');
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const page = btn.getAttribute('data-page');
      const on = page === current;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    syncSidebarSettingsActive();
  }

  function bindEvents() {
    sidebar.querySelector('.chat-sidebar-new-btn').addEventListener('click', () => {
      Store.createSession('新会话', (session) => {
        if (session) {
          renderList();
          selectSession(session.id);
        }
      });
    });

    const navBtns = sidebar.querySelectorAll('.chat-sidebar-nav-btn');
    for (let i = 0; i < navBtns.length; i++) {
      ((btn) => {
        btn.addEventListener('click', () => {
          const page = btn.getAttribute('data-page');
          if (!page) return;
          if (window.location.hash !== `#/${page}`) {
            window.location.hash = `#/${page}`;
          } else {
            // 已经在该路由：仍触发一次 hashchange 监听器，保持行为一致
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }
        });
      })(navBtns[i]);
    }
    syncSidebarNavActive();
    window.addEventListener('hashchange', () => {
      syncSidebarNavActive();
      renderList();
    });

    bindShellControls();
    bindShellCollabWs();

    Store.onChange(() => { renderList(); });
  }

  function notifyShellCollabUpdated(data) {
    if (!data) return;
    if (data.shellCollabActiveBySession && Store.applyShellCollabActiveMap) {
      Store.applyShellCollabActiveMap(data.shellCollabActiveBySession);
    } else {
      const sid = data.sessionId;
      if (sid && typeof data.shellCollabActive === 'boolean' && Store.setShellCollabActive) {
        Store.setShellCollabActive(sid, data.shellCollabActive);
      }
    }
    renderList();
  }

  function bindShellCollabWs() {
    const WS = window.ChatWebSocket;
    if (!WS || WS.__shellCollabSidebarBound) return;
    WS.__shellCollabSidebarBound = true;
    WS.on('connected', notifyShellCollabUpdated);
    WS.on('shell_collab_entered', notifyShellCollabUpdated);
  }

  function syncShellMode() {
    if (!sidebar) return;
    const shell = window.AppShell;
    const btn = sidebar.querySelector('.chat-sidebar-mode-btn');
    if (!btn) return;
    const mode = (shell && typeof shell.getSupervisorMode === 'function') ? shell.getSupervisorMode() : 'adaptive';
    const label = (shell && typeof shell.getSupervisorLabel === 'function') ? shell.getSupervisorLabel(mode) : mode;
    btn.setAttribute('data-mode', mode);
    const labelEl = btn.querySelector('.chat-sidebar-control-label');
    if (labelEl) labelEl.textContent = label;
    btn.title = `监管模式：${label}（点击切换）`;
  }

  function syncShellConnection(state) {
    if (!sidebar) return;
    const el = sidebar.querySelector('.chat-sidebar-connection');
    if (!el) return;
    let resolved = state;
    if (!resolved) {
      const shell = window.AppShell;
      resolved = (shell && typeof shell.getConnectionState === 'function') ? shell.getConnectionState() : 'disconnected';
    }
    el.setAttribute('data-state', resolved);
  }

  function bindShellControls() {
    const shell = window.AppShell;
    syncShellMode();
    syncShellConnection();
    syncSidebarSettingsActive();

    const modeBtn = sidebar.querySelector('.chat-sidebar-mode-btn');
    if (modeBtn) {
      modeBtn.addEventListener('click', () => {
        if (!shell || typeof shell.cycleSupervisorMode !== 'function') return;
        shell.cycleSupervisorMode();
      });
    }

    const settingsBtn = sidebar.querySelector('.chat-sidebar-settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        if (window.location.hash !== '#/settings') {
          window.location.hash = '#/settings';
        } else {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
      });
    }

    if (shell) {
      if (typeof shell.addSupervisorModeListener === 'function') {
        shell.addSupervisorModeListener(() => { syncShellMode(); });
      }
      if (typeof shell.addConnectionChangeListener === 'function') {
        shell.addConnectionChangeListener((state) => { syncShellConnection(state); });
      }
    }
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
    if (diff < day * 3) return '2天前';
    if (diff < day * 7) return `${Math.floor(diff / day)}天前`;
    const d = new Date(Number(ts));
    const m = d.getMonth() + 1;
    const dd = d.getDate();
    return `${m}月${dd}日`;
  }

  function basename(p) {
    if (!p) return '';
    const norm = String(p).replace(/\\/g, '/');
    const parts = norm.split('/').filter((x) =>  x && x !== '.');
    return parts.length ? parts[parts.length - 1] : (p || '');
  }

  function renderWorkspaceFooter() {
    if (!sidebar) return;
    const activeId = Store.getActiveSessionId();
    const root = fullWorkspacePath(activeId);
    const nameEl = sidebar.querySelector('.chat-sidebar-workspace-name');
    const pathEl = sidebar.querySelector('.chat-sidebar-workspace-path');
    if (nameEl) nameEl.textContent = basename(root) || 'IceCoder';
    if (pathEl) {
      const home = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
      if (root && home) {
        const normRoot = String(root).replace(/\\/g, '/');
        const normHome = String(home).replace(/\\/g, '/');
        let rel;
        if (normRoot.toLowerCase() === normHome.toLowerCase()) {
          rel = '~';
        } else if (normRoot.toLowerCase().startsWith(`${normHome.toLowerCase()}/`)) {
          rel = `~/${normRoot.slice(normHome.length + 1)}`;
        } else {
          rel = compactPath(root);
        }
        pathEl.textContent = rel;
        pathEl.title = root;
      } else {
        pathEl.textContent = '';
        pathEl.removeAttribute('title');
      }
    }
  }

  function renderList() {
    if (!sidebar) return;
    const list = sidebar.querySelector('.chat-sidebar-list');
    if (!list) return;
    list.innerHTML = '';

    const sessions = Store.getSessions();
    const activeId = Store.getActiveSessionId();
    const highlightActive = !isAuxiliaryNavPage();

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const isActive = highlightActive && s.id === activeId;
      const item = document.createElement('div');
      item.className = 'chat-sidebar-item' + (isActive ? ' active' : '');
      item.setAttribute('data-id', s.id);

      const runPhase = Store.getRunPhase ? Store.getRunPhase(s.id) : '';
      if (runPhase === 'running' || runPhase === 'done' || runPhase === 'error') {
        item.setAttribute('data-run-phase', runPhase);
        item.classList.add('has-run-dot');
        const runDot = document.createElement('span');
        runDot.className = `chat-sidebar-item-run-dot is-${runPhase}`;
        runDot.setAttribute(
          'aria-label',
          runPhase === 'running' ? '任务进行中' : runPhase === 'done' ? '任务已完成' : '任务失败',
        );
        item.appendChild(runDot);
      }

      const body = document.createElement('div');
      body.className = 'chat-sidebar-item-body';

      const titleRow = document.createElement('div');
      titleRow.className = 'chat-sidebar-item-title-row';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'chat-sidebar-item-title';
      titleSpan.textContent = s.title || '未命名';
      titleSpan.title = s.title || '未命名';

      ((sid, titleEl) => {
        titleEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          startRename(sid, titleEl);
        });
      })(s.id, titleSpan);
      titleRow.appendChild(titleSpan);

      if (!isActive) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'chat-sidebar-item-delete';
        delBtn.title = '删除会话';
        delBtn.setAttribute('aria-label', '删除会话');
        delBtn.textContent = '×';
        ((sid) => {
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSessionItem(sid);
          });
        })(s.id);
        titleRow.appendChild(delBtn);
      }

      body.appendChild(titleRow);

      const meta = document.createElement('div');
      meta.className = 'chat-sidebar-item-meta';

      if (Store.getShellCollabActive && Store.getShellCollabActive(s.id)) {
        const shellBadge = document.createElement('span');
        shellBadge.className = 'chat-sidebar-item-shell-badge';
        shellBadge.title = 'Shell 协作模式已固定；需要普通 Agent 请新建会话';
        shellBadge.setAttribute('aria-label', 'Shell 协作模式');
        shellBadge.innerHTML =
          `${ic('terminal', 11)}<span class="chat-sidebar-item-shell-label">Shell</span>`;
        meta.appendChild(shellBadge);
      }

      if (isActive) {
        const subtitle = document.createElement('span');
        subtitle.className = 'chat-sidebar-item-subtitle';
        const subtitleText = formatWorkspaceSubtitle(s.id);
        const fullPath = fullWorkspacePath(s.id);
        subtitle.textContent = subtitleText || '默认工作区';
        if (subtitleText === '默认工作区' || !subtitleText) subtitle.classList.add('is-default');
        if (fullPath) subtitle.title = fullPath;
        meta.appendChild(subtitle);
      } else {
        const time = document.createElement('span');
        time.className = 'chat-sidebar-item-time';
        time.textContent = formatRelativeTime(s.updatedAt);
        meta.appendChild(time);
      }

      body.appendChild(meta);

      item.appendChild(body);

      ((sid) => {
        item.addEventListener('click', () => { selectSession(sid); });
      })(s.id);

      list.appendChild(item);
    }
    if (window.AppIcon) window.AppIcon.hydrate(list);
    renderWorkspaceFooter();
  }

  function applyWorkspaceForSession(sessionId, workspacePayload) {
    if (workspacePayload && Store.setSessionWorkspace) {
      Store.setSessionWorkspace(sessionId, workspacePayload);
      if (typeof workspacePayload.shellCollabActive === 'boolean' && Store.setShellCollabActive) {
        Store.setShellCollabActive(sessionId, workspacePayload.shellCollabActive);
      }
      return;
    }
    Store.fetchSessions(() => { renderList(); });
  }

  function deleteSessionItem(sessionId) {
    Modal.confirm({
      title: '删除会话',
      message: '确定要删除该会话吗？此操作不可撤销。',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      dangerConfirm: true,
    }).then((ok) => {
      if (!ok) return;
      const wasActive = Store.getActiveSessionId() === sessionId;
      const wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;
      Store.deleteSession(sessionId, wsSend, (ok, info) => {
        if (!ok) return;
        renderList();
        if (wasActive && info && info.switchedTo
            && window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
          window.ChatPage.onSessionSwitched(info.switchedTo);
        }
      });
    });
  }

  function selectSession(sessionId) {
    const leaveAuxiliary = isAuxiliaryNavPage();
    if (sessionId === Store.getActiveSessionId()) {
      if (leaveAuxiliary) navigateToChatPage();
      return;
    }
    Store.switchSession(sessionId, window.ChatWebSocket ? window.ChatWebSocket.send : null, (ok, runningTurn, workspacePayload, _degraded, bgTasks, runtime) => {
      if (!ok) return;
      applyWorkspaceForSession(sessionId, workspacePayload);
      renderList();
      if (window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
        window.ChatPage.onSessionSwitched(sessionId, runningTurn, { bgTasks, ...(runtime || {}) });
      }
      if (leaveAuxiliary) navigateToChatPage();
    });
  }

  function startRename(sessionId, titleEl) {
    const current = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-sidebar-rename-input';
    input.value = current;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      const newTitle = input.value.trim() || current;
      Store.renameSession(sessionId, newTitle, () => { renderList(); });
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { input.blur(); }
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
  }

  /** WS / connected 推送的工作区更新 */
  function notifyWorkspaceUpdated(data) {
    if (!data) return;
    const sid = data.sessionId || data.activeSessionId;
    if (!sid || !Store.setSessionWorkspace) return;
    Store.setSessionWorkspace(sid, data);
    if (typeof data.shellCollabActive === 'boolean' && Store.setShellCollabActive) {
      Store.setShellCollabActive(sid, data.shellCollabActive);
    }
  }

  return {
    create,
    destroy,
    renderList,
    notifyWorkspaceUpdated,
    notifyShellCollabUpdated,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatSessionSidebar = ChatSessionSidebar;
}
