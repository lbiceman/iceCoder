/**
 * SPA 路由和主应用逻辑
 * 处理配置页面和聊天页面之间的 hash 路由
 * 包含主题切换（默认暗色模式）
 */

/* global ConfigPage, ChatPage, MemoryPage */

(function () {
  'use strict';

  // ---- 状态 ----
  var currentPage = null;
  /**
   * 页面 keep-alive：每个页面独立的子容器 + mount 标志位。
   * 切页只是 display 切换，不销毁聊天 DOM 与其 WS / sessionPet / 流式状态。
   * 见 docs/requirement 关于「切页面状态丢失」的根因分析。
   */
  var pages = {
    chat: { root: null, mounted: false },
    config: { root: null, mounted: false },
    memory: { root: null, mounted: false },
  };

  // ---- DOM 引用 ----
  var pageContainer = document.getElementById('page-container');

  /** 侧栏与主内容区并列，切页时仅切换 page-container 内子页，不隐藏会话栏 */
  function ensureAppShell() {
    var app = document.getElementById('app');
    if (!app || !pageContainer) return null;
    var existing = app.querySelector('.app-shell');
    if (existing) return existing;
    var shell = document.createElement('div');
    shell.className = 'app-shell';
    var main = document.createElement('div');
    main.className = 'app-main';
    app.appendChild(shell);
    shell.appendChild(main);
    main.appendChild(pageContainer);
    return shell;
  }

  function ensureSessionSidebar() {
    var shell = ensureAppShell();
    if (!shell || !window.ChatSessionSidebar) return;
    window.ChatSessionSidebar.create(shell);
  }
  // 顶栏元素已移入侧边栏（IceCoder logo / 监管模式 / 主题 / 连接状态），此处不再持有引用。

  var SUPERVISOR_MODES = ['off', 'adaptive', 'strict'];
  var SUPERVISOR_LABELS = { off: '自由', adaptive: '自适应', strict: '严格' };
  var currentSupervisorMode = 'adaptive';
  var setupRequired = false;

  function applySetupMode(required) {
    setupRequired = !!required;
    document.body.classList.toggle('setup-required', setupRequired);
    if (setupRequired && getRouteFromHash() !== 'config') {
      window.location.replace('#/config');
    }
  }

  function exitSetupMode() {
    applySetupMode(false);
    navigate('chat');
  }

  // ---- 监管模式 ----

  function syncSupervisorModeToPet(showBubble) {
    var label = SUPERVISOR_LABELS[currentSupervisorMode] || currentSupervisorMode;
    if (window.ChatPetBridge) {
      if (showBubble && typeof window.ChatPetBridge.notifySupervisorMode === 'function') {
        window.ChatPetBridge.notifySupervisorMode(currentSupervisorMode, label);
      } else if (typeof window.ChatPetBridge.syncSupervisorModeEye === 'function') {
        window.ChatPetBridge.syncSupervisorModeEye(currentSupervisorMode);
      }
    }
  }

  function applySupervisorModeFromConfig(data) {
    if (data && (data.supervisorMode === 'off' || data.supervisorMode === 'adaptive' || data.supervisorMode === 'strict')) {
      currentSupervisorMode = data.supervisorMode;
    }
    syncSupervisorModeToPet(false);
    if (window.AppShell && typeof window.AppShell.notifySupervisorModeChange === 'function') {
      window.AppShell.notifySupervisorModeChange(currentSupervisorMode);
    }
  }

  function cycleSupervisorMode() {
    var idx = SUPERVISOR_MODES.indexOf(currentSupervisorMode);
    var next = SUPERVISOR_MODES[(idx + 1) % SUPERVISOR_MODES.length];
    fetch('/api/config/supervisor-mode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supervisorMode: next }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok && result.body.success) {
          currentSupervisorMode = result.body.supervisorMode;
          syncSupervisorModeToPet(true);
          if (window.AppShell && typeof window.AppShell.notifySupervisorModeChange === 'function') {
            window.AppShell.notifySupervisorModeChange(currentSupervisorMode);
          }
        }
      })
      .catch(function () { /* ignore */ });
  }

  // ---- 主题管理 ----

  function getStoredTheme() {
    return localStorage.getItem('ice-theme') || 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ice-theme', theme);
    if (window.AppShell && typeof window.AppShell.notifyThemeChange === 'function') {
      window.AppShell.notifyThemeChange(theme);
    }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(current === 'dark' ? 'light' : 'dark');
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function getSupervisorMode() { return currentSupervisorMode; }
  function getSupervisorLabel(mode) {
    return SUPERVISOR_LABELS[mode || currentSupervisorMode] || (mode || currentSupervisorMode);
  }

  var currentConnectionState = 'disconnected';
  function getConnectionState() { return currentConnectionState; }
  function setConnectionState(state) {
    currentConnectionState = state || 'disconnected';
    if (window.AppShell && typeof window.AppShell.notifyConnectionChange === 'function') {
      window.AppShell.notifyConnectionChange(currentConnectionState);
    }
  }

  window.AppShell = {
    getTheme: getTheme,
    toggleTheme: toggleTheme,
    getSupervisorMode: getSupervisorMode,
    getSupervisorLabel: getSupervisorLabel,
    cycleSupervisorMode: cycleSupervisorMode,
    setConnectionState: setConnectionState,
    getConnectionState: getConnectionState,
    onThemeChange: null,
    onConnectionChange: null,
    onSupervisorModeChange: null,
  };
  function notifySupervisorShell() {
    if (window.AppShell && typeof window.AppShell.notifySupervisorModeChange === 'function') {
      window.AppShell.notifySupervisorModeChange(currentSupervisorMode);
    }
  }
  window.AppShell.notifyThemeChange = function (t) { if (typeof window.AppShell.onThemeChange === 'function') window.AppShell.onThemeChange(t); };
  window.AppShell.notifyConnectionChange = function (s) { if (typeof window.AppShell.onConnectionChange === 'function') window.AppShell.onConnectionChange(s); };
  window.AppShell.notifySupervisorModeChange = function (m) { if (typeof window.AppShell.onSupervisorModeChange === 'function') window.AppShell.onSupervisorModeChange(m); };

  // ---- 路由 ----

  function getRouteFromHash() {
    var hash = window.location.hash || '';
    if (hash.startsWith('#/config')) return 'config';
    if (hash.startsWith('#/memory')) return 'memory';
    return 'chat';
  }

  function ensurePageRoot(page) {
    var entry = pages[page];
    if (!entry) return null;
    if (!entry.root) {
      entry.root = document.createElement('div');
      entry.root.className = 'page-root page-root-' + page;
      entry.root.dataset.pageRoot = page;
      entry.root.style.display = 'none';
      pageContainer.appendChild(entry.root);
    }
    return entry.root;
  }

  function navigate(page) {
    if (setupRequired && page !== 'config') {
      page = 'config';
    }
    if (page === currentPage) return;
    var prev = currentPage;
    currentPage = page;

    var newHash = '#/chat';
    if (page === 'config') newHash = '#/config';
    else if (page === 'memory') newHash = '#/memory';

    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }

    // 顶栏三个 tab 已移入侧边栏：路由 active 态由 ChatSessionSidebar 监听 hashchange 维护。

    // 离开 memory：必须停掉 fetch/AbortController/resize/popover；DOM 子树保留隐藏以备复用
    if (
      prev === 'memory' &&
      page !== 'memory' &&
      window.MemoryPage &&
      typeof window.MemoryPage.destroy === 'function'
    ) {
      window.MemoryPage.destroy();
      pages.memory.mounted = false;
    }

    // 聊天页/配置页保持 keep-alive：不调用 destroy，子树仅切 display
    renderPage(page);
  }

  function renderPage(page) {
    document.body.dataset.page = page;
    for (var k in pages) {
      var entry = pages[k];
      if (entry.root) entry.root.style.display = (k === page) ? '' : 'none';
    }
    var root = ensurePageRoot(page);
    if (!root) return;
    root.style.display = '';
    var entry = pages[page];
    if (!entry.mounted) {
      if (page === 'config') {
        window.ConfigPage.render(root);
      } else if (page === 'memory' && window.MemoryPage) {
        window.MemoryPage.render(root);
      } else {
        window.ChatPage.render(root);
      }
      entry.mounted = true;
    } else if (page === 'memory' && window.MemoryPage) {
      // memory 因 destroy 已重置内部状态，每次进入重新 render
      window.MemoryPage.render(root);
    } else if (page === 'chat' && window.ChatPage && typeof window.ChatPage.onActivate === 'function') {
      window.ChatPage.onActivate();
    }
  }

  // ---- 系统状态 ----

  function fetchSystemStatus() {
    return fetch('/api/config')
      .then(function (res) {
        if (!res.ok) throw new Error('获取配置失败');
        return res.json();
      })
      .then(function (data) {
        applySetupMode(!!data.setupRequired);
        setConnectionState('connected');
        applySupervisorModeFromConfig(data);

        var providers = data.providers || [];
        if (providers.length > 0) {
          var defaultProvider = providers.find(function (p) { return p.isDefault; }) || providers[0];
          // statusModel.textContent = defaultProvider.modelName || '—';
        } else {
          // statusModel.textContent = '—';
        }
        return data;
      })
      .catch(function () {
        setConnectionState('disconnected');
        // statusModel.textContent = '—';
        return null;
      });
  }

  // ---- 初始化 ----

  function init() {
    // 检测是否为远程控制模式（URL 含 ?token=xxx）
    var params = new URLSearchParams(window.location.search);
    if (params.get('token')) {
      // 远程控制模式：直接渲染聊天页面（ChatPage 内部处理远程逻辑）
      setTheme(getStoredTheme());
      fetchSystemStatus();
      document.body.dataset.page = 'chat';
      var chatRoot = ensurePageRoot('chat');
      window.ChatPage.render(chatRoot);
      pages.chat.mounted = true;
      currentPage = 'chat';
      return;
    }

    // 应用存储的主题（默认暗色）
    setTheme(getStoredTheme());
    ensureSessionSidebar();

    // 监听 hash 变化
    window.addEventListener('hashchange', function () {
      if (setupRequired && getRouteFromHash() !== 'config') {
        window.location.replace('#/config');
        return;
      }
      navigate(getRouteFromHash());
    });

    // 顶栏三个 tab 的 click 逻辑已移入 ChatSessionSidebar 内部。
    fetchSystemStatus().then(function () {
      navigate(setupRequired ? 'config' : getRouteFromHash());
    });
    window.addEventListener('visibilitychange', function onVis () {
      if (document.visibilityState === 'visible') {
        fetchSystemStatus();
      }
    });
  }

  window.AppRouter = {
    refreshStatus: fetchSystemStatus,
    exitSetupMode: exitSetupMode,
    isSetupRequired: function () {
      return setupRequired;
    },
    getSupervisorMode: function () {
      return currentSupervisorMode;
    },
  };

  // 检测 bfcache 恢复（移动端浏览器关闭后重新打开可能从缓存恢复页面）
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      window.location.reload();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
