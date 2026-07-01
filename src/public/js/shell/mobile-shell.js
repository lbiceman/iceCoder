/**
 * 移动端 H5 Shell：底栏导航、顶栏、会话抽屉挂载点。
 * 仅负责导航 chrome，不承载业务逻辑。
 */

/* exported MobileShell */

window.MobileShell = (function () {
  'use strict';

  var shellEl = null;
  var topBarEl = null;
  var bottomNavEl = null;
  var currentTopMode = 'work';

  var NAV_ICONS = {
    work:
      '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v7A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Zm2 .5h8M4 8h6M4 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    memory:
      '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h7A1.5 1.5 0 0 1 13 3.5v9A1.5 1.5 0 0 1 11.5 14h-7A1.5 1.5 0 0 1 3 12.5v-9Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    skills:
      '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.8 2.5 4.2v3.6c0 3.1 2.3 5.4 5.5 6.4 3.2-1 5.5-3.3 5.5-6.4V4.2L8 1.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.2 8.2 7.4 9.5 10 6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    config:
      '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  };

  var NAV_ITEMS = [
    { page: 'work', label: '工作', path: '/m/chat' },
    { page: 'mMemory', label: '记忆', path: '/m/memory' },
    { page: 'mSkills', label: '技能', path: '/m/skills' },
    { page: 'mConfig', label: '配置', path: '/m/config' },
  ];

  var THEME_BTN_HTML =
    '<button type="button" class="mobile-top-bar-theme-btn" data-current-theme="light" aria-label="切换主题">' +
      '<svg class="mobile-top-bar-theme-icon-dark" width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>' +
      '<svg class="mobile-top-bar-theme-icon-light" width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1M12.3 12.3l-1.1-1.1M4.8 4.8 3.7 3.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    '</button>';

  function create() {
    if (shellEl && shellEl.isConnected) return shellEl;

    var app = document.getElementById('app');
    var pageContainer = document.getElementById('page-container');
    if (!app || !pageContainer) return null;

    shellEl = document.createElement('div');
    shellEl.className = 'mobile-shell';
    shellEl.setAttribute('data-shell', 'mobile');
    shellEl.innerHTML =
      '<header class="mobile-top-bar">' +
        '<div class="mobile-top-bar-left"></div>' +
        '<div class="mobile-top-bar-center"></div>' +
        '<div class="mobile-top-bar-right"></div>' +
      '</header>' +
      '<aside class="mobile-session-drawer" aria-hidden="true">' +
        '<div class="mobile-session-drawer-backdrop"></div>' +
        '<div class="mobile-session-drawer-panel"></div>' +
      '</aside>' +
      '<main class="mobile-main"></main>' +
      '<nav class="mobile-bottom-nav" role="tablist" aria-label="主导航"></nav>';

    app.appendChild(shellEl);

    var mainEl = shellEl.querySelector('.mobile-main');
    mainEl.appendChild(pageContainer);

    topBarEl = shellEl.querySelector('.mobile-top-bar');
    bottomNavEl = shellEl.querySelector('.mobile-bottom-nav');

    buildBottomNav();
    bindBottomNav();
    bindDrawerBackdrop();

    if (window.MobileSessionDrawer) {
      window.MobileSessionDrawer.mount(shellEl.querySelector('.mobile-session-drawer-panel'));
    }

    syncBottomNavActive();
    bindAppShellListeners();
    setTopBarMode('work');

    return shellEl;
  }

  function buildBottomNav() {
    if (!bottomNavEl) return;
    bottomNavEl.innerHTML = NAV_ITEMS.map(function (item) {
      return (
        '<button type="button" class="mobile-bottom-nav-btn" data-page="' + item.page + '" data-path="' + item.path + '" role="tab" aria-selected="false">' +
          '<span class="mobile-bottom-nav-icon" aria-hidden="true">' + NAV_ICONS[item.page === 'work' ? 'work' : item.page === 'mMemory' ? 'memory' : item.page === 'mSkills' ? 'skills' : 'config'] + '</span>' +
          '<span class="mobile-bottom-nav-label">' + item.label + '</span>' +
        '</button>'
      );
    }).join('');
  }

  function bindBottomNav() {
    if (!bottomNavEl) return;
    bottomNavEl.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.mobile-bottom-nav-btn') : null;
      if (!btn) return;
      var page = btn.getAttribute('data-page');
      if (page && window.AppRouter && typeof window.AppRouter.navigate === 'function') {
        window.AppRouter.navigate(page);
      }
    });
    window.addEventListener('popstate', function () {
      syncBottomNavActive();
    });
    window.addEventListener('hashchange', function () {
      syncBottomNavActive();
    });
  }

  function bindDrawerBackdrop() {
    if (!shellEl) return;
    var backdrop = shellEl.querySelector('.mobile-session-drawer-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', closeDrawer);
    }
  }

  function normalizePathname(pathname) {
    var p = String(pathname || '/').replace(/\/+$/, '');
    return p || '/';
  }

  function pageFromLocation() {
    var path = normalizePathname(window.location.pathname);
    if (path === '/m/chat' || path === '/m/work') return 'work';
    if (path.indexOf('/m/work/') === 0) return 'workChat';
    if (path === '/m/memory') return 'mMemory';
    if (path === '/m/skills') return 'mSkills';
    if (path === '/m/config') return 'mConfig';

    var h = window.location.hash || '';
    if (h.startsWith('#/m/work/')) return 'workChat';
    if (h.startsWith('#/m/work')) return 'work';
    if (h.startsWith('#/m/memory')) return 'mMemory';
    if (h.startsWith('#/m/skills')) return 'mSkills';
    if (h.startsWith('#/m/config')) return 'mConfig';
    return 'work';
  }

  function syncBottomNavActive(activePage) {
    if (!bottomNavEl) return;
    var current = activePage || pageFromLocation();
    var hideNav = current === 'workChat';
    bottomNavEl.classList.toggle('is-hidden', hideNav);

    var btns = bottomNavEl.querySelectorAll('.mobile-bottom-nav-btn');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var page = btn.getAttribute('data-page');
      var on = page === current || (current === 'workChat' && page === 'work');
      if (current !== 'workChat') {
        on = page === current;
      }
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function getConnectionDot() {
    var state = 'disconnected';
    if (window.AppShell && typeof window.AppShell.getConnectionState === 'function') {
      state = window.AppShell.getConnectionState();
    }
    return '<span class="mobile-top-bar-status" data-state="' + state + '" aria-hidden="true"></span>';
  }

  function syncThemeButton() {
    if (!topBarEl) return;
    var btn = topBarEl.querySelector('.mobile-top-bar-theme-btn');
    if (!btn) return;
    var theme = 'light';
    if (window.AppShell && typeof window.AppShell.getTheme === 'function') {
      theme = window.AppShell.getTheme();
    }
    btn.setAttribute('data-current-theme', theme);
    btn.title = theme === 'dark' ? '当前：深色模式，点击切换为浅色' : '当前：浅色模式，点击切换为深色';
  }

  function bindThemeButton() {
    if (!topBarEl) return;
    var btn = topBarEl.querySelector('.mobile-top-bar-theme-btn');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      if (window.AppShell && typeof window.AppShell.toggleTheme === 'function') {
        window.AppShell.toggleTheme();
        syncThemeButton();
      }
    });
    syncThemeButton();
  }

  function finishTopBarRender() {
    bindThemeButton();
    syncThemeButton();
  }

  function setTopBarMode(mode, opts) {
    opts = opts || {};
    currentTopMode = mode;
    if (!topBarEl) return;

    var left = topBarEl.querySelector('.mobile-top-bar-left');
    var center = topBarEl.querySelector('.mobile-top-bar-center');
    var right = topBarEl.querySelector('.mobile-top-bar-right');
    if (!left || !center || !right) return;

    left.innerHTML = '';
    center.innerHTML = '';
    right.innerHTML = '';

    if (mode === 'work') {
      left.innerHTML =
        '<button type="button" class="mobile-top-bar-menu-btn" aria-label="打开会话列表" aria-expanded="false">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>' +
        '</button>';
      center.innerHTML = '<span class="mobile-top-bar-brand">IceCoder</span>' + getConnectionDot();
      right.innerHTML = THEME_BTN_HTML;
      var menuBtn = left.querySelector('.mobile-top-bar-menu-btn');
      if (menuBtn) {
        menuBtn.addEventListener('click', openDrawer);
      }
      bindWorkSwipe();
    } else if (mode === 'workChat') {
      left.innerHTML =
        '<button type="button" class="mobile-top-bar-back-btn" aria-label="返回">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
        '</button>';
      var title = opts.title || '会话';
      center.innerHTML = '<span class="mobile-top-bar-title">' + escapeHtml(title) + '</span>';
      right.innerHTML =
        '<button type="button" class="mobile-top-bar-more-btn" aria-label="更多">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>' +
        '</button>' +
        THEME_BTN_HTML;
      var backBtn = left.querySelector('.mobile-top-bar-back-btn');
      if (backBtn) {
        backBtn.addEventListener('click', function () {
          if (window.AppRouter && typeof window.AppRouter.back === 'function') {
            window.AppRouter.back();
          }
        });
      }
    } else if (mode === 'memory') {
      center.innerHTML = '<span class="mobile-top-bar-title">记忆</span>' + getConnectionDot();
      right.innerHTML = THEME_BTN_HTML;
    } else if (mode === 'skills') {
      center.innerHTML = '<span class="mobile-top-bar-title">技能</span>' + getConnectionDot();
      right.innerHTML = THEME_BTN_HTML;
    } else if (mode === 'config') {
      center.innerHTML = '<span class="mobile-top-bar-title">配置</span>' + getConnectionDot();
      right.innerHTML = THEME_BTN_HTML;
    }

    finishTopBarRender();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openDrawer() {
    if (!shellEl || currentTopMode !== 'work') return;
    var drawer = shellEl.querySelector('.mobile-session-drawer');
    if (!drawer) return;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    var menuBtn = shellEl.querySelector('.mobile-top-bar-menu-btn');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
    if (window.MobileSessionDrawer && typeof window.MobileSessionDrawer.onOpen === 'function') {
      window.MobileSessionDrawer.onOpen();
    }
  }

  function closeDrawer() {
    if (!shellEl) return;
    var drawer = shellEl.querySelector('.mobile-session-drawer');
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    var menuBtn = shellEl.querySelector('.mobile-top-bar-menu-btn');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
  }

  var swipeBound = false;
  function bindWorkSwipe() {
    if (swipeBound || !shellEl) return;
    swipeBound = true;
    var startX = 0;
    var startY = 0;
    var tracking = false;

    shellEl.addEventListener('touchstart', function (e) {
      if (currentTopMode !== 'work') return;
      var touch = e.touches[0];
      if (!touch || touch.clientX > 24) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    }, { passive: true });

    shellEl.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      var touch = e.touches[0];
      if (!touch) return;
      var dx = touch.clientX - startX;
      var dy = Math.abs(touch.clientY - startY);
      if (dx > 48 && dy < 40) {
        tracking = false;
        openDrawer();
      }
    }, { passive: true });

    shellEl.addEventListener('touchend', function () {
      tracking = false;
    }, { passive: true });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  function updateChatTitle(title) {
    if (currentTopMode !== 'workChat' || !topBarEl) return;
    var el = topBarEl.querySelector('.mobile-top-bar-title');
    if (el) el.textContent = title || '会话';
  }

  function syncConnectionState(state) {
    if (!topBarEl) return;
    var dot = topBarEl.querySelector('.mobile-top-bar-status');
    if (dot) {
      var resolved = state;
      if (!resolved && window.AppShell) {
        resolved = window.AppShell.getConnectionState();
      }
      dot.setAttribute('data-state', resolved || 'disconnected');
    }
  }

  function bindAppShellListeners() {
    var shell = window.AppShell;
    if (!shell || shell._mobileBound) return;
    shell._mobileBound = true;
    if (typeof shell.addConnectionChangeListener === 'function') {
      shell.addConnectionChangeListener(syncConnectionState);
    }
    if (typeof shell.addThemeChangeListener === 'function') {
      shell.addThemeChangeListener(syncThemeButton);
    }
  }

  return {
    create: create,
    setTopBarMode: setTopBarMode,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    updateChatTitle: updateChatTitle,
    syncBottomNavActive: syncBottomNavActive,
  };
})();
