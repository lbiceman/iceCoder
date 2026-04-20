/**
 * SPA Router and main application logic.
 * Handles hash-based routing between Config Page and Chat Page.
 * Fetches system status (current model) from /api/config.
 */

/* global ConfigPage, ChatPage */

(function () {
  'use strict';

  // ---- State ----
  let currentPage = null; // 'chat' | 'config'

  // ---- DOM refs ----
  const pageContainer = document.getElementById('page-container');
  const navChat = document.getElementById('nav-chat');
  const navConfig = document.getElementById('nav-config');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statusModel = document.getElementById('status-model');

  // ---- Routing ----

  function getRouteFromHash() {
    const hash = window.location.hash || '';
    if (hash.startsWith('#/config')) return 'config';
    return 'chat'; // default
  }

  function navigate(page) {
    if (page === currentPage) return;
    currentPage = page;

    // Update hash without triggering hashchange again
    const newHash = page === 'config' ? '#/config' : '#/chat';
    if (window.location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }

    // Update nav active state
    navChat.classList.toggle('active', page === 'chat');
    navConfig.classList.toggle('active', page === 'config');

    // Render page
    renderPage(page);
  }

  function renderPage(page) {
    // Clear container
    pageContainer.innerHTML = '';

    if (page === 'config') {
      ConfigPage.render(pageContainer);
    } else {
      ChatPage.render(pageContainer);
    }
  }

  // ---- System Status ----

  async function fetchSystemStatus() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('Failed to fetch config');
      const data = await res.json();

      statusDot.classList.remove('disconnected');
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';

      // Find default provider or first provider
      const providers = data.providers || [];
      if (providers.length > 0) {
        const defaultProvider = providers.find(function (p) { return p.isDefault; }) || providers[0];
        statusModel.textContent = defaultProvider.modelName || '—';
      } else {
        statusModel.textContent = '—';
      }
    } catch (_err) {
      statusDot.classList.remove('connected');
      statusDot.classList.add('disconnected');
      statusText.textContent = 'Disconnected';
      statusModel.textContent = '—';
    }
  }

  // ---- Init ----

  function init() {
    // Listen for hash changes
    window.addEventListener('hashchange', function () {
      navigate(getRouteFromHash());
    });

    // Nav button clicks
    navChat.addEventListener('click', function () {
      window.location.hash = '#/chat';
    });
    navConfig.addEventListener('click', function () {
      window.location.hash = '#/config';
    });

    // Fetch system status
    fetchSystemStatus();
    // Refresh status every 30 seconds
    setInterval(fetchSystemStatus, 30000);

    // Initial route
    navigate(getRouteFromHash());
  }

  // Expose a way for pages to refresh status
  window.AppRouter = {
    refreshStatus: fetchSystemStatus
  };

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
