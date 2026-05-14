/**
 * 执行透明层 — 前端事件桥。
 *
 * 职责：
 *   1. 订阅 ChatWebSocket 的 `step`、`connected`、`session_updated` 事件；
 *   2. 把 `execution_plan_init / update` 转给 ChatExecutionPlan 面板；
 *   3. WS 重连或先错过 init 时通过 GET /api/sessions/:id/plan 重同步；
 *   4. flag 关闭时整条桥不挂载。
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
    if (!enabled) return;
    var step = data && data.step;
    if (!step) return;

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
          if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
          currentPlanId = null;
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
    if (!window.ChatWebSocket) return;
    attached = true;

    // 复用 ChatPage 已有的 step 路由：bridge 仅在已有 step listener 之上再挂一层观察者，
    // 不抢占其他模块的 step 消费。
    var WS = window.ChatWebSocket;
    if (WS.on) {
      // 现在 ChatWebSocket.on 是「最后写入覆盖」语义，因此我们不直接覆盖 step，
      // 而是通过包装在 ChatPage 注册的 step 处理函数之外的方式：监听 connected + session_updated，
      // 并把 step 的处理放进 ChatPage 内部 (见 chat-page.js)。
      // 这里只订阅 connected / session_updated；step 由 ChatPage 主动转发到 handleStep。
      WS.on('connected', function (data) { onConnected(data); });
      WS.on('session_updated', function () { onSessionUpdated(); });
    }
    // 暴露 handleStep 给 ChatPage 在 onWsStep 内手动调用，避免覆盖既有 step handler
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

  // 模块加载即挂载（main.js 加载顺序保证 ChatWebSocket 已存在）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  return bridgeApi;
})();
