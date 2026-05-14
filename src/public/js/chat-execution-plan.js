/**
 * 执行透明层 — 宠物底部摘要 + 悬停/点击详情气泡（锚定 #status-turn，随视口夹紧）。
 *
 * 不再使用右上角固定卡片；详情见 popover，数据仍由 setPlan / applyPatch 驱动。
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

  var INTENT_LABELS = {
    edit: '实现',
    debug: '排查',
    test: '测试',
    refactor: '重构',
    inspect: '查阅',
    docs: '文档',
    question: '问答',
  };

  var rootEl = null;
  var listEl = null;
  var progressEl = null;
  var titleEl = null;
  var currentPlan = null;
  var visible = false;
  var popoverOpen = false;
  var hoverShowTimer = null;
  var hoverHideTimer = null;
  var pinnedOpen = false;
  var anchorBound = false;
  var resizeBound = false;

  var HOVER_SHOW_MS = 220;
  var HOVER_HIDE_MS = 280;

  function isPanelSuppressed() {
    try {
      return localStorage.getItem('ICE_PLAN_PANEL') === '0';
    } catch (_e) {
      return false;
    }
  }

  function getAnchorEl() {
    return document.getElementById('status-turn');
  }

  function ensureMounted() {
    if (rootEl) return rootEl;

    rootEl = document.createElement('aside');
    rootEl.id = PANEL_ID;
    rootEl.className = 'exec-plan-panel exec-plan-panel--popover';
    rootEl.setAttribute('aria-label', '执行计划详情');
    rootEl.setAttribute('role', 'dialog');
    rootEl.setAttribute('aria-modal', 'false');

    rootEl.innerHTML =
      '<header class="exec-plan-header">' +
        '<span class="exec-plan-title" id="exec-plan-title">执行计划</span>' +
        '<span class="exec-plan-progress" id="exec-plan-progress">0%</span>' +
      '</header>' +
      '<ol class="exec-plan-list" id="exec-plan-list"></ol>';

    var attachTo = document.body;
    attachTo.appendChild(rootEl);

    listEl = rootEl.querySelector('#exec-plan-list');
    progressEl = rootEl.querySelector('#exec-plan-progress');
    titleEl = rootEl.querySelector('#exec-plan-title');

    rootEl.addEventListener('mouseenter', function () {
      cancelHidePopover();
    });
    rootEl.addEventListener('mouseleave', function () {
      if (!pinnedOpen) scheduleHidePopover();
    });

    return rootEl;
  }

  function bindAnchorEvents() {
    if (anchorBound) return;
    var el = getAnchorEl();
    if (!el) return;
    anchorBound = true;

    el.addEventListener('mouseenter', onAnchorEnter);
    el.addEventListener('mouseleave', onAnchorLeave);
    el.addEventListener('click', onAnchorClick);
    el.addEventListener('keydown', onAnchorKeydown);
    document.addEventListener('keydown', onGlobalKeydown);
    document.addEventListener('click', onDocumentClickCapture, true);
  }

  function unbindAnchorEvents() {
    if (!anchorBound) return;
    var el = getAnchorEl();
    anchorBound = false;
    if (el) {
      el.removeEventListener('mouseenter', onAnchorEnter);
      el.removeEventListener('mouseleave', onAnchorLeave);
      el.removeEventListener('click', onAnchorClick);
      el.removeEventListener('keydown', onAnchorKeydown);
    }
    document.removeEventListener('keydown', onGlobalKeydown);
    document.removeEventListener('click', onDocumentClickCapture, true);
  }

  function onAnchorEnter() {
    if (!currentPlan || isPanelSuppressed()) return;
    cancelHidePopover();
    if (hoverShowTimer) clearTimeout(hoverShowTimer);
    hoverShowTimer = setTimeout(function () {
      hoverShowTimer = null;
      if (!pinnedOpen) openPopover();
    }, HOVER_SHOW_MS);
  }

  function onAnchorLeave() {
    if (hoverShowTimer) {
      clearTimeout(hoverShowTimer);
      hoverShowTimer = null;
    }
    if (!pinnedOpen) scheduleHidePopover();
  }

  function onAnchorClick(e) {
    if (!currentPlan || isPanelSuppressed()) return;
    e.preventDefault();
    pinnedOpen = !pinnedOpen;
    if (pinnedOpen) openPopover();
    else closePopover();
  }

  function onAnchorKeydown(e) {
    if (!currentPlan || isPanelSuppressed()) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pinnedOpen = !pinnedOpen;
      if (pinnedOpen) openPopover();
      else closePopover();
    }
  }

  function onGlobalKeydown(e) {
    if (e.key === 'Escape' && popoverOpen) {
      pinnedOpen = false;
      closePopover();
    }
  }

  function onDocumentClickCapture(e) {
    var target = e.target;
    var anchor = getAnchorEl();
    if (rootEl && rootEl.contains(target)) return;
    if (anchor && anchor.contains(target)) return;
    if (popoverOpen) {
      pinnedOpen = false;
      closePopover();
    }
  }

  function cancelHidePopover() {
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
  }

  function scheduleHidePopover() {
    cancelHidePopover();
    hoverHideTimer = setTimeout(function () {
      hoverHideTimer = null;
      if (!pinnedOpen) closePopover();
    }, HOVER_HIDE_MS);
  }

  function bindResize() {
    if (resizeBound) return;
    resizeBound = true;
    window.addEventListener('resize', onResizeReflow);
    window.addEventListener('scroll', onResizeReflow, true);
  }

  function unbindResize() {
    if (!resizeBound) return;
    resizeBound = false;
    window.removeEventListener('resize', onResizeReflow);
    window.removeEventListener('scroll', onResizeReflow, true);
  }

  var resizeTimer = null;
  function onResizeReflow() {
    if (!popoverOpen) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      positionPopover();
    }, 60);
  }

  function positionPopover() {
    if (!rootEl) return;
    var anchor = getAnchorEl();
    if (!anchor) return;
    var ar = anchor.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 8;
    var gap = 10;

    rootEl.style.display = 'flex';
    var pw = rootEl.offsetWidth || 280;
    var ph = rootEl.offsetHeight || 200;

    var left = ar.left + ar.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, vw - pw - margin));

    var belowTop = ar.bottom + gap;
    var aboveTop = ar.top - ph - gap;
    var top;
    if (belowTop + ph <= vh - margin) {
      top = belowTop;
    } else if (aboveTop >= margin) {
      top = aboveTop;
    } else {
      top = Math.max(margin, Math.min(belowTop, vh - ph - margin));
    }

    rootEl.style.position = 'fixed';
    rootEl.style.left = Math.round(left) + 'px';
    rootEl.style.top = Math.round(top) + 'px';
    rootEl.style.right = 'auto';
    rootEl.style.bottom = 'auto';
  }

  function openPopover() {
    if (!currentPlan || isPanelSuppressed()) return;
    ensureMounted();
    popoverOpen = true;
    rootEl.classList.add('exec-plan-panel--open');
    rootEl.setAttribute('aria-hidden', 'false');
    var anchor = getAnchorEl();
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    positionPopover();
    bindResize();
  }

  function closePopover() {
    if (!rootEl) return;
    popoverOpen = false;
    rootEl.classList.remove('exec-plan-panel--open');
    rootEl.setAttribute('aria-hidden', 'true');
    rootEl.style.display = '';
    rootEl.style.left = '';
    rootEl.style.top = '';
    rootEl.style.right = '';
    rootEl.style.bottom = '';
    rootEl.style.position = '';
    var anchor = getAnchorEl();
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    unbindResize();
  }

  function updateAnchorChrome() {
    var el = getAnchorEl();
    if (!el) return;
    var on = !!currentPlan && !isPanelSuppressed() && visible;
    if (on) {
      el.classList.add('exec-plan-anchor');
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-haspopup', 'dialog');
      el.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false');
      bindAnchorEvents();
    } else {
      el.classList.remove('exec-plan-anchor');
      el.removeAttribute('tabindex');
      el.removeAttribute('role');
      el.removeAttribute('aria-haspopup');
      el.removeAttribute('aria-expanded');
      pinnedOpen = false;
      closePopover();
      unbindAnchorEvents();
    }
  }

  function countFinished(steps) {
    var n = 0;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i].status;
      if (s === 'done' || s === 'failed' || s === 'skipped') n++;
    }
    return n;
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

  /** 底部一行摘要（供冰豆 #status-turn） */
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
    var intentLabel = INTENT_LABELS[currentPlan.intent] || currentPlan.intent;
    titleEl.textContent = '执行计划 · ' + intentLabel;
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

  function notifyPetFoot() {
    if (typeof window.ChatPetBridge !== 'undefined' && window.ChatPetBridge.syncExecPlanFoot) {
      window.ChatPetBridge.syncExecPlanFoot();
    }
  }

  function setPlan(plan) {
    if (!plan) {
      clear();
      return;
    }
    currentPlan = plan;
    visible = !isPanelSuppressed();
    ensureMounted();
    fullRender();
    updateAnchorChrome();
    rootEl.classList.toggle('exec-plan-panel--suppressed', isPanelSuppressed());
    notifyPetFoot();
    if (popoverOpen) positionPopover();
  }

  function applyPatch(patch) {
    if (!currentPlan || !patch || !rootEl) return;

    if (Array.isArray(patch.stepPatches)) {
      for (var i = 0; i < patch.stepPatches.length; i++) {
        var sp = patch.stepPatches[i];
        var stepObj = currentPlan.steps.find(function (s) {
          return s.id === sp.id;
        });
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

    if (typeof patch.progress === 'number') {
      currentPlan.progress = patch.progress;
      progressEl.textContent = patch.progress + '%';
    }
    if (typeof patch.updatedAt === 'number') {
      currentPlan.updatedAt = patch.updatedAt;
    }
    notifyPetFoot();
    if (popoverOpen) positionPopover();
  }

  function clear() {
    currentPlan = null;
    visible = false;
    pinnedOpen = false;
    closePopover();
    updateAnchorChrome();
    if (rootEl) {
      listEl.innerHTML = '';
      if (progressEl) progressEl.textContent = '0%';
      rootEl.classList.remove('exec-plan-panel--open', 'exec-plan-panel--suppressed');
    }
    notifyPetFoot();
  }

  function setVisible(v) {
    visible = !!v && !isPanelSuppressed();
    if (rootEl) {
      rootEl.classList.toggle('exec-plan-panel--suppressed', isPanelSuppressed() || !visible);
    }
    updateAnchorChrome();
    notifyPetFoot();
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
    formatFootSummary: formatFootSummary,
    isPanelSuppressed: isPanelSuppressed,
  };
})();
