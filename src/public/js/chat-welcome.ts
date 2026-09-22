// @ts-nocheck
/**
 * 聊天空状态欢迎页：状态卡片、快速上手与当前上下文。
 */

/* exported ChatWelcome */

export const ChatWelcome = (() => {

  let elRoot = null;
  let elMessages = null;
  let memoryCount = null;
  let memoryFetchPending = false;
  let contextMaxTokens = null;
  let contextUsedTokens = 0;
  let contextFetchPending = false;
  let toolsCategories = null;
  let toolsFetchPending = false;
  let storeListenerBound = false;

  const TIPS = [
    {
      key: 'cmd',
      title: '命令面板',
      desc: '输入 /open 浏览磁盘目录；命令按钮用于扫码、遥测等',
      descRemote: '输入 /open 浏览磁盘目录；命令按钮用于遥测等',
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
      desc: '在输入框输入 /，选用 /plan、/shell、/next 等本地指令',
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
    const labels = { off: '自由', adaptive: '自适应', strict: '严格' };
    return labels[mode] || mode || '自适应';
  }

  function getSubtitle(mode) {
    if (mode === 'off') return '自由模式下，Agent 可自主执行任务';
    if (mode === 'strict') return '严格监管下，重要操作需你确认';
    return '自适应监管，在关键节点向你确认';
  }

  function statIconSvg(name) {
    const map = { mode: 'eye', memory: 'database', harness: 'harness', l2: 'shield-badge' };
    return window.AppIcon ? window.AppIcon.html(map[name] || 'circle', { width: 18 }) : '';
  }

  function tipKbdHtml(tip) {
    if (!tip.icon || !window.AppIcon) {
      return '<span class="chat-welcome-tip-kbd" aria-hidden="true"></span>';
    }
    return (
      `<span class="chat-welcome-tip-kbd" aria-hidden="true">${window.AppIcon.html(tip.icon, { width: 16, className: 'chat-welcome-tip-kbd-svg' })}</span>`
    );
  }

  function buildMarkup(remoteMode) {
    const tipsHtml = TIPS.map((tip) => {
      const desc = (remoteMode && tip.descRemote) ? tip.descRemote : tip.desc;
      return (
        `<div class="chat-welcome-tip">${tipKbdHtml(tip)}<div class="chat-welcome-tip-body"><div class="chat-welcome-tip-title">${escapeHtml(tip.title)}</div><div class="chat-welcome-tip-desc">${escapeHtml(desc)}</div></div></div>`
      );
    }).join('');

    return (
      `<div class="chat-welcome-inner"><header class="chat-welcome-header"><div class="chat-welcome-brand"><div class="chat-welcome-headings"><h1 class="chat-welcome-title">IceCoder 已就绪</h1><p class="chat-welcome-subtitle" data-welcome-subtitle></p></div></div></header><div class="chat-welcome-stats"><div class="chat-welcome-stat"><span class="chat-welcome-stat-icon chat-welcome-stat-icon-mode">${statIconSvg('mode')}</span><div class="chat-welcome-stat-body"><span class="chat-welcome-stat-label">模式</span><span class="chat-welcome-stat-value chat-welcome-stat-value-accent" data-welcome-mode>—</span></div></div><div class="chat-welcome-stat"><span class="chat-welcome-stat-icon">${statIconSvg('memory')}</span><div class="chat-welcome-stat-body"><span class="chat-welcome-stat-label">Memory</span><span class="chat-welcome-stat-value" data-welcome-memory>载入中…</span></div></div><div class="chat-welcome-stat"><span class="chat-welcome-stat-icon chat-welcome-stat-icon-harness" data-welcome-harness-icon>${statIconSvg('harness')}</span><div class="chat-welcome-stat-body"><span class="chat-welcome-stat-label">Harness</span><span class="chat-welcome-stat-value" data-welcome-harness title="L1 主循环：消息预处理 → LLM → 工具执行">—</span></div></div><div class="chat-welcome-stat"><span class="chat-welcome-stat-icon chat-welcome-stat-icon-pipeline" data-welcome-pipeline-icon>${statIconSvg('l2')}</span><div class="chat-welcome-stat-body"><span class="chat-welcome-stat-label">验收门控</span><span class="chat-welcome-stat-value" data-welcome-pipeline title="工具执行前的审批：allow / confirm / deny">—</span></div></div></div><section class="chat-welcome-section"><h2 class="chat-welcome-section-title">快速上手</h2><div class="chat-welcome-tips">${tipsHtml}</div></section><section class="chat-welcome-section chat-welcome-context"><h2 class="chat-welcome-section-title">当前上下文</h2><div class="chat-welcome-context-rows"><div class="chat-welcome-context-row"><span class="chat-welcome-context-label">工作区</span><span class="chat-welcome-context-value" data-welcome-workspace title="">—</span></div><div class="chat-welcome-context-row chat-welcome-context-row--tools"><span class="chat-welcome-context-label">系统工具</span><div class="chat-welcome-tools-inline" data-welcome-tools-inline title="">载入中…</div></div><div class="chat-welcome-context-row"><span class="chat-welcome-context-label">上下文大小</span><span class="chat-welcome-context-value" data-welcome-context-size title="">载入中…</span></div></div></section></div>`
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

    const historyOuter = elMessages.querySelector('.chat-history-outer');
    if (historyOuter) {
      elMessages.insertBefore(elRoot, historyOuter);
    } else {
      elMessages.insertBefore(elRoot, elMessages.firstChild);
    }
  }

  function compactPath(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const parts = norm.split('/').filter((x) =>  x && x !== '.');
    if (parts.length <= 2) return p || '';
    return `…/${parts.slice(-2).join('/')}`;
  }

  function formatWorkspaceLabel(sessionId) {
    const Store = window.ChatSessionStore;
    if (!Store) return { text: '—', title: '' };
    const root = typeof Store.getSessionWorkspace === 'function'
      ? Store.getSessionWorkspace(sessionId)
      : '';
    const def = typeof Store.getDefaultWorkDir === 'function' ? Store.getDefaultWorkDir() : '';
    const full = root || def || '';
    if (!full) return { text: '—', title: '' };
    const display = full.length > 52 ? (compactPath(full) || full) : full;
    return { text: display, title: full };
  }

  function formatToolCount(n) {
    if (n == null || n <= 0) return '—';
    return `${n} 个`;
  }

  function buildToolSegHtml(name, count, opts) {
    opts = opts || {};
    const countText = opts.countCompact
      ? (count == null || count <= 0 ? '—' : `${count}个`)
      : formatToolCount(count);
    return (
      '<span class="chat-welcome-tool-seg"' +
        (opts.title ? ` title="${escapeHtml(opts.title)}"` : '') +
      '>' +
        '<span class="chat-welcome-tool-seg-name">' + escapeHtml(name) + '</span>' +
        '<span class="chat-welcome-tool-seg-value">' + escapeHtml(countText) + '</span>' +
      '</span>'
    );
  }

  function buildToolsInlineHtml(categories) {
    if (!categories) return '';
    const chat = categories.chat && typeof categories.chat.count === 'number' ? categories.chat.count : 0;
    const doc = categories.doc && typeof categories.doc.count === 'number' ? categories.doc.count : 0;
    const shell = categories.shell && typeof categories.shell.count === 'number' ? categories.shell.count : 0;
    return (
      buildToolSegHtml('常用', chat, {
        title: '普通模式默认可用：文件读写、搜索、命令执行等',
      }) +
      buildToolSegHtml('解析', doc, {
        title: '文档/媒体解析工具；检测到相关文件或意图后按需携带',
      }) +
      buildToolSegHtml('shell模式', shell, {
        title: 'Shell 模式专用；输入 /shell 进入协作会话后可用',
        countCompact: true,
      })
    );
  }

  function formatContextWindow(n) {
    if (!isFinite(n) || n <= 0) return '';
    if (n >= 1000) return `${Math.round(n / 1000)}K`;
    return String(n);
  }

  function formatContextSizeLabel(max, used) {
    if (max == null) return { text: '载入中…', title: '' };
    if (!max || max <= 0) return { text: '—', title: '' };
    const maxLabel = formatContextWindow(max);
    const title = `${Number(max).toLocaleString('en-US')} tokens`;
    if (typeof used === 'number' && used > 0) {
      const usedLabel = Number(used).toLocaleString('en-US');
      const pct = ((used / max) * 100).toFixed(1);
      return { text: `${usedLabel} / ${maxLabel}`, title: `${title} · 已用 ${pct}%` };
    }
    return { text: maxLabel, title };
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

  /** @deprecated 仅作 API 无 categories 时的兜底 */
  const DEFERRED_TOOL_NAMES = [
    'parse_document', 'parse_doc_legacy', 'parse_xlsx_deep', 'parse_pptx_deep',
    'parse_xmind_deep', 'notebook_read', 'image_read',
  ];
  const SHELL_TOOL_COUNT = 8;

  function fallbackCategoriesFromTools(tools) {
    if (!Array.isArray(tools)) return { chat: { count: 0 }, doc: { count: 0, lazy: true }, shell: { count: SHELL_TOOL_COUNT } };
    const deferredSet = {};
    for (let i = 0; i < DEFERRED_TOOL_NAMES.length; i++) deferredSet[DEFERRED_TOOL_NAMES[i]] = true;
    let doc = 0;
    let chat = 0;
    for (let j = 0; j < tools.length; j++) {
      const name = tools[j] && tools[j].name ? String(tools[j].name) : '';
      if (!name || name.startsWith('mcp_')) continue;
      if (deferredSet[name]) doc++;
      else chat++;
    }
    return { chat: { count: chat }, doc: { count: doc, lazy: true }, shell: { count: SHELL_TOOL_COUNT } };
  }

  function fetchToolCategories() {
    if (toolsFetchPending || toolsCategories != null) return;
    toolsFetchPending = true;
    fetch('/api/tools')
      .then((res) =>  res.json())
      .then((data) => {
        if (data && data.success && data.categories) {
          toolsCategories = data.categories;
        } else if (data && data.success && Array.isArray(data.tools)) {
          toolsCategories = fallbackCategoriesFromTools(data.tools);
        } else {
          toolsCategories = fallbackCategoriesFromTools([]);
        }
      })
      .catch(() => {
        toolsCategories = fallbackCategoriesFromTools([]);
      })
      .finally(() => {
        toolsFetchPending = false;
        refreshContextLabels();
      });
  }

  function fetchModelContext() {
    if (contextFetchPending || contextMaxTokens != null) return;
    contextFetchPending = true;
    fetch('/api/config')
      .then((res) =>  res.json())
      .then((data) => {
        const providers = data && data.providers ? data.providers : [];
        const def = providers.find((p) =>  p.isDefault) || providers[0];
        if (def && typeof def.maxContextTokens === 'number' && def.maxContextTokens > 0) {
          contextMaxTokens = def.maxContextTokens;
        } else {
          contextMaxTokens = 0;
        }
      })
      .catch(() => {
        contextMaxTokens = 0;
      })
      .finally(() => {
        contextFetchPending = false;
        refreshContextLabels();
      });
  }

  function refreshContextLabels() {
    if (elRoot && !elRoot.classList.contains('hidden')) {
      updateContextLabels();
    }
    const mobileDash = document.getElementById('mobile-work-dashboard');
    if (mobileDash) updateContextLabels(mobileDash);
  }

  function updateContextLabels(root) {
    const r = resolveRoot(root);
    if (!r) return;

    const workspaceEl = r.querySelector('[data-welcome-workspace]');
    if (workspaceEl) {
      const Store = window.ChatSessionStore;
      const sessionId = Store && typeof Store.getActiveSessionId === 'function'
        ? Store.getActiveSessionId()
        : 'default';
      const workspace = formatWorkspaceLabel(sessionId);
      workspaceEl.textContent = workspace.text;
      if (workspace.title) workspaceEl.setAttribute('title', workspace.title);
      else workspaceEl.removeAttribute('title');
    }

    const toolsInlineEl = r.querySelector('[data-welcome-tools-inline]');
    if (toolsInlineEl) {
      if (!toolsCategories) {
        toolsInlineEl.textContent = '载入中…';
        toolsInlineEl.removeAttribute('title');
      } else {
        toolsInlineEl.innerHTML = buildToolsInlineHtml(toolsCategories);
        toolsInlineEl.setAttribute(
          'title',
          '常用：普通模式默认携带 · 解析：按需携带 · shell模式：/shell 会话专用'
        );
      }
    }

    const contextEl = r.querySelector('[data-welcome-context-size]');
    if (contextEl) {
      const size = formatContextSizeLabel(contextMaxTokens, contextUsedTokens);
      contextEl.textContent = size.text;
      if (size.title) contextEl.setAttribute('title', size.title);
      else contextEl.removeAttribute('title');
    }
  }

  function bindStoreListener() {
    if (storeListenerBound) return;
    const Store = window.ChatSessionStore;
    if (!Store || typeof Store.onChange !== 'function') return;
    Store.onChange(() => {
      refreshContextLabels();
    });
    storeListenerBound = true;
  }

  function fetchMemoryCount() {
    if (memoryFetchPending || memoryCount != null) return;
    memoryFetchPending = true;
    fetch('/api/memory/stats')
      .then((res) =>  res.json())
      .then((data) => {
        if (data && data.success && typeof data.total === 'number') {
          memoryCount = data.total;
        } else {
          memoryCount = 0;
        }
      })
      .catch(() => {
        memoryCount = 0;
      })
      .finally(() => {
        memoryFetchPending = false;
        if (elRoot && !elRoot.classList.contains('hidden')) {
          updateMemoryLabel();
        }
        const mobileDash = document.getElementById('mobile-work-dashboard');
        if (mobileDash) updateMemoryLabel(mobileDash);
      });
  }

  function updateMemoryLabel(root) {
    const r = resolveRoot(root);
    if (!r) return;
    const el = r.querySelector('[data-welcome-memory]');
    if (!el) return;
    if (memoryCount == null) {
      el.textContent = '载入中…';
      return;
    }
    el.textContent = memoryCount > 0 ? (`已加载 ${memoryCount} 条`) : '暂无记忆';
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
    const r = resolveRoot(root);
    if (!r) return;
    const el = r.querySelector('[data-welcome-harness]');
    const iconEl = r.querySelector('[data-welcome-harness-icon]');
    const connected = opts.connectionState === 'connected';
    const setupRequired = !!opts.setupRequired;
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
    const r = resolveRoot(root);
    if (!r) return;
    const el = r.querySelector('[data-welcome-pipeline]');
    const iconEl = r.querySelector('[data-welcome-pipeline-icon]');
    const connected = opts.connectionState === 'connected';
    const setupRequired = !!opts.setupRequired;
    if (!connected || setupRequired) {
      setStatValue(el, iconEl, '未激活', 'muted');
      return;
    }
    setStatValue(el, iconEl, '就绪', 'success');
  }

  function resolveRoot(root) {
    return root || elRoot;
  }

  function updateModeLabel(mode, root) {
    const r = resolveRoot(root);
    if (!r) return;
    const modeEl = r.querySelector('[data-welcome-mode]');
    const subEl = r.querySelector('[data-welcome-subtitle]');
    const label = getSupervisorLabel(mode);
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
    fetchToolCategories();
  }

  function sync(opts) {
    opts = opts || {};
    ensureRoot(!!opts.remoteMode);
    if (!elRoot) return;

    const messageCount = typeof opts.messageCount === 'number' ? opts.messageCount : 0;
    const hasTailContent = !!opts.hasTailContent;
    const isWorkloadActive = !!opts.isWorkloadActive;
    const show = messageCount <= 0 && !hasTailContent && !isWorkloadActive;
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
    if (toolsCategories == null) fetchToolCategories();
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
    if (toolsCategories == null) fetchToolCategories();
  }

  return {
    init,
    sync,
    buildDashboardMarkup: buildMarkup,
    syncDashboard,
    getTips() { return TIPS.slice(); },
  };
})();

if (typeof window !== 'undefined') {
  window.ChatWelcome = ChatWelcome;
}
