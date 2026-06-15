/**
 * 会话侧栏组件
 * 职责：侧栏 DOM 创建与渲染、会话列表、新建按钮、编辑标题、选中高亮
 * 侧栏全站固定常驻，无窄屏抽屉/折叠
 */

/* exported ChatSessionSidebar */

window.ChatSessionSidebar = (function () {
  'use strict';

  var Store = window.ChatSessionStore;
  var sidebar = null;

  function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/').toLowerCase();
  }

  function compactPath(p) {
    var norm = String(p || '').replace(/\\/g, '/');
    var parts = norm.split('/').filter(function (x) { return x && x !== '.'; });
    if (parts.length <= 2) return p || '';
    return '\u2026/' + parts.slice(-2).join('/');
  }

  function formatWorkspaceSubtitle(sessionId) {
    var root = Store.getSessionWorkspace ? Store.getSessionWorkspace(sessionId) : '';
    var def = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
    if (!root && !def) return '';
    if (Store.isDefaultWorkspace && Store.isDefaultWorkspace(sessionId)) return '默认工作区';
    if (def && root && normalizePath(root) === normalizePath(def)) return '默认工作区';
    return compactPath(root || def);
  }

  function fullWorkspacePath(sessionId) {
    var root = Store.getSessionWorkspace ? Store.getSessionWorkspace(sessionId) : '';
    var def = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
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

    var host = shellEl || document.querySelector('.app-shell');
    if (!host) return null;

    sidebar = document.createElement('aside');
    sidebar.className = 'chat-session-sidebar';
    sidebar.innerHTML =
      '<div class="chat-sidebar-brand">' +
        '<span class="chat-sidebar-brand-logo">IceCoder</span>' +
      '</div>' +
      '<nav class="chat-sidebar-nav" role="tablist" aria-label="主导航">' +
        '<button class="chat-sidebar-nav-btn" data-page="chat" role="tab" aria-selected="true">' +
          '<span class="chat-sidebar-nav-btn-icon" aria-hidden="true">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v7A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Zm2 .5h8M4 8h6M4 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</span>' +
          '<span class="chat-sidebar-nav-btn-label">工作</span>' +
        '</button>' +
        '<button class="chat-sidebar-nav-btn" data-page="memory" role="tab" aria-selected="false">' +
          '<span class="chat-sidebar-nav-btn-icon" aria-hidden="true">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h7A1.5 1.5 0 0 1 13 3.5v9A1.5 1.5 0 0 1 11.5 14h-7A1.5 1.5 0 0 1 3 12.5v-9Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
          '</span>' +
          '<span class="chat-sidebar-nav-btn-label">记忆</span>' +
        '</button>' +
        '<button class="chat-sidebar-nav-btn" data-page="config" role="tab" aria-selected="false">' +
          '<span class="chat-sidebar-nav-btn-icon" aria-hidden="true">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
          '</span>' +
          '<span class="chat-sidebar-nav-btn-label">配置</span>' +
        '</button>' +
      '</nav>' +
      '<div class="chat-sidebar-header">' +
        '<div class="chat-sidebar-header-top">' +
          '<span class="chat-sidebar-title">会话</span>' +
        '</div>' +
        '<button class="chat-sidebar-new-btn" title="新建会话">' +
          '<span class="chat-sidebar-new-btn-icon" aria-hidden="true">+</span>' +
          '<span class="chat-sidebar-new-btn-label">新建会话</span>' +
        '</button>' +
      '</div>' +
      '<div class="chat-sidebar-list"></div>' +
      '<div class="chat-sidebar-footer">' +
      '<button class="chat-sidebar-control chat-sidebar-theme-btn" type="button" data-theme="dark" title="切换主题">' +
        '<span class="chat-sidebar-control-icon" aria-hidden="true">' +
          '<svg class="chat-sidebar-theme-icon-dark" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>' +
          '<svg class="chat-sidebar-theme-icon-light" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1M12.3 12.3l-1.1-1.1M4.8 4.8 3.7 3.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
        '</span>' +
        '<span class="chat-sidebar-control-label">主题</span>' +
      '</button>' +
        '<button class="chat-sidebar-control chat-sidebar-mode-btn" type="button" data-mode="adaptive" title="点击切换监管模式">' +
          '<span class="chat-sidebar-control-icon" aria-hidden="true">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="5.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.5v3.7l2.4 1.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</span>' +
          '<span class="chat-sidebar-control-label">自适应</span>' +
        '</button>' +
        '<div class="chat-sidebar-control chat-sidebar-connection" data-state="disconnected" title="连接状态">' +
          '<span class="chat-sidebar-control-icon" aria-hidden="true">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 5.8a8.5 8.5 0 0 1 12 0M4.4 8.2a5.5 5.5 0 0 1 7.2 0M6.8 10.6a2.5 2.5 0 0 1 2.4 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="13" r="0.9" fill="currentColor"/></svg>' +
          '</span>' +
        '</div>' +
      '</div>';

    var mainEl = host.querySelector('.app-main');
    if (mainEl) {
      host.insertBefore(sidebar, mainEl);
    } else {
      host.insertBefore(sidebar, host.firstChild);
    }
    bindEvents();
    Store.fetchSessions(function () { renderList(); });
    return sidebar;
  }

  function isSwitchLocked() {
    if (window.ChatPage && typeof window.ChatPage.isWorkloadActive === 'function') {
      return window.ChatPage.isWorkloadActive();
    }
    var WS = window.ChatWebSocket;
    return !!(WS && typeof WS.isProcessing === 'function' && WS.isProcessing());
  }

  function syncSwitchLockState() {
    if (!sidebar) return;
    var locked = isSwitchLocked();
    var list = sidebar.querySelector('.chat-sidebar-list');
    if (list) {
      list.classList.toggle('is-switch-locked', locked);
      list.title = locked ? '任务进行中，请先停止后再切换会话' : '';
    }
    var newBtn = sidebar.querySelector('.chat-sidebar-new-btn');
    if (newBtn) {
      newBtn.classList.toggle('is-disabled', locked);
      newBtn.title = locked ? '任务进行中，请先停止后再新建会话' : '新建会话';
    }
  }

  function getRouteFromHash() {
    var h = String(window.location.hash || '').replace(/^#\/?/, '').split('/')[0];
    if (h === 'chat' || h === 'memory' || h === 'config') return h;
    return 'chat';
  }

  function syncSidebarNavActive() {
    if (!sidebar) return;
    var current = getRouteFromHash();
    var btns = sidebar.querySelectorAll('.chat-sidebar-nav-btn');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var page = btn.getAttribute('data-page');
      var on = page === current;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function bindEvents() {
    sidebar.querySelector('.chat-sidebar-new-btn').addEventListener('click', function () {
      if (isSwitchLocked()) return;
      Store.createSession('新会话', function (session) {
        if (session) {
          renderList();
          selectSession(session.id);
        }
      });
    });

    var navBtns = sidebar.querySelectorAll('.chat-sidebar-nav-btn');
    for (var i = 0; i < navBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var page = btn.getAttribute('data-page');
          if (!page) return;
          if (window.location.hash !== '#/' + page) {
            window.location.hash = '#/' + page;
          } else {
            // 已经在该路由：仍触发一次 hashchange 监听器，保持行为一致
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }
        });
      })(navBtns[i]);
    }
    syncSidebarNavActive();
    window.addEventListener('hashchange', syncSidebarNavActive);

    bindShellControls();

    Store.onChange(function () { renderList(); });
  }

  function syncShellMode() {
    if (!sidebar) return;
    var shell = window.AppShell;
    var btn = sidebar.querySelector('.chat-sidebar-mode-btn');
    if (!btn) return;
    var mode = (shell && typeof shell.getSupervisorMode === 'function') ? shell.getSupervisorMode() : 'adaptive';
    var label = (shell && typeof shell.getSupervisorLabel === 'function') ? shell.getSupervisorLabel(mode) : mode;
    btn.setAttribute('data-mode', mode);
    var labelEl = btn.querySelector('.chat-sidebar-control-label');
    if (labelEl) labelEl.textContent = label;
    btn.title = '监管模式：' + label + '（点击切换）';
  }

  function syncShellTheme() {
    if (!sidebar) return;
    var shell = window.AppShell;
    var btn = sidebar.querySelector('.chat-sidebar-theme-btn');
    if (!btn) return;
    var theme = (shell && typeof shell.getTheme === 'function') ? shell.getTheme() : 'dark';
    btn.setAttribute('data-theme', theme);
    btn.title = theme === 'dark' ? '当前：深色模式，点击切换为浅色' : '当前：浅色模式，点击切换为深色';
  }

  function syncShellConnection(state) {
    if (!sidebar) return;
    var el = sidebar.querySelector('.chat-sidebar-connection');
    if (!el) return;
    var resolved = state;
    if (!resolved) {
      var shell = window.AppShell;
      resolved = (shell && typeof shell.getConnectionState === 'function') ? shell.getConnectionState() : 'disconnected';
    }
    el.setAttribute('data-state', resolved);
  }

  function bindShellControls() {
    var shell = window.AppShell;
    syncShellMode();
    syncShellTheme();
    syncShellConnection();

    var modeBtn = sidebar.querySelector('.chat-sidebar-mode-btn');
    if (modeBtn) {
      modeBtn.addEventListener('click', function () {
        if (!shell || typeof shell.cycleSupervisorMode !== 'function') return;
        shell.cycleSupervisorMode();
        syncShellMode();
      });
    }

    var themeBtn = sidebar.querySelector('.chat-sidebar-theme-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        if (!shell || typeof shell.toggleTheme !== 'function') return;
        shell.toggleTheme();
        syncShellTheme();
      });
    }

    if (shell) {
      shell.onSupervisorModeChange = function () { syncShellMode(); };
      shell.onThemeChange = function () { syncShellTheme(); };
      shell.onConnectionChange = function (state) { syncShellConnection(state); };
    }
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
    if (diff < day * 3) return '2天前';
    if (diff < day * 7) return Math.floor(diff / day) + '天前';
    var d = new Date(Number(ts));
    var m = d.getMonth() + 1;
    var dd = d.getDate();
    return m + '月' + dd + '日';
  }

  function basename(p) {
    if (!p) return '';
    var norm = String(p).replace(/\\/g, '/');
    var parts = norm.split('/').filter(function (x) { return x && x !== '.'; });
    return parts.length ? parts[parts.length - 1] : (p || '');
  }

  function renderWorkspaceFooter() {
    if (!sidebar) return;
    var activeId = Store.getActiveSessionId();
    var root = fullWorkspacePath(activeId);
    var nameEl = sidebar.querySelector('.chat-sidebar-workspace-name');
    var pathEl = sidebar.querySelector('.chat-sidebar-workspace-path');
    if (nameEl) nameEl.textContent = basename(root) || 'IceCoder';
    if (pathEl) {
      var home = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
      if (root && home) {
        var normRoot = String(root).replace(/\\/g, '/');
        var normHome = String(home).replace(/\\/g, '/');
        var rel;
        if (normRoot.toLowerCase() === normHome.toLowerCase()) {
          rel = '~';
        } else if (normRoot.toLowerCase().indexOf(normHome.toLowerCase() + '/') === 0) {
          rel = '~/' + normRoot.slice(normHome.length + 1);
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
    var list = sidebar.querySelector('.chat-sidebar-list');
    if (!list) return;
    list.innerHTML = '';

    var sessions = Store.getSessions();
    var activeId = Store.getActiveSessionId();

    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var isActive = s.id === activeId;
      var item = document.createElement('div');
      item.className = 'chat-sidebar-item' + (isActive ? ' active' : '');
      item.setAttribute('data-id', s.id);

      var body = document.createElement('div');
      body.className = 'chat-sidebar-item-body';

      var titleRow = document.createElement('div');
      titleRow.className = 'chat-sidebar-item-title-row';

      var titleSpan = document.createElement('span');
      titleSpan.className = 'chat-sidebar-item-title';
      titleSpan.textContent = s.title || '未命名';
      titleSpan.title = s.title || '未命名';

      (function (sid, titleEl) {
        titleEl.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          startRename(sid, titleEl);
        });
      })(s.id, titleSpan);
      titleRow.appendChild(titleSpan);

      if (isActive) {
        var dot = document.createElement('span');
        dot.className = 'chat-sidebar-item-dot';
        dot.setAttribute('aria-hidden', 'true');
        titleRow.appendChild(dot);
      } else {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'chat-sidebar-item-delete';
        delBtn.title = '删除会话';
        delBtn.setAttribute('aria-label', '删除会话');
        delBtn.textContent = '×';
        (function (sid) {
          delBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            deleteSessionItem(sid);
          });
        })(s.id);
        titleRow.appendChild(delBtn);
      }

      body.appendChild(titleRow);

      if (isActive) {
        var subtitle = document.createElement('span');
        subtitle.className = 'chat-sidebar-item-subtitle';
        var subtitleText = formatWorkspaceSubtitle(s.id);
        var fullPath = fullWorkspacePath(s.id);
        subtitle.textContent = subtitleText || '默认工作区';
        if (subtitleText === '默认工作区' || !subtitleText) subtitle.classList.add('is-default');
        if (fullPath) subtitle.title = fullPath;
        body.appendChild(subtitle);
      } else {
        var time = document.createElement('span');
        time.className = 'chat-sidebar-item-time';
        time.textContent = formatRelativeTime(s.updatedAt);
        body.appendChild(time);
      }

      item.appendChild(body);

      (function (sid) {
        item.addEventListener('click', function () { selectSession(sid); });
      })(s.id);

      list.appendChild(item);
    }
    syncSwitchLockState();
    renderWorkspaceFooter();
  }

  function applyWorkspaceForSession(sessionId, workspacePayload) {
    if (workspacePayload && Store.setSessionWorkspace) {
      Store.setSessionWorkspace(sessionId, workspacePayload);
      return;
    }
    Store.fetchSessions(function () { renderList(); });
  }

  function deleteSessionItem(sessionId) {
    Modal.confirm({
      title: '删除会话',
      message: '确定要删除该会话吗？此操作不可撤销。',
      type: 'warning',
      confirmText: '删除',
      cancelText: '取消',
    }).then(function (ok) {
      if (!ok) return;
      var wasActive = Store.getActiveSessionId() === sessionId;
      var wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;
      Store.deleteSession(sessionId, wsSend, function (ok, info) {
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
    if (isSwitchLocked()) return;
    if (sessionId === Store.getActiveSessionId()) return;
    Store.switchSession(sessionId, window.ChatWebSocket ? window.ChatWebSocket.send : null, function (ok, runningTurn, workspacePayload) {
      if (!ok) return;
      applyWorkspaceForSession(sessionId, workspacePayload);
      renderList();
      if (window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
        window.ChatPage.onSessionSwitched(sessionId, runningTurn);
      }
    });
  }

  function startRename(sessionId, titleEl) {
    var current = titleEl.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-sidebar-rename-input';
    input.value = current;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      var newTitle = input.value.trim() || current;
      Store.renameSession(sessionId, newTitle, function () { renderList(); });
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { input.blur(); }
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
  }

  /** WS / connected 推送的工作区更新 */
  function notifyWorkspaceUpdated(data) {
    if (!data) return;
    var sid = data.sessionId || data.activeSessionId;
    if (!sid || !Store.setSessionWorkspace) return;
    Store.setSessionWorkspace(sid, data);
  }

  return {
    create: create,
    destroy: destroy,
    renderList: renderList,
    syncSwitchLockState: syncSwitchLockState,
    notifyWorkspaceUpdated: notifyWorkspaceUpdated,
  };
})();
