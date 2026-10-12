// @ts-nocheck
/**
 * 定时任务面板（嵌在「技能/任务」页的「定时任务」标签下）：
 * 列表、新建/编辑、启停、立即执行、删除、打开任务专属会话。
 */

/* exported ScheduledTasksPage */

export const ScheduledTasksPage = (() => {

  const UNIT_LABELS = { second: '秒', minute: '分钟', hour: '小时', day: '天' };
  const UNITS = ['second', 'minute', 'hour', 'day'];
  const STATUS_LABELS = { idle: '未执行', queued: '执行中', success: '成功', error: '失败' };
  const POLL_MS = 5000;

  let containerEl = null;
  let tasks = [];
  let clockOffset = 0;
  let tickTimer = null;
  let pollTimer = null;
  let fetchAbort = null;
  let busyIds = new Set();

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str == null ? '' : String(str)));
    return div.innerHTML;
  }

  function serverNow() {
    return Date.now() + clockOffset;
  }

  function formatTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatCountdown(ms) {
    if (ms <= 0) return '即将执行';
    const total = Math.ceil(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const parts = [];
    if (d) parts.push(`${d}天`);
    if (d || h) parts.push(`${h}时`);
    if (d || h || m) parts.push(`${m}分`);
    parts.push(`${s}秒`);
    return parts.join('') + '后';
  }

  function formatInterval(task) {
    return `每 ${task.intervalValue} ${UNIT_LABELS[task.intervalUnit] || task.intervalUnit}`;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_e) { /* 非 JSON 响应 */ }
    if (!res.ok || !data || !data.success) {
      throw new Error((data && data.error) || `请求失败（${res.status}）`);
    }
    return data;
  }

  function notifyError(prefix, err) {
    if (window.Notification) Notification.error(`${prefix}：${(err && err.message) || '未知错误'}`);
  }

  function countdownText(task) {
    if (!task.enabled) return '已停用';
    if (!task.nextRunAt) return '—';
    return formatCountdown(task.nextRunAt - serverNow());
  }

  function renderTaskCard(task) {
    const status = task.lastStatus || 'idle';
    const skills = (task.skillFilenames || [])
      .map((f) => `<span class="sched-chip">#${escapeHtml(f)}</span>`)
      .join('');
    const busy = busyIds.has(task.id);
    return (
      `<article class="sched-card${task.enabled ? '' : ' is-disabled'}" data-task-id="${escapeHtml(task.id)}">` +
        '<div class="sched-card-head">' +
          `<span class="sched-card-name">${escapeHtml(task.name)}</span>` +
          `<span class="sched-status sched-status-${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>` +
          `<span class="sched-badge${task.enabled ? ' is-on' : ''}">${task.enabled ? '已启用' : '已停用'}</span>` +
        '</div>' +
        `<p class="sched-card-prompt">${escapeHtml(task.prompt)}</p>` +
        (skills ? `<div class="sched-chips">${skills}</div>` : '') +
        '<dl class="sched-meta">' +
          `<div><dt>间隔</dt><dd>${escapeHtml(formatInterval(task))}</dd></div>` +
          `<div><dt>下次执行</dt><dd>${task.enabled ? escapeHtml(formatTime(task.nextRunAt)) : '—'}` +
            ` <span class="sched-countdown" data-countdown="${escapeHtml(task.id)}">${escapeHtml(countdownText(task))}</span></dd></div>` +
          `<div><dt>上次执行</dt><dd>${escapeHtml(formatTime(task.lastRunAt))}</dd></div>` +
        '</dl>' +
        (status === 'error' && task.lastError
          ? `<div class="sched-error">${escapeHtml(task.lastError)}</div>`
          : '') +
        '<div class="sched-actions">' +
          `<button type="button" class="skills-btn skills-btn-primary" data-action="run"${busy ? ' disabled' : ''}>立即执行</button>` +
          `<button type="button" class="skills-btn" data-action="toggle"${busy ? ' disabled' : ''}>${task.enabled ? '停用' : '启用'}</button>` +
          '<button type="button" class="skills-btn" data-action="edit">编辑</button>' +
          '<button type="button" class="skills-btn" data-action="open-session">打开会话</button>' +
          `<button type="button" class="skills-btn skills-btn-danger" data-action="delete"${busy ? ' disabled' : ''}>删除</button>` +
        '</div>' +
      '</article>'
    );
  }

  function renderList() {
    if (!containerEl) return;
    const listEl = containerEl.querySelector('.sched-list');
    const countEl = containerEl.querySelector('.sched-count');
    if (countEl) {
      const enabled = tasks.filter((t) => t.enabled).length;
      countEl.textContent = `${tasks.length} 个任务 · ${enabled} 个启用`;
    }
    if (!listEl) return;
    if (!tasks.length) {
      listEl.innerHTML =
        '<div class="skills-empty">暂无定时任务。点击「新建任务」，设定提示词与执行间隔（秒 / 分钟 / 小时 / 天）。</div>';
      return;
    }
    listEl.innerHTML = tasks.map(renderTaskCard).join('');
  }

  function tickCountdowns() {
    if (!containerEl) return;
    const nodes = containerEl.querySelectorAll('[data-countdown]');
    for (let i = 0; i < nodes.length; i++) {
      const task = tasks.find((t) => t.id === nodes[i].getAttribute('data-countdown'));
      if (task) nodes[i].textContent = countdownText(task);
    }
  }

  function reload() {
    if (!containerEl) return Promise.resolve();
    if (fetchAbort) fetchAbort.abort();
    fetchAbort = new AbortController();
    return fetch('/api/scheduled-tasks', { signal: fetchAbort.signal })
      .then((res) => res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || '加载失败');
        tasks = body.tasks || [];
        if (typeof body.now === 'number') clockOffset = body.now - Date.now();
        renderList();
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        const listEl = containerEl && containerEl.querySelector('.sched-list');
        if (listEl) {
          listEl.innerHTML = `<div class="skills-empty">加载失败：${escapeHtml(err.message || '未知错误')}</div>`;
        }
      });
  }

  function replaceTask(task) {
    if (!task) return;
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) tasks[idx] = task; else tasks.unshift(task);
    renderList();
  }

  async function withBusy(id, fn) {
    busyIds.add(id);
    renderList();
    try {
      await fn();
    } finally {
      busyIds.delete(id);
      renderList();
    }
  }

  function runTask(task) {
    return withBusy(task.id, async () => {
      try {
        const data = await api('POST', `/api/scheduled-tasks/${encodeURIComponent(task.id)}/run`);
        replaceTask(data.task);
        if (window.Notification) Notification.success(`已触发「${task.name}」`);
      } catch (err) {
        notifyError('执行失败', err);
        await reload();
      }
    });
  }

  function toggleTask(task) {
    return withBusy(task.id, async () => {
      try {
        const data = await api('POST', `/api/scheduled-tasks/${encodeURIComponent(task.id)}/toggle`, {
          enabled: !task.enabled,
        });
        replaceTask(data.task);
      } catch (err) {
        notifyError('切换失败', err);
      }
    });
  }

  function deleteTask(task) {
    window.Modal.confirm({
      title: '删除定时任务',
      message: `确定删除「${task.name}」？任务的历史会话会保留在会话列表中。`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      dangerConfirm: true,
    }).then((ok) => {
      if (!ok) return;
      withBusy(task.id, async () => {
        try {
          await api('DELETE', `/api/scheduled-tasks/${encodeURIComponent(task.id)}`);
          tasks = tasks.filter((t) => t.id !== task.id);
          if (window.Notification) Notification.success('任务已删除');
        } catch (err) {
          notifyError('删除失败', err);
        }
      });
    });
  }

  function openSession(task) {
    const router = window.AppRouter;
    if (!router || typeof router.navigateWorkChat !== 'function') return;
    const go = () => router.navigateWorkChat(task.sessionId);
    // 新建任务的专属会话可能还不在前端会话列表里；未知会话会被列表同步回退到默认会话。
    const Store = window.ChatSessionStore;
    if (Store && typeof Store.fetchSessions === 'function') Store.fetchSessions(go);
    else go();
  }

  function fetchSkillOptions() {
    return fetch('/api/skills')
      .then((res) => res.json())
      .then((body) => (body && body.success ? body.skills || [] : []))
      .catch(() => []);
  }

  function buildFormHtml(task, skills) {
    const selected = new Set((task && task.skillFilenames) || []);
    const known = new Set(skills.map((s) => s.filename));
    const missing = [...selected].filter((f) => !known.has(f));
    const skillRows = skills
      .map((s) =>
        '<label class="sched-skill-option">' +
          `<input type="checkbox" name="skill" value="${escapeHtml(s.filename)}"${selected.has(s.filename) ? ' checked' : ''}>` +
          `<span class="sched-skill-name">${escapeHtml(s.name || s.filename)}</span>` +
          `<span class="sched-skill-file">#${escapeHtml(s.filename)}</span>` +
        '</label>')
      .concat(missing.map((f) =>
        '<label class="sched-skill-option is-missing">' +
          `<input type="checkbox" name="skill" value="${escapeHtml(f)}" checked>` +
          `<span class="sched-skill-name">${escapeHtml(f)}</span>` +
          '<span class="sched-skill-file">已不存在，执行时跳过</span>' +
        '</label>'))
      .join('');
    const unit = (task && task.intervalUnit) || 'hour';
    const unitOptions = UNITS
      .map((u) => `<option value="${u}"${u === unit ? ' selected' : ''}>${UNIT_LABELS[u]}</option>`)
      .join('');
    return (
      '<form class="sched-form" novalidate>' +
        '<label class="sched-field"><span class="sched-label">任务名称</span>' +
          `<input class="sched-input" name="name" maxlength="80" required value="${escapeHtml((task && task.name) || '')}" placeholder="例如：每日检查依赖更新"></label>` +
        '<label class="sched-field"><span class="sched-label">提示词</span>' +
          `<textarea class="sched-input sched-textarea" name="prompt" rows="5" required placeholder="到点后发送给 Agent 的内容">${escapeHtml((task && task.prompt) || '')}</textarea></label>` +
        '<div class="sched-field"><span class="sched-label">执行间隔</span>' +
          '<div class="sched-interval">' +
            `<span>每</span><input class="sched-input sched-interval-value" name="intervalValue" type="number" min="1" step="1" required value="${escapeHtml((task && task.intervalValue) || 1)}">` +
            `<select class="sched-input sched-interval-unit" name="intervalUnit">${unitOptions}</select>` +
          '</div>' +
          '<span class="sched-hint">首次执行在保存后满一个间隔；服务停机期间错过的执行会直接跳过。</span>' +
        '</div>' +
        '<div class="sched-field"><span class="sched-label">绑定技能（可选，可多选）</span>' +
          (skillRows
            ? `<div class="sched-skill-list">${skillRows}</div>`
            : '<span class="sched-hint">暂无可用技能，只用提示词即可。</span>') +
        '</div>' +
        (task ? '' :
          '<label class="sched-check"><input type="checkbox" name="enabled" checked><span>创建后立即启用</span></label>') +
        '<div class="sched-form-error" hidden></div>' +
        '<div class="sched-form-actions">' +
          '<button type="button" class="skills-btn" data-form-action="cancel">取消</button>' +
          `<button type="submit" class="skills-btn skills-btn-primary">${task ? '保存' : '创建'}</button>` +
        '</div>' +
      '</form>'
    );
  }

  function readForm(form, isEdit) {
    const name = form.elements.name.value.trim();
    const prompt = form.elements.prompt.value.trim();
    const intervalValue = Number(form.elements.intervalValue.value);
    const intervalUnit = form.elements.intervalUnit.value;
    if (!name) return { error: '请填写任务名称' };
    if (!prompt) return { error: '请填写提示词' };
    if (!Number.isInteger(intervalValue) || intervalValue <= 0) return { error: '执行间隔必须是正整数' };
    const skillFilenames = Array.from(form.querySelectorAll('input[name="skill"]:checked')).map((el) => el.value);
    const payload = { name, prompt, intervalValue, intervalUnit, skillFilenames };
    if (!isEdit) payload.enabled = !!form.elements.enabled.checked;
    return { payload };
  }

  async function openForm(task) {
    const skills = await fetchSkillOptions();
    const panel = window.Modal.panel({
      title: task ? '编辑定时任务' : '新建定时任务',
      description: '到点后把提示词（及所选技能）发送到该任务的专属会话。',
      bodyHtml: buildFormHtml(task, skills),
    });
    const form = panel.body.querySelector('.sched-form');
    const errorEl = form.querySelector('.sched-form-error');
    const submitBtn = form.querySelector('button[type="submit"]');
    form.querySelector('[data-form-action="cancel"]').addEventListener('click', () => panel.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { payload, error } = readForm(form, !!task);
      if (error) {
        errorEl.textContent = error;
        errorEl.hidden = false;
        return;
      }
      errorEl.hidden = true;
      submitBtn.disabled = true;
      try {
        const data = task
          ? await api('PUT', `/api/scheduled-tasks/${encodeURIComponent(task.id)}`, payload)
          : await api('POST', '/api/scheduled-tasks', payload);
        replaceTask(data.task);
        panel.close();
        if (window.Notification) Notification.success(task ? '任务已保存' : '任务已创建');
      } catch (err) {
        errorEl.textContent = err.message || '保存失败';
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
    const first = form.elements.name;
    if (first) setTimeout(() => first.focus(), 50);
  }

  function onListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const card = btn.closest('[data-task-id]');
    const task = card && tasks.find((t) => t.id === card.getAttribute('data-task-id'));
    if (!task) return;
    const action = btn.getAttribute('data-action');
    if (action === 'run') runTask(task);
    else if (action === 'toggle') toggleTask(task);
    else if (action === 'edit') openForm(task);
    else if (action === 'open-session') openSession(task);
    else if (action === 'delete') deleteTask(task);
  }

  function startTimers() {
    stopTimers();
    tickTimer = setInterval(tickCountdowns, 1000);
    pollTimer = setInterval(() => {
      if (!document.hidden) reload();
    }, POLL_MS);
  }

  function stopTimers() {
    if (tickTimer) clearInterval(tickTimer);
    if (pollTimer) clearInterval(pollTimer);
    tickTimer = null;
    pollTimer = null;
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML =
      '<div class="sched-root">' +
        '<div class="sched-toolbar">' +
          '<span class="sched-count skills-count">载入中…</span>' +
          '<button type="button" class="skills-btn skills-btn-primary" data-sched-create>新建任务</button>' +
        '</div>' +
        '<div class="sched-list"></div>' +
      '</div>';
    parentEl.querySelector('[data-sched-create]').addEventListener('click', () => openForm(null));
    parentEl.querySelector('.sched-list').addEventListener('click', onListClick);
    startTimers();
    reload();
  }

  function destroy() {
    stopTimers();
    if (fetchAbort) {
      fetchAbort.abort();
      fetchAbort = null;
    }
    containerEl = null;
    tasks = [];
    busyIds = new Set();
  }

  return { render, reload, destroy };
})();

if (typeof window !== 'undefined') {
  window.ScheduledTasksPage = ScheduledTasksPage;
}
