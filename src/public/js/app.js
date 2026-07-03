/**
 * SPA 路由和主应用逻辑
 * 处理配置页面和聊天页面之间的 hash 路由
 * 包含主题切换（桌面默认暗色，移动端默认浅色）
 */

/* global ConfigPage, ChatPage, MemoryPage, SkillsPage */

(function () {
  'use strict';

  // ---- 状态 ----
  var currentPage = null;
  var currentShell = 'desktop';
  /**
   * 页面 keep-alive：每个页面独立的子容器 + mount 标志位。
   * 切页只是 display 切换，不销毁聊天 DOM 与其 WS / sessionPet / 流式状态。
   * 见 docs/requirement 关于「切页面状态丢失」的根因分析。
   */
  var pages = {
    chat: { shell: 'desktop', root: null, mounted: false },
    config: { shell: 'desktop', root: null, mounted: false },
    memory: { shell: 'desktop', root: null, mounted: false },
    skills: { shell: 'desktop', root: null, mounted: false },
    work: { shell: 'mobile', root: null, mounted: false },
    workChat: { shell: 'mobile', root: null, mounted: false },
    mMemory: { shell: 'mobile', root: null, mounted: false },
    mSkills: { shell: 'mobile', root: null, mounted: false },
    mConfig: { shell: 'mobile', root: null, mounted: false },
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
    if (!setupRequired) return;
    if (isRemoteTokenUrl()) return;
    var route = resolveEntryRoute();
    if (route.shell === 'mobile' && route.page !== 'mConfig') {
      if (usesMobilePathRouting()) {
        window.location.replace(mobileUrl('/m/config'));
      } else {
        window.location.replace('#/m/config');
      }
    } else if (route.shell === 'desktop' && route.page !== 'config') {
      window.location.replace('#/config');
    }
  }

  function clearSetupMode() {
    applySetupMode(false);
  }

  function exitSetupMode() {
    clearSetupMode();
    if (currentShell === 'mobile') {
      navigateMobile({ shell: 'mobile', page: 'work' });
    } else {
      navigateDesktop('chat');
    }
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

  var THEME_KEY_DESKTOP = 'ice-theme';
  var THEME_KEY_MOBILE = 'ice-theme-mobile';

  function getThemeStorageKey(shell) {
    return shell === 'mobile' ? THEME_KEY_MOBILE : THEME_KEY_DESKTOP;
  }

  function detectShellForTheme() {
    var path = normalizePathname(window.location.pathname);
    if (parseMobilePathRoute(path)) return 'mobile';
    if (path === '/m/chat') return 'mobile';
    if (path === '/' && isRemoteTokenUrl()) return 'mobile';
    var hash = window.location.hash || '';
    if (hash.indexOf('#/m/') === 0) return 'mobile';
    if (path === '/' && !hash && !isRemoteTokenUrl() && window.matchMedia('(max-width: 768px)').matches) {
      return 'mobile';
    }
    return 'desktop';
  }

  function getStoredTheme(shell) {
    if (!shell) shell = currentShell || detectShellForTheme();
    var stored = localStorage.getItem(getThemeStorageKey(shell));
    if (stored === 'light' || stored === 'dark') return stored;
    return shell === 'mobile' ? 'light' : 'dark';
  }

  function setTheme(theme, shell) {
    if (!shell) shell = currentShell || detectShellForTheme();
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(getThemeStorageKey(shell), theme);
    if (window.AppShell && typeof window.AppShell.notifyThemeChange === 'function') {
      window.AppShell.notifyThemeChange(theme);
    }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || getStoredTheme();
    setTheme(current === 'dark' ? 'light' : 'dark');
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') || getStoredTheme();
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

  function createListenerHub() {
    var listeners = [];
    return {
      add: function (fn) {
        if (typeof fn !== 'function') return;
        if (listeners.indexOf(fn) === -1) listeners.push(fn);
      },
      notify: function (arg) {
        for (var i = 0; i < listeners.length; i++) listeners[i](arg);
      },
    };
  }

  var supervisorModeHub = createListenerHub();
  var themeChangeHub = createListenerHub();
  var connectionChangeHub = createListenerHub();

  window.AppShell = {
    getTheme: getTheme,
    toggleTheme: toggleTheme,
    getSupervisorMode: getSupervisorMode,
    getSupervisorLabel: getSupervisorLabel,
    cycleSupervisorMode: cycleSupervisorMode,
    setConnectionState: setConnectionState,
    getConnectionState: getConnectionState,
    addSupervisorModeListener: supervisorModeHub.add,
    addThemeChangeListener: themeChangeHub.add,
    addConnectionChangeListener: connectionChangeHub.add,
    notifySupervisorModeChange: supervisorModeHub.notify,
    notifyThemeChange: themeChangeHub.notify,
    notifyConnectionChange: connectionChangeHub.notify,
  };

  // ---- 路由 ----

  function normalizePathname(pathname) {
    var p = String(pathname || '/').replace(/\/+$/, '');
    return p || '/';
  }

  function isRemoteTokenUrl() {
    return !!new URLSearchParams(window.location.search).get('token');
  }

  /** 远程扫码 /m/* 入口：Tab 切换 pathname（/m/memory?token=），不用 hash */
  function usesMobilePathRouting() {
    return isRemoteTokenUrl() || parseMobilePathRoute(window.location.pathname) !== null;
  }

  function mobileUrl(pathname, search) {
    if (search === undefined) search = window.location.search || '';
    return pathname + search;
  }

  /**
   * @returns {{ shell: 'mobile', page: string, sessionId?: string } | null}
   */
  function parseMobilePathRoute(pathname) {
    var path = normalizePathname(pathname);
    if (path === '/m/chat' || path === '/m/work') {
      return { shell: 'mobile', page: 'work' };
    }
    if (path.indexOf('/m/work/') === 0) {
      var id = path.slice('/m/work/'.length).split('/')[0];
      if (id) return { shell: 'mobile', page: 'workChat', sessionId: decodeURIComponent(id) };
    }
    if (path === '/m/memory') return { shell: 'mobile', page: 'mMemory' };
    if (path === '/m/skills') return { shell: 'mobile', page: 'mSkills' };
    if (path === '/m/config') return { shell: 'mobile', page: 'mConfig' };
    return null;
  }

  function mobilePageToPath(page, opts) {
    opts = opts || {};
    if (page === 'workChat' && opts.sessionId) {
      return '/m/work/' + encodeURIComponent(opts.sessionId);
    }
    if (page === 'work') return '/m/chat';
    if (page === 'mMemory') return '/m/memory';
    if (page === 'mSkills') return '/m/skills';
    if (page === 'mConfig') return '/m/config';
    return '/m/chat';
  }

  function pushMobilePath(pathname) {
    var url = mobileUrl(pathname);
    if (window.location.pathname + window.location.search === url) return;
    history.pushState(null, '', url);
  }

  function setMobilePath(pathname) {
    var url = mobileUrl(pathname);
    if (window.location.pathname + window.location.search === url) return;
    history.replaceState(null, '', url);
  }

  /** 解析入口：/m/*?token= 用 pathname；窄屏 / 桌面仍用 hash */
  function resolveEntryRoute() {
    var pathRoute = parseMobilePathRoute(window.location.pathname);
    if (pathRoute) return pathRoute;
    var path = normalizePathname(window.location.pathname);
    if (path === '/m/chat') {
      return { shell: 'mobile', page: 'work' };
    }
    return parseRoute(window.location.hash || '#/chat');
  }

  function syncMobileNavActive(route) {
    if (!window.MobileShell || typeof window.MobileShell.syncBottomNavActive !== 'function') return;
    var page = route && route.page;
    if (page === 'workChat') page = 'work';
    window.MobileShell.syncBottomNavActive(page);
  }

  function setMobileHash(newHash) {
    if (window.location.hash === newHash) return;
    history.replaceState(null, '', newHash);
  }

  function pushMobileHash(newHash) {
    if (window.location.hash === newHash) return;
    history.pushState(null, '', newHash);
  }

  /**
   * @returns {{ shell: 'desktop'|'mobile', page: string, sessionId?: string }}
   */
  function parseRoute(hash) {
    var h = hash || window.location.hash || '';
    if (h.startsWith('#/m/')) {
      // "#/m/config".slice(3) => "/config"（slice(4) 会丢掉前导 /，导致全部误判为 work）
      var rest = h.slice(3);
      if (rest.startsWith('/work/')) {
        var id = rest.slice('/work/'.length).split('/')[0];
        if (id) return { shell: 'mobile', page: 'workChat', sessionId: decodeURIComponent(id) };
      }
      if (rest.startsWith('/work')) return { shell: 'mobile', page: 'work' };
      if (rest.startsWith('/memory')) return { shell: 'mobile', page: 'mMemory' };
      if (rest.startsWith('/skills')) return { shell: 'mobile', page: 'mSkills' };
      if (rest.startsWith('/config')) return { shell: 'mobile', page: 'mConfig' };
      return { shell: 'mobile', page: 'work' };
    }
    if (h.startsWith('#/config')) return { shell: 'desktop', page: 'config' };
    if (h.startsWith('#/memory')) return { shell: 'desktop', page: 'memory' };
    if (h.startsWith('#/skills')) return { shell: 'desktop', page: 'skills' };
    return { shell: 'desktop', page: 'chat' };
  }

  function getRouteFromHash() {
    return parseRoute(window.location.hash).page;
  }

  function mobilePageToHash(page, opts) {
    opts = opts || {};
    if (page === 'workChat' && opts.sessionId) {
      return '#/m/work/' + encodeURIComponent(opts.sessionId);
    }
    if (page === 'work') return '#/m/work';
    if (page === 'mMemory') return '#/m/memory';
    if (page === 'mSkills') return '#/m/skills';
    if (page === 'mConfig') return '#/m/config';
    return '#/m/work';
  }

  function ensureShell(route) {
    if (route.shell === currentShell) return;
    currentShell = route.shell;
    document.documentElement.setAttribute('data-shell', currentShell);
    window.location.reload();
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
    if (currentShell === 'mobile') {
      navigateMobile({ shell: 'mobile', page: page });
      return;
    }
    navigateDesktop(page);
  }

  function navigateDesktop(page) {
    if (setupRequired && page !== 'config') {
      page = 'config';
    }
    if (page === currentPage) return;
    var prev = currentPage;
    currentPage = page;

    var newHash = '#/chat';
    if (page === 'config') newHash = '#/config';
    else if (page === 'memory') newHash = '#/memory';
    else if (page === 'skills') newHash = '#/skills';

    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }

    // 顶栏三个 tab 已移入侧边栏：路由 active 态由 ChatSessionSidebar 监听 hashchange 维护。

    // 离开 memory/skills：停掉 fetch/AbortController；DOM 子树保留隐藏以备复用
    if (
      prev === 'memory' &&
      page !== 'memory' &&
      window.MemoryPage &&
      typeof window.MemoryPage.destroy === 'function'
    ) {
      window.MemoryPage.destroy();
      pages.memory.mounted = false;
    }
    if (
      prev === 'skills' &&
      page !== 'skills' &&
      window.SkillsPage &&
      typeof window.SkillsPage.destroy === 'function'
    ) {
      window.SkillsPage.destroy();
      pages.skills.mounted = false;
    }

    // 聊天页/配置页保持 keep-alive：不调用 destroy，子树仅切 display
    renderPage(page);
  }

  function navigateMobile(route) {
    var page = route.page;
    if (setupRequired && page !== 'mConfig') {
      page = 'mConfig';
      route = { shell: 'mobile', page: page };
    }
    if (page === currentPage && page !== 'workChat') {
      renderPage(page, route.sessionId);
      syncMobileNavActive(route);
      return;
    }
    if (page === 'workChat' && page === currentPage && route.sessionId) {
      renderPage('workChat', route.sessionId);
      syncMobileNavActive(route);
      return;
    }

    var prev = currentPage;
    currentPage = page;

    if (usesMobilePathRouting()) {
      setMobilePath(mobilePageToPath(page, { sessionId: route.sessionId }));
    } else {
      setMobileHash(mobilePageToHash(page, { sessionId: route.sessionId }));
    }

    if (
      prev === 'mMemory' &&
      page !== 'mMemory' &&
      window.MobileMemoryPage &&
      typeof window.MobileMemoryPage.destroy === 'function'
    ) {
      window.MobileMemoryPage.destroy();
      pages.mMemory.mounted = false;
    }
    if (
      prev === 'mSkills' &&
      page !== 'mSkills' &&
      window.MobileSkillsPage &&
      typeof window.MobileSkillsPage.destroy === 'function'
    ) {
      window.MobileSkillsPage.destroy();
      pages.mSkills.mounted = false;
    }

    if (page === 'workChat') {
      renderPage('workChat', route.sessionId);
    } else {
      renderPage(page);
    }

    syncMobileNavActive(route);
  }

  function handleRouteChange(route) {
    if (!route) route = resolveEntryRoute();
    ensureShell(route);
    if (route.shell === 'mobile') {
      navigateMobile(route);
    } else {
      navigateDesktop(route.page);
    }
  }

  function onRouteLocationChange() {
    var route = resolveEntryRoute();
    if (setupRequired && !isRemoteTokenUrl()) {
      if (route.shell === 'mobile' && route.page !== 'mConfig') {
        if (usesMobilePathRouting()) {
          window.location.replace(mobileUrl('/m/config'));
        } else {
          window.location.replace('#/m/config');
        }
        return;
      }
      if (route.shell === 'desktop' && route.page !== 'config') {
        window.location.replace('#/config');
        return;
      }
    }
    handleRouteChange(route);
    syncMobileNavActive(route);
  }

  function renderPage(page, sessionId) {
    var prevPage = document.body.dataset.page;
    if (prevPage === 'config' && page !== 'config' && window.ConfigPage && typeof window.ConfigPage.onDeactivate === 'function') {
      window.ConfigPage.onDeactivate();
    }
    if (prevPage === 'mConfig' && page !== 'mConfig' && window.ConfigPage && typeof window.ConfigPage.onDeactivate === 'function') {
      window.ConfigPage.onDeactivate();
    }

    document.body.dataset.page = page;
    document.body.dataset.shell = currentShell;
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
      } else if (page === 'skills' && window.SkillsPage) {
        window.SkillsPage.render(root);
      } else if (page === 'work' && window.MobileWorkPage) {
        window.MobileWorkPage.render(root);
      } else if (page === 'workChat' && window.MobileChatPage) {
        window.MobileChatPage.render(root, sessionId);
      } else if (page === 'mMemory' && window.MobileMemoryPage) {
        window.MobileMemoryPage.render(root);
      } else if (page === 'mSkills' && window.MobileSkillsPage) {
        window.MobileSkillsPage.render(root);
      } else if (page === 'mConfig' && window.MobileConfigPage) {
        window.MobileConfigPage.render(root);
      } else {
        window.ChatPage.render(root);
      }
      entry.mounted = true;
    } else if (page === 'memory' && window.MemoryPage) {
      // memory 因 destroy 已重置内部状态，每次进入重新 render
      window.MemoryPage.render(root);
    } else if (page === 'skills' && window.SkillsPage) {
      window.SkillsPage.render(root);
    } else if (page === 'chat' && window.ChatPage && typeof window.ChatPage.onActivate === 'function') {
      window.ChatPage.onActivate();
    } else if (page === 'work' && window.MobileWorkPage && typeof window.MobileWorkPage.onActivate === 'function') {
      window.MobileWorkPage.onActivate();
    } else if (page === 'workChat' && window.MobileChatPage) {
      if (sessionId) {
        window.MobileChatPage.render(root, sessionId);
      } else if (typeof window.MobileChatPage.onActivate === 'function') {
        window.MobileChatPage.onActivate();
      }
    } else if (page === 'mMemory' && window.MobileMemoryPage) {
      window.MobileMemoryPage.render(root);
    } else if (page === 'mSkills' && window.MobileSkillsPage) {
      window.MobileSkillsPage.render(root);
    } else if (page === 'mConfig' && window.MobileConfigPage) {
      window.MobileConfigPage.render(root);
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
    var path = normalizePathname(window.location.pathname);
    var search = window.location.search || '';

    // 旧链接 /?token=xxx → /m/chat?token=xxx
    if (path === '/' && isRemoteTokenUrl()) {
      window.location.replace('/m/chat' + search);
      return;
    }

    // 旧链接 /m/chat?token=xxx#/m/memory → /m/memory?token=xxx
    if (path === '/m/chat' && window.location.hash && window.location.hash.indexOf('#/m/') === 0) {
      var legacyRoute = parseRoute(window.location.hash);
      window.location.replace(mobileUrl(mobilePageToPath(legacyRoute.page, { sessionId: legacyRoute.sessionId }), search));
      return;
    }

    // 无 hash 时，窄屏自动跳转 H5 工作页（非远程、非 /m/chat）
    if (path === '/' && !window.location.hash && !isRemoteTokenUrl()) {
      if (window.matchMedia('(max-width: 768px)').matches) {
        window.location.replace('#/m/work');
        return;
      }
    }

    var initialRoute = resolveEntryRoute();
    currentShell = initialRoute.shell;
    document.documentElement.setAttribute('data-shell', currentShell);
    setTheme(getStoredTheme(currentShell));

    if (currentShell === 'mobile') {
      if (window.MobileShell) window.MobileShell.create();
    } else {
      ensureSessionSidebar();
    }

    // hash 路由 + /m/* pathname 路由均监听 popstate；hash 另监听 hashchange
    window.addEventListener('hashchange', onRouteLocationChange);
    window.addEventListener('popstate', onRouteLocationChange);

    // 顶栏三个 tab 的 click 逻辑已移入 ChatSessionSidebar 内部。
    fetchSystemStatus().then(function () {
      if (setupRequired) {
        if (currentShell === 'mobile') {
          handleRouteChange(
            usesMobilePathRouting()
              ? parseMobilePathRoute('/m/config')
              : parseRoute('#/m/config')
          );
        } else {
          handleRouteChange(parseRoute('#/config'));
        }
      } else {
        handleRouteChange(resolveEntryRoute());
      }
    });
    window.addEventListener('visibilitychange', function onVis () {
      if (document.visibilityState === 'visible') {
        fetchSystemStatus();
      }
    });
  }

  window.AppRouter = {
    refreshStatus: fetchSystemStatus,
    clearSetupMode: clearSetupMode,
    exitSetupMode: exitSetupMode,
    isSetupRequired: function () {
      return setupRequired;
    },
    getSupervisorMode: function () {
      return currentSupervisorMode;
    },
    getShell: function () {
      return currentShell;
    },
    navigate: function (page, opts) {
      opts = opts || {};
      if (currentShell === 'mobile') {
        if (usesMobilePathRouting()) {
          var newPath = mobilePageToPath(page, opts);
          pushMobilePath(newPath);
          handleRouteChange(parseMobilePathRoute(newPath) || { shell: 'mobile', page: page });
        } else {
          var hash = mobilePageToHash(page, opts);
          pushMobileHash(hash);
          handleRouteChange(parseRoute(hash));
        }
      } else {
        navigateDesktop(page);
      }
    },
    resolveRoute: resolveEntryRoute,
    usesPathRouting: usesMobilePathRouting,
    navigateWorkChat: function (sessionId) {
      if (!sessionId) return;
      if (currentShell === 'mobile') {
        if (usesMobilePathRouting()) {
          var chatPath = '/m/work/' + encodeURIComponent(sessionId);
          pushMobilePath(chatPath);
          handleRouteChange(parseMobilePathRoute(chatPath));
        } else {
          var hash = '#/m/work/' + encodeURIComponent(sessionId);
          if (window.location.hash === hash) {
            handleRouteChange(parseRoute(hash));
          } else {
            window.location.hash = hash;
          }
        }
        return;
      }
      var Store = window.ChatSessionStore;
      var wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;
      if (Store && typeof Store.switchSession === 'function') {
        Store.switchSession(sessionId, wsSend, function (ok, runningTurn) {
          if (!ok) return;
          if (window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
            window.ChatPage.onSessionSwitched(sessionId, runningTurn);
          }
        });
      }
      if (currentPage !== 'chat') {
        navigateDesktop('chat');
      } else if (window.ChatPage && typeof window.ChatPage.onActivate === 'function') {
        window.ChatPage.onActivate();
      }
    },
    back: function () {
      if (currentShell === 'mobile' && currentPage === 'workChat') {
        if (usesMobilePathRouting()) {
          setMobilePath('/m/chat');
          handleRouteChange(parseMobilePathRoute('/m/chat'));
        } else {
          history.replaceState(null, '', '#/m/work');
          handleRouteChange(parseRoute('#/m/work'));
        }
      } else {
        history.back();
      }
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
