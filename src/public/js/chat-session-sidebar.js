/**
 * 会话侧栏组件
 * 职责：侧栏 DOM 创建与渲染、会话列表、新建按钮、编辑标题、选中高亮
 * 窄屏（≤768px）抽屉模式 + backdrop
 */

/* exported ChatSessionSidebar */

window.ChatSessionSidebar = (function () {
  'use strict';

  var Store = window.ChatSessionStore;
  var STORAGE_KEY_PANEL = 'ice-chat-sidebar-panel-visible';
  var sidebar = null;
  var backdrop = null;
  var isOpen = false;
  /** 桌面端侧栏是否展开（窄屏用抽屉 isOpen） */
  var panelVisible = true;
  var navToggleBtn = null;

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

  function readPanelVisible() {
    try {
      return localStorage.getItem(STORAGE_KEY_PANEL) !== '0';
    } catch (_e) {
      return true;
    }
  }

  function savePanelVisible() {
    try {
      localStorage.setItem(STORAGE_KEY_PANEL, panelVisible ? '1' : '0');
    } catch (_e) { /* ignore */ }
  }

  function syncToggleButtonState() {
    var expanded = isNarrow() ? isOpen : panelVisible;
    var targets = [];
    if (navToggleBtn) targets.push(navToggleBtn);
    var legacy = document.getElementById('sidebar-toggle');
    if (legacy) targets.push(legacy);
    for (var i = 0; i < targets.length; i++) {
      var btn = targets[i];
      btn.classList.toggle('is-expanded', expanded);
      btn.classList.toggle('is-collapsed', !expanded);
      btn.title = expanded ? '隐藏会话列表' : '显示会话列表';
      btn.setAttribute('aria-pressed', expanded ? 'true' : 'false');
    }
  }

  function applyPanelVisibility() {
    if (!sidebar) return;
    if (isNarrow()) {
      sidebar.classList.remove('collapsed');
      return;
    }
    sidebar.classList.toggle('collapsed', !panelVisible);
  }

  /** 离开聊天页时销毁侧栏（pageContainer 清空后旧节点已脱离文档，须重置引用） */
  function destroy() {
    if (sidebar) {
      sidebar.remove();
      sidebar = null;
    }
    if (backdrop) {
      backdrop.classList.add('hidden');
      backdrop.remove();
      backdrop = null;
    }
    isOpen = false;
    navToggleBtn = null;
  }

  /** 创建侧栏 DOM（插入到 .chat-layout 内部、.chat-main 之前） */
  function create(chatContainer) {
    if (sidebar && sidebar.isConnected) return sidebar;
    destroy();

    sidebar = document.createElement('aside');
    sidebar.className = 'chat-session-sidebar';
    sidebar.innerHTML =
      '<div class="chat-sidebar-header">' +
        '<div class="chat-sidebar-header-top">' +
          '<span class="chat-sidebar-title">会话</span>' +
          '<button class="chat-sidebar-new-btn" title="新建会话">＋</button>' +
          '<button class="chat-sidebar-close-btn" title="关闭侧栏">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="chat-sidebar-list"></div>';

    backdrop = document.createElement('div');
    backdrop.className = 'chat-sidebar-backdrop hidden';

    chatContainer.insertBefore(sidebar, chatContainer.firstChild);
    document.body.appendChild(backdrop);

    bindEvents();
    panelVisible = readPanelVisible();
    applyPanelVisibility();
    syncToggleButtonState();
    Store.fetchSessions(function () { renderList(); });
    return sidebar;
  }

  function bindNavToggle(buttonEl) {
    if (!buttonEl || navToggleBtn === buttonEl) return;
    navToggleBtn = buttonEl;
    syncToggleButtonState();
  }

  function bindEvents() {
    sidebar.querySelector('.chat-sidebar-new-btn').addEventListener('click', function () {
      Store.createSession('新会话', function (session) {
        if (session) {
          renderList();
          selectSession(session.id);
        }
      });
    });

    sidebar.querySelector('.chat-sidebar-close-btn').addEventListener('click', function () {
      close();
    });

    backdrop.addEventListener('click', function () {
      close();
    });

    Store.onChange(function () { renderList(); });
  }

  function renderList() {
    var list = sidebar.querySelector('.chat-sidebar-list');
    if (!list) return;
    list.innerHTML = '';

    var sessions = Store.getSessions();
    var activeId = Store.getActiveSessionId();

    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var item = document.createElement('div');
      item.className = 'chat-sidebar-item' + (s.id === activeId ? ' active' : '');
      item.setAttribute('data-id', s.id);

      var body = document.createElement('div');
      body.className = 'chat-sidebar-item-body';

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

      body.appendChild(titleSpan);

      var subtitle = document.createElement('span');
      subtitle.className = 'chat-sidebar-item-subtitle';
      var fullPath = fullWorkspacePath(s.id);
      var subtitleText = formatWorkspaceSubtitle(s.id);
      subtitle.textContent = subtitleText;
      if (subtitleText === '默认工作区') subtitle.classList.add('is-default');
      if (fullPath) subtitle.title = fullPath;
      body.appendChild(subtitle);

      item.appendChild(body);

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
      item.appendChild(delBtn);

      (function (sid) {
        item.addEventListener('click', function () { selectSession(sid); });
      })(s.id);

      list.appendChild(item);
    }
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
    if (sessionId === Store.getActiveSessionId()) return;
    Store.switchSession(sessionId, window.ChatWebSocket ? window.ChatWebSocket.send : null, function (ok, runningTurn, workspacePayload) {
      if (ok) {
        applyWorkspaceForSession(sessionId, workspacePayload);
        if (isNarrow()) close();
        renderList();
        if (window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
          window.ChatPage.onSessionSwitched(sessionId, runningTurn);
        }
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

  function toggle() {
    if (isOpen) close(); else open();
    syncToggleButtonState();
  }

  function togglePanel() {
    if (isNarrow()) {
      toggle();
      return;
    }
    panelVisible = !panelVisible;
    savePanelVisible();
    applyPanelVisibility();
    syncToggleButtonState();
  }

  function isNarrow() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function open() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    if (isNarrow()) backdrop.classList.remove('hidden');
    isOpen = true;
    syncToggleButtonState();
    Store.fetchSessions(function () { renderList(); });
  }

  function close() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    backdrop.classList.add('hidden');
    isOpen = false;
    syncToggleButtonState();
  }

  function isOpenState() { return isOpen; }

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
    bindNavToggle: bindNavToggle,
    toggle: toggle,
    togglePanel: togglePanel,
    open: open,
    close: close,
    isOpen: isOpenState,
    isPanelVisible: function () { return isNarrow() ? isOpen : panelVisible; },
    renderList: renderList,
    notifyWorkspaceUpdated: notifyWorkspaceUpdated,
  };
})();
