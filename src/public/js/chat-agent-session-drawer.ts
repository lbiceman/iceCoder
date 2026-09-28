// @ts-nocheck
/**
 * 子 Agent 抽屉：
 * - openCard(agentId)：移动端点卡片标题后，以底部抽屉展示活动与结果
 * - openSession(agentId)：只读查看子 Agent 的完整对话与工具调用；桌面端侧边抽屉，移动端全屏
 *
 * 运行中的子 Agent 还没有落盘的对话，展示卡片状态里的实时工具轨迹与流式输出；
 * 结束后从 GET /api/sessions/:id/agents/:agentId/messages 读取完整对话。
 * 依赖：window.ChatAgentCards、window.ChatSession。
 * 暴露：window.ChatAgentDrawer。
 */

/* exported ChatAgentDrawer */

export const ChatAgentDrawer = (() => {
  const TOOL_OUTPUT_PREVIEW_CHARS = 4000;

  let root = null;
  let current = { agentId: '', mode: '', messages: null, loading: false, error: '' };

  function activeSessionId() {
    const S = window.ChatSession;
    return (S && S.getActiveId && S.getActiveId()) || 'default';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function cards() {
    return window.ChatAgentCards || null;
  }

  function ensureRoot() {
    if (root) return root;
    root = el('div', 'agent-drawer');
    root.hidden = true;
    const backdrop = el('div', 'agent-drawer__backdrop');
    backdrop.addEventListener('click', close);
    const panel = el('aside', 'agent-drawer__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const header = el('header', 'agent-drawer__header');
    header.appendChild(el('span', 'agent-card__type agent-drawer__type'));
    header.appendChild(el('span', 'agent-drawer__title'));
    const closeBtn = el('button', 'agent-drawer__close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    const meta = el('div', 'agent-drawer__meta');
    const body = el('div', 'agent-drawer__body');
    panel.appendChild(header);
    panel.appendChild(meta);
    panel.appendChild(body);
    root.appendChild(backdrop);
    root.appendChild(panel);
    document.body.appendChild(root);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && root && !root.hidden) close();
    });
    return root;
  }

  function open(agentId, mode) {
    const C = cards();
    const state = C && C.getState(agentId);
    if (!state || !state.view) return;
    ensureRoot();
    current = { agentId, mode, messages: null, loading: false, error: '' };
    root.setAttribute('data-mode', mode);
    root.hidden = false;
    document.documentElement.classList.add('agent-drawer-open');
    render();
    if (mode === 'session') {
      C.ensureDetail(agentId);
      loadMessages(agentId);
    }
  }

  function openCard(agentId) {
    open(agentId, 'card');
  }

  function openSession(agentId) {
    open(agentId, 'session');
  }

  function close() {
    if (!root) return;
    root.hidden = true;
    current = { agentId: '', mode: '', messages: null, loading: false, error: '' };
    document.documentElement.classList.remove('agent-drawer-open');
  }

  function loadMessages(agentId) {
    const C = cards();
    const state = C && C.getState(agentId);
    if (!state || !C.isTerminal(state.view)) return;
    current.loading = true;
    const sid = activeSessionId();
    fetch(`/api/sessions/${encodeURIComponent(sid)}/agents/${encodeURIComponent(agentId)}/messages`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body) => {
        if (current.agentId !== agentId) return;
        current.loading = false;
        current.messages = Array.isArray(body.messages) ? body.messages : [];
        render();
      })
      .catch((err) => {
        if (current.agentId !== agentId) return;
        current.loading = false;
        current.error = err && err.message ? err.message : '加载失败';
        render();
      });
    render();
  }

  function render() {
    if (!root || root.hidden) return;
    const C = cards();
    const state = C && C.getState(current.agentId);
    if (!state || !state.view) return;
    const view = state.view;
    root.querySelector('.agent-drawer__type').textContent = view.type || 'general';
    root.querySelector('.agent-drawer__title').textContent = view.description || '';
    const meta = root.querySelector('.agent-drawer__meta');
    meta.innerHTML = '';
    meta.appendChild(el('span', '', C.headMetaParts(view).join(' · ')));
    if (view.leaseRejects > 0) meta.appendChild(el('span', 'agent-card__lease', `${view.leaseRejects} 次写入被拦截`));
    if (!C.isTerminal(view)) {
      const stop = el('button', 'agent-card__stop', '■ 停止');
      stop.type = 'button';
      stop.addEventListener('click', () => C.requestStop(view.agentId, stop));
      meta.appendChild(stop);
    }

    const body = root.querySelector('.agent-drawer__body');
    body.innerHTML = '';
    if (current.mode === 'card') {
      renderCardBody(body, state);
    } else {
      renderSessionBody(body, state);
    }
  }

  function renderRows(parent, rows) {
    if (!rows.length) {
      parent.appendChild(el('div', 'agent-card__muted', '还没有工具调用'));
      return;
    }
    const list = el('div', 'agent-drawer__rows');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = el('div', `agent-drawer__row is-${r.status || 'pending'}`);
      line.appendChild(el('span', 'agent-drawer__row-name', r.toolName));
      line.appendChild(el('span', 'agent-drawer__row-detail', r.detail || ''));
      list.appendChild(line);
    }
    parent.appendChild(list);
  }

  function renderLiveStream(parent, state) {
    const now = el('div', 'agent-drawer__stream');
    now.textContent = state.streamText || '';
    now.hidden = !state.streamText;
    parent.appendChild(now);
  }

  function renderCardBody(body, state) {
    const C = cards();
    body.appendChild(el('div', 'agent-card__section-title', `工具轨迹（${state.rows.length}）`));
    renderRows(body, state.rows);
    if (!C.isTerminal(state.view)) {
      renderLiveStream(body, state);
      return;
    }
    const result = el('div', 'agent-card__result');
    C.fillResult(result, state, { withOpenSession: false });
    body.appendChild(result);
    const open = el('button', 'agent-card__open', '打开子会话');
    open.type = 'button';
    open.addEventListener('click', () => openSession(state.agentId));
    body.appendChild(open);
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block && block.type === 'image') parts.push('[图片]');
    }
    return parts.join('\n');
  }

  function argsPreview(args) {
    if (!args || typeof args !== 'object') return '';
    const direct = args.path || args.file || args.command || args.query || args.pattern;
    if (typeof direct === 'string') return direct;
    try {
      const s = JSON.stringify(args);
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    } catch (_e) {
      return '';
    }
  }

  function renderSessionBody(body, state) {
    const C = cards();
    const detail = state.detail;
    if (detail && detail.prompt) {
      const task = el('details', 'agent-drawer__prompt');
      task.appendChild(el('summary', '', '任务说明'));
      task.appendChild(el('div', 'agent-drawer__text', detail.prompt));
      body.appendChild(task);
    }

    if (!C.isTerminal(state.view)) {
      body.appendChild(el('div', 'agent-card__muted', '子 Agent 运行中，完整对话在结束后可查看。以下为实时工具轨迹：'));
      renderRows(body, state.rows);
      renderLiveStream(body, state);
      return;
    }
    if (current.loading) {
      body.appendChild(el('div', 'agent-card__muted', '正在加载子会话…'));
      return;
    }
    if (current.error) {
      body.appendChild(el('div', 'agent-card__error', `子会话加载失败：${current.error}`));
      return;
    }
    const messages = current.messages || [];
    if (!messages.length) {
      body.appendChild(el('div', 'agent-card__muted', '没有找到子会话记录'));
      return;
    }
    const list = el('div', 'agent-drawer__messages');
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role === 'system') continue;
      if (m.role === 'user') {
        const item = el('div', 'agent-drawer__msg is-user');
        item.appendChild(el('div', 'agent-drawer__role', '任务'));
        item.appendChild(el('div', 'agent-drawer__text', textOf(m.content)));
        list.appendChild(item);
      } else if (m.role === 'assistant') {
        const text = textOf(m.content);
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (!text.trim() && !calls.length) continue;
        const item = el('div', 'agent-drawer__msg is-assistant');
        item.appendChild(el('div', 'agent-drawer__role', '子 Agent'));
        if (text.trim()) item.appendChild(el('div', 'agent-drawer__text', text));
        for (let c = 0; c < calls.length; c++) {
          const call = el('div', 'agent-drawer__call');
          call.appendChild(el('span', 'agent-drawer__row-name', calls[c].name));
          call.appendChild(el('span', 'agent-drawer__row-detail', argsPreview(calls[c].arguments)));
          item.appendChild(call);
        }
        list.appendChild(item);
      } else if (m.role === 'tool') {
        const out = textOf(m.content);
        const item = el('details', 'agent-drawer__msg is-tool');
        item.appendChild(el('summary', '', `工具结果 · ${out.length} 字符`));
        item.appendChild(el('pre', 'agent-drawer__tool-output',
          out.length > TOOL_OUTPUT_PREVIEW_CHARS ? `${out.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)}\n…（已截断）` : out));
        list.appendChild(item);
      }
    }
    body.appendChild(list);
  }

  /** 卡片状态变化时调用 */
  function refresh(agentId) {
    if (!root || root.hidden || current.agentId !== agentId) return;
    const C = cards();
    const state = C && C.getState(agentId);
    if (current.mode === 'session' && state && C.isTerminal(state.view) && !current.messages && !current.loading) {
      loadMessages(agentId);
      return;
    }
    render();
  }

  function refreshStream(agentId) {
    if (!root || root.hidden || current.agentId !== agentId) return;
    const C = cards();
    const state = C && C.getState(agentId);
    const node = root.querySelector('.agent-drawer__stream');
    if (!node || !state) return;
    node.textContent = state.streamText || '';
    node.hidden = !state.streamText;
  }

  return { openCard, openSession, close, refresh, refreshStream };
})();

if (typeof window !== 'undefined') {
  window.ChatAgentDrawer = ChatAgentDrawer;
}
