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
      key: 'at',
      title: '@ 引用文件',
      desc: '输入 @ 从工作区选择文件，引用绝对路径供 Agent 读取',
      hint: '@',
    },
    {
      key: 'hash',
      title: '# 技能',
      desc: '输入 # 选用技能，或在侧栏「技能」页浏览全部技能',
      hint: '#',
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

  function promptIconSvg(name) {
    var map = { megaphone: 'megaphone', spark: 'spark', code: 'code-cursor' };
    return window.AppIcon ? window.AppIcon.html(map[name] || 'code-cursor', { width: 18 }) : '';
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
              (window.AppIcon ? window.AppIcon.html('logo', { width: 40 }) : '') +
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
        '<section class="chat-welcome-section">' +
          '<h2 class="chat-welcome-section-title">建议开始</h2>' +
          '<div class="chat-welcome-prompts">' + promptsHtml + '</div>' +
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
    onPromptSelect = typeof opts.onPromptSelect === 'function' ? opts.onPromptSelect : null;
    ensureRoot(!!opts.remoteMode);
    fetchMemoryCount();
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

    updateModeLabel(opts.supervisorMode || 'adaptive');
    updateHarnessLabel(opts);
    updatePipelineLabel(opts);
    updateMemoryLabel();
    if (memoryCount == null) fetchMemoryCount();
  }

  function bindDashboardEvents(root, onSelect) {
    if (!root) return;
    root.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-prompt-index]') : null;
      if (!btn) return;
      var idx = parseInt(btn.getAttribute('data-prompt-index'), 10);
      var item = PROMPTS[idx];
      if (!item || typeof onSelect !== 'function') return;
      onSelect(item.value);
    });
  }

  function syncDashboard(root, opts) {
    opts = opts || {};
    if (!root) return;
    updateModeLabel(opts.supervisorMode || 'adaptive', root);
    updateHarnessLabel(opts, root);
    updatePipelineLabel(opts, root);
    updateMemoryLabel(root);
    if (memoryCount == null) fetchMemoryCount();
  }

  return {
    init: init,
    sync: sync,
    buildDashboardMarkup: buildMarkup,
    bindDashboardEvents: bindDashboardEvents,
    syncDashboard: syncDashboard,
    getPrompts: function () { return PROMPTS.slice(); },
    getTips: function () { return TIPS.slice(); },
  };
})();
