/**
 * 执行透明层 — 前端事件桥。
 *
 * 职责：
 *   1. 由 ChatPage 转发 `connected` / `session_updated`（见 notifyConnected / notifySessionUpdated）。
 *      原因：ChatWebSocket.on() 每个 type 只保留最后一个回调，若在桥里 WS.on('connected') 会被 ChatPage 覆盖。
 *   2. 把 `task_graph_*` / `execution_plan_*`（兼容）事件转给 ChatExecutionPlan 面板；
 *   3. WS 重连或先错过 init 时通过 GET /api/sessions/:id/plan 重同步；
 *   4. 每个 session 在 localStorage 仅保留最近一次执行流快照（见 ChatExecutionFlowStore）；
 *   5. 详情卡片锚定冰豆底部 #status-turn；localStorage ICE_PLAN_PANEL=0 仍可关闭计划展示。
 *
 * 设计文档：docs/execution-transparency-layer.md §Frontend Design
 */

/* exported ChatExecutionPlanBridge */

window.ChatExecutionPlanBridge = (function () {
  'use strict';

  /**
   * 对外导出对象（先于 attach() 同步调用而存在）。
   * 不能用 window.ChatExecutionPlanBridge._handleStep：attach 可能在整句赋值完成前就运行。
   */
  var bridgeApi = {};

  var enabled = false;          // 服务端 feature flag
  var connectedKnown = false;   // connected 到达后，其 capability 判定为权威值
  var attached = false;         // 已经挂载过订阅
  var currentPlanId = null;     // 本地 plan 跟踪 ID（防错位）
  var lastSyncMs = 0;
  var syncGeneration = 0;       // REST 请求代次，旧响应不得覆盖较新会话
  /** exit_forced 后抑制 REST 重同步，直到新一轮 task_graph / plan init */
  var planFootDismissed = false;
  /** 新一轮用户输入已清空面板时，忽略 REST /plan 返回的上一轮计划。 */
  var restPlanSuppressed = false;
  /** 已应用默认展开策略的 session + plan，避免同一计划重连时重复收起。 */
  var defaultCollapseApplied = Object.create(null);
  var lastShowPanelPref = prefShowPanel();

  function getActiveSessionId() {
    try {
      if (window.ChatSessionStore
        && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
        return window.ChatSessionStore.getActiveSessionId() || 'default';
      }
    } catch (_e) { /* ignore */ }
    return 'default';
  }

  function getFlowStore() {
    return window.ChatExecutionFlowStore || null;
  }

  function clearSessionFlow(sessionId) {
    var store = getFlowStore();
    if (store && typeof store.clear === 'function') {
      store.clear(sessionId || getActiveSessionId());
    }
  }

  function clearPlanStateForSession(sessionId) {
    currentPlanId = null;
    planFootDismissed = false;
    clearSessionFlow(sessionId || getActiveSessionId());
    if (window.ChatExecutionPlan) {
      window.ChatExecutionPlan.clear();
      if (!enabled) window.ChatExecutionPlan.setVisible(false);
    }
  }

  function loadStoredFlow(sessionId) {
    var store = getFlowStore();
    if (!store || typeof store.load !== 'function') return null;
    return store.load(sessionId || getActiveSessionId());
  }

  function applyStoredFlowSnapshot(stored) {
    if (!stored || !stored.panel || !window.ChatExecutionPlan) return false;
    if (stored.bridge && typeof stored.bridge === 'object') {
      currentPlanId = stored.bridge.currentPlanId || stored.planId || null;
      planFootDismissed = !!stored.bridge.planFootDismissed;
    } else {
      currentPlanId = stored.planId || null;
    }
    if (typeof window.ChatExecutionPlan.restoreFlowSnapshot === 'function') {
      window.ChatExecutionPlan.restoreFlowSnapshot(stored.panel);
    }
    return true;
  }

  function restoreFlowFromStorage(sessionId) {
    var stored = loadStoredFlow(sessionId);
    if (!stored) return null;
    applyStoredFlowSnapshot(stored);
    return stored;
  }

  function persistFlowForSession(sessionId, bridgeState) {
    var store = getFlowStore();
    if (!store || typeof store.save !== 'function' || !window.ChatExecutionPlan) return;
    if (!sessionId) return;
    var panel = typeof window.ChatExecutionPlan.getFlowSnapshot === 'function'
      ? window.ChatExecutionPlan.getFlowSnapshot()
      : null;
    if (!panel) return;
    var plan = typeof window.ChatExecutionPlan.getPlan === 'function'
      ? window.ChatExecutionPlan.getPlan()
      : null;
    var bridgePlanId = bridgeState && bridgeState.currentPlanId;
    var bridgeFootDismissed = bridgeState && bridgeState.planFootDismissed;
    var planId = bridgePlanId || currentPlanId || (plan && plan.planId) || null;
    var hasFlow = !!(planId || panel.roundRecords.length || panel.currentExecutionMode);
    if (!hasFlow) {
      clearSessionFlow(sessionId);
      return;
    }
    store.save(sessionId, {
      planId: planId,
      bridge: {
        currentPlanId: bridgePlanId !== undefined ? bridgePlanId : currentPlanId,
        planFootDismissed: bridgeFootDismissed !== undefined
          ? !!bridgeFootDismissed
          : planFootDismissed,
      },
      panel: panel,
    });
  }

  function persistCurrentFlow() {
    persistFlowForSession(getActiveSessionId());
  }

  /**
   * 离开会话前同步落盘：取消防抖并把当前面板状态写入 outgoing session。
   * 须在 activeSessionId 切换之前调用；面板内存仍为 outgoing 会话数据。
   */
  function flushOutgoingSession(outgoingSessionId) {
    if (!outgoingSessionId) return;
    var bridgeState = {
      currentPlanId: currentPlanId,
      planFootDismissed: planFootDismissed,
    };
    try {
      if (window.ChatExecutionPlan && typeof window.ChatExecutionPlan.cancelFlowPersist === 'function') {
        window.ChatExecutionPlan.cancelFlowPersist();
      }
    } catch (_e) { /* ignore */ }
    persistFlowForSession(outgoingSessionId, bridgeState);
  }

  function flushActiveSessionFlow() {
    try {
      if (window.ChatExecutionPlan && typeof window.ChatExecutionPlan.flushFlowPersist === 'function') {
        window.ChatExecutionPlan.flushFlowPersist();
        return;
      }
    } catch (_e) { /* ignore */ }
    persistCurrentFlow();
  }

  function applyRestPlan(plan, stored) {
    if (!window.ChatExecutionPlan) return;
    if (restPlanSuppressed && plan) return;
    if (!plan) {
      var live = window.ChatExecutionPlan.getPlan
        ? window.ChatExecutionPlan.getPlan()
        : null;
      if (!live && stored) {
        applyStoredFlowSnapshot(stored);
        ensurePanelVisible();
        return;
      }
      if (!live) {
        window.ChatExecutionPlan.clear();
        currentPlanId = null;
      }
      return;
    }
    currentPlanId = plan.planId;
    if (stored && stored.planId === plan.planId && stored.panel
      && typeof window.ChatExecutionPlan.restoreFlowSnapshot === 'function') {
      window.ChatExecutionPlan.setPlan(plan);
      window.ChatExecutionPlan.restoreFlowSnapshot(stored.panel, { overlayOnly: true });
      if (stored.bridge && typeof stored.bridge === 'object') {
        planFootDismissed = !!stored.bridge.planFootDismissed;
      }
    } else {
      window.ChatExecutionPlan.setPlan(plan);
    }
    ensurePanelVisible();
  }

  function setEnabled(next) {
    next = !!next;
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.setCapabilityEnabled === 'function') {
        window.ChatExecutionPlan.setCapabilityEnabled(next);
      }
    } catch (_e) { /* ignore */ }
    if (enabled === next) return;
    enabled = next;
    try {
      window.dispatchEvent(new CustomEvent('etl:capabilitychange', {
        detail: { enabled: enabled },
      }));
    } catch (_e) { /* ignore */ }
  }

  function capabilityEvidenceFromStep() {
    if (!connectedKnown) setEnabled(true);
  }

  /** 前端主开关：showTransparencyPanel（默认关）。 */
  function prefShowPanel() {
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.getKey === 'function') {
        return !!window.EtlPrefs.getKey('showTransparencyPanel');
      }
    } catch (_e) { /* ignore */ }
    return false;
  }

  /** 默认是否展开：false 时初始最小化为宠物形态。 */
  function prefDefaultExpanded() {
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.getKey === 'function') {
        var v = window.EtlPrefs.getKey('panelDefaultExpanded');
        return v === undefined ? true : !!v;
      }
    } catch (_e) { /* ignore */ }
    return true;
  }

  /**
   * 两层门控（设计 §4.4）：服务端能力 features.executionPlan 与前端主开关
   * showTransparencyPanel 同时为真才显示；任一关闭即隐藏。
   */
  function ensurePanelVisible() {
    if (!window.ChatExecutionPlan) return;
    if (!enabled || !prefShowPanel()) {
      window.ChatExecutionPlan.setVisible(false);
      return;
    }
    window.ChatExecutionPlan.setVisible(true);
    // 默认收起按 session + plan 应用一次；同一计划重连不重复改变用户已展开的状态。
    var collapseKey = getActiveSessionId() + '::' + (currentPlanId || '__no_plan__');
    if (!defaultCollapseApplied[collapseKey]) {
      defaultCollapseApplied[collapseKey] = true;
      if (!prefDefaultExpanded() && typeof window.ChatExecutionPlan.minimize === 'function') {
        window.ChatExecutionPlan.minimize();
      }
    }
  }

  /** EtlPrefs 变更即时联动：主开关显隐、面板宽度由面板内部读取重应用。 */
  function onPrefsChange() {
    try {
      var showPanel = prefShowPanel();
      var turnedOn = !lastShowPanelPref && showPanel;
      lastShowPanelPref = showPanel;
      if (!window.ChatExecutionPlan) return;
      if (!enabled || !showPanel) {
        window.ChatExecutionPlan.setVisible(false);
        return;
      }
      ensurePanelVisible();
      if (turnedOn) fetchAndApply();
    } catch (_e) { /* ignore */ }
  }

  function tryHydrateFromStructuredCache() {
    try {
      if (!window.ChatSession
        || typeof window.ChatSession.getStructuredMessages !== 'function'
        || !window.ChatExecutionPlan
        || typeof window.ChatExecutionPlan.hydrateFromStructured !== 'function') {
        return;
      }
      var structured = window.ChatSession.getStructuredMessages();
      if (structured && structured.length) {
        window.ChatExecutionPlan.hydrateFromStructured(structured);
      }
    } catch (_e) { /* ignore */ }
  }

  function onConnected(data) {
    var features = data && data.features;
    connectedKnown = true;
    setEnabled(!!(features && features.executionPlan));
    if (!enabled) {
      if (window.ChatExecutionPlan) {
        window.ChatExecutionPlan.clear();
        window.ChatExecutionPlan.setVisible(false);
      }
      return;
    }
    ensurePanelVisible();
    resyncShellDockUi();
    var stored = restoreFlowFromStorage(getActiveSessionId());
    // 连接时主动同步一次，覆盖刷新页面 / 跨端的场景
    fetchAndApply(stored);
    tryHydrateFromStructuredCache();
  }

  function onStep(data) {
    // Observer 红线（设计 §14）：单事件处理异常绝不冒泡、绝不中断后续分发。
    try {
      onStepInner(data);
    } catch (e) {
      try {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[ChatExecutionPlanBridge] onStep 降级：', e);
        }
      } catch (_e) { /* ignore */ }
    }
  }

  function onStepInner(data) {
    var step = data && data.step;
    if (!step) return;

    // 前端净化后的轮次标记：仅含 iteration/ts/stopReason，不携带模型正文。
    if (step.type === 'model_round_start'
      || step.type === 'model_round_end'
      || step.type === 'model_task_final') {
      if (window.ChatExecutionPlan && window.ChatExecutionPlan.applyRoundActivity) {
        window.ChatExecutionPlan.applyRoundActivity(step);
      }
      return;
    }

    // 工具事件仅用于推导 LLM 当前动作（不改计划状态）；独立于 enabled，异常已在面板内兜底。
    if (step.type === 'tool_call' || step.type === 'tool_result') {
      if (window.ChatExecutionPlan && window.ChatExecutionPlan.applyToolActivity) {
        window.ChatExecutionPlan.applyToolActivity(step);
      }
      return;
    }

    // 独立于 enabled：上一轮残留 UI 在非计划型对话时也必须清掉
    if (step.type === 'execution_plan_clear') {
      clearPlanStateForSession(getActiveSessionId());
      return;
    }

    // 独立于 enabled：终态必须定格保留，直到显式 clear 或新任务替换。
    if (step.type === 'task_graph_done') {
      planFootDismissed = true;
      if (window.ChatExecutionPlan) {
        window.ChatExecutionPlan.applyPatch({
          activeStepId: null,
          progress: 100,
          updatedAt: typeof step.ts === 'number' ? step.ts : Date.now(),
        });
      }
      return;
    }

    // 独立于 enabled：exit_forced = L2 交还模型；保留计划与监管横幅状态。
    if (step.type === 'execution_mode_exit') {
      if (window.ChatExecutionPlan) {
        if (window.ChatExecutionPlan.applyRoundActivity) {
          window.ChatExecutionPlan.applyRoundActivity(step);
        }
        window.ChatExecutionPlan.applyExecutionModeEvent(step);
      }
      return;
    }

    if (step.type === 'execution_mode_enter') {
      capabilityEvidenceFromStep();
      if (!enabled) return;
      planFootDismissed = false;
      if (window.ChatExecutionPlan) {
        if (window.ChatExecutionPlan.applyRoundActivity) {
          window.ChatExecutionPlan.applyRoundActivity(step);
        }
        window.ChatExecutionPlan.applyExecutionModeEvent(step);
      }
      return;
    }

    // connected 尚未到达时，以首个明确计划事件作为旧服务兼容能力证据。
    if (step.type === 'execution_plan_init' && step.plan) {
      capabilityEvidenceFromStep();
    }
    if (step.type === 'task_graph_init') {
      capabilityEvidenceFromStep();
    }
    if (!enabled) return;

    if (step.type === 'execution_plan_init' && step.plan) {
      restPlanSuppressed = false;
      planFootDismissed = false;
      currentPlanId = step.plan.planId;
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.setPlan(step.plan);
      ensurePanelVisible();
      return;
    }
    if (step.type === 'execution_plan_update' && step.patch) {
      if (planFootDismissed) return;
      if (!currentPlanId || step.planId !== currentPlanId) {
        // planId 不匹配：丢弃 patch + 触发全量同步
        scheduleResync();
        return;
      }
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.applyPatch(step.patch);
    }

    // ── TaskGraph events (Phase 7) ──
    if (step.type === 'task_graph_init') {
      restPlanSuppressed = false;
      planFootDismissed = false;
      currentPlanId = step.plan && step.plan.planId ? step.plan.planId : currentPlanId;
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.renderGraph(step);
      ensurePanelVisible();
      return;
    }
    if (step.type === 'task_graph_node' && step.nodeId) {
      if (!planFootDismissed && window.ChatExecutionPlan) {
        window.ChatExecutionPlan.updateGraphNode(step);
      }
    }
    if (step.type === 'task_graph_update' && step.plan) {
      if (planFootDismissed) return;
      restPlanSuppressed = false;
      currentPlanId = step.plan.planId;
      if (window.ChatExecutionPlan) {
        // TaskGraphView 也是面板的权威只读快照；完整投影可保留 createdAt /
        // updatedAt 以及 Timeline、Footer 后续消费的其它时间字段。
        window.ChatExecutionPlan.setPlan(Object.assign({}, step.plan));
      }
    }
    if (step.type === 'task_graph_branch') {
      if (window.ChatExecutionPlan) {
        if (window.ChatExecutionPlan.applyRoundActivity) {
          window.ChatExecutionPlan.applyRoundActivity(step);
        }
        window.ChatExecutionPlan.highlightGraphBranch(step);
      }
    }
  }

  function getSessionUpdatedThrottleMs() {
    try {
      if (document.documentElement.getAttribute('data-shell') === 'mobile') return 5000;
    } catch (_e) { /* ignore */ }
    return 800;
  }

  function onSessionUpdated() {
    if (!enabled) return;
    ensurePanelVisible();
    var stored = loadStoredFlow(getActiveSessionId());
    if (planFootDismissed && stored) {
      applyStoredFlowSnapshot(stored);
      return;
    }
    // 节流：避免短时间多次 session_updated 撞接口
    var now = Date.now();
    if (now - lastSyncMs < getSessionUpdatedThrottleMs()) return;
    lastSyncMs = now;
    fetchAndApply();
  }

  /**
   * ChatPage 已完成真实会话切换后调用。先使旧会话的所有 REST 响应失效，
   * 再只读拉取 ChatSessionStore 当前 activeSessionId 对应的计划。
   */
  function onSessionSwitched() {
    syncGeneration++;
    lastSyncMs = 0;
    restPlanSuppressed = false;
    if (window.ChatExecutionPlan && typeof window.ChatExecutionPlan.cancelFlowPersist === 'function') {
      window.ChatExecutionPlan.cancelFlowPersist();
    }
    currentPlanId = null;
    planFootDismissed = false;
    if (resyncTimer) {
      clearTimeout(resyncTimer);
      resyncTimer = null;
    }
    var sessionId = getActiveSessionId();
    var stored = restoreFlowFromStorage(sessionId);
    if (!stored) {
      try {
        if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
      } catch (_e) { /* ignore */ }
    }
    if (!enabled) {
      try {
        if (window.ChatExecutionPlan) window.ChatExecutionPlan.setVisible(false);
      } catch (_e) { /* ignore */ }
      return;
    }
    ensurePanelVisible();
    fetchAndApply(stored);
  }

  /**
   * 同会话新一轮用户输入开始时调用：清空上一轮 goal/steps/执行流，
   * 并抑制 session_updated 触发的 REST /plan 把旧计划写回面板。
   */
  function onNewTurnStarted() {
    syncGeneration++;
    lastSyncMs = 0;
    restPlanSuppressed = true;
    if (resyncTimer) {
      clearTimeout(resyncTimer);
      resyncTimer = null;
    }
    if (window.ChatExecutionPlan && typeof window.ChatExecutionPlan.cancelFlowPersist === 'function') {
      window.ChatExecutionPlan.cancelFlowPersist();
    }
    clearPlanStateForSession(getActiveSessionId());
    if (enabled) ensurePanelVisible();
  }

  function resyncShellDockUi() {
    try {
      if (window.ChatPage && typeof window.ChatPage.syncShellDockOnMount === 'function') {
        window.ChatPage.syncShellDockOnMount();
      }
    } catch (_e) { /* ignore */ }
  }

  function fetchAndApply(pendingStored) {
    if (!enabled) return;
    var sessionId = getActiveSessionId();
    var stored = pendingStored || loadStoredFlow(sessionId);
    if (planFootDismissed && stored) {
      applyStoredFlowSnapshot(stored);
      ensurePanelVisible();
      resyncShellDockUi();
      return;
    }
    var requestGeneration = ++syncGeneration;
    fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/plan', {
      cache: 'no-store',
    })
      .then(function (res) { return res.ok ? res.json() : { plan: null }; })
      .then(function (body) {
        if (requestGeneration !== syncGeneration || getActiveSessionId() !== sessionId) return;
        stored = pendingStored || loadStoredFlow(sessionId);
        if (planFootDismissed) {
          if (stored) applyStoredFlowSnapshot(stored);
          ensurePanelVisible();
          resyncShellDockUi();
          return;
        }
        var plan = body && body.plan;
        applyRestPlan(plan, stored);
        resyncShellDockUi();
      })
      .catch(function () { /* ignore */ });
  }

  var resyncTimer = null;
  function scheduleResync() {
    if (resyncTimer) return;
    resyncTimer = setTimeout(function () {
      resyncTimer = null;
      fetchAndApply();
    }, 250);
  }

  function attach() {
    if (attached) return;
    attached = true;
    // connected / session_updated 必须由 ChatPage 调用 notify*（ChatWebSocket 单处理器会被覆盖）。
    bridgeApi._handleStep = onStep;
    // 订阅偏好变更：设置页切换主开关 / 宽度等即时联动，无需刷新。
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.onChange === 'function') {
        window.EtlPrefs.onChange(onPrefsChange);
      }
    } catch (_e) { /* ignore */ }
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.registerFlowPersist === 'function') {
        window.ChatExecutionPlan.registerFlowPersist(persistCurrentFlow);
      }
    } catch (_e) { /* ignore */ }
    try {
      var onPageHide = function () {
        flushActiveSessionFlow();
      };
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') onPageHide();
      });
      window.addEventListener('pagehide', onPageHide);
    } catch (_e) { /* ignore */ }
  }

  function handleStep(step) {
    onStep({ step: step });
  }

  function isEnabled() {
    return enabled;
  }

  /** WS connected 到达后，isEnabled() 才是服务端权威值；此前视为未知。 */
  function isCapabilityKnown() {
    return connectedKnown;
  }

  bridgeApi.attach = attach;
  bridgeApi.handleStep = handleStep;
  bridgeApi.isEnabled = isEnabled;
  bridgeApi.isCapabilityKnown = isCapabilityKnown;
  bridgeApi.fetchAndApply = fetchAndApply;
  bridgeApi.clearSessionFlow = clearSessionFlow;
  bridgeApi.flushOutgoingSession = flushOutgoingSession;
  bridgeApi.flushActiveSessionFlow = flushActiveSessionFlow;
  /** ChatPage.onWsConnected 末尾调用 — 不可替代 WS.on */
  bridgeApi.notifyConnected = onConnected;
  /** ChatPage.session_updated 时与拉取快照一并调用 */
  bridgeApi.notifySessionUpdated = onSessionUpdated;
  /** ChatPage.onSessionSwitched 在 Store activeSessionId 更新后调用。 */
  bridgeApi.notifySessionSwitched = onSessionSwitched;
  /** ChatPage 发送新一轮用户消息时调用。 */
  bridgeApi.notifyNewTurnStarted = onNewTurnStarted;

  // 模块加载即挂载（main.js 加载顺序保证 ChatWebSocket 已存在）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  return bridgeApi;
})();
