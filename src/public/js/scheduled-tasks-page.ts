// @ts-nocheck
import { t, intlLocale, getLocale } from './i18n.ts';
/**
 * 定时任务面板（嵌在「任务」页 TasksPage 中）：
 * 列表、新建/编辑、启停、立即执行、删除、打开任务专属会话。
 */

/* exported ScheduledTasksPage */

export const ScheduledTasksPage = (() => {

  const UNITS = ['second', 'minute', 'hour', 'day'];
  const SCHEDULE_KIND_KEYS = { interval: 'tasks.interval', daily: 'tasks.daily', weekly: 'tasks.weekly', monthly: 'tasks.monthly' };
  const WEEKDAY_KEYS = ['tasks.sun', 'tasks.mon', 'tasks.tue', 'tasks.wed', 'tasks.thu', 'tasks.fri', 'tasks.sat'];
  /** 表单里周一在前。 */
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const STATUS_KEYS = { idle: 'tasks.neverRun', queued: 'tasks.running', success: 'tasks.success', error: 'tasks.failure' };

  const UNIT_KEYS = { second: 'tasks.seconds', minute: 'tasks.minutes', hour: 'tasks.hours', day: 'tasks.days' };

  function weekdayLabel(day) {
    return t(WEEKDAY_KEYS[day] || 'tasks.sun');
  }

  function unitLabel(unit) {
    return t(UNIT_KEYS[unit] || 'tasks.hours');
  }

  function joinList(parts) {
    return parts.filter(Boolean).join(getLocale() === 'en' ? ', ' : '、');
  }
  const POLL_MS = 5000;

  let containerEl = null;
  let tasks = [];
  let pollTimer = null;
  let fetchAbort = null;
  let busyIds = new Set();

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str == null ? '' : String(str)));
    return div.innerHTML;
  }

  function formatTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(intlLocale(), {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function isClockKind(kind) {
    return kind === 'daily' || kind === 'weekly' || kind === 'monthly';
  }

  function monthDaysLabel(days) {
    return joinList((days || []).map((d) => t('tasks.dayOfMonth', { n: d })));
  }

  function formatSchedule(task) {
    const time = task.timeOfDay;
    if (task.scheduleKind === 'monthly') {
      const days = monthDaysLabel(task.monthDays || []);
      return task.once
        ? t('tasks.nextMonthlyOnce', { days, time })
        : t('tasks.monthlyAt', { days, time });
    }
    if (isClockKind(task.scheduleKind)) {
      const days = task.scheduleKind === 'daily'
        ? t('tasks.dayWord')
        : joinList((task.weekdays || []).map(weekdayLabel));
      if (task.once) {
        return t('tasks.nextClockOnce', { days: task.scheduleKind === 'daily' ? '' : days, time });
      }
      return t('tasks.everyClock', { days, time });
    }
    const span = t('tasks.span', { n: task.intervalValue, unit: task.intervalUnit });
    return task.once ? t('tasks.afterSpan', { span }) : t('tasks.everySpan', { span });
  }

  function scheduleLabel(task) {
    if (task.once) return t('tasks.runWord');
    return isClockKind(task.scheduleKind) ? t('tasks.planWord') : t('tasks.gapWord');
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
      throw new Error((data && data.error) || t('tasks.requestFailed', { status: res.status }));
    }
    return data;
  }

  function notifyError(prefix, err) {
    if (window.Notification) Notification.error(t('tasks.prefixedError', { prefix, message: (err && err.message) || t('common.unknownError') }));
  }

  function renderTaskCard(task) {
    const status = task.lastStatus || 'idle';
    const imageCount = (task.images || []).length;
    const skills = (task.skillFilenames || [])
      .map((f) => `<span class="sched-chip">#${escapeHtml(f)}</span>`)
      .concat(imageCount ? [`<span class="sched-chip is-attachment">${t('tasks.images', { n: imageCount })}</span>`] : [])
      .concat((task.files || []).map((f) =>
        `<span class="sched-chip is-attachment" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>`))
      .join('');
    const busy = busyIds.has(task.id);
    return (
      `<article class="sched-card${task.enabled ? '' : ' is-disabled'}" data-task-id="${escapeHtml(task.id)}">` +
        '<div class="sched-card-head">' +
          `<span class="sched-card-name">${escapeHtml(task.name)}</span>` +
          (task.once ? '<span class="sched-badge is-once">' + t('tasks.once') + '</span>' : '') +
          `<span class="sched-status sched-status-${escapeHtml(status)}">${escapeHtml(t(STATUS_KEYS[status] || '') || status)}</span>` +
          `<span class="sched-badge${task.enabled ? ' is-on' : ''}">${task.enabled ? t('tasks.enabled') : t('common.off')}</span>` +
        '</div>' +
        `<p class="sched-card-prompt">${escapeHtml(task.prompt)}</p>` +
        (skills ? `<div class="sched-chips">${skills}</div>` : '') +
        '<dl class="sched-meta">' +
          `<div><dt>${scheduleLabel(task)}</dt><dd>${escapeHtml(formatSchedule(task))}</dd></div>` +
          `<div><dt>${t('tasks.next')}</dt><dd>${task.enabled ? escapeHtml(formatTime(task.nextRunAt)) : '—'}</dd></div>` +
          `<div><dt>${t('tasks.last')}</dt><dd>${escapeHtml(formatTime(task.lastRunAt))}</dd></div>` +
        '</dl>' +
        (status === 'error' && task.lastError
          ? `<div class="sched-error">${escapeHtml(task.lastError)}</div>`
          : '') +
        '<div class="sched-actions">' +
          `<button type="button" class="skills-btn skills-btn-primary" data-action="run"${busy ? ' disabled' : ''}>${t('tasks.runNow')}</button>` +
          `<button type="button" class="skills-btn" data-action="toggle"${busy ? ' disabled' : ''}>${task.enabled ? t('tasks.disable') : t('tasks.enable')}</button>` +
          '<button type="button" class="skills-btn" data-action="edit">' + t('common.edit') + '</button>' +
          (task.sessionId
            ? '<button type="button" class="skills-btn" data-action="open-session">' + t('tasks.openSession') + '</button>'
            : `<button type="button" class="skills-btn" data-action="open-session" disabled title="${escapeHtml(t('tasks.noSession'))}">${t('tasks.openSession')}</button>`) +
          `<button type="button" class="skills-btn skills-btn-danger" data-action="delete"${busy ? ' disabled' : ''}>${t('common.delete')}</button>` +
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
      countEl.textContent = t('tasks.count', { total: tasks.length, enabled });
    }
    if (!listEl) return;
    if (!tasks.length) {
      listEl.innerHTML =
        '<div class="skills-empty">' + t('tasks.empty') + '</div>';
      return;
    }
    listEl.innerHTML = tasks.map(renderTaskCard).join('');
  }

  function reload() {
    if (!containerEl) return Promise.resolve();
    if (fetchAbort) fetchAbort.abort();
    fetchAbort = new AbortController();
    return fetch('/api/scheduled-tasks', { signal: fetchAbort.signal })
      .then((res) => res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || t('common.loadFailed'));
        tasks = body.tasks || [];
        renderList();
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        const listEl = containerEl && containerEl.querySelector('.sched-list');
        if (listEl) {
          listEl.innerHTML = `<div class="skills-empty">${escapeHtml(t('skills.loadFailed', { message: err.message || t('common.unknownError') }))}</div>`;
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
        if (window.Notification) Notification.success(t('tasks.triggered', { name: task.name }));
      } catch (err) {
        notifyError(t('tasks.runFailed'), err);
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
        notifyError(t('tasks.toggleFailed'), err);
      }
    });
  }

  function deleteTask(task) {
    window.Modal.confirm({
      title: t('tasks.deleteTitle'),
      message: t('tasks.deleteBody', { name: task.name }),
      type: 'danger',
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      dangerConfirm: true,
    }).then((ok) => {
      if (!ok) return;
      withBusy(task.id, async () => {
        try {
          await api('DELETE', `/api/scheduled-tasks/${encodeURIComponent(task.id)}`);
          tasks = tasks.filter((t) => t.id !== task.id);
          if (window.Notification) Notification.success(t('tasks.deleted'));
        } catch (err) {
          notifyError(t('common.deleteFailed'), err);
        }
      });
    });
  }

  async function openSession(task) {
    const router = window.AppRouter;
    if (!router || typeof router.navigateWorkChat !== 'function') return;
    // 会话只在执行时创建：还没执行过或专属会话已被删除时不新建，提示等下次执行。
    let sessionId = task.sessionId;
    try {
      const data = await api('POST', `/api/scheduled-tasks/${encodeURIComponent(task.id)}/session`);
      replaceTask(data.task);
      if (!data.sessionReady) {
        if (window.Notification) Notification.info(t('tasks.noSession'));
        return;
      }
      sessionId = data.task.sessionId;
    } catch (err) {
      notifyError(t('tasks.openFailed'), err);
      return;
    }
    const go = () => {
      const sidebar = window.ChatSessionSidebar;
      if (sidebar && typeof sidebar.revealSession === 'function') sidebar.revealSession(sessionId);
      router.navigateWorkChat(sessionId);
    };
    // 刚执行时新建的专属会话可能还不在前端会话列表里；未知会话会被列表同步回退到默认会话。
    const Store = window.ChatSessionStore;
    if (Store && typeof Store.fetchSessions === 'function') Store.fetchSessions(go);
    else go();
  }

  function taskImageUrl(task, image) {
    return `/api/scheduled-tasks/${encodeURIComponent(task.id)}/images/${encodeURIComponent(image.id)}`;
  }

  function fetchSkillOptions() {
    return fetch('/api/skills')
      .then((res) => res.json())
      .then((body) => (body && body.success ? body.skills || [] : []))
      .catch(() => []);
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function isImageFile(file) {
    if (window.ChatFile && typeof window.ChatFile.isImageFile === 'function') return window.ChatFile.isImageFile(file);
    return !!(file && file.type && file.type.startsWith('image/'));
  }

  function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    return fetch('/api/chat/upload', { method: 'POST', body: formData })
      .then((res) => res.json())
      .then((data) => {
        if (!data || data.error || !data.fileId) throw new Error((data && data.error) || t('tasks.uploadFailed'));
        return data;
      });
  }

  /** 与后端行为对应：chat-ws-confirm 无人值守自动通过、SCHEDULED_TASK_SESSION_MAX_BYTES 会话轮换。 */
  function unattendedNoticeHtml() {
    return (
      '<div class="sched-notice" role="note">' +
        '<strong>' + t('tasks.caution') + '</strong>' +
        '<ul>' +
          '<li>' + t('tasks.caution1') + '</li>' +
          '<li>' + t('tasks.caution2') + '</li>' +
          '<li>' + t('tasks.caution3') + '</li>' +
        '</ul>' +
      '</div>'
    );
  }

  /** 光标前的 @ 或 #（与主输入框的技能触发一致）打开技能下拉。 */
  const SKILL_TRIGGER_RE = /[@#]([^\s@#]*)$/;

  /**
   * 提示词编辑器：@ 选技能（输入框上方 chip）、粘贴/拖入/按钮添加图片与文件。
   * 图片和文件先走 /api/chat/upload 拿临时 uploadId，保存任务时由后端转存。
   */
  function createPromptComposer(root, task, skills) {
    const input = root.querySelector('.sched-composer-input');
    const chipBar = root.querySelector('.sched-composer-skills');
    const imageBar = root.querySelector('.sched-composer-images');
    const fileBar = root.querySelector('.sched-composer-files');
    const fileInput = root.querySelector('.sched-composer-file-input');
    const known = new Set(skills.map((s) => s.filename));

    let selectedSkills = ((task && task.skillFilenames) || []).slice();
    let images = ((task && task.images) || []).map((img) => ({ id: img.id, preview: taskImageUrl(task, img), status: 'ready' }));
    let files = ((task && task.files) || []).map((f) => ({ id: f.id, name: f.name, size: f.size, status: 'ready' }));
    let dropdownOpen = false;
    let filtered = [];
    let activeIndex = 0;

    function renderSkills() {
      chipBar.innerHTML = selectedSkills.map((fn, i) => {
        const missing = !known.has(fn);
        return `<span class="skill-chip${missing ? ' is-missing' : ''}" data-index="${i}"${missing ? ' title="' + escapeHtml(t('tasks.missingSkill')) + '"' : ''}>` +
          `<span class="skill-chip-label">#${escapeHtml(fn)}</span>` +
          `<button type="button" class="skill-chip-remove" aria-label="${escapeHtml(t('tasks.removeSkill', { name: fn }))}">×</button>` +
        '</span>';
      }).join('');
      chipBar.classList.toggle('hidden', !selectedSkills.length);
    }

    function renderImages() {
      imageBar.innerHTML = images.map((img, i) =>
        `<div class="pending-image-item${img.status === 'failed' || img.status === 'missing' ? ' is-failed' : ''}${img.status === 'uploading' ? ' is-uploading' : ''}" data-index="${i}"` +
          `${img.status === 'missing' ? ' title="' + escapeHtml(t('tasks.missingImage')) + '"' : ''}>` +
          `<img class="pending-image-thumb" src="${escapeHtml(img.preview)}" alt="${escapeHtml(t('tasks.taskImage'))}">` +
          `<button type="button" class="pending-image-remove" title="${escapeHtml(t('tasks.removeImage'))}">×</button>` +
        '</div>').join('');
      imageBar.classList.toggle('hidden', !images.length);
    }

    function renderFiles() {
      fileBar.innerHTML = files.map((f, i) => {
        const suffix = f.status === 'uploading' ? t('tasks.uploading') : f.status === 'failed' ? t('tasks.uploadError') : ` (${formatSize(f.size)})`;
        return `<div class="pending-file-item" data-index="${i}">` +
          `<span class="pending-file-name${f.status === 'failed' ? ' pending-file-failed' : ''}" title="${escapeHtml(f.name)}">${escapeHtml(f.name + suffix)}</span>` +
          '<button type="button" class="pending-file-remove" title="' + escapeHtml(t('tasks.removeFile')) + '">×</button>' +
        '</div>';
      }).join('');
      fileBar.classList.toggle('hidden', !files.length);
    }

    function addSkill(fn) {
      if (fn && !selectedSkills.includes(fn)) selectedSkills.push(fn);
      renderSkills();
    }

    function addFile(file) {
      if (!file) return;
      if (isImageFile(file)) {
        const entry = { preview: URL.createObjectURL(file), status: 'uploading' };
        images.push(entry);
        renderImages();
        uploadFile(file)
          .then((data) => { entry.uploadId = data.fileId; entry.status = 'ready'; })
          .catch(() => { entry.status = 'failed'; })
          .finally(renderImages);
        return;
      }
      const entry = { name: file.name, size: file.size, status: 'uploading' };
      files.push(entry);
      renderFiles();
      uploadFile(file)
        .then((data) => { entry.uploadId = data.fileId; entry.name = data.filename || entry.name; entry.size = data.size; entry.status = 'ready'; })
        .catch(() => { entry.status = 'failed'; })
        .finally(renderFiles);
    }

    function closeDropdown() {
      if (!dropdownOpen) return;
      dropdownOpen = false;
      if (window.ChatDropdown) window.ChatDropdown.close();
    }

    function highlight() {
      const dd = window.ChatDropdown && window.ChatDropdown.getContainer();
      if (!dd) return;
      const items = dd.querySelectorAll('.cmd-item');
      for (let i = 0; i < items.length; i++) items[i].classList.toggle('active', i === activeIndex);
    }

    function parseTrigger() {
      const cursor = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
      const m = input.value.slice(0, cursor).match(SKILL_TRIGGER_RE);
      return m ? { query: m[1].toLowerCase(), start: cursor - m[0].length, end: cursor } : null;
    }

    function applySkill(index) {
      const item = filtered[index];
      const trigger = parseTrigger();
      closeDropdown();
      if (!item) return;
      if (trigger) {
        input.value = input.value.slice(0, trigger.start) + input.value.slice(trigger.end);
        input.setSelectionRange(trigger.start, trigger.start);
      }
      addSkill(item.key);
      input.focus();
    }

    function updateDropdown() {
      const trigger = parseTrigger();
      if (!trigger || !window.ChatDropdown) { closeDropdown(); return; }
      filtered = skills
        .filter((s) => !selectedSkills.includes(s.filename))
        .filter((s) => [s.filename, s.name, s.description]
          .some((v) => String(v || '').toLowerCase().includes(trigger.query)))
        .map((s) => ({ key: s.filename, name: s.name || s.filename, description: `#${s.filename}` }));
      // 邮箱等普通文本里的 @ 匹配不到技能时不弹空列表。
      if (!filtered.length && trigger.query) { closeDropdown(); return; }
      activeIndex = 0;
      window.ChatDropdown.open({
        anchor: input,
        items: filtered,
        placement: 'auto',
        align: 'start',
        fitContent: true,
        minWidth: 240,
        maxWidth: 360,
        markAnchorActive: false,
        onSelect(_item, idx) { applySkill(idx); },
        onHighlight(_item, idx) { activeIndex = idx; },
        onClose() { dropdownOpen = false; },
      });
      dropdownOpen = true;
      highlight();
    }

    input.addEventListener('input', updateDropdown);
    input.addEventListener('click', updateDropdown);
    input.addEventListener('keydown', (e) => {
      if (dropdownOpen) {
        const count = Math.max(filtered.length, 1);
        let handled = true;
        if (e.key === 'ArrowDown') { activeIndex = (activeIndex + 1) % count; highlight(); }
        else if (e.key === 'ArrowUp') { activeIndex = (activeIndex - 1 + count) % count; highlight(); }
        else if (e.key === 'Enter' || e.key === 'Tab') applySkill(activeIndex);
        else if (e.key === 'Escape') closeDropdown();
        else handled = false;
        if (handled) {
          // 阻止冒泡到弹层的 Escape 关闭。
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (e.key === 'Backspace' && selectedSkills.length
          && input.selectionStart === 0 && input.selectionEnd === 0) {
        e.preventDefault();
        selectedSkills.pop();
        renderSkills();
      }
    });

    input.addEventListener('paste', (e) => {
      const CF = window.ChatFile;
      let pasted = CF && typeof CF.collectClipboardImageFiles === 'function'
        ? CF.collectClipboardImageFiles(e.clipboardData)
        : [];
      if (!pasted.length && CF && typeof CF.readDesktopClipboardImageFile === 'function') {
        const desktopFile = CF.readDesktopClipboardImageFile(e.clipboardData);
        if (desktopFile) pasted = [desktopFile];
      }
      if (!pasted.length) return;
      e.preventDefault();
      pasted.forEach(addFile);
    });

    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      root.classList.add('is-drag-over');
    });
    root.addEventListener('dragleave', (e) => {
      if (!root.contains(e.relatedTarget)) root.classList.remove('is-drag-over');
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('is-drag-over');
      const dropped = e.dataTransfer && e.dataTransfer.files;
      for (let i = 0; dropped && i < dropped.length; i++) addFile(dropped[i]);
    });

    fileInput.addEventListener('change', () => {
      for (let i = 0; i < fileInput.files.length; i++) addFile(fileInput.files[i]);
      fileInput.value = '';
    });

    chipBar.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('.skill-chip-remove');
      if (!btn) return;
      e.preventDefault();
      selectedSkills.splice(Number(btn.closest('.skill-chip').dataset.index), 1);
      renderSkills();
      input.focus();
    });
    // img 的 error 事件不冒泡，只能在捕获阶段统一监听。
    imageBar.addEventListener('error', (e) => {
      const item = e.target && e.target.closest && e.target.closest('.pending-image-item');
      const img = item && images[Number(item.dataset.index)];
      if (!img || img.status !== 'ready' || !img.id) return;
      img.status = 'missing';
      renderImages();
    }, true);
    imageBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.pending-image-remove');
      if (!btn) return;
      const [removed] = images.splice(Number(btn.closest('.pending-image-item').dataset.index), 1);
      if (removed && removed.preview.startsWith('blob:')) URL.revokeObjectURL(removed.preview);
      renderImages();
    });
    fileBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.pending-file-remove');
      if (!btn) return;
      files.splice(Number(btn.closest('.pending-file-item').dataset.index), 1);
      renderFiles();
    });

    renderSkills();
    renderImages();
    renderFiles();

    return {
      validate() {
        const all = images.concat(files);
        if (all.some((a) => a.status === 'uploading')) return t('tasks.waitUpload');
        if (all.some((a) => a.status === 'failed')) return t('tasks.uploadRetry');
        return null;
      },
      getPayload() {
        return {
          skillFilenames: selectedSkills.slice(),
          images: images.map((img) => (img.uploadId ? { uploadId: img.uploadId } : { id: img.id })),
          files: files.map((f) => (f.uploadId ? { uploadId: f.uploadId } : { id: f.id })),
        };
      },
      destroy() {
        closeDropdown();
        images.forEach((img) => { if (img.preview.startsWith('blob:')) URL.revokeObjectURL(img.preview); });
      },
    };
  }

  function scheduleFieldText(clock, once) {
    if (clock) {
      return {
        label: t('tasks.clockTitle'),
        hint: once ? t('tasks.clockOnceHint') : t('tasks.clockHint'),
      };
    }
    return {
      label: once ? t('tasks.durationTitle') : t('tasks.intervalTitle'),
      hint: once ? t('tasks.durationHint') : t('tasks.intervalHint'),
    };
  }

  function applyScheduleUi(form) {
    const once = form.elements.mode.value === 'once';
    const kind = form.elements.scheduleKind.value;
    const clock = isClockKind(kind);
    const text = scheduleFieldText(clock, once);
    form.querySelector('.sched-interval-label').textContent = text.label;
    form.querySelector('.sched-interval-hint').textContent = kind === 'monthly' ? `${text.hint} ${t('tasks.monthEndHint')}` : text.hint;
    form.querySelector('.sched-interval-every').hidden = clock;
    form.querySelector('.sched-clock').hidden = !clock;
    form.querySelector('.sched-weekday-select').hidden = kind !== 'weekly';
    form.querySelector('.sched-monthday-select').hidden = kind !== 'monthly';
    form.querySelector('.sched-interval-prefix').hidden = once;
    form.querySelector('.sched-interval-suffix').hidden = !once;
  }

  /** 表单下拉的选项与当前值；weekdays / monthDays 的值是逗号分隔的星期 / 日期。 */
  function scheduleSelects(task) {
    const weekdays = (task && task.weekdays && task.weekdays.length) ? task.weekdays : [1];
    const monthDays = (task && task.monthDays && task.monthDays.length) ? task.monthDays : [1];
    // AI 可以建多天的每周 / 每月任务；下拉只能单选，多天组合单独列一项，保存时不丢。
    const multiDay = weekdays.length > 1
      ? [{ value: weekdays.join(','), label: joinList(weekdays.map(weekdayLabel)) }]
      : [];
    const multiMonthDay = monthDays.length > 1
      ? [{ value: monthDays.join(','), label: monthDaysLabel(monthDays) }]
      : [];
    const [hour, minute] = ((task && task.timeOfDay) || '09:00').split(':');
    const pad = (n) => String(n).padStart(2, '0');
    const range = (count) => Array.from({ length: count }, (_, i) => ({ value: pad(i), label: pad(i) }));
    return {
      hour: { value: hour, options: range(24) },
      minute: { value: minute, options: range(60) },
      intervalUnit: {
        value: (task && task.intervalUnit) || 'hour',
        options: UNITS.map((u) => ({ value: u, label: unitLabel(u) })),
      },
      weekdays: {
        value: weekdays.join(','),
        options: multiDay.concat(WEEKDAY_ORDER.map((d) => ({ value: String(d), label: weekdayLabel(d) }))),
      },
      monthDays: {
        value: monthDays.join(','),
        options: multiMonthDay.concat(Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: t('tasks.dayOfMonth', { n: i + 1 }) }))),
      },
    };
  }

  /** 按钮 + 隐藏 input（表单照常按 name 取值）；点击后由 bindSelects 用 ChatDropdown 弹出选项，与模型选择一致。 */
  function selectHtml(name, select, className, ariaLabel) {
    const current = select.options.find((o) => o.value === select.value) || select.options[0];
    const caret = window.AppIcon ? window.AppIcon.html('chevron-down', { width: 10, className: 'chip-caret' }) : '▾';
    return (
      `<button type="button" class="sched-input sched-select ${className}" data-select="${name}" aria-label="${ariaLabel}" aria-haspopup="menu" aria-expanded="false">` +
        `<span class="sched-select-label">${escapeHtml(current.label)}</span>${caret}` +
      '</button>' +
      `<input type="hidden" name="${name}" value="${escapeHtml(current.value)}">`
    );
  }

  function bindSelects(form, selects) {
    const Dropdown = window.ChatDropdown;
    form.querySelectorAll('[data-select]').forEach((btn) => {
      const name = btn.getAttribute('data-select');
      const input = form.elements[name];
      const { options } = selects[name];
      btn.addEventListener('click', () => {
        if (!Dropdown) return;
        if (Dropdown.isOpen() && btn.classList.contains('active')) {
          Dropdown.close();
          return;
        }
        Dropdown.open({
          anchor: btn,
          variant: 'model',
          placement: 'bottom',
          align: 'start',
          fitContent: true,
          minWidth: Math.ceil(btn.getBoundingClientRect().width),
          maxWidth: 240,
          items: options.map((o) => ({ key: o.value, name: o.label, isCurrent: o.value === input.value })),
          onSelect(item) {
            input.value = item.key;
            btn.querySelector('.sched-select-label').textContent = item.name;
          },
        });
      });
      // 弹层在 document 上监听 Esc；下拉打开时只关下拉。
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !btn.classList.contains('active')) return;
        e.preventDefault();
        e.stopPropagation();
        Dropdown.close();
      });
    });
  }

  function buildFormHtml(task) {
    const once = !!(task && task.once);
    const kind = (task && task.scheduleKind) || 'interval';
    const selects = scheduleSelects(task);
    const kindOptions = ['interval', 'daily', 'weekly', 'monthly']
      .map((value) =>
        `<label class="sched-mode-option"><input type="radio" name="scheduleKind" value="${value}"${value === kind ? ' checked' : ''}><span>${t(SCHEDULE_KIND_KEYS[value])}</span></label>`)
      .join('');
    const plusIcon = window.AppIcon ? window.AppIcon.html('plus', { width: 18 }) : '+';
    return (
      '<form class="sched-form" novalidate>' +
        '<label class="sched-field"><span class="sched-label">' + t('tasks.name') + '</span>' +
          `<input class="sched-input" name="name" maxlength="80" required value="${escapeHtml((task && task.name) || '')}" placeholder="${escapeHtml(t('tasks.namePh'))}"></label>` +
        '<div class="sched-field"><span class="sched-label">' + t('tasks.prompt') + '</span>' +
          '<div class="sched-composer">' +
            '<div class="pending-images-preview sched-composer-images hidden"></div>' +
            '<div class="file-upload-status sched-composer-files hidden"></div>' +
            '<div class="skill-chips-bar sched-composer-skills hidden" role="listbox" aria-label="' + escapeHtml(t('tasks.pickedSkills')) + '"></div>' +
            `<textarea class="sched-composer-input" name="prompt" rows="5" required placeholder="${escapeHtml(t('tasks.promptPh'))}">${escapeHtml((task && task.prompt) || '')}</textarea>` +
            '<div class="sched-composer-toolbar">' +
              '<div class="composer-file-btn">' +
                '<input type="file" class="composer-file-input sched-composer-file-input" multiple title="' + escapeHtml(t('tasks.attach')) + '" aria-label="' + escapeHtml(t('tasks.attach')) + '">' +
                `<span class="btn-icon btn-icon-ghost composer-file-btn-face" aria-hidden="true">${plusIcon}</span>` +
              '</div>' +
              '<span class="sched-hint">' + t('tasks.attach') + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="sched-field"><span class="sched-label">' + t('tasks.mode') + '</span>' +
          '<div class="sched-mode" role="radiogroup" aria-label="' + escapeHtml(t('tasks.mode')) + '">' +
            `<label class="sched-mode-option"><input type="radio" name="mode" value="repeat"${once ? '' : ' checked'}><span>${t('tasks.repeat')}</span></label>` +
            `<label class="sched-mode-option"><input type="radio" name="mode" value="once"${once ? ' checked' : ''}><span>${t('tasks.onceMode')}</span></label>` +
          '</div>' +
        '</div>' +
        '<div class="sched-field"><span class="sched-label">' + t('tasks.schedule') + '</span>' +
          `<div class="sched-mode" role="radiogroup" aria-label="${escapeHtml(t('tasks.schedule'))}">${kindOptions}</div>` +
        '</div>' +
        '<div class="sched-field"><span class="sched-label sched-interval-label"></span>' +
          '<div class="sched-interval sched-interval-every">' +
            '<span class="sched-interval-prefix">' + t('tasks.every') + '</span>' +
            `<input class="sched-input sched-interval-value" name="intervalValue" type="number" min="1" step="1" value="${escapeHtml((task && task.intervalValue) || 1)}">` +
            selectHtml('intervalUnit', selects.intervalUnit, 'sched-interval-unit', t('tasks.unitAria')) +
            '<span class="sched-interval-suffix">' + t('tasks.thenRun') + '</span>' +
          '</div>' +
          '<div class="sched-interval sched-clock">' +
            selectHtml('weekdays', selects.weekdays, 'sched-weekday-select', t('tasks.weekday')) +
            selectHtml('monthDays', selects.monthDays, 'sched-monthday-select', t('tasks.monthday')) +
            selectHtml('hour', selects.hour, 'sched-time-select', t('tasks.hour')) +
            '<span>:</span>' +
            selectHtml('minute', selects.minute, 'sched-time-select', t('tasks.minute')) +
            '<span class="sched-hint">' + t('tasks.midnightHint') + '</span>' +
          '</div>' +
          '<span class="sched-hint sched-interval-hint"></span>' +
        '</div>' +
        (task ? '' :
          '<label class="sched-check"><input type="checkbox" name="enabled" checked><span>' + t('tasks.enableOnCreate') + '</span></label>') +
        '<div class="sched-form-error" hidden></div>' +
        '<div class="sched-form-actions">' +
          '<button type="button" class="skills-btn" data-form-action="cancel">' + t('common.cancel') + '</button>' +
          `<button type="submit" class="skills-btn skills-btn-primary">${task ? t('common.save') : t('common.create')}</button>` +
        '</div>' +
      '</form>'
    );
  }

  function readForm(form, isEdit, composer) {
    const name = form.elements.name.value.trim();
    const prompt = form.elements.prompt.value.trim();
    const scheduleKind = form.elements.scheduleKind.value;
    if (!name) return { error: t('tasks.nameRequired') };
    if (!prompt) return { error: t('tasks.promptRequired') };
    const schedule = { scheduleKind };
    if (isClockKind(scheduleKind)) {
      schedule.timeOfDay = `${form.elements.hour.value}:${form.elements.minute.value}`;
      if (scheduleKind === 'weekly') {
        schedule.weekdays = form.elements.weekdays.value.split(',').map(Number);
      }
      if (scheduleKind === 'monthly') {
        schedule.monthDays = form.elements.monthDays.value.split(',').map(Number);
      }
    } else {
      schedule.intervalValue = Number(form.elements.intervalValue.value);
      schedule.intervalUnit = form.elements.intervalUnit.value;
      if (!Number.isInteger(schedule.intervalValue) || schedule.intervalValue <= 0) return { error: t('tasks.intervalInvalid') };
    }
    const attachError = composer.validate();
    if (attachError) return { error: attachError };
    const once = form.elements.mode.value === 'once';
    const payload = { name, prompt, ...schedule, once, ...composer.getPayload() };
    if (!isEdit) payload.enabled = !!form.elements.enabled.checked;
    return { payload };
  }

  async function openForm(task) {
    const skills = await fetchSkillOptions();
    const panel = window.Modal.panel({
      title: task ? t('tasks.editTitle') : t('tasks.newTitle'),
      description: t('tasks.formLead'),
      bodyHtml: buildFormHtml(task),
    });
    if (window.AppIcon && typeof window.AppIcon.hydrate === 'function') window.AppIcon.hydrate(panel.body);
    const form = panel.body.querySelector('.sched-form');
    const composer = createPromptComposer(form.querySelector('.sched-composer'), task, skills);
    // 弹层可经 × / 遮罩 / Esc 关闭，统一在节点移除后释放下拉与预览 URL。
    const observer = new MutationObserver(() => {
      if (panel.overlay.isConnected) return;
      observer.disconnect();
      composer.destroy();
    });
    observer.observe(document.body, { childList: true });
    const errorEl = form.querySelector('.sched-form-error');
    const submitBtn = form.querySelector('button[type="submit"]');
    form.querySelector('[data-form-action="cancel"]').addEventListener('click', () => panel.close());
    bindSelects(form, scheduleSelects(task));
    applyScheduleUi(form);
    form.addEventListener('change', (e) => {
      if (e.target && (e.target.name === 'mode' || e.target.name === 'scheduleKind')) applyScheduleUi(form);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { payload, error } = readForm(form, !!task, composer);
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
        if (window.Notification) Notification.success(task ? t('tasks.saved') : t('tasks.created'));
      } catch (err) {
        errorEl.textContent = err.message || t('common.saveFailed');
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
    pollTimer = setInterval(() => {
      if (!document.hidden) reload();
    }, POLL_MS);
  }

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML =
      '<div class="sched-root">' +
        '<div class="sched-toolbar">' +
          '<span class="sched-count skills-count">' + t('common.loadingPage') + '</span>' +
          '<button type="button" class="skills-btn skills-btn-primary" data-sched-create>' + t('tasks.new') + '</button>' +
        '</div>' +
        unattendedNoticeHtml() +
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
