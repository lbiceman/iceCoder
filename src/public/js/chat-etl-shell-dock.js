/**
 * 执行透明层（ETL）底部 — 当前会话运行中的后台 shell 任务。
 *
 * - 仅展示 status=running 的长驻任务；终态（killed/completed 等）立即移除
 * - 数据来自 bg_task_update / connected|session_switched.bgTasks / GET /api/sessions/:id/bg-tasks
 * - 不写入聊天历史（BgTaskChip 仍保留终态 linger）
 */
(function (global) {
  'use strict';

  var dockEl = null;
  var listEl = null;
  var items = new Map(); // taskId → { el, lastTask }
  var stopHandler = null;
  var taskRemovedHandler = null;

  function isRunningDockTask(task) {
    return !!(task && task.taskId && task.status === 'running' && !task.isTerminal);
  }

  function statusText(task, isStopping) {
    if (isStopping) return 'stopping…';
    if (task.isHang) return 'no output >30min';
    var newPart = task.newLines > 0 ? ' · +' + task.newLines + ' lines' : '';
    return 'running · ' + task.elapsed + newPart;
  }

  function displayLabel(task) {
    var raw = task.label || task.command || task.taskId || '';
    var text = String(raw).replace(/[<>]/g, '');
    return text.length > 48 ? text.slice(0, 45) + '...' : text;
  }

  function itemClass(task) {
    var cls = 'etl-shell-item is-running';
    if (task.isHang) cls += ' is-hang';
    return cls;
  }

  function setStopHandler(fn) {
    stopHandler = typeof fn === 'function' ? fn : null;
  }

  function setTaskRemovedHandler(fn) {
    taskRemovedHandler = typeof fn === 'function' ? fn : null;
  }

  function ensureMounted(container) {
    if (!container) return false;
    if (dockEl && dockEl.parentNode && dockEl.parentNode !== container) {
      resetMount();
    }
    if (dockEl && dockEl.parentNode === container) return true;
    dockEl = document.createElement('div');
    dockEl.className = 'etl-shell-dock hidden';
    dockEl.id = 'etl-shell-dock';
    dockEl.setAttribute('aria-label', '后台 shell 任务');
    dockEl.innerHTML =
      '<div class="etl-shell-dock-head">后台命令</div>' +
      '<ul class="etl-shell-list" id="etl-shell-list"></ul>';
    container.insertBefore(dockEl, container.querySelector('#etl-footer') || null);
    listEl = dockEl.querySelector('#etl-shell-list');
    return !!listEl;
  }

  function syncDockVisibility() {
    if (!dockEl) return;
    dockEl.classList.toggle('hidden', items.size === 0);
  }

  function removeItem(taskId) {
    var entry = items.get(taskId);
    if (!entry) return;
    if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    items.delete(taskId);
    syncDockVisibility();
    if (taskRemovedHandler) taskRemovedHandler(taskId);
  }

  function renderItemEl(el, task) {
    var isStopping = el.classList.contains('is-stopping');
    el.className = itemClass(task);
    if (isStopping) el.classList.add('is-stopping');

    var labelEl = el.querySelector('.etl-shell-label');
    var statusEl = el.querySelector('.etl-shell-status');
    if (!labelEl) {
      el.innerHTML =
        '<span class="etl-shell-label"></span>' +
        '<span class="etl-shell-status"></span>';
      labelEl = el.querySelector('.etl-shell-label');
      statusEl = el.querySelector('.etl-shell-status');
    }
    if (labelEl) labelEl.textContent = displayLabel(task);
    if (statusEl) statusEl.textContent = statusText(task, isStopping);

    var existingBtn = el.querySelector('.etl-shell-stop');
    if (existingBtn) existingBtn.parentNode.removeChild(existingBtn);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'etl-shell-stop';
    btn.setAttribute('aria-label', '终止后台命令');
    btn.title = '终止';
    btn.textContent = '\u00d7';
    if (isStopping) btn.disabled = true;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!stopHandler || btn.disabled) return;
      btn.disabled = true;
      el.classList.add('is-stopping');
      stopHandler(task.taskId);
    });
    el.appendChild(btn);
  }

  function upsertTask(task) {
    if (!listEl || !task || !task.taskId) return;
    if (!isRunningDockTask(task)) {
      removeItem(task.taskId);
      return;
    }
    var entry = items.get(task.taskId);
    if (entry && entry.el) {
      renderItemEl(entry.el, task);
      entry.lastTask = task;
    } else {
      var li = document.createElement('li');
      li.setAttribute('data-task-id', task.taskId);
      renderItemEl(li, task);
      listEl.appendChild(li);
      items.set(task.taskId, { el: li, lastTask: task });
    }
    syncDockVisibility();
  }

  function handleUpdate(payload, activeSessionId) {
    if (!payload || !Array.isArray(payload.tasks)) return;
    if (activeSessionId && payload.sessionId && payload.sessionId !== activeSessionId) return;
    for (var i = 0; i < payload.tasks.length; i++) {
      upsertTask(payload.tasks[i]);
    }
  }

  function hydrate(tasks) {
    clearAll();
    if (!Array.isArray(tasks)) return;
    for (var i = 0; i < tasks.length; i++) {
      upsertTask(tasks[i]);
    }
  }

  function resetStopPending(taskId) {
    var entry = items.get(taskId);
    if (!entry || !entry.el || !entry.lastTask) return;
    entry.el.classList.remove('is-stopping');
    renderItemEl(entry.el, entry.lastTask);
  }

  function clearAll() {
    items.forEach(function (entry) {
      if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    });
    items.clear();
    syncDockVisibility();
  }

  /** ETL teardown / 容器切换时重置 DOM 引用 */
  function resetMount() {
    clearAll();
    if (dockEl && dockEl.parentNode) {
      dockEl.parentNode.removeChild(dockEl);
    }
    dockEl = null;
    listEl = null;
  }

  function mount(container) {
    if (!ensureMounted(container)) return false;
    syncDockVisibility();
    return true;
  }

  global.EtlShellDock = {
    mount: mount,
    handleUpdate: handleUpdate,
    hydrate: hydrate,
    clearAll: clearAll,
    resetMount: resetMount,
    setStopHandler: setStopHandler,
    setTaskRemovedHandler: setTaskRemovedHandler,
    resetStopPending: resetStopPending,
    isRunningTask: isRunningDockTask,
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
