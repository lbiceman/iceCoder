// @ts-nocheck
/**
 * 子 Agent 卡片：主 Agent 的 `task` 工具行渲染为卡片，实时展示子 Agent 的工具轨迹、计时与结果。
 *
 * 数据来源：
 * - WS：agent_update（卡片状态）、带 agentId 的 step（工具轨迹）、agent_stream（当前在做什么）
 * - 运行中快照：runningTurn.agents（刷新 / 扫码后恢复）
 * - 历史：带 agentId 的 tool_trace（工具轨迹）+ GET /api/sessions/:id/agents（标题行与结果）
 *
 * 卡片挂在 `task` 工具行所在的 .tool-action-row-block 内，按 parentToolCallId 关联。
 * 同一轮里相邻的多个 task 行合成并行分组，在第一张卡片上方显示分组计数。
 * 依赖：window.ChatUI（工具行渲染）、window.ChatSession、window.ChatWebSocket、window.ChatAgentDrawer。
 * 暴露：window.ChatAgentCards。
 */

/* exported ChatAgentCards */

export const ChatAgentCards = (() => {
  const RECENT_ROWS = 5;
  const ROWS_MAX = 300;
  const STREAM_MAX_CHARS = 8000;
  const HISTORY_REFETCH_GAP_MS = 3000;

  const STATUS_LABEL = {
    queued: '排队中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    timeout: '超时',
    max_rounds: '达到轮次上限',
    cancelled: '已取消',
  };
  const TERMINAL = { completed: 1, failed: 1, timeout: 1, max_rounds: 1, cancelled: 1 };

  /** agentId → { agentId, view, rows, streamText, expanded, detail, detailLoading } */
  const agents = {};
  /** parentToolCallId → agentId */
  const byParentCall = {};
  let historyFetch = { sid: '', at: 0, pending: false };
  let tickTimer = 0;
  let groupRefreshQueued = false;

  function activeSessionId() {
    const S = window.ChatSession;
    return (S && S.getActiveId && S.getActiveId()) || 'default';
  }

  function cssEscape(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  function isMobileShell() {
    try {
      return document.documentElement.getAttribute('data-shell') === 'mobile';
    } catch (_e) {
      return false;
    }
  }

  function ensureState(agentId) {
    if (!agents[agentId]) {
      agents[agentId] = {
        agentId,
        view: null,
        rows: [],
        streamText: '',
        expanded: null,
        detail: null,
        detailLoading: false,
      };
    }
    return agents[agentId];
  }

  function isTerminal(view) {
    return !!(view && TERMINAL[view.status]);
  }

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => (n < 10 ? `0${n}` : String(n));
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function formatTokens(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function elapsedOf(view) {
    if (!view || !view.startedAt) return 0;
    const end = view.finishedAt || Date.now();
    return end - view.startedAt;
  }

  function commandSummary(view) {
    const cmds = (view && view.commands) || [];
    if (!cmds.length) return '';
    let failed = 0;
    for (let i = 0; i < cmds.length; i++) {
      if (typeof cmds[i].exitCode === 'number' && cmds[i].exitCode !== 0) failed++;
    }
    return failed ? `${failed} 条命令失败` : '命令全部通过';
  }

  function statusText(view) {
    if (!view) return '';
    if (view.interrupted) return '已中断';
    return STATUS_LABEL[view.status] || view.status;
  }

  function headMetaParts(view) {
    const parts = [statusText(view)];
    const elapsed = elapsedOf(view);
    if (elapsed > 0) parts.push(formatElapsed(elapsed));
    parts.push(`${view.toolCalls || 0} 次工具调用`);
    if (isTerminal(view)) {
      const files = (view.filesChanged || []).length;
      if (files) parts.push(`改了 ${files} 个文件`);
      const cmd = commandSummary(view);
      if (cmd) parts.push(cmd);
    }
    return parts;
  }

  /** 流式输出的最近一句，用作“当前在做什么” */
  function lastSentence(text) {
    const trimmed = String(text || '').replace(/\s+$/, '');
    if (!trimmed) return '';
    const lines = trimmed.split('\n');
    let line = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) { line = lines[i].trim(); break; }
    }
    const pieces = line.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
    const last = pieces.length ? pieces[pieces.length - 1] : line;
    return last.length > 120 ? `…${last.slice(-120)}` : last;
  }

  function parseTaskDetail(detail) {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(String(detail || ''));
    return m ? { type: m[1], description: m[2] } : { type: 'general', description: String(detail || '') };
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function buildCardSkeleton(parentToolCallId) {
    const card = el('div', 'agent-card');
    card.setAttribute('data-parent-call-id', parentToolCallId);

    const head = el('div', 'agent-card__head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.appendChild(el('span', 'agent-card__type'));
    head.appendChild(el('span', 'agent-card__desc'));
    const lease = el('span', 'agent-card__lease');
    lease.hidden = true;
    head.appendChild(lease);
    head.appendChild(el('span', 'agent-card__meta'));
    const stop = el('button', 'agent-card__stop', '■ 停止');
    stop.type = 'button';
    stop.hidden = true;
    head.appendChild(stop);
    head.appendChild(el('span', 'agent-card__chevron', '▾'));
    card.appendChild(head);

    const body = el('div', 'agent-card__body');
    const activity = el('div', 'agent-card__activity');
    const olderToggle = el('button', 'agent-card__older-toggle');
    olderToggle.type = 'button';
    olderToggle.hidden = true;
    const older = el('div', 'agent-card__older');
    older.hidden = true;
    const recent = el('div', 'agent-card__recent');
    activity.appendChild(olderToggle);
    activity.appendChild(older);
    activity.appendChild(recent);
    body.appendChild(activity);
    body.appendChild(el('div', 'agent-card__now'));
    body.appendChild(el('div', 'agent-card__result'));
    card.appendChild(body);

    head.addEventListener('click', (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.agent-card__stop')) return;
      onHeadClick(card);
    });
    head.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onHeadClick(card);
      }
    });
    stop.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const agentId = card.getAttribute('data-agent-id');
      if (agentId) requestStop(agentId, stop);
    });
    olderToggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      older.hidden = !older.hidden;
      refreshOlderToggle(card);
      notifyLayout(card);
    });
    return card;
  }

  function onHeadClick(card) {
    const agentId = card.getAttribute('data-agent-id');
    if (isMobileShell()) {
      if (agentId && window.ChatAgentDrawer) window.ChatAgentDrawer.openCard(agentId);
      return;
    }
    const state = agentId ? agents[agentId] : null;
    const expanded = !card.classList.contains('is-expanded');
    if (state) state.expanded = expanded;
    card.classList.toggle('is-expanded', expanded);
    if (expanded && state && isTerminal(state.view)) loadDetail(state);
    notifyLayout(card);
  }

  function requestStop(agentId, btn) {
    const WS = window.ChatWebSocket;
    if (!WS || typeof WS.send !== 'function') return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '停止中…';
    }
    WS.send({ type: 'agent_stop', agentId });
  }

  function notifyLayout(node) {
    const UI = window.ChatUI;
    if (UI && typeof UI.notifyNodeLayoutChange === 'function') UI.notifyNodeLayoutChange(node);
  }

  function cardsForParentCall(parentToolCallId) {
    if (!parentToolCallId) return [];
    const list = document.querySelectorAll(`.agent-card[data-parent-call-id="${cssEscape(parentToolCallId)}"]`);
    return Array.prototype.slice.call(list);
  }

  function findTaskBlock(parentToolCallId) {
    const list = document.querySelectorAll(`.tool-action-row-block[data-tool-call-id="${cssEscape(parentToolCallId)}"]`);
    return list.length ? list[list.length - 1] : null;
  }

  /** ChatUI 创建 task 工具行时调用：挂卡片（尚无状态时先按工具参数显示占位标题） */
  function decorateTaskBlock(block, parentToolCallId, detail) {
    if (!block || !parentToolCallId) return;
    block.classList.add('has-agent-card');
    let card = block.querySelector('.agent-card');
    if (!card) {
      card = buildCardSkeleton(parentToolCallId);
      block.appendChild(card);
    }
    const agentId = byParentCall[parentToolCallId];
    if (agentId && agents[agentId] && agents[agentId].view) {
      renderCard(card, agents[agentId]);
    } else {
      const parsed = parseTaskDetail(detail);
      card.querySelector('.agent-card__type').textContent = parsed.type;
      card.querySelector('.agent-card__desc').textContent = parsed.description;
      card.querySelector('.agent-card__meta').textContent = '准备中';
      card.setAttribute('data-status', 'queued');
      scheduleHistoryFetch();
    }
    scheduleGroupRefresh();
  }

  function mountCardsFor(state) {
    const view = state.view;
    if (!view || !view.parentToolCallId) return [];
    let cards = cardsForParentCall(view.parentToolCallId);
    if (!cards.length) {
      const block = findTaskBlock(view.parentToolCallId);
      if (block) {
        decorateTaskBlock(block, view.parentToolCallId, '');
        cards = cardsForParentCall(view.parentToolCallId);
      }
    }
    return cards;
  }

  function renderAll(state) {
    const cards = mountCardsFor(state);
    for (let i = 0; i < cards.length; i++) renderCard(cards[i], state);
    if (window.ChatAgentDrawer) window.ChatAgentDrawer.refresh(state.agentId);
  }

  function renderCard(card, state) {
    const view = state.view;
    if (!view) return;
    card.setAttribute('data-agent-id', state.agentId);
    card.setAttribute('data-status', view.interrupted ? 'failed' : view.status);
    card.querySelector('.agent-card__type').textContent = view.type || 'general';
    card.querySelector('.agent-card__desc').textContent = view.description || '';
    card.querySelector('.agent-card__meta').textContent = headMetaParts(view).join(' · ');

    const lease = card.querySelector('.agent-card__lease');
    lease.hidden = !(view.leaseRejects > 0);
    lease.textContent = view.leaseRejects > 0 ? `${view.leaseRejects} 次写入被拦截` : '';

    const stop = card.querySelector('.agent-card__stop');
    const running = view.status === 'running' || view.status === 'queued';
    stop.hidden = !running;
    if (running && stop.disabled && !stop.textContent.includes('停止中')) stop.disabled = false;
    if (!running) {
      stop.disabled = false;
      stop.textContent = '■ 停止';
    }

    const expanded = state.expanded !== null ? state.expanded : !isTerminal(view);
    card.classList.toggle('is-expanded', expanded);

    syncRows(card, state);
    renderNowLine(card, state);
    renderResult(card, state);
    if (expanded && isTerminal(view)) loadDetail(state);
    ensureTicking();
    scheduleGroupRefresh();
    notifyLayout(card);
  }

  function syncRows(card, state) {
    const UI = window.ChatUI;
    if (!UI || typeof UI.createAgentToolRowBlock !== 'function') return;
    const older = card.querySelector('.agent-card__older');
    const recent = card.querySelector('.agent-card__recent');
    const existing = {};
    const blocks = card.querySelectorAll('.agent-card__activity .tool-action-row-block');
    for (let i = 0; i < blocks.length; i++) {
      existing[blocks[i].getAttribute('data-tool-call-id') || ''] = blocks[i];
    }
    for (let r = 0; r < state.rows.length; r++) {
      const row = state.rows[r];
      let block = existing[row.toolCallId];
      if (!block) {
        block = UI.createAgentToolRowBlock(row.toolName, row.detail, row.status, row.toolCallId, row.diffSource);
        recent.appendChild(block);
      } else {
        setRowStatus(block, row.status);
      }
    }
    while (recent.children.length > RECENT_ROWS) {
      older.appendChild(recent.firstChild);
    }
    refreshOlderToggle(card);
  }

  function setRowStatus(block, status) {
    const icon = block.querySelector('.tool-icon');
    if (!icon || icon.classList.contains(status)) return;
    const UI = window.ChatUI;
    const id = block.getAttribute('data-tool-call-id') || '';
    const row = block.querySelector('.tool-action');
    if (UI && id && row) UI.updateToolActionByCallId(id, row.getAttribute('data-tool') || '', status);
  }

  function refreshOlderToggle(card) {
    const older = card.querySelector('.agent-card__older');
    const toggle = card.querySelector('.agent-card__older-toggle');
    const n = older.children.length;
    toggle.hidden = n === 0;
    toggle.textContent = older.hidden ? `还有 ${n} 条 · 展开` : '收起';
  }

  function renderNowLine(card, state) {
    const now = card.querySelector('.agent-card__now');
    const view = state.view;
    const running = view && (view.status === 'running' || view.status === 'queued');
    const text = running ? (lastSentence(state.streamText) || view.currentActivity || '') : '';
    now.textContent = text ? `… ${text}` : '';
    now.hidden = !text;
  }

  function renderResult(card, state) {
    const box = card.querySelector('.agent-card__result');
    const view = state.view;
    box.innerHTML = '';
    if (!isTerminal(view)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    fillResult(box, state, { withOpenSession: true });
  }

  /** 结果区：报告、改动文件、命令、用量、打开子会话；卡片与移动端抽屉共用 */
  function fillResult(box, state, opts) {
    const view = state.view;
    const detail = state.detail;
    const errorText = view.error || (detail && detail.statusReason) || '';
    if (errorText) box.appendChild(el('div', 'agent-card__error', errorText));

    const report = (detail && detail.report) || view.reportPreview || '';
    if (report) {
      box.appendChild(el('div', 'agent-card__section-title', '报告'));
      box.appendChild(el('div', 'agent-card__report', report));
    } else if (state.detailLoading) {
      box.appendChild(el('div', 'agent-card__muted', '正在加载报告…'));
    }

    const files = view.filesChanged || [];
    if (files.length) {
      box.appendChild(el('div', 'agent-card__section-title', `改动文件（${files.length}）`));
      const list = el('div', 'agent-card__files');
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const item = el('button', 'agent-card__file');
        item.type = 'button';
        item.appendChild(el('span', 'agent-card__file-path', f.path));
        item.appendChild(el('span', 'agent-card__file-add', `+${f.additions || 0}`));
        item.appendChild(el('span', 'agent-card__file-del', `-${f.deletions || 0}`));
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          revealFileDiff(state, f.path);
        });
        list.appendChild(item);
      }
      box.appendChild(list);
    }

    const cmds = view.commands || [];
    if (cmds.length) {
      box.appendChild(el('div', 'agent-card__section-title', `命令（${cmds.length}）`));
      const list = el('div', 'agent-card__commands');
      for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i];
        const exit = typeof c.exitCode === 'number' ? c.exitCode : null;
        const item = el('div', `agent-card__command${exit !== null && exit !== 0 ? ' is-failed' : ''}`);
        item.appendChild(el('code', 'agent-card__command-text', c.command));
        item.appendChild(el('span', 'agent-card__command-exit', exit === null ? '未结束' : `exit ${exit}`));
        list.appendChild(item);
      }
      box.appendChild(list);
    }

    const foot = el('div', 'agent-card__foot');
    foot.appendChild(el('span', 'agent-card__usage', `${view.rounds || 0} 轮 · ${formatTokens(view.tokens)} token`));
    if (opts && opts.withOpenSession) {
      const open = el('button', 'agent-card__open', '打开子会话');
      open.type = 'button';
      open.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (window.ChatAgentDrawer) window.ChatAgentDrawer.openSession(state.agentId);
      });
      foot.appendChild(open);
    }
    box.appendChild(foot);
  }

  /** 点改动文件：展开折叠的轨迹，滚到该文件最后一次写入行并展开 diff */
  function revealFileDiff(state, filePath) {
    let target = null;
    for (let i = state.rows.length - 1; i >= 0; i--) {
      const row = state.rows[i];
      if (row.detail === filePath || String(row.detail || '').endsWith(filePath)) {
        target = row;
        break;
      }
    }
    if (!target) return;
    const UI = window.ChatUI;
    const cards = cardsForParentCall(state.view && state.view.parentToolCallId);
    for (let c = 0; c < cards.length; c++) {
      const older = cards[c].querySelector('.agent-card__older');
      if (older && older.hidden) {
        older.hidden = false;
        refreshOlderToggle(cards[c]);
      }
    }
    if (UI && typeof UI.scrollToToolCall === 'function') UI.scrollToToolCall(target.toolCallId);
    const block = document.querySelector(`.tool-action-row-block[data-tool-call-id="${cssEscape(target.toolCallId)}"]`);
    const row = block && block.querySelector('.tool-action');
    if (row && block.getAttribute('data-has-diff') === '1') {
      const wrap = block.querySelector('.tool-diff-wrap');
      if (wrap && wrap.classList.contains('is-hidden')) row.click();
    }
  }

  function loadDetail(state) {
    if (state.detail || state.detailLoading) return;
    state.detailLoading = true;
    const sid = activeSessionId();
    fetch(`/api/sessions/${encodeURIComponent(sid)}/agents/${encodeURIComponent(state.agentId)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        state.detailLoading = false;
        if (body && body.agent) {
          state.detail = body.agent;
          renderAll(state);
        }
      })
      .catch(() => {
        state.detailLoading = false;
      });
  }

  // ---------------------------------------------------------------------------
  // 并行分组与计时
  // ---------------------------------------------------------------------------

  function scheduleGroupRefresh() {
    if (groupRefreshQueued) return;
    groupRefreshQueued = true;
    const run = () => {
      groupRefreshQueued = false;
      refreshGroups();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  function blockAgentState(block) {
    const card = block.querySelector('.agent-card');
    const agentId = card && card.getAttribute('data-agent-id');
    return agentId ? agents[agentId] : null;
  }

  function refreshGroups() {
    const blocks = document.querySelectorAll('.tool-action-row-block.has-agent-card');
    const seen = new Set();
    for (let i = 0; i < blocks.length; i++) {
      const first = blocks[i];
      if (seen.has(first)) continue;
      const prev = first.previousElementSibling;
      if (prev && prev.classList.contains('has-agent-card')) continue;
      const run = [first];
      let next = first.nextElementSibling;
      while (next && next.classList && next.classList.contains('has-agent-card')) {
        run.push(next);
        next = next.nextElementSibling;
      }
      for (let r = 0; r < run.length; r++) {
        seen.add(run[r]);
        run[r].classList.toggle('agent-group-member', run.length > 1);
        const head = run[r].querySelector(':scope > .agent-group-head');
        if (head && (r > 0 || run.length < 2)) head.remove();
      }
      if (run.length < 2) continue;
      let head = first.querySelector(':scope > .agent-group-head');
      if (!head) {
        head = el('div', 'agent-group-head');
        first.insertBefore(head, first.firstChild);
      }
      let runningCount = 0;
      let doneCount = 0;
      let failedCount = 0;
      for (let r = 0; r < run.length; r++) {
        const st = blockAgentState(run[r]);
        const status = st && st.view ? st.view.status : 'queued';
        if (status === 'running' || status === 'queued') runningCount++;
        else if (status === 'completed') doneCount++;
        else failedCount++;
      }
      const parts = [`并行 ${run.length} 个 Agent`];
      if (runningCount) parts.push(`${runningCount} 运行中`);
      if (doneCount) parts.push(`${doneCount} 已完成`);
      if (failedCount) parts.push(`${failedCount} 未完成`);
      head.textContent = parts.join(' · ');
    }
  }

  function hasRunningAgents() {
    for (const id in agents) {
      const v = agents[id].view;
      if (v && (v.status === 'running' || v.status === 'queued')) return true;
    }
    return false;
  }

  function ensureTicking() {
    if (tickTimer || !hasRunningAgents()) return;
    tickTimer = setInterval(() => {
      if (!hasRunningAgents()) {
        clearInterval(tickTimer);
        tickTimer = 0;
        return;
      }
      for (const id in agents) {
        const st = agents[id];
        if (!st.view || isTerminal(st.view)) continue;
        const cards = cardsForParentCall(st.view.parentToolCallId);
        for (let i = 0; i < cards.length; i++) {
          cards[i].querySelector('.agent-card__meta').textContent = headMetaParts(st.view).join(' · ');
        }
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // 数据入口
  // ---------------------------------------------------------------------------

  function applyView(view) {
    if (!view || !view.agentId) return;
    const state = ensureState(view.agentId);
    const becameTerminal = isTerminal(view) && !isTerminal(state.view);
    state.view = { ...view };
    if (becameTerminal) state.detail = null;
    if (view.parentToolCallId) byParentCall[view.parentToolCallId] = view.agentId;
    renderAll(state);
  }

  function upsertRow(state, row) {
    for (let i = state.rows.length - 1; i >= 0; i--) {
      if (state.rows[i].toolCallId === row.toolCallId) {
        state.rows[i] = { ...state.rows[i], ...row };
        return;
      }
    }
    state.rows.push(row);
    if (state.rows.length > ROWS_MAX) state.rows.splice(0, state.rows.length - ROWS_MAX);
  }

  /** 带 agentId 的 tool_call：新增一行 */
  function onAgentToolCall(step, detail, status, diffSource) {
    const state = ensureState(step.agentId);
    upsertRow(state, {
      toolName: step.toolName,
      detail: detail || '',
      status: status || 'pending',
      toolCallId: step.toolCallId || '',
      diffSource: diffSource || null,
    });
    state.streamText = '';
    if (state.view) renderAll(state);
  }

  /** 带 agentId 的 tool_result：更新行状态 */
  function onAgentToolResult(step, status) {
    const state = ensureState(step.agentId);
    for (let i = state.rows.length - 1; i >= 0; i--) {
      if (state.rows[i].toolCallId === step.toolCallId) {
        state.rows[i].status = status;
        break;
      }
    }
    if (state.view) renderAll(state);
  }

  function onAgentStream(data) {
    if (!data || !data.agentId) return;
    const state = ensureState(data.agentId);
    if (data.kind === 'discard') {
      state.streamText = '';
    } else if (data.kind === 'text' || data.kind === 'reasoning') {
      state.streamText = (state.streamText + (data.delta || '')).slice(-STREAM_MAX_CHARS);
    }
    const view = state.view;
    if (!view) return;
    const cards = cardsForParentCall(view.parentToolCallId);
    for (let i = 0; i < cards.length; i++) renderNowLine(cards[i], state);
    if (window.ChatAgentDrawer) window.ChatAgentDrawer.refreshStream(state.agentId);
  }

  function onStopResult(data) {
    if (!data || data.ok !== false) return;
    const state = agents[data.agentId];
    if (!state || !state.view) return;
    const cards = cardsForParentCall(state.view.parentToolCallId);
    for (let i = 0; i < cards.length; i++) {
      const btn = cards[i].querySelector('.agent-card__stop');
      btn.disabled = false;
      btn.textContent = '■ 停止';
    }
    if (window.Notification && typeof window.Notification.show === 'function') {
      window.Notification.show(data.error || '停止子 Agent 失败', 'error');
    }
  }

  /** 运行中快照：刷新 / 扫码 / 重连后恢复卡片 */
  function restoreFromSnapshot(snapshotAgents) {
    if (!snapshotAgents || typeof snapshotAgents !== 'object') return;
    const ids = Object.keys(snapshotAgents);
    for (let i = 0; i < ids.length; i++) {
      const snap = snapshotAgents[ids[i]];
      if (!snap || !snap.view) continue;
      const state = ensureState(ids[i]);
      const rows = Array.isArray(snap.toolTimeline) ? snap.toolTimeline : [];
      state.rows = rows.map((r) => ({
        toolName: r.toolName || '',
        detail: r.detail || '',
        status: r.status || 'pending',
        toolCallId: r.toolCallId || '',
        diffSource: r.diffSource || null,
      }));
      state.streamText = snap.streamingText || '';
      applyView(snap.view);
    }
  }

  /** 历史 tool_trace 中带 agentId 的条目：只在没有更实时的数据时采用 */
  function setHistoryTraces(map) {
    const ids = Object.keys(map || {});
    for (let i = 0; i < ids.length; i++) {
      const state = ensureState(ids[i]);
      const live = state.view && !isTerminal(state.view);
      if (live && state.rows.length) continue;
      if (state.rows.length > map[ids[i]].length) continue;
      state.rows = map[ids[i]].slice(-ROWS_MAX);
      if (state.view) renderAll(state);
    }
  }

  function scheduleHistoryFetch() {
    const sid = activeSessionId();
    const now = Date.now();
    if (historyFetch.pending) return;
    if (historyFetch.sid === sid && now - historyFetch.at < HISTORY_REFETCH_GAP_MS) return;
    historyFetch = { sid, at: now, pending: true };
    setTimeout(() => {
      fetch(`/api/sessions/${encodeURIComponent(sid)}/agents`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          historyFetch.pending = false;
          historyFetch.at = Date.now();
          if (!body || !Array.isArray(body.agents) || sid !== activeSessionId()) return;
          for (let i = 0; i < body.agents.length; i++) {
            const view = body.agents[i];
            const state = ensureState(view.agentId);
            const liveNewer = state.view && !isTerminal(state.view) && isTerminal(view) === false;
            if (liveNewer) continue;
            applyView(view);
          }
        })
        .catch(() => {
          historyFetch.pending = false;
        });
    }, 0);
  }

  /** 会话切换：清掉上一会话的卡片状态 */
  function reset() {
    for (const id in agents) delete agents[id];
    for (const k in byParentCall) delete byParentCall[k];
    historyFetch = { sid: '', at: 0, pending: false };
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }
    if (window.ChatAgentDrawer) window.ChatAgentDrawer.close();
  }

  function getState(agentId) {
    return agents[agentId] || null;
  }

  function ensureDetail(agentId) {
    const state = agents[agentId];
    if (state) loadDetail(state);
  }

  function findByDescription(description) {
    for (const id in agents) {
      if (agents[id].view && agents[id].view.description === description) return agents[id];
    }
    return null;
  }

  return {
    decorateTaskBlock,
    applyView,
    onAgentToolCall,
    onAgentToolResult,
    onAgentStream,
    onStopResult,
    restoreFromSnapshot,
    setHistoryTraces,
    reset,
    getState,
    ensureDetail,
    findByDescription,
    fillResult,
    headMetaParts,
    lastSentence,
    isTerminal,
    requestStop,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatAgentCards = ChatAgentCards;
}
