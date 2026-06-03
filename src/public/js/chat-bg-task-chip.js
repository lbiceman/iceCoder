/**
 * 后台任务 ephemeral chip 渲染（Phase 4b UI 通路）。
 *
 * - 不调 Session.appendMessage（不进消息流持久化）
 * - 同 taskId 的更新替换前一条，不堆叠
 * - 任务进入终态后保留 5 分钟，然后淡出移除
 * - 提供 clearAll() 给 session 切换调用
 */
(function (global) {
  'use strict';

  var TERMINAL_LINGER_MS = 5 * 60 * 1000;
  var CHIP_CLASS = 'message-bg_status';

  /** ChipStore：跟踪当前活跃 chip 元素 + 自动移除定时器 */
  var chips = new Map(); // taskId → { el, removeTimer, lastTask, viaCheck }
  var stopHandler = null;

  function terminalConfirmSuffix(task) {
    if (!task.isTerminal || !task.viaCheck) return '';
    if (task.status === 'completed') return ' · confirmed via check';
    if (task.status === 'failed' || task.status === 'timeout' || task.status === 'killed') {
      return ' · confirmed failed via check';
    }
    return ' · confirmed via check';
  }

  function ensureContainer(messagesEl) {
    if (!messagesEl) return null;
    var container = messagesEl.querySelector('.bg-status-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'bg-status-container';
      var tailRoot = messagesEl.querySelector('.chat-tail-root');
      var tailAnchor = messagesEl.querySelector('.chat-tail-anchor');
      var insertParent = (tailRoot && tailAnchor) ? tailRoot : messagesEl;
      var insertRef = (tailRoot && tailAnchor) ? tailAnchor : messagesEl.querySelector('.chat-messages-anchor');
      if (insertRef) {
        insertParent.insertBefore(container, insertRef);
      } else {
        messagesEl.appendChild(container);
      }
    }
    return container;
  }

  function buildChipHtml(task, isStopping) {
    var statusText;
    if (isStopping) {
      statusText = 'stopping…';
    } else if (task.isHang) {
      statusText = 'no output for >30min, may be hung';
    } else if (task.isTerminal) {
      var verb = task.status === 'completed' ? 'completed'
               : task.status === 'failed' ? 'failed'
               : task.status === 'timeout' ? 'timed out'
               : 'killed';
      var exitPart = (typeof task.exitCode === 'number') ? (' · exit=' + task.exitCode) : '';
      statusText = verb + ' · ' + task.elapsed + exitPart + terminalConfirmSuffix(task);
    } else {
      var newPart = task.newLines > 0 ? (' · +' + task.newLines + ' lines') : ' · no new output';
      statusText = 'running · ' + task.elapsed + newPart;
    }
    var shortId = (task.taskId || '').slice(0, 8);
    var label = (task.label || '').replace(/[<>]/g, '');
    return '<span class="bg-status-label">' + label + '</span>' +
           '<span class="bg-status-id">[' + shortId + ']</span> ' +
           '<span class="bg-status-text">' + statusText + '</span>';
  }

  function classForTask(task) {
    var cls = CHIP_CLASS;
    if (task.isHang) cls += ' is-hang';
    else if (task.isTerminal) {
      if (task.status === 'completed') cls += ' is-terminal-success';
      else cls += ' is-terminal-error';
    }
    return cls;
  }

  function setStopHandler(fn) {
    stopHandler = typeof fn === 'function' ? fn : null;
  }

  function renderChipEl(el, task) {
    var isStopping = el.classList.contains('is-stopping') && !task.isTerminal;
    el.className = classForTask(task);
    if (isStopping) el.classList.add('is-stopping');
    el.innerHTML = '';
    var body = document.createElement('div');
    body.className = 'bg-status-body';
    body.innerHTML = buildChipHtml(task, isStopping);
    el.appendChild(body);
    var canStop = !task.isTerminal && task.status === 'running';
    if (canStop) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bg-status-stop-btn';
      btn.setAttribute('aria-label', '终止后台任务');
      btn.title = '终止';
      btn.textContent = '\u00d7';
      if (el.classList.contains('is-stopping')) btn.disabled = true;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!stopHandler || btn.disabled) return;
        btn.disabled = true;
        el.classList.add('is-stopping');
        stopHandler(task.taskId, btn, el);
      });
      el.appendChild(btn);
    } else {
      el.classList.remove('is-stopping');
    }
  }

  function scheduleRemoval(taskId, delayMs) {
    var entry = chips.get(taskId);
    if (!entry) return;
    if (entry.removeTimer) clearTimeout(entry.removeTimer);
    entry.removeTimer = setTimeout(function () {
      removeChip(taskId);
    }, delayMs);
  }

  function removeChip(taskId) {
    var entry = chips.get(taskId);
    if (!entry) return;
    if (entry.el && entry.el.parentNode) {
      entry.el.parentNode.removeChild(entry.el);
    }
    if (entry.removeTimer) clearTimeout(entry.removeTimer);
    chips.delete(taskId);
  }

  /**
   * 处理一条 bg_task_update 事件。
   *
   * @param {HTMLElement} messagesEl 聊天消息容器
   * @param {Object} payload 事件负载（含 sessionId, tasks[]）
   * @param {string} activeSessionId 当前活跃 session（用于过滤）
   */
  function handleUpdate(messagesEl, payload, activeSessionId) {
    if (!payload || !Array.isArray(payload.tasks)) return;
    if (activeSessionId && payload.sessionId && payload.sessionId !== activeSessionId) {
      return; // 非当前 session 忽略
    }
    var container = ensureContainer(messagesEl);
    if (!container) return;

    for (var i = 0; i < payload.tasks.length; i++) {
      var task = payload.tasks[i];
      if (!task || !task.taskId) continue;
      upsertChip(container, task);
    }
  }

  function upsertChip(container, task) {
    var entry = chips.get(task.taskId);
    if (entry && entry.viaCheck) {
      task = Object.assign({}, task, { viaCheck: true });
    }
    if (entry && entry.el) {
      renderChipEl(entry.el, task);
      entry.lastTask = task;
      entry.viaCheck = entry.viaCheck || !!task.viaCheck;
    } else {
      var el = document.createElement('div');
      el.setAttribute('data-task-id', task.taskId);
      renderChipEl(el, task);
      container.appendChild(el);
      chips.set(task.taskId, { el: el, removeTimer: null, lastTask: task, viaCheck: !!task.viaCheck });
      entry = chips.get(task.taskId);
    }

    if (task.isTerminal) {
      scheduleRemoval(task.taskId, TERMINAL_LINGER_MS);
    }
  }

  /** check 轮询确认终态后，为 chip 追加说明文案 */
  function markConfirmedViaCheck(messagesEl, taskId) {
    if (!taskId) return;
    var entry = chips.get(taskId);
    if (!entry || !entry.el) return;
    entry.viaCheck = true;
    if (entry.lastTask) {
      var container = entry.el.parentNode;
      if (container) {
        upsertChip(container, Object.assign({}, entry.lastTask, { viaCheck: true }));
      }
    }
  }

  /** 终止请求失败时恢复关闭按钮（任务仍在运行） */
  function resetStopPending(taskId) {
    var entry = chips.get(taskId);
    if (!entry || !entry.el || !entry.lastTask) return;
    entry.el.classList.remove('is-stopping');
    var container = entry.el.parentNode;
    if (container) upsertChip(container, entry.lastTask);
  }

  /** 切换 session / 清屏时调用 */
  function clearAll() {
    chips.forEach(function (entry, taskId) {
      if (entry.removeTimer) clearTimeout(entry.removeTimer);
      if (entry.el && entry.el.parentNode) {
        entry.el.parentNode.removeChild(entry.el);
      }
    });
    chips.clear();
  }

  /** 测试 / 调试用：返回当前活跃 chip 的数量 */
  function getActiveCount() {
    return chips.size;
  }

  global.BgTaskChip = {
    handleUpdate: handleUpdate,
    markConfirmedViaCheck: markConfirmedViaCheck,
    setStopHandler: setStopHandler,
    resetStopPending: resetStopPending,
    clearAll: clearAll,
    getActiveCount: getActiveCount,
    /** 暴露用于单测：构造 chip 文本 */
    _buildChipHtml: buildChipHtml,
    _classForTask: classForTask,
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
