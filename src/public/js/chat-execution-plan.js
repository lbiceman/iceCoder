/**
 * 执行透明层（ETL）— 右侧停靠侧边栏。
 *
 * Phase 4：由锚定冰豆的 popover 重构为聊天页右侧常驻 `<aside id="exec-transparency-panel">`。
 * 结构：头部（标题 + 最小化）→ Tab 条（执行流 / 状态快照）→ 执行流主体 → Footer（上下文/工具/时间）。
 * 显示门控读 EtlPrefs（`showTransparencyPanel`）；最小化收为宠物形态，双击宠物展开。
 *
 * Observer 红线：只消费事件、不影响事件；所有入口 try/catch，异常降级为空 UI，绝不 throw 冒泡。
 * 对外契约（setPlan/applyPatch/clear/... ）签名保持不变。
 */

/* exported ChatExecutionPlan */

window.ChatExecutionPlan = (function () {
  'use strict';

  var PANEL_ID = 'exec-transparency-panel';
  // Observer 必须同步、快速返回；异常大的计划不应把浏览器事件循环拖死。
  var MAX_RENDER_STEPS = 500;
  var MAX_TOOL_HISTORY = 100;
  var MAX_ROUND_HISTORY = 50;

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

  var TABS = [
    { id: 'flow', label: '执行流' },
    { id: 'snapshot', label: '状态快照' },
  ];

  // 移动端底部 sheet 仅保留「执行流」。
  var MOBILE_TABS = [
    { id: 'flow', label: '执行流' },
  ];

  var currentPlan = null;
  var frozenPlanId = null;
  var currentExecutionMode = null;
  var visible = false;
  var capabilityEnabled = true;
  var pageActive = true;
  var minimized = false;
  var activeTab = 'flow';

  var rootEl = null;
  var listEl = null;
  var modeBannerEl = null;
  var currentStepEl = null;
  var emptyStateEl = null;
  var footerEl = null;
  var llmActivityEl = null;
  var taskOverviewEl = null;
  var roundTimelineEl = null;
  var snapshotTimelineEl = null;
  var snapshotRestoreHandler = null;
  var snapshotCanRestoreFn = null;
  var snapshotFetchGeneration = 0;

  // 挂载模式与承载容器：桌面 = 右侧停靠 aside；移动 = 顶部条 + 底部 sheet（设计 §6）。
  var mountedMode = null;      // 'desktop' | 'mobile'
  var hostEl = null;          // 承载 tabs/panels/footer 的容器（桌面=rootEl，移动=mobileSheetEl）
  var mobileBarEl = null;      // 移动端顶部一行入口「执行 X/N ▸」
  var mobileSheetEl = null;    // 移动端底部 sheet
  var mobileBackdropEl = null; // 移动端 sheet 蒙层

  var tickTimer = null;
  var turnStartedAt = null;
  var turnEndedAt = null;
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
  // 本轮模型循环，只保存结构化执行信息；绝不保存 thinking/reasoning 正文。
  var roundRecords = [];
  var roundRecordByIteration = Object.create(null);
  var expandedRounds = Object.create(null);
  var bannerDetailOpen = false;
  var roundVisibleLimit = 20;
  var roundTimelineBound = false;
  var roundTimelineBoundEl = null;
  var roundTimelineClickHandler = null;
  var roundTimelineKeydownHandler = null;
  var cachedLoadMoreHidden = -1;
  var flowPersistTimer = null;
  var flowPersistHandler = null;

  function safeWarn(where, err) {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[ChatExecutionPlan] ' + where + ' 降级：', err);
      }
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

  function headerActionsHtml() {
    return '<button type="button" class="etl-minimize" title="最小化" aria-label="最小化面板">—</button>';
  }

  /** 状态快照 Tab：会话检查点时间轴（回滚复用 chat-page restore 流程）。 */
  function snapshotPanelHtml() {
    return '<section class="etl-tabpanel hidden" id="etl-panel-snapshot" data-panel="snapshot" role="tabpanel" aria-labelledby="etl-tab-snapshot">' +
      '<div class="etl-snapshot-timeline" id="etl-snapshot-timeline">' +
        '<div class="etl-empty etl-snapshot-loading">加载检查点…</div>' +
      '</div>' +
    '</section>';
  }

  /** 执行流 Tab 主体（轮次时间轴 + 隐藏的计划列表供 patch 增量更新）。 */
  function flowPanelHtml() {
    return '<section class="etl-tabpanel" id="etl-panel-flow" data-panel="flow" role="tabpanel" aria-labelledby="etl-tab-flow">' +
      '<div class="etl-round-timeline" id="etl-round-timeline">' +
        '<div class="etl-round-empty etl-empty">等待模型开始执行</div>' +
        '<div class="etl-round-prefix-hint hidden" id="etl-round-prefix-hint" role="note"></div>' +
        '<button type="button" class="etl-round-load-more hidden" id="etl-round-load-more">加载更早的轮次 ↓</button>' +
        '<ol class="etl-round-list"></ol>' +
      '</div>' +
      '<div class="etl-current-step hidden" id="etl-current-step"></div>' +
      '<div class="etl-empty etl-plan-empty hidden">本次任务无结构化执行计划</div>' +
      '<ol class="exec-plan-list" id="exec-plan-list"></ol>' +
      '<div class="etl-llm-activity hidden" id="etl-llm-activity" aria-live="polite"></div>' +
    '</section>';
  }

  function sharedBodyHtml() {
    return '<div class="etl-task-overview hidden" id="etl-task-overview"></div>' +
      '<nav class="etl-tabs" role="tablist">' + buildTabsHtml(TABS) + '</nav>' +
      '<div class="etl-body">' +
        flowPanelHtml() +
        snapshotPanelHtml() +
      '</div>';
  }

  /** 从 host 抓取渲染所需元素引用（模块级变量，后续渲染均以此为准）。 */
  function grabHostRefs(host) {
    listEl = host.querySelector('#exec-plan-list');
    modeBannerEl = host.querySelector('#exec-plan-mode-banner');
    currentStepEl = host.querySelector('#etl-current-step');
    emptyStateEl = host.querySelector('.etl-plan-empty');
    footerEl = host.querySelector('#etl-footer');
    llmActivityEl = host.querySelector('#etl-llm-activity');
    taskOverviewEl = host.querySelector('#etl-task-overview');
    roundTimelineEl = host.querySelector('#etl-round-timeline');
    snapshotTimelineEl = host.querySelector('#etl-snapshot-timeline');
    bindRoundTimelineEvents();
    if (window.EtlShellDock && typeof window.EtlShellDock.mount === 'function') {
      var dockHost = host.querySelector('#etl-shell-dock-host');
      if (dockHost) window.EtlShellDock.mount(dockHost);
      if (window.ChatPage && typeof window.ChatPage.syncShellDockOnMount === 'function') {
        window.ChatPage.syncShellDockOnMount();
      }
    }
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
    taskOverviewEl = null;
    roundTimelineEl = null;
    snapshotTimelineEl = null;
    unbindRoundTimelineEvents();
    mountedMode = null;
    if (window.EtlShellDock && typeof window.EtlShellDock.resetMount === 'function') {
      window.EtlShellDock.resetMount();
    }
  }

  function mountDesktop() {
    rootEl = document.createElement('aside');
    rootEl.id = PANEL_ID;
    rootEl.className = 'etl-panel';
    rootEl.setAttribute('role', 'complementary');
    rootEl.setAttribute('aria-label', 'iceCoder工作台');
    rootEl.setAttribute('aria-hidden', 'true');

    rootEl.innerHTML =
      '<header class="etl-header">' +
        '<span class="etl-title">iceCoder工作台</span>' +
        headerActionsHtml() +
      '</header>' +
      '<div class="etl-main-scroll">' +
        '<div class="exec-plan-mode-banner hidden" id="exec-plan-mode-banner"></div>' +
        sharedBodyHtml() +
      '</div>' +
      '<div class="etl-shell-dock-host" id="etl-shell-dock-host"></div>' +
      '<footer class="etl-footer" id="etl-footer"></footer>';

    document.body.appendChild(rootEl);
    hostEl = rootEl;
    mountedMode = 'desktop';
    grabHostRefs(rootEl);
    bindHostControls(rootEl);
  }

  /** 移动端：顶部一行入口 + 底部 sheet（仅执行流 Tab；设计 §6）。 */
  function mountMobile() {
    // 移动端仅有 flow Tab；若 activeTab 落在桌面独有 Tab 上则回落到 flow。
    if (activeTab !== 'flow') {
      activeTab = 'flow';
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
    mobileSheetEl.setAttribute('aria-label', 'iceCoder工作台');
    mobileSheetEl.setAttribute('aria-hidden', 'true');
    mobileSheetEl.innerHTML =
      '<div class="etl-msheet-handle" aria-hidden="true"></div>' +
      '<header class="etl-header">' +
        '<span class="etl-title">iceCoder工作台</span>' +
        headerActionsHtml() +
      '</header>' +
      '<div class="etl-main-scroll">' +
        '<div class="exec-plan-mode-banner hidden" id="exec-plan-mode-banner"></div>' +
        '<div class="etl-task-overview hidden" id="etl-task-overview"></div>' +
        '<nav class="etl-tabs" role="tablist">' + buildTabsHtml(MOBILE_TABS) + '</nav>' +
        '<div class="etl-body">' +
          flowPanelHtml() +
        '</div>' +
      '</div>' +
      '<div class="etl-shell-dock-host" id="etl-shell-dock-host"></div>' +
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
      if (tabId === 'snapshot') refreshSnapshotTimeline();
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
      if (shouldShow()) {
        ensureMounted();
        applyPanelWidth();
        layoutTop();
      }
      if (shouldShow() && !minimized) {
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
    if (tickTimer || (isPlanComplete(currentPlan) && turnStartedAt === null)) return;
    tickTimer = setInterval(function () {
      try {
        if (!isShowing()) {
          stopTick();
          return;
        }
        updateLiveTimes();
        if (isPlanComplete(currentPlan) && !hasRunningStep() && turnEndedAt !== null) {
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
    if (roundTimelineEl) {
      for (var rr = 0; rr < roundRecords.length; rr++) {
        var roundNode = roundTimelineEl.querySelector(
          '.etl-round-node[data-iteration="' + roundRecords[rr].iteration + '"]',
        );
        var roundTime = roundNode && roundNode.querySelector('.etl-round-duration');
        if (roundTime) roundTime.textContent = roundDuration(roundRecords[rr]);
      }
    }
    // Footer 总时间
    var timeElFoot = footerEl && footerEl.querySelector('.etl-foot-time b');
    if (timeElFoot) timeElFoot.textContent = formatTurnElapsed();
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
  }

  function renderEmptyState() {
    if (!emptyStateEl) return;
    emptyStateEl.classList.toggle('hidden', !!currentPlan || roundRecords.length > 0);
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

  /** 右下角时间：本轮用户发送 → model_done 的本地模型工作耗时。 */
  function formatTurnElapsed() {
    if (typeof turnStartedAt !== 'number') return '00:00';
    var end = typeof turnEndedAt === 'number' ? turnEndedAt : Date.now();
    return formatClock(Math.max(0, end - turnStartedAt));
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

  function ensureFooterSkeleton() {
    if (!footerEl || footerEl.querySelector('.etl-foot-token')) return;
    footerEl.innerHTML = '';
    footerEl.appendChild(makeFootItem('etl-foot-token', '上下文', '—'));
    footerEl.appendChild(makeFootItem('etl-foot-tool', '工具', '—'));
    footerEl.appendChild(makeFootItem('etl-foot-time', '时间', '00:00'));
  }

  function renderFooter() {
    if (!footerEl) return;
    ensureFooterSkeleton();
    var tokenTxt = formatTokenStat();
    var liveToolCount = authoritativeToolCalls === null
      ? uniqueToolCallCount
      : authoritativeToolCalls + Math.max(0, uniqueToolCallCount - calibratedUniqueToolCount);
    var toolTxt = liveToolCount > 0 || authoritativeToolCalls !== null ? String(liveToolCount) : '—';
    var timeTxt = formatTurnElapsed();
    var tokenEl = footerEl.querySelector('.etl-foot-token b');
    var toolEl = footerEl.querySelector('.etl-foot-tool b');
    var timeEl = footerEl.querySelector('.etl-foot-time b');
    if (tokenEl) tokenEl.textContent = tokenTxt;
    if (toolEl) toolEl.textContent = toolTxt;
    if (timeEl) timeEl.textContent = timeTxt;
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

  // ── 监管横幅 ──

  function formatSupervisionReason(modeState) {
    if (!modeState) return '—';
    var primary = modeState.enteredByPrimary || (modeState.enteredBy && modeState.enteredBy[0]);
    if (primary) return MODE_SIGNAL_LABELS[primary] || primary;
    return modeState.primaryReasonHuman || '监管接管';
  }

  function renderExecutionModeBanner() {
    if (!modeBannerEl) return;
    if (!currentExecutionMode || currentExecutionMode.executionMode !== 'forced') {
      modeBannerEl.classList.add('hidden');
      modeBannerEl.innerHTML = '';
      bannerDetailOpen = false;
      return;
    }
    var reasonLabel = formatSupervisionReason(currentExecutionMode);
    var roundNo = typeof currentExecutionMode.round === 'number'
      ? currentExecutionMode.round
      : (roundRecords.length ? roundRecords[roundRecords.length - 1].iteration : null);
    var headline = '已进入监管模式（' + reasonLabel + (roundNo ? '，第 ' + roundNo + ' 轮' : '') + '）';

    var detailLines = [];
    if (currentExecutionMode.enteredBy && currentExecutionMode.enteredBy.length) {
      var tags = currentExecutionMode.enteredBy.map(function (sig) {
        return MODE_SIGNAL_LABELS[sig] || sig;
      });
      detailLines.push('信号：' + tags.join(' + '));
    }
    if (currentExecutionMode.degradedTier) {
      detailLines.push('降级：' + (DEGRADED_LABELS[currentExecutionMode.degradedTier]
        || currentExecutionMode.degradedTier));
    }
    if (currentExecutionMode.primaryReasonHuman) {
      detailLines.push('原因：' + currentExecutionMode.primaryReasonHuman);
    }

    modeBannerEl.innerHTML = '';
    var main = document.createElement('div');
    main.className = 'etl-banner-main';
    var icon = document.createElement('span');
    icon.className = 'etl-banner-icon';
    icon.textContent = '⚠';
    var text = document.createElement('span');
    text.className = 'etl-banner-text';
    text.textContent = headline;
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'etl-banner-toggle';
    toggle.textContent = (bannerDetailOpen ? '收起详情 ▴' : '查看详情 ▾');
    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      bannerDetailOpen = !bannerDetailOpen;
      renderExecutionModeBanner();
    });
    main.appendChild(icon);
    main.appendChild(text);
    if (detailLines.length) main.appendChild(toggle);
    modeBannerEl.appendChild(main);

    if (detailLines.length) {
      var detail = document.createElement('div');
      detail.className = 'etl-banner-detail' + (bannerDetailOpen ? '' : ' hidden');
      detail.textContent = detailLines.join('\n');
      modeBannerEl.appendChild(detail);
    }
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
      if (!currentPlan || isPlanComplete(currentPlan)) {
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
      var label = llmActivityEl.querySelector('.etl-llm-label');
      var text = llmActivityEl.querySelector('.etl-llm-text');
      if (!label || !text) {
        llmActivityEl.textContent = '';
        label = document.createElement('div');
        label.className = 'etl-llm-label';
        label.textContent = 'LLM 当前动作';
        text = document.createElement('div');
        text.className = 'etl-llm-text';
        llmActivityEl.appendChild(label);
        llmActivityEl.appendChild(text);
      }
      if (text.textContent !== phrase) text.textContent = phrase;
      llmActivityEl.classList.remove('hidden');
    } catch (e) {
      safeWarn('renderLlmActivity', e);
      try {
        llmActivityEl.classList.add('hidden');
        llmActivityEl.textContent = '';
      } catch (_e) { /* ignore */ }
    }
  }

  // ── 工具执行辅助（供执行流轮次时间轴与 Footer/时间轴消费）──

  function toolStatusClass(status) {
    if (status === 'done' || status === 'success') return 'done';
    if (status === 'failed' || status === 'error') return 'failed';
    if (status === 'warn') return 'warn';
    return 'running';
  }

  function formatToolDuration(record) {
    if (!record || typeof record.callTs !== 'number') return '';
    var end = typeof record.resultTs === 'number' ? record.resultTs : Date.now();
    var ms = Math.max(0, end - record.callTs);
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return formatClock(ms);
  }

  function formatSearchToolPreview(toolName, args) {
    if (!args || typeof args !== 'object') return '';
    var pattern = args.pattern || args.glob || args.query || '';
    var scope = args.path || args.directory || '';
    if (pattern && scope) return clamp40(String(pattern) + ' · ' + String(scope));
    return clamp40(String(pattern || scope || ''));
  }

  function formatToolArgsPreview(toolName, args) {
    try {
      if (toolName === 'glob' || toolName === 'grep') {
        var searchPreview = formatSearchToolPreview(toolName, args);
        if (searchPreview) return searchPreview;
      }
      if (window.ToolTraceFormat
        && typeof window.ToolTraceFormat.formatToolArgsDetailPreview === 'function') {
        var formatted = window.ToolTraceFormat.formatToolArgsDetailPreview(toolName, args);
        if (formatted) return clamp40(formatted);
      }
      if (!args || typeof args !== 'object') return '';
      var common = args.path || args.file || args.command || args.query
        || args.pattern || args.url || args.description;
      if (common) return clamp40(common);
      return clamp40(JSON.stringify(args));
    } catch (_e) {
      return '';
    }
  }

  // 工具名 → 归类；供执行流轮次推导「本轮做了什么/为什么」。
  var CONTEXT_READ_TOOLS = {
    read_file: true, file_info: true, notebook_read: true,
    parse_document: true, parse_pptx_deep: true, parse_doc_legacy: true,
    parse_xmind_deep: true, parse_xlsx_deep: true, open_file: true,
    read_image: true, image_read: true, xmind_parse: true, xlsx_parse: true,
    browse_directory: true, list_drives: true, diff_files: true,
  };
  var CONTEXT_WRITE_TOOLS = {
    write_file: true, append_file: true, edit_file: true,
    patch_file: true, batch_edit_file: true, fs_operation: true,
    apply_patch: true, undo_edit: true, create_file: true, multi_edit: true,
  };
  var CONTEXT_SEARCH_TOOLS = { glob: true, grep: true };

  function extractToolTarget(toolName, args) {
    try {
      if (!args || typeof args !== 'object') return '';
      if (toolName === 'run_command') return String(args.command || '');
      if (CONTEXT_SEARCH_TOOLS[toolName]) {
        var pattern = args.pattern || args.glob || args.query || '';
        var scope = args.path || args.directory || '';
        if (pattern && scope) return String(pattern) + ' · ' + String(scope);
        return String(pattern || scope || '');
      }
      var pathVal = args.path || args.file || args.filePath || args.filename;
      if (pathVal) return String(pathVal);
      return '';
    } catch (_e) {
      return '';
    }
  }

  function targetHint(tool) {
    var t = tool.target || tool.detail || '';
    return t ? '「' + clamp24(t) + '」' : '';
  }

  function inferCommandIntent(tool) {
    var detail = tool.detail || tool.target || '';
    if (!detail) return '执行命令验证或推进任务';
    var cmd = String(detail).trim();
    if (cmd.indexOf('check ') === 0) {
      return '检查后台任务' + (cmd.length > 6 ? ' ' + clamp24(cmd.slice(6)) : '');
    }
    if (cmd.indexOf('stop ') === 0) return '停止后台任务';
    if (cmd === 'list background tasks') return '查看后台任务列表';
    if (/^(npm|pnpm|yarn|bun)\s+(test|t\b|run\s+test)/.test(cmd)) return '运行测试验证改动';
    if (/^(vitest|jest|playwright|cypress)\b/.test(cmd)) return '运行测试验证改动';
    if (/^(npm|pnpm|yarn|bun)\s+run\s+(build|dev|start|serve|preview|watch)/.test(cmd)) {
      return '启动或构建项目';
    }
    if (/^(npm|pnpm|yarn|bun)\s+install/.test(cmd)) return '安装项目依赖';
    if (/^git\s+(status|diff|log|show)\b/.test(cmd)) return '查看 Git 变更与历史';
    if (/^git\s+(add|commit|checkout|branch|merge|pull|push)\b/.test(cmd)) return '执行 Git 操作';
    if (/^(ls|dir|pwd|cat|head|tail|find|tree)\b/.test(cmd)) return '查看目录或文件内容';
    if (/^(python|node|tsx?|deno|bun)\s/.test(cmd)) return '运行脚本验证逻辑';
    return '执行命令 ' + clamp24(cmd);
  }

  function inferFsOperationIntent(tool) {
    var detail = String(tool.detail || tool.target || '').toLowerCase();
    if (/\bdelete\b/.test(detail)) return '删除文件或目录' + targetHint(tool);
    if (/\b(mkdir|create_dir)\b/.test(detail)) return '创建目录' + targetHint(tool);
    if (/\b(move|rename)\b/.test(detail)) return '移动或重命名' + targetHint(tool);
    if (/\bcopy\b/.test(detail)) return '复制文件' + targetHint(tool);
    return '执行文件系统操作' + targetHint(tool);
  }

  function inferMcpToolIntent(toolName) {
    if (toolName.indexOf('mcp_') !== 0) return '';
    var parts = toolName.slice(4).split('_');
    if (parts.length >= 2) {
      return '调用 MCP 工具 ' + parts[0] + '/' + parts.slice(1).join('_');
    }
    return '调用 MCP 扩展工具';
  }

  function inferToolIntent(tool) {
    var name = tool.toolName || '';
    var hint = targetHint(tool);
    if (name === 'read_file') return '读取' + hint + '了解代码与上下文';
    if (name === 'file_info') return '查看文件元信息' + hint;
    if (name === 'notebook_read') return '读取 Notebook' + hint;
    if (name === 'open_file') return '打开' + hint + '查看内容';
    if (name === 'read_image' || name === 'image_read') return '读取图片' + hint;
    if (name === 'parse_document' || name === 'parse_doc_legacy') return '解析文档' + hint + '提取内容';
    if (name === 'parse_pptx_deep') return '深度解析 PPT' + hint;
    if (name === 'parse_xmind_deep' || name === 'xmind_parse') return '解析思维导图' + hint;
    if (name === 'parse_xlsx_deep' || name === 'xlsx_parse') return '解析表格' + hint;
    if (name === 'diff_files') return '对比文件差异' + hint;
    if (name === 'browse_directory' || name === 'list_drives') return '浏览目录结构' + hint;
    if (name === 'grep') return '搜索代码' + (hint || '中的关键词');
    if (name === 'glob') return '查找匹配' + (hint || '模式的文件');
    if (name === 'write_file' || name === 'create_file') return '写入或创建文件' + hint;
    if (name === 'edit_file' || name === 'patch_file' || name === 'apply_patch') return '修改文件' + hint;
    if (name === 'append_file') return '追加内容到' + hint;
    if (name === 'batch_edit_file' || name === 'multi_edit') return '批量修改多个文件';
    if (name === 'fs_operation') return inferFsOperationIntent(tool);
    if (name === 'undo_edit') return '撤销上一次编辑';
    if (name === 'run_command') return inferCommandIntent(tool);
    if (name === 'fetch_url' || name === 'web_search') return '联网查询外部信息' + hint;
    if (name === 'git') return '执行 Git 操作' + hint;
    if (name === 'env_info') return '获取运行环境信息';
    var mcpIntent = inferMcpToolIntent(name);
    if (mcpIntent) return mcpIntent + hint;
    if (CONTEXT_READ_TOOLS[name]) return '读取资源' + hint;
    if (CONTEXT_SEARCH_TOOLS[name]) return '搜索项目' + hint;
    if (CONTEXT_WRITE_TOOLS[name]) return '更新文件' + hint;
    return (name ? '调用 ' + humanizeToolName(name) : '调用工具') + hint;
  }

  /** 工具行副标题：仅在 intent 未覆盖时展示路径/命令等细节。 */
  function toolActionDetailLine(tool) {
    var detail = tool.detail || tool.target || '';
    if (!detail) return '';
    var intent = inferToolIntent(tool);
    var short = clamp24(detail);
    if (short && intent.indexOf(short) >= 0) return '';
    return detail;
  }

  function findFirstToolBy(tools, predicate) {
    for (var i = 0; i < tools.length; i++) {
      if (predicate(tools[i])) return tools[i];
    }
    return null;
  }

  function summarizeToolIntents(tools) {
    var counts = { read: 0, search: 0, write: 0, command: 0, other: 0 };
    for (var i = 0; i < tools.length; i++) {
      var name = tools[i].toolName;
      if (CONTEXT_READ_TOOLS[name]) counts.read++;
      else if (CONTEXT_SEARCH_TOOLS[name]) counts.search++;
      else if (CONTEXT_WRITE_TOOLS[name]) counts.write++;
      else if (name === 'run_command') counts.command++;
      else counts.other++;
    }
    var parts = [];
    if (counts.write) {
      parts.push(counts.write === 1
        ? inferToolIntent(findFirstToolBy(tools, function (t) { return CONTEXT_WRITE_TOOLS[t.toolName]; }))
        : '修改 ' + counts.write + ' 处文件落实改动');
    }
    if (counts.command) {
      parts.push(counts.command === 1
        ? inferToolIntent(findFirstToolBy(tools, function (t) { return t.toolName === 'run_command'; }))
        : '执行 ' + counts.command + ' 条命令验证或推进任务');
    }
    if (counts.read) {
      parts.push(counts.read === 1
        ? inferToolIntent(findFirstToolBy(tools, function (t) { return CONTEXT_READ_TOOLS[t.toolName]; }))
        : '读取 ' + counts.read + ' 个文件收集上下文');
    }
    if (counts.search) {
      parts.push(counts.search === 1
        ? inferToolIntent(findFirstToolBy(tools, function (t) { return CONTEXT_SEARCH_TOOLS[t.toolName]; }))
        : '搜索 ' + counts.search + ' 次定位相关代码');
    }
    if (counts.other) parts.push('调用其他工具推进任务');
    return parts;
  }

  function deriveRoundToolIntents(tools) {
    if (!tools.length) return ['理解用户目标并规划下一步执行'];
    if (tools.length > 3) return summarizeToolIntents(tools);
    var intents = [];
    var seen = Object.create(null);
    for (var i = 0; i < tools.length; i++) {
      var intent = inferToolIntent(tools[i]);
      if (intent && !seen[intent]) {
        seen[intent] = true;
        intents.push(intent);
      }
    }
    return intents.length ? intents : ['理解用户目标并规划下一步执行'];
  }

  // ── 渲染：按模型轮次的执行流 ──

  var PHASE_LABELS = {
    intent: '理解目标',
    context: '收集上下文',
    editing: '实施修改',
    verification: '验证结果',
    final: '整理结论',
  };

  function normalizeRoundIteration(iteration) {
    if (typeof iteration === 'number' && isFinite(iteration) && iteration > 0) {
      return Math.floor(iteration);
    }
    if (roundRecords.length) return roundRecords[roundRecords.length - 1].iteration;
    return 1;
  }

  function snapshotRoundPlan(record) {
    if (!record || record.activeTitle) return;
    var active = pickActiveStep(currentPlan);
    if (active) {
      record.activeTitle = active.title || '';
      record.phase = active.phase || '';
    } else if (currentPlan) {
      record.phase = currentPlan.phase || '';
    }
  }

  function ensureRoundRecord(iteration, ts) {
    var normalized = normalizeRoundIteration(iteration);
    var key = String(normalized);
    var record = roundRecordByIteration[key];
    var created = false;
    if (!record) {
      created = true;
      var inferredStart = typeof ts === 'number' ? ts : Date.now();
      if (normalized === 1 && typeof turnStartedAt === 'number') {
        inferredStart = turnStartedAt;
      } else {
        for (var previousIndex = 0; previousIndex < roundRecords.length; previousIndex++) {
          var previousRecord = roundRecords[previousIndex];
          if (previousRecord.iteration < normalized && typeof previousRecord.endTs === 'number') {
            inferredStart = previousRecord.endTs;
          }
        }
      }
      record = {
        iteration: normalized,
        startTs: inferredStart,
        endTs: null,
        status: 'running',
        toolCallIds: [],
        signals: [],
        branchReasons: [],
        stopReason: '',
        activeTitle: '',
        phase: '',
      };
      snapshotRoundPlan(record);
      roundRecords.push(record);
      roundRecords.sort(function (a, b) { return a.iteration - b.iteration; });
      roundRecordByIteration[key] = record;
      if (roundRecords.length > MAX_ROUND_HISTORY) {
        var removed = roundRecords.shift();
        if (removed) delete roundRecordByIteration[String(removed.iteration)];
      }
    } else if (typeof ts === 'number' && ts < record.startTs) {
      record.startTs = ts;
    }
    snapshotRoundPlan(record);
    return { record: record, created: created };
  }

  function addUniqueStrings(target, values) {
    if (!Array.isArray(values)) return;
    for (var i = 0; i < values.length; i++) {
      if (target.indexOf(values[i]) < 0) target.push(values[i]);
    }
  }

  function applyRoundActivity(evt) {
    try {
      if (!evt || !evt.type) return;
      var ts = typeof evt.ts === 'number' ? evt.ts : Date.now();
      var roundResult = ensureRoundRecord(evt.iteration, ts);
      var record = roundResult.record;
      if (evt.type === 'model_round_end' || evt.type === 'model_task_final') {
        record.endTs = ts;
        record.status = 'done';
        if (evt.stopReason) record.stopReason = String(evt.stopReason);
      }
      if (evt.type === 'model_task_final') {
        // 最终轮：标记任务完成，供轮次卡展示「已完成」结果。
        record.isFinal = true;
        markRoundsComplete(record.iteration);
        if (evt.stopReason === 'model_done') endTurnTimer(ts);
      }
      if (evt.executionMode) {
        addUniqueStrings(record.signals, evt.executionMode.enteredBy || []);
        if (evt.executionMode.primaryReasonHuman && !record.reasonHuman) {
          record.reasonHuman = evt.executionMode.primaryReasonHuman;
        }
      }
      if (evt.reason || evt.message) {
        var branchReason = String(evt.message || evt.reason);
        if (record.branchReasons.indexOf(branchReason) < 0) {
          record.branchReasons.push(branchReason);
        }
      }
      syncRoundTimeline({ iteration: record.iteration, insert: roundResult.created });
      renderEmptyState();
      if (typeof turnStartedAt === 'number' && turnEndedAt === null) startTick();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('applyRoundActivity', e);
    }
  }

  function getRoundTools(record) {
    var out = [];
    for (var i = 0; i < record.toolCallIds.length; i++) {
      var tool = toolRecordById[record.toolCallIds[i]];
      if (tool) out.push(tool);
    }
    return out;
  }

  function roundDuration(record) {
    var end = typeof record.endTs === 'number' ? record.endTs : Date.now();
    var tools = getRoundTools(record);
    for (var i = 0; i < tools.length; i++) {
      if (typeof tools[i].resultTs === 'number' && tools[i].resultTs > end) end = tools[i].resultTs;
    }
    var ms = Math.max(0, end - record.startTs);
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return formatClock(ms);
  }

  function previousRoundFailed(record) {
    var previous = null;
    for (var i = 0; i < roundRecords.length; i++) {
      if (roundRecords[i].iteration < record.iteration) previous = roundRecords[i];
    }
    if (!previous) return false;
    var tools = getRoundTools(previous);
    for (var j = 0; j < tools.length; j++) {
      if (toolStatusClass(tools[j].status) === 'failed') return true;
    }
    return false;
  }

  /** 任务完成时把仍在运行的历史轮统一收尾，避免遗留“进行中”状态。 */
  function markRoundsComplete(finalIteration) {
    for (var i = 0; i < roundRecords.length; i++) {
      var record = roundRecords[i];
      if (record.iteration <= finalIteration && record.status !== 'done') {
        record.status = 'done';
        if (typeof record.endTs !== 'number') record.endTs = Date.now();
      }
    }
  }

  var STOP_REASON_LABELS = {
    model_done: '模型已完成本次任务',
    stop_hook: '任务在收尾校验后完成',
    max_output_tokens: '输出达到上限后结束',
    verification_exhausted: '验证轮次用尽后结束',
    circuit_breaker: '触发熔断保护后结束',
    error: '执行出现错误后结束',
  };

  function roundCompletionText(record) {
    if (record.stopReason && STOP_REASON_LABELS[record.stopReason]) {
      return '✅ ' + STOP_REASON_LABELS[record.stopReason];
    }
    return '✅ 已完成本次任务';
  }

  function deriveRoundReason(record) {
    if (record.isFinal) {
      return '模型判断目标已达成，结束本次执行';
    }
    var parts = [];
    if (record.signals.length) {
      var labels = record.signals.map(function (signal) {
        return MODE_SIGNAL_LABELS[signal] || signal;
      });
      parts.push('监管信号：' + labels.join('、'));
    }
    if (record.branchReasons.length) {
      parts.push('执行路径调整：' + clamp40(record.branchReasons[record.branchReasons.length - 1]));
    }
    if (previousRoundFailed(record)) {
      parts.push('上一轮工具执行失败，需要调整策略并继续验证');
    }
    if (record.activeTitle) {
      parts.push('为完成计划步骤「' + clamp40(record.activeTitle) + '」');
    } else {
      var toolIntents = deriveRoundToolIntents(getRoundTools(record));
      for (var ti = 0; ti < toolIntents.length; ti++) parts.push(toolIntents[ti]);
    }
    return parts.join('；');
  }

  function estimateRemainingSeconds(plan) {
    if (!plan || !plan.steps || !plan.steps.length || isPlanComplete(plan)) return null;
    var remaining = 0;
    var samples = 0;
    var totalSampleMs = 0;
    for (var i = 0; i < plan.steps.length; i++) {
      var step = plan.steps[i];
      if (step.status === 'done' || step.status === 'failed' || step.status === 'skipped') {
        if (typeof step.startedAt === 'number' && typeof step.endedAt === 'number') {
          totalSampleMs += Math.max(0, step.endedAt - step.startedAt);
          samples++;
        }
      } else {
        remaining++;
      }
    }
    if (!remaining) return 0;
    var avg = samples ? totalSampleMs / samples : 8000;
    return Math.max(1, Math.round((avg * remaining) / 1000));
  }

  function roundVisualStatus(record) {
    if (record.isFinal && record.status === 'done') return 'done';
    var tools = getRoundTools(record);
    for (var i = 0; i < tools.length; i++) {
      if (toolStatusClass(tools[i].status) === 'failed') return 'failed';
    }
    if (record.status === 'done') return 'done';
    return 'running';
  }

  function roundStatusLabel(status) {
    if (status === 'failed') return '失败';
    if (status === 'done') return '完成';
    return '进行中';
  }

  function humanizeToolName(toolName) {
    if (!toolName) return 'Tool';
    if (toolName === 'run_command') return 'Run Command';
    if (toolName === 'read_file') return 'Read File';
    if (toolName === 'write_file' || toolName === 'edit_file') return 'Edit File';
    if (toolName === 'grep') return 'Grep';
    if (toolName === 'glob') return 'Glob';
    return toolName.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function deriveRoundTitle(record) {
    if (record.isFinal) return '整理结论';
    var tools = getRoundTools(record);
    if (!tools.length) {
      return record.activeTitle || '分析目标并规划下一步';
    }
    var command = findFirstToolBy(tools, function (t) { return t.toolName === 'run_command'; });
    if (command) {
      var cmd = command.detail || command.target || '';
      if (/test|vitest|jest|playwright|cypress/i.test(cmd)) return 'Run Integration Test';
      return inferCommandIntent(command);
    }
    var reads = tools.filter(function (t) { return CONTEXT_READ_TOOLS[t.toolName]; });
    if (reads.length >= 2) return '读取核心文件理解实现';
    if (reads.length === 1) return '读取文件了解上下文';
    var writes = tools.filter(function (t) { return CONTEXT_WRITE_TOOLS[t.toolName]; });
    if (writes.length) return writes.length > 1 ? '批量修改文件' : '修改文件落实改动';
    var searches = tools.filter(function (t) { return CONTEXT_SEARCH_TOOLS[t.toolName]; });
    if (searches.length >= 2) return '搜索定位相关代码';
    if (searches.length === 1) return inferToolIntent(searches[0]);
    if (tools.length === 1) return inferToolIntent(tools[0]);
    if (record.activeTitle) return clamp40(record.activeTitle);
    if (record.phase && PHASE_LABELS[record.phase]) return PHASE_LABELS[record.phase];
    return '第 ' + record.iteration + ' 轮执行';
  }

  function buildAllRoundPills(tools) {
    var pills = [];
    var grouped = Object.create(null);
    for (var i = 0; i < tools.length; i++) {
      var tool = tools[i];
      var key = tool.toolName + '|' + (tool.detail || tool.target || '');
      if (!grouped[key]) {
        grouped[key] = { tool: tool, count: 0 };
      }
      grouped[key].count++;
    }
    var keys = Object.keys(grouped);
    for (var k = 0; k < keys.length; k++) {
      var entry = grouped[keys[k]];
      var label = inferToolIntent(entry.tool);
      if (entry.count > 1) label += ' x ' + entry.count;
      pills.push({
        label: label,
        raw: entry.tool.toolName + (entry.tool.detail ? ' · ' + entry.tool.detail : ''),
      });
    }
    return pills;
  }

  /** 折叠态：任意工具类型均只展示首个 +「...」。 */
  function buildCollapsedRoundPill(tools) {
    if (!tools.length) return [];
    var firstTool = tools[0];
    var label = inferToolIntent(firstTool);
    var path = firstTool.detail || firstTool.target || '';
    if (tools.length === 1) {
      return [{
        label: label,
        raw: firstTool.toolName + (path ? ' · ' + path : ''),
      }];
    }
    return [{
      label: label + '...',
      raw: firstTool.toolName + (path ? ' · ' + path : ''),
      title: '共 ' + tools.length + ' 项',
    }];
  }

  /** 折叠态合并为一条；展开态展示全部 pill。 */
  function buildRoundPills(tools, collapsed) {
    if (!collapsed) return buildAllRoundPills(tools);
    return buildCollapsedRoundPill(tools);
  }

  function roundPillSignature(tools, collapsed) {
    if (!tools.length) return '0';
    if (collapsed) {
      var first = tools[0];
      return 'c:' + first.toolCallId + ':' + tools.length;
    }
    return 'e:' + tools.map(function (tool) { return tool.toolCallId; }).join(',');
  }

  function shouldRebuildRoundPills(roundNode, record) {
    var tools = getRoundTools(record);
    var collapsed = !isRoundExpanded(record);
    var wrap = roundNode.querySelector('.etl-round-pills');
    if (!tools.length) return !!wrap;
    if (!wrap) return true;
    var nextSig = roundPillSignature(tools, collapsed);
    return wrap.dataset.pillSig !== nextSig;
  }

  function renderRoundPills(summary, tools, record) {
    if (!summary) return;
    var collapsed = !isRoundExpanded(record);
    var pills = buildRoundPills(tools, collapsed);
    if (!pills.length) return;
    var nextSig = roundPillSignature(tools, collapsed);
    var wrap = summary.querySelector('.etl-round-pills');
    if (wrap && wrap.dataset.pillSig === nextSig) return;
    if (wrap) wrap.parentNode.removeChild(wrap);
    var pillWrap = document.createElement('div');
    pillWrap.className = 'etl-round-pills' + (collapsed ? ' etl-round-pills--folded' : '');
    pillWrap.dataset.pillSig = nextSig;
    for (var p = 0; p < pills.length; p++) {
      var pill = document.createElement('span');
      pill.className = 'etl-round-pill';
      pill.textContent = pills[p].label;
      pill.title = pills[p].title || pills[p].raw || '';
      pillWrap.appendChild(pill);
    }
    summary.appendChild(pillWrap);
  }

  /** 按当前展开态刷新所有可见轮次的摘要 pill（避免旧轮次残留多条工具标签）。 */
  function refreshVisibleRoundPillSummaries() {
    if (!roundTimelineEl) return;
    try {
      var nodes = roundTimelineEl.querySelectorAll('.etl-round-node');
      Array.prototype.forEach.call(nodes, function (node) {
        var iter = node.dataset.iteration;
        if (!iter) return;
        var record = roundRecordByIteration[iter];
        if (!record) return;
        var expanded = isRoundExpanded(record);
        node.classList.toggle('is-expanded', expanded);
        if (record.isFinal) node.classList.add('is-final');
        var row = node.querySelector('.etl-round-row');
        if (row) row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        var toggle = node.querySelector('.etl-round-toggle');
        if (toggle) {
          toggle.textContent = expanded ? '▴' : '▾';
          toggle.setAttribute('aria-label', expanded ? '收起轮次详情' : '展开轮次详情');
        }
        rebuildRoundPillsInNode(node, record);
      });
    } catch (e) {
      safeWarn('refreshVisibleRoundPillSummaries', e);
    }
  }

  function makeRoundActionRow(tool) {
    var status = toolStatusClass(tool.status);
    var row = document.createElement('li');
    row.className = 'etl-round-action etl-round-tool status-' + status;
    row.dataset.toolCallId = tool.toolCallId;
    row.dataset.status = tool.status;
    if (typeof tool.callTs === 'number') row.dataset.callTs = String(tool.callTs);
    if (typeof tool.resultTs === 'number') row.dataset.resultTs = String(tool.resultTs);
    var icon = document.createElement('span');
    icon.className = 'etl-round-action-icon etl-round-tool-icon';
    icon.textContent = status === 'failed' ? '×' : '✓';
    var body = document.createElement('div');
    body.style.minWidth = '0';
    var name = document.createElement('div');
    name.className = 'etl-round-action-name';
    name.textContent = inferToolIntent(tool);
    name.title = humanizeToolName(tool.toolName);
    body.appendChild(name);
    var detailLine = toolActionDetailLine(tool);
    if (detailLine) {
      var path = document.createElement('div');
      path.className = 'etl-round-action-target';
      path.textContent = detailLine;
      body.appendChild(path);
    }
    var dur = document.createElement('span');
    dur.className = 'etl-round-action-dur etl-round-tool-duration';
    dur.textContent = formatToolDuration(tool);
    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(dur);
    return row;
  }

  function getVisibleRoundRecords() {
    return roundRecords.slice(-roundVisibleLimit);
  }

  function isRoundInVisibleWindow(record) {
    if (!record) return false;
    var visible = getVisibleRoundRecords();
    for (var i = 0; i < visible.length; i++) {
      if (visible[i].iteration === record.iteration) return true;
    }
    return false;
  }

  function findRoundNode(iteration) {
    if (!roundTimelineEl) return null;
    return roundTimelineEl.querySelector('.etl-round-node[data-iteration="' + iteration + '"]');
  }

  function getRoundListContext() {
    bindRoundTimelineEvents();
    if (!roundTimelineEl) return null;
    var empty = roundTimelineEl.querySelector('.etl-round-empty');
    var list = roundTimelineEl.querySelector('.etl-round-list');
    if (empty) empty.classList.toggle('hidden', roundRecords.length > 0);
    return { empty: empty, list: list };
  }

  function syncLoadMoreButton(force) {
    if (!roundTimelineEl) return;
    var loadMore = roundTimelineEl.querySelector('#etl-round-load-more');
    if (!loadMore) return;
    var hiddenCount = Math.max(0, roundRecords.length - roundVisibleLimit);
    // 前缀缺口与“本地隐藏数量”是两套独立状态；即使按钮数量未变化也必须刷新提示。
    syncPrefixGapHint();
    if (!force && hiddenCount === cachedLoadMoreHidden) return;
    cachedLoadMoreHidden = hiddenCount;
    loadMore.classList.toggle('hidden', hiddenCount <= 0);
    loadMore.textContent = '加载更早的轮次 ↓' + (hiddenCount ? ' (' + hiddenCount + ')' : '');
  }

  /** 轮次从中间开始（如 19）时提示：更早轮次未实时捕获，可回填或去聊天区展开。 */
  function syncPrefixGapHint() {
    if (!roundTimelineEl) return;
    var hint = roundTimelineEl.querySelector('#etl-round-prefix-hint');
    if (!hint) return;
    if (!roundRecords.length) {
      hint.classList.add('hidden');
      hint.textContent = '';
      return;
    }
    var firstIteration = roundRecords[0].iteration;
    if (typeof firstIteration !== 'number' || firstIteration <= 1) {
      hint.classList.add('hidden');
      hint.textContent = '';
      return;
    }
    var missing = firstIteration - 1;
    hint.textContent = '轮次 1–' + missing + ' 未载入本面板 · 完整工具记录见聊天区「还有 N 条历史 · 展开」';
    hint.classList.remove('hidden');
  }

  function sliceCurrentTurnStructured(structured) {
    if (!Array.isArray(structured) || !structured.length) return [];
    var startIdx = -1;
    for (var i = structured.length - 1; i >= 0; i--) {
      if (structured[i] && structured[i].role === 'user') {
        startIdx = i;
        break;
      }
    }
    return startIdx < 0 ? structured.slice() : structured.slice(startIdx);
  }

  /**
   * 从 structured 助手轮次回填 ETL 缺失的前缀轮次（面板晚开 / F5 后只拿到后半段时）。
   * 只补 roundRecordByIteration 中不存在的 iteration，不覆盖实时数据。
   */
  function hydrateFromStructured(structured) {
    try {
      var slice = sliceCurrentTurnStructured(structured);
      if (!slice.length) return false;
      var baseTs = Date.now() - slice.length * 2000;
      var iteration = 0;
      var filled = 0;
      for (var i = 0; i < slice.length; i++) {
        var msg = slice[i];
        if (!msg || msg.role !== 'assistant') continue;
        iteration++;
        if (roundRecordByIteration[String(iteration)]) continue;
        var roundTs = baseTs + iteration * 2000;
        var roundResult = ensureRoundRecord(iteration, roundTs);
        var record = roundResult.record;
        record.status = 'done';
        record.endTs = roundTs + 1500;
        var toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
        for (var ti = 0; ti < toolCalls.length; ti++) {
          var tc = toolCalls[ti];
          if (!tc || !tc.name) continue;
          var callId = typeof tc.id === 'string' && tc.id
            ? tc.id
            : ('hydrate-' + iteration + '-' + ti);
          if (toolRecordById[callId]) continue;
          var toolTs = roundTs + ti * 200;
          var toolRec = {
            toolCallId: callId,
            toolName: tc.name,
            callTs: toolTs,
            resultTs: toolTs + 100,
            status: 'done',
            detail: formatToolArgsPreview(tc.name, tc.arguments),
            target: extractToolTarget(tc.name, tc.arguments),
            iteration: iteration,
          };
          toolRecords.push(toolRec);
          toolRecordById[callId] = toolRec;
          if (record.toolCallIds.indexOf(callId) < 0) record.toolCallIds.push(callId);
          if (!toolCallIds[callId]) {
            toolCallIds[callId] = true;
            uniqueToolCallCount++;
          }
          if (toolRecords.length > MAX_TOOL_HISTORY) {
            var removed = toolRecords.shift();
            if (removed) delete toolRecordById[removed.toolCallId];
          }
        }
        filled++;
      }
      if (!filled) {
        syncPrefixGapHint();
        return false;
      }
      renderRoundTimeline(true);
      renderEmptyState();
      patchFooterToolCount();
      scheduleFlowPersist();
      return true;
    } catch (e) {
      safeWarn('hydrateFromStructured', e);
      return false;
    }
  }

  function isRoundExpanded(record) {
    if (!record) return false;
    var key = String(record.iteration);
    return expandedRounds[key] === true;
  }

  function applyRoundExpandPresentation(roundNode, record) {
    if (!roundNode || !record) return;
    var expanded = isRoundExpanded(record);
    roundNode.classList.toggle('is-expanded', expanded);
    var row = roundNode.querySelector('.etl-round-row');
    if (row) row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    var toggle = roundNode.querySelector('.etl-round-toggle');
    if (toggle) {
      toggle.textContent = expanded ? '▴' : '▾';
      toggle.setAttribute('aria-label', expanded ? '收起轮次详情' : '展开轮次详情');
    }
    if (expanded) {
      var pills = roundNode.querySelector('.etl-round-pills');
      if (pills) pills.parentNode.removeChild(pills);
      appendRoundDetailElement(roundNode, record);
      var detail = roundNode.querySelector('.etl-round-detail');
      var actions = detail && detail.querySelector('.etl-round-actions');
      if (actions) {
        var tools = getRoundTools(record);
        for (var i = 0; i < tools.length; i++) {
          if (!actions.querySelector('[data-tool-call-id="' + tools[i].toolCallId + '"]')) {
            actions.appendChild(makeRoundActionRow(tools[i]));
          }
        }
      }
      patchRoundReason(roundNode, record);
    } else {
      syncRoundToolsPreview(roundNode, record);
    }
  }

  /** 紧凑轮次壳（对齐 chat appendToolAction）：仅 summary + live 工具槽，不建 detail。 */
  function createRoundShell(record) {
    var visualStatus = roundVisualStatus(record);
    var item = document.createElement('li');
    item.className = 'etl-round-node etl-round-card status-' + visualStatus
      + (record.isFinal ? ' is-final' : '');
    item.dataset.iteration = String(record.iteration);

    var row = document.createElement('div');
    row.className = 'etl-round-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'false');

    var marker = document.createElement('span');
    marker.className = 'etl-round-marker';
    marker.textContent = record.isFinal ? '✓' : String(record.iteration);

    var summary = document.createElement('div');
    summary.className = 'etl-round-summary';

    var head = document.createElement('div');
    head.className = 'etl-round-head';
    var title = document.createElement('span');
    title.className = 'etl-round-title';
    title.textContent = deriveRoundTitle(record);
    var badge = document.createElement('span');
    badge.className = 'etl-round-badge status-' + visualStatus;
    badge.textContent = roundStatusLabel(visualStatus);
    var time = document.createElement('span');
    time.className = 'etl-round-duration';
    time.textContent = roundDuration(record);
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'etl-round-toggle';
    toggle.setAttribute('aria-label', '展开轮次详情');
    toggle.textContent = '▾';
    head.appendChild(title);
    head.appendChild(badge);
    head.appendChild(time);
    head.appendChild(toggle);
    summary.appendChild(head);

    var liveTools = document.createElement('ul');
    liveTools.className = 'etl-round-live-tools';
    summary.appendChild(liveTools);

    row.appendChild(marker);
    row.appendChild(summary);
    item.appendChild(row);
    return item;
  }

  function ensureLiveToolsList(roundNode) {
    if (!roundNode) return null;
    var summary = roundNode.querySelector('.etl-round-summary');
    if (!summary) return null;
    var list = summary.querySelector('.etl-round-live-tools');
    if (list) return list;
    list = document.createElement('ul');
    list.className = 'etl-round-live-tools';
    summary.appendChild(list);
    return list;
  }

  function syncRoundToolsPreview(roundNode, record) {
    if (!roundNode || !record || isRoundExpanded(record)) return;
    var summary = roundNode.querySelector('.etl-round-summary');
    if (!summary) return;
    renderRoundPills(summary, getRoundTools(record), record);
  }

  function appendToolRowToDetail(roundNode, tool) {
    if (!roundNode || !tool) return;
    appendRoundDetailElement(roundNode, roundRecordByIteration[roundNode.dataset.iteration]);
    var detail = roundNode.querySelector('.etl-round-detail');
    if (!detail) return;
    var actions = detail.querySelector('.etl-round-actions');
    if (!actions) return;
    if (!actions.querySelector('[data-tool-call-id="' + tool.toolCallId + '"]')) {
      actions.appendChild(makeRoundActionRow(tool));
      while (actions.children.length > MAX_TOOL_HISTORY) {
        actions.removeChild(actions.firstElementChild);
      }
    }
  }

  function syncRoundFinalDetail(roundNode, record) {
    if (!roundNode || !record || !record.isFinal) return;
    var detail = roundNode.querySelector('.etl-round-detail');
    if (!detail || getRoundTools(record).length) return;
    var actionLabel = detail.querySelector('.etl-round-section-label');
    if (actionLabel) actionLabel.textContent = '本轮结果';
    if (!detail.querySelector('.etl-round-complete')) {
      rebuildRoundDetailBody(detail, record);
    } else {
      var completion = detail.querySelector('.etl-round-complete');
      if (completion) completion.textContent = roundCompletionText(record);
    }
  }

  /** 对齐 chat appendToolAction：折叠态写入隐藏槽供 patch；展开态只写入 detail。 */
  function appendLiveToolToRound(roundNode, tool) {
    if (!roundNode || !tool || !tool.toolCallId) return;
    var record = roundRecordByIteration[roundNode.dataset.iteration];
    if (!record) return;
    if (isRoundExpanded(record)) {
      appendToolRowToDetail(roundNode, tool);
      return;
    }
    var list = ensureLiveToolsList(roundNode);
    if (!list || list.querySelector('[data-tool-call-id="' + tool.toolCallId + '"]')) return;
    list.appendChild(makeRoundActionRow(tool));
    while (list.children.length > MAX_TOOL_HISTORY) {
      list.removeChild(list.firstElementChild);
    }
    syncRoundToolsPreview(roundNode, record);
  }

  function patchRoundShellSummary(roundNode, record) {
    if (!roundNode || !record) return;
    var visualStatus = roundVisualStatus(record);
    roundNode.classList.remove('status-done', 'status-failed', 'status-running');
    roundNode.classList.add('status-' + visualStatus);
    roundNode.classList.toggle('is-final', !!record.isFinal);
    var marker = roundNode.querySelector('.etl-round-marker');
    if (marker) marker.textContent = record.isFinal ? '✓' : String(record.iteration);
    var title = roundNode.querySelector('.etl-round-title');
    if (title) title.textContent = deriveRoundTitle(record);
    var badge = roundNode.querySelector('.etl-round-badge');
    if (badge) {
      badge.className = 'etl-round-badge status-' + visualStatus;
      badge.textContent = roundStatusLabel(visualStatus);
    }
    var time = roundNode.querySelector('.etl-round-duration');
    if (time) time.textContent = roundDuration(record);
    applyRoundExpandPresentation(roundNode, record);
    syncRoundFinalDetail(roundNode, record);
  }

  function patchFooterToolCount() {
    if (!footerEl) return;
    ensureFooterSkeleton();
    var liveToolCount = authoritativeToolCalls === null
      ? uniqueToolCallCount
      : authoritativeToolCalls + Math.max(0, uniqueToolCallCount - calibratedUniqueToolCount);
    var toolTxt = liveToolCount > 0 || authoritativeToolCalls !== null ? String(liveToolCount) : '—';
    var toolEl = footerEl.querySelector('.etl-foot-tool b');
    if (toolEl && toolEl.textContent !== toolTxt) toolEl.textContent = toolTxt;
  }

  /** 新增可见轮次：≤limit append 壳；>limit remove 首条再 append。 */
  function pushRoundShellToList(list, record) {
    if (!list || !record) return null;
    if (findRoundNode(record.iteration)) return findRoundNode(record.iteration);
    var fresh = createRoundShell(record);
    if (list.children.length >= roundVisibleLimit) {
      var first = list.firstElementChild;
      if (first) list.removeChild(first);
    }
    list.appendChild(fresh);
    return fresh;
  }

  /** 加载更早轮次：在列表头部按时间顺序 prepend 尚未渲染的轮次。 */
  function prependMissingRoundNodes(list, records) {
    if (!list || !records || !records.length) return;
    var missing = [];
    for (var i = 0; i < records.length; i++) {
      if (!findRoundNode(records[i].iteration)) missing.push(records[i]);
    }
    for (var j = missing.length - 1; j >= 0; j--) {
      list.insertBefore(materializeRoundNode(missing[j]), list.firstElementChild);
    }
  }

  function materializeRoundNode(record) {
    var node = createRoundShell(record);
    if (!isRoundExpanded(record)) {
      var tools = getRoundTools(record);
      for (var i = 0; i < tools.length; i++) {
        var list = ensureLiveToolsList(node);
        if (list && !list.querySelector('[data-tool-call-id="' + tools[i].toolCallId + '"]')) {
          list.appendChild(makeRoundActionRow(tools[i]));
        }
      }
    }
    patchRoundShellSummary(node, record);
    return node;
  }

  function rebuildVisibleRoundList(list) {
    if (!list) return;
    list.innerHTML = '';
    var visible = getVisibleRoundRecords();
    for (var i = 0; i < visible.length; i++) {
      list.appendChild(materializeRoundNode(visible[i]));
    }
  }

  function rebuildRoundPillsInNode(roundNode, record) {
    var summary = roundNode.querySelector('.etl-round-summary');
    if (!summary) return;
    renderRoundPills(summary, getRoundTools(record), record);
  }

  function patchRoundReason(roundNode, record) {
    var detail = roundNode.querySelector('.etl-round-detail');
    if (!detail) return;
    var reasons = detail.querySelectorAll('.etl-round-reason');
    var reason = reasons.length ? reasons[reasons.length - 1] : null;
    if (reason) reason.textContent = deriveRoundReason(record);
  }

  /** 就地更新已有轮次节点，避免 replaceChild 引发整表重绘闪烁。 */
  function patchRoundNode(roundNode, record) {
    if (!roundNode || !record) return;
    snapshotRoundPlan(record);
    patchRoundSummary(roundNode, record);
    appendRoundDetailElement(roundNode, record);
    var detail = roundNode.querySelector('.etl-round-detail');
    if (!detail) return;
    var tools = getRoundTools(record);
    var actions = detail.querySelector('.etl-round-actions');
    if (tools.length) {
      if (actions) {
        var validIds = Object.create(null);
        for (var tv = 0; tv < tools.length; tv++) {
          validIds[tools[tv].toolCallId] = true;
        }
        var existingRows = actions.querySelectorAll('[data-tool-call-id]');
        Array.prototype.forEach.call(existingRows, function (row) {
          if (!validIds[row.dataset.toolCallId]) {
            row.parentNode.removeChild(row);
          }
        });
        for (var ti = 0; ti < tools.length; ti++) {
          var tool = tools[ti];
          if (!actions.querySelector('[data-tool-call-id="' + tool.toolCallId + '"]')) {
            actions.appendChild(makeRoundActionRow(tool));
          }
        }
      } else {
        rebuildRoundDetailBody(detail, record);
      }
    } else if (record.isFinal) {
      var actionLabel = detail.querySelector('.etl-round-section-label');
      if (actionLabel) actionLabel.textContent = '本轮结果';
      if (!detail.querySelector('.etl-round-complete')) {
        rebuildRoundDetailBody(detail, record);
      } else {
        var completion = detail.querySelector('.etl-round-complete');
        if (completion) completion.textContent = roundCompletionText(record);
      }
    } else {
      var planning = detail.querySelector('.etl-round-reason');
      if (planning && !actions) {
        planning.textContent = record.activeTitle || '分析目标并生成下一步动作';
      } else if (!planning) {
        rebuildRoundDetailBody(detail, record);
      }
    }
    patchRoundReason(roundNode, record);
    var row = roundNode.querySelector('.etl-round-row');
    if (row) row.setAttribute('aria-expanded', isRoundExpanded(record) ? 'true' : 'false');
    var toggle = roundNode.querySelector('.etl-round-toggle');
    if (toggle) {
      var expanded = isRoundExpanded(record);
      toggle.textContent = expanded ? '▴' : '▾';
      toggle.setAttribute('aria-label', expanded ? '收起轮次详情' : '展开轮次详情');
    }
  }

  function patchRoundSummary(roundNode, record, options) {
    options = options || {};
    var visualStatus = roundVisualStatus(record);
    roundNode.classList.remove('status-done', 'status-failed', 'status-running', 'is-expanded');
    roundNode.classList.add('status-' + visualStatus);
    roundNode.classList.toggle('is-final', !!record.isFinal);
    roundNode.classList.toggle('is-expanded', isRoundExpanded(record));
    var marker = roundNode.querySelector('.etl-round-marker');
    if (marker) marker.textContent = record.isFinal ? '✓' : String(record.iteration);
    var title = roundNode.querySelector('.etl-round-title');
    if (title) title.textContent = deriveRoundTitle(record);
    var badge = roundNode.querySelector('.etl-round-badge');
    if (badge) {
      badge.className = 'etl-round-badge status-' + visualStatus;
      badge.textContent = roundStatusLabel(visualStatus);
    }
    var time = roundNode.querySelector('.etl-round-duration');
    if (time) time.textContent = roundDuration(record);
    if (!options.skipPills && shouldRebuildRoundPills(roundNode, record)) {
      rebuildRoundPillsInNode(roundNode, record);
    }
  }

  function rebuildRoundDetailBody(detail, record) {
    var label = detail.querySelector('.etl-round-section-label');
    if (!label) return;
    label.textContent = record.isFinal ? '本轮结果' : '做了什么';
    while (label.nextSibling) detail.removeChild(label.nextSibling);
    var tools = getRoundTools(record);
    if (tools.length) {
      var actionList = document.createElement('ul');
      actionList.className = 'etl-round-actions';
      for (var i = 0; i < tools.length; i++) {
        actionList.appendChild(makeRoundActionRow(tools[i]));
      }
      detail.appendChild(actionList);
    } else if (record.isFinal) {
      var completion = document.createElement('div');
      completion.className = 'etl-round-complete';
      completion.textContent = roundCompletionText(record);
      detail.appendChild(completion);
    } else {
      var planning = document.createElement('div');
      planning.className = 'etl-round-reason';
      planning.textContent = record.activeTitle || '分析目标并生成下一步动作';
      detail.appendChild(planning);
    }
    var reasonLabel = document.createElement('div');
    reasonLabel.className = 'etl-round-section-label';
    reasonLabel.textContent = '为什么这么做';
    var reason = document.createElement('div');
    reason.className = 'etl-round-reason';
    reason.textContent = deriveRoundReason(record);
    detail.appendChild(reasonLabel);
    detail.appendChild(reason);
  }

  function appendRoundDetailElement(item, record) {
    if (!item || item.querySelector('.etl-round-detail')) return;
    var tools = getRoundTools(record);
    var detail = document.createElement('div');
    detail.className = 'etl-round-detail';

    var actionLabel = document.createElement('div');
    actionLabel.className = 'etl-round-section-label';
    actionLabel.textContent = record.isFinal ? '本轮结果' : '做了什么';
    detail.appendChild(actionLabel);

    if (tools.length) {
      var actionList = document.createElement('ul');
      actionList.className = 'etl-round-actions';
      for (var i = 0; i < tools.length; i++) {
        actionList.appendChild(makeRoundActionRow(tools[i]));
      }
      detail.appendChild(actionList);
    } else if (record.isFinal) {
      var completion = document.createElement('div');
      completion.className = 'etl-round-complete';
      completion.textContent = roundCompletionText(record);
      detail.appendChild(completion);
    } else {
      var planning = document.createElement('div');
      planning.className = 'etl-round-reason';
      planning.textContent = record.activeTitle || '分析目标并生成下一步动作';
      detail.appendChild(planning);
    }

    var reasonLabel = document.createElement('div');
    reasonLabel.className = 'etl-round-section-label';
    reasonLabel.textContent = '为什么这么做';
    var reason = document.createElement('div');
    reason.className = 'etl-round-reason';
    reason.textContent = deriveRoundReason(record);
    detail.appendChild(reasonLabel);
    detail.appendChild(reason);
    item.appendChild(detail);
  }

  function appendToolToRoundNode(roundNode, record, tool) {
    appendRoundDetailElement(roundNode, record);
    patchRoundSummary(roundNode, record);
    var detail = roundNode.querySelector('.etl-round-detail');
    if (!detail) return;
    var actions = detail.querySelector('.etl-round-actions');
    if (actions) {
      if (!actions.querySelector('[data-tool-call-id="' + tool.toolCallId + '"]')) {
        actions.appendChild(makeRoundActionRow(tool));
      }
    } else {
      rebuildRoundDetailBody(detail, record);
      return;
    }
    patchRoundReason(roundNode, record);
  }

  function patchRoundToolRow(row, tool) {
    if (!row || !tool) return;
    var status = toolStatusClass(tool.status);
    row.className = 'etl-round-action etl-round-tool status-' + status;
    row.dataset.status = tool.status;
    if (typeof tool.callTs === 'number') row.dataset.callTs = String(tool.callTs);
    if (typeof tool.resultTs === 'number') row.dataset.resultTs = String(tool.resultTs);
    var icon = row.querySelector('.etl-round-action-icon');
    if (icon) icon.textContent = status === 'failed' ? '×' : '✓';
    var dur = row.querySelector('.etl-round-action-dur');
    if (dur) dur.textContent = formatToolDuration(tool);
  }

  function tryPatchRoundToolRow(tool) {
    if (!tool || !tool.toolCallId) return false;
    var rows = [];
    if (roundTimelineEl) {
      var matches = roundTimelineEl.querySelectorAll('[data-tool-call-id="' + tool.toolCallId + '"]');
      Array.prototype.forEach.call(matches, function (row) { rows.push(row); });
    }
    if (!rows.length) return false;
    for (var i = 0; i < rows.length; i++) patchRoundToolRow(rows[i], tool);
    return true;
  }

  /** 已有节点就地 patch；新节点走 pushRoundNodeToList。 */
  function ensureRoundNode(record, options) {
    options = options || {};
    var ctx = getRoundListContext();
    if (!ctx || !ctx.list || !record) return null;
    var existing = findRoundNode(record.iteration);
    if (existing) {
      patchRoundNode(existing, record);
      return existing;
    }
    if (options.insert) return pushRoundShellToList(ctx.list, record);
    return null;
  }

  function syncRoundTimeline(options) {
    options = options || {};
    try {
      var ctx = getRoundListContext();
      if (!ctx || !ctx.list) return;

      if (options.reset) {
        ctx.list.innerHTML = '';
        cachedLoadMoreHidden = -1;
      }

      if (options.iteration != null) {
        var rec = roundRecordByIteration[String(options.iteration)];
        if (!rec || !isRoundInVisibleWindow(rec)) {
          var stale = findRoundNode(options.iteration);
          if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
          syncLoadMoreButton();
          return;
        }
        if (options.tool && options.mode === 'append') {
          var liveNode = findRoundNode(rec.iteration);
          if (liveNode) {
            appendLiveToolToRound(liveNode, options.tool);
            patchRoundShellSummary(liveNode, rec);
            return;
          }
        }
        if (options.insert) {
          var shell = pushRoundShellToList(ctx.list, rec);
          if (shell && options.tool) appendLiveToolToRound(shell, options.tool);
          if (shell) patchRoundShellSummary(shell, rec);
          syncLoadMoreButton();
          return;
        }
        var existing = findRoundNode(rec.iteration);
        if (existing) {
          if (options.tool) appendLiveToolToRound(existing, options.tool);
          patchRoundShellSummary(existing, rec);
        }
        return;
      }

      if (options.loadMore) {
        cachedLoadMoreHidden = -1;
        syncLoadMoreButton(true);
        prependMissingRoundNodes(ctx.list, getVisibleRoundRecords());
        refreshVisibleRoundPillSummaries();
        return;
      }

      syncLoadMoreButton(true);
      rebuildVisibleRoundList(ctx.list);
      refreshVisibleRoundPillSummaries();
    } catch (e) {
      safeWarn('syncRoundTimeline', e);
    }
  }

  function renderRoundTimeline(reset) {
    syncRoundTimeline({ reset: !!reset });
  }

  function toggleRoundExpanded(iteration) {
    var key = String(iteration);
    var record = roundRecordByIteration[key];
    expandedRounds[key] = !isRoundExpanded(record);
    var node = findRoundNode(iteration);
    if (!node || !record) return;
    applyRoundExpandPresentation(node, record);
  }

  function handleRoundTimelineInteraction(event) {
    try {
      var target = event.target;
      if (!target || !target.closest) return;
      var loadMore = target.closest('#etl-round-load-more');
      if (loadMore) {
        roundVisibleLimit += 8;
        cachedLoadMoreHidden = -1;
        syncRoundTimeline({ loadMore: true });
        return;
      }
      var row = target.closest('.etl-round-row');
      if (!row) return;
      var node = row.closest('.etl-round-node');
      if (!node || !node.dataset.iteration) return;
      if (event.type === 'keydown') {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
      } else if (target.closest('.etl-round-toggle')) {
        event.preventDefault();
      }
      toggleRoundExpanded(node.dataset.iteration);
    } catch (e) {
      safeWarn('roundTimelineClick', e);
    }
  }

  function unbindRoundTimelineEvents() {
    if (roundTimelineBoundEl) {
      if (roundTimelineClickHandler) {
        roundTimelineBoundEl.removeEventListener('click', roundTimelineClickHandler);
      }
      if (roundTimelineKeydownHandler) {
        roundTimelineBoundEl.removeEventListener('keydown', roundTimelineKeydownHandler);
      }
    }
    roundTimelineBoundEl = null;
    roundTimelineClickHandler = null;
    roundTimelineKeydownHandler = null;
    roundTimelineBound = false;
  }

  function bindRoundTimelineEvents() {
    if (!roundTimelineEl) return;
    if (roundTimelineBound && roundTimelineBoundEl === roundTimelineEl) return;
    unbindRoundTimelineEvents();
    roundTimelineClickHandler = handleRoundTimelineInteraction;
    roundTimelineKeydownHandler = handleRoundTimelineInteraction;
    roundTimelineEl.addEventListener('click', roundTimelineClickHandler);
    roundTimelineEl.addEventListener('keydown', roundTimelineKeydownHandler);
    roundTimelineBoundEl = roundTimelineEl;
    roundTimelineBound = true;
  }

  function makeRoundNode(record, options) {
    options = options || {};
    var tools = getRoundTools(record);
    var visualStatus = roundVisualStatus(record);
    var itemKey = String(record.iteration);
    var isExpanded = isRoundExpanded(record);

    var item = document.createElement('li');
    item.className = 'etl-round-node etl-round-card status-' + visualStatus
      + (record.isFinal ? ' is-final' : '')
      + (isExpanded ? ' is-expanded' : '');
    item.dataset.iteration = itemKey;

    var row = document.createElement('div');
    row.className = 'etl-round-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');

    var marker = document.createElement('span');
    marker.className = 'etl-round-marker';
    marker.textContent = record.isFinal ? '✓' : String(record.iteration);

    var summary = document.createElement('div');
    summary.className = 'etl-round-summary';

    var head = document.createElement('div');
    head.className = 'etl-round-head';
    var title = document.createElement('span');
    title.className = 'etl-round-title';
    title.textContent = deriveRoundTitle(record);
    var badge = document.createElement('span');
    badge.className = 'etl-round-badge status-' + visualStatus;
    badge.textContent = roundStatusLabel(visualStatus);
    var time = document.createElement('span');
    time.className = 'etl-round-duration';
    time.textContent = roundDuration(record);
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'etl-round-toggle';
    toggle.setAttribute('aria-label', isExpanded ? '收起轮次详情' : '展开轮次详情');
    toggle.textContent = isExpanded ? '▴' : '▾';
    head.appendChild(title);
    head.appendChild(badge);
    head.appendChild(time);
    head.appendChild(toggle);
    summary.appendChild(head);

    renderRoundPills(summary, tools, record);

    row.appendChild(marker);
    row.appendChild(summary);
    item.appendChild(row);

    if (!options.summaryOnly) appendRoundDetailElement(item, record);

    return item;
  }

  function buildTaskOverviewSkeleton() {
    taskOverviewEl.innerHTML = '';
    var label = document.createElement('div');
    label.className = 'etl-overview-label';
    label.textContent = '当前目标';
    taskOverviewEl.appendChild(label);

    var head = document.createElement('div');
    head.className = 'etl-overview-head';
    var goal = document.createElement('div');
    goal.className = 'etl-overview-goal';
    goal.id = 'etl-overview-goal';
    var badge = document.createElement('span');
    badge.className = 'etl-overview-badge hidden';
    badge.id = 'etl-overview-badge';
    badge.textContent = '监管接管中';
    head.appendChild(goal);
    head.appendChild(badge);
    taskOverviewEl.appendChild(head);

    var progressWrap = document.createElement('div');
    progressWrap.className = 'etl-overview-progress';
    var bar = document.createElement('div');
    bar.className = 'etl-overview-bar';
    var fill = document.createElement('div');
    fill.className = 'etl-overview-bar-fill';
    fill.id = 'etl-overview-bar-fill';
    bar.appendChild(fill);
    var progressMeta = document.createElement('div');
    progressMeta.className = 'etl-overview-progress-meta';
    progressMeta.id = 'etl-overview-progress-meta';
    progressWrap.appendChild(bar);
    progressWrap.appendChild(progressMeta);
    taskOverviewEl.appendChild(progressWrap);

    var grid = document.createElement('div');
    grid.className = 'etl-overview-grid hidden';
    grid.id = 'etl-overview-grid';
    grid.innerHTML =
      '<div class="etl-overview-grid-item">' +
        '<span class="etl-overview-grid-label">接管原因</span>' +
        '<span class="etl-overview-grid-value" id="etl-overview-reason">—</span>' +
      '</div>' +
      '<div class="etl-overview-grid-item">' +
        '<span class="etl-overview-grid-label">接管轮次</span>' +
        '<span class="etl-overview-grid-value" id="etl-overview-round">—</span>' +
      '</div>';
    taskOverviewEl.appendChild(grid);

    var intentEl = document.createElement('div');
    intentEl.className = 'etl-overview-intent hidden';
    intentEl.id = 'etl-overview-intent';
    taskOverviewEl.appendChild(intentEl);
  }

  function formatGoalDisplay(goal, active) {
    var raw = goal || (active && active.title) || '当前任务';
    if (!raw || raw === '当前任务') return raw;
    var skillMatch = raw.match(/\[Active Skill:\s*([^\]]+)\]/);
    if (skillMatch) {
      return '[Active Skill: ' + skillMatch[1].trim() + ']';
    }
    if (raw.length > 240) {
      var trimmed = raw.slice(0, 240);
      trimmed = trimmed.replace(/\s+\S*$/, '');
      return trimmed + '…';
    }
    return raw;
  }

  function renderTaskOverview() {
    if (!taskOverviewEl) return;
    try {
      if (!currentPlan) {
        taskOverviewEl.innerHTML = '';
        taskOverviewEl.classList.add('hidden');
        return;
      }
      if (!taskOverviewEl.querySelector('#etl-overview-goal')) {
        buildTaskOverviewSkeleton();
      }

      var steps = currentPlan.steps || [];
      var total = steps.length;
      var done = countFinished(steps);
      var pct = total ? Math.round((done / total) * 100) : (currentPlan.progress || 0);
      var active = pickActiveStep(currentPlan);
      var intent = INTENT_LABELS[currentPlan.intent] || currentPlan.intent || '';
      var forced = currentExecutionMode && currentExecutionMode.executionMode === 'forced';
      var remainSec = estimateRemainingSeconds(currentPlan);

      var goalEl = taskOverviewEl.querySelector('#etl-overview-goal');
      if (goalEl) {
        goalEl.textContent = formatGoalDisplay(currentPlan.goal, active);
      }
      var badgeEl = taskOverviewEl.querySelector('#etl-overview-badge');
      if (badgeEl) badgeEl.classList.toggle('hidden', !forced);

      var fillEl = taskOverviewEl.querySelector('#etl-overview-bar-fill');
      if (fillEl) fillEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
      var progressMetaEl = taskOverviewEl.querySelector('#etl-overview-progress-meta');
      if (progressMetaEl) {
        var progressText = total ? (done + ' / ' + total + ' 步骤') : (pct + '% 进度');
        if (remainSec !== null && !isPlanComplete(currentPlan)) {
          progressText += ' · 预计 ' + remainSec + 's 完成';
        } else if (isPlanComplete(currentPlan)) {
          progressText += ' · 已完成';
        }
        progressMetaEl.textContent = progressText;
      }

      var gridEl = taskOverviewEl.querySelector('#etl-overview-grid');
      if (gridEl) {
        gridEl.classList.toggle('hidden', !forced);
        if (forced) {
          var reasonEl = taskOverviewEl.querySelector('#etl-overview-reason');
          if (reasonEl) reasonEl.textContent = formatSupervisionReason(currentExecutionMode);
          var roundEl = taskOverviewEl.querySelector('#etl-overview-round');
          if (roundEl) {
            var roundNo = typeof currentExecutionMode.round === 'number'
              ? currentExecutionMode.round
              : (roundRecords.length ? roundRecords[roundRecords.length - 1].iteration : '—');
            roundEl.textContent = '第 ' + roundNo + ' 轮';
          }
        }
      }

      var intentEl = taskOverviewEl.querySelector('#etl-overview-intent');
      if (intentEl) {
        if (intent) {
          var phase = active && active.phase ? (PHASE_LABELS[active.phase] || active.phase) : '已结束';
          intentEl.textContent = '意图：' + intent + ' · 阶段：' + phase;
          intentEl.classList.remove('hidden');
        } else {
          intentEl.textContent = '';
          intentEl.classList.add('hidden');
        }
      }

      taskOverviewEl.classList.remove('hidden');
    } catch (e) {
      safeWarn('renderTaskOverview', e);
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

  /**
   * 消费 tool_call / tool_result 用于推导 LLM 当前动作（不做展示，仅记录最近工具）。
   * 只取 toolName 与到达状态，绝不读取 reasoning/thinking。
   */
  function applyToolActivity(step) {
    try {
      if (!step || !step.type) return;
      recoverPanelAfterFatal();
      if (step.type === 'tool_call') {
        var callId = typeof step.toolCallId === 'string' ? step.toolCallId : '';
        if (!callId) return;
        var toolName = typeof step.toolName === 'string' ? step.toolName : '';
        var callTs = typeof step.ts === 'number' ? step.ts : Date.now();
        var roundResult = ensureRoundRecord(step.iteration, callTs);
        var round = roundResult.record;
        var createdTool = false;
        var historyTrimmed = false;
        if (!toolRecordById[callId]) {
          createdTool = true;
          var record = {
            toolCallId: callId,
            toolName: toolName,
            callTs: callTs,
            resultTs: null,
            status: 'running',
            detail: formatToolArgsPreview(toolName, step.toolArgs),
            target: extractToolTarget(toolName, step.toolArgs),
            iteration: round.iteration,
          };
          toolRecords.push(record);
          toolRecordById[callId] = record;
          if (round.toolCallIds.indexOf(callId) < 0) round.toolCallIds.push(callId);
          if (!toolCallIds[callId]) {
            toolCallIds[callId] = true;
            uniqueToolCallCount++;
          }
          if (toolRecords.length > MAX_TOOL_HISTORY) {
            var removed = toolRecords.shift();
            if (removed) delete toolRecordById[removed.toolCallId];
            historyTrimmed = true;
          }
        }
        lastTool = { toolCallId: callId, toolName: toolName, pending: true, ts: callTs };
        if (!historyTrimmed && createdTool && findRoundNode(round.iteration) && !roundResult.created
          && getRoundTools(round).length < MAX_TOOL_HISTORY) {
          syncRoundTimeline({
            iteration: round.iteration,
            mode: 'append',
            tool: toolRecordById[callId],
          });
        } else {
          syncRoundTimeline({
            iteration: round.iteration,
            insert: roundResult.created,
            tool: createdTool ? toolRecordById[callId] : null,
          });
        }
        renderEmptyState();
        if (createdTool) {
          patchFooterToolCount();
          renderLlmActivity();
        }
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
          if (!matched.toolName && typeof step.toolName === 'string') {
            matched.toolName = step.toolName;
          }
          var matchedRoundResult = ensureRoundRecord(matched.iteration, matched.callTs);
          var matchedRound = matchedRoundResult.record;
          if (matched.resultTs > (matchedRound.endTs || 0)) matchedRound.endTs = matched.resultTs;
          var roundTools = getRoundTools(matchedRound);
          var allDone = roundTools.length > 0;
          for (var ri = 0; ri < roundTools.length; ri++) {
            if (toolStatusClass(roundTools[ri].status) === 'running') allDone = false;
          }
          if (allDone) matchedRound.status = 'done';
          if (tryPatchRoundToolRow(matched)) {
            var roundNode = findRoundNode(matchedRound.iteration);
            if (roundNode) patchRoundShellSummary(roundNode, matchedRound);
          } else {
            syncRoundTimeline({ iteration: matchedRound.iteration });
          }
        }
        if (lastTool.pending && resultId && lastTool.toolCallId === resultId) {
          lastTool.pending = false;
          renderLlmActivity();
        }
      }
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('applyToolActivity', e);
    }
  }

  /** 新一轮用户输入开始时，仅清空上一轮工具记录与计数，不改执行计划。 */
  function resetToolActivity() {
    try {
      lastTool = { toolCallId: '', toolName: '', pending: false, ts: 0 };
      toolRecords = [];
      toolRecordById = Object.create(null);
      toolCallIds = Object.create(null);
      uniqueToolCallCount = 0;
      authoritativeToolCalls = null;
      calibratedUniqueToolCount = 0;
      footerStats.totalToolCalls = null;
      roundRecords = [];
      roundRecordByIteration = Object.create(null);
      expandedRounds = Object.create(null);
      roundVisibleLimit = 20;
      cachedLoadMoreHidden = -1;
      renderTaskOverview();
      renderRoundTimeline(true);
      renderEmptyState();
      renderLlmActivity();
      renderFooter();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('resetToolActivity', e);
    }
  }

  function beginTurnTimer(ts) {
    try {
      recoverPanelAfterFatal();
      turnStartedAt = typeof ts === 'number' ? ts : Date.now();
      turnEndedAt = null;
      renderFooter();
      startTick();
    } catch (e) {
      safeWarn('beginTurnTimer', e);
    }
  }

  function endTurnTimer(ts) {
    try {
      if (typeof turnStartedAt !== 'number' || typeof turnEndedAt === 'number') return;
      turnEndedAt = typeof ts === 'number' ? Math.max(turnStartedAt, ts) : Date.now();
      renderFooter();
      stopTick();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('endTurnTimer', e);
    }
  }

  // ── 全量渲染 ──

  function fullRender() {
    if (!ensureMounted()) throw new Error('执行透明层挂载失败');
    renderExecutionModeBanner();
    renderTaskOverview();
    renderRoundTimeline(true);
    renderCurrentStep();
    renderEmptyState();
    renderList();
    renderLlmActivity();
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
      // 新一轮任务（planId 变化）才重置工具状态；同 plan 的增量更新保留执行流。
      var prevId = currentPlan && currentPlan.planId;
      if (frozenPlanId && prevId === plan.planId && frozenPlanId === plan.planId) {
        recoverPanelAfterFatal();
        return;
      }
      if (!prevId || prevId !== plan.planId) {
        frozenPlanId = null;
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
      scheduleFlowPersist();
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
      renderTaskOverview();
      renderEmptyState();
      renderLlmActivity();
      renderFooter();

      if (isPlanComplete(currentPlan)) {
        visible = !isPanelSuppressed();
        stopTick();
        applyVisibility();
      } else if (hasRunningStep()) {
        startTick();
      }
      notifyPetFoot();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('applyPatch', e);
      teardownMounts();
    }
  }

  function resetExecutionMode() {
    try {
      currentExecutionMode = null;
      bannerDetailOpen = false;
      renderExecutionModeBanner();
      renderTaskOverview();
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
      roundRecords = [];
      roundRecordByIteration = Object.create(null);
      expandedRounds = Object.create(null);
      roundVisibleLimit = 20;
      bannerDetailOpen = false;
      lastTool = { toolCallId: '', toolName: '', pending: false, ts: 0 };
      toolRecords = [];
      toolRecordById = Object.create(null);
      toolCallIds = Object.create(null);
      uniqueToolCallCount = 0;
      authoritativeToolCalls = null;
      calibratedUniqueToolCount = 0;
      footerStats = { totalTokenUsage: null, totalToolCalls: null };
      if (typeof turnStartedAt !== 'number' || typeof turnEndedAt === 'number') stopTick();
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
        renderTaskOverview();
        renderRoundTimeline(true);
        renderExecutionModeBanner();
        renderFooter();
      }
      applyVisibility();
      notifyPetFoot();
      scheduleFlowPersist();
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
        bannerDetailOpen = false;
        renderExecutionModeBanner();
        renderTaskOverview();
        applyVisibility();
        notifyPetFoot();
        return;
      }
      currentExecutionMode = Object.assign({}, step.executionMode);
      if (!isPanelSuppressed() && pageActive) {
        ensureMounted();
        renderExecutionModeBanner();
        renderTaskOverview();
      }
      applyVisibility();
      notifyPetFoot();
      scheduleFlowPersist();
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
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('applyRuntimeStats', e);
    }
  }

  function cloneRoundRecord(record) {
    if (!record || typeof record !== 'object') return null;
    return {
      iteration: record.iteration,
      startTs: record.startTs,
      endTs: record.endTs,
      status: record.status,
      toolCallIds: Array.isArray(record.toolCallIds) ? record.toolCallIds.slice() : [],
      signals: Array.isArray(record.signals) ? record.signals.slice() : [],
      branchReasons: Array.isArray(record.branchReasons) ? record.branchReasons.slice() : [],
      stopReason: record.stopReason || '',
      activeTitle: record.activeTitle || '',
      phase: record.phase || '',
    };
  }

  function cloneToolRecord(record) {
    if (!record || typeof record !== 'object') return null;
    return {
      toolCallId: record.toolCallId || '',
      toolName: record.toolName || '',
      callTs: record.callTs,
      resultTs: record.resultTs,
      status: record.status || 'running',
      detail: record.detail || '',
      target: record.target || '',
      iteration: record.iteration,
    };
  }

  function rebuildRoundIndexes(records) {
    roundRecordByIteration = Object.create(null);
    for (var i = 0; i < records.length; i++) {
      var rr = records[i];
      if (rr && typeof rr.iteration === 'number') {
        roundRecordByIteration[String(rr.iteration)] = rr;
      }
    }
  }

  function rebuildToolIndexes(records) {
    toolRecordById = Object.create(null);
    toolCallIds = Object.create(null);
    uniqueToolCallCount = 0;
    for (var i = 0; i < records.length; i++) {
      var tr = records[i];
      if (!tr || !tr.toolCallId) continue;
      toolRecordById[tr.toolCallId] = tr;
      if (!toolCallIds[tr.toolCallId]) {
        toolCallIds[tr.toolCallId] = true;
        uniqueToolCallCount++;
      }
    }
  }

  function scheduleFlowPersist() {
    if (!flowPersistHandler) return;
    if (flowPersistTimer) clearTimeout(flowPersistTimer);
    flowPersistTimer = setTimeout(function () {
      flowPersistTimer = null;
      try {
        flowPersistHandler();
      } catch (e) {
        safeWarn('scheduleFlowPersist', e);
      }
    }, 250);
  }

  function cancelFlowPersist() {
    if (flowPersistTimer) {
      clearTimeout(flowPersistTimer);
      flowPersistTimer = null;
    }
  }

  /** 取消待写防抖并立即落盘（会话切换 / 页面隐藏时调用）。 */
  function flushFlowPersist() {
    cancelFlowPersist();
    if (!flowPersistHandler) return;
    try {
      flowPersistHandler();
    } catch (e) {
      safeWarn('flushFlowPersist', e);
    }
  }

  function registerFlowPersist(handler) {
    flowPersistHandler = typeof handler === 'function' ? handler : null;
  }

  /** 导出可 JSON 序列化的执行流快照（不含 DOM / 偏好）。 */
  function getFlowSnapshot() {
    try {
      var rounds = [];
      for (var i = 0; i < roundRecords.length; i++) {
        var clonedRound = cloneRoundRecord(roundRecords[i]);
        if (clonedRound) rounds.push(clonedRound);
      }
      var tools = [];
      for (var j = 0; j < toolRecords.length; j++) {
        var clonedTool = cloneToolRecord(toolRecords[j]);
        if (clonedTool) tools.push(clonedTool);
      }
      return {
        currentPlan: currentPlan ? JSON.parse(JSON.stringify(currentPlan)) : null,
        frozenPlanId: frozenPlanId,
        currentExecutionMode: currentExecutionMode
          ? Object.assign({}, currentExecutionMode)
          : null,
        roundRecords: rounds,
        toolRecords: tools,
        lastTool: Object.assign({}, lastTool),
        footerStats: Object.assign({}, footerStats),
        turnStartedAt: turnStartedAt,
        turnEndedAt: turnEndedAt,
        uniqueToolCallCount: uniqueToolCallCount,
        calibratedUniqueToolCount: calibratedUniqueToolCount,
        authoritativeToolCalls: typeof authoritativeToolCalls === 'number'
          ? authoritativeToolCalls
          : null,
      };
    } catch (e) {
      safeWarn('getFlowSnapshot', e);
      return null;
    }
  }

  /**
   * 从本地快照恢复执行流。
   * @param {object} snapshot
   * @param {{ overlayOnly?: boolean }} opts overlayOnly=true 时仅恢复轮次/工具，保留当前 plan。
   */
  function restoreFlowSnapshot(snapshot, opts) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    opts = opts || {};
    try {
      var rounds = [];
      if (Array.isArray(snapshot.roundRecords)) {
        for (var i = 0; i < snapshot.roundRecords.length; i++) {
          var rr = cloneRoundRecord(snapshot.roundRecords[i]);
          if (rr) rounds.push(rr);
        }
      }
      roundRecords = rounds;
      rebuildRoundIndexes(rounds);

      var tools = [];
      if (Array.isArray(snapshot.toolRecords)) {
        for (var j = 0; j < snapshot.toolRecords.length; j++) {
          var tr = cloneToolRecord(snapshot.toolRecords[j]);
          if (tr) tools.push(tr);
        }
      }
      toolRecords = tools;
      rebuildToolIndexes(tools);

      lastTool = snapshot.lastTool && typeof snapshot.lastTool === 'object'
        ? Object.assign({ toolCallId: '', toolName: '', pending: false, ts: 0 }, snapshot.lastTool)
        : { toolCallId: '', toolName: '', pending: false, ts: 0 };
      footerStats = snapshot.footerStats && typeof snapshot.footerStats === 'object'
        ? Object.assign({ totalTokenUsage: null, totalToolCalls: null }, snapshot.footerStats)
        : { totalTokenUsage: null, totalToolCalls: null };
      turnStartedAt = typeof snapshot.turnStartedAt === 'number' ? snapshot.turnStartedAt : null;
      turnEndedAt = typeof snapshot.turnEndedAt === 'number' ? snapshot.turnEndedAt : null;
      calibratedUniqueToolCount = typeof snapshot.calibratedUniqueToolCount === 'number'
        ? snapshot.calibratedUniqueToolCount
        : uniqueToolCallCount;
      authoritativeToolCalls = typeof snapshot.authoritativeToolCalls === 'number'
        ? snapshot.authoritativeToolCalls
        : null;
      expandedRounds = Object.create(null);
      roundVisibleLimit = 20;

      if (!opts.overlayOnly) {
        currentPlan = snapshot.currentPlan && hasSafePlanShape(snapshot.currentPlan)
          ? snapshot.currentPlan
          : null;
        frozenPlanId = snapshot.frozenPlanId || null;
        currentExecutionMode = snapshot.currentExecutionMode
          ? Object.assign({}, snapshot.currentExecutionMode)
          : null;
      }

      visible = !isPanelSuppressed()
        && !!(currentPlan || currentExecutionMode || roundRecords.length);
      if (visible || hostEl) {
        ensureMounted();
        fullRender();
      } else {
        applyVisibility();
      }
      if (hasRunningStep()) startTick();
      else if (isPlanComplete(currentPlan)) stopTick();
      notifyPetFoot();
      return true;
    } catch (e) {
      safeWarn('restoreFlowSnapshot', e);
      return false;
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
      goal: plan.goal,
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
      scheduleFlowPersist();
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
      renderTaskOverview();
      renderFooter();
      notifyPetFoot();
      scheduleFlowPersist();
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
      renderFooter();
      stopTick();
      applyVisibility();
      notifyPetFoot();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('markGraphComplete', e);
      teardownMounts();
    }
  }

  // ── 状态快照 Tab：会话检查点时间轴 ──

  function getActiveSessionIdForSnapshot() {
    try {
      if (window.ChatSessionStore
        && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
        return window.ChatSessionStore.getActiveSessionId() || 'default';
      }
    } catch (_e) { /* ignore */ }
    return 'default';
  }

  function formatSnapshotTime(userMessageTime, createdAt) {
    var ts = typeof userMessageTime === 'number' && isFinite(userMessageTime)
      ? userMessageTime
      : (createdAt ? Date.parse(createdAt) : NaN);
    if (!isFinite(ts)) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function snapshotRestoreIconHtml() {
    if (window.AppIcon && typeof window.AppIcon.html === 'function') {
      return window.AppIcon.html('restore', { width: 14, className: 'etl-snapshot-restore-icon' });
    }
    return '↩';
  }

  function renderSnapshotTimeline(payload) {
    if (!snapshotTimelineEl) return;
    try {
      var entries = payload && Array.isArray(payload.entries) ? payload.entries : [];
      var canRestore = snapshotCanRestoreFn ? !!snapshotCanRestoreFn() : true;
      snapshotTimelineEl.innerHTML = '';

      if (!canRestore) {
        var hint = document.createElement('div');
        hint.className = 'etl-snapshot-hint';
        hint.setAttribute('role', 'status');
        hint.textContent = '任务运行中或回滚进行中，请稍候再试。';
        snapshotTimelineEl.appendChild(hint);
      }

      var header = document.createElement('div');
      header.className = 'etl-snapshot-header';
      var label = document.createElement('span');
      label.className = 'etl-snapshot-header-label';
      label.textContent = '会话检查点';
      var count = document.createElement('span');
      count.className = 'etl-snapshot-header-count';
      count.textContent = entries.length ? (entries.length + ' 个节点') : '暂无节点';
      header.appendChild(label);
      header.appendChild(count);
      snapshotTimelineEl.appendChild(header);

      var desc = document.createElement('p');
      desc.className = 'etl-snapshot-desc';
      desc.textContent = '回滚到某条用户消息发送时的运行时；之后的对话与文件修改将被丢弃。';
      snapshotTimelineEl.appendChild(desc);

      if (!entries.length) {
        var empty = document.createElement('div');
        empty.className = 'etl-empty etl-snapshot-empty';
        empty.textContent = '发送用户消息后，将在此列出可回滚节点。';
        snapshotTimelineEl.appendChild(empty);
        return;
      }

      var list = document.createElement('ol');
      list.className = 'etl-snapshot-list';
      list.setAttribute('role', 'list');

      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry || !entry.messageId) continue;
        var isCursor = !!entry.isCursor;
        var li = document.createElement('li');
        li.className = 'etl-snapshot-node' + (isCursor ? ' is-cursor' : '');
        li.setAttribute('role', 'listitem');
        li.setAttribute('data-message-id', entry.messageId);

        var rail = document.createElement('div');
        rail.className = 'etl-snapshot-rail';
        rail.setAttribute('aria-hidden', 'true');
        var dot = document.createElement('span');
        dot.className = 'etl-snapshot-dot';
        rail.appendChild(dot);
        if (i < entries.length - 1) {
          var line = document.createElement('span');
          line.className = 'etl-snapshot-line';
          rail.appendChild(line);
        }

        var card = document.createElement('div');
        card.className = 'etl-snapshot-card';

        var meta = document.createElement('div');
        meta.className = 'etl-snapshot-meta';
        var indexEl = document.createElement('span');
        indexEl.className = 'etl-snapshot-index';
        indexEl.textContent = String(i + 1);
        var timeEl = document.createElement('time');
        timeEl.className = 'etl-snapshot-time';
        var timeText = formatSnapshotTime(entry.userMessageTime, entry.createdAt);
        if (timeText) timeEl.textContent = timeText;
        meta.appendChild(indexEl);
        meta.appendChild(timeEl);
        if (isCursor) {
          var cursorBadge = document.createElement('span');
          cursorBadge.className = 'etl-snapshot-badge';
          cursorBadge.textContent = '当前位置';
          meta.appendChild(cursorBadge);
        }

        var preview = document.createElement('div');
        preview.className = 'etl-snapshot-preview';
        preview.textContent = entry.preview || '（无消息摘要）';
        preview.title = entry.preview || '';

        card.appendChild(meta);
        card.appendChild(preview);

        if (!isCursor) {
          var restoreBtn = document.createElement('button');
          restoreBtn.type = 'button';
          restoreBtn.className = 'etl-snapshot-restore-btn';
          restoreBtn.setAttribute('data-message-id', entry.messageId);
          restoreBtn.innerHTML = snapshotRestoreIconHtml();
          if (window.AppIcon && typeof window.AppIcon.hydrate === 'function') {
            window.AppIcon.hydrate(restoreBtn);
          }
          restoreBtn.setAttribute('aria-label', '回滚到此消息');
          restoreBtn.title = '回滚到此消息';
          restoreBtn.disabled = !canRestore;
          restoreBtn.addEventListener('click', function (evt) {
            evt.preventDefault();
            evt.stopPropagation();
            var btn = evt.currentTarget;
            if (!btn || btn.disabled) return;
            var targetMessageId = btn.getAttribute('data-message-id');
            if (!targetMessageId) return;
            if (typeof snapshotRestoreHandler === 'function') {
              snapshotRestoreHandler(targetMessageId, btn);
            }
          });
          card.appendChild(restoreBtn);
        }

        li.appendChild(rail);
        li.appendChild(card);
        list.appendChild(li);
      }

      snapshotTimelineEl.appendChild(list);
    } catch (e) {
      safeWarn('renderSnapshotTimeline', e);
      if (snapshotTimelineEl) {
        snapshotTimelineEl.innerHTML = '<div class="etl-empty etl-snapshot-empty">检查点加载失败</div>';
      }
    }
  }

  function fetchSnapshotTimeline(sessionId, done) {
    var gen = ++snapshotFetchGeneration;
    var sid = sessionId || getActiveSessionIdForSnapshot();
    fetch('/api/sessions/' + encodeURIComponent(sid) + '/checkpoints', {
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).catch(function () {
      return null;
    }).then(function (data) {
      if (gen !== snapshotFetchGeneration) return;
      renderSnapshotTimeline(data || { entries: [] });
      if (typeof done === 'function') done(data);
    });
  }

  function refreshSnapshotTimeline() {
    try {
      if (activeTab !== 'snapshot' || !snapshotTimelineEl) return;
      fetchSnapshotTimeline(getActiveSessionIdForSnapshot());
    } catch (e) {
      safeWarn('refreshSnapshotTimeline', e);
    }
  }

  /**
   * 注册回滚回调（由 chat-page 注入，复用消息气泡回滚逻辑）。
   * @param {{ onRestore?: function, canRestore?: function }} handlers
   */
  function registerSnapshotHandlers(handlers) {
    handlers = handlers || {};
    snapshotRestoreHandler = typeof handlers.onRestore === 'function' ? handlers.onRestore : null;
    snapshotCanRestoreFn = typeof handlers.canRestore === 'function' ? handlers.canRestore : null;
    if (activeTab === 'snapshot') refreshSnapshotTimeline();
  }

  function notifySnapshotRestoreAvailability() {
    if (activeTab !== 'snapshot' || !snapshotTimelineEl) return;
    var list = snapshotTimelineEl.querySelector('.etl-snapshot-list');
    if (!list) {
      refreshSnapshotTimeline();
      return;
    }
    var canRestore = snapshotCanRestoreFn ? !!snapshotCanRestoreFn() : true;
    var hint = snapshotTimelineEl.querySelector('.etl-snapshot-hint');
    if (!canRestore && !hint) {
      hint = document.createElement('div');
      hint.className = 'etl-snapshot-hint';
      hint.setAttribute('role', 'status');
      hint.textContent = '任务运行中或回滚进行中，请稍候再试。';
      snapshotTimelineEl.insertBefore(hint, snapshotTimelineEl.firstChild);
    } else if (canRestore && hint) {
      hint.parentNode.removeChild(hint);
    }
    var btns = list.querySelectorAll('.etl-snapshot-restore-btn');
    Array.prototype.forEach.call(btns, function (btn) {
      btn.disabled = !canRestore;
    });
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
    // Phase 5 新增：LLM 动作 + 执行流轮次
    applyToolActivity: applyToolActivity,
    applyRoundActivity: applyRoundActivity,
    resetToolActivity: resetToolActivity,
    beginTurnTimer: beginTurnTimer,
    endTurnTimer: endTurnTimer,
    getFlowSnapshot: getFlowSnapshot,
    restoreFlowSnapshot: restoreFlowSnapshot,
    hydrateFromStructured: hydrateFromStructured,
    registerFlowPersist: registerFlowPersist,
    flushFlowPersist: flushFlowPersist,
    cancelFlowPersist: cancelFlowPersist,
    // TaskGraph（兼容）
    renderGraph: renderGraph,
    updateGraphNode: updateGraphNode,
    highlightGraphBranch: highlightGraphBranch,
    markGraphComplete: markGraphComplete,
    registerSnapshotHandlers: registerSnapshotHandlers,
    refreshSnapshotTimeline: refreshSnapshotTimeline,
    notifySnapshotRestoreAvailability: notifySnapshotRestoreAvailability,
  };
})();
