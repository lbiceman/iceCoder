/**
 * 聊天空状态欢迎页：状态卡片、快速上手与当前上下文。
 */

/* exported ChatWelcome */

window.ChatWelcome = (function () {
  'use strict';

  var elRoot = null;
  var elMessages = null;
  var memoryCount = null;
  var memoryFetchPending = false;
  var contextMaxTokens = null;
  var contextUsedTokens = 0;
  var contextFetchPending = false;
  var toolsCount = null;
  var toolsFetchPending = false;
  var storeListenerBound = false;

  var TIPS = [
    {
      key: 'cmd',
      title: '命令面板',
      desc: '点击输入框右侧命令按钮，执行 open、scan等操作',
      descRemote: '点击输入框右侧命令按钮，执行 open等操作',
      icon: 'command-list',
    },
    {
      key: 'at',
      title: '@ 引用文件',
      desc: '输入 @ 从工作区选择文件，引用绝对路径供Agent读取',
      icon: 'at',
    },
    {
      key: 'hash',
      title: '# 技能',
      desc: '输入 # 选用技能，或在侧栏「技能」页浏览全部技能',
      icon: 'hash',
    },
    {
      key: 'slash',
      title: '/ 指令',
      desc: '在输入框输入 /，选用 /also、/next 等本地指令',
      icon: 'slash',
    },
  ];

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getSupervisorLabel(mode) {
    if (window.AppShell && typeof window.AppShell.getSupervisorLabel === 'function') {
      return window.AppShell.getSupervisorLabel(mode);
    }
    var labels = { off: '自由', adaptive: '自适应', strict: '严格' };
    return labels[mode] || mode || '自适应';
  }

  function getSubtitle(mode) {
    if (mode === 'off') return '自由模式下，Agent 可自主执行任务';
    if (mode === 'strict') return '严格监管下，重要操作需你确认';
    return '自适应监管，在关键节点向你确认';
  }

  function statIconSvg(name) {
    var map = { mode: 'eye', memory: 'database', harness: 'harness', l2: 'shield-badge' };
    return window.AppIcon ? window.AppIcon.html(map[name] || 'circle', { width: 18 }) : '';
  }

  function tipKbdHtml(tip) {
    if (!tip.icon || !window.AppIcon) {
      return '<span class="chat-welcome-tip-kbd" aria-hidden="true"></span>';
    }
    return (
      '<span class="chat-welcome-tip-kbd" aria-hidden="true">' +
        window.AppIcon.html(tip.icon, { width: 16, className: 'chat-welcome-tip-kbd-svg' }) +
      '</span>'
    );
  }

  function buildMarkup(remoteMode) {
    var tipsHtml = TIPS.map(function (tip) {
      var desc = (remoteMode && tip.descRemote) ? tip.descRemote : tip.desc;
      return (
        '<div class="chat-welcome-tip">' +
          tipKbdHtml(tip) +
          '<div class="chat-welcome-tip-body">' +
            '<div class="chat-welcome-tip-title">' + escapeHtml(tip.title) + '</div>' +
            '<div class="chat-welcome-tip-desc">' + escapeHtml(desc) + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="chat-welcome-inner">' +
        '<header class="chat-welcome-header">' +
          '<div class="chat-welcome-brand">' +
            '<span class="chat-welcome-logo" aria-hidden="true">' +
              (window.AppIcon ? window.AppIcon.html('logo', { width: 56 }) : '') +
            '</span>' +
            '<div class="chat-welcome-headings">' +
              '<h1 class="chat-welcome-title">IceCoder 已就绪</h1>' +
              '<p class="chat-welcome-subtitle" data-welcome-subtitle></p>' +
            '</div>' +
          '</div>' +
        '</header>' +
        '<div class="chat-welcome-stats">' +
          '<div class="chat-welcome-stat">' +
            '<span class="chat-welcome-stat-icon chat-welcome-stat-icon-mode">' + statIconSvg('mode') + '</span>' +
            '<div class="chat-welcome-stat-body">' +
              '<span class="chat-welcome-stat-label">模式</span>' +
              '<span class="chat-welcome-stat-value chat-welcome-stat-value-accent" data-welcome-mode>—</span>' +
            '</div>' +
          '</div>' +
          '<div class="chat-welcome-stat">' +
            '<span class="chat-welcome-stat-icon">' + statIconSvg('memory') + '</span>' +
            '<div class="chat-welcome-stat-body">' +
              '<span class="chat-welcome-stat-label">Memory</span>' +
              '<span class="chat-welcome-stat-value" data-welcome-memory>载入中…</span>' +
            '</div>' +
          '</div>' +
          '<div class="chat-welcome-stat">' +
            '<span class="chat-welcome-stat-icon chat-welcome-stat-icon-harness" data-welcome-harness-icon>' + statIconSvg('harness') + '</span>' +
            '<div class="chat-welcome-stat-body">' +
              '<span class="chat-welcome-stat-label">Harness</span>' +
              '<span class="chat-welcome-stat-value" data-welcome-harness title="L1 主循环：消息预处理 → LLM → 工具执行">—</span>' +
            '</div>' +
          '</div>' +
          '<div class="chat-welcome-stat">' +
            '<span class="chat-welcome-stat-icon chat-welcome-stat-icon-pipeline" data-welcome-pipeline-icon>' + statIconSvg('l2') + '</span>' +
            '<div class="chat-welcome-stat-body">' +
              '<span class="chat-welcome-stat-label">L2 · Gate</span>' +
              '<span class="chat-welcome-stat-value" data-welcome-pipeline title="L2 过程监管与 Gate 收尾验收">—</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<section class="chat-welcome-section">' +
          '<h2 class="chat-welcome-section-title">快速上手</h2>' +
          '<div class="chat-welcome-tips">' + tipsHtml + '</div>' +
        '</section>' +
        '<section class="chat-welcome-section chat-welcome-context">' +
          '<h2 class="chat-welcome-section-title">当前上下文</h2>' +
          '<div class="chat-welcome-context-rows">' +
            '<div class="chat-welcome-context-row">' +
              '<span class="chat-welcome-context-label">工作区</span>' +
              '<span class="chat-welcome-context-value" data-welcome-workspace title="">—</span>' +
            '</div>' +
            '<div class="chat-welcome-context-row">' +
              '<span class="chat-welcome-context-label">系统工具</span>' +
              '<span class="chat-welcome-context-value" data-welcome-tools title="">载入中…</span>' +
            '</div>' +
            '<div class="chat-welcome-context-row">' +
              '<span class="chat-welcome-context-label">上下文大小</span>' +
              '<span class="chat-welcome-context-value" data-welcome-context-size title="">载入中…</span>' +
            '</div>' +
          '</div>' +
        '</section>' +
      '</div>'
    );
  }

  function ensureRoot(remoteMode) {
    if (!elMessages) return;
    if (elRoot && !elMessages.contains(elRoot)) {
      elRoot = null;
    }
    if (elRoot) return;
    elRoot = document.createElement('div');
    elRoot.className = 'chat-welcome hidden';
    elRoot.id = 'chat-welcome';
    elRoot.setAttribute('role', 'region');
    elRoot.setAttribute('aria-label', '欢迎与快速上手');
    elRoot.innerHTML = buildMarkup(!!remoteMode);
    if (window.AppIcon) window.AppIcon.hydrate(elRoot);

    var historyOuter = elMessages.querySelector('.chat-history-outer');
    if (historyOuter) {
      elMessages.insertBefore(elRoot, historyOuter);
    } else {
      elMessages.insertBefore(elRoot, elMessages.firstChild);
    }
  }

  function compactPath(p) {
    var norm = String(p || '').replace(/\\/g, '/');
    var parts = norm.split('/').filter(function (x) { return x && x !== '.'; });
    if (parts.length <= 2) return p || '';
    return '\u2026/' + parts.slice(-2).join('/');
  }

  function formatWorkspaceLabel(sessionId) {
    var Store = window.ChatSessionStore;
    if (!Store) return { text: '—', title: '' };
    var root = typeof Store.getSessionWorkspace === 'function'
      ? Store.getSessionWorkspace(sessionId)
      : '';
    var def = typeof Store.getDefaultWorkDir === 'function' ? Store.getDefaultWorkDir() : '';
    var full = root || def || '';
    if (!full) return { text: '—', title: '' };
    var display = full.length > 52 ? (compactPath(full) || full) : full;
    return { text: display, title: full };
  }

  function formatToolsCountLabel(count) {
    if (count == null) return { text: '载入中…', title: '' };
    if (count <= 0) return { text: '—', title: '' };
    return { text: count + ' 个', title: 'IceCoder 内置工具' };
  }

  function formatContextWindow(n) {
    if (!isFinite(n) || n <= 0) return '';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  function formatContextSizeLabel(max, used) {
    if (max == null) return { text: '载入中…', title: '' };
    if (!max || max <= 0) return { text: '—', title: '' };
    var maxLabel = formatContextWindow(max);
    var title = Number(max).toLocaleString('en-US') + ' tokens';
    if (typeof used === 'number' && used > 0) {
      var usedLabel = Number(used).toLocaleString('en-US');
      var pct = ((used / max) * 100).toFixed(1);
      return { text: usedLabel + ' / ' + maxLabel, title: title + ' · 已用 ' + pct + '%' };
    }
    return { text: maxLabel, title: title };
  }

  function applyContextFromOpts(opts) {
    opts = opts || {};
    if (typeof opts.contextMaxTokens === 'number' && opts.contextMaxTokens > 0) {
      contextMaxTokens = opts.contextMaxTokens;
    }
    if (typeof opts.contextUsedTokens === 'number' && opts.contextUsedTokens >= 0) {
      contextUsedTokens = opts.contextUsedTokens;
    }
  }

  function countBuiltinTools(tools) {
    if (!Array.isArray(tools)) return 0;
    var n = 0;
    for (var i = 0; i < tools.length; i++) {
      var name = tools[i] && tools[i].name ? String(tools[i].name) : '';
      if (name && name.indexOf('mcp_') !== 0) n++;
    }
    return n;
  }

  function fetchToolsCount() {
    if (toolsFetchPending || toolsCount != null) return;
    toolsFetchPending = true;
    fetch('/api/tools')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.success && Array.isArray(data.tools)) {
          toolsCount = countBuiltinTools(data.tools);
        } else if (data && typeof data.count === 'number') {
          toolsCount = data.count;
        } else {
          toolsCount = 0;
        }
      })
      .catch(function () {
        toolsCount = 0;
      })
      .finally(function () {
        toolsFetchPending = false;
        refreshContextLabels();
      });
  }

  function fetchModelContext() {
    if (contextFetchPending || contextMaxTokens != null) return;
    contextFetchPending = true;
    fetch('/api/config')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var providers = data && data.providers ? data.providers : [];
        var def = providers.find(function (p) { return p.isDefault; }) || providers[0];
        if (def && typeof def.maxContextTokens === 'number' && def.maxContextTokens > 0) {
          contextMaxTokens = def.maxContextTokens;
        } else {
          contextMaxTokens = 0;
        }
      })
      .catch(function () {
        contextMaxTokens = 0;
      })
      .finally(function () {
        contextFetchPending = false;
        refreshContextLabels();
      });
  }

  function refreshContextLabels() {
    if (elRoot && !elRoot.classList.contains('hidden')) {
      updateContextLabels();
    }
    var mobileDash = document.getElementById('mobile-work-dashboard');
    if (mobileDash) updateContextLabels(mobileDash);
  }

  function updateContextLabels(root) {
    var r = resolveRoot(root);
    if (!r) return;

    var workspaceEl = r.querySelector('[data-welcome-workspace]');
    if (workspaceEl) {
      var Store = window.ChatSessionStore;
      var sessionId = Store && typeof Store.getActiveSessionId === 'function'
        ? Store.getActiveSessionId()
        : 'default';
      var workspace = formatWorkspaceLabel(sessionId);
      workspaceEl.textContent = workspace.text;
      if (workspace.title) workspaceEl.setAttribute('title', workspace.title);
      else workspaceEl.removeAttribute('title');
    }

    var toolsEl = r.querySelector('[data-welcome-tools]');
    if (toolsEl) {
      var tools = formatToolsCountLabel(toolsCount);
      toolsEl.textContent = tools.text;
      if (tools.title) toolsEl.setAttribute('title', tools.title);
      else toolsEl.removeAttribute('title');
    }

    var contextEl = r.querySelector('[data-welcome-context-size]');
    if (contextEl) {
      var size = formatContextSizeLabel(contextMaxTokens, contextUsedTokens);
      contextEl.textContent = size.text;
      if (size.title) contextEl.setAttribute('title', size.title);
      else contextEl.removeAttribute('title');
    }
  }

  function bindStoreListener() {
    if (storeListenerBound) return;
    var Store = window.ChatSessionStore;
    if (!Store || typeof Store.onChange !== 'function') return;
    Store.onChange(function () {
      refreshContextLabels();
    });
    storeListenerBound = true;
  }

  function fetchMemoryCount() {
    if (memoryFetchPending || memoryCount != null) return;
    memoryFetchPending = true;
    fetch('/api/memory/stats')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.success && typeof data.total === 'number') {
          memoryCount = data.total;
        } else {
          memoryCount = 0;
        }
      })
      .catch(function () {
        memoryCount = 0;
      })
      .finally(function () {
        memoryFetchPending = false;
        if (elRoot && !elRoot.classList.contains('hidden')) {
          updateMemoryLabel();
        }
        var mobileDash = document.getElementById('mobile-work-dashboard');
        if (mobileDash) updateMemoryLabel(mobileDash);
      });
  }

  function updateMemoryLabel(root) {
    var r = resolveRoot(root);
    if (!r) return;
    var el = r.querySelector('[data-welcome-memory]');
    if (!el) return;
    if (memoryCount == null) {
      el.textContent = '载入中…';
      return;
    }
    el.textContent = memoryCount > 0 ? ('已加载 ' + memoryCount + ' 条') : '暂无记忆';
  }

  function setStatValue(el, iconEl, text, tone) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove(
      'chat-welcome-stat-value-accent',
      'chat-welcome-stat-value-success',
      'chat-welcome-stat-value-muted'
    );
    if (tone === 'accent') el.classList.add('chat-welcome-stat-value-accent');
    else if (tone === 'success') el.classList.add('chat-welcome-stat-value-success');
    else if (tone === 'muted') el.classList.add('chat-welcome-stat-value-muted');
    if (!iconEl) return;
    iconEl.classList.remove(
      'chat-welcome-stat-icon-ready',
      'chat-welcome-stat-icon-warn',
      'chat-welcome-stat-icon-muted'
    );
    if (tone === 'success') iconEl.classList.add('chat-welcome-stat-icon-ready');
    else if (tone === 'muted') iconEl.classList.add('chat-welcome-stat-icon-muted');
    else if (tone === 'warn') iconEl.classList.add('chat-welcome-stat-icon-warn');
  }

  function updateHarnessLabel(opts, root) {
    var r = resolveRoot(root);
    if (!r) return;
    var el = r.querySelector('[data-welcome-harness]');
    var iconEl = r.querySelector('[data-welcome-harness-icon]');
    var connected = opts.connectionState === 'connected';
    var setupRequired = !!opts.setupRequired;
    if (!connected) {
      setStatValue(el, iconEl, '未连接', 'warn');
      return;
    }
    if (setupRequired) {
      setStatValue(el, iconEl, '待配置', 'warn');
      return;
    }
    setStatValue(el, iconEl, '就绪', 'success');
  }

  function updatePipelineLabel(opts, root) {
    var r = resolveRoot(root);
    if (!r) return;
    var el = r.querySelector('[data-welcome-pipeline]');
    var iconEl = r.querySelector('[data-welcome-pipeline-icon]');
    var mode = opts.supervisorMode || 'adaptive';
    var connected = opts.connectionState === 'connected';
    var setupRequired = !!opts.setupRequired;
    var l2Text = '待命';
    if (mode === 'off') l2Text = '已关闭';
    else if (mode === 'strict') l2Text = '严格';
    var gateText = (!connected || setupRequired) ? '未激活' : '待触发';
    var tone = 'accent';
    if (mode === 'off' || !connected || setupRequired) tone = 'muted';
    else if (gateText === '待触发') tone = 'success';
    setStatValue(el, iconEl, l2Text + ' · ' + gateText, tone);
  }

  function resolveRoot(root) {
    return root || elRoot;
  }

  function updateModeLabel(mode, root) {
    var r = resolveRoot(root);
    if (!r) return;
    var modeEl = r.querySelector('[data-welcome-mode]');
    var subEl = r.querySelector('[data-welcome-subtitle]');
    var label = getSupervisorLabel(mode);
    if (modeEl) modeEl.textContent = label;
    if (subEl) subEl.textContent = getSubtitle(mode);
  }

  function setVisible(show) {
    if (!elRoot || !elMessages) return;
    elRoot.classList.toggle('hidden', !show);
    elMessages.classList.toggle('has-welcome', !!show);
  }

  function init(opts) {
    opts = opts || {};
    elMessages = opts.elMessages || null;
    ensureRoot(!!opts.remoteMode);
    bindStoreListener();
    fetchMemoryCount();
    fetchModelContext();
    fetchToolsCount();
  }

  function sync(opts) {
    opts = opts || {};
    ensureRoot(!!opts.remoteMode);
    if (!elRoot) return;

    var messageCount = typeof opts.messageCount === 'number' ? opts.messageCount : 0;
    var hasTailContent = !!opts.hasTailContent;
    var isWorkloadActive = !!opts.isWorkloadActive;
    var show = messageCount <= 0 && !hasTailContent && !isWorkloadActive;
    setVisible(show);
    if (!show) return;

    applyContextFromOpts(opts);
    updateModeLabel(opts.supervisorMode || 'adaptive');
    updateHarnessLabel(opts);
    updatePipelineLabel(opts);
    updateMemoryLabel();
    updateContextLabels();
    bindStoreListener();
    if (memoryCount == null) fetchMemoryCount();
    if (contextMaxTokens == null) fetchModelContext();
    if (toolsCount == null) fetchToolsCount();
  }

  function syncDashboard(root, opts) {
    opts = opts || {};
    if (!root) return;
    applyContextFromOpts(opts);
    updateModeLabel(opts.supervisorMode || 'adaptive', root);
    updateHarnessLabel(opts, root);
    updatePipelineLabel(opts, root);
    updateMemoryLabel(root);
    updateContextLabels(root);
    bindStoreListener();
    if (memoryCount == null) fetchMemoryCount();
    if (contextMaxTokens == null) fetchModelContext();
    if (toolsCount == null) fetchToolsCount();
  }

  return {
    init: init,
    sync: sync,
    buildDashboardMarkup: buildMarkup,
    syncDashboard: syncDashboard,
    getTips: function () { return TIPS.slice(); },
  };
})();
