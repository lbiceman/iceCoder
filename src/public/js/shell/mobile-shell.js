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

  function ic(name, width, className) {
    if (!window.AppIcon) return '';
    return window.AppIcon.html(name, {
      width: width || 20,
      className: className || '',
    });
  }

  var NAV_ICON_NAMES = {
    work: 'work',
    memory: 'memory',
    skills: 'skills',
    config: 'settings',
  };

  var NAV_ITEMS = [
    { page: 'work', label: '工作', path: '/m/chat' },
    { page: 'mMemory', label: '记忆', path: '/m/memory' },
    { page: 'mSkills', label: '技能', path: '/m/skills' },
    { page: 'mConfig', label: '设置', path: '/m/config' },
  ];

  function themeBtnHtml() {
    return (
      '<button type="button" class="mobile-top-bar-theme-btn" data-current-theme="light" aria-label="切换主题">' +
        ic('moon', 20, 'mobile-top-bar-theme-icon-dark') +
        ic('sun', 20, 'mobile-top-bar-theme-icon-light') +
      '</button>'
    );
  }

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
      var iconKey = item.page === 'work' ? 'work' : item.page === 'mMemory' ? 'memory' : item.page === 'mSkills' ? 'skills' : 'config';
      return (
        '<button type="button" class="mobile-bottom-nav-btn" data-page="' + item.page + '" data-path="' + item.path + '" role="tab" aria-selected="false">' +
          '<span class="mobile-bottom-nav-icon" aria-hidden="true">' + ic(NAV_ICON_NAMES[iconKey]) + '</span>' +
          '<span class="mobile-bottom-nav-label">' + item.label + '</span>' +
        '</button>'
      );
    }).join('');
    if (window.AppIcon) window.AppIcon.hydrate(bottomNavEl);
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
          ic('menu', 22) +
        '</button>';
      center.innerHTML = '<span class="mobile-top-bar-brand">IceCoder</span>' + getConnectionDot();
      right.innerHTML = themeBtnHtml();
      var menuBtn = left.querySelector('.mobile-top-bar-menu-btn');
      if (menuBtn) {
        menuBtn.addEventListener('click', openDrawer);
      }
      bindWorkSwipe();
    } else if (mode === 'workChat') {
      left.innerHTML =
        '<button type="button" class="mobile-top-bar-back-btn" aria-label="返回">' +
          ic('back', 22) +
        '</button>';
      var title = opts.title || '会话';
      center.innerHTML = '<span class="mobile-top-bar-title">' + escapeHtml(title) + '</span>';
      right.innerHTML =
        '<button type="button" class="mobile-top-bar-more-btn" aria-label="更多">' +
          ic('more-dots', 20) +
        '</button>' +
        themeBtnHtml();
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
      right.innerHTML = themeBtnHtml();
    } else if (mode === 'skills') {
      center.innerHTML = '<span class="mobile-top-bar-title">技能</span>' + getConnectionDot();
      right.innerHTML = themeBtnHtml();
    } else if (mode === 'config') {
      center.innerHTML = '<span class="mobile-top-bar-title">设置</span>' + getConnectionDot();
      right.innerHTML = themeBtnHtml();
    }

    if (window.AppIcon) window.AppIcon.hydrate(topBarEl);
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
