/**
 * 执行透明层（ETL）— 右侧停靠侧边栏。
 *
 * Phase 4：由锚定冰豆的 popover 重构为聊天页右侧常驻 `<aside id="exec-transparency-panel">`。
 * 结构：头部（标题 + 最小化）→ Tab 条 → 当前步骤卡 → 执行计划列表（含耗时）→ Footer（Token/工具/时间）。
 * 显示门控读 EtlPrefs（`showTransparencyPanel`）；最小化收为宠物形态，双击宠物展开。
 *
 * Observer 红线：只消费事件、不影响事件；所有入口 try/catch，异常降级为空 UI，绝不 throw 冒泡。
 * 对外契约（setPlan/applyPatch/clear/... ）签名保持不变。
 */

/* exported ChatExecutionPlan */

window.ChatExecutionPlan = (function () {
  'use strict';

  var PANEL_ID = 'exec-transparency-panel';
  var ACTIVE_TAB_STORAGE_KEY = 'ICE_ETL_ACTIVE_TAB';
  // Observer 必须同步、快速返回；异常大的计划不应把浏览器事件循环拖死。
  var MAX_RENDER_STEPS = 500;
  var MAX_TOOL_HISTORY = 100;

  var STATE_LABELS = {
    pending: '待执行',
    running: '进行中',
    done: '已完成',
    failed: '失败',
    skipped: '已跳过',
    fallback: '备选',
  };

  var STATE_ICONS = {
    pending: '⬜',
    running: '🔄',
    done: '✅',
    failed: '❌',
    skipped: '⏭️',
    fallback: '🔀',
  };

  var INTENT_LABELS = {
    edit: '实现',
    debug: '排查',
    test: '测试',
    refactor: '重构',
    inspect: '查阅',
    docs: '文档',
    question: '问答',
  };

  // tool_failure：ModeSignal 名，UI 显示「forced · 工具失败」。多为 run_command 验收失败触发，
  // 或 BranchBudget 拦 write（工具未执行）；不是 edit_file 引擎坏了。见 branch-budget.ts 文件头。
  var MODE_SIGNAL_LABELS = {
    checkpoint_resumed: 'checkpoint 恢复',
    task_graph_active: '任务图活跃',
    branch_switched: '分支切换',
    pending_steps: '待执行步骤',
    tool_failure: '工具失败',
    multi_write: '多文件写入',
    large_diff: '大 diff',
    explicit_impl: '明确实现',
    recovery_pending: '恢复待定',
    engine_fail_safe: '引擎 fail-safe',
  };

  var DEGRADED_LABELS = {
    graph: '图构建降级',
    step_queue: '步骤队列降级',
    write_intent: '写入意图降级',
  };

  // Supervisor（L2 监管层）Timeline 一级事件模板（设计 §3.7.1）。
  var SUPERVISOR_SUBTYPES = {
    takeover: { icon: '⚠', label: 'Supervisor 接管', cls: 'is-takeover' },
    recovery: { icon: '↻', label: '开始恢复', cls: 'is-recovery' },
    replan: { icon: '↻', label: '重新规划', cls: 'is-replan' },
    resume: { icon: '▸', label: '继续执行', cls: 'is-resume' },
  };

  var TABS = [
    { id: 'flow', label: '执行流' },
    { id: 'tools', label: '工具调用' },
    { id: 'context', label: '上下文' },
    { id: 'snapshot', label: '状态快照' },
    { id: 'log', label: '日志' },
  ];

  // 移动端底部 sheet 仅保留「执行流」+「工具调用」（设计 §6）。
  var MOBILE_TABS = [
    { id: 'flow', label: '执行流' },
    { id: 'tools', label: '工具调用' },
  ];

  var currentPlan = null;
  var frozenPlanId = null;
  var currentExecutionMode = null;
  var visible = false;
  var capabilityEnabled = true;
  var pageActive = true;
  var minimized = false;
  var activeTab = restoreActiveTab();

  var rootEl = null;
  var listEl = null;
  var modeBannerEl = null;
  var currentStepEl = null;
  var emptyStateEl = null;
  var footerEl = null;
  var llmActivityEl = null;
  var timelineEl = null;

  // 挂载模式与承载容器：桌面 = 右侧停靠 aside；移动 = 顶部条 + 底部 sheet（设计 §6）。
  var mountedMode = null;      // 'desktop' | 'mobile'
  var hostEl = null;          // 承载 tabs/panels/footer 的容器（桌面=rootEl，移动=mobileSheetEl）
  var mobileBarEl = null;      // 移动端顶部一行入口「执行 X/N ▸」
  var mobileSheetEl = null;    // 移动端底部 sheet
  var mobileBackdropEl = null; // 移动端 sheet 蒙层

  var tickTimer = null;
  var resizeBound = false;
  var footerStats = { totalTokenUsage: null, totalToolCalls: null };
  var toolRecords = [];
  var toolRecordById = Object.create(null);
  var toolCallIds = Object.create(null);
  var uniqueToolCallCount = 0;
  var authoritativeToolCalls = null;
  var calibratedUniqueToolCount = 0;

  // LLM 当前动作：仅记录最近一次工具调用及其是否已返回；不读取任何 reasoning/thinking 文本。
  var lastTool = { toolCallId: '', toolName: '', pending: false, ts: 0 };
  // Supervisor 一级事件（{ kind:'supervisor', subtype, reasonHuman, signals, round, ts, expanded }）。
  var supervisorEvents = [];

  function safeWarn(where, err) {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[ChatExecutionPlan] ' + where + ' 降级：', err);
      }
    } catch (_e) { /* ignore */ }
  }

  function restoreActiveTab() {
    try {
      var stored = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
      for (var i = 0; i < TABS.length; i++) {
        if (TABS[i].id === stored) return stored;
      }
    } catch (_e) { /* ignore */ }
    return 'flow';
  }

  function persistActiveTab(tabId) {
    try {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabId);
    } catch (_e) { /* ignore */ }
  }

  // ── 偏好读取（EtlPrefs）──

  function pref(key, fallback) {
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.getKey === 'function') {
        var v = window.EtlPrefs.getKey(key);
        return v === undefined ? fallback : v;
      }
    } catch (_e) { /* ignore */ }
    return fallback;
  }

  /** 面板是否被抑制：主开关 showTransparencyPanel 关闭即抑制（默认关）。 */
  function isPanelSuppressed() {
    try {
      return !pref('showTransparencyPanel', false);
    } catch (_e) {
      return true;
    }
  }

  function isMobileShell() {
    try {
      return document.documentElement.getAttribute('data-shell') === 'mobile';
    } catch (_e) {
      return false;
    }
  }

  function applyPanelWidth() {
    try {
      var w = pref('panelWidth', 360);
      w = typeof w === 'number' ? w : parseInt(w, 10);
      if (!isFinite(w)) w = 360;
      w = Math.min(480, Math.max(320, w));
      document.documentElement.style.setProperty('--etl-w', w + 'px');
    } catch (_e) { /* ignore */ }
  }

  // ── 时间格式化 ──

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatClock(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return pad2(m) + ':' + pad2(s);
  }

  function formatStepDuration(step) {
    if (!step || typeof step.startedAt !== 'number') return '';
    var end = typeof step.endedAt === 'number' ? step.endedAt : Date.now();
    var ms = end - step.startedAt;
    if (ms < 0) ms = 0;
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return formatClock(ms);
  }

  function formatThousands(n) {
    try {
      return Number(n).toLocaleString('en-US');
    } catch (_e) {
      return '' + n;
    }
  }

  function formatWindow(n) {
    if (!isFinite(n) || n <= 0) return '';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return '' + n;
  }

  // ── 计划状态工具 ──

  function countFinished(steps) {
    var n = 0;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i].status;
      if (s === 'done' || s === 'failed' || s === 'skipped') n++;
    }
    return n;
  }

  function hasSafePlanShape(plan) {
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) return false;
    for (var i = 0; i < plan.steps.length; i++) {
      if (!plan.steps[i] || typeof plan.steps[i] !== 'object') return false;
    }
    return true;
  }

  /** 计划是否已全部结束（进度 100 或所有步骤进入终态） */
  function isPlanComplete(plan) {
    if (!plan) return true;
    if (typeof plan.progress === 'number' && plan.progress >= 100) return true;
    if (!plan.steps || !plan.steps.length) return false;
    for (var i = 0; i < plan.steps.length; i++) {
      var s = plan.steps[i].status;
      if (s !== 'done' && s !== 'failed' && s !== 'skipped') return false;
    }
    return true;
  }

  /** 底部摘要 / 锚点是否应继续展示（forced 执行段且进行中） */
  function isPlanLive() {
    if (!currentPlan || isPlanComplete(currentPlan)) return false;
    if (!currentExecutionMode || currentExecutionMode.executionMode !== 'forced') return false;
    return true;
  }

  function pickActiveStep(plan) {
    if (!plan || !plan.steps) return null;
    if (plan.activeStepId) {
      for (var i = 0; i < plan.steps.length; i++) {
        if (plan.steps[i].id === plan.activeStepId) return plan.steps[i];
      }
    }
    for (var j = 0; j < plan.steps.length; j++) {
      if (plan.steps[j].status === 'running') return plan.steps[j];
    }
    for (var k = 0; k < plan.steps.length; k++) {
      if (plan.steps[k].status === 'pending') return plan.steps[k];
    }
    return plan.steps[plan.steps.length - 1] || null;
  }

  function hasRunningStep() {
    if (!currentPlan || !currentPlan.steps) return false;
    for (var i = 0; i < currentPlan.steps.length; i++) {
      var st = currentPlan.steps[i];
      if (st.status === 'running' && typeof st.startedAt === 'number' && typeof st.endedAt !== 'number') {
        return true;
      }
    }
    return false;
  }

  function clamp40(s) {
    if (!s) return '';
    var str = String(s);
    return str.length > 40 ? str.slice(0, 39) + '…' : str;
  }

  function clamp24(s) {
    if (!s) return '';
    var str = String(s);
    return str.length > 24 ? str.slice(0, 23) + '…' : str;
  }

  // ── 挂载 ──

  function buildTabsHtml(tabs) {
    var html = '';
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var tabId = 'etl-tab-' + t.id;
      var panelId = 'etl-panel-' + t.id;
      html +=
        '<button type="button" class="etl-tab' + (t.id === activeTab ? ' is-active' : '') +
        '" id="' + tabId + '" data-tab="' + t.id + '" role="tab" aria-controls="' + panelId +
        '" aria-selected="' + (t.id === activeTab ? 'true' : 'false') +
        '" tabindex="' + (t.id === activeTab ? '0' : '-1') + '">' +
        t.label + '</button>';
    }
    return html;
  }

  /** 执行流 Tab 主体（当前步骤卡 + 计划列表 + LLM 动作 + 时间轴），桌面/移动共用 IDs。 */
  function flowPanelHtml() {
    return '<section class="etl-tabpanel" id="etl-panel-flow" data-panel="flow" role="tabpanel" aria-labelledby="etl-tab-flow">' +
      '<div class="etl-current-step hidden" id="etl-current-step"></div>' +
      '<div class="etl-empty etl-plan-empty hidden">本次为问答，无执行计划</div>' +
      '<ol class="exec-plan-list" id="exec-plan-list"></ol>' +
      '<div class="etl-llm-activity hidden" id="etl-llm-activity" aria-live="polite"></div>' +
      '<div class="etl-timeline hidden" id="etl-timeline"></div>' +
    '</section>';
  }

  /** 从 host 抓取渲染所需元素引用（模块级变量，后续渲染均以此为准）。 */
  function grabHostRefs(host) {
    listEl = host.querySelector('#exec-plan-list');
    modeBannerEl = host.querySelector('#exec-plan-mode-banner');
    currentStepEl = host.querySelector('#etl-current-step');
    emptyStateEl = host.querySelector('.etl-plan-empty');
    footerEl = host.querySelector('#etl-footer');
    llmActivityEl = host.querySelector('#etl-llm-activity');
    timelineEl = host.querySelector('#etl-timeline');
  }

  /** 绑定最小化按钮 + Tab 切换（桌面/移动共用）。 */
  function bindHostControls(host) {
    var minBtn = host.querySelector('.etl-minimize');
    if (minBtn) {
      minBtn.addEventListener('click', function () {
        minimize();
      });
    }
    var tabBtns = host.querySelectorAll('.etl-tab');
    Array.prototype.forEach.call(tabBtns, function (btn) {
      btn.addEventListener('click', function () {
        setActiveTab(btn.getAttribute('data-tab'));
      });
      btn.addEventListener('keydown', function (event) {
        var key = event.key;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
        event.preventDefault();
        var available = Array.prototype.slice.call(host.querySelectorAll('.etl-tab'));
        if (!available.length) return;
        var index = available.indexOf(btn);
        if (key === 'Home') index = 0;
        else if (key === 'End') index = available.length - 1;
        else if (key === 'ArrowRight') index = (index + 1) % available.length;
        else index = (index - 1 + available.length) % available.length;
        var target = available[index];
        setActiveTab(target.getAttribute('data-tab'));
        target.focus();
      });
    });
  }

  function ensureMounted() {
    try {
      var wantMobile = isMobileShell();
      var wantMode = wantMobile ? 'mobile' : 'desktop';
      if (mountedMode === wantMode) return hostEl;
      // 运行时 shell 切换（罕见）：拆除旧挂载后重挂对应形态。
      if (mountedMode) teardownMounts();
      if (wantMobile) mountMobile();
      else mountDesktop();
      bindResize();
      return hostEl;
    } catch (e) {
      safeWarn('ensureMounted', e);
      teardownMounts();
      return null;
    }
  }

  function teardownMounts() {
    try {
      stopTick();
      if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      if (mobileBarEl && mobileBarEl.parentNode) mobileBarEl.parentNode.removeChild(mobileBarEl);
      if (mobileSheetEl && mobileSheetEl.parentNode) mobileSheetEl.parentNode.removeChild(mobileSheetEl);
      if (mobileBackdropEl && mobileBackdropEl.parentNode) mobileBackdropEl.parentNode.removeChild(mobileBackdropEl);
      document.body.classList.remove('etl-panel-open', 'etl-msheet-open', 'etl-pet-hidden-by-panel');
    } catch (_e) { /* ignore */ }
    rootEl = null;
    mobileBarEl = null;
    mobileSheetEl = null;
    mobileBackdropEl = null;
    hostEl = null;
    listEl = null;
    modeBannerEl = null;
    currentStepEl = null;
    emptyStateEl = null;
    footerEl = null;
    llmActivityEl = null;
    timelineEl = null;
    mountedMode = null;
  }

  function mountDesktop() {
    rootEl = document.createElement('aside');
    rootEl.id = PANEL_ID;
    rootEl.className = 'etl-panel';
    rootEl.setAttribute('role', 'complementary');
    rootEl.setAttribute('aria-label', '执行透明层');
    rootEl.setAttribute('aria-hidden', 'true');

    rootEl.innerHTML =
      '<header class="etl-header">' +
        '<span class="etl-title">执行透明层</span>' +
        '<button type="button" class="etl-minimize" title="最小化" aria-label="最小化面板">—</button>' +
      '</header>' +
      '<div class="exec-plan-mode-banner hidden" id="exec-plan-mode-banner"></div>' +
      '<nav class="etl-tabs" role="tablist">' + buildTabsHtml(TABS) + '</nav>' +
      '<div class="etl-body">' +
        flowPanelHtml() +
        '<section class="etl-tabpanel hidden" id="etl-panel-tools" data-panel="tools" role="tabpanel" aria-labelledby="etl-tab-tools">' +
          '<div class="etl-empty">暂无数据</div>' +
        '</section>' +
        '<section class="etl-tabpanel hidden" id="etl-panel-context" data-panel="context" role="tabpanel" aria-labelledby="etl-tab-context">' +
          '<div class="etl-empty">暂无数据</div>' +
        '</section>' +
        '<section class="etl-tabpanel hidden" id="etl-panel-snapshot" data-panel="snapshot" role="tabpanel" aria-labelledby="etl-tab-snapshot">' +
          '<div class="etl-empty">暂无数据</div>' +
        '</section>' +
        '<section class="etl-tabpanel hidden" id="etl-panel-log" data-panel="log" role="tabpanel" aria-labelledby="etl-tab-log">' +
          '<div class="etl-empty">暂无数据</div>' +
        '</section>' +
      '</div>' +
      '<footer class="etl-footer" id="etl-footer"></footer>';

    document.body.appendChild(rootEl);
    hostEl = rootEl;
    mountedMode = 'desktop';
    grabHostRefs(rootEl);
    bindHostControls(rootEl);
  }

  /** 移动端：顶部一行入口 + 底部 sheet（复用执行流/工具调用 Tab；设计 §6）。 */
  function mountMobile() {
    // 移动端仅有 flow/tools 两个 Tab；若 activeTab 落在桌面独有 Tab 上则回落到 flow。
    if (activeTab !== 'flow' && activeTab !== 'tools') {
      activeTab = 'flow';
      persistActiveTab(activeTab);
    }

    mobileBarEl = document.createElement('button');
    mobileBarEl.type = 'button';
    mobileBarEl.className = 'etl-mbar';
    mobileBarEl.setAttribute('aria-label', '展开执行透明层');
    mobileBarEl.innerHTML = '<span class="etl-mbar-text">执行透明层 ▸</span>';
    mobileBarEl.addEventListener('click', function () {
      if (minimized) expand();
      else minimize();
    });

    mobileBackdropEl = document.createElement('div');
    mobileBackdropEl.className = 'etl-mbackdrop';
    mobileBackdropEl.addEventListener('click', function () {
      minimize();
    });

    mobileSheetEl = document.createElement('aside');
    mobileSheetEl.id = PANEL_ID;
    mobileSheetEl.className = 'etl-msheet';
    mobileSheetEl.setAttribute('role', 'complementary');
    mobileSheetEl.setAttribute('aria-label', '执行透明层');
    mobileSheetEl.setAttribute('aria-hidden', 'true');
    mobileSheetEl.innerHTML =
      '<div class="etl-msheet-handle" aria-hidden="true"></div>' +
      '<header class="etl-header">' +
        '<span class="etl-title">执行透明层</span>' +
        '<button type="button" class="etl-minimize" title="收起" aria-label="收起面板">—</button>' +
      '</header>' +
      '<div class="exec-plan-mode-banner hidden" id="exec-plan-mode-banner"></div>' +
      '<nav class="etl-tabs" role="tablist">' + buildTabsHtml(MOBILE_TABS) + '</nav>' +
      '<div class="etl-body">' +
        flowPanelHtml() +
        '<section class="etl-tabpanel hidden" id="etl-panel-tools" data-panel="tools" role="tabpanel" aria-labelledby="etl-tab-tools">' +
          '<div class="etl-empty">暂无数据</div>' +
        '</section>' +
      '</div>' +
      '<footer class="etl-footer" id="etl-footer"></footer>';

    document.body.appendChild(mobileBackdropEl);
    document.body.appendChild(mobileSheetEl);
    document.body.appendChild(mobileBarEl);

    hostEl = mobileSheetEl;
    mountedMode = 'mobile';
    grabHostRefs(mobileSheetEl);
    bindHostControls(mobileSheetEl);
    bindMobileEscape();
    layoutMobileBar();
  }

  var mobileEscapeBound = false;
  function bindMobileEscape() {
    if (mobileEscapeBound) return;
    mobileEscapeBound = true;
    document.addEventListener('keydown', function (event) {
      try {
        if (event.key === 'Escape' && mountedMode === 'mobile'
          && mobileSheetEl && mobileSheetEl.classList.contains('etl-msheet--open')) {
          minimize();
        }
      } catch (e) {
        safeWarn('mobileEscape', e);
      }
    });
  }

  function bindResize() {
    if (resizeBound) return;
    resizeBound = true;
    window.addEventListener('resize', onResizeReflow);
  }

  var resizeTimer = null;
  function onResizeReflow() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      try {
        if (mountedMode === 'mobile') {
          layoutMobileBar();
        } else if (rootEl && rootEl.classList.contains('etl-panel--open')) {
          layoutTop();
        }
      } catch (_e) { /* ignore */ }
    }, 80);
  }

  /** #top-nav 底缘（不存在则 0） */
  function navBottom() {
    var top = 0;
    try {
      var nav = document.getElementById('top-nav');
      if (nav && nav.getBoundingClientRect) {
        top = Math.max(0, nav.getBoundingClientRect().bottom);
      }
    } catch (_e) { /* ignore */ }
    return top;
  }

  /** 桌面：top 由 #top-nav 底缘决定（不存在则贴顶） */
  function layoutTop() {
    if (!rootEl) return;
    rootEl.style.top = navBottom() + 'px';
  }

  /** 移动：顶部条贴 #top-nav 底缘。 */
  function layoutMobileBar() {
    if (!mobileBarEl) return;
    mobileBarEl.style.top = navBottom() + 'px';
  }

  function setActiveTab(tabId) {
    try {
      if (!tabId || !hostEl) return;
      activeTab = tabId;
      persistActiveTab(activeTab);
      var tabBtns = hostEl.querySelectorAll('.etl-tab');
      Array.prototype.forEach.call(tabBtns, function (btn) {
        var on = btn.getAttribute('data-tab') === tabId;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.setAttribute('tabindex', on ? '0' : '-1');
      });
      var panels = hostEl.querySelectorAll('.etl-tabpanel');
      Array.prototype.forEach.call(panels, function (p) {
        p.classList.toggle('hidden', p.getAttribute('data-panel') !== tabId);
      });
    } catch (e) {
      safeWarn('setActiveTab', e);
    }
  }

  // ── 显隐控制 ──

  /** 是否应呈现透明层（桌面面板 / 移动顶部条的共同前置条件）。 */
  function shouldShow() {
    if (isPanelSuppressed()) return false;
    if (!capabilityEnabled) return false;
    if (!pageActive) return false;
    if (!visible) return false;
    return true;
  }

  /** 当前形态是否处于「呈现中」（供 tick 判活）。 */
  function isShowing() {
    if (mountedMode === 'mobile') {
      return !!(mobileBarEl && mobileBarEl.classList.contains('etl-mbar--open'));
    }
    return !!(rootEl && rootEl.classList.contains('etl-panel--open'));
  }

  function applyVisibility() {
    try {
      // 主开关关闭时不得残留面板 DOM；计划状态仍保留，重新开启时再按需挂载。
      if (isPanelSuppressed()) {
        teardownMounts();
        return;
      }
      if (!capabilityEnabled || !pageActive) {
        if (rootEl) {
          rootEl.classList.remove('etl-panel--open');
          rootEl.setAttribute('aria-hidden', 'true');
        }
        if (mobileBarEl) mobileBarEl.classList.remove('etl-mbar--open');
        closeSheetDom();
        document.body.classList.remove('etl-panel-open', 'etl-pet-hidden-by-panel');
        stopTick();
        return;
      }
      if (isMobileShell()) {
        applyVisibilityMobile();
        return;
      }
      if (shouldShow() && !minimized) {
        ensureMounted();
        applyPanelWidth();
        layoutTop();
        rootEl.classList.add('etl-panel--open');
        rootEl.setAttribute('aria-hidden', 'false');
        document.body.classList.add('etl-panel-open');
        document.body.classList.add('etl-pet-hidden-by-panel');
        startTick();
      } else {
        if (rootEl) {
          rootEl.classList.remove('etl-panel--open');
          rootEl.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('etl-panel-open');
        document.body.classList.remove('etl-pet-hidden-by-panel');
        stopTick();
      }
    } catch (e) {
      safeWarn('applyVisibility', e);
      teardownMounts();
    }
  }

  /**
   * 移动端：顶部条常驻入口 + 底部 sheet（设计 §6）。
   * `minimized` 复用为「sheet 是否收起」：panelDefaultExpanded=true → 默认展开 sheet；
   * =false 时桥调用 minimize() 收起，仅留顶部条。panelWidth 不适用（sheet 占满宽度）。
   */
  function applyVisibilityMobile() {
    ensureMounted();
    if (shouldShow()) {
      layoutMobileBar();
      if (mobileBarEl) mobileBarEl.classList.add('etl-mbar--open');
      updateMobileBar();
      if (!minimized) openSheetDom();
      else closeSheetDom();
      startTick();
    } else {
      if (mobileBarEl) mobileBarEl.classList.remove('etl-mbar--open');
      closeSheetDom();
      stopTick();
    }
  }

  function openSheetDom() {
    if (!mobileSheetEl) return;
    mobileSheetEl.classList.add('etl-msheet--open');
    mobileSheetEl.setAttribute('aria-hidden', 'false');
    if (mobileBackdropEl) mobileBackdropEl.classList.add('etl-mbackdrop--open');
    document.body.classList.add('etl-msheet-open');
    document.body.classList.add('etl-pet-hidden-by-panel');
    if (mobileBarEl) mobileBarEl.classList.add('is-expanded');
  }

  function closeSheetDom() {
    if (mobileSheetEl) {
      mobileSheetEl.classList.remove('etl-msheet--open');
      mobileSheetEl.setAttribute('aria-hidden', 'true');
    }
    if (mobileBackdropEl) mobileBackdropEl.classList.remove('etl-mbackdrop--open');
    document.body.classList.remove('etl-msheet-open');
    document.body.classList.remove('etl-pet-hidden-by-panel');
    if (mobileBarEl) mobileBarEl.classList.remove('is-expanded');
  }

  function updateMobileBar() {
    if (!mobileBarEl) return;
    var textEl = mobileBarEl.querySelector('.etl-mbar-text');
    if (!textEl) return;
    var arrow = minimized ? '▸' : '▾';
    if (currentPlan && currentPlan.steps && currentPlan.steps.length) {
      var total = currentPlan.steps.length;
      var done = countFinished(currentPlan.steps);
      textEl.textContent = '执行 ' + done + '/' + total + ' ' + arrow;
    } else {
      textEl.textContent = '执行透明层 ' + arrow;
    }
  }

  function startTick() {
    if (tickTimer || isPlanComplete(currentPlan)) return;
    tickTimer = setInterval(function () {
      try {
        if (!isShowing()) {
          stopTick();
          return;
        }
        updateLiveTimes();
        if (isPlanComplete(currentPlan) && !hasRunningStep()) {
          stopTick();
        }
      } catch (e) {
        safeWarn('tick', e);
        stopTick();
      }
    }, 1000);
  }

  function stopTick() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function updateLiveTimes() {
    // 当前步骤卡耗时
    if (currentStepEl && currentPlan) {
      var active = pickActiveStep(currentPlan);
      var elapsedEl = currentStepEl.querySelector('.etl-cs-elapsed');
      if (elapsedEl && active) elapsedEl.textContent = formatStepDuration(active);
    }
    // 列表内运行中步骤耗时
    if (listEl && currentPlan && currentPlan.steps) {
      for (var i = 0; i < currentPlan.steps.length; i++) {
        var st = currentPlan.steps[i];
        if (st.status === 'running' && typeof st.startedAt === 'number' && typeof st.endedAt !== 'number') {
          var node = listEl.querySelector('.exec-plan-step[data-step-id="' + st.id + '"] .exec-plan-step-dur');
          if (node) node.textContent = formatStepDuration(st);
        }
      }
    }
    // 时间轴：运行中步骤耗时 + 总时长条（就地更新，避免整块重渲染导致滚动/展开态丢失）
    if (timelineEl && !timelineEl.classList.contains('hidden') && currentPlan && currentPlan.steps) {
      for (var t = 0; t < currentPlan.steps.length; t++) {
        var ts = currentPlan.steps[t];
        if (ts.status === 'running' && typeof ts.startedAt === 'number' && typeof ts.endedAt !== 'number') {
          var durNode = timelineEl.querySelector('.etl-tl-node--step[data-step-id="' + ts.id + '"] .etl-tl-dur');
          if (durNode) durNode.textContent = formatStepDuration(ts);
        }
      }
      var totalEl = timelineEl.querySelector('.etl-tl-total');
      if (totalEl) totalEl.textContent = '总时长 ' + formatPlanTotalTime();
    }
    // Footer 总时间
    var timeElFoot = footerEl && footerEl.querySelector('.etl-foot-time b');
    if (timeElFoot) timeElFoot.textContent = formatPlanTotalTime();
    // 移动端顶部条进度计数
    if (mountedMode === 'mobile') updateMobileBar();
  }

  // ── 渲染：当前步骤卡 ──

  function renderCurrentStep() {
    if (!currentStepEl) return;
    if (!currentPlan || !currentPlan.steps || !currentPlan.steps.length) {
      currentStepEl.innerHTML = '';
      currentStepEl.classList.add('hidden');
      return;
    }
    currentStepEl.classList.remove('hidden');

    var steps = currentPlan.steps;
    var total = steps.length;
    var active = pickActiveStep(currentPlan);
    var idx = active ? steps.indexOf(active) : -1;
    var stepNo = idx >= 0 ? idx + 1 : countFinished(steps);
    var done = countFinished(steps);
    var pct = total ? Math.round((done / total) * 100) : 0;
    var statusLabel = active ? (STATE_LABELS[active.status] || active.status) : '';
    var icon = active ? (STATE_ICONS[active.status] || '') : '';
    var dur = active ? formatStepDuration(active) : '';
    var title = active ? clamp40(active.title) : '';
    var complete = isPlanComplete(currentPlan);

    currentStepEl.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'etl-cs-head';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'etl-cs-title';
    titleSpan.textContent = '步骤 ' + stepNo + '/' + total + '：' + title;
    var elapsed = document.createElement('span');
    elapsed.className = 'etl-cs-elapsed';
    elapsed.textContent = dur;
    head.appendChild(titleSpan);
    head.appendChild(elapsed);
    currentStepEl.appendChild(head);

    var bar = document.createElement('div');
    bar.className = 'etl-cs-progress';
    var fill = document.createElement('div');
    fill.className = 'etl-cs-bar';
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    currentStepEl.appendChild(bar);

    var statusRow = document.createElement('div');
    statusRow.className = 'etl-cs-status status-' + (active ? active.status : 'pending');
    statusRow.textContent = complete
      ? '✅ 已完成 · 用时 ' + formatPlanTotalTime()
      : (icon ? icon + ' ' : '') + statusLabel;
    currentStepEl.appendChild(statusRow);

    if (active && active.evidence) {
      var ev = document.createElement('div');
      ev.className = 'etl-cs-evidence';
      ev.textContent = clamp40(active.evidence);
      ev.title = active.evidence;
      currentStepEl.appendChild(ev);
    }
  }

  // ── 渲染：执行计划列表 ──

  function renderStepNode(step, isActive) {
    var li = document.createElement('li');
    var branchClass = step.isFallback ? ' exec-plan-step--fallback' : (step.isResumed ? ' exec-plan-step--resumed' : '');
    li.className = 'exec-plan-step status-' + step.status + (isActive ? ' active' : '') + branchClass;
    li.dataset.stepId = step.id;
    if (step.isFallback) li.dataset.branch = 'fallback';
    else if (step.isResumed) li.dataset.branch = 'resumed';

    var head = document.createElement('div');
    head.className = 'exec-plan-step-head';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'exec-plan-step-title';
    titleSpan.textContent = clamp40(step.title);
    var badge = document.createElement('span');
    badge.className = 'exec-plan-step-badge';
    badge.textContent = STATE_LABELS[step.status] || step.status;
    var dur = document.createElement('span');
    dur.className = 'exec-plan-step-dur';
    dur.textContent = formatStepDuration(step);
    head.appendChild(titleSpan);
    head.appendChild(badge);
    head.appendChild(dur);
    li.appendChild(head);

    if (step.suggestedTools && step.suggestedTools.length > 0) {
      var tools = document.createElement('div');
      tools.className = 'exec-plan-step-tools';
      tools.textContent = '工具：' + step.suggestedTools.join('、');
      li.appendChild(tools);
    }

    if (step.evidence) {
      var ev = document.createElement('div');
      ev.className = 'exec-plan-step-evidence';
      ev.textContent = '证据：' + clamp40(step.evidence);
      ev.title = step.evidence;
      li.appendChild(ev);
    }

    if (step.status === 'failed' && step.error) {
      var err = document.createElement('div');
      err.className = 'exec-plan-step-error';
      err.textContent = step.error;
      err.title = step.error;
      li.appendChild(err);
    }

    return li;
  }

  function renderList() {
    if (!listEl || !currentPlan) return;
    listEl.innerHTML = '';
    var steps = currentPlan.steps || [];
    if (!Array.isArray(steps) || steps.length > MAX_RENDER_STEPS) return;
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (!step || typeof step !== 'object') continue;
      var isActive = step.id === currentPlan.activeStepId;
      listEl.appendChild(renderStepNode(step, isActive));
    }
    maybeScrollActive();
  }

  function renderEmptyState() {
    if (!emptyStateEl) return;
    emptyStateEl.classList.toggle('hidden', !!currentPlan);
  }

  function maybeScrollActive() {
    try {
      if (!pref('autoScrollActiveStep', true)) return;
      if (!listEl || !currentPlan || !currentPlan.activeStepId) return;
      var el = listEl.querySelector('.exec-plan-step[data-step-id="' + currentPlan.activeStepId + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } catch (_e) { /* ignore */ }
  }

  function applyPatchToStep(stepEl, patch) {
    if (!stepEl) return;
    if (patch.status) {
      stepEl.classList.remove('status-pending', 'status-running', 'status-done', 'status-failed', 'status-skipped', 'status-fallback');
      stepEl.classList.add('status-' + patch.status);
      var badge = stepEl.querySelector('.exec-plan-step-badge');
      if (badge) badge.textContent = STATE_LABELS[patch.status] || patch.status;
    }
    var durEl = stepEl.querySelector('.exec-plan-step-dur');
    if (durEl) {
      var stepId = stepEl.dataset.stepId;
      var stepObj = currentPlan && currentPlan.steps
        ? currentPlan.steps.find(function (s) { return s.id === stepId; })
        : null;
      if (stepObj) durEl.textContent = formatStepDuration(stepObj);
    }
    if (patch.evidence !== undefined) {
      var evEl = stepEl.querySelector('.exec-plan-step-evidence');
      if (!evEl) {
        evEl = document.createElement('div');
        evEl.className = 'exec-plan-step-evidence';
        stepEl.appendChild(evEl);
      }
      evEl.textContent = '证据：' + clamp40(patch.evidence);
      evEl.title = patch.evidence;
    }
    if (patch.error) {
      var errEl = stepEl.querySelector('.exec-plan-step-error');
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.className = 'exec-plan-step-error';
        stepEl.appendChild(errEl);
      }
      errEl.textContent = patch.error;
      errEl.title = patch.error;
    }
  }

  // ── 渲染：Footer ──

  function formatPlanTotalTime() {
    if (!currentPlan || !currentPlan.steps || !currentPlan.steps.length) {
      if (currentPlan && typeof currentPlan.createdAt === 'number') {
        var endc = isPlanComplete(currentPlan) && typeof currentPlan.updatedAt === 'number'
          ? currentPlan.updatedAt : Date.now();
        return formatClock(endc - currentPlan.createdAt);
      }
      return '00:00';
    }
    var start = null;
    var end = null;
    var running = false;
    var steps = currentPlan.steps;
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i];
      if (typeof st.startedAt === 'number') {
        if (start === null || st.startedAt < start) start = st.startedAt;
      }
      if (typeof st.endedAt === 'number') {
        if (end === null || st.endedAt > end) end = st.endedAt;
      }
      if (st.status === 'running' && typeof st.startedAt === 'number' && typeof st.endedAt !== 'number') {
        running = true;
      }
    }
    if (start === null) {
      if (typeof currentPlan.createdAt === 'number') start = currentPlan.createdAt;
      else return '00:00';
    }
    var e;
    if (isPlanComplete(currentPlan)) {
      e = typeof currentPlan.updatedAt === 'number'
        ? currentPlan.updatedAt
        : (end !== null ? end : Date.now());
    } else {
      e = running ? Date.now() : (end !== null ? end : Date.now());
    }
    return formatClock(e - start);
  }

  function formatTokenStat() {
    var t = footerStats.totalTokenUsage;
    if (!t) return '—';
    var used = typeof t.effectiveUsed === 'number' && t.effectiveUsed > 0 ? t.effectiveUsed : (t.inputTokens || 0);
    var win = typeof t.contextWindow === 'number' ? t.contextWindow : 0;
    if (!win) return formatThousands(used);
    var pct = win > 0 ? ((used / win) * 100).toFixed(1) : '0';
    return formatThousands(used) + '/' + formatWindow(win) + ' (' + pct + '%)';
  }

  function renderFooter() {
    if (!footerEl) return;
    var tokenTxt = formatTokenStat();
    var liveToolCount = authoritativeToolCalls === null
      ? uniqueToolCallCount
      : authoritativeToolCalls + Math.max(0, uniqueToolCallCount - calibratedUniqueToolCount);
    var toolTxt = liveToolCount > 0 || authoritativeToolCalls !== null ? String(liveToolCount) : '—';
    var timeTxt = formatPlanTotalTime();
    footerEl.innerHTML = '';

    footerEl.appendChild(makeFootItem('etl-foot-token', 'Token', tokenTxt));
    footerEl.appendChild(makeFootItem('etl-foot-tool', '工具', toolTxt));
    footerEl.appendChild(makeFootItem('etl-foot-time', '时间', timeTxt));
  }

  function makeFootItem(cls, label, value) {
    var span = document.createElement('span');
    span.className = 'etl-foot-item ' + cls;
    var b = document.createElement('b');
    b.textContent = value;
    span.appendChild(document.createTextNode(label + ' '));
    span.appendChild(b);
    return span;
  }

  // ── 监管横幅（复用现有 .exec-plan-mode-banner）──

  function renderExecutionModeBanner() {
    if (!modeBannerEl) return;
    if (!currentExecutionMode || currentExecutionMode.executionMode !== 'forced') {
      modeBannerEl.classList.add('hidden');
      modeBannerEl.textContent = '';
      return;
    }
    var lines = [];
    lines.push('⚠ 监管接管中 · ' + (currentExecutionMode.primaryReasonHuman || 'forced'));
    if (currentExecutionMode.enteredBy && currentExecutionMode.enteredBy.length) {
      var tags = currentExecutionMode.enteredBy.map(function (sig) {
        return MODE_SIGNAL_LABELS[sig] || sig;
      });
      lines.push('信号：' + tags.join(' + '));
    }
    if (currentExecutionMode.degradedTier) {
      lines.push('降级：' + (DEGRADED_LABELS[currentExecutionMode.degradedTier] || currentExecutionMode.degradedTier));
    }
    if (typeof currentExecutionMode.round === 'number') {
      lines.push('轮次：' + currentExecutionMode.round);
    }
    modeBannerEl.textContent = lines.join('\n');
    modeBannerEl.classList.remove('hidden');
  }

  /** 底部一行摘要（供冰豆 #status-turn）；如 forced · 工具失败 = executionMode + enteredByPrimary 组合，非单一事件类型 */
  function formatExecutionModeChip(modeState) {
    if (!modeState || modeState.executionMode !== 'forced') return '';
    var primary = modeState.enteredByPrimary;
    var label = primary ? (MODE_SIGNAL_LABELS[primary] || primary) : 'forced';
    if (modeState.degradedTier) {
      label += ' · ' + (DEGRADED_LABELS[modeState.degradedTier] || modeState.degradedTier);
    }
    return 'forced · ' + label;
  }

  function formatFootSummary(plan) {
    if (!plan || !plan.steps || !plan.steps.length) return '';
    var done = countFinished(plan.steps);
    var total = plan.steps.length;
    var active = pickActiveStep(plan);
    var phase = active ? STATE_LABELS[active.status] || active.status : '';
    var shortTitle = active ? clamp24(active.title) : '';
    var base = done + '/' + total;
    if (phase && shortTitle) return base + ' · ' + phase + ' · ' + shortTitle;
    if (phase) return base + ' · ' + phase;
    return base;
  }

  function notifyPetFoot() {
    if (typeof window.ChatPetBridge !== 'undefined' && window.ChatPetBridge.syncExecPlanFoot) {
      window.ChatPetBridge.syncExecPlanFoot();
    }
  }

  // ── 渲染：LLM 当前动作（设计 §3.6，仅动作状态，无 reasoning/思维链）──

  /**
   * 由「活动节点 phase/status + 最近 tool_call/tool_result」确定性推导一条动作短语。
   * 绝不读取任何 reasoning / thinking 文本。
   */
  function deriveLlmActivity() {
    // 最近一次 tool_call 尚未收到 tool_result：优先展示等待工具返回
    if (lastTool.pending && lastTool.toolName) {
      return '正在等待工具返回（' + lastTool.toolName + '）…';
    }
    var active = pickActiveStep(currentPlan);
    if (!active) return '';
    var running = active.status === 'running';
    if (active.isVerification && running) return '正在验证结果…';
    var phase = active.phase || '';
    if (phase === 'final') return '正在整理结论…';
    if (running) {
      if (phase === 'context') return '正在分析项目结构…';
      if (phase === 'editing') return '正在生成修改方案…';
      if (phase === 'intent') return '正在理解任务目标…';
      if (active.requiresTool) return '正在调用工具…';
      return '正在执行当前步骤…';
    }
    return '';
  }

  function renderLlmActivity() {
    if (!llmActivityEl) return;
    try {
      if (!pref('showLlmActivity', true) || !currentPlan || isPlanComplete(currentPlan)) {
        llmActivityEl.classList.add('hidden');
        llmActivityEl.textContent = '';
        return;
      }
      var phrase = clamp40(deriveLlmActivity());
      if (!phrase) {
        llmActivityEl.classList.add('hidden');
        llmActivityEl.textContent = '';
        return;
      }
      llmActivityEl.innerHTML = '';
      var label = document.createElement('div');
      label.className = 'etl-llm-label';
      label.textContent = 'LLM 当前动作';
      var text = document.createElement('div');
      text.className = 'etl-llm-text';
      text.textContent = phrase;
      llmActivityEl.appendChild(label);
      llmActivityEl.appendChild(text);
      llmActivityEl.classList.remove('hidden');
    } catch (e) {
      safeWarn('renderLlmActivity', e);
      try {
        llmActivityEl.classList.add('hidden');
        llmActivityEl.textContent = '';
      } catch (_e) { /* ignore */ }
    }
  }

  // ── 渲染：时间轴（设计 §3.7 / §3.7.1）──

  function formatAbsClock(ts) {
    try {
      var d = new Date(ts);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    } catch (_e) {
      return '';
    }
  }

  function formatRel(ts, origin) {
    var ms = ts - origin;
    if (ms < 0) ms = 0;
    if (ms < 60000) return '+' + (ms / 1000).toFixed(1) + 's';
    return '+' + formatClock(ms);
  }

  /** 计算时间轴起点：首个 startedAt，退化到 plan.createdAt。 */
  function timelineOrigin() {
    var origin = null;
    if (currentPlan && currentPlan.steps) {
      for (var i = 0; i < currentPlan.steps.length; i++) {
        var st = currentPlan.steps[i];
        if (typeof st.startedAt === 'number' && (origin === null || st.startedAt < origin)) {
          origin = st.startedAt;
        }
      }
    }
    for (var j = 0; j < supervisorEvents.length; j++) {
      var ev = supervisorEvents[j];
      if (typeof ev.ts === 'number' && (origin === null || ev.ts < origin)) origin = ev.ts;
    }
    for (var k = 0; k < toolRecords.length; k++) {
      var toolTs = toolRecords[k].callTs;
      if (typeof toolTs === 'number' && (origin === null || toolTs < origin)) origin = toolTs;
    }
    if (origin === null && currentPlan && typeof currentPlan.createdAt === 'number') {
      origin = currentPlan.createdAt;
    }
    return origin;
  }

  /** 归并步骤节点与 supervisor 事件为统一时间线（按 ts 升序）。 */
  function buildTimelineNodes() {
    var nodes = [];
    if (currentPlan && currentPlan.steps) {
      for (var i = 0; i < currentPlan.steps.length; i++) {
        var st = currentPlan.steps[i];
        var ts = typeof st.startedAt === 'number'
          ? st.startedAt
          : (typeof st.endedAt === 'number' ? st.endedAt : null);
        nodes.push({
          kind: 'step',
          ts: ts,
          order: i,
          step: st,
        });
      }
    }
    for (var k = 0; k < supervisorEvents.length; k++) {
      var ev = supervisorEvents[k];
      nodes.push({ kind: 'supervisor', ts: typeof ev.ts === 'number' ? ev.ts : null, order: 10000 + k, event: ev });
    }
    if (pref('timelineGranularity', 'step') === 'step+tool') {
      for (var t = 0; t < toolRecords.length; t++) {
        var tool = toolRecords[t];
        nodes.push({ kind: 'tool', ts: tool.callTs, order: 20000 + t, tool: tool });
      }
    }
    nodes.sort(function (a, b) {
      var ta = a.ts === null ? Infinity : a.ts;
      var tb = b.ts === null ? Infinity : b.ts;
      if (ta !== tb) return ta - tb;
      return a.order - b.order;
    });
    return nodes;
  }

  function timeModeLabel() {
    return pref('timelineTimeMode', 'absolute') === 'relative' ? '相对时间' : '绝对时间';
  }

  function granularityLabel() {
    return pref('timelineGranularity', 'step') === 'step+tool' ? '步骤+工具' : '仅步骤';
  }

  function makeStepTimelineNode(node, origin, timeMode) {
    var st = node.step;
    var wrap = document.createElement('div');
    wrap.className = 'etl-tl-node etl-tl-node--step status-' + st.status;
    wrap.dataset.stepId = st.id;

    var stamp = document.createElement('span');
    stamp.className = 'etl-tl-time';
    if (node.ts !== null) {
      stamp.textContent = timeMode === 'relative' ? formatRel(node.ts, origin) : formatAbsClock(node.ts);
    } else {
      stamp.textContent = '—';
    }

    var dot = document.createElement('span');
    dot.className = 'etl-tl-dot status-' + st.status;

    var body = document.createElement('span');
    body.className = 'etl-tl-body';
    var title = document.createElement('span');
    title.className = 'etl-tl-title';
    title.textContent = clamp24(st.title);
    var dur = document.createElement('span');
    dur.className = 'etl-tl-dur';
    dur.textContent = st.status === 'pending' ? (STATE_LABELS[st.status] || '') : formatStepDuration(st);
    body.appendChild(title);
    body.appendChild(dur);

    wrap.appendChild(stamp);
    wrap.appendChild(dot);
    wrap.appendChild(body);

    var tip = clamp24(st.title) + ' · ';
    tip += node.ts !== null ? ('开始 ' + formatAbsClock(node.ts)) : '未开始';
    if (typeof st.endedAt === 'number') tip += ' · 结束 ' + formatAbsClock(st.endedAt);
    tip += ' · ' + (STATE_LABELS[st.status] || st.status);
    if (st.status !== 'pending') tip += ' · 用时 ' + formatStepDuration(st);
    wrap.title = tip;

    wrap.addEventListener('click', function () {
      try {
        var target = listEl && listEl.querySelector('.exec-plan-step[data-step-id="' + st.id + '"]');
        if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
        if (target) {
          target.classList.add('exec-plan-step--flash');
          setTimeout(function () {
            try { target.classList.remove('exec-plan-step--flash'); } catch (_e) { /* ignore */ }
          }, 900);
        }
      } catch (_e) { /* ignore */ }
    });
    return wrap;
  }

  function makeSupervisorTimelineNode(node, origin, timeMode) {
    var ev = node.event;
    var conf = SUPERVISOR_SUBTYPES[ev.subtype] || SUPERVISOR_SUBTYPES.takeover;
    var wrap = document.createElement('div');
    wrap.className = 'etl-tl-node etl-tl-node--supervisor ' + conf.cls;

    var stamp = document.createElement('span');
    stamp.className = 'etl-tl-time';
    if (node.ts !== null) {
      stamp.textContent = timeMode === 'relative' ? formatRel(node.ts, origin) : formatAbsClock(node.ts);
    } else {
      stamp.textContent = '—';
    }

    var dot = document.createElement('span');
    dot.className = 'etl-tl-dot etl-tl-dot--supervisor';
    dot.textContent = conf.icon;

    var body = document.createElement('span');
    body.className = 'etl-tl-body';
    var head = document.createElement('span');
    head.className = 'etl-tl-sup-head';
    var title = document.createElement('span');
    title.className = 'etl-tl-title';
    title.textContent = conf.icon + ' ' + conf.label;
    head.appendChild(title);

    var hasDetail = !!(ev.reasonHuman || (ev.signals && ev.signals.length) || typeof ev.round === 'number');
    if (hasDetail) {
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'etl-tl-sup-toggle';
      toggle.textContent = ev.expanded ? '收起 ▴' : '展开 ▾';
      head.appendChild(toggle);
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        ev.expanded = !ev.expanded;
        renderTimeline();
      });
    }
    body.appendChild(head);

    if (ev.reasonHuman) {
      var sub = document.createElement('span');
      sub.className = 'etl-tl-sup-reason';
      sub.textContent = clamp40(ev.reasonHuman);
      body.appendChild(sub);
    }

    if (ev.expanded && hasDetail) {
      var detail = document.createElement('div');
      detail.className = 'etl-tl-sup-detail';
      if (ev.reasonHuman) {
        var r = document.createElement('div');
        r.textContent = '原因：' + ev.reasonHuman;
        detail.appendChild(r);
      }
      if (ev.signals && ev.signals.length) {
        var sig = document.createElement('div');
        var tags = ev.signals.map(function (s) { return MODE_SIGNAL_LABELS[s] || s; });
        sig.textContent = '信号：' + tags.join(' + ');
        detail.appendChild(sig);
      }
      if (typeof ev.round === 'number') {
        var rd = document.createElement('div');
        rd.textContent = '轮次：' + ev.round;
        detail.appendChild(rd);
      }
      body.appendChild(detail);
    }

    wrap.appendChild(stamp);
    wrap.appendChild(dot);
    wrap.appendChild(body);
    return wrap;
  }

  function makeToolTimelineNode(node, origin, timeMode) {
    var tool = node.tool;
    var wrap = document.createElement('div');
    wrap.className = 'etl-tl-node etl-tl-node--tool status-' + tool.status;
    wrap.dataset.toolCallId = tool.toolCallId;
    wrap.dataset.status = tool.status;
    wrap.dataset.callTs = String(tool.callTs);
    if (typeof tool.resultTs === 'number') wrap.dataset.resultTs = String(tool.resultTs);

    var stamp = document.createElement('span');
    stamp.className = 'etl-tl-time';
    stamp.textContent = timeMode === 'relative'
      ? formatRel(tool.callTs, origin)
      : formatAbsClock(tool.callTs);
    var dot = document.createElement('span');
    dot.className = 'etl-tl-dot status-' + tool.status;
    var body = document.createElement('span');
    body.className = 'etl-tl-body';
    var title = document.createElement('span');
    title.className = 'etl-tl-title';
    title.textContent = clamp24(tool.toolName || '工具调用');
    var detail = document.createElement('span');
    detail.className = 'etl-tl-dur';
    detail.textContent = typeof tool.resultTs === 'number'
      ? ('返回 ' + (timeMode === 'relative'
        ? formatRel(tool.resultTs, origin)
        : formatAbsClock(tool.resultTs)))
      : '运行中';
    body.appendChild(title);
    body.appendChild(detail);
    wrap.appendChild(stamp);
    wrap.appendChild(dot);
    wrap.appendChild(body);
    try {
      wrap.title = (tool.toolName || '工具调用') + ' · 调用 ' + formatAbsClock(tool.callTs)
        + (typeof tool.resultTs === 'number' ? ' · 返回 ' + formatAbsClock(tool.resultTs) : '')
        + ' · ' + tool.status;
    } catch (e) {
      safeWarn('toolTooltip', e);
    }
    return wrap;
  }

  function timelineEnd(nodes, origin) {
    var end = origin;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (typeof n.ts === 'number' && n.ts > end) end = n.ts;
      if (n.kind === 'step' && typeof n.step.endedAt === 'number' && n.step.endedAt > end) end = n.step.endedAt;
      if (n.kind === 'tool' && typeof n.tool.resultTs === 'number' && n.tool.resultTs > end) end = n.tool.resultTs;
    }
    return end;
  }

  function positionTimelineNode(nodeEl, node, origin, span) {
    if (!nodeEl || mountedMode === 'mobile') return;
    var ts = typeof node.ts === 'number' ? node.ts : origin;
    var ratio = span > 0 ? (ts - origin) / span : 0;
    ratio = Math.max(0, Math.min(1, ratio));
    nodeEl.style.left = (ratio * 100) + '%';
  }

  function renderTimeline() {
    if (!timelineEl) return;
    try {
      if (!pref('showTimeline', true) || !currentPlan || !currentPlan.steps || !currentPlan.steps.length) {
        timelineEl.classList.add('hidden');
        timelineEl.innerHTML = '';
        return;
      }
      if (!Array.isArray(currentPlan.steps) || currentPlan.steps.length > MAX_RENDER_STEPS) {
        timelineEl.classList.add('hidden');
        timelineEl.innerHTML = '';
        return;
      }
      var origin = timelineOrigin();
      if (origin === null) {
        timelineEl.classList.add('hidden');
        timelineEl.innerHTML = '';
        return;
      }
      var timeMode = pref('timelineTimeMode', 'absolute');
      var nodes = buildTimelineNodes();

      timelineEl.innerHTML = '';

      var head = document.createElement('div');
      head.className = 'etl-tl-head';
      var htitle = document.createElement('span');
      htitle.className = 'etl-tl-headtitle';
      htitle.textContent = '时间轴';
      var toggles = document.createElement('span');
      toggles.className = 'etl-tl-toggles';

      var timeBtn = document.createElement('button');
      timeBtn.type = 'button';
      timeBtn.className = 'etl-tl-toggle';
      timeBtn.textContent = timeModeLabel() + ' ▾';
      timeBtn.title = '切换绝对/相对时间';
      timeBtn.addEventListener('click', function () {
        setPrefSafe('timelineTimeMode', timeMode === 'relative' ? 'absolute' : 'relative');
      });

      var granBtn = document.createElement('button');
      granBtn.type = 'button';
      granBtn.className = 'etl-tl-toggle';
      granBtn.textContent = granularityLabel() + ' ▾';
      granBtn.title = '切换时间轴粒度';
      granBtn.addEventListener('click', function () {
        var cur = pref('timelineGranularity', 'step');
        setPrefSafe('timelineGranularity', cur === 'step+tool' ? 'step' : 'step+tool');
      });

      toggles.appendChild(timeBtn);
      toggles.appendChild(granBtn);
      head.appendChild(htitle);
      head.appendChild(toggles);
      timelineEl.appendChild(head);

      var track = document.createElement('div');
      var horizontal = mountedMode !== 'mobile';
      track.className = 'etl-tl-track ' + (horizontal
        ? 'etl-tl-track--horizontal'
        : 'etl-tl-track--vertical');
      var totalSpan = Math.max(0, timelineEnd(nodes, origin) - origin);
      track.dataset.totalSpan = String(totalSpan);
      if (horizontal) track.style.width = Math.max(640, nodes.length * 128) + 'px';
      var activeNodeEl = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var nodeEl;
        if (n.kind === 'supervisor') nodeEl = makeSupervisorTimelineNode(n, origin, timeMode);
        else if (n.kind === 'tool') nodeEl = makeToolTimelineNode(n, origin, timeMode);
        else nodeEl = makeStepTimelineNode(n, origin, timeMode);
        positionTimelineNode(nodeEl, n, origin, totalSpan);
        track.appendChild(nodeEl);
        if (n.kind === 'step' && currentPlan.activeStepId && n.step.id === currentPlan.activeStepId) {
          activeNodeEl = nodeEl;
        }
      }
      var scroll = document.createElement('div');
      scroll.className = 'etl-tl-scroll';
      scroll.appendChild(track);
      timelineEl.appendChild(scroll);

      var totalBar = document.createElement('div');
      totalBar.className = 'etl-tl-total';
      totalBar.textContent = '总时长 ' + formatPlanTotalTime();
      timelineEl.appendChild(totalBar);

      timelineEl.classList.remove('hidden');

      // 吸附到当前步骤
      if (activeNodeEl && activeNodeEl.scrollIntoView && mountedMode === 'mobile') {
        try { activeNodeEl.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (_e) { /* ignore */ }
      }
    } catch (e) {
      safeWarn('renderTimeline', e);
      try {
        timelineEl.classList.add('hidden');
        timelineEl.innerHTML = '';
      } catch (_e) { /* ignore */ }
    }
  }

  function setPrefSafe(key, value) {
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.set === 'function') {
        var patch = {};
        patch[key] = value;
        window.EtlPrefs.set(patch);
      }
      renderTimeline();
    } catch (e) {
      safeWarn('setPrefSafe', e);
    }
  }

  /**
   * 偏好变化后的公开刷新入口。仅重绘依赖偏好的独立区块；
   * 不修改计划、执行模式或完成态，供 EtlPrefs 全局变更广播统一调用。
   */
  function refreshPreferences() {
    try {
      if (isPanelSuppressed()) {
        applyVisibility();
        return;
      }
      if (!hostEl) return;
      applyPanelWidth();
      renderLlmActivity();
      renderTimeline();
    } catch (e) {
      safeWarn('refreshPreferences', e);
    }
  }

  function bindPreferenceRefresh() {
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.onChange === 'function') {
        window.EtlPrefs.onChange(refreshPreferences);
      }
    } catch (e) {
      safeWarn('bindPreferenceRefresh', e);
    }
  }

  /** 供桥投影 Supervisor（L2 监管层）Timeline 事件；异常丢弃该条，不影响主流程（设计 §14）。 */
  function pushSupervisorTimelineEvent(evt) {
    try {
      if (!evt || !evt.subtype || !SUPERVISOR_SUBTYPES[evt.subtype]) return;
      var record = {
        kind: 'supervisor',
        subtype: evt.subtype,
        reasonHuman: evt.reasonHuman || '',
        signals: Array.isArray(evt.signals) ? evt.signals.slice() : [],
        round: typeof evt.round === 'number' ? evt.round : undefined,
        ts: typeof evt.ts === 'number' ? evt.ts : Date.now(),
        expanded: false,
      };
      // 去抖：同 subtype + round 短时间重复只保留一条
      var last = supervisorEvents[supervisorEvents.length - 1];
      if (last && last.subtype === record.subtype && last.round === record.round
        && Math.abs(record.ts - last.ts) < 500) {
        return;
      }
      supervisorEvents.push(record);
      if (supervisorEvents.length > 50) supervisorEvents.shift();
      renderTimeline();
    } catch (e) {
      safeWarn('pushSupervisorTimelineEvent', e);
    }
  }

  /**
   * 消费 tool_call / tool_result 用于推导 LLM 当前动作（不做展示，仅记录最近工具）。
   * 只取 toolName 与到达状态，绝不读取 reasoning/thinking。
   */
  function applyToolActivity(step) {
    try {
      if (!step || !step.type) return;
      if (step.type === 'tool_call') {
        var callId = typeof step.toolCallId === 'string' ? step.toolCallId : '';
        if (!callId) return;
        var toolName = typeof step.toolName === 'string' ? step.toolName : '';
        var callTs = typeof step.ts === 'number' ? step.ts : Date.now();
        if (!toolRecordById[callId]) {
          var record = {
            toolCallId: callId,
            toolName: toolName,
            callTs: callTs,
            resultTs: null,
            status: 'running',
          };
          toolRecords.push(record);
          toolRecordById[callId] = record;
          if (!toolCallIds[callId]) {
            toolCallIds[callId] = true;
            uniqueToolCallCount++;
          }
          if (toolRecords.length > MAX_TOOL_HISTORY) {
            var removed = toolRecords.shift();
            if (removed) delete toolRecordById[removed.toolCallId];
          }
        }
        lastTool = { toolCallId: callId, toolName: toolName, pending: true, ts: callTs };
        renderLlmActivity();
        renderTimeline();
        renderFooter();
      } else if (step.type === 'tool_result') {
        var resultId = typeof step.toolCallId === 'string' ? step.toolCallId : '';
        var matched = resultId ? toolRecordById[resultId] : null;
        if (matched) {
          matched.resultTs = typeof step.ts === 'number' ? step.ts : Date.now();
          matched.status = typeof step.status === 'string'
            ? step.status
            : (step.toolOutcome === 'policy_block'
              ? 'warn'
              : (step.toolSuccess === false ? 'failed' : 'done'));
        }
        if (lastTool.pending && resultId && lastTool.toolCallId === resultId) {
          lastTool.pending = false;
          renderLlmActivity();
        }
        renderTimeline();
      }
    } catch (e) {
      safeWarn('applyToolActivity', e);
    }
  }

  // ── 全量渲染 ──

  function fullRender() {
    if (!ensureMounted()) throw new Error('执行透明层挂载失败');
    renderExecutionModeBanner();
    renderCurrentStep();
    renderEmptyState();
    renderList();
    renderLlmActivity();
    renderTimeline();
    renderFooter();
    if (mountedMode === 'mobile') updateMobileBar();
  }

  /** fatal teardown 后由下一条合法事件按当前只读状态重建完整面板。 */
  function recoverPanelAfterFatal() {
    if (hostEl) return true;
    if (!visible || !pageActive || !capabilityEnabled || isPanelSuppressed()) return false;
    fullRender();
    applyVisibility();
    return !!hostEl;
  }

  // ── 对外 API ──

  function setPlan(plan) {
    try {
      if (!plan) {
        clear();
        return;
      }
      if (!hasSafePlanShape(plan)) {
        clear();
        return;
      }
      // 新一轮任务（planId 变化）才重置 Supervisor 事件与工具状态；同 plan 的增量更新保留时间线。
      var prevId = currentPlan && currentPlan.planId;
      if (frozenPlanId && prevId === plan.planId && frozenPlanId === plan.planId) {
        recoverPanelAfterFatal();
        return;
      }
      if (!prevId || prevId !== plan.planId) {
        frozenPlanId = null;
        supervisorEvents = [];
        lastTool = { toolCallId: '', toolName: '', pending: false, ts: 0 };
        toolRecords = [];
        toolRecordById = Object.create(null);
        toolCallIds = Object.create(null);
        uniqueToolCallCount = 0;
        authoritativeToolCalls = null;
        calibratedUniqueToolCount = 0;
        footerStats.totalToolCalls = null;
      }
      currentPlan = plan;
      if (isPlanComplete(currentPlan)) frozenPlanId = currentPlan.planId;
      visible = !isPanelSuppressed();
      if (isPanelSuppressed()) {
        applyVisibility();
        notifyPetFoot();
        return;
      }
      ensureMounted();
      fullRender();
      applyVisibility();
      notifyPetFoot();
    } catch (e) {
      safeWarn('setPlan', e);
      teardownMounts();
    }
  }

  function applyPatch(patch) {
    try {
      if (!currentPlan || !patch) return;
      if (frozenPlanId && currentPlan.planId === frozenPlanId) {
        recoverPanelAfterFatal();
        return;
      }
      var wasComplete = isPlanComplete(currentPlan);

      if (Array.isArray(patch.stepPatches)) {
        for (var i = 0; i < patch.stepPatches.length; i++) {
          try {
            var sp = patch.stepPatches[i];
            if (!sp || typeof sp !== 'object' || !sp.id || !Array.isArray(currentPlan.steps)) continue;
            var stepObj = currentPlan.steps.find(function (s) {
              return s && s.id === sp.id;
            });
            if (stepObj) {
              Object.assign(stepObj, sp);
            }
            if (listEl) {
              var stepEl = listEl.querySelector('.exec-plan-step[data-step-id="' + sp.id + '"]');
              applyPatchToStep(stepEl, sp);
            }
          } catch (itemError) {
            safeWarn('applyPatch.stepPatches[' + i + ']', itemError);
          }
        }
      }

      if (patch.activeStepId !== undefined) {
        currentPlan.activeStepId = patch.activeStepId || undefined;
        if (listEl) {
          var actives = listEl.querySelectorAll('.exec-plan-step.active');
          actives.forEach(function (n) {
            n.classList.remove('active');
          });
          if (currentPlan.activeStepId) {
            var newActive = listEl.querySelector(
              '.exec-plan-step[data-step-id="' + currentPlan.activeStepId + '"]',
            );
            if (newActive) newActive.classList.add('active');
          }
          maybeScrollActive();
        }
      }

      if (typeof patch.progress === 'number') {
        currentPlan.progress = patch.progress;
      }
      if (typeof patch.updatedAt === 'number') {
        currentPlan.updatedAt = patch.updatedAt;
      }
      if (!wasComplete && isPlanComplete(currentPlan) && typeof patch.updatedAt !== 'number') {
        var terminalEnd = null;
        for (var endIndex = 0; endIndex < currentPlan.steps.length; endIndex++) {
          var endedAt = currentPlan.steps[endIndex] && currentPlan.steps[endIndex].endedAt;
          if (typeof endedAt === 'number' && (terminalEnd === null || endedAt > terminalEnd)) {
            terminalEnd = endedAt;
          }
        }
        currentPlan.updatedAt = terminalEnd === null ? Date.now() : terminalEnd;
      }
      if (isPlanComplete(currentPlan)) frozenPlanId = currentPlan.planId;

      if (!hostEl && recoverPanelAfterFatal()) {
        notifyPetFoot();
        return;
      }

      renderCurrentStep();
      renderEmptyState();
      renderLlmActivity();
      renderTimeline();
      renderFooter();

      if (isPlanComplete(currentPlan)) {
        visible = !isPanelSuppressed();
        stopTick();
        applyVisibility();
      } else if (hasRunningStep()) {
        startTick();
      }
      notifyPetFoot();
    } catch (e) {
      safeWarn('applyPatch', e);
      teardownMounts();
    }
  }

  function resetExecutionMode() {
    try {
      currentExecutionMode = null;
      renderExecutionModeBanner();
      applyVisibility();
      notifyPetFoot();
    } catch (e) {
      safeWarn('resetExecutionMode', e);
    }
  }

  function clear() {
    try {
      currentPlan = null;
      frozenPlanId = null;
      currentExecutionMode = null;
      visible = !isPanelSuppressed();
      supervisorEvents = [];
      lastTool = { toolCallId: '', toolName: '', pending: false, ts: 0 };
      toolRecords = [];
      toolRecordById = Object.create(null);
      toolCallIds = Object.create(null);
      uniqueToolCallCount = 0;
      authoritativeToolCalls = null;
      calibratedUniqueToolCount = 0;
      footerStats = { totalTokenUsage: null, totalToolCalls: null };
      stopTick();
      if (hostEl) {
        if (listEl) listEl.innerHTML = '';
        if (currentStepEl) {
          currentStepEl.innerHTML = '';
          currentStepEl.classList.add('hidden');
        }
        renderEmptyState();
        if (llmActivityEl) {
          llmActivityEl.innerHTML = '';
          llmActivityEl.classList.add('hidden');
        }
        if (timelineEl) {
          timelineEl.innerHTML = '';
          timelineEl.classList.add('hidden');
        }
        renderExecutionModeBanner();
        renderFooter();
      }
      applyVisibility();
      notifyPetFoot();
    } catch (e) {
      safeWarn('clear', e);
      teardownMounts();
    }
  }

  function setVisible(v) {
    try {
      visible = !!v && !isPanelSuppressed();
      if (visible && !hostEl) {
        ensureMounted();
        fullRender();
      }
      applyVisibility();
      notifyPetFoot();
    } catch (e) {
      safeWarn('setVisible', e);
      teardownMounts();
    }
  }

  function setPageActive(active) {
    try {
      pageActive = !!active;
      if (pageActive && visible && !hostEl && !isPanelSuppressed()) {
        fullRender();
      }
      applyVisibility();
    } catch (e) {
      safeWarn('setPageActive', e);
      teardownMounts();
    }
  }

  function setCapabilityEnabled(enabled) {
    try {
      capabilityEnabled = !!enabled;
      applyVisibility();
    } catch (e) {
      safeWarn('setCapabilityEnabled', e);
      teardownMounts();
    }
  }

  function minimize() {
    try {
      minimized = true;
      applyVisibility();
    } catch (e) {
      safeWarn('minimize', e);
    }
  }

  function expand() {
    try {
      if (isPanelSuppressed()) return;
      minimized = false;
      if (currentPlan || currentExecutionMode) {
        if (!isPlanComplete(currentPlan) || currentExecutionMode) visible = true;
      }
      applyVisibility();
    } catch (e) {
      safeWarn('expand', e);
    }
  }

  /** 由聊天页宠物双击触发；受主开关 + 服务端能力两层门控。 */
  function requestExpandFromPet() {
    try {
      if (isPanelSuppressed()) return;
      if (!window.ChatExecutionPlanBridge
        || typeof window.ChatExecutionPlanBridge.isEnabled !== 'function'
        || !window.ChatExecutionPlanBridge.isEnabled()) return;
      expand();
    } catch (e) {
      safeWarn('requestExpandFromPet', e);
    }
  }

  function applyExecutionModeEvent(step) {
    try {
      if (!step || !step.executionMode) return;
      if (step.type === 'execution_mode_exit') {
        currentExecutionMode = null;
        renderExecutionModeBanner();
        applyVisibility();
        notifyPetFoot();
        return;
      }
      currentExecutionMode = Object.assign({}, step.executionMode);
      if (!isPanelSuppressed() && pageActive) {
        ensureMounted();
        renderExecutionModeBanner();
      }
      applyVisibility();
      notifyPetFoot();
    } catch (e) {
      safeWarn('applyExecutionModeEvent', e);
      teardownMounts();
    }
  }

  /** 供后续阶段/桥接喂入 Footer 统计（Token/工具）；加性、不改契约。 */
  function applyRuntimeStats(stats) {
    try {
      if (!stats || typeof stats !== 'object') return;
      if (stats.totalTokenUsage !== undefined) footerStats.totalTokenUsage = stats.totalTokenUsage;
      if (typeof stats.totalToolCalls === 'number' && isFinite(stats.totalToolCalls)) {
        footerStats.totalToolCalls = stats.totalToolCalls;
        authoritativeToolCalls = Math.max(0, stats.totalToolCalls);
        calibratedUniqueToolCount = uniqueToolCallCount;
      }
      renderFooter();
    } catch (e) {
      safeWarn('applyRuntimeStats', e);
    }
  }

  function getPlan() {
    return currentPlan;
  }

  function isVisible() {
    return visible;
  }

  function getExecutionModeChip() {
    return formatExecutionModeChip(currentExecutionMode);
  }

  function getExecutionModeState() {
    return currentExecutionMode ? Object.assign({}, currentExecutionMode) : null;
  }

  // ── TaskGraph 方法（保留兼容）──

  function graphPlanToPanel(plan) {
    if (!plan || !plan.steps) return null;
    return {
      planId: plan.planId,
      intent: plan.intent,
      progress: plan.progress || 0,
      steps: plan.steps,
      activeStepId: plan.activeStepId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  function renderGraph(data) {
    try {
      if (data.plan) {
        var panelPlan = graphPlanToPanel(data.plan);
        if (panelPlan) {
          setPlan(panelPlan);
          return;
        }
      }
      if (!data.graphGoal) return;
      currentPlan = {
        planId: 'graph-' + Date.now(),
        intent: data.graphIntent || 'edit',
        progress: 0,
        steps: [],
        activeStepId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      frozenPlanId = null;
      visible = !isPanelSuppressed();
      ensureMounted();
      fullRender();
      applyVisibility();
      notifyPetFoot();
    } catch (e) {
      safeWarn('renderGraph', e);
      teardownMounts();
    }
  }

  function updateGraphNode(data) {
    try {
      if (!currentPlan) return;
      recoverPanelAfterFatal();
      if (frozenPlanId && currentPlan.planId === frozenPlanId) return;
      currentPlan.progress = Math.min(100, ((data.nodeIndex || 0) + 1) * 25);
      currentPlan.activeStepId = data.nodeId || null;
      if (isPlanComplete(currentPlan)) {
        currentPlan.updatedAt = Date.now();
        frozenPlanId = currentPlan.planId;
        stopTick();
      }
      if (listEl) {
        var items = listEl.querySelectorAll('.exec-plan-step');
        for (var i = 0; i < items.length; i++) {
          items[i].classList.toggle('active', items[i].dataset.stepId === data.nodeId);
        }
      }
      renderCurrentStep();
      renderFooter();
      notifyPetFoot();
    } catch (e) {
      safeWarn('updateGraphNode', e);
      teardownMounts();
    }
  }

  function highlightGraphBranch(_data) {
    try {
      recoverPanelAfterFatal();
      if (!listEl) return;
      var items = listEl.querySelectorAll('.exec-plan-step');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.add('exec-plan-step--fallback');
      }
    } catch (e) {
      safeWarn('highlightGraphBranch', e);
      teardownMounts();
    }
  }

  function markGraphComplete() {
    try {
      if (!currentPlan) return;
      recoverPanelAfterFatal();
      if (frozenPlanId && currentPlan.planId === frozenPlanId) return;
      currentPlan.progress = 100;
      if (typeof currentPlan.updatedAt !== 'number' || currentPlan.updatedAt < Date.now()) {
        currentPlan.updatedAt = Date.now();
      }
      frozenPlanId = currentPlan.planId;
      visible = !isPanelSuppressed();
      renderCurrentStep();
      renderTimeline();
      renderFooter();
      stopTick();
      applyVisibility();
      notifyPetFoot();
    } catch (e) {
      safeWarn('markGraphComplete', e);
      teardownMounts();
    }
  }

  bindPreferenceRefresh();

  return {
    setPlan: setPlan,
    applyPatch: applyPatch,
    clear: clear,
    resetExecutionMode: resetExecutionMode,
    setVisible: setVisible,
    setPageActive: setPageActive,
    setCapabilityEnabled: setCapabilityEnabled,
    getPlan: getPlan,
    isVisible: isVisible,
    isPlanLive: isPlanLive,
    isPlanComplete: isPlanComplete,
    formatFootSummary: formatFootSummary,
    formatExecutionModeChip: formatExecutionModeChip,
    getExecutionModeChip: getExecutionModeChip,
    getExecutionModeState: getExecutionModeState,
    applyExecutionModeEvent: applyExecutionModeEvent,
    isPanelSuppressed: isPanelSuppressed,
    requestExpandFromPet: requestExpandFromPet,
    // Phase 4 新增
    minimize: minimize,
    expand: expand,
    applyRuntimeStats: applyRuntimeStats,
    refreshPreferences: refreshPreferences,
    // Phase 5 新增：LLM 动作 + 时间轴 + Supervisor 投影
    pushSupervisorTimelineEvent: pushSupervisorTimelineEvent,
    applyToolActivity: applyToolActivity,
    // TaskGraph（兼容）
    renderGraph: renderGraph,
    updateGraphNode: updateGraphNode,
    highlightGraphBranch: highlightGraphBranch,
    markGraphComplete: markGraphComplete,
  };
})();
