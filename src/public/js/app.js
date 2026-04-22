/**
 * SPA 路由和主应用逻辑
 * 处理配置页面和聊天页面之间的 hash 路由
 * 包含主题切换（默认暗色模式）
 */

/* global ConfigPage, ChatPage */

(function () {
  'use strict';

  // ---- 状态 ----
  var currentPage = null;

  // ---- DOM 引用 ----
  var pageContainer = document.getElementById('page-container');
  var navChat = document.getElementById('nav-chat');
  var navConfig = document.getElementById('nav-config');
  var statusDot = document.getElementById('status-dot');
  // var statusModel = document.getElementById('status-model');
  var themeToggle = document.getElementById('theme-toggle');
  var themeIcon = document.getElementById('theme-icon');

  // ---- 主题管理 ----

  function getStoredTheme() {
    return localStorage.getItem('ice-theme') || 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ice-theme', theme);
    themeIcon.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(current === 'dark' ? 'light' : 'dark');
  }

  // ---- 路由 ----

  function getRouteFromHash() {
    var hash = window.location.hash || '';
    if (hash.startsWith('#/config')) return 'config';
    return 'chat';
  }

  function navigate(page) {
    if (page === currentPage) return;
    currentPage = page;

    var newHash = page === 'config' ? '#/config' : '#/chat';
    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }

    navChat.classList.toggle('active', page === 'chat');
    navConfig.classList.toggle('active', page === 'config');

    renderPage(page);
  }

  function renderPage(page) {
    pageContainer.innerHTML = '';
    if (page === 'config') {
      window.ConfigPage.render(pageContainer);
    } else {
      window.ChatPage.render(pageContainer);
    }
  }

  // ---- 系统状态 ----

  function fetchSystemStatus() {
    fetch('/api/config')
      .then(function (res) {
        if (!res.ok) throw new Error('获取配置失败');
        return res.json();
      })
      .then(function (data) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusDot.title = '已连接';

        var providers = data.providers || [];
        if (providers.length > 0) {
          var defaultProvider = providers.find(function (p) { return p.isDefault; }) || providers[0];
          // statusModel.textContent = defaultProvider.modelName || '—';
        } else {
          // statusModel.textContent = '—';
        }
      })
      .catch(function () {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusDot.title = '未连接';
        // statusModel.textContent = '—';
      });
  }

  // ---- 初始化 ----

  function init() {
    // 检测是否为远程控制模式（URL 含 ?token=xxx）
    var params = new URLSearchParams(window.location.search);
    if (params.get('token')) {
      // 远程控制模式：隐藏配置按钮，直接渲染聊天页面（ChatPage 内部处理远程逻辑）
      setTheme(getStoredTheme());
      navConfig.style.display = 'none';
      themeToggle.addEventListener('click', toggleTheme);
      fetchSystemStatus();
      window.ChatPage.render(pageContainer);
      return;
    }

    // 应用存储的主题（默认暗色）
    setTheme(getStoredTheme());

    // 主题切换按钮
    themeToggle.addEventListener('click', toggleTheme);

    // 监听 hash 变化
    window.addEventListener('hashchange', function () {
      navigate(getRouteFromHash());
    });

    navChat.addEventListener('click', function () {
      window.location.hash = '#/chat';
    });
    navConfig.addEventListener('click', function () {
      window.location.hash = '#/config';
    });

    fetchSystemStatus();
    setInterval(fetchSystemStatus, 30000);

    navigate(getRouteFromHash());
  }

  window.AppRouter = {
    refreshStatus: fetchSystemStatus
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
