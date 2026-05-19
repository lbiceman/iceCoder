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

  var SESSION_ID = 'default';
  var LOCAL_DISABLE_KEY = 'ICE_PLAN_PANEL';

  var enabled = false;          // 服务端 feature flag
  var attached = false;         // 已经挂载过订阅
  var currentPlanId = null;     // 本地 plan 跟踪 ID（防错位）
  var lastSyncMs = 0;

  function isLocallyDisabled() {
    try {
      return localStorage.getItem(LOCAL_DISABLE_KEY) === '0';
    } catch (_e) {
      return false;
    }
  }

  function ensurePanelVisible() {
    if (!window.ChatExecutionPlan) return;
    if (isLocallyDisabled()) {
      window.ChatExecutionPlan.setVisible(false);
      return;
    }
    window.ChatExecutionPlan.setVisible(true);
  }

  function onConnected(data) {
    var features = data && data.features;
    enabled = !!(features && features.executionPlan);
    if (!enabled) {
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
      return;
    }
    ensurePanelVisible();
    // 连接时主动同步一次，覆盖刷新页面 / 跨端的场景
    fetchAndApply();
  }

  function onStep(data) {
    var step = data && data.step;
    if (!step) return;

    // 独立于 enabled：上一轮残留 UI 在非计划型对话时也必须清掉
    if (step.type === 'execution_plan_clear') {
      currentPlanId = null;
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
      return;
    }

    // connected 若被其它模块覆盖导致 enabled 仍为 false，仍以首包 init 打开功能
    if (step.type === 'execution_plan_init' && step.plan) {
      enabled = true;
    }
    if (!enabled) return;

    if (step.type === 'execution_plan_init' && step.plan) {
      currentPlanId = step.plan.planId;
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.setPlan(step.plan);
      return;
    }
    if (step.type === 'execution_plan_update' && step.patch) {
      if (!currentPlanId || step.planId !== currentPlanId) {
        // planId 不匹配：丢弃 patch + 触发全量同步
        scheduleResync();
        return;
      }
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.applyPatch(step.patch);
    }

    // ── TaskGraph events (Phase 7) ──
    if (step.type === 'task_graph_init') {
      enabled = true;
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.renderGraph(step);
      return;
    }
    if (step.type === 'task_graph_node' && step.nodeId) {
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.updateGraphNode(step);
    }
    if (step.type === 'task_graph_branch') {
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.highlightGraphBranch(step);
    }
    if (step.type === 'task_graph_done') {
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.markGraphComplete();
    }
  }

  function onSessionUpdated() {
    if (!enabled) return;
    // 节流：避免短时间多次 session_updated 撞接口
    var now = Date.now();
    if (now - lastSyncMs < 800) return;
    lastSyncMs = now;
    fetchAndApply();
  }

  function fetchAndApply() {
    if (!enabled) return;
    fetch('/api/sessions/' + encodeURIComponent(SESSION_ID) + '/plan', {
      cache: 'no-store',
    })
      .then(function (res) { return res.ok ? res.json() : { plan: null }; })
      .then(function (body) {
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

  // 模块加载即挂载（main.js 加载顺序保证 ChatWebSocket 已存在）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  return bridgeApi;
})();
