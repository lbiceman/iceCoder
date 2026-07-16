/**
 * 执行透明层 — 前端事件桥。
 *
 * 职责：
 *   1. 由 ChatPage 转发 `connected` / `session_updated`（见 notifyConnected / notifySessionUpdated）。
 *      原因：ChatWebSocket.on() 每个 type 只保留最后一个回调，若在桥里 WS.on('connected') 会被 ChatPage 覆盖。
 *   2. 把 `task_graph_*` / `execution_plan_*`（兼容）事件转给 ChatExecutionPlan 面板；
 *   3. WS 重连或先错过 init 时通过 GET /api/sessions/:id/plan 重同步；
 *   4. 详情卡片锚定冰豆底部 #status-turn；localStorage ICE_PLAN_PANEL=0 仍可关闭计划展示。
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
    // 连接时主动同步一次，覆盖刷新页面 / 跨端的场景
    fetchAndApply();
  }

  /** 把 execution_mode_* / task_graph_branch 投影为 Timeline supervisor 事件（设计 §3.7.1）。 */
  function projectSupervisor(subtype, mode, ts) {
    if (!window.ChatExecutionPlan
      || typeof window.ChatExecutionPlan.pushSupervisorTimelineEvent !== 'function') return;
    window.ChatExecutionPlan.pushSupervisorTimelineEvent({
      subtype: subtype,
      reasonHuman: mode && mode.primaryReasonHuman ? mode.primaryReasonHuman : '',
      signals: mode && Array.isArray(mode.enteredBy) ? mode.enteredBy : [],
      round: mode && typeof mode.round === 'number' ? mode.round : undefined,
      ts: ts || Date.now(),
    });
  }

  function hasRecoverySignal(mode) {
    if (!mode || !Array.isArray(mode.enteredBy)) return false;
    for (var i = 0; i < mode.enteredBy.length; i++) {
      if (mode.enteredBy[i] === 'recovery_pending' || mode.enteredBy[i] === 'checkpoint_resumed') {
        return true;
      }
    }
    return false;
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

    // 工具事件仅用于推导 LLM 当前动作（不改计划状态）；独立于 enabled，异常已在面板内兜底。
    if (step.type === 'tool_call' || step.type === 'tool_result') {
      if (window.ChatExecutionPlan && window.ChatExecutionPlan.applyToolActivity) {
        window.ChatExecutionPlan.applyToolActivity(step);
      }
      return;
    }

    // 独立于 enabled：上一轮残留 UI 在非计划型对话时也必须清掉
    if (step.type === 'execution_plan_clear') {
      currentPlanId = null;
      if (window.ChatExecutionPlan) {
        window.ChatExecutionPlan.clear();
        if (!enabled) window.ChatExecutionPlan.setVisible(false);
      }
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

    // 独立于 enabled：exit_forced = L2 交还模型；保留计划与「继续执行」Supervisor 节点。
    if (step.type === 'execution_mode_exit') {
      projectSupervisor('resume', step.executionMode, step.ts);
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.applyExecutionModeEvent(step);
      return;
    }

    if (step.type === 'execution_mode_enter') {
      capabilityEvidenceFromStep();
      if (!enabled) return;
      planFootDismissed = false;
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.applyExecutionModeEvent(step);
      // 接管（forced）与恢复（enteredBy 含 recovery_pending/checkpoint_resumed）分别投影一级事件
      var mode = step.executionMode;
      if (mode && mode.executionMode === 'forced') projectSupervisor('takeover', mode, step.ts);
      if (hasRecoverySignal(mode)) projectSupervisor('recovery', mode, step.ts);
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
      currentPlanId = step.plan.planId;
      if (window.ChatExecutionPlan) {
        // TaskGraphView 也是面板的权威只读快照；完整投影可保留 createdAt /
        // updatedAt 以及 Timeline、Footer 后续消费的其它时间字段。
        window.ChatExecutionPlan.setPlan(Object.assign({}, step.plan));
      }
    }
    if (step.type === 'task_graph_branch') {
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.highlightGraphBranch(step);
      // 分支切换 = 重新规划，投影为 supervisor 一级事件
      projectSupervisor('replan', step.executionMode, step.ts);
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
    currentPlanId = null;
    planFootDismissed = false;
    if (resyncTimer) {
      clearTimeout(resyncTimer);
      resyncTimer = null;
    }
    try {
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
    } catch (_e) { /* ignore */ }
    if (!enabled) {
      try {
        if (window.ChatExecutionPlan) window.ChatExecutionPlan.setVisible(false);
      } catch (_e) { /* ignore */ }
      return;
    }
    ensurePanelVisible();
    fetchAndApply();
  }

  function fetchAndApply() {
    if (!enabled || planFootDismissed) return;
    var sessionId = getActiveSessionId();
    var requestGeneration = ++syncGeneration;
    fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/plan', {
      cache: 'no-store',
    })
      .then(function (res) { return res.ok ? res.json() : { plan: null }; })
      .then(function (body) {
        if (requestGeneration !== syncGeneration || getActiveSessionId() !== sessionId) return;
        var plan = body && body.plan;
        if (!plan) {
          // REST 可能晚于 WebSocket；若 WS 已推送计划事件，不 clear 正在显示的面板。
          var live = window.ChatExecutionPlan && window.ChatExecutionPlan.getPlan
            ? window.ChatExecutionPlan.getPlan()
            : null;
          if (!live) {
            if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
            currentPlanId = null;
          }
          return;
        }
        currentPlanId = plan.planId;
        if (window.ChatExecutionPlan) window.ChatExecutionPlan.setPlan(plan);
        ensurePanelVisible();
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
  }

  function handleStep(step) {
    onStep({ step: step });
  }

  function isEnabled() {
    return enabled;
  }

  bridgeApi.attach = attach;
  bridgeApi.handleStep = handleStep;
  bridgeApi.isEnabled = isEnabled;
  bridgeApi.fetchAndApply = fetchAndApply;
  /** ChatPage.onWsConnected 末尾调用 — 不可替代 WS.on */
  bridgeApi.notifyConnected = onConnected;
  /** ChatPage.session_updated 时与拉取快照一并调用 */
  bridgeApi.notifySessionUpdated = onSessionUpdated;
  /** ChatPage.onSessionSwitched 在 Store activeSessionId 更新后调用。 */
  bridgeApi.notifySessionSwitched = onSessionSwitched;

  // 模块加载即挂载（main.js 加载顺序保证 ChatWebSocket 已存在）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  return bridgeApi;
})();
