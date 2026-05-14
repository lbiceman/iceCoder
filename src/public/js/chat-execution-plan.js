/**
 * 执行透明层面板（Execution Transparency Layer）—— 前端 UI 渲染。
 *
 * 负责：
 *   1. 挂载 / 卸载折叠卡片到 chat-page 容器内；
 *   2. 接收 setPlan / applyPatch / clear 三个 API 渲染；
 *   3. 仅在 feature flag 开 + 用户偏好允许时显示。
 *
 * 设计文档：docs/execution-transparency-layer.md §Frontend Design
 */

/* exported ChatExecutionPlan */

window.ChatExecutionPlan = (function () {
  'use strict';

  var PANEL_ID = 'exec-plan-panel';
  var STATE_LABELS = {
    pending: '待执行',
    running: '进行中',
    done: '已完成',
    failed: '失败',
    skipped: '已跳过',
  };

  var rootEl = null;
  var listEl = null;
  var progressEl = null;
  var titleEl = null;
  var collapsed = false;
  var currentPlan = null;
  var visible = false;

  function ensureMounted() {
    if (rootEl) return rootEl;

    rootEl = document.createElement('aside');
    rootEl.id = PANEL_ID;
    rootEl.className = 'exec-plan-panel';
    rootEl.setAttribute('aria-label', '执行计划');

    rootEl.innerHTML =
      '<header class="exec-plan-header">' +
        '<button type="button" class="exec-plan-toggle" id="exec-plan-toggle" aria-expanded="true">' +
          '<span class="exec-plan-caret" aria-hidden="true">▾</span>' +
          '<span class="exec-plan-title" id="exec-plan-title">执行计划</span>' +
        '</button>' +
        '<span class="exec-plan-progress" id="exec-plan-progress">0%</span>' +
      '</header>' +
      '<ol class="exec-plan-list" id="exec-plan-list"></ol>';

    var attachTo = document.querySelector('.chat-page')
      || document.getElementById('page-container')
      || document.body;
    attachTo.appendChild(rootEl);

    listEl = rootEl.querySelector('#exec-plan-list');
    progressEl = rootEl.querySelector('#exec-plan-progress');
    titleEl = rootEl.querySelector('#exec-plan-title');

    var toggleBtn = rootEl.querySelector('#exec-plan-toggle');
    toggleBtn.addEventListener('click', function () {
      collapsed = !collapsed;
      rootEl.classList.toggle('collapsed', collapsed);
      toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });

    return rootEl;
  }

  function clamp40(s) {
    if (!s) return '';
    var str = String(s);
    return str.length > 40 ? str.slice(0, 39) + '…' : str;
  }

  function renderStepNode(step, isActive) {
    var li = document.createElement('li');
    li.className = 'exec-plan-step status-' + step.status + (isActive ? ' active' : '');
    li.dataset.stepId = step.id;

    var head = document.createElement('div');
    head.className = 'exec-plan-step-head';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'exec-plan-step-title';
    titleSpan.textContent = clamp40(step.title);
    var badge = document.createElement('span');
    badge.className = 'exec-plan-step-badge';
    badge.textContent = STATE_LABELS[step.status] || step.status;
    head.appendChild(titleSpan);
    head.appendChild(badge);
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

  function fullRender() {
    if (!currentPlan) return;
    ensureMounted();
    titleEl.textContent = '执行计划 · ' + currentPlan.intent;
    progressEl.textContent = (currentPlan.progress || 0) + '%';
    listEl.innerHTML = '';
    for (var i = 0; i < currentPlan.steps.length; i++) {
      var step = currentPlan.steps[i];
      var isActive = step.id === currentPlan.activeStepId;
      listEl.appendChild(renderStepNode(step, isActive));
    }
  }

  function applyPatchToStep(stepEl, patch) {
    if (!stepEl) return;
    if (patch.status) {
      stepEl.classList.remove('status-pending', 'status-running', 'status-done', 'status-failed', 'status-skipped');
      stepEl.classList.add('status-' + patch.status);
      var badge = stepEl.querySelector('.exec-plan-step-badge');
      if (badge) badge.textContent = STATE_LABELS[patch.status] || patch.status;
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

  function setPlan(plan) {
    if (!plan) {
      clear();
      return;
    }
    currentPlan = plan;
    visible = true;
    ensureMounted();
    rootEl.classList.add('visible');
    fullRender();
  }

  function applyPatch(patch) {
    if (!currentPlan || !patch || !rootEl) return;

    if (Array.isArray(patch.stepPatches)) {
      for (var i = 0; i < patch.stepPatches.length; i++) {
        var sp = patch.stepPatches[i];
        var stepObj = currentPlan.steps.find(function (s) { return s.id === sp.id; });
        if (stepObj) {
          Object.assign(stepObj, sp);
        }
        var stepEl = listEl.querySelector('.exec-plan-step[data-step-id="' + sp.id + '"]');
        applyPatchToStep(stepEl, sp);
      }
    }

    if (patch.activeStepId !== undefined) {
      currentPlan.activeStepId = patch.activeStepId || undefined;
      var actives = listEl.querySelectorAll('.exec-plan-step.active');
      actives.forEach(function (n) { n.classList.remove('active'); });
      if (currentPlan.activeStepId) {
        var newActive = listEl.querySelector('.exec-plan-step[data-step-id="' + currentPlan.activeStepId + '"]');
        if (newActive) newActive.classList.add('active');
      }
    }

    if (typeof patch.progress === 'number') {
      currentPlan.progress = patch.progress;
      progressEl.textContent = patch.progress + '%';
    }
    if (typeof patch.updatedAt === 'number') {
      currentPlan.updatedAt = patch.updatedAt;
    }
  }

  function clear() {
    currentPlan = null;
    visible = false;
    if (rootEl) {
      rootEl.classList.remove('visible');
      if (listEl) listEl.innerHTML = '';
      if (progressEl) progressEl.textContent = '0%';
    }
  }

  function setVisible(v) {
    visible = !!v;
    if (rootEl) rootEl.classList.toggle('visible', visible && !!currentPlan);
  }

  function getPlan() {
    return currentPlan;
  }

  function isVisible() {
    return visible;
  }

  return {
    setPlan: setPlan,
    applyPatch: applyPatch,
    clear: clear,
    setVisible: setVisible,
    getPlan: getPlan,
    isVisible: isVisible,
  };
})();
