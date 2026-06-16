/**
 * 聊天空状态欢迎页：无消息时展示快速上手与建议开始。
 */

/* exported ChatWelcome */

window.ChatWelcome = (function () {
  'use strict';

  var elRoot = null;
  var elMessages = null;
  var onPromptSelect = null;
  var memoryCount = null;
  var memoryFetchPending = false;

  var PROMPTS = [
    {
      icon: 'megaphone',
      text: '检查项目中的问题并给出修复建议',
      value: '请检查当前项目中的问题，并给出修复建议。',
    },
    {
      icon: 'spark',
      text: '优化项目的性能并提供改进方案',
      value: '请分析当前项目的性能瓶颈，并提供可落地的改进方案。',
    },
    {
      icon: 'code',
      text: '解释项目中的某段代码逻辑',
      value: '请帮我解释项目中某段关键代码的逻辑与调用关系。',
    },
  ];

  var TIPS = [
    {
      key: 'cmd',
      title: '命令面板',
      desc: '点击输入框右侧命令按钮，快速执行 open、scan、telemetry 等操作',
      descRemote: '点击输入框右侧命令按钮，快速执行 open、telemetry 等操作',
      hint: '命令',
    },
    {
      key: 'hash',
      title: '# 技能',
      desc: '输入 # 选用技能，或在侧栏「技能」页浏览全部技能',
      hint: '#',
    },
    {
      key: 'model',
      title: '模型切换',
      desc: '点击输入框下方模型 chip，切换 Provider 与默认模型',
      hint: '模型',
    },
    {
      key: 'plus',
      title: '附件与命令',
      desc: '左侧 + 上传文件；右侧命令按钮打开命令面板',
      hint: '+',
    },
  ];

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTokenCount(n) {
    if (!n || n <= 0) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
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
    if (name === 'mode') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    }
    if (name === 'memory') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>';
    }
    if (name === 'checkpoint') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 4h15v16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M6 8h11"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  }

  function promptIconSvg(name) {
    if (name === 'megaphone') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3 11 8-4v10l-8-4v-2Z"/><path d="M11 9.5 16 7v10l-5-2.5"/><path d="M18 8a3 3 0 0 1 0 8"/></svg>';
    }
    if (name === 'spark') {
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3 9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5L12 3Z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 8l-2 8 8-2 2-8-8 2Z"/><path d="m14 10 4 4"/></svg>';
  }

  function buildMarkup(remoteMode) {
    var tipsHtml = TIPS.map(function (tip) {
      var desc = (remoteMode && tip.descRemote) ? tip.descRemote : tip.desc;
      return (
        '<div class="chat-welcome-tip">' +
          '<span class="chat-welcome-tip-kbd">' + escapeHtml(tip.hint) + '</span>' +
          '<div class="chat-welcome-tip-body">' +
            '<div class="chat-welcome-tip-title">' + escapeHtml(tip.title) + '</div>' +
            '<div class="chat-welcome-tip-desc">' + escapeHtml(desc) + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    var promptsHtml = PROMPTS.map(function (item, idx) {
      return (
        '<button type="button" class="chat-welcome-prompt" data-prompt-index="' + idx + '">' +
          '<span class="chat-welcome-prompt-icon">' + promptIconSvg(item.icon) + '</span>' +
          '<span class="chat-welcome-prompt-text">' + escapeHtml(item.text) + '</span>' +
          '<span class="chat-welcome-prompt-arrow" aria-hidden="true">&rsaquo;</span>' +
        '</button>'
      );
    }).join('');

    return (
      '<div class="chat-welcome-inner">' +
        '<header class="chat-welcome-header">' +
          '<div class="chat-welcome-brand">' +
            '<span class="chat-welcome-logo" aria-hidden="true">' +
              '<svg viewBox="0 0 100 100" width="40" height="40"><circle cx="50" cy="50" r="41" fill="currentColor" opacity="0.12"/><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M21 37 A9 9 0 0 1 39 37 L39 59 A9 9 0 0 1 21 59 Z"/><path d="M61 37 A9 9 0 0 1 79 37 L79 59 A9 9 0 0 1 61 59 Z"/></g></svg>' +
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
            '<span class="chat-welcome-stat-icon chat-welcome-stat-icon-ready">' + statIconSvg('checkpoint') + '</span>' +
            '<div class="chat-welcome-stat-body">' +
              '<span class="chat-welcome-stat-label">Checkpoint</span>' +
              '<span class="chat-welcome-stat-value chat-welcome-stat-value-success">就绪</span>' +
            '</div>' +
          '</div>' +
          '<div class="chat-welcome-stat">' +
            '<span class="chat-welcome-stat-icon">' + statIconSvg('context') + '</span>' +
            '<div class="chat-welcome-stat-body">' +
              '<span class="chat-welcome-stat-label">上下文</span>' +
              '<span class="chat-welcome-stat-value" data-welcome-context>—</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<section class="chat-welcome-section">' +
          '<h2 class="chat-welcome-section-title">快速上手</h2>' +
          '<div class="chat-welcome-tips">' + tipsHtml + '</div>' +
        '</section>' +
        '<section class="chat-welcome-section">' +
          '<h2 class="chat-welcome-section-title">建议开始</h2>' +
          '<div class="chat-welcome-prompts">' + promptsHtml + '</div>' +
        '</section>' +
      '</div>'
    );
  }

  function ensureRoot(remoteMode) {
    if (elRoot || !elMessages) return;
    elRoot = document.createElement('div');
    elRoot.className = 'chat-welcome hidden';
    elRoot.id = 'chat-welcome';
    elRoot.setAttribute('role', 'region');
    elRoot.setAttribute('aria-label', '欢迎与快速上手');
    elRoot.innerHTML = buildMarkup(!!remoteMode);

    elRoot.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-prompt-index]') : null;
      if (!btn) return;
      var idx = parseInt(btn.getAttribute('data-prompt-index'), 10);
      var item = PROMPTS[idx];
      if (!item || !onPromptSelect) return;
      onPromptSelect(item.value);
    });

    var historyOuter = elMessages.querySelector('.chat-history-outer');
    if (historyOuter) {
      elMessages.insertBefore(elRoot, historyOuter);
    } else {
      elMessages.insertBefore(elRoot, elMessages.firstChild);
    }
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
      });
  }

  function updateMemoryLabel() {
    if (!elRoot) return;
    var el = elRoot.querySelector('[data-welcome-memory]');
    if (!el) return;
    if (memoryCount == null) {
      el.textContent = '载入中…';
      return;
    }
    el.textContent = memoryCount > 0 ? ('已加载 ' + memoryCount + ' 条') : '暂无记忆';
  }

  function updateContextLabel(opts) {
    if (!elRoot) return;
    var el = elRoot.querySelector('[data-welcome-context]');
    if (!el) return;
    var maxCtx = opts.maxContextTokens || 0;
    var used = opts.usedInputTokens || 0;
    if (maxCtx > 0) {
      var pct = Math.min(100, Math.round((used / maxCtx) * 100));
      el.textContent = pct + '% / ' + formatTokenCount(maxCtx);
      return;
    }
    if (opts.modelName) {
      el.textContent = opts.modelName;
      return;
    }
    el.textContent = '—';
  }

  function updateModeLabel(mode) {
    if (!elRoot) return;
    var modeEl = elRoot.querySelector('[data-welcome-mode]');
    var subEl = elRoot.querySelector('[data-welcome-subtitle]');
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
    onPromptSelect = typeof opts.onPromptSelect === 'function' ? opts.onPromptSelect : null;
    ensureRoot(!!opts.remoteMode);
    fetchMemoryCount();
  }

  function sync(opts) {
    opts = opts || {};
    ensureRoot(!!opts.remoteMode);
    if (!elRoot) return;

    var messageCount = typeof opts.messageCount === 'number' ? opts.messageCount : 0;
    var show = messageCount <= 0;
    setVisible(show);
    if (!show) return;

    updateModeLabel(opts.supervisorMode || 'adaptive');
    updateContextLabel(opts);
    updateMemoryLabel();
    if (memoryCount == null) fetchMemoryCount();
  }

  return {
    init: init,
    sync: sync,
  };
})();
