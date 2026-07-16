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

  /** 执行流 Tab 主体（当前步骤卡 + 计划列表 + LLM 动作 + 时间轴），桌面/移动共用 IDs。 */
  function flowPanelHtml() {
    return '<section class="etl-tabpanel" id="etl-panel-flow" data-panel="flow" role="tabpanel" aria-labelledby="etl-tab-flow">' +
      '<div class="etl-task-overview hidden" id="etl-task-overview"></div>' +
      '<div class="etl-round-timeline" id="etl-round-timeline">' +
        '<div class="etl-round-empty etl-empty">等待模型开始执行</div>' +
        '<ol class="etl-round-list"></ol>' +
      '</div>' +
      '<div class="etl-current-step hidden" id="etl-current-step"></div>' +
      '<div class="etl-empty etl-plan-empty hidden">本次任务无结构化执行计划</div>' +
      '<ol class="exec-plan-list" id="exec-plan-list"></ol>' +
      '<div class="etl-llm-activity hidden" id="etl-llm-activity" aria-live="polite"></div>' +
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
    taskOverviewEl = host.querySelector('#etl-task-overview');
    roundTimelineEl = host.querySelector('#etl-round-timeline');
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
        '<section class="etl-tabpanel hidden" id="etl-panel-snapshot" data-panel="snapshot" role="tabpanel" aria-labelledby="etl-tab-snapshot">' +
          '<div class="etl-empty">开发中。。。</div>' +
        '</section>' +
      '</div>' +
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

  /** 右下角时间：从本轮用户发送开始，到最终回复/停止/异常结束。 */
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

  function renderFooter() {
    if (!footerEl) return;
    var tokenTxt = formatTokenStat();
    var liveToolCount = authoritativeToolCalls === null
      ? uniqueToolCallCount
      : authoritativeToolCalls + Math.max(0, uniqueToolCallCount - calibratedUniqueToolCount);
    var toolTxt = liveToolCount > 0 || authoritativeToolCalls !== null ? String(liveToolCount) : '—';
    var timeTxt = formatTurnElapsed();
    footerEl.innerHTML = '';

    footerEl.appendChild(makeFootItem('etl-foot-token', '上下文', tokenTxt));
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

  function formatToolArgsPreview(toolName, args) {
    try {
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
    parse_document: true, parse_pptx_deep: true, open_file: true,
    read_image: true, xmind_parse: true, xlsx_parse: true,
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
      if (CONTEXT_SEARCH_TOOLS[toolName]) return String(args.pattern || args.query || '');
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
    if (name === 'xlsx_parse') return '解析表格' + hint;
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
    return (name ? '调用 ' + name : '调用工具') + hint;
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
    if (!record) {
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
    return record;
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
      var record = ensureRoundRecord(evt.iteration, ts);
      if (evt.type === 'model_round_end' || evt.type === 'model_task_final') {
        record.endTs = ts;
        record.status = 'done';
        if (evt.stopReason) record.stopReason = String(evt.stopReason);
      }
      if (evt.type === 'model_task_final') {
        // 最终轮：标记任务完成，供轮次卡展示「已完成」结果。
        record.isFinal = true;
        markRoundsComplete(record.iteration);
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
      renderTaskOverview();
      renderRoundTimeline();
      renderEmptyState();
      if (typeof turnStartedAt === 'number' && turnEndedAt === null) startTick();
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

  function makeRoundToolRow(tool) {
    var row = document.createElement('li');
    row.className = 'etl-round-tool status-' + toolStatusClass(tool.status);
    row.dataset.toolCallId = tool.toolCallId;
    row.dataset.status = tool.status;
    if (typeof tool.callTs === 'number') row.dataset.callTs = String(tool.callTs);
    if (typeof tool.resultTs === 'number') row.dataset.resultTs = String(tool.resultTs);
    var icon = document.createElement('span');
    icon.className = 'etl-round-tool-icon';
    icon.textContent = toolStatusClass(tool.status) === 'done'
      ? '✓'
      : (toolStatusClass(tool.status) === 'failed' ? '×' : '•');
    var text = document.createElement('span');
    text.className = 'etl-round-tool-text';
    text.textContent = tool.toolName + (tool.detail ? ' · ' + tool.detail : '');
    var dur = document.createElement('span');
    dur.className = 'etl-round-tool-duration';
    dur.textContent = formatToolDuration(tool);
    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(dur);
    return row;
  }

  function makeRoundNode(record) {
    var tools = getRoundTools(record);
    var item = document.createElement('li');
    item.className = 'etl-round-node status-' + (record.status === 'done' ? 'done' : 'running')
      + (record.isFinal ? ' is-final' : '');
    item.dataset.iteration = String(record.iteration);

    var marker = document.createElement('span');
    marker.className = 'etl-round-marker';
    marker.textContent = record.isFinal ? '✓' : String(record.iteration);
    item.appendChild(marker);

    var card = document.createElement('div');
    card.className = 'etl-round-card';
    var head = document.createElement('div');
    head.className = 'etl-round-head';
    var title = document.createElement('span');
    title.className = 'etl-round-title';
    title.textContent = '第 ' + record.iteration + ' 轮'
      + (record.phase ? ' · ' + (PHASE_LABELS[record.phase] || record.phase) : '');
    var time = document.createElement('span');
    time.className = 'etl-round-duration';
    time.textContent = roundDuration(record);
    head.appendChild(title);
    head.appendChild(time);
    card.appendChild(head);

    var actionLabel = document.createElement('div');
    actionLabel.className = 'etl-round-section-label';
    actionLabel.textContent = record.isFinal ? '本轮结果' : '本轮做了什么';
    card.appendChild(actionLabel);
    if (tools.length) {
      var toolList = document.createElement('ul');
      toolList.className = 'etl-round-tools';
      for (var i = 0; i < tools.length; i++) toolList.appendChild(makeRoundToolRow(tools[i]));
      card.appendChild(toolList);
    }
    if (record.isFinal) {
      var completion = document.createElement('div');
      completion.className = 'etl-round-complete';
      completion.textContent = roundCompletionText(record);
      card.appendChild(completion);
    } else if (!tools.length) {
      var planning = document.createElement('div');
      planning.className = 'etl-round-action';
      planning.textContent = record.activeTitle || '分析目标并生成下一步动作';
      card.appendChild(planning);
    }

    var reasonLabel = document.createElement('div');
    reasonLabel.className = 'etl-round-section-label';
    reasonLabel.textContent = '为什么这么做';
    var reason = document.createElement('div');
    reason.className = 'etl-round-reason';
    reason.textContent = deriveRoundReason(record);
    card.appendChild(reasonLabel);
    card.appendChild(reason);
    item.appendChild(card);
    return item;
  }

  function renderTaskOverview() {
    if (!taskOverviewEl) return;
    try {
      if (!currentPlan) {
        taskOverviewEl.innerHTML = '';
        taskOverviewEl.classList.add('hidden');
        return;
      }
      var active = pickActiveStep(currentPlan);
      var intent = INTENT_LABELS[currentPlan.intent] || currentPlan.intent || '未分类';
      var phase = active && active.phase ? (PHASE_LABELS[active.phase] || active.phase) : '已结束';
      taskOverviewEl.innerHTML = '';
      var goal = document.createElement('div');
      goal.className = 'etl-overview-goal';
      goal.textContent = currentPlan.goal || (active && active.title) || '当前任务';
      var meta = document.createElement('div');
      meta.className = 'etl-overview-meta';
      meta.textContent = '意图：' + intent + ' · 阶段：' + phase
        + ' · 进度：' + Math.max(0, Math.min(100, currentPlan.progress || 0)) + '%';
      taskOverviewEl.appendChild(goal);
      taskOverviewEl.appendChild(meta);
      taskOverviewEl.classList.remove('hidden');
    } catch (e) {
      safeWarn('renderTaskOverview', e);
    }
  }

  function renderRoundTimeline() {
    if (!roundTimelineEl) return;
    try {
      var empty = roundTimelineEl.querySelector('.etl-round-empty');
      var list = roundTimelineEl.querySelector('.etl-round-list');
      if (empty) empty.classList.toggle('hidden', roundRecords.length > 0);
      if (!list) return;
      list.innerHTML = '';
      for (var i = 0; i < roundRecords.length; i++) {
        snapshotRoundPlan(roundRecords[i]);
        list.appendChild(makeRoundNode(roundRecords[i]));
      }
    } catch (e) {
      safeWarn('renderRoundTimeline', e);
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
      if (step.type === 'tool_call') {
        var callId = typeof step.toolCallId === 'string' ? step.toolCallId : '';
        if (!callId) return;
        var toolName = typeof step.toolName === 'string' ? step.toolName : '';
        var callTs = typeof step.ts === 'number' ? step.ts : Date.now();
        var round = ensureRoundRecord(step.iteration, callTs);
        if (!toolRecordById[callId]) {
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
          }
        }
        lastTool = { toolCallId: callId, toolName: toolName, pending: true, ts: callTs };
        renderTaskOverview();
        renderRoundTimeline();
        renderEmptyState();
        renderLlmActivity();
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
          if (!matched.toolName && typeof step.toolName === 'string') {
            matched.toolName = step.toolName;
          }
          var matchedRound = ensureRoundRecord(matched.iteration, matched.callTs);
          if (matched.resultTs > (matchedRound.endTs || 0)) matchedRound.endTs = matched.resultTs;
          var roundTools = getRoundTools(matchedRound);
          var allDone = roundTools.length > 0;
          for (var ri = 0; ri < roundTools.length; ri++) {
            if (toolStatusClass(roundTools[ri].status) === 'running') allDone = false;
          }
          if (allDone) matchedRound.status = 'done';
        }
        if (lastTool.pending && resultId && lastTool.toolCallId === resultId) {
          lastTool.pending = false;
          renderLlmActivity();
        }
        renderRoundTimeline();
      }
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
      renderTaskOverview();
      renderRoundTimeline();
      renderEmptyState();
      renderLlmActivity();
      renderFooter();
    } catch (e) {
      safeWarn('resetToolActivity', e);
    }
  }

  function beginTurnTimer(ts) {
    try {
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
      if (isPlanComplete(currentPlan) && !hasRunningStep()) stopTick();
    } catch (e) {
      safeWarn('endTurnTimer', e);
    }
  }

  // ── 全量渲染 ──

  function fullRender() {
    if (!ensureMounted()) throw new Error('执行透明层挂载失败');
    renderExecutionModeBanner();
    renderTaskOverview();
    renderRoundTimeline();
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
      roundRecords = [];
      roundRecordByIteration = Object.create(null);
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
        renderRoundTimeline();
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
      renderRoundTimeline();
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
    // Phase 5 新增：LLM 动作 + 执行流轮次
    applyToolActivity: applyToolActivity,
    applyRoundActivity: applyRoundActivity,
    resetToolActivity: resetToolActivity,
    beginTurnTimer: beginTurnTimer,
    endTurnTimer: endTurnTimer,
    // TaskGraph（兼容）
    renderGraph: renderGraph,
    updateGraphNode: updateGraphNode,
    highlightGraphBranch: highlightGraphBranch,
    markGraphComplete: markGraphComplete,
  };
})();
