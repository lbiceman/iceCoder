// @ts-nocheck
/**
 * 执行透明层（ETL）— 右侧停靠侧边栏。
 *
 * 结构：头部 → 监管条 → 工作台（上：检查点章节 / 下：本章执行流）→ 文件层 → Footer。
 * 点章节打开下边执行流；回滚按钮在章节标题右侧，逻辑复用现有检查点回滚。
 * Observer 红线：只消费事件、不影响事件；所有入口 try/catch，异常降级为空 UI，绝不 throw 冒泡。
 */

/* exported ChatExecutionPlan */

export const ChatExecutionPlan = (() => {

  const PANEL_ID = 'exec-transparency-panel';
  // Observer 必须同步、快速返回；异常大的计划不应把浏览器事件循环拖死。
  const MAX_RENDER_STEPS = 500;
  const MAX_TOOL_HISTORY = 4000;
  const MAX_ROUND_HISTORY = 400;
  const MAX_TOOLS_PER_ROUND_DOM = 80;

  const STATE_LABELS = {
    pending: '待执行',
    running: '进行中',
    done: '已完成',
    failed: '失败',
    skipped: '已跳过',
    fallback: '备选',
  };

  const STATE_ICONS = {
    pending: '⬜',
    running: '🔄',
    done: '✅',
    failed: '❌',
    skipped: '⏭️',
    fallback: '🔀',
  };

  const INTENT_LABELS = {
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
  const MODE_SIGNAL_LABELS = {
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

  const DEGRADED_LABELS = {
    graph: '图构建降级',
    step_queue: '步骤队列降级',
    write_intent: '写入意图降级',
  };

  let currentPlan = null;
  let frozenPlanId = null;
  let currentExecutionMode = null;
  let visible = false;
  let capabilityEnabled = true;
  let pageActive = true;
  let minimized = false;

  let rootEl = null;
  let listEl = null;
  let modeBannerEl = null;
  let currentStepEl = null;
  let emptyStateEl = null;
  let footerEl = null;
  let llmActivityEl = null;
  let taskOverviewEl = null;
  let roundTimelineEl = null;
  let snapshotFilesEl = null;
  /** 底栏弹出层：'' 关闭；files 变更文件；tools 本会话工具名。 */
  let dockSheetKind = '';
  let snapshotRestoreHandler = null;
  let snapshotCanRestoreFn = null;
  let snapshotFetchGeneration = 0;
  /** 最近一次 /checkpoints 时间轴上的 messageId，比聊天气泡内存集合更权威。 */
  let snapshotCheckpointIds = Object.create(null);
  let snapshotCheckpointEntries = [];
  let snapshotCursorMessageId = '';
  let snapshotCursorRestored = false;
  /** 检查点时间轴下发的会话改动文件（只读 sessionTouchedPaths，不另存）。 */
  let snapshotChangedFiles = [];
  let snapshotFilesRefreshTimer = 0;

  // 挂载模式与承载容器：桌面 = 右侧停靠 aside；移动 = 顶部条 + 底部 sheet（设计 §6）。
  let mountedMode = null;      // 'desktop' | 'mobile'
  let hostEl = null;          // 承载工作台/footer 的容器（桌面=rootEl，移动=mobileSheetEl）
  let mobileBarEl = null;      // 移动端顶部一行入口「执行 X/N ▸」
  let mobileSheetEl = null;    // 移动端底部 sheet
  let mobileBackdropEl = null; // 移动端 sheet 蒙层

  let tickTimer = null;
  let turnStartedAt = null;
  let turnEndedAt = null;
  let resizeBound = false;
  let footerStats = { totalTokenUsage: null, totalToolCalls: null };
  let toolRecords = [];
  let toolRecordById = Object.create(null);
  let toolCallIds = Object.create(null);
  let uniqueToolCallCount = 0;
  let authoritativeToolCalls = null;
  let calibratedUniqueToolCount = 0;

  // LLM 当前动作：仅记录最近一次工具调用及其是否已返回；不读取任何 reasoning/thinking 文本。
  let lastTool = { toolCallId: '', toolName: '', pending: false, ts: 0 };
  // 本轮模型循环，只保存结构化执行信息；绝不保存 thinking/reasoning 正文。
  let roundRecords = [];
  let roundRecordByIteration = Object.create(null);
  let expandedRounds = Object.create(null);
  let bannerDetailOpen = false;
  let roundVisibleLimit = 20;
  let roundTimelineBound = false;
  let roundTimelineBoundEl = null;
  let roundTimelineClickHandler = null;
  let roundTimelineKeydownHandler = null;
  let cachedLoadMoreHidden = -1;
  let flowPersistTimer = null;
  let flowPersistHandler = null;
  /** 已封存的历史章（不含当前活章）。 */
  let sealedChapters = [];
  /** 当前活章元数据：{ messageId, preview, startedAt, markers, status } */
  let liveChapterMeta = null;
  let selectedChapterKey = '';
  let userPinnedChapter = false;
  let chapterVisibleLimit = 30;
  let chapterTimelineEl = null;
  let sealedToolCount = 0;
  let pendingRevealMessageId = '';
  let chapterTimelineBound = false;
  let chapterClickHandler = null;
  let filesSheetBound = false;
  let filesSheetDocHandler = null;

  function safeWarn(where, err) {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[ChatExecutionPlan] ${where} 降级：`, err);
      }
    } catch (_e) { /* ignore */ }
  }

  function safeSetTitle(el, text) {
    if (!el) return;
    try {
      el.title = text == null ? '' : String(text);
    } catch (_e) { /* tooltip 能力缺失时忽略 */ }
  }

  // ── 偏好读取（EtlPrefs）──

  function pref(key, fallback) {
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.getKey === 'function') {
        const v = window.EtlPrefs.getKey(key);
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
      let w = pref('panelWidth', 320);
      w = typeof w === 'number' ? w : parseInt(w, 10);
      if (!isFinite(w)) w = 320;
      const allowed = [280, 320, 380];
      let best = allowed[0];
      let bestDist = Math.abs(w - best);
      for (let i = 1; i < allowed.length; i++) {
        const d = Math.abs(w - allowed[i]);
        if (d < bestDist) {
          best = allowed[i];
          bestDist = d;
        }
      }
      w = best;
      document.documentElement.style.setProperty('--etl-w', `${w}px`);
    } catch (_e) { /* ignore */ }
  }

  // ── 时间格式化 ──

  function pad2(n) {
    return n < 10 ? `0${n}` : `${n}`;
  }

  function formatClock(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }

  /** 检查点耗时：带单位，避免 09:09 被看成钟点。 */
  function formatElapsedHuman(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}小时${m}分${s}秒`;
    if (m > 0) {
      if (s === 0) return `${m}分`;
      return `${m}分${s}秒`;
    }
    return `${s}秒`;
  }

  function formatStepDuration(step) {
    if (!step || typeof step.startedAt !== 'number') return '';
    const end = typeof step.endedAt === 'number' ? step.endedAt : Date.now();
    let ms = end - step.startedAt;
    if (ms < 0) ms = 0;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return formatClock(ms);
  }

  function formatThousands(n) {
    try {
      return Number(n).toLocaleString('en-US');
    } catch (_e) {
      return `${n}`;
    }
  }

  /** 底栏上下文：小于 1K 原样，1K–1M 用 K，更大用 M。 */
  function formatCompactCount(n) {
    const num = Number(n);
    if (!isFinite(num) || num < 0) return '0';
    if (num < 1000) return String(Math.round(num));
    function oneDecimal(x) {
      return String(Math.round(x * 10) / 10);
    }
    if (num < 1000000) {
      return (num < 10000 ? oneDecimal(num / 1000) : String(Math.round(num / 1000))) + 'K';
    }
    return `${oneDecimal(num / 1000000)}M`;
  }

  // ── 计划状态工具 ──

  function countFinished(steps) {
    let n = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i].status;
      if (s === 'done' || s === 'failed' || s === 'skipped') n++;
    }
    return n;
  }

  function hasSafePlanShape(plan) {
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) return false;
    for (let i = 0; i < plan.steps.length; i++) {
      if (!plan.steps[i] || typeof plan.steps[i] !== 'object') return false;
    }
    return true;
  }

  /** 计划是否已全部结束（进度 100 或所有步骤进入终态） */
  function isPlanComplete(plan) {
    if (!plan) return true;
    if (typeof plan.progress === 'number' && plan.progress >= 100) return true;
    if (!plan.steps || !plan.steps.length) return false;
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i].status;
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
      for (let i = 0; i < plan.steps.length; i++) {
        if (plan.steps[i].id === plan.activeStepId) return plan.steps[i];
      }
    }
    for (let j = 0; j < plan.steps.length; j++) {
      if (plan.steps[j].status === 'running') return plan.steps[j];
    }
    for (let k = 0; k < plan.steps.length; k++) {
      if (plan.steps[k].status === 'pending') return plan.steps[k];
    }
    return plan.steps[plan.steps.length - 1] || null;
  }

  function hasRunningStep() {
    if (!currentPlan || !currentPlan.steps) return false;
    for (let i = 0; i < currentPlan.steps.length; i++) {
      const st = currentPlan.steps[i];
      if (st.status === 'running' && typeof st.startedAt === 'number' && typeof st.endedAt !== 'number') {
        return true;
      }
    }
    return false;
  }

  function clamp40(s) {
    if (!s) return '';
    const str = String(s);
    return str.length > 40 ? `${str.slice(0, 39)}…` : str;
  }

  function clamp24(s) {
    if (!s) return '';
    const str = String(s);
    return str.length > 24 ? `${str.slice(0, 23)}…` : str;
  }

  // ── 挂载 ──

  function minimizeIconHtml() {
    return '<span class="etl-min-icon" aria-hidden="true"></span>';
  }

  function headerActionsHtml() {
    return `<button type="button" class="etl-minimize" title="最小化" aria-label="最小化面板">${minimizeIconHtml()}</button>`;
  }

  function filesSheetHtml() {
    return `<div class="etl-files-sheet hidden" id="etl-snapshot-files"><div class="etl-files-sheet-head"><span class="etl-files-sheet-title">变更文件</span><span class="etl-snapshot-header-count" id="etl-snapshot-files-count">暂无文件</span><button type="button" class="etl-files-sheet-close" id="etl-files-sheet-close" title="收起" aria-label="收起">${minimizeIconHtml()}</button></div><div class="etl-files-sheet-body"><div class="etl-empty etl-snapshot-files-empty">尚无变更文件</div><ol class="etl-snapshot-files-list hidden" id="etl-snapshot-files-list"></ol></div></div>`;
  }

  /** 单工作台：上检查点章节，下本章执行流，文件层叠在底栏上方。 */
  function workbenchHtml() {
    return `<div class="etl-body etl-workbench"><section class="etl-wb-chapters" id="etl-chapter-timeline"><div class="etl-wb-section-head"><div class="etl-wb-section-header"><span class="etl-wb-section-title">检查点</span><span class="etl-wb-section-count" id="etl-chapter-node-count"></span></div><p class="etl-wb-desc">回溯到某个检查点可以恢复到该时间点的状态，同时包含本次执行的完整上下文。</p></div><div class="etl-chapter-empty etl-empty">等待模型开始执行</div><button type="button" class="etl-chapter-load-more hidden" id="etl-chapter-load-more">加载更早的章节 ↑</button><ol class="etl-chapter-list"></ol></section><section class="etl-wb-flow" id="etl-panel-flow"><div class="etl-wb-section-head"><div class="etl-wb-section-header"><span class="etl-wb-section-title">执行流</span><span class="etl-wb-section-count" id="etl-flow-step-count"></span></div></div><div class="etl-task-overview hidden" id="etl-task-overview"></div><div class="etl-current-step hidden" id="etl-current-step"></div><div class="etl-round-timeline" id="etl-round-timeline"><div class="etl-round-empty etl-empty hidden">等待模型开始执行</div><div class="etl-round-prefix-hint hidden" id="etl-round-prefix-hint" role="note"></div><button type="button" class="etl-round-load-more hidden" id="etl-round-load-more">加载更早的轮次 ↓</button><ol class="etl-round-list"></ol></div><div class="etl-empty etl-plan-empty hidden">本次任务无结构化执行计划</div><ol class="exec-plan-list" id="exec-plan-list"></ol><div class="etl-llm-activity hidden" id="etl-llm-activity" aria-live="polite"></div></section>${filesSheetHtml()}</div>`;
  }

  function sharedBodyHtml() {
    return workbenchHtml();
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
    chapterTimelineEl = host.querySelector('#etl-chapter-timeline');
    snapshotFilesEl = host.querySelector('#etl-snapshot-files');
    bindRoundTimelineEvents();
    bindChapterTimelineEvents();
    bindFilesSheetControls();
    renderDockSheet();
    if (window.EtlShellDock && typeof window.EtlShellDock.mount === 'function') {
      const dockHost = host.querySelector('#etl-shell-dock-host');
      if (dockHost) window.EtlShellDock.mount(dockHost);
      if (window.ChatPage && typeof window.ChatPage.syncShellDockOnMount === 'function') {
        window.ChatPage.syncShellDockOnMount();
      }
    }
  }

  /** 绑定最小化按钮（桌面/移动共用）。 */
  function bindHostControls(host) {
    const minBtn = host.querySelector('.etl-minimize');
    if (minBtn) {
      minBtn.addEventListener('click', () => {
        minimize();
      });
    }
  }

  function ensureMounted() {
    try {
      const wantMobile = isMobileShell();
      const wantMode = wantMobile ? 'mobile' : 'desktop';
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
    chapterTimelineEl = null;
    snapshotFilesEl = null;
    unbindRoundTimelineEvents();
    unbindChapterTimelineEvents();
    unbindFilesSheetControls();
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
      `<header class="etl-header"><span class="etl-title">iceCoder工作台</span>${headerActionsHtml()}</header><div class="etl-main-scroll"><div class="exec-plan-mode-banner hidden" id="exec-plan-mode-banner"></div>${sharedBodyHtml()}</div><div class="etl-shell-dock-host" id="etl-shell-dock-host"></div><footer class="etl-footer" id="etl-footer"></footer>`;

    document.body.appendChild(rootEl);
    hostEl = rootEl;
    mountedMode = 'desktop';
    grabHostRefs(rootEl);
    bindHostControls(rootEl);
  }

  /** 移动端：顶部一行入口 + 底部 sheet（与桌面同一工作台，无 Tab）。 */
  function mountMobile() {

    mobileBarEl = document.createElement('button');
    mobileBarEl.type = 'button';
    mobileBarEl.className = 'etl-mbar';
    mobileBarEl.setAttribute('aria-label', '展开执行透明层');
    mobileBarEl.innerHTML = '<span class="etl-mbar-text">执行透明层 ▸</span>';
    mobileBarEl.addEventListener('click', () => {
      if (minimized) expand();
      else minimize();
    });

    mobileBackdropEl = document.createElement('div');
    mobileBackdropEl.className = 'etl-mbackdrop';
    mobileBackdropEl.addEventListener('click', () => {
      minimize();
    });

    mobileSheetEl = document.createElement('aside');
    mobileSheetEl.id = PANEL_ID;
    mobileSheetEl.className = 'etl-msheet';
    mobileSheetEl.setAttribute('role', 'complementary');
    mobileSheetEl.setAttribute('aria-label', 'iceCoder工作台');
    mobileSheetEl.setAttribute('aria-hidden', 'true');
    mobileSheetEl.innerHTML =
      `<div class="etl-msheet-handle" aria-hidden="true"></div><header class="etl-header"><span class="etl-title">iceCoder工作台</span>${headerActionsHtml()}</header><div class="etl-main-scroll"><div class="exec-plan-mode-banner hidden" id="exec-plan-mode-banner"></div>${sharedBodyHtml()}</div><div class="etl-shell-dock-host" id="etl-shell-dock-host"></div><footer class="etl-footer" id="etl-footer"></footer>`;

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

  let mobileEscapeBound = false;
  function bindMobileEscape() {
    if (mobileEscapeBound) return;
    mobileEscapeBound = true;
    document.addEventListener('keydown', (event) => {
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

  let resizeTimer = null;
  function onResizeReflow() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
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
    let top = 0;
    try {
      const nav = document.getElementById('top-nav');
      if (nav && nav.getBoundingClientRect) {
        top = Math.max(0, nav.getBoundingClientRect().bottom);
      }
    } catch (_e) { /* ignore */ }
    return top;
  }

  /** 桌面：top 由 #top-nav 底缘决定（不存在则贴顶） */
  function layoutTop() {
    if (!rootEl) return;
    rootEl.style.top = `${navBottom()}px`;
  }

  /** 移动：顶部条贴 #top-nav 底缘。 */
  function layoutMobileBar() {
    if (!mobileBarEl) return;
    mobileBarEl.style.top = `${navBottom()}px`;
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
    const textEl = mobileBarEl.querySelector('.etl-mbar-text');
    if (!textEl) return;
    const arrow = minimized ? '▸' : '▾';
    if (currentPlan && currentPlan.steps && currentPlan.steps.length) {
      const total = currentPlan.steps.length;
      const done = countFinished(currentPlan.steps);
      textEl.textContent = `执行 ${done}/${total} ${arrow}`;
    } else {
      textEl.textContent = `执行透明层 ${arrow}`;
    }
  }

  function startTick() {
    if (tickTimer || (isPlanComplete(currentPlan) && turnStartedAt === null)) return;
    tickTimer = setInterval(() => {
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
      const active = pickActiveStep(currentPlan);
      const elapsedEl = currentStepEl.querySelector('.etl-cs-elapsed');
      if (elapsedEl && active) elapsedEl.textContent = formatStepDuration(active);
    }
    // 列表内运行中步骤耗时
    if (listEl && currentPlan && currentPlan.steps) {
      for (let i = 0; i < currentPlan.steps.length; i++) {
        const st = currentPlan.steps[i];
        if (st.status === 'running' && typeof st.startedAt === 'number' && typeof st.endedAt !== 'number') {
          const node = listEl.querySelector(`.exec-plan-step[data-step-id="${st.id}"] .exec-plan-step-dur`);
          if (node) node.textContent = formatStepDuration(st);
        }
      }
    }
    if (roundTimelineEl) {
      for (let rr = 0; rr < roundRecords.length; rr++) {
        const roundNode = roundTimelineEl.querySelector(
          `.etl-round-node[data-iteration="${roundRecords[rr].iteration}"]`,
        );
        const roundTime = roundNode && roundNode.querySelector('.etl-round-duration');
        if (roundTime) roundTime.textContent = roundDuration(roundRecords[rr]);
      }
    }
    const timeElFoot = footerEl && footerEl.querySelector('.etl-foot-time');
    if (timeElFoot && timeElFoot.parentNode) timeElFoot.parentNode.removeChild(timeElFoot);
    patchCurrentChapterChrome();
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

    const steps = currentPlan.steps;
    const total = steps.length;
    const active = pickActiveStep(currentPlan);
    const idx = active ? steps.indexOf(active) : -1;
    const stepNo = idx >= 0 ? idx + 1 : countFinished(steps);
    const done = countFinished(steps);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const statusLabel = active ? (STATE_LABELS[active.status] || active.status) : '';
    const icon = active ? (STATE_ICONS[active.status] || '') : '';
    const dur = active ? formatStepDuration(active) : '';
    const title = active ? clamp40(active.title) : '';
    const complete = isPlanComplete(currentPlan);

    currentStepEl.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'etl-cs-head';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'etl-cs-title';
    titleSpan.textContent = `步骤 ${stepNo}/${total}：${title}`;
    const elapsed = document.createElement('span');
    elapsed.className = 'etl-cs-elapsed';
    elapsed.textContent = dur;
    head.appendChild(titleSpan);
    head.appendChild(elapsed);
    currentStepEl.appendChild(head);

    const bar = document.createElement('div');
    bar.className = 'etl-cs-progress';
    const fill = document.createElement('div');
    fill.className = 'etl-cs-bar';
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    currentStepEl.appendChild(bar);

    const statusRow = document.createElement('div');
    statusRow.className = 'etl-cs-status status-' + (active ? active.status : 'pending');
    statusRow.textContent = complete
      ? `✅ 已完成 · 用时 ${formatPlanTotalTime()}`
      : (icon ? `${icon} ` : '') + statusLabel;
    currentStepEl.appendChild(statusRow);

    if (active && active.evidence) {
      const ev = document.createElement('div');
      ev.className = 'etl-cs-evidence';
      ev.textContent = clamp40(active.evidence);
      ev.title = active.evidence;
      currentStepEl.appendChild(ev);
    }
  }

  // ── 渲染：执行计划列表 ──

  function renderStepNode(step, isActive) {
    const li = document.createElement('li');
    const branchClass = step.isFallback ? ' exec-plan-step--fallback' : (step.isResumed ? ' exec-plan-step--resumed' : '');
    li.className = 'exec-plan-step status-' + step.status + (isActive ? ' active' : '') + branchClass;
    li.dataset.stepId = step.id;
    if (step.isFallback) li.dataset.branch = 'fallback';
    else if (step.isResumed) li.dataset.branch = 'resumed';

    const head = document.createElement('div');
    head.className = 'exec-plan-step-head';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'exec-plan-step-title';
    titleSpan.textContent = clamp40(step.title);
    const badge = document.createElement('span');
    badge.className = 'exec-plan-step-badge';
    badge.textContent = STATE_LABELS[step.status] || step.status;
    const dur = document.createElement('span');
    dur.className = 'exec-plan-step-dur';
    dur.textContent = formatStepDuration(step);
    head.appendChild(titleSpan);
    head.appendChild(badge);
    head.appendChild(dur);
    li.appendChild(head);

    if (step.suggestedTools && step.suggestedTools.length > 0) {
      const tools = document.createElement('div');
      tools.className = 'exec-plan-step-tools';
      tools.textContent = `工具：${step.suggestedTools.join('、')}`;
      li.appendChild(tools);
    }

    if (step.evidence) {
      const ev = document.createElement('div');
      ev.className = 'exec-plan-step-evidence';
      ev.textContent = `证据：${clamp40(step.evidence)}`;
      ev.title = step.evidence;
      li.appendChild(ev);
    }

    if (step.status === 'failed' && step.error) {
      const err = document.createElement('div');
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
    const steps = currentPlan.steps || [];
    if (!Array.isArray(steps) || steps.length > MAX_RENDER_STEPS) return;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== 'object') continue;
      const isActive = step.id === currentPlan.activeStepId;
      listEl.appendChild(renderStepNode(step, isActive));
    }
  }

  function hasSealableWork() {
    return roundRecords.length > 0 || uniqueToolCallCount > 0 || !!currentPlan;
  }

  function hasLiveChapterWork() {
    if (liveChapterMeta) return true;
    return hasSealableWork() || !!currentExecutionMode;
  }

  function hasChronicleWork() {
    return sealedChapters.length > 0 || hasLiveChapterWork();
  }

  function renderEmptyState() {
    if (!emptyStateEl) return;
    emptyStateEl.classList.toggle('hidden', !!currentPlan || roundRecords.length > 0 || sealedChapters.length > 0);
  }

  function applyPatchToStep(stepEl, patch) {
    if (!stepEl) return;
    if (patch.status) {
      stepEl.classList.remove('status-pending', 'status-running', 'status-done', 'status-failed', 'status-skipped', 'status-fallback');
      stepEl.classList.add(`status-${patch.status}`);
      const badge = stepEl.querySelector('.exec-plan-step-badge');
      if (badge) badge.textContent = STATE_LABELS[patch.status] || patch.status;
    }
    const durEl = stepEl.querySelector('.exec-plan-step-dur');
    if (durEl) {
      const stepId = stepEl.dataset.stepId;
      const stepObj = currentPlan && currentPlan.steps
        ? currentPlan.steps.find((s) =>  s.id === stepId)
        : null;
      if (stepObj) durEl.textContent = formatStepDuration(stepObj);
    }
    if (patch.evidence !== undefined) {
      let evEl = stepEl.querySelector('.exec-plan-step-evidence');
      if (!evEl) {
        evEl = document.createElement('div');
        evEl.className = 'exec-plan-step-evidence';
        stepEl.appendChild(evEl);
      }
      evEl.textContent = `证据：${clamp40(patch.evidence)}`;
      evEl.title = patch.evidence;
    }
    if (patch.error) {
      let errEl = stepEl.querySelector('.exec-plan-step-error');
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
        const endc = isPlanComplete(currentPlan) && typeof currentPlan.updatedAt === 'number'
          ? currentPlan.updatedAt : Date.now();
        return formatClock(endc - currentPlan.createdAt);
      }
      return '00:00';
    }
    let start = null;
    let end = null;
    let running = false;
    const steps = currentPlan.steps;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
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
    let e;
    if (isPlanComplete(currentPlan)) {
      e = typeof currentPlan.updatedAt === 'number'
        ? currentPlan.updatedAt
        : (end !== null ? end : Date.now());
    } else {
      e = running ? Date.now() : (end !== null ? end : Date.now());
    }
    return formatClock(e - start);
  }

  /** 检查点序号右侧：最近一次对话从发出到做完的耗时。 */
  function formatTurnElapsed() {
    return formatElapsedHuman(liveChapterDurationMs());
  }

  function formatTokenStat(compact) {
    const t = footerStats.totalTokenUsage;
    if (!t) return '—';
    const used = typeof t.effectiveUsed === 'number' && t.effectiveUsed > 0 ? t.effectiveUsed : (t.inputTokens || 0);
    const win = typeof t.contextWindow === 'number' ? t.contextWindow : 0;
    const usedTxt = compact ? formatCompactCount(used) : formatThousands(used);
    if (!win) return usedTxt;
    const pct = ((used / win) * 100).toFixed(1);
    const winTxt = compact ? formatCompactCount(win) : formatThousands(win);
    return `${usedTxt}/${winTxt} (${pct}%)`;
  }

  function ensureFooterSkeleton() {
    if (!footerEl) return;
    const leftoverTime = footerEl.querySelector('.etl-foot-time');
    if (leftoverTime && leftoverTime.parentNode) leftoverTime.parentNode.removeChild(leftoverTime);
    if (footerEl.querySelector('.etl-foot-token')) return;
    footerEl.innerHTML = '';
    footerEl.appendChild(makeFootItem('etl-foot-token', '上下文', '—'));
    footerEl.appendChild(makeFootToggleItem(
      'etl-foot-tool', 'etl-foot-tool', '工具', '—',
      '本会话使用过的工具，点击查看', 'tools'
    ));
    footerEl.appendChild(makeFootToggleItem(
      'etl-foot-files', 'etl-foot-files', '文件', '0',
      '本会话变更的文件，点击查看', 'files'
    ));
  }

  function makeFootToggleItem(id, extraClass, label, initial, title, kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `etl-foot-item etl-foot-toggle ${extraClass}`;
    btn.id = id;
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'etl-snapshot-files');
    btn.title = title;
    const b = document.createElement('b');
    b.textContent = initial;
    btn.appendChild(document.createTextNode(`${label} `));
    btn.appendChild(b);
    btn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      toggleDockSheet(kind);
    });
    return btn;
  }

  function renderFooter() {
    if (!footerEl) return;
    ensureFooterSkeleton();
    const tokenTxt = formatTokenStat(true);
    const tokenDetail = formatTokenStat(false);
    const liveToolCount = sessionToolTotal();
    const toolTxt = liveToolCount > 0 || authoritativeToolCalls !== null ? String(liveToolCount) : '—';
    const tokenEl = footerEl.querySelector('.etl-foot-token b');
    const toolEl = footerEl.querySelector('.etl-foot-tool b');
    const fileEl = footerEl.querySelector('.etl-foot-files b');
    if (tokenEl) tokenEl.textContent = tokenTxt;
    const tokenItem = footerEl.querySelector('.etl-foot-token');
    if (tokenItem) safeSetTitle(tokenItem, tokenDetail && tokenDetail !== '—' ? (`上下文 ${tokenDetail}`) : '');
    if (toolEl) toolEl.textContent = toolTxt;
    const fileCount = snapshotChangedFiles.length;
    if (fileEl) fileEl.textContent = String(fileCount);
    const fileBtn = footerEl.querySelector('#etl-foot-files');
    if (fileBtn) {
      fileBtn.classList.toggle('is-empty', fileCount <= 0);
    }
    const toolBtn = footerEl.querySelector('#etl-foot-tool');
    if (toolBtn) {
      toolBtn.classList.toggle('is-empty', liveToolCount <= 0 && authoritativeToolCalls === null);
    }
    syncDockToggleAria();
    renderWorkbenchStatus();
  }

  function makeFootItem(cls, label, value) {
    const span = document.createElement('span');
    span.className = `etl-foot-item ${cls}`;
    const b = document.createElement('b');
    b.textContent = value;
    span.appendChild(document.createTextNode(`${label} `));
    span.appendChild(b);
    return span;
  }

  function renderWorkbenchStatus() {
    if (!hostEl) return;
    try {
      const countEl = hostEl.querySelector('#etl-chapter-node-count');
      const n = allChapterViews().length;
      if (countEl) countEl.textContent = n ? (`${n} 个节点`) : '';
    } catch (e) {
      safeWarn('renderWorkbenchStatus', e);
    }
  }

  function setDockSheet(kind) {
    dockSheetKind = kind === 'files' || kind === 'tools' ? kind : '';
    if (snapshotFilesEl) {
      const open = !!dockSheetKind;
      snapshotFilesEl.classList.toggle('hidden', !open);
      snapshotFilesEl.classList.toggle('etl-files-sheet--open', open);
      if (open) snapshotFilesEl.setAttribute('data-dock-kind', dockSheetKind);
      else snapshotFilesEl.removeAttribute('data-dock-kind');
    }
    renderDockSheet();
    syncDockToggleAria();
  }

  function toggleDockSheet(kind) {
    setDockSheet(dockSheetKind === kind ? '' : kind);
  }

  function syncDockToggleAria() {
    const fileBtn = footerEl && footerEl.querySelector('#etl-foot-files');
    const toolBtn = footerEl && footerEl.querySelector('#etl-foot-tool');
    if (fileBtn) fileBtn.setAttribute('aria-expanded', dockSheetKind === 'files' ? 'true' : 'false');
    if (toolBtn) toolBtn.setAttribute('aria-expanded', dockSheetKind === 'tools' ? 'true' : 'false');
  }

  function bindFilesSheetControls() {
    if (filesSheetBound) return;
    const closeBtn = hostEl && hostEl.querySelector('#etl-files-sheet-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        setDockSheet('');
      });
    }
    filesSheetDocHandler = function (evt) {
      try {
        if (!dockSheetKind) return;
        if (evt.type === 'keydown' && evt.key === 'Escape') {
          setDockSheet('');
          evt.stopPropagation();
          return;
        }
        if (evt.type !== 'click') return;
        const t = evt.target;
        if (!t || !t.closest) return;
        if (t.closest('#etl-snapshot-files')
          || t.closest('#etl-foot-files')
          || t.closest('#etl-foot-tool')) return;
        if (hostEl && hostEl.contains(t)) setDockSheet('');
      } catch (e) {
        safeWarn('filesSheetDoc', e);
      }
    };
    document.addEventListener('click', filesSheetDocHandler, true);
    document.addEventListener('keydown', filesSheetDocHandler, true);
    filesSheetBound = true;
  }

  function unbindFilesSheetControls() {
    if (filesSheetDocHandler) {
      document.removeEventListener('click', filesSheetDocHandler, true);
      document.removeEventListener('keydown', filesSheetDocHandler, true);
    }
    filesSheetDocHandler = null;
    filesSheetBound = false;
    dockSheetKind = '';
  }

  // ── 监管横幅 ──

  function formatSupervisionReason(modeState) {
    if (!modeState) return '—';
    const primary = modeState.enteredByPrimary || (modeState.enteredBy && modeState.enteredBy[0]);
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
    const reasonLabel = formatSupervisionReason(currentExecutionMode);
    const roundNo = typeof currentExecutionMode.round === 'number'
      ? currentExecutionMode.round
      : (roundRecords.length ? roundRecords[roundRecords.length - 1].iteration : null);
    const headline = '已进入监管模式（' + reasonLabel + (roundNo ? `，第 ${roundNo} 轮` : '') + '）';

    const detailLines = [];
    if (currentExecutionMode.enteredBy && currentExecutionMode.enteredBy.length) {
      const tags = currentExecutionMode.enteredBy.map((sig) =>  MODE_SIGNAL_LABELS[sig] || sig);
      detailLines.push(`信号：${tags.join(' + ')}`);
    }
    if (currentExecutionMode.degradedTier) {
      detailLines.push('降级：' + (DEGRADED_LABELS[currentExecutionMode.degradedTier]
        || currentExecutionMode.degradedTier));
    }
    if (currentExecutionMode.primaryReasonHuman) {
      detailLines.push(`原因：${currentExecutionMode.primaryReasonHuman}`);
    }

    modeBannerEl.innerHTML = '';
    const main = document.createElement('div');
    main.className = 'etl-banner-main';
    const icon = document.createElement('span');
    icon.className = 'etl-banner-icon';
    icon.textContent = '⚠';
    const text = document.createElement('span');
    text.className = 'etl-banner-text';
    text.textContent = headline;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'etl-banner-toggle';
    toggle.textContent = (bannerDetailOpen ? '收起详情 ▴' : '查看详情 ▾');
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      bannerDetailOpen = !bannerDetailOpen;
      renderExecutionModeBanner();
    });
    main.appendChild(icon);
    main.appendChild(text);
    if (detailLines.length) main.appendChild(toggle);
    modeBannerEl.appendChild(main);

    if (detailLines.length) {
      const detail = document.createElement('div');
      detail.className = 'etl-banner-detail' + (bannerDetailOpen ? '' : ' hidden');
      detail.textContent = detailLines.join('\n');
      modeBannerEl.appendChild(detail);
    }
    modeBannerEl.classList.remove('hidden');
  }

  /** 底部一行摘要（供冰豆 #status-turn）；如 forced · 工具失败 = executionMode + enteredByPrimary 组合，非单一事件类型 */
  function formatExecutionModeChip(modeState) {
    if (!modeState || modeState.executionMode !== 'forced') return '';
    const primary = modeState.enteredByPrimary;
    let label = primary ? (MODE_SIGNAL_LABELS[primary] || primary) : 'forced';
    if (modeState.degradedTier) {
      label += ' · ' + (DEGRADED_LABELS[modeState.degradedTier] || modeState.degradedTier);
    }
    return `forced · ${label}`;
  }

  function formatFootSummary(plan) {
    if (!plan || !plan.steps || !plan.steps.length) return '';
    const done = countFinished(plan.steps);
    const total = plan.steps.length;
    const active = pickActiveStep(plan);
    const phase = active ? STATE_LABELS[active.status] || active.status : '';
    const shortTitle = active ? clamp24(active.title) : '';
    const base = `${done}/${total}`;
    if (phase && shortTitle) return `${base} · ${phase} · ${shortTitle}`;
    if (phase) return `${base} · ${phase}`;
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
      return `正在等待工具返回（${lastTool.toolName}）…`;
    }
    const active = pickActiveStep(currentPlan);
    if (!active) return '';
    const running = active.status === 'running';
    if (active.isVerification && running) return '正在验证结果…';
    const phase = active.phase || '';
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
      const phrase = clamp40(deriveLlmActivity());
      if (!phrase) {
        llmActivityEl.classList.add('hidden');
        llmActivityEl.textContent = '';
        return;
      }
      let label = llmActivityEl.querySelector('.etl-llm-label');
      let text = llmActivityEl.querySelector('.etl-llm-text');
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
    const end = typeof record.resultTs === 'number' ? record.resultTs : Date.now();
    const ms = Math.max(0, end - record.callTs);
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return formatClock(ms);
  }

  function formatSearchToolPreview(toolName, args) {
    if (!args || typeof args !== 'object') return '';
    const pattern = args.pattern || args.glob || args.query || '';
    const scope = args.path || args.directory || '';
    if (pattern && scope) return clamp40(`${String(pattern)} · ${String(scope)}`);
    return clamp40(String(pattern || scope || ''));
  }

  function formatToolArgsPreview(toolName, args) {
    try {
      if (toolName === 'glob' || toolName === 'grep') {
        const searchPreview = formatSearchToolPreview(toolName, args);
        if (searchPreview) return searchPreview;
      }
      if (window.ToolTraceFormat
        && typeof window.ToolTraceFormat.formatToolArgsDetailPreview === 'function') {
        const formatted = window.ToolTraceFormat.formatToolArgsDetailPreview(toolName, args);
        if (formatted) return clamp40(formatted);
      }
      if (!args || typeof args !== 'object') return '';
      const common = args.path || args.file || args.command || args.query
        || args.pattern || args.url || args.description;
      if (common) return clamp40(common);
      return clamp40(JSON.stringify(args));
    } catch (_e) {
      return '';
    }
  }

  // 工具名 → 归类；供执行流轮次推导「本轮做了什么/为什么」。
  const CONTEXT_READ_TOOLS = {
    read_file: true, file_info: true, notebook_read: true,
    parse_document: true, parse_pptx_deep: true, parse_doc_legacy: true,
    parse_xmind_deep: true, parse_xlsx_deep: true, open_file: true,
    read_image: true, image_read: true, xmind_parse: true, xlsx_parse: true,
    browse_directory: true, list_drives: true, diff_files: true,
  };
  const CONTEXT_WRITE_TOOLS = {
    write_file: true, append_file: true, edit_file: true,
    patch_file: true, batch_edit_file: true, fs_operation: true,
    apply_patch: true, undo_edit: true, create_file: true, multi_edit: true,
  };
  const CONTEXT_SEARCH_TOOLS = { glob: true, grep: true };

  function extractToolTarget(toolName, args) {
    try {
      if (!args || typeof args !== 'object') return '';
      if (toolName === 'run_command') return String(args.command || '');
      if (CONTEXT_SEARCH_TOOLS[toolName]) {
        const pattern = args.pattern || args.glob || args.query || '';
        const scope = args.path || args.directory || '';
        if (pattern && scope) return `${String(pattern)} · ${String(scope)}`;
        return String(pattern || scope || '');
      }
      const pathVal = args.path || args.file || args.filePath || args.filename;
      if (pathVal) return String(pathVal);
      return '';
    } catch (_e) {
      return '';
    }
  }

  function targetHint(tool) {
    const t = tool.target || tool.detail || '';
    return t ? `「${clamp24(t)}」` : '';
  }

  function inferCommandIntent(tool) {
    const detail = tool.detail || tool.target || '';
    if (!detail) return '执行命令验证或推进任务';
    const cmd = String(detail).trim();
    if (cmd.startsWith('check ')) {
      return '检查后台任务' + (cmd.length > 6 ? ` ${clamp24(cmd.slice(6))}` : '');
    }
    if (cmd.startsWith('stop ')) return '停止后台任务';
    if (cmd === 'list background tasks') return '查看后台任务列表';
    return `运行命令 ${clamp24(cmd)}`;
  }

  function inferFsOperationIntent(tool) {
    const detail = String(tool.detail || tool.target || '').toLowerCase();
    if (/\bdelete\b/.test(detail)) return `删除文件或目录${targetHint(tool)}`;
    if (/\b(mkdir|create_dir)\b/.test(detail)) return `创建目录${targetHint(tool)}`;
    if (/\b(move|rename)\b/.test(detail)) return `移动或重命名${targetHint(tool)}`;
    if (/\bcopy\b/.test(detail)) return `复制文件${targetHint(tool)}`;
    return `执行文件系统操作${targetHint(tool)}`;
  }

  function inferMcpToolIntent(toolName) {
    if (!toolName.startsWith('mcp_')) return '';
    const parts = toolName.slice(4).split('_');
    if (parts.length >= 2) {
      return '调用 MCP 工具 ' + parts[0] + '/' + parts.slice(1).join('_');
    }
    return '调用 MCP 扩展工具';
  }

  function inferToolIntent(tool) {
    const name = tool.toolName || '';
    const hint = targetHint(tool);
    if (name === 'read_file') return `读取${hint}了解代码与上下文`;
    if (name === 'file_info') return `查看文件元信息${hint}`;
    if (name === 'notebook_read') return `读取 Notebook${hint}`;
    if (name === 'open_file') return `打开${hint}查看内容`;
    if (name === 'read_image' || name === 'image_read') return `读取图片${hint}`;
    if (name === 'parse_document' || name === 'parse_doc_legacy') return `解析文档${hint}提取内容`;
    if (name === 'parse_pptx_deep') return `深度解析 PPT${hint}`;
    if (name === 'parse_xmind_deep' || name === 'xmind_parse') return `解析思维导图${hint}`;
    if (name === 'parse_xlsx_deep' || name === 'xlsx_parse') return `解析表格${hint}`;
    if (name === 'diff_files') return `对比文件差异${hint}`;
    if (name === 'browse_directory' || name === 'list_drives') return `浏览目录结构${hint}`;
    if (name === 'grep') return '搜索代码' + (hint || '中的关键词');
    if (name === 'glob') return '查找匹配' + (hint || '模式的文件');
    if (name === 'write_file' || name === 'create_file') return `写入或创建文件${hint}`;
    if (name === 'edit_file' || name === 'patch_file' || name === 'apply_patch') return `修改文件${hint}`;
    if (name === 'append_file') return `追加内容到${hint}`;
    if (name === 'batch_edit_file' || name === 'multi_edit') return '批量修改多个文件';
    if (name === 'fs_operation') return inferFsOperationIntent(tool);
    if (name === 'undo_edit') return '撤销上一次编辑';
    if (name === 'run_command') return inferCommandIntent(tool);
    if (name === 'fetch_url' || name === 'web_search') return `联网查询外部信息${hint}`;
    if (name === 'git') return `执行 Git 操作${hint}`;
    if (name === 'env_info') return '获取运行环境信息';
    const mcpIntent = inferMcpToolIntent(name);
    if (mcpIntent) return mcpIntent + hint;
    if (CONTEXT_READ_TOOLS[name]) return `读取资源${hint}`;
    if (CONTEXT_SEARCH_TOOLS[name]) return `搜索项目${hint}`;
    if (CONTEXT_WRITE_TOOLS[name]) return `更新文件${hint}`;
    return (name ? `调用 ${humanizeToolName(name)}` : '调用工具') + hint;
  }

  /** 工具行副标题：仅在 intent 未覆盖时展示路径/命令等细节。 */
  function toolActionDetailLine(tool) {
    const detail = tool.detail || tool.target || '';
    if (!detail) return '';
    const intent = inferToolIntent(tool);
    const short = clamp24(detail);
    if (short && intent.includes(short)) return '';
    return detail;
  }

  function findFirstToolBy(tools, predicate) {
    for (let i = 0; i < tools.length; i++) {
      if (predicate(tools[i])) return tools[i];
    }
    return null;
  }

  function summarizeToolIntents(tools) {
    const counts = { read: 0, search: 0, write: 0, command: 0, other: 0 };
    for (let i = 0; i < tools.length; i++) {
      const name = tools[i].toolName;
      if (CONTEXT_READ_TOOLS[name]) counts.read++;
      else if (CONTEXT_SEARCH_TOOLS[name]) counts.search++;
      else if (CONTEXT_WRITE_TOOLS[name]) counts.write++;
      else if (name === 'run_command') counts.command++;
      else counts.other++;
    }
    const parts = [];
    if (counts.write) {
      parts.push(counts.write === 1
        ? inferToolIntent(findFirstToolBy(tools, (t) =>  CONTEXT_WRITE_TOOLS[t.toolName]))
        : `修改 ${counts.write} 处文件落实改动`);
    }
    if (counts.command) {
      parts.push(counts.command === 1
        ? inferToolIntent(findFirstToolBy(tools, (t) =>  t.toolName === 'run_command'))
        : `执行 ${counts.command} 条命令验证或推进任务`);
    }
    if (counts.read) {
      parts.push(counts.read === 1
        ? inferToolIntent(findFirstToolBy(tools, (t) =>  CONTEXT_READ_TOOLS[t.toolName]))
        : `读取 ${counts.read} 个文件收集上下文`);
    }
    if (counts.search) {
      parts.push(counts.search === 1
        ? inferToolIntent(findFirstToolBy(tools, (t) =>  CONTEXT_SEARCH_TOOLS[t.toolName]))
        : `搜索 ${counts.search} 次定位相关代码`);
    }
    if (counts.other) parts.push('调用其他工具推进任务');
    return parts;
  }

  function deriveRoundToolIntents(tools) {
    if (!tools.length) return ['理解用户目标并规划下一步执行'];
    if (tools.length > 3) return summarizeToolIntents(tools);
    const intents = [];
    const seen = Object.create(null);
    for (let i = 0; i < tools.length; i++) {
      const intent = inferToolIntent(tools[i]);
      if (intent && !seen[intent]) {
        seen[intent] = true;
        intents.push(intent);
      }
    }
    return intents.length ? intents : ['理解用户目标并规划下一步执行'];
  }

  // ── 编年史：章节目录 ──

  function chronicleApi() {
    try {
      return window.EtlChronicle || null;
    } catch (_e) {
      return null;
    }
  }

  function chapterStatusLabel(status) {
    const api = chronicleApi();
    if (api && api.STATUS_LABELS && api.STATUS_LABELS[status]) return api.STATUS_LABELS[status];
    if (status === 'running') return '进行中';
    if (status === 'failed') return '失败';
    if (status === 'paused') return '已暂停';
    if (status === 'stopped') return '用户停止';
    return '完成';
  }

  function chapterRunPhase(status) {
    if (status === 'running') return 'running';
    if (status === 'failed') return 'error';
    return 'done';
  }

  function applyChapterRunDot(dot, status) {
    if (!dot) return;
    const phase = chapterRunPhase(status);
    dot.className = `chat-sidebar-item-run-dot is-${phase}`;
    dot.setAttribute('aria-label', chapterStatusLabel(status));
  }

  function makeChapterRunDot(status) {
    const dot = document.createElement('span');
    applyChapterRunDot(dot, status);
    return dot;
  }

  function chapterMarkerLabel(key) {
    const api = chronicleApi();
    if (api && api.MARKER_LABELS && api.MARKER_LABELS[key]) return api.MARKER_LABELS[key];
    if (key === 'supervision') return '监管曾介入';
    if (key === 'compaction') return '本章发生过压缩';
    if (key === 'circuit') return '熔断保护';
    if (key === 'subagent') return '子代理';
    return '';
  }

  function formatChapterDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
    return formatClock(ms);
  }

  function lastLiveWorkTs() {
    let last = 0;
    for (let i = 0; i < roundRecords.length; i++) {
      const rec = roundRecords[i];
      if (!rec) continue;
      if (typeof rec.endTs === 'number' && rec.endTs > last) last = rec.endTs;
      if (typeof rec.startTs === 'number' && rec.startTs > last) last = rec.startTs;
    }
    for (let j = 0; j < toolRecords.length; j++) {
      const tool = toolRecords[j];
      if (!tool) continue;
      if (typeof tool.resultTs === 'number' && tool.resultTs > last) last = tool.resultTs;
      if (typeof tool.callTs === 'number' && tool.callTs > last) last = tool.callTs;
    }
    return last || 0;
  }

  function latestUserSentAt() {
    try {
      if (!window.ChatSession || typeof window.ChatSession.getMessages !== 'function') return null;
      const msgs = window.ChatSession.getMessages() || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (!msg || msg.role !== 'user') continue;
        if (typeof msg.sentAt === 'number' && isFinite(msg.sentAt)) return msg.sentAt;
      }
    } catch (_e) { /* ignore */ }
    return null;
  }

  function inferTurnStartTs(fallbackTs) {
    if (typeof turnStartedAt === 'number') return turnStartedAt;
    if (liveChapterMeta && typeof liveChapterMeta.startedAt === 'number') return liveChapterMeta.startedAt;
    const fromUser = latestUserSentAt();
    if (typeof fromUser === 'number') return fromUser;
    if (typeof fallbackTs === 'number' && isFinite(fallbackTs)) return fallbackTs;
    return Date.now();
  }

  /** 任务还在跑但没走过 beginTurnTimer（F5 / 重连 / 同轮封章）时把检查点计时拉起来。 */
  function ensureTurnTimerRunning(ts) {
    if (liveChapterHasStopped()) return;
    if (typeof turnStartedAt !== 'number') {
      turnStartedAt = inferTurnStartTs(ts);
      turnEndedAt = null;
      if (liveChapterMeta && typeof liveChapterMeta.startedAt !== 'number') {
        liveChapterMeta.startedAt = turnStartedAt;
      }
      renderFooter();
      startTick();
      return;
    }
    reopenTurnIfModelStillWorking();
  }

  function liveChapterDurationMs() {
    const start = typeof turnStartedAt === 'number'
      ? turnStartedAt
      : (liveChapterMeta && typeof liveChapterMeta.startedAt === 'number'
        ? liveChapterMeta.startedAt
        : null);
    if (typeof start !== 'number') return 0;
    let end;
    if (typeof turnEndedAt === 'number') {
      end = turnEndedAt;
    } else if (liveChapterStatus() === 'running') {
      end = Date.now();
    } else {
      const work = lastLiveWorkTs();
      end = work > start ? work : start;
    }
    return Math.max(0, end - start);
  }

  function sealedDurationTotal() {
    let total = 0;
    for (let i = 0; i < sealedChapters.length; i++) {
      const ms = sealedChapters[i] && sealedChapters[i].durationMs;
      if (typeof ms === 'number') total += ms;
    }
    return total;
  }

  function sessionWorkMs() {
    return sealedDurationTotal() + liveChapterDurationMs();
  }

  function sessionToolTotal() {
    if (authoritativeToolCalls === null) {
      return sealedToolCount + uniqueToolCallCount;
    }
    return authoritativeToolCalls + Math.max(0, uniqueToolCallCount - calibratedUniqueToolCount);
  }

  function liveMarkersFromState() {
    const markers = (liveChapterMeta && Array.isArray(liveChapterMeta.markers))
      ? liveChapterMeta.markers.slice()
      : [];
    if (currentExecutionMode && currentExecutionMode.executionMode === 'forced') {
      if (!markers.includes('supervision')) markers.push('supervision');
    }
    for (let i = 0; i < roundRecords.length; i++) {
      const rec = roundRecords[i];
      if (!rec) continue;
      if (rec.stopReason === 'circuit_breaker' && !markers.includes('circuit')) {
        markers.push('circuit');
      }
    }
    return markers;
  }

  function isTurnInFlight() {
    return typeof turnStartedAt === 'number' && turnEndedAt === null;
  }

  function hasLiveProgress() {
    return roundRecords.length > 0 || uniqueToolCallCount > 0;
  }

  function latestUiUserIdentity() {
    try {
      if (!window.ChatSession || typeof window.ChatSession.getMessages !== 'function') return null;
      const msgs = window.ChatSession.getMessages() || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (!msg || msg.role !== 'user' || !msg.id) continue;
        let preview = '';
        const api = chronicleApi();
        if (api && typeof api.previewFromUser === 'function') {
          preview = api.previewFromUser(msg) || '';
        }
        return { messageId: String(msg.id), preview };
      }
    } catch (_e) { /* ignore */ }
    return null;
  }

  function adoptLiveChapterIdentity(messageId, preview) {
    if (!liveChapterMeta || !messageId) return;
    const prev = liveChapterMeta.messageId || '';
    liveChapterMeta.messageId = String(messageId);
    if (preview) liveChapterMeta.preview = preview;
    if (selectedChapterKey && (selectedChapterKey === prev || selectedChapterKey === '__live__')) {
      selectedChapterKey = liveChapterMeta.messageId;
    }
  }

  function bindLiveChapterIdentity(meta) {
    if (!liveChapterMeta) return;
    if (meta && typeof meta === 'object') {
      if (meta.messageId) adoptLiveChapterIdentity(meta.messageId, meta.preview);
      else if (meta.preview && !liveChapterMeta.preview) liveChapterMeta.preview = meta.preview;
    }
    if (!isSyntheticLiveId(liveChapterMeta.messageId)) {
      if (!liveChapterMeta.preview) {
        const same = latestUiUserIdentity();
        if (same && same.messageId === liveChapterMeta.messageId && same.preview) {
          liveChapterMeta.preview = same.preview;
        }
      }
      return;
    }
    const ident = latestUiUserIdentity();
    if (ident && ident.messageId) adoptLiveChapterIdentity(ident.messageId, ident.preview);
  }

  function markLiveChapterRunning(meta) {
    const prevKey = selectedChapterKey;
    ensureLiveChapter(meta || {});
    liveChapterMeta.status = 'running';
    bindLiveChapterIdentity(meta);
    if (!userPinnedChapter) focusNewestChapter();
    if (hostEl && selectedChapterKey && selectedChapterKey !== prevKey) {
      renderChapterDirectory();
    }
  }

  function mergeLiveIntoChapterList(list, live) {
    list = Array.isArray(list) ? list.slice() : [];
    if (!live) return list;
    if (!isSyntheticLiveId(live.messageId)) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].messageId === live.messageId) {
          list[i] = live;
          return list;
        }
      }
      list.push(live);
      return list;
    }
    if (list.length) {
      const last = list[list.length - 1];
      if (last && last.messageId) {
        adoptLiveChapterIdentity(last.messageId, last.preview);
        live.messageId = last.messageId;
        if (last.preview && (!live.preview || live.preview === '正在执行')) {
          live.preview = last.preview;
        }
        list[list.length - 1] = live;
        return list;
      }
    }
    list.push(live);
    return list;
  }

  function lastLiveRound() {
    for (let i = roundRecords.length - 1; i >= 0; i--) {
      if (roundRecords[i]) return roundRecords[i];
    }
    return null;
  }

  function stopReasonChapterStatus(reason) {
    if (!reason) return '';
    if (reason === 'circuit_breaker' || reason === 'completion_failed' || reason === 'error') {
      return 'failed';
    }
    if (reason === 'user_stop' || reason === 'cancelled' || reason === 'user_abort') {
      return 'stopped';
    }
    if (reason === 'completion_paused') return 'paused';
    return '';
  }

  function liveChapterHasStopped() {
    const last = lastLiveRound();
    if (!last) return false;
    if (last.isFinal) return true;
    if (stopReasonChapterStatus(last.stopReason)) return true;
    return last.stopReason === 'model_done' || last.stopReason === 'stop_hook';
  }

  function liveChapterStatus() {
    // 任务还在跑、模型未停：目录徽章保持进行中。
    // 某轮工具失败（如测试没过）不能把整章提前标成失败。
    if (!liveChapterHasStopped()) {
      if (isTurnInFlight() || !liveChapterMeta || liveChapterMeta.status === 'running') {
        return 'running';
      }
    }
    if (liveChapterMeta && liveChapterMeta.status && liveChapterMeta.status !== 'running') {
      return liveChapterMeta.status;
    }
    const last = lastLiveRound();
    if (last) {
      const fromStop = stopReasonChapterStatus(last.stopReason);
      if (fromStop) return fromStop;
      if (last.isFinal && last.status === 'done') return 'done';
      if (liveChapterHasStopped() && roundVisualStatus(last) === 'failed') return 'failed';
    }
    if (liveChapterHasStopped() && roundRecords.length && currentPlan && isPlanComplete(currentPlan)) {
      return 'done';
    }
    if (hasLiveChapterWork() && !liveChapterHasStopped()) return 'running';
    return 'done';
  }

  /** WS 闪断等会提前 endTurnTimer；模型还没停、后续工具/轮次到来时把活章重新打开。 */
  function reopenTurnIfModelStillWorking() {
    if (liveChapterHasStopped()) return;
    if (typeof turnStartedAt !== 'number' || turnEndedAt === null) return;
    turnEndedAt = null;
    if (liveChapterMeta) liveChapterMeta.status = 'running';
    startTick();
  }

  function liveFilesChangedCount() {
    const seen = Object.create(null);
    let n = 0;
    for (let i = 0; i < toolRecords.length; i++) {
      const tool = toolRecords[i];
      if (!tool || !CONTEXT_WRITE_TOOLS[tool.toolName]) continue;
      if (tool.status === 'failed' || tool.status === 'error') continue;
      const pathVal = tool.target || tool.detail || '';
      if (!pathVal || seen[pathVal]) continue;
      seen[pathVal] = true;
      n++;
    }
    return n;
  }

  function ensureLiveChapter(opts) {
    opts = opts || {};
    if (!liveChapterMeta) {
      liveChapterMeta = {
        messageId: opts.messageId || (`live-${Date.now()}`),
        preview: opts.preview || '',
        startedAt: typeof turnStartedAt === 'number' ? turnStartedAt : Date.now(),
        markers: [],
        status: opts.status || 'running',
      };
    } else {
      if (opts.messageId) liveChapterMeta.messageId = opts.messageId;
      if (opts.preview) liveChapterMeta.preview = opts.preview;
      if (opts.status) liveChapterMeta.status = opts.status;
    }
    bindLiveChapterIdentity(opts);
    return liveChapterMeta;
  }

  function formatClockStamp(ts) {
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function chapterElapsedLabel(chapter) {
    if (chapter && (chapter.live || (chapterMatchesLive(chapter) && isTurnInFlight()))) {
      return formatTurnElapsed();
    }
    if (chapter && typeof chapter.durationMs === 'number') return formatElapsedHuman(chapter.durationMs);
    return formatElapsedHuman(0);
  }

  function toolPreviewLine(tool) {
    if (!tool) return '';
    const name = tool.toolName || '';
    const preview = tool.preview || tool.target || tool.detail || '';
    if (name && preview) return `${name} · ${preview}`;
    return preview || name;
  }

  function liveChapterViewModel() {
    if (!hasLiveChapterWork()) return null;
    const meta = ensureLiveChapter();
    const files = liveFilesChangedCount();
    let rounds = [];
    const api = chronicleApi();
    if (api && typeof api.fromLive === 'function') {
      const packed = api.fromLive({
        messageId: meta.messageId,
        preview: meta.preview || '正在执行',
        status: liveChapterStatus(),
        startedAt: meta.startedAt || turnStartedAt,
        endedAt: turnEndedAt,
        markers: liveMarkersFromState(),
        roundRecords,
        toolRecords,
        plan: currentPlan,
      });
      if (packed && Array.isArray(packed.rounds)) rounds = packed.rounds;
    }
    return {
      messageId: meta.messageId,
      preview: meta.preview || '正在执行',
      status: liveChapterStatus(),
      roundCount: roundRecords.length,
      filesChangedCount: files,
      durationMs: liveChapterDurationMs(),
      markers: liveMarkersFromState(),
      toolCount: uniqueToolCallCount,
      rounds,
      goal: currentPlan && currentPlan.goal ? currentPlan.goal : '',
      phase: currentPlan && currentPlan.phase ? currentPlan.phase : '',
      progress: currentPlan && typeof currentPlan.progress === 'number' ? currentPlan.progress : null,
      intent: currentPlan && currentPlan.intent ? currentPlan.intent : '',
      startTs: typeof meta.startedAt === 'number' ? meta.startedAt : turnStartedAt,
      live: true,
    };
  }

  function isSyntheticLiveId(id) {
    return !id || String(id).startsWith('live-');
  }

  function allChapterViews() {
    bindLiveChapterIdentity();
    const list = sealedChapters.slice();
    const live = liveChapterViewModel();
    if (!list.length && snapshotCheckpointEntries.length) {
      const fallbacks = checkpointFallbackChapters();
      return live ? mergeLiveIntoChapterList(fallbacks, live) : fallbacks;
    }
    if (live) return mergeLiveIntoChapterList(list, live);
    return list;
  }

  function checkpointFallbackChapters() {
    const out = [];
    for (let i = 0; i < snapshotCheckpointEntries.length; i++) {
      const e = snapshotCheckpointEntries[i];
      if (!e || !e.messageId) continue;
      let ts = typeof e.userMessageTime === 'number' ? e.userMessageTime : 0;
      if (!ts && e.createdAt) ts = Date.parse(e.createdAt) || 0;
      out.push({
        messageId: e.messageId,
        preview: e.preview || '（无消息摘要）',
        status: 'done',
        startTs: ts,
        rounds: [],
        live: false,
      });
    }
    return out;
  }

  function visibleChapterViews() {
    const all = allChapterViews();
    if (all.length <= chapterVisibleLimit) return all;
    return all.slice(all.length - chapterVisibleLimit);
  }

  function chapterKey(chapter) {
    if (!chapter) return '';
    return chapter.messageId || (chapter.live ? '__live__' : '');
  }

  function newestChapterKey() {
    const all = allChapterViews();
    if (!all.length) return '';
    return chapterKey(all[all.length - 1]);
  }

  function getSelectedChapter() {
    const all = allChapterViews();
    if (!all.length) return null;
    if (selectedChapterKey) {
      for (let i = 0; i < all.length; i++) {
        if (chapterKey(all[i]) === selectedChapterKey) return all[i];
      }
    }
    return all[all.length - 1];
  }

  function isChapterSelected(chapter) {
    if (!chapter) return false;
    const selected = getSelectedChapter();
    return !!(selected && chapterKey(selected) === chapterKey(chapter));
  }

  function chapterMatchesLive(chapter) {
    if (!chapter) return false;
    if (chapter.live) return true;
    return !!(liveChapterMeta && chapter.messageId && liveChapterMeta.messageId === chapter.messageId);
  }

  function selectedChapterIsLive() {
    const ch = getSelectedChapter();
    if (!ch || !hasLiveChapterWork()) return false;
    const followingNewest = !userPinnedChapter && chapterKey(ch) === newestChapterKey();
    if (!chapterMatchesLive(ch) && !followingNewest) return false;
    return ch.status === 'running'
      || liveChapterStatus() === 'running'
      || hasLiveProgress()
      || isTurnInFlight();
  }

  function hideParkedLiveWidgets() {
    const live = selectedChapterIsLive();
    if (!live) {
      if (taskOverviewEl) {
        const ch = getSelectedChapter();
        if (!(ch && ch.goal)) taskOverviewEl.classList.add('hidden');
      }
      if (currentStepEl) currentStepEl.classList.add('hidden');
    }
  }

  function focusNewestChapter() {
    userPinnedChapter = false;
    selectedChapterKey = newestChapterKey();
  }

  function detachLiveWidgets() {
    if (!hostEl) return;
    const flow = hostEl.querySelector('#etl-panel-flow');
    if (!flow) return;
    if (taskOverviewEl && taskOverviewEl.parentNode !== flow) flow.appendChild(taskOverviewEl);
    if (currentStepEl && currentStepEl.parentNode !== flow) flow.appendChild(currentStepEl);
    if (roundTimelineEl && roundTimelineEl.parentNode !== flow) flow.appendChild(roundTimelineEl);
  }

  function nowDoingText() {
    if (!lastTool.toolName) return '';
    let target = '';
    const rec = lastTool.toolCallId ? toolRecordById[lastTool.toolCallId] : null;
    if (rec) target = rec.target || rec.detail || '';
    const label = inferToolIntent({
      toolName: lastTool.toolName,
      target,
      detail: target,
    });
    let elapsed = '';
    if (lastTool.ts) {
      elapsed = ` · ${formatToolDuration({
        callTs: lastTool.ts,
        resultTs: lastTool.pending ? Date.now() : rec && rec.resultTs,
      })}`;
    }
    return (lastTool.pending ? '正在' : '') + label + elapsed;
  }

  function makeRoundToggle(expanded) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'etl-round-toggle etl-visually-hidden';
    toggle.tabIndex = -1;
    toggle.setAttribute('aria-hidden', 'true');
    toggle.textContent = expanded ? '▴' : '▾';
    return toggle;
  }

  function makeFrozenRoundNode(round) {
    const item = document.createElement('li');
    const status = round.status || 'done';
    item.className = 'etl-round-node etl-round-card status-' + status
      + (round.isFinal ? ' is-final' : '');
    item.dataset.iteration = String(round.iteration);
    item.dataset.frozen = '1';
    const row = document.createElement('div');
    row.className = 'etl-round-row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-expanded', 'false');
    const marker = document.createElement('span');
    marker.className = 'etl-round-marker';
    marker.textContent = String(round.iteration);
    const summary = document.createElement('div');
    summary.className = 'etl-round-summary';
    const head = document.createElement('div');
    head.className = 'etl-round-head';
    const title = document.createElement('span');
    title.className = 'etl-round-title';
    title.textContent = round.title || (`第 ${round.iteration} 轮`);
    const time = document.createElement('span');
    time.className = 'etl-round-duration';
    const stamp = formatClockStamp(round.startTs);
    time.textContent = stamp || formatChapterDuration(round.durationMs);
    const toggle = makeRoundToggle(false);
    const badge = document.createElement('span');
    badge.className = `etl-round-badge status-${status}`;
    badge.textContent = roundStatusLabel(status);
    head.appendChild(title);
    head.appendChild(time);
    head.appendChild(badge);
    head.appendChild(toggle);
    summary.appendChild(head);
    const meta = document.createElement('div');
    meta.className = 'etl-round-meta';
    const desc = toolPreviewLine(round.tools && round.tools[0]);
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'etl-round-desc';
      descEl.textContent = desc;
      meta.appendChild(descEl);
    }
    summary.appendChild(meta);
    row.appendChild(marker);
    row.appendChild(summary);
    item.appendChild(row);
    const detail = document.createElement('div');
    detail.className = 'etl-round-detail';
    const actions = document.createElement('ol');
    actions.className = 'etl-round-actions';
    const tools = round.tools || [];
    for (let i = 0; i < tools.length; i++) {
      actions.appendChild(makeFrozenToolRow(tools[i]));
    }
    if (!tools.length && round.isFinal) {
      const complete = document.createElement('div');
      complete.className = 'etl-round-complete';
      complete.textContent = '模型判断本章目标已达成';
      detail.appendChild(complete);
    }
    detail.appendChild(actions);
    item.appendChild(detail);
    row.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const open = !item.classList.contains('is-expanded');
      item.classList.toggle('is-expanded', open);
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? '▴' : '▾';
    });
    return item;
  }

  function makeFrozenToolRow(tool) {
    const status = toolStatusClass(tool.status);
    const row = document.createElement('li');
    row.className = `etl-round-action etl-round-tool status-${status}`;
    if (tool.toolCallId) {
      row.dataset.toolCallId = tool.toolCallId;
      row.title = '定位到对话';
    }
    const icon = document.createElement('span');
    icon.className = 'etl-round-action-icon';
    icon.textContent = status === 'failed' ? '×' : '✓';
    const body = document.createElement('div');
    body.className = 'etl-round-action-body';
    const name = document.createElement('div');
    name.className = 'etl-round-action-name';
    name.textContent = tool.intent || tool.toolName || '工具';
    body.appendChild(name);
    if (tool.preview) {
      const path = document.createElement('div');
      path.className = 'etl-round-action-target';
      path.textContent = tool.preview;
      body.appendChild(path);
    }
    const dur = document.createElement('span');
    dur.className = 'etl-round-action-dur';
    dur.textContent = formatChapterDuration(tool.durationMs);
    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(dur);
    return row;
  }

  function makeChapterNode(chapter, index, isCurrent) {
    const selected = isChapterSelected(chapter);
    const isCursor = !!(chapter.messageId && isSnapshotCursorMessage(chapter.messageId));
    const li = document.createElement('li');
    li.className = 'etl-chapter-node etl-snapshot-node'
      + (isCurrent ? ' is-current' : '')
      + (selected ? ' is-selected' : '')
      + (isCursor ? ' is-cursor' : '')
      + ' status-' + (chapter.status || 'done');
    if (chapter.messageId) li.setAttribute('data-message-id', chapter.messageId);
    li.setAttribute('data-chapter-index', String(index));

    const rail = document.createElement('div');
    rail.className = 'etl-snapshot-rail';
    rail.setAttribute('aria-hidden', 'true');
    const marker = document.createElement('span');
    marker.className = 'etl-chapter-marker etl-snapshot-index etl-chapter-index';
    marker.textContent = String(index);
    const line = document.createElement('span');
    line.className = 'etl-snapshot-line';
    rail.appendChild(marker);
    rail.appendChild(line);

    const card = document.createElement('div');
    card.className = 'etl-snapshot-card etl-chapter-row';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.setAttribute('aria-selected', selected ? 'true' : 'false');

    const main = document.createElement('div');
    main.className = 'etl-chapter-main';
    const timeEl = document.createElement('time');
    timeEl.className = 'etl-snapshot-time etl-chapter-clock';
    timeEl.textContent = chapterElapsedLabel(chapter);
    timeEl.setAttribute('title', `本轮运行 ${timeEl.textContent}`);
    const clockRow = document.createElement('div');
    clockRow.className = 'etl-chapter-clock-row';
    clockRow.appendChild(timeEl);
    clockRow.appendChild(makeChapterRunDot(chapter.status));

    const titleRow = document.createElement('div');
    titleRow.className = 'etl-chapter-title-row';
    const preview = document.createElement('div');
    preview.className = 'etl-snapshot-preview etl-chapter-title';
    preview.textContent = chapter.preview || '（无消息摘要）';
    safeSetTitle(preview, preview.textContent);
    titleRow.appendChild(preview);
    if (chapter.messageId && isSnapshotRestoreHidden(chapter.messageId)) {
      card.classList.add('etl-snapshot-card--no-restore');
    } else if (chapter.messageId && !isSyntheticLiveId(chapter.messageId)) {
      titleRow.appendChild(createSnapshotRestoreButton(chapter.messageId));
    }
    main.appendChild(clockRow);
    main.appendChild(titleRow);
    card.appendChild(main);
    li.appendChild(rail);
    li.appendChild(card);
    return li;
  }

  function syncChapterEmptyAndLoadMore(allCount, visibleCount) {
    if (!chapterTimelineEl) return;
    const empty = chapterTimelineEl.querySelector('.etl-chapter-empty');
    if (empty) empty.classList.toggle('hidden', allCount > 0);
    const loadMore = chapterTimelineEl.querySelector('#etl-chapter-load-more');
    if (!loadMore) return;
    const hiddenCount = Math.max(0, allCount - visibleCount);
    loadMore.classList.toggle('hidden', hiddenCount <= 0);
    loadMore.textContent = hiddenCount
      ? (`加载更早的章节 ↑ (${hiddenCount})`)
      : '加载更早的章节 ↑';
  }

  function updateFlowStepCount(n) {
    const el = hostEl && hostEl.querySelector('#etl-flow-step-count');
    if (!el) return;
    el.textContent = n > 0 ? (`共 ${n} 个步骤`) : '';
  }

  function renderChapterDirectory(options) {
    options = options || {};
    if (!chapterTimelineEl) return;
    try {
      detachLiveWidgets();
      const list = chapterTimelineEl.querySelector('.etl-chapter-list');
      if (!list) return;
      list.innerHTML = '';
      const all = allChapterViews();
      const visible = visibleChapterViews();
      const offset = all.length - visible.length;
      syncChapterEmptyAndLoadMore(all.length, visible.length);
      renderWorkbenchStatus();

      for (let i = 0; i < visible.length; i++) {
        const chapter = visible[i];
        const absIndex = offset + i + 1;
        const isCurrent = !!chapter.live || chapter === all[all.length - 1];
        list.appendChild(makeChapterNode(chapter, absIndex, isCurrent));
      }

      if (options.scrollToLatest && list.lastElementChild && list.lastElementChild.scrollIntoView) {
        list.lastElementChild.scrollIntoView({ block: 'nearest' });
      }
      if (pendingRevealMessageId) {
        const reveal = list.querySelector(`[data-message-id="${pendingRevealMessageId.replace(/"/g, '\\"')}"]`);
        if (reveal && reveal.scrollIntoView) reveal.scrollIntoView({ block: 'nearest' });
        pendingRevealMessageId = '';
      }
    } catch (e) {
      safeWarn('renderChapterDirectory', e);
    }
  }

  function patchCurrentChapterChrome() {
    if (!chapterTimelineEl) return;
    const live = liveChapterViewModel();
    if (!live) return;
    const node = chapterTimelineEl.querySelector('.etl-chapter-node.is-current');
    if (!node) {
      renderChapterDirectory();
      return;
    }
    const title = node.querySelector('.etl-chapter-title');
    if (title && live.preview) {
      title.textContent = live.preview;
      safeSetTitle(title, live.preview);
    }
    const statusEl = node.querySelector('.chat-sidebar-item-run-dot');
    if (statusEl) applyChapterRunDot(statusEl, live.status);
    node.classList.remove('status-running', 'status-done', 'status-failed', 'status-paused', 'status-stopped');
    node.classList.add('status-' + (live.status || 'done'));
    const clock = node.querySelector('.etl-chapter-clock');
    if (clock) {
      clock.textContent = chapterElapsedLabel(live);
      clock.setAttribute('title', `本轮运行 ${clock.textContent}`);
      clock.classList.remove('hidden');
    }
    renderWorkbenchStatus();
  }

  function selectChapter(messageId, indexAttr, fromUser) {
    const views = allChapterViews();
    let chapter = null;
    if (messageId) {
      for (let i = 0; i < views.length; i++) {
        if (views[i].messageId === messageId) { chapter = views[i]; break; }
      }
    }
    if (!chapter && indexAttr) {
      const idx = parseInt(indexAttr, 10);
      if (idx >= 1 && idx <= views.length) chapter = views[idx - 1];
    }
    if (!chapter) return;
    const key = chapterKey(chapter);
    if (fromUser) userPinnedChapter = key !== newestChapterKey();
    selectedChapterKey = key;
    renderChapterDirectory();
    renderTaskOverview();
    renderCurrentStep();
    renderRoundTimeline(true);
    hideParkedLiveWidgets();
  }

  function revealChapter(messageId) {
    if (!messageId) return;
    pendingRevealMessageId = messageId;
    userPinnedChapter = true;
    selectedChapterKey = messageId;
    renderChapterDirectory({ scrollToLatest: false });
    renderRoundTimeline(true);
  }

  function jumpToChatTool(toolCallId) {
    if (!toolCallId) return;
    try {
      if (window.ChatUI && typeof window.ChatUI.scrollToToolCall === 'function') {
        window.ChatUI.scrollToToolCall(toolCallId);
      }
    } catch (e) {
      safeWarn('jumpToChatTool', e);
    }
  }

  function handleChapterTimelineInteraction(event) {
    try {
      const target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('.etl-snapshot-restore-btn')) return;
      const loadMore = target.closest('#etl-chapter-load-more');
      if (loadMore) {
        chapterVisibleLimit += 8;
        renderChapterDirectory();
        return;
      }
      const row = target.closest('.etl-chapter-row');
      if (!row) return;
      const node = row.closest('.etl-chapter-node');
      if (!node) return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      if (event.type === 'keydown') event.preventDefault();
      selectChapter(node.getAttribute('data-message-id') || '', node.getAttribute('data-chapter-index'), true);
    } catch (e) {
      safeWarn('chapterTimelineClick', e);
    }
  }

  function unbindChapterTimelineEvents() {
    if (chapterTimelineEl && chapterClickHandler) {
      chapterTimelineEl.removeEventListener('click', chapterClickHandler);
      chapterTimelineEl.removeEventListener('keydown', chapterClickHandler);
    }
    chapterClickHandler = null;
    chapterTimelineBound = false;
  }

  function bindChapterTimelineEvents() {
    if (!chapterTimelineEl) return;
    if (chapterTimelineBound) return;
    chapterClickHandler = handleChapterTimelineInteraction;
    chapterTimelineEl.addEventListener('click', chapterClickHandler);
    chapterTimelineEl.addEventListener('keydown', chapterClickHandler);
    chapterTimelineBound = true;
  }

  function resetLiveChapterState() {
    currentPlan = null;
    frozenPlanId = null;
    currentExecutionMode = null;
    bannerDetailOpen = false;
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
    liveChapterMeta = null;
    turnStartedAt = null;
    turnEndedAt = null;
  }

  function restoreInFlightTurnClock(savedStart, savedEnd, resetTimer) {
    if (resetTimer) {
      turnStartedAt = null;
      turnEndedAt = null;
      stopTick();
      return;
    }
    if (typeof savedStart === 'number' && savedEnd === null) {
      turnStartedAt = savedStart;
      turnEndedAt = null;
    }
  }

  function sealLiveChapter(opts) {
    opts = opts || {};
    const resetTimer = !!opts.resetTimer;
    const savedStart = turnStartedAt;
    const savedEnd = turnEndedAt;
    try {
      if (!hasSealableWork()) {
        currentPlan = null;
        frozenPlanId = null;
        currentExecutionMode = null;
        bannerDetailOpen = false;
        restoreInFlightTurnClock(savedStart, savedEnd, resetTimer);
        markLiveChapterRunning(opts.nextMeta || {});
        if (typeof turnStartedAt === 'number' && turnEndedAt === null) startTick();
        focusNewestChapter();
        if (hostEl) {
          renderChapterDirectory();
          renderTaskOverview();
          renderRoundTimeline(true);
          renderCurrentStep();
          renderEmptyState();
          renderExecutionModeBanner();
          renderFooter();
          renderDockSheet();
          hideParkedLiveWidgets();
        }
        return false;
      }
      ensureLiveChapter();
      let status = opts.status || liveChapterStatus();
      if (status === 'running') status = 'done';
      const api = chronicleApi();
      let chapter = null;
      if (api && typeof api.fromLive === 'function') {
        chapter = api.fromLive({
          messageId: liveChapterMeta.messageId,
          preview: liveChapterMeta.preview || '（无消息摘要）',
          status,
          startedAt: liveChapterMeta.startedAt || turnStartedAt,
          endedAt: typeof turnEndedAt === 'number' ? turnEndedAt : Date.now(),
          markers: liveMarkersFromState(),
          roundRecords,
          toolRecords,
          plan: currentPlan,
        });
      }
      if (chapter) {
        chapter.status = status;
        sealedChapters.push(chapter);
        sealedToolCount += typeof chapter.toolCount === 'number' ? chapter.toolCount : 0;
        if (chapter.messageId) userPinnedChapter = false;
      }
      resetLiveChapterState();
      restoreInFlightTurnClock(savedStart, savedEnd, resetTimer);
      markLiveChapterRunning(opts.nextMeta || {});
      if (typeof turnStartedAt === 'number' && turnEndedAt === null) startTick();
      focusNewestChapter();
      if (hostEl) {
        renderChapterDirectory();
        renderTaskOverview();
        renderRoundTimeline(true);
        renderCurrentStep();
        renderEmptyState();
        renderExecutionModeBanner();
        renderFooter();
        renderDockSheet();
        hideParkedLiveWidgets();
      }
      scheduleFlowPersist();
      return true;
    } catch (e) {
      safeWarn('sealLiveChapter', e);
      return false;
    }
  }

  function loadChapterIntoLive(chapter) {
    if (!chapter) return;
    resetLiveChapterState();
    liveChapterMeta = {
      messageId: chapter.messageId || (`live-${Date.now()}`),
      preview: chapter.preview || '',
      startedAt: chapter.startTs,
      markers: Array.isArray(chapter.markers) ? chapter.markers.slice() : [],
      status: chapter.status === 'running' ? 'running' : (chapter.status || 'done'),
    };
    /* hydrate 回填的章不要造空任务图，否则总览卡会撑乱目录。 */
    const rounds = chapter.rounds || [];
    const startBase = typeof chapter.startTs === 'number' ? chapter.startTs : Date.now() - rounds.length * 2000;
    for (let r = 0; r < rounds.length; r++) {
      const round = rounds[r];
      const roundTs = startBase + r * 2000;
      const ensured = ensureRoundRecord(round.iteration || (r + 1), roundTs);
      const record = ensured.record;
      record.status = round.status === 'running' ? 'running' : 'done';
      record.isFinal = !!round.isFinal;
      record.endTs = roundTs + (round.durationMs || 1500);
      if (round.stopReason) record.stopReason = round.stopReason;
      const tools = round.tools || [];
      for (let t = 0; t < tools.length; t++) {
        const tool = tools[t];
        const callId = tool.toolCallId || (`hydrate-${record.iteration}-${t}`);
        if (toolRecordById[callId]) continue;
        const toolTs = roundTs + t * 200;
        const toolRec = {
          toolCallId: callId,
          toolName: tool.toolName,
          callTs: toolTs,
          resultTs: toolTs + Math.max(100, tool.durationMs || 100),
          status: tool.status || 'done',
          detail: tool.preview || tool.target || '',
          target: tool.target || tool.preview || '',
          iteration: record.iteration,
        };
        toolRecords.push(toolRec);
        toolRecordById[callId] = toolRec;
        if (!record.toolCallIds.includes(callId)) record.toolCallIds.push(callId);
        if (!toolCallIds[callId]) {
          toolCallIds[callId] = true;
          uniqueToolCallCount++;
        }
      }
    }
    if (typeof chapter.startTs === 'number') turnStartedAt = chapter.startTs;
    if (chapter.status === 'running') {
      turnEndedAt = null;
    } else if (typeof chapter.endTs === 'number') {
      turnEndedAt = chapter.endTs;
    } else if (chapter.status && chapter.status !== 'running') {
      turnEndedAt = turnStartedAt ? turnStartedAt + (chapter.durationMs || 0) : Date.now();
    }
    if (chapter.status === 'running' || (typeof turnStartedAt === 'number' && turnEndedAt === null)) {
      startTick();
    } else if (chapter.status && chapter.status !== 'running') {
      stopTick();
    }
  }

  function applyAssembledChapters(chapters, options) {
    options = options || {};
    if (!Array.isArray(chapters)) chapters = [];
    const keepLive = !!options.keepLive && (
      hasLiveProgress()
      || isTurnInFlight()
      || !!(liveChapterMeta && liveChapterMeta.status === 'running')
    );
    if (keepLive && !chapters.length) return;
    const liveId = liveChapterMeta && liveChapterMeta.messageId;
    sealedChapters = [];
    sealedToolCount = 0;
    let last = null;
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      last = ch;
      if (keepLive && liveId && ch.messageId === liveId) continue;
      if (keepLive && isSyntheticLiveId(liveId) && i === chapters.length - 1) continue;
      if (keepLive || i < chapters.length - 1) {
        sealedChapters.push(ch);
        sealedToolCount += typeof ch.toolCount === 'number' ? ch.toolCount : 0;
      }
    }
    if (!keepLive && last) loadChapterIntoLive(last);
    else if (!keepLive && !last) resetLiveChapterState();
    if (!userPinnedChapter) focusNewestChapter();
  }

  function stampLiveMarker(key) {
    ensureLiveChapter();
    if (!liveChapterMeta.markers) liveChapterMeta.markers = [];
    if (!liveChapterMeta.markers.includes(key)) liveChapterMeta.markers.push(key);
  }

  // ── 渲染：按模型轮次的执行流 ──

  const PHASE_LABELS = {
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
    const active = pickActiveStep(currentPlan);
    if (active) {
      record.activeTitle = active.title || '';
      record.phase = active.phase || '';
    } else if (currentPlan) {
      record.phase = currentPlan.phase || '';
    }
  }

  function ensureRoundRecord(iteration, ts) {
    const normalized = normalizeRoundIteration(iteration);
    const key = String(normalized);
    let record = roundRecordByIteration[key];
    let created = false;
    if (!record) {
      created = true;
      let inferredStart = typeof ts === 'number' ? ts : Date.now();
      if (normalized === 1 && typeof turnStartedAt === 'number') {
        inferredStart = turnStartedAt;
      } else {
        for (let previousIndex = 0; previousIndex < roundRecords.length; previousIndex++) {
          const previousRecord = roundRecords[previousIndex];
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
      roundRecords.sort((a, b) =>  a.iteration - b.iteration);
      roundRecordByIteration[key] = record;
      if (roundRecords.length > MAX_ROUND_HISTORY) {
        const removed = roundRecords.shift();
        if (removed) delete roundRecordByIteration[String(removed.iteration)];
      }
    } else if (typeof ts === 'number' && ts < record.startTs) {
      record.startTs = ts;
    }
    snapshotRoundPlan(record);
    return { record, created };
  }

  function addUniqueStrings(target, values) {
    if (!Array.isArray(values)) return;
    for (let i = 0; i < values.length; i++) {
      if (!target.includes(values[i])) target.push(values[i]);
    }
  }

  function applyRoundActivity(evt) {
    try {
      if (!evt || !evt.type) return;
      if (evt.type !== 'model_task_final') {
        ensureTurnTimerRunning(typeof evt.ts === 'number' ? evt.ts : undefined);
      }
      markLiveChapterRunning();
      const ts = typeof evt.ts === 'number' ? evt.ts : Date.now();
      const roundResult = ensureRoundRecord(evt.iteration, ts);
      const record = roundResult.record;
      if (evt.type === 'model_round_end' || evt.type === 'model_task_final') {
        record.endTs = ts;
        record.status = 'done';
        if (evt.stopReason) record.stopReason = String(evt.stopReason);
      }
      if (evt.type === 'model_task_final') {
        // 最终轮：标记任务完成，供轮次卡展示「已完成」结果。
        record.isFinal = true;
        markRoundsComplete(record.iteration);
        endTurnTimer(ts);
      }
      if (evt.executionMode) {
        addUniqueStrings(record.signals, evt.executionMode.enteredBy || []);
        if (evt.executionMode.primaryReasonHuman && !record.reasonHuman) {
          record.reasonHuman = evt.executionMode.primaryReasonHuman;
        }
      }
      if (evt.reason || evt.message) {
        const branchReason = String(evt.message || evt.reason);
        if (!record.branchReasons.includes(branchReason)) {
          record.branchReasons.push(branchReason);
        }
      }
      syncRoundTimeline({ iteration: record.iteration, insert: roundResult.created });
      renderEmptyState();
      if (typeof turnStartedAt === 'number' && turnEndedAt === null) startTick();
      if (evt.stopReason === 'circuit_breaker') stampLiveMarker('circuit');
      if (evt.type === 'compaction' || evt.kind === 'compaction') stampLiveMarker('compaction');
      ensureLiveChapter();
      patchCurrentChapterChrome();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('applyRoundActivity', e);
    }
  }

  function getRoundTools(record) {
    const out = [];
    for (let i = 0; i < record.toolCallIds.length; i++) {
      const tool = toolRecordById[record.toolCallIds[i]];
      if (tool) out.push(tool);
    }
    return out;
  }

  function roundDuration(record) {
    let end = typeof record.endTs === 'number' ? record.endTs : Date.now();
    const tools = getRoundTools(record);
    for (let i = 0; i < tools.length; i++) {
      if (typeof tools[i].resultTs === 'number' && tools[i].resultTs > end) end = tools[i].resultTs;
    }
    const ms = Math.max(0, end - record.startTs);
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return formatClock(ms);
  }

  function previousRoundFailed(record) {
    let previous = null;
    for (let i = 0; i < roundRecords.length; i++) {
      if (roundRecords[i].iteration < record.iteration) previous = roundRecords[i];
    }
    if (!previous) return false;
    const tools = getRoundTools(previous);
    for (let j = 0; j < tools.length; j++) {
      if (toolStatusClass(tools[j].status) === 'failed') return true;
    }
    return false;
  }

  /** 任务完成时把仍在运行的历史轮统一收尾，避免遗留“进行中”状态。 */
  function markRoundsComplete(finalIteration) {
    for (let i = 0; i < roundRecords.length; i++) {
      const record = roundRecords[i];
      if (record.iteration <= finalIteration && record.status !== 'done') {
        record.status = 'done';
        if (typeof record.endTs !== 'number') record.endTs = Date.now();
      }
    }
  }

  const STOP_REASON_LABELS = {
    model_done: '模型已完成本次任务',
    stop_hook: '任务在收尾校验后完成',
    max_output_tokens: '输出达到上限后结束',
    completion_paused: '任务仍有未完成条件，已暂停',
    completion_failed: '任务未能完成必要条件',
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
    const parts = [];
    if (record.signals.length) {
      const labels = record.signals.map((signal) =>  MODE_SIGNAL_LABELS[signal] || signal);
      parts.push(`监管信号：${labels.join('、')}`);
    }
    if (record.branchReasons.length) {
      parts.push(`执行路径调整：${clamp40(record.branchReasons[record.branchReasons.length - 1])}`);
    }
    if (previousRoundFailed(record)) {
      parts.push('上一轮工具执行失败，需要调整策略并继续验证');
    }
    if (record.activeTitle) {
      parts.push(`为完成计划步骤「${clamp40(record.activeTitle)}」`);
    } else {
      const toolIntents = deriveRoundToolIntents(getRoundTools(record));
      for (let ti = 0; ti < toolIntents.length; ti++) parts.push(toolIntents[ti]);
    }
    return parts.join('；');
  }

  function estimateRemainingSeconds(plan) {
    if (!plan || !plan.steps || !plan.steps.length || isPlanComplete(plan)) return null;
    let remaining = 0;
    let samples = 0;
    let totalSampleMs = 0;
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
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
    const avg = samples ? totalSampleMs / samples : 8000;
    return Math.max(1, Math.round((avg * remaining) / 1000));
  }

  function roundVisualStatus(record) {
    if (record.isFinal && record.status === 'done') return 'done';
    const tools = getRoundTools(record);
    for (let i = 0; i < tools.length; i++) {
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
    return toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) =>  c.toUpperCase());
  }

  function deriveRoundTitle(record) {
    if (record.isFinal) return '整理结论';
    const tools = getRoundTools(record);
    if (!tools.length) {
      return record.activeTitle || '分析目标并规划下一步';
    }
    const command = findFirstToolBy(tools, (t) =>  t.toolName === 'run_command');
    if (command) {
      const cmd = command.detail || command.target || '';
      return cmd ? (`运行命令 ${String(cmd).slice(0, 24)}`) : '运行命令';
    }
    const reads = tools.filter((t) =>  CONTEXT_READ_TOOLS[t.toolName]);
    if (reads.length >= 2) return '读取核心文件理解实现';
    if (reads.length === 1) return '读取文件了解上下文';
    const writes = tools.filter((t) =>  CONTEXT_WRITE_TOOLS[t.toolName]);
    if (writes.length) return writes.length > 1 ? '批量修改文件' : '修改文件落实改动';
    const searches = tools.filter((t) =>  CONTEXT_SEARCH_TOOLS[t.toolName]);
    if (searches.length >= 2) return '搜索定位相关代码';
    if (searches.length === 1) return inferToolIntent(searches[0]);
    if (tools.length === 1) return inferToolIntent(tools[0]);
    if (record.activeTitle) return clamp40(record.activeTitle);
    if (record.phase && PHASE_LABELS[record.phase]) return PHASE_LABELS[record.phase];
    return `第 ${record.iteration} 轮执行`;
  }

  function buildAllRoundPills(tools) {
    const pills = [];
    const grouped = Object.create(null);
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      const key = tool.toolName + '|' + (tool.detail || tool.target || '');
      if (!grouped[key]) {
        grouped[key] = { tool, count: 0 };
      }
      grouped[key].count++;
    }
    const keys = Object.keys(grouped);
    for (let k = 0; k < keys.length; k++) {
      const entry = grouped[keys[k]];
      let label = inferToolIntent(entry.tool);
      if (entry.count > 1) label += ` x ${entry.count}`;
      pills.push({
        label,
        raw: entry.tool.toolName + (entry.tool.detail ? ` · ${entry.tool.detail}` : ''),
      });
    }
    return pills;
  }

  /** 折叠态：任意工具类型均只展示首个 +「...」。 */
  function buildCollapsedRoundPill(tools) {
    if (!tools.length) return [];
    const firstTool = tools[0];
    const label = inferToolIntent(firstTool);
    const path = firstTool.detail || firstTool.target || '';
    if (tools.length === 1) {
      return [{
        label,
        raw: firstTool.toolName + (path ? ` · ${path}` : ''),
      }];
    }
    return [{
      label: `${label}...`,
      raw: firstTool.toolName + (path ? ` · ${path}` : ''),
      title: `共 ${tools.length} 项`,
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
      const first = tools[0];
      return `c:${first.toolCallId}:${tools.length}`;
    }
    return 'e:' + tools.map((tool) =>  tool.toolCallId).join(',');
  }

  function renderRoundPills(summary, tools, record) {
    if (!summary) return;
    const collapsed = !isRoundExpanded(record);
    const pills = buildRoundPills(tools, collapsed);
    const host = summary.querySelector('.etl-round-meta') || summary;
    const wrap = host.querySelector('.etl-round-pills');
    if (!pills.length) {
      if (wrap) wrap.parentNode.removeChild(wrap);
      return;
    }
    const nextSig = roundPillSignature(tools, collapsed);
    if (wrap && wrap.dataset.pillSig === nextSig) return;
    if (wrap) wrap.parentNode.removeChild(wrap);
    const pillWrap = document.createElement('div');
    pillWrap.className = 'etl-round-pills' + (collapsed ? ' etl-round-pills--folded' : '');
    pillWrap.dataset.pillSig = nextSig;
    for (let p = 0; p < pills.length; p++) {
      const pill = document.createElement('span');
      pill.className = 'etl-round-pill';
      pill.textContent = pills[p].label;
      pill.title = pills[p].title || pills[p].raw || '';
      pillWrap.appendChild(pill);
    }
    host.appendChild(pillWrap);
  }

  /** 按当前展开态刷新所有可见轮次的摘要 pill（避免旧轮次残留多条工具标签）。 */
  function refreshVisibleRoundPillSummaries() {
    if (!roundTimelineEl) return;
    try {
      const nodes = roundTimelineEl.querySelectorAll('.etl-round-node');
      Array.prototype.forEach.call(nodes, (node) => {
        const iter = node.dataset.iteration;
        if (!iter) return;
        const record = roundRecordByIteration[iter];
        if (!record) return;
        const expanded = isRoundExpanded(record);
        node.classList.toggle('is-expanded', expanded);
        if (record.isFinal) node.classList.add('is-final');
        const row = node.querySelector('.etl-round-row');
        if (row) row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const toggle = node.querySelector('.etl-round-toggle');
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
    const status = toolStatusClass(tool.status);
    const row = document.createElement('li');
    row.className = `etl-round-action etl-round-tool status-${status}`;
    row.dataset.toolCallId = tool.toolCallId;
    row.title = '定位到对话';
    row.dataset.status = tool.status;
    if (typeof tool.callTs === 'number') row.dataset.callTs = String(tool.callTs);
    if (typeof tool.resultTs === 'number') row.dataset.resultTs = String(tool.resultTs);
    const icon = document.createElement('span');
    icon.className = 'etl-round-action-icon etl-round-tool-icon';
    icon.textContent = status === 'failed' ? '×' : '✓';
    const body = document.createElement('div');
    body.className = 'etl-round-action-body';
    const name = document.createElement('div');
    name.className = 'etl-round-action-name';
    name.textContent = inferToolIntent(tool);
    name.title = humanizeToolName(tool.toolName);
    body.appendChild(name);
    const detailLine = toolActionDetailLine(tool);
    if (detailLine) {
      const path = document.createElement('div');
      path.className = 'etl-round-action-target';
      path.textContent = detailLine;
      body.appendChild(path);
    }
    const dur = document.createElement('span');
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
    const visible = getVisibleRoundRecords();
    for (let i = 0; i < visible.length; i++) {
      if (visible[i].iteration === record.iteration) return true;
    }
    return false;
  }

  function findRoundNode(iteration) {
    if (!roundTimelineEl) return null;
    return roundTimelineEl.querySelector(`.etl-round-node[data-iteration="${iteration}"]`);
  }

  function getRoundListContext() {
    bindRoundTimelineEvents();
    if (!roundTimelineEl) return null;
    const empty = roundTimelineEl.querySelector('.etl-round-empty');
    const list = roundTimelineEl.querySelector('.etl-round-list');
    if (empty) empty.classList.add('hidden');
    return { empty, list };
  }

  function syncLoadMoreButton(force) {
    if (!roundTimelineEl) return;
    const loadMore = roundTimelineEl.querySelector('#etl-round-load-more');
    if (!loadMore) return;
    const hiddenCount = Math.max(0, roundRecords.length - roundVisibleLimit);
    // 前缀缺口与“本地隐藏数量”是两套独立状态；即使按钮数量未变化也必须刷新提示。
    syncPrefixGapHint();
    if (!force && hiddenCount === cachedLoadMoreHidden) return;
    cachedLoadMoreHidden = hiddenCount;
    loadMore.classList.toggle('hidden', hiddenCount <= 0);
    loadMore.textContent = '加载更早的轮次 ↓' + (hiddenCount ? ` (${hiddenCount})` : '');
  }

  /** 前缀缺口提示已废弃：编年史从会话数据回填，不再叫人去聊天区翻历史。 */
  function syncPrefixGapHint() {
    if (!roundTimelineEl) return;
    const hint = roundTimelineEl.querySelector('#etl-round-prefix-hint');
    if (!hint) return;
    hint.classList.add('hidden');
    hint.textContent = '';
  }

  function sliceCurrentTurnStructured(structured) {
    return Array.isArray(structured) ? structured : [];
  }

  function countAssembledWorkRounds(rounds) {
    let n = 0;
    if (!Array.isArray(rounds)) return 0;
    for (let i = 0; i < rounds.length; i++) {
      if (rounds[i] && !rounds[i].isFinal) n++;
    }
    return n;
  }

  function overlayRicherLiveChapter(chapter) {
    if (!chapter) return;
    let liveWork = 0;
    for (let i = 0; i < roundRecords.length; i++) {
      if (roundRecords[i] && !roundRecords[i].isFinal) liveWork++;
    }
    if (liveWork <= countAssembledWorkRounds(chapter.rounds)) return;
    const api = chronicleApi();
    if (!api || typeof api.fromLive !== 'function') return;
    const packed = api.fromLive({
      messageId: chapter.messageId,
      preview: chapter.preview,
      status: chapter.status,
      startedAt: liveChapterMeta && liveChapterMeta.startedAt,
      endedAt: turnEndedAt,
      markers: liveMarkersFromState(),
      roundRecords,
      toolRecords,
      plan: currentPlan,
    });
    if (!packed || countAssembledWorkRounds(packed.rounds) <= countAssembledWorkRounds(chapter.rounds)) return;
    chapter.rounds = packed.rounds;
    chapter.roundCount = packed.roundCount;
    chapter.toolCount = packed.toolCount;
    chapter.filesChangedCount = packed.filesChangedCount;
  }

  /**
   * 从 structured + UI 消息回填整本编年史。
   * 正在跑的活章不覆盖实时 tool/round。
   */
  function hydrateFromStructured(structured, uiMessages, toolTracesOpt) {
    try {
      try {
        scheduleSnapshotTimelineRefresh();
      } catch (fileErr) {
        safeWarn('hydrateFromStructured.files', fileErr);
      }
      const api = chronicleApi();
      let ui = Array.isArray(uiMessages) ? uiMessages : [];
      let traces = (toolTracesOpt && typeof toolTracesOpt === 'object') ? toolTracesOpt : null;
      try {
        if (window.ChatSession) {
          if (!ui.length && typeof window.ChatSession.getMessages === 'function') {
            ui = window.ChatSession.getMessages() || [];
          }
          if (!traces && typeof window.ChatSession.getToolTraces === 'function') {
            traces = window.ChatSession.getToolTraces() || {};
          }
        }
      } catch (_e) { /* ignore */ }
      if (api && typeof api.assemble === 'function') {
        let lastAssembledStatus = '';
        bindLiveChapterIdentity();
        const turnInFlight = isTurnInFlight();
        const liveRunning = (
          liveChapterStatus() === 'running'
          || turnInFlight
          || !!(liveChapterMeta && liveChapterMeta.status === 'running')
        ) && (hasLiveProgress() || turnInFlight || !!liveChapterMeta);
        const assembled = api.assemble({
          uiMessages: ui,
          structured,
          toolTraces: traces,
          checkpointEntries: snapshotCheckpointEntries,
          currentPlan: liveRunning ? currentPlan : null,
        });
        const lastCh = assembled && assembled.chapters && assembled.chapters.length
          ? assembled.chapters[assembled.chapters.length - 1]
          : null;
        lastAssembledStatus = lastCh && lastCh.status ? lastCh.status : '';
        if (lastCh && lastCh.messageId && liveChapterMeta && isSyntheticLiveId(liveChapterMeta.messageId)
          && (lastAssembledStatus === 'running' || turnInFlight)) {
          adoptLiveChapterIdentity(lastCh.messageId, lastCh.preview);
        }
        const hasLiveWork = hasLiveProgress() || turnInFlight;
        const lastIsSameDone = !!(lastCh && liveChapterMeta && lastCh.messageId
          && lastCh.messageId === liveChapterMeta.messageId
          && lastAssembledStatus && lastAssembledStatus !== 'running'
          && !turnInFlight);
        if (lastCh && hasLiveProgress()) overlayRicherLiveChapter(lastCh);
        const keepLive = hasLiveWork && !lastIsSameDone;
        applyAssembledChapters(assembled && assembled.chapters, { keepLive });
        if (typeof turnStartedAt !== 'number' && lastCh && typeof lastCh.startTs === 'number'
          && (keepLive || lastAssembledStatus === 'running')) {
          turnStartedAt = lastCh.startTs;
          turnEndedAt = null;
        }
        if (typeof turnStartedAt === 'number' && turnEndedAt === null) startTick();
        else if (!keepLive && lastAssembledStatus && lastAssembledStatus !== 'running') stopTick();
      } else {
        const slice = sliceCurrentTurnStructured(structured);
        if (!slice.length) return false;
        const baseTs = Date.now() - slice.length * 2000;
        let iteration = 0;
        for (let i = 0; i < slice.length; i++) {
          const msg = slice[i];
          if (!msg || msg.role !== 'assistant') continue;
          iteration++;
          if (roundRecordByIteration[String(iteration)]) continue;
          const roundTs = baseTs + iteration * 2000;
          const roundResult = ensureRoundRecord(iteration, roundTs);
          const record = roundResult.record;
          record.status = 'done';
          record.endTs = roundTs + 1500;
          const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
          for (let ti = 0; ti < toolCalls.length; ti++) {
            const tc = toolCalls[ti];
            if (!tc || !tc.name) continue;
            const callId = typeof tc.id === 'string' && tc.id
              ? tc.id
              : (`hydrate-${iteration}-${ti}`);
            if (toolRecordById[callId]) continue;
            const toolTs = roundTs + ti * 200;
            const toolRec = {
              toolCallId: callId,
              toolName: tc.name,
              callTs: toolTs,
              resultTs: toolTs + 100,
              status: 'done',
              detail: formatToolArgsPreview(tc.name, tc.arguments),
              target: extractToolTarget(tc.name, tc.arguments),
              iteration,
            };
            toolRecords.push(toolRec);
            toolRecordById[callId] = toolRec;
            if (!record.toolCallIds.includes(callId)) record.toolCallIds.push(callId);
            if (!toolCallIds[callId]) {
              toolCallIds[callId] = true;
              uniqueToolCallCount++;
            }
          }
        }
      }
      visible = !isPanelSuppressed() && (hasChronicleWork() || !!currentPlan);
      if (visible || hostEl) {
        ensureMounted();
        if (!userPinnedChapter) focusNewestChapter();
        renderChapterDirectory({ scrollToLatest: true });
        renderRoundTimeline(true);
        renderTaskOverview();
        renderCurrentStep();
        renderEmptyState();
        patchFooterToolCount();
        renderFooter();
        renderDockSheet();
      }
      scheduleFlowPersist();
      return true;
    } catch (e) {
      safeWarn('hydrateFromStructured', e);
      return false;
    }
  }

  function isRoundExpanded(record) {
    if (!record) return false;
    const key = String(record.iteration);
    return expandedRounds[key] === true;
  }

  function applyRoundExpandPresentation(roundNode, record) {
    if (!roundNode || !record) return;
    const expanded = isRoundExpanded(record);
    roundNode.classList.toggle('is-expanded', expanded);
    const row = roundNode.querySelector('.etl-round-row');
    if (row) row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const toggle = roundNode.querySelector('.etl-round-toggle');
    if (toggle) {
      toggle.textContent = expanded ? '▴' : '▾';
      toggle.setAttribute('aria-label', expanded ? '收起轮次详情' : '展开轮次详情');
    }
    if (expanded) {
      const pills = roundNode.querySelector('.etl-round-pills');
      if (pills) pills.parentNode.removeChild(pills);
      appendRoundDetailElement(roundNode, record);
      const detail = roundNode.querySelector('.etl-round-detail');
      const actions = detail && detail.querySelector('.etl-round-actions');
      if (actions) {
        const tools = getRoundTools(record);
        for (let i = 0; i < tools.length; i++) {
          if (!actions.querySelector(`[data-tool-call-id="${tools[i].toolCallId}"]`)) {
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
    const visualStatus = roundVisualStatus(record);
    const item = document.createElement('li');
    item.className = 'etl-round-node etl-round-card status-' + visualStatus
      + (record.isFinal ? ' is-final' : '');
    item.dataset.iteration = String(record.iteration);

    const row = document.createElement('div');
    row.className = 'etl-round-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'false');

    const marker = document.createElement('span');
    marker.className = 'etl-round-marker';
    marker.textContent = String(record.iteration);

    const summary = document.createElement('div');
    summary.className = 'etl-round-summary';

    const head = document.createElement('div');
    head.className = 'etl-round-head';
    const title = document.createElement('span');
    title.className = 'etl-round-title';
    title.textContent = deriveRoundTitle(record);
    const time = document.createElement('span');
    time.className = 'etl-round-duration';
    time.textContent = roundDuration(record);
    const toggle = makeRoundToggle(false);
    const badge = document.createElement('span');
    badge.className = `etl-round-badge status-${visualStatus}`;
    badge.textContent = roundStatusLabel(visualStatus);
    head.appendChild(title);
    head.appendChild(time);
    head.appendChild(badge);
    head.appendChild(toggle);
    summary.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'etl-round-meta';
    summary.appendChild(meta);

    const liveTools = document.createElement('ul');
    liveTools.className = 'etl-round-live-tools';
    summary.appendChild(liveTools);

    row.appendChild(marker);
    row.appendChild(summary);
    item.appendChild(row);
    return item;
  }

  function ensureLiveToolsList(roundNode) {
    if (!roundNode) return null;
    const summary = roundNode.querySelector('.etl-round-summary');
    if (!summary) return null;
    let list = summary.querySelector('.etl-round-live-tools');
    if (list) return list;
    list = document.createElement('ul');
    list.className = 'etl-round-live-tools';
    summary.appendChild(list);
    return list;
  }

  function syncRoundToolsPreview(roundNode, record) {
    if (!roundNode || !record || isRoundExpanded(record)) return;
    const summary = roundNode.querySelector('.etl-round-summary');
    if (!summary) return;
    renderRoundPills(summary, getRoundTools(record), record);
  }

  function appendToolRowToDetail(roundNode, tool) {
    if (!roundNode || !tool) return;
    appendRoundDetailElement(roundNode, roundRecordByIteration[roundNode.dataset.iteration]);
    const detail = roundNode.querySelector('.etl-round-detail');
    if (!detail) return;
    const actions = detail.querySelector('.etl-round-actions');
    if (!actions) return;
    if (!actions.querySelector(`[data-tool-call-id="${tool.toolCallId}"]`)) {
      actions.appendChild(makeRoundActionRow(tool));
      while (actions.children.length > MAX_TOOLS_PER_ROUND_DOM) {
        actions.removeChild(actions.firstElementChild);
      }
    }
  }

  function syncRoundFinalDetail(roundNode, record) {
    if (!roundNode || !record || !record.isFinal) return;
    const detail = roundNode.querySelector('.etl-round-detail');
    if (!detail || getRoundTools(record).length) return;
    const actionLabel = detail.querySelector('.etl-round-section-label');
    if (actionLabel) actionLabel.textContent = '本轮结果';
    if (!detail.querySelector('.etl-round-complete')) {
      rebuildRoundDetailBody(detail, record);
    } else {
      const completion = detail.querySelector('.etl-round-complete');
      if (completion) completion.textContent = roundCompletionText(record);
    }
  }

  /** 对齐 chat appendToolAction：折叠态写入隐藏槽供 patch；展开态只写入 detail。 */
  function appendLiveToolToRound(roundNode, tool) {
    if (!roundNode || !tool || !tool.toolCallId) return;
    const record = roundRecordByIteration[roundNode.dataset.iteration];
    if (!record) return;
    if (isRoundExpanded(record)) {
      appendToolRowToDetail(roundNode, tool);
      return;
    }
    const list = ensureLiveToolsList(roundNode);
    if (!list || list.querySelector(`[data-tool-call-id="${tool.toolCallId}"]`)) return;
    list.appendChild(makeRoundActionRow(tool));
    while (list.children.length > MAX_TOOLS_PER_ROUND_DOM) {
      list.removeChild(list.firstElementChild);
    }
    syncRoundToolsPreview(roundNode, record);
  }

  function patchRoundShellSummary(roundNode, record) {
    if (!roundNode || !record) return;
    const visualStatus = roundVisualStatus(record);
    roundNode.classList.remove('status-done', 'status-failed', 'status-running');
    roundNode.classList.add(`status-${visualStatus}`);
    roundNode.classList.toggle('is-final', !!record.isFinal);
    const marker = roundNode.querySelector('.etl-round-marker');
    if (marker) marker.textContent = String(record.iteration);
    const title = roundNode.querySelector('.etl-round-title');
    if (title) title.textContent = deriveRoundTitle(record);
    const badge = roundNode.querySelector('.etl-round-badge');
    if (badge) {
      badge.className = `etl-round-badge status-${visualStatus}`;
      badge.textContent = roundStatusLabel(visualStatus);
    }
    const time = roundNode.querySelector('.etl-round-duration');
    if (time) time.textContent = roundDuration(record);
    applyRoundExpandPresentation(roundNode, record);
    syncRoundFinalDetail(roundNode, record);
  }

  function patchFooterToolCount() {
    if (!footerEl) return;
    ensureFooterSkeleton();
    const liveToolCount = sessionToolTotal();
    const toolTxt = liveToolCount > 0 || authoritativeToolCalls !== null ? String(liveToolCount) : '—';
    const toolEl = footerEl.querySelector('.etl-foot-tool b');
    if (toolEl && toolEl.textContent !== toolTxt) toolEl.textContent = toolTxt;
  }

  /** 新增可见轮次：≤limit append 壳；>limit remove 首条再 append。 */
  function pushRoundShellToList(list, record) {
    if (!list || !record) return null;
    if (findRoundNode(record.iteration)) return findRoundNode(record.iteration);
    const fresh = createRoundShell(record);
    if (list.children.length >= roundVisibleLimit) {
      const first = list.firstElementChild;
      if (first) list.removeChild(first);
    }
    list.appendChild(fresh);
    return fresh;
  }

  /** 加载更早轮次：在列表头部按时间顺序 prepend 尚未渲染的轮次。 */
  function prependMissingRoundNodes(list, records) {
    if (!list || !records || !records.length) return;
    const missing = [];
    for (let i = 0; i < records.length; i++) {
      if (!findRoundNode(records[i].iteration)) missing.push(records[i]);
    }
    for (let j = missing.length - 1; j >= 0; j--) {
      list.insertBefore(materializeRoundNode(missing[j]), list.firstElementChild);
    }
  }

  function materializeRoundNode(record) {
    const node = createRoundShell(record);
    if (!isRoundExpanded(record)) {
      const tools = getRoundTools(record);
      for (let i = 0; i < tools.length; i++) {
        const list = ensureLiveToolsList(node);
        if (list && !list.querySelector(`[data-tool-call-id="${tools[i].toolCallId}"]`)) {
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
    const visible = getVisibleRoundRecords();
    for (let i = 0; i < visible.length; i++) {
      list.appendChild(materializeRoundNode(visible[i]));
    }
  }

  function rebuildRoundPillsInNode(roundNode, record) {
    const summary = roundNode.querySelector('.etl-round-summary');
    if (!summary) return;
    renderRoundPills(summary, getRoundTools(record), record);
  }

  function patchRoundReason(roundNode, record) {
    const detail = roundNode.querySelector('.etl-round-detail');
    if (!detail) return;
    const reasons = detail.querySelectorAll('.etl-round-reason');
    const reason = reasons.length ? reasons[reasons.length - 1] : null;
    if (reason) reason.textContent = deriveRoundReason(record);
  }

  function rebuildRoundDetailBody(detail, record) {
    const label = detail.querySelector('.etl-round-section-label');
    if (!label) return;
    label.textContent = record.isFinal ? '本轮结果' : '做了什么';
    while (label.nextSibling) detail.removeChild(label.nextSibling);
    const tools = getRoundTools(record);
    if (tools.length) {
      const actionList = document.createElement('ul');
      actionList.className = 'etl-round-actions';
      for (let i = 0; i < tools.length; i++) {
        actionList.appendChild(makeRoundActionRow(tools[i]));
      }
      detail.appendChild(actionList);
    } else if (record.isFinal) {
      const completion = document.createElement('div');
      completion.className = 'etl-round-complete';
      completion.textContent = roundCompletionText(record);
      detail.appendChild(completion);
    } else {
      const planning = document.createElement('div');
      planning.className = 'etl-round-reason';
      planning.textContent = record.activeTitle || '分析目标并生成下一步动作';
      detail.appendChild(planning);
    }
    const reasonLabel = document.createElement('div');
    reasonLabel.className = 'etl-round-section-label';
    reasonLabel.textContent = '为什么这么做';
    const reason = document.createElement('div');
    reason.className = 'etl-round-reason';
    reason.textContent = deriveRoundReason(record);
    detail.appendChild(reasonLabel);
    detail.appendChild(reason);
  }

  function appendRoundDetailElement(item, record) {
    if (!item || item.querySelector('.etl-round-detail')) return;
    const tools = getRoundTools(record);
    const detail = document.createElement('div');
    detail.className = 'etl-round-detail';

    const actionLabel = document.createElement('div');
    actionLabel.className = 'etl-round-section-label';
    actionLabel.textContent = record.isFinal ? '本轮结果' : '做了什么';
    detail.appendChild(actionLabel);

    if (tools.length) {
      const actionList = document.createElement('ul');
      actionList.className = 'etl-round-actions';
      for (let i = 0; i < tools.length; i++) {
        actionList.appendChild(makeRoundActionRow(tools[i]));
      }
      detail.appendChild(actionList);
    } else if (record.isFinal) {
      const completion = document.createElement('div');
      completion.className = 'etl-round-complete';
      completion.textContent = roundCompletionText(record);
      detail.appendChild(completion);
    } else {
      const planning = document.createElement('div');
      planning.className = 'etl-round-reason';
      planning.textContent = record.activeTitle || '分析目标并生成下一步动作';
      detail.appendChild(planning);
    }

    const reasonLabel = document.createElement('div');
    reasonLabel.className = 'etl-round-section-label';
    reasonLabel.textContent = '为什么这么做';
    const reason = document.createElement('div');
    reason.className = 'etl-round-reason';
    reason.textContent = deriveRoundReason(record);
    detail.appendChild(reasonLabel);
    detail.appendChild(reason);
    item.appendChild(detail);
  }

  function patchRoundToolRow(row, tool) {
    if (!row || !tool) return;
    const status = toolStatusClass(tool.status);
    row.className = `etl-round-action etl-round-tool status-${status}`;
    row.dataset.status = tool.status;
    if (typeof tool.callTs === 'number') row.dataset.callTs = String(tool.callTs);
    if (typeof tool.resultTs === 'number') row.dataset.resultTs = String(tool.resultTs);
    const icon = row.querySelector('.etl-round-action-icon');
    if (icon) icon.textContent = status === 'failed' ? '×' : '✓';
    const dur = row.querySelector('.etl-round-action-dur');
    if (dur) dur.textContent = formatToolDuration(tool);
  }

  function tryPatchRoundToolRow(tool) {
    if (!tool || !tool.toolCallId) return false;
    const rows = [];
    if (roundTimelineEl) {
      const matches = roundTimelineEl.querySelectorAll(`[data-tool-call-id="${tool.toolCallId}"]`);
      Array.prototype.forEach.call(matches, (row) => { rows.push(row); });
    }
    if (!rows.length) return false;
    for (let i = 0; i < rows.length; i++) patchRoundToolRow(rows[i], tool);
    return true;
  }

  function attachLiveTimelineIfRunning() {
    if (!roundTimelineEl || !hostEl) return false;
    if (!selectedChapterIsLive()) return false;
    roundTimelineEl.classList.remove('hidden');
    const flow = hostEl.querySelector('#etl-panel-flow');
    if (flow && roundTimelineEl.parentNode !== flow) flow.appendChild(roundTimelineEl);
    return true;
  }

  function renderFrozenSelectedFlow() {
    if (!roundTimelineEl) return;
    roundTimelineEl.classList.remove('hidden');
    const list = roundTimelineEl.querySelector('.etl-round-list');
    const empty = roundTimelineEl.querySelector('.etl-round-empty');
    const loadMore = roundTimelineEl.querySelector('#etl-round-load-more');
    if (loadMore) loadMore.classList.add('hidden');
    if (!list) return;
    list.innerHTML = '';
    const ch = getSelectedChapter();
    const rounds = (ch && ch.rounds) || [];
    if (empty) {
      empty.textContent = ch ? '本章暂无执行步骤' : '等待模型开始执行';
      empty.classList.toggle('hidden', rounds.length > 0);
    }
    for (let r = 0; r < rounds.length; r++) {
      list.appendChild(makeFrozenRoundNode(rounds[r]));
    }
    updateFlowStepCount(rounds.length);
    if (taskOverviewEl && !(ch && ch.live)) {
      taskOverviewEl.classList.add('hidden');
    }
    if (currentStepEl && !(ch && ch.live && ch.status === 'running')) {
      currentStepEl.classList.add('hidden');
    }
  }

  function syncRoundTimeline(options) {
    options = options || {};
    if (!attachLiveTimelineIfRunning()) {
      return;
    }
    try {
      const ctx = getRoundListContext();
      if (!ctx || !ctx.list) return;

      if (options.reset) {
        ctx.list.innerHTML = '';
        cachedLoadMoreHidden = -1;
      }

      if (options.iteration != null) {
        const rec = roundRecordByIteration[String(options.iteration)];
        if (!rec || !isRoundInVisibleWindow(rec)) {
          const stale = findRoundNode(options.iteration);
          if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
          syncLoadMoreButton();
          return;
        }
        if (options.tool && options.mode === 'append') {
          const liveNode = findRoundNode(rec.iteration);
          if (liveNode) {
            appendLiveToolToRound(liveNode, options.tool);
            patchRoundShellSummary(liveNode, rec);
            return;
          }
        }
        if (options.insert) {
          const shell = pushRoundShellToList(ctx.list, rec);
          if (shell && options.tool) appendLiveToolToRound(shell, options.tool);
          if (shell) patchRoundShellSummary(shell, rec);
          syncLoadMoreButton();
          return;
        }
        const existing = findRoundNode(rec.iteration);
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
      updateFlowStepCount(roundRecords.length);
    } catch (e) {
      safeWarn('syncRoundTimeline', e);
    }
  }

  function renderRoundTimeline(reset) {
    if (attachLiveTimelineIfRunning()) {
      syncRoundTimeline({ reset: !!reset });
      return;
    }
    renderFrozenSelectedFlow();
  }

  function toggleRoundExpanded(iteration) {
    const key = String(iteration);
    const record = roundRecordByIteration[key];
    expandedRounds[key] = !isRoundExpanded(record);
    const node = findRoundNode(iteration);
    if (!node || !record) return;
    applyRoundExpandPresentation(node, record);
  }

  function handleRoundTimelineInteraction(event) {
    try {
      const target = event.target;
      if (!target || !target.closest) return;
      const loadMore = target.closest('#etl-round-load-more');
      if (loadMore) {
        roundVisibleLimit += 8;
        cachedLoadMoreHidden = -1;
        syncRoundTimeline({ loadMore: true });
        return;
      }
      const action = target.closest('.etl-round-action[data-tool-call-id]');
      if (action && event.type === 'click') {
        jumpToChatTool(action.getAttribute('data-tool-call-id'));
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const row = target.closest('.etl-round-row');
      if (!row) return;
      const node = row.closest('.etl-round-node');
      if (!node || !node.dataset.iteration) return;
      if (node.dataset.frozen === '1') return;
      if (event.type === 'keydown') {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
      } else if (target.closest('.etl-round-toggle')) {
        event.preventDefault();
      }
      toggleRoundExpanded(node.dataset.iteration);
      event.stopPropagation();
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

  function buildTaskOverviewSkeleton() {
    taskOverviewEl.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'etl-overview-label';
    label.textContent = '当前目标';
    taskOverviewEl.appendChild(label);

    const head = document.createElement('div');
    head.className = 'etl-overview-head';
    const goal = document.createElement('div');
    goal.className = 'etl-overview-goal';
    goal.id = 'etl-overview-goal';
    const badge = document.createElement('span');
    badge.className = 'etl-overview-badge hidden';
    badge.id = 'etl-overview-badge';
    badge.textContent = '监管接管中';
    head.appendChild(goal);
    head.appendChild(badge);
    taskOverviewEl.appendChild(head);

    const progressWrap = document.createElement('div');
    progressWrap.className = 'etl-overview-progress';
    const bar = document.createElement('div');
    bar.className = 'etl-overview-bar';
    const fill = document.createElement('div');
    fill.className = 'etl-overview-bar-fill';
    fill.id = 'etl-overview-bar-fill';
    bar.appendChild(fill);
    const progressMeta = document.createElement('div');
    progressMeta.className = 'etl-overview-progress-meta';
    progressMeta.id = 'etl-overview-progress-meta';
    progressWrap.appendChild(bar);
    progressWrap.appendChild(progressMeta);
    taskOverviewEl.appendChild(progressWrap);

    const grid = document.createElement('div');
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

    const intentEl = document.createElement('div');
    intentEl.className = 'etl-overview-intent hidden';
    intentEl.id = 'etl-overview-intent';
    taskOverviewEl.appendChild(intentEl);
  }

  function formatGoalDisplay(goal, active) {
    const raw = goal || (active && active.title) || '当前任务';
    if (!raw || raw === '当前任务') return raw;
    const skillMatch = raw.match(/\[Active Skill:\s*([^\]]+)\]/);
    if (skillMatch) {
      return `[Active Skill: ${skillMatch[1].trim()}]`;
    }
    if (raw.length > 240) {
      let trimmed = raw.slice(0, 240);
      trimmed = trimmed.replace(/\s+\S*$/, '');
      return `${trimmed}…`;
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

      const steps = currentPlan.steps || [];
      const total = steps.length;
      const done = countFinished(steps);
      const pct = total ? Math.round((done / total) * 100) : (currentPlan.progress || 0);
      const active = pickActiveStep(currentPlan);
      const intent = INTENT_LABELS[currentPlan.intent] || currentPlan.intent || '';
      const forced = currentExecutionMode && currentExecutionMode.executionMode === 'forced';
      const remainSec = estimateRemainingSeconds(currentPlan);

      const goalEl = taskOverviewEl.querySelector('#etl-overview-goal');
      if (goalEl) {
        goalEl.textContent = formatGoalDisplay(currentPlan.goal, active);
      }
      const badgeEl = taskOverviewEl.querySelector('#etl-overview-badge');
      if (badgeEl) badgeEl.classList.toggle('hidden', !forced);

      const fillEl = taskOverviewEl.querySelector('#etl-overview-bar-fill');
      if (fillEl) fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      const progressMetaEl = taskOverviewEl.querySelector('#etl-overview-progress-meta');
      if (progressMetaEl) {
        let progressText = total ? (`${done} / ${total} 步骤`) : (`${pct}% 进度`);
        if (remainSec !== null && !isPlanComplete(currentPlan)) {
          progressText += ` · 预计 ${remainSec}s 完成`;
        } else if (isPlanComplete(currentPlan)) {
          progressText += ' · 已完成';
        }
        progressMetaEl.textContent = progressText;
      }

      const gridEl = taskOverviewEl.querySelector('#etl-overview-grid');
      if (gridEl) {
        gridEl.classList.toggle('hidden', !forced);
        if (forced) {
          const reasonEl = taskOverviewEl.querySelector('#etl-overview-reason');
          if (reasonEl) reasonEl.textContent = formatSupervisionReason(currentExecutionMode);
          const roundEl = taskOverviewEl.querySelector('#etl-overview-round');
          if (roundEl) {
            const roundNo = typeof currentExecutionMode.round === 'number'
              ? currentExecutionMode.round
              : (roundRecords.length ? roundRecords[roundRecords.length - 1].iteration : '—');
            roundEl.textContent = `第 ${roundNo} 轮`;
          }
        }
      }

      const intentEl = taskOverviewEl.querySelector('#etl-overview-intent');
      if (intentEl) {
        if (intent) {
          const phase = active && active.phase ? (PHASE_LABELS[active.phase] || active.phase) : '已结束';
          intentEl.textContent = `意图：${intent} · 阶段：${phase}`;
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
      ensureTurnTimerRunning(typeof step.ts === 'number' ? step.ts : undefined);
      markLiveChapterRunning();
      if (step.type === 'tool_call') {
        const callId = typeof step.toolCallId === 'string' ? step.toolCallId : '';
        if (!callId) return;
        const toolName = typeof step.toolName === 'string' ? step.toolName : '';
        const callTs = typeof step.ts === 'number' ? step.ts : Date.now();
        const roundResult = ensureRoundRecord(step.iteration, callTs);
        const round = roundResult.record;
        let createdTool = false;
        let historyTrimmed = false;
        if (!toolRecordById[callId]) {
          createdTool = true;
          const record = {
            toolCallId: callId,
            toolName,
            callTs,
            resultTs: null,
            status: 'running',
            detail: formatToolArgsPreview(toolName, step.toolArgs),
            target: extractToolTarget(toolName, step.toolArgs),
            iteration: round.iteration,
          };
          toolRecords.push(record);
          toolRecordById[callId] = record;
          if (!round.toolCallIds.includes(callId)) round.toolCallIds.push(callId);
          if (!toolCallIds[callId]) {
            toolCallIds[callId] = true;
            uniqueToolCallCount++;
          }
          if (toolRecords.length > MAX_TOOL_HISTORY) {
            const removed = toolRecords.shift();
            if (removed) delete toolRecordById[removed.toolCallId];
            historyTrimmed = true;
          }
        }
        lastTool = { toolCallId: callId, toolName, pending: true, ts: callTs };
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
          if (dockSheetKind === 'tools') renderDockTools();
        }
      } else if (step.type === 'tool_result') {
        const resultId = typeof step.toolCallId === 'string' ? step.toolCallId : '';
        const matched = resultId ? toolRecordById[resultId] : null;
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
          const matchedRoundResult = ensureRoundRecord(matched.iteration, matched.callTs);
          const matchedRound = matchedRoundResult.record;
          if (matched.resultTs > (matchedRound.endTs || 0)) matchedRound.endTs = matched.resultTs;
          const roundTools = getRoundTools(matchedRound);
          let allDone = roundTools.length > 0;
          for (let ri = 0; ri < roundTools.length; ri++) {
            if (toolStatusClass(roundTools[ri].status) === 'running') allDone = false;
          }
          if (allDone) matchedRound.status = 'done';
          if (tryPatchRoundToolRow(matched)) {
            const roundNode = findRoundNode(matchedRound.iteration);
            if (roundNode) patchRoundShellSummary(roundNode, matchedRound);
          } else {
            syncRoundTimeline({ iteration: matchedRound.iteration });
          }
        }
        if (lastTool.pending && resultId && lastTool.toolCallId === resultId) {
          lastTool.pending = false;
          renderLlmActivity();
        }
        const resultName = (matched && matched.toolName) || step.toolName || '';
        if (CONTEXT_WRITE_TOOLS[resultName] && step.toolSuccess !== false) {
          scheduleSnapshotTimelineRefresh();
        }
      }
      ensureLiveChapter();
      if (hostEl && chapterTimelineEl && !chapterTimelineEl.querySelector('.etl-chapter-node.is-current')) {
        renderChapterDirectory();
      } else {
        patchCurrentChapterChrome();
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
      renderChapterDirectory();
      renderRoundTimeline(true);
      renderEmptyState();
      renderLlmActivity();
      renderFooter();
      renderDockSheet();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('resetToolActivity', e);
    }
  }

  function beginTurnTimer(ts, meta) {
    try {
      recoverPanelAfterFatal();
      turnStartedAt = typeof ts === 'number' ? ts : Date.now();
      turnEndedAt = null;
      markLiveChapterRunning(meta && typeof meta === 'object' ? meta : {});
      renderFooter();
      startTick();
      if (hostEl) {
        renderChapterDirectory();
        renderRoundTimeline(true);
        renderCurrentStep();
        renderEmptyState();
        hideParkedLiveWidgets();
      }
    } catch (e) {
      safeWarn('beginTurnTimer', e);
    }
  }

  function endTurnTimer(ts) {
    try {
      if (typeof turnStartedAt !== 'number' || typeof turnEndedAt === 'number') return;
      turnEndedAt = typeof ts === 'number' ? Math.max(turnStartedAt, ts) : Date.now();
      if (liveChapterMeta && liveChapterHasStopped()) {
        liveChapterMeta.status = liveChapterStatus();
      }
      renderFooter();
      patchCurrentChapterChrome();
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
    renderChapterDirectory({ scrollToLatest: true });
    renderTaskOverview();
    renderRoundTimeline(true);
    renderCurrentStep();
    hideParkedLiveWidgets();
    renderEmptyState();
    renderList();
    renderLlmActivity();
    renderFooter();
    renderDockSheet();
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
      const prevId = currentPlan && currentPlan.planId;
      if (frozenPlanId && prevId === plan.planId && frozenPlanId === plan.planId) {
        recoverPanelAfterFatal();
        return;
      }
      if (!prevId || prevId !== plan.planId) {
        frozenPlanId = null;
      }
      currentPlan = plan;
      ensureLiveChapter();
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
      const wasComplete = isPlanComplete(currentPlan);

      if (Array.isArray(patch.stepPatches)) {
        for (let i = 0; i < patch.stepPatches.length; i++) {
          try {
            const sp = patch.stepPatches[i];
            if (!sp || typeof sp !== 'object' || !sp.id || !Array.isArray(currentPlan.steps)) continue;
            const stepObj = currentPlan.steps.find((s) =>  s && s.id === sp.id);
            if (stepObj) {
              Object.assign(stepObj, sp);
            }
            if (listEl) {
              const stepEl = listEl.querySelector(`.exec-plan-step[data-step-id="${sp.id}"]`);
              applyPatchToStep(stepEl, sp);
            }
          } catch (itemError) {
            safeWarn(`applyPatch.stepPatches[${i}]`, itemError);
          }
        }
      }

      if (patch.activeStepId !== undefined) {
        currentPlan.activeStepId = patch.activeStepId || undefined;
        if (listEl) {
          const actives = listEl.querySelectorAll('.exec-plan-step.active');
          actives.forEach((n) => {
            n.classList.remove('active');
          });
          if (currentPlan.activeStepId) {
            const newActive = listEl.querySelector(
              `.exec-plan-step[data-step-id="${currentPlan.activeStepId}"]`,
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
        let terminalEnd = null;
        for (let endIndex = 0; endIndex < currentPlan.steps.length; endIndex++) {
          const endedAt = currentPlan.steps[endIndex] && currentPlan.steps[endIndex].endedAt;
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
        if (typeof turnStartedAt !== 'number' || typeof turnEndedAt === 'number') stopTick();
        applyVisibility();
      } else if (hasRunningStep() || (typeof turnStartedAt === 'number' && turnEndedAt === null)) {
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

  function clear(opts) {
    try {
      opts = opts || {};
      if (opts.sealChapter) {
        sealLiveChapter({ status: opts.status || 'done', nextMeta: opts.nextMeta });
        visible = !isPanelSuppressed();
        applyVisibility();
        notifyPetFoot();
        return;
      }
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
      sealedChapters = [];
      sealedToolCount = 0;
      liveChapterMeta = null;
      selectedChapterKey = '';
      userPinnedChapter = false;
      chapterVisibleLimit = 30;
      pendingRevealMessageId = '';
      setDockSheet('');
      // 文件列表来自 checkpoint；切会话/回滚时清视图，新一轮保留到下次拉取。
      if (snapshotFilesRefreshTimer) {
        clearTimeout(snapshotFilesRefreshTimer);
        snapshotFilesRefreshTimer = 0;
      }
      if (opts.resetSessionFiles !== false) snapshotChangedFiles = [];
      snapshotCheckpointIds = Object.create(null);
      snapshotCheckpointEntries = [];
      snapshotCursorMessageId = '';
      snapshotCursorRestored = false;
      try {
        if (window.ChatUI && typeof window.ChatUI.setCursorMessageId === 'function') {
          window.ChatUI.setCursorMessageId('');
        }
      } catch (_e) { /* ignore */ }
      if (typeof turnStartedAt !== 'number' || typeof turnEndedAt === 'number') stopTick();
      turnStartedAt = null;
      turnEndedAt = null;
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
        renderChapterDirectory();
        renderRoundTimeline(true);
        renderExecutionModeBanner();
        renderFooter();
        renderDockSheet();
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
      currentExecutionMode = { ...step.executionMode };
      stampLiveMarker('supervision');
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
    for (let i = 0; i < records.length; i++) {
      const rr = records[i];
      if (rr && typeof rr.iteration === 'number') {
        roundRecordByIteration[String(rr.iteration)] = rr;
      }
    }
  }

  function rebuildToolIndexes(records) {
    toolRecordById = Object.create(null);
    toolCallIds = Object.create(null);
    uniqueToolCallCount = 0;
    for (let i = 0; i < records.length; i++) {
      const tr = records[i];
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
    flowPersistTimer = setTimeout(() => {
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
      const rounds = [];
      for (let i = 0; i < roundRecords.length; i++) {
        const clonedRound = cloneRoundRecord(roundRecords[i]);
        if (clonedRound) rounds.push(clonedRound);
      }
      const tools = [];
      for (let j = 0; j < toolRecords.length; j++) {
        const clonedTool = cloneToolRecord(toolRecords[j]);
        if (clonedTool) tools.push(clonedTool);
      }
      return {
        currentPlan: currentPlan ? JSON.parse(JSON.stringify(currentPlan)) : null,
        frozenPlanId,
        currentExecutionMode: currentExecutionMode
          ? { ...currentExecutionMode }
          : null,
        roundRecords: rounds,
        toolRecords: tools,
        lastTool: { ...lastTool },
        footerStats: { ...footerStats },
        turnStartedAt,
        turnEndedAt,
        uniqueToolCallCount,
        calibratedUniqueToolCount,
        authoritativeToolCalls: typeof authoritativeToolCalls === 'number'
          ? authoritativeToolCalls
          : null,
        sealedChapters: JSON.parse(JSON.stringify(sealedChapters)),
        liveChapterMeta: liveChapterMeta ? { ...liveChapterMeta } : null,
        sealedToolCount,
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
      const rounds = [];
      if (Array.isArray(snapshot.roundRecords)) {
        for (let i = 0; i < snapshot.roundRecords.length; i++) {
          const rr = cloneRoundRecord(snapshot.roundRecords[i]);
          if (rr) rounds.push(rr);
        }
      }
      roundRecords = rounds;
      rebuildRoundIndexes(rounds);

      const tools = [];
      if (Array.isArray(snapshot.toolRecords)) {
        for (let j = 0; j < snapshot.toolRecords.length; j++) {
          const tr = cloneToolRecord(snapshot.toolRecords[j]);
          if (tr) tools.push(tr);
        }
      }
      toolRecords = tools;
      rebuildToolIndexes(tools);

      lastTool = snapshot.lastTool && typeof snapshot.lastTool === 'object'
        ? { toolCallId: '', toolName: '', pending: false, ts: 0, ...snapshot.lastTool }
        : { toolCallId: '', toolName: '', pending: false, ts: 0 };
      footerStats = snapshot.footerStats && typeof snapshot.footerStats === 'object'
        ? { totalTokenUsage: null, totalToolCalls: null, ...snapshot.footerStats }
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
      if (Array.isArray(snapshot.sealedChapters)) {
        sealedChapters = snapshot.sealedChapters;
      }
      if (snapshot.liveChapterMeta && typeof snapshot.liveChapterMeta === 'object') {
        liveChapterMeta = { ...snapshot.liveChapterMeta };
      }
      if (typeof snapshot.sealedToolCount === 'number') {
        sealedToolCount = snapshot.sealedToolCount;
      }

      if (!opts.overlayOnly) {
        currentPlan = snapshot.currentPlan && hasSafePlanShape(snapshot.currentPlan)
          ? snapshot.currentPlan
          : null;
        frozenPlanId = snapshot.frozenPlanId || null;
        currentExecutionMode = snapshot.currentExecutionMode
          ? { ...snapshot.currentExecutionMode }
          : null;
      }

      visible = !isPanelSuppressed()
        && !!(currentPlan || currentExecutionMode || roundRecords.length || sealedChapters.length);
      if (visible || hostEl) {
        ensureMounted();
        fullRender();
      } else {
        applyVisibility();
      }
      if (typeof turnStartedAt === 'number' && turnEndedAt === null) startTick();
      else if (hasRunningStep()) startTick();
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
    return currentExecutionMode ? { ...currentExecutionMode } : null;
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
        const panelPlan = graphPlanToPanel(data.plan);
        if (panelPlan) {
          setPlan(panelPlan);
          return;
        }
      }
      if (!data.graphGoal) return;
      currentPlan = {
        planId: `graph-${Date.now()}`,
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
        if (typeof turnStartedAt !== 'number' || typeof turnEndedAt === 'number') stopTick();
      }
      if (listEl) {
        const items = listEl.querySelectorAll('.exec-plan-step');
        for (let i = 0; i < items.length; i++) {
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
      const items = listEl.querySelectorAll('.exec-plan-step');
      for (let i = 0; i < items.length; i++) {
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
      if (typeof turnStartedAt !== 'number' || typeof turnEndedAt === 'number') stopTick();
      applyVisibility();
      notifyPetFoot();
      scheduleFlowPersist();
    } catch (e) {
      safeWarn('markGraphComplete', e);
      teardownMounts();
    }
  }

  // ── 检查点数据：回滚按钮挂在章节上；变更文件走底栏弹出层 ──

  function normalizeChangedPath(p) {
    const text = String(p || '').trim().split(/\r?\n/)[0] || '';
    return text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  }

  function applyCheckpointChangedFiles(files) {
    snapshotChangedFiles = [];
    if (!Array.isArray(files)) return;
    for (let i = 0; i < files.length; i++) {
      const fe = files[i];
      if (!fe || typeof fe.path !== 'string') continue;
      const path = normalizeChangedPath(fe.path);
      if (!path) continue;
      snapshotChangedFiles.push({
        path,
        op: fe.op || '修改',
        ts: typeof fe.ts === 'number' ? fe.ts : 0,
      });
    }
  }

  function scheduleSnapshotTimelineRefresh() {
    if (snapshotFilesRefreshTimer) clearTimeout(snapshotFilesRefreshTimer);
    snapshotFilesRefreshTimer = setTimeout(() => {
      snapshotFilesRefreshTimer = 0;
      refreshSnapshotTimeline();
    }, 400);
  }

  function snapshotFileName(p) {
    const n = normalizeChangedPath(p);
    const idx = n.lastIndexOf('/');
    return idx >= 0 ? n.slice(idx + 1) : n;
  }

  function snapshotFileBadgeClass(op) {
    if (op === '新建') return 'etl-snapshot-file-badge--add';
    if (op === '删除') return 'etl-snapshot-file-badge--del';
    if (op === '移动') return 'etl-snapshot-file-badge--move';
    return 'etl-snapshot-file-badge--edit';
  }

  function notifySnapshotFileOpen(message, type) {
    try {
      if (window.Notification && typeof window.Notification.show === 'function') {
        window.Notification.show(message, type || 'info', { duration: 4000 });
        return;
      }
    } catch (_e) { /* ignore */ }
    try {
      if (window.ChatPage && typeof window.ChatPage.notifyUser === 'function') {
        window.ChatPage.notifyUser(message, type || 'info', { duration: 4000 });
      }
    } catch (_e2) { /* ignore */ }
  }

  const snapshotFileOpenInFlight = Object.create(null);

  function openSnapshotChangedFile(relPath, btn) {
    const filePath = normalizeChangedPath(relPath);
    if (!filePath || snapshotFileOpenInFlight[filePath]) return;
    snapshotFileOpenInFlight[filePath] = true;
    if (btn) btn.disabled = true;
    const sid = getActiveSessionIdForSnapshot();
    fetch(`/api/sessions/${encodeURIComponent(sid)}/open-file`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    }).then((res) => {
      return res.json().then((body) =>  ({ ok: res.ok, body: body || {} })).catch(() =>  ({ ok: false, body: { error: '无法在文件夹中定位文件' } }));
    }).then((result) => {
      if (result.ok) return;
      notifySnapshotFileOpen((result.body && result.body.error) || '无法在文件夹中定位文件', 'error');
    }).catch((e) => {
      safeWarn('openSnapshotChangedFile', e);
      notifySnapshotFileOpen('无法在文件夹中定位文件', 'error');
    }).then(() => {
      delete snapshotFileOpenInFlight[filePath];
      if (btn) btn.disabled = false;
    });
  }

  function buildSnapshotFileItem(file) {
    const li = document.createElement('li');
    li.className = 'etl-snapshot-file';
    li.setAttribute('role', 'listitem');

    const badge = document.createElement('span');
    badge.className = `etl-snapshot-file-badge ${snapshotFileBadgeClass(file.op)}`;
    badge.textContent = file.op || '修改';

    const nameEl = document.createElement('button');
    nameEl.type = 'button';
    nameEl.className = 'etl-snapshot-file-name';
    nameEl.textContent = snapshotFileName(file.path) || file.path;
    nameEl.title = (file.path || '') + '\n打开所在文件夹并定位';
    nameEl.setAttribute('aria-label', '在文件夹中定位 ' + (file.path || nameEl.textContent));
    nameEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openSnapshotChangedFile(file.path, nameEl);
    });

    li.appendChild(badge);
    li.appendChild(nameEl);
    return li;
  }

  function collectSessionToolUsage() {
    const byName = Object.create(null);
    const order = [];
    const seenCall = Object.create(null);

    function add(name, callId) {
      const toolName = String(name || '').trim();
      if (!toolName) return;
      if (callId) {
        if (seenCall[callId]) return;
        seenCall[callId] = true;
      }
      if (!byName[toolName]) {
        byName[toolName] = { name: toolName, count: 0 };
        order.push(toolName);
      }
      byName[toolName].count += 1;
    }

    function addFromRounds(rounds) {
      if (!Array.isArray(rounds)) return;
      for (let i = 0; i < rounds.length; i++) {
        const tools = (rounds[i] && rounds[i].tools) || [];
        for (let t = 0; t < tools.length; t++) {
          const tool = tools[t];
          if (!tool) continue;
          add(tool.toolName, tool.toolCallId);
        }
      }
    }

    for (let c = 0; c < sealedChapters.length; c++) {
      addFromRounds(sealedChapters[c] && sealedChapters[c].rounds);
    }
    for (let j = 0; j < toolRecords.length; j++) {
      const rec = toolRecords[j];
      if (!rec) continue;
      add(rec.toolName, rec.toolCallId);
    }
    const out = [];
    for (let k = 0; k < order.length; k++) out.push(byName[order[k]]);
    return out;
  }

  function renderDockSheet() {
    if (dockSheetKind === 'tools') renderDockTools();
    else renderSnapshotFiles();
  }

  function buildDockToolItem(entry) {
    const li = document.createElement('li');
    li.className = 'etl-snapshot-file is-static';
    li.setAttribute('role', 'listitem');
    li.setAttribute('data-tool-name', entry.name);

    const badge = document.createElement('span');
    badge.className = 'etl-snapshot-file-badge etl-snapshot-file-badge--tool';
    badge.textContent = `×${entry.count}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'etl-snapshot-file-name';
    nameEl.textContent = entry.name;
    nameEl.title = entry.name;

    li.appendChild(badge);
    li.appendChild(nameEl);
    return li;
  }

  function renderDockTools() {
    if (!snapshotFilesEl) return;
    try {
      const titleEl = snapshotFilesEl.querySelector('.etl-files-sheet-title');
      const countEl = snapshotFilesEl.querySelector('#etl-snapshot-files-count');
      const emptyEl = snapshotFilesEl.querySelector('.etl-snapshot-files-empty');
      const list = snapshotFilesEl.querySelector('#etl-snapshot-files-list');
      if (!list) return;
      const tools = collectSessionToolUsage().slice(0, 200);
      if (titleEl) titleEl.textContent = tools.length ? (`会话工具 · ${tools.length}`) : '会话工具';
      if (countEl) countEl.textContent = tools.length ? (`${tools.length} 个工具`) : '暂无工具';
      list.innerHTML = '';
      if (!tools.length) {
        if (emptyEl) {
          emptyEl.textContent = '尚无工具调用';
          emptyEl.classList.remove('hidden');
        }
        list.classList.add('hidden');
        return;
      }
      if (emptyEl) emptyEl.classList.add('hidden');
      list.classList.remove('hidden');
      for (let i = 0; i < tools.length; i++) {
        list.appendChild(buildDockToolItem(tools[i]));
      }
    } catch (e) {
      safeWarn('renderDockTools', e);
    }
  }

  function renderSnapshotFiles() {
    if (!snapshotFilesEl) return;
    if (dockSheetKind === 'tools') return;
    try {
      const titleEl = snapshotFilesEl.querySelector('.etl-files-sheet-title');
      const countEl = snapshotFilesEl.querySelector('#etl-snapshot-files-count');
      const emptyEl = snapshotFilesEl.querySelector('.etl-snapshot-files-empty');
      const list = snapshotFilesEl.querySelector('#etl-snapshot-files-list');
      if (!list) return;
      const files = snapshotChangedFiles.slice(0, 200);
      if (titleEl) titleEl.textContent = files.length ? (`变更文件 · ${files.length}`) : '变更文件';
      if (countEl) countEl.textContent = files.length ? (`${files.length} 个文件`) : '暂无文件';
      if (emptyEl) emptyEl.textContent = '尚无变更文件';
      list.innerHTML = '';
      if (!files.length) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        list.classList.add('hidden');
        renderFooter();
        return;
      }
      if (emptyEl) emptyEl.classList.add('hidden');
      list.classList.remove('hidden');
      for (let i = 0; i < files.length; i++) {
        list.appendChild(buildSnapshotFileItem(files[i]));
      }
      renderFooter();
    } catch (e) {
      safeWarn('renderSnapshotFiles', e);
    }
  }

  function refreshSnapshotFiles() {
    try {
      renderSnapshotFiles();
    } catch (e) {
      safeWarn('refreshSnapshotFiles', e);
    }
  }

  function getActiveSessionIdForSnapshot() {
    try {
      if (window.ChatSessionStore
        && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
        return window.ChatSessionStore.getActiveSessionId() || 'default';
      }
    } catch (_e) { /* ignore */ }
    return 'default';
  }

  function snapshotRestoreIconHtml() {
    if (window.AppIcon && typeof window.AppIcon.html === 'function') {
      return window.AppIcon.html('restore', { width: 14, className: 'etl-snapshot-restore-icon' });
    }
    return '↩';
  }

  function snapshotRestoreAllowed() {
    return snapshotCanRestoreFn ? !!snapshotCanRestoreFn() : true;
  }

  function rememberSnapshotCheckpointIds(entries, cursorMessageId, cursorRestored) {
    snapshotCheckpointIds = Object.create(null);
    snapshotCheckpointEntries = [];
    snapshotCursorMessageId = cursorMessageId || '';
    snapshotCursorRestored = !!cursorRestored;
    if (!Array.isArray(entries)) return;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const mid = entry && entry.messageId;
      if (!mid) continue;
      snapshotCheckpointIds[mid] = true;
      if (entry.isCursor) snapshotCursorMessageId = mid;
      if (entry.isRestoredCursor) snapshotCursorRestored = true;
      snapshotCheckpointEntries.push({
        messageId: mid,
        userMessageTime: typeof entry.userMessageTime === 'number' ? entry.userMessageTime : null,
        createdAt: entry.createdAt || '',
        preview: entry.preview || '',
        isCursor: !!entry.isCursor,
        isRestoredCursor: !!entry.isRestoredCursor,
      });
    }
  }

  function hasSnapshotCheckpoint(messageId) {
    return !!(messageId && snapshotCheckpointIds[messageId]);
  }

  function getSnapshotCheckpointEntries() {
    return snapshotCheckpointEntries.slice();
  }

  function getSnapshotCursorMessageId() {
    return snapshotCursorMessageId || '';
  }

  function isSnapshotCursorMessage(messageId) {
    return !!(messageId && snapshotCursorMessageId && messageId === snapshotCursorMessageId);
  }

  function isSnapshotCursorRestored() {
    return !!snapshotCursorRestored;
  }

  /** 只有回滚落到该节点后才隐藏回滚；仅「当前位置」不够。 */
  function isSnapshotRestoreHidden(messageId) {
    return isSnapshotCursorMessage(messageId) && snapshotCursorRestored;
  }

  function syncSnapshotCheckpointsToChatUi(entries) {
    const ids = [];
    if (Array.isArray(entries)) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i] && entries[i].messageId) ids.push(entries[i].messageId);
      }
    }
    try {
      if (window.ChatUI && typeof window.ChatUI.mergeCheckpointMessageIds === 'function') {
        window.ChatUI.mergeCheckpointMessageIds(ids);
      } else if (window.ChatUI && typeof window.ChatUI.setCheckpointMessageIds === 'function') {
        window.ChatUI.setCheckpointMessageIds(ids);
      }
      if (window.ChatUI && typeof window.ChatUI.setCursorMessageId === 'function') {
        window.ChatUI.setCursorMessageId(snapshotCursorMessageId, snapshotCursorRestored);
      }
    } catch (_e) { /* ignore */ }
  }

  /** 时间轴条目即检查点；聊天气泡内存集合可能滞后，不能单独作为否决。 */
  function snapshotHasCheckpoint(messageId) {
    if (hasSnapshotCheckpoint(messageId)) return true;
    try {
      if (window.ChatUI && typeof window.ChatUI.hasCheckpointForMessage === 'function') {
        return !!window.ChatUI.hasCheckpointForMessage(messageId);
      }
    } catch (_e) { /* ignore */ }
    return false;
  }

  function applySnapshotRestoreButtonState(btn, messageId) {
    if (!btn) return;
    const hasCp = snapshotHasCheckpoint(messageId);
    const can = snapshotRestoreAllowed();
    btn.disabled = !hasCp || !can;
    btn.classList.toggle('etl-snapshot-restore-btn--ready', hasCp);
    const title = !hasCp
      ? '未找到检查点，无法回滚'
      : (can ? '回滚到此消息' : '运行中，请等待当前任务完成后再回滚');
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }

  function bindSnapshotRestoreButton(btn) {
    if (!btn || btn._snapshotRestoreBound) return;
    btn._snapshotRestoreBound = true;
    btn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (!btn || btn.disabled) return;
      const targetMessageId = btn.getAttribute('data-message-id');
      if (!targetMessageId) return;
      if (typeof snapshotRestoreHandler === 'function') {
        snapshotRestoreHandler(targetMessageId, btn);
      }
    });
  }

  function createSnapshotRestoreButton(messageId) {
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'etl-snapshot-restore-btn';
    restoreBtn.setAttribute('data-message-id', messageId);
    restoreBtn.innerHTML = snapshotRestoreIconHtml();
    if (window.AppIcon && typeof window.AppIcon.hydrate === 'function') {
      window.AppIcon.hydrate(restoreBtn);
    }
    applySnapshotRestoreButtonState(restoreBtn, messageId);
    bindSnapshotRestoreButton(restoreBtn);
    return restoreBtn;
  }

  function applyCheckpointPayload(payload) {
    const entries = payload && Array.isArray(payload.entries) ? payload.entries : [];
    rememberSnapshotCheckpointIds(entries, payload && payload.cursorMessageId, payload && payload.cursorRestored);
    syncSnapshotCheckpointsToChatUi(entries);
    applyCheckpointChangedFiles(payload && payload.changedFiles);
    bindLiveChapterIdentity();
    renderDockSheet();
    renderChapterDirectory();
    renderRoundTimeline(true);
    notifySnapshotRestoreAvailability();
  }

  function fetchSnapshotTimeline(sessionId, done) {
    const gen = ++snapshotFetchGeneration;
    const sid = sessionId || getActiveSessionIdForSnapshot();
    fetch(`/api/sessions/${encodeURIComponent(sid)}/checkpoints`, {
      credentials: 'same-origin',
      cache: 'no-store',
    }).then((res) => {
      if (!res.ok) return null;
      return res.json();
    }).catch(() =>  null).then((data) => {
      if (gen !== snapshotFetchGeneration) return;
      applyCheckpointPayload(data || { entries: [] });
      if (typeof done === 'function') done(data);
    });
  }

  function refreshSnapshotTimeline() {
    try {
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
    refreshSnapshotTimeline();
  }

  function notifySnapshotRestoreAvailability() {
    if (!chapterTimelineEl) return;
    const list = chapterTimelineEl.querySelector('.etl-chapter-list');
    if (!list) {
      refreshSnapshotTimeline();
      return;
    }
    const btns = list.querySelectorAll('.etl-snapshot-restore-btn');
    Array.prototype.forEach.call(btns, (btn) => {
      applySnapshotRestoreButtonState(btn, btn.getAttribute('data-message-id') || '');
    });
  }

  bindPreferenceRefresh();

  return {
    setPlan,
    applyPatch,
    clear,
    resetExecutionMode,
    setVisible,
    setPageActive,
    setCapabilityEnabled,
    getPlan,
    isVisible,
    isPlanLive,
    isPlanComplete,
    formatFootSummary,
    formatExecutionModeChip,
    getExecutionModeChip,
    getExecutionModeState,
    applyExecutionModeEvent,
    isPanelSuppressed,
    requestExpandFromPet,
    // Phase 4 新增
    minimize,
    expand,
    applyRuntimeStats,
    refreshPreferences,
    // Phase 5 新增：LLM 动作 + 执行流轮次
    applyToolActivity,
    applyRoundActivity,
    resetToolActivity,
    beginTurnTimer,
    endTurnTimer,
    getFlowSnapshot,
    restoreFlowSnapshot,
    hydrateFromStructured,
    sealChapter: sealLiveChapter,
    revealChapter,
    getSealedChapters() { return sealedChapters.slice(); },
    registerFlowPersist,
    flushFlowPersist,
    cancelFlowPersist,
    // TaskGraph（兼容）
    renderGraph,
    updateGraphNode,
    highlightGraphBranch,
    markGraphComplete,
    registerSnapshotHandlers,
    refreshSnapshotTimeline,
    notifySnapshotRestoreAvailability,
    hasSnapshotCheckpoint,
    getSnapshotCheckpointEntries,
    getSnapshotCursorMessageId,
    isSnapshotCursorMessage,
    isSnapshotCursorRestored,
    isSnapshotRestoreHidden,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatExecutionPlan = ChatExecutionPlan;
}
