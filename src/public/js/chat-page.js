/**
 * 聊天页面模块。
 * 渲染聊天界面，包含消息输入、文件上传与 WebSocket 流式回复。
 */

/* exported ChatPage */

window.ChatPage = (function () {
  'use strict';

  // ---- Constants ----
  /** 超过此数量时折叠更早的工具行；始终保留最新的若干条可见 */
  var TOOL_TRACE_VISIBLE_MAX = 3;

  var SUPPORTED_EXTENSIONS = []; // 不限制，允许所有格式
  var supportedPattern = null;

  // ---- localStorage keys ----
  var STORAGE_KEY_MESSAGES = 'ice-chat-messages';

  // ---- State ----
  var container = null;
  var messages = [];       // { role: 'user'|'agent', content: string, images?: string[] }
  var uploadedFile = null; // { fileId, filename, size } or null
  var pendingImages = [];  // 待发送的图片 { dataUrl, file } 列表
  var streamReplyBuffer = ''; // accumulates streaming chunks
  var isStreaming = false;      // 是否正在流式传输
  var userStopped = false;      // 用户是否已点击停止（忽略后续 stream 消息）
  var streamFinalized = false;  // 标记刚刚 finalize 了流式消息（用于跳过冗余 response）

  // ---- 工具调用记录（服务端持久化，通过 parentId 关联到助手侧消息） ----
  // toolTraces: { [assistantMsgId]: [{ toolName, detail, status }] }
  var toolTraces = {};
  var currentToolBatch = [];    // 当前轮次收集的工具调用，等助手消息 id 从服务端同步后关联

  /** 本轮对话实时工具区（WS）：更早的进折叠区，保留最新 TOOL_TRACE_VISIBLE_MAX 条 */
  var liveToolRoundActive = false;
  var liveToolRoundRoot = null;
  var liveToolRoundVisible = null;
  var liveToolRoundCollapsed = null;
  var liveToolRoundToggle = null;
  var liveToolRoundCount = 0;

  // ---- 远程模式（仅控制 UI 差异，通信方式统一用 WebSocket） ----
  var remoteMode = false;       // 是否为远程控制模式（带 token）
  var remoteToken = null;       // 远程 token（移动端扫码用）

  // ---- WebSocket（PC 和移动端统一） ----
  var chatWs = null;            // WebSocket 连接
  var wsProcessing = false;     // 是否正在处理消息
  /** 最近一次工具执行阶段提示（与 pulse 心跳一起刷新状态栏） */
  var lastToolProgressHint = '';
  var wsReconnectTimer = null;
  var wsReconnectAttempts = 0;
  var wsHeartbeatTimer = null;
  var wsSyncTimer = null;       // 定期轮询同步
  var wsConnectTimeout = null;

  /** 上次已成功应用的服务端会话快照签名（避免 sync 轮询无意义全量重绘） */
  var lastSessionSyncSig = '';

  // ---- 上下文用量跟踪 ----
  var maxContextTokens = 0;     // 当前模型最大上下文（/api/config 默认 provider）
  /** 用于进度条：最近一轮 LLM 请求的 inputTokens（≈该轮上下文占用），非多轮累计 */
  var usedInputTokens = 0;
  var usedOutputTokens = 0;     // 累计输出 token
  var modelName = '';            // 当前模型名称

  // ---- 消息持久化（单会话，固定 ID） ----

  var SESSION_ID = 'default';

  /**
   * 移除模型按记忆/系统要求在末尾输出的 <status>…</status>（不向用户展示）。
   */
  function stripStatusTag(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/<status>\s*(?:complete|incomplete)\s*<\/status>/gi, '')
      .replace(/\s*$/, '');
  }

  /** 序列化单条消息写入 localStorage（保留 id 以便刷新后挂载 tool_trace） */
  function serializeMessageForStorage(m) {
    var c = m.content;
    if (m.role === 'agent' && typeof c === 'string') c = stripStatusTag(c);
    var o = { role: m.role, content: c };
    if (m.id) o.id = m.id;
    return o;
  }

  /** 规范化本地缓存条目（忽略未知 role / 损坏项） */
  function normalizeStoredMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var role = raw.role;
    if (role !== 'user' && role !== 'agent') return null;
    var rawContent = typeof raw.content === 'string' ? raw.content : '';
    var content = role === 'agent' ? stripStatusTag(rawContent) : rawContent;
    var o = { role: role, content: content };
    if (raw.id) o.id = raw.id;
    return o;
  }

  /** 保存消息到本地缓存（服务端由后端统一写入） */
  function saveSessionMessages() {
    var toSave = messages.map(function (m) { return serializeMessageForStorage(m); });
    try {
      localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(toSave));
    } catch (_e) { /* ignore */ }
  }

  /** 从本地缓存加载消息（同步） */
  function loadLocalMessages() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY_MESSAGES);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];
        var out = [];
        for (var i = 0; i < parsed.length; i++) {
          var n = normalizeStoredMessage(parsed[i]);
          if (n) out.push(n);
        }
        return out;
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  /** 从服务端加载消息（异步） */
  function fetchServerMessages(callback) {
    var url = '/api/sessions/' + SESSION_ID + '?_t=' + Date.now();
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var msgs = (data.messages && data.messages.length > 0) ? data.messages : [];
        if (callback) callback(msgs);
      })
      .catch(function () {
        if (callback) callback([]);
      });
  }

  /** 当前是否有一条正在流式输出的助手消息（勿全量重绘，否则会删掉 #streaming-msg） */
  function hasStreamingModelBubble() {
    var last = messages[messages.length - 1];
    return !!(last && last.role === 'agent' && last._streaming);
  }

  /** 初始化：从本地缓存加载，再从服务端同步 */
  function initSession() {
    messages = loadLocalMessages();
    toolTraces = {};
    renderMessages();
    // 异步从服务端拉取最新消息（含 tool_trace）
    fetchServerMessages(function (serverMsgs) {
      if (serverMsgs.length === 0) return;
      var separated = separateToolTraces(serverMsgs);
      applyServerChatSnapshot(separated, { fullRender: true, authoritative: true });
    });
  }

  // ---- 持久化 ----

  function saveMessages() {
    saveSessionMessages();
  }

  function loadMessages() {
    return loadLocalMessages();
  }

  function clearMessages() {
    messages = [];
    pendingImages = [];
    toolTraces = {};
    currentToolBatch = [];
    lastSessionSyncSig = '';
    saveMessages();
    // 通知后端清除消息缓存，下一轮从零构建
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'clear_session' }));
    }
    renderPendingImages();
  }

  /**
   * 从服务端消息数组中分离出 tool_trace 条目，构建 toolTraces 映射。
   * 返回过滤后的纯消息数组（不含 tool_trace）。
   */
  function separateToolTraces(serverMsgs) {
    var msgs = [];
    var traces = {};
    for (var i = 0; i < serverMsgs.length; i++) {
      var m = serverMsgs[i];
      if (m.role === 'tool_trace' && m.parentId) {
        if (!traces[m.parentId]) traces[m.parentId] = [];
        traces[m.parentId].push({ toolName: m.toolName || '', detail: m.detail || '', status: m.status || 'pending' });
      } else {
        var cloned = Object.assign({}, m);
        if ((m.role === 'agent' || m.role === 'assistant') && typeof m.content === 'string') {
          cloned.content = stripStatusTag(m.content);
        }
        msgs.push(cloned);
      }
    }
    return { msgs: msgs, traces: traces };
  }

  function snapshotTraceTotals(tr) {
    var keys = Object.keys(tr || {}).sort();
    if (!keys.length) return '';
    return keys.map(function (k) { return k + '=' + tr[k].length; }).join(';');
  }

  /** 服务端会话快照签名（条数 + 各条 id + tool_trace 体量），用于跳过重复 apply */
  function sessionPayloadSig(separated) {
    var ids = separated.msgs.map(function (m) { return m.id || ''; }).join(',');
    return separated.msgs.length + '|' + ids + '|' + snapshotTraceTotals(separated.traces);
  }

  /**
   * 用服务端分离后的会话覆盖本地 messages + toolTraces。
   * opts.authoritative：冷启动/应以服务端为准（忽略本地多出来的仅前端消息，如 memory_notice、confirm）
   * @returns {boolean} 是否发生了更新（含渲染）
   */
  function applyServerChatSnapshot(separated, options) {
    var opts = options || {};
    if (hasStreamingModelBubble() || wsProcessing || isStreaming) return false;
    if (!opts.authoritative && separated.msgs.length < messages.length) return false;

    var sig = sessionPayloadSig(separated);
    if (sig === lastSessionSyncSig && separated.msgs.length === messages.length) {
      return false;
    }

    var wasNearBottom = isNearBottom();
    messages = separated.msgs;
    toolTraces = separated.traces;
    lastSessionSyncSig = sig;

    if (opts.fullRender) {
      renderMessages();
    } else {
      renderMessagesOnly(wasNearBottom);
      saveSessionMessages();
    }
    return true;
  }

  /** 将当前收集的工具调用批次暂存（等助手消息的 id 从服务端同步后关联） */
  function flushToolBatchLocal() {
    // 工具调用记录已由后端持久化，前端只需清空当前批次
    // 下次 syncMessages 时会从服务端拉到完整的 tool_trace
    currentToolBatch = [];
  }

  // ---- DOM refs (set during render) ----
  var elMessages, elAnchor, elInput, elSendBtn, elFileBtn, elFileInput;
  var elFileStatus, elFileName, elFileRemove;
  var elStatusBar, elStatusTurn;
  /** 会话宠物指示器（见 session-pet.js） */
  var sessionPet = null;

  // ---- 辅助函数 ----

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /**
   * 从后端获取 FileParser 支持的文件格式列表（仅用于信息展示，不限制上传）。
   */
  function fetchSupportedFormats() {
    fetch('/api/chat/supported-formats')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.extensions && data.extensions.length > 0) {
          SUPPORTED_EXTENSIONS = data.extensions;
        }
      })
      .catch(function () { /* ignore */ });
  }

  function scrollToBottom() {
    if (elMessages) {
      elMessages.scrollTop = elMessages.scrollHeight;
    }
  }

  /** 判断用户是否在聊天底部附近（150px 阈值） */
  function isNearBottom() {
    if (!elMessages) return true;
    var threshold = 150;
    return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < threshold;
  }

  // ---- 状态指示器（输入区上方状态栏） ----

  var currentTurnCount = 0;
  /** 从发送后到 removeThinking 前视为「工作台会话」，允许气泡与 pulse 刷新 */
  var petUiSessionActive = false;

  function showThinking(withFile) {
    currentTurnCount = 0;
    petUiSessionActive = true;
    if (!sessionPet) return;
    sessionPet.setVisible(true);
    sessionPet.setState('thinking');
    sessionPet.setTurnLabel('');
    sessionPet.setBubbleText(withFile ? '解析文件中…' : '');
  }

  function updateTurnCounter(turn) {
    if (turn > currentTurnCount) {
      currentTurnCount = turn;
    }
    if (sessionPet) {
      sessionPet.setTurnLabel(
        petUiSessionActive || wsProcessing || isStreaming
          ? currentTurnCount
            ? '第 ' + currentTurnCount + ' 轮'
            : ''
          : '',
      );
    }
  }

  function removeThinking() {
    currentTurnCount = 0;
    lastToolProgressHint = '';
    petUiSessionActive = false;
    if (!sessionPet) return;
    sessionPet.setState('idle');
    sessionPet.setBubbleText('');
    sessionPet.setTurnLabel('');
  }

  /** 仅在工作台前会话中更新气泡（工具进度、心跳等） */
  function updateStatusText(text) {
    if (!sessionPet) return;
    if (!petUiSessionActive && !wsProcessing && !isStreaming) return;
    sessionPet.setBubbleText(text || '');
  }

  /**
   * 将 Harness step 映射到会话宠物表情 + 气泡（工作台会话中会显示气泡文案）。
   */
  function applyHarnessStepToPet(step) {
    if (!sessionPet || !step) return;

    function recoverThinkingOrIdle() {
      sessionPet.setState(isStreaming || wsProcessing ? 'thinking' : 'idle');
    }

    /** 有字时仅在工作/流式中展示；传 '' 则总是清空气泡 */
    function bubble(txt) {
      if (txt === undefined || txt === null) return;
      if (txt === '') {
        sessionPet.setBubbleText('');
        return;
      }
      if (!petUiSessionActive && !wsProcessing && !isStreaming) return;
      sessionPet.setBubbleText(String(txt));
    }

    switch (step.type) {
      case 'thinking':
        sessionPet.setState('thinking');
        if (step.content) bubble(step.content);
        break;
      case 'tool_call':
        sessionPet.setState('working');
        {
          var toolHint = step.toolName || '';
          if (step.toolArgs) {
            var argHint =
              step.toolArgs.path ||
              step.toolArgs.file ||
              step.toolArgs.command ||
              step.toolArgs.query ||
              '';
            if (argHint) toolHint = (toolHint ? toolHint + ' · ' : '') + argHint;
          }
          bubble(step.content || toolHint || '调用工具…');
        }
        break;
      case 'tool_result':
        if (step.toolSuccess === false) {
          sessionPet.setState('confused');
          bubble(step.toolError || step.content || '工具失败');
        } else {
          recoverThinkingOrIdle();
          var okMsg = lastToolProgressHint || step.content;
          if (okMsg) bubble(okMsg);
        }
        break;
      case 'tool_denied':
        sessionPet.setState('alert');
        bubble(step.content || '已拒绝工具');
        break;
      case 'tool_confirm':
        sessionPet.setState('alert');
        bubble(step.content || '待确认');
        break;
      case 'tool_progress':
        sessionPet.setState('working');
        bubble(step.content || '');
        break;
      case 'compaction':
        sessionPet.setState('thinking');
        bubble(step.content || '整理上下文中…');
        break;
      case 'final':
        if (step.stopReason === 'error' || step.stopReason === 'circuit_breaker') {
          sessionPet.setState('confused');
          bubble(step.content || '出错了');
        } else if (step.stopReason === 'user_abort') {
          recoverThinkingOrIdle();
          sessionPet.setBubbleText('');
        } else {
          sessionPet.setState('happy');
          if (step.content) bubble(step.content);
        }
        break;
      case 'stream_delta':
        sessionPet.setState('thinking');
        break;
      case 'tool_output':
        break;
      case 'memory_event':
        {
          var mk = step.memoryKind;
          if (mk === 'recall_hit' || mk === 'recall_coarse_hit') {
            sessionPet.setState('happy');
          } else if (mk === 'recall_empty' || mk === 'recall_skipped') {
            recoverThinkingOrIdle();
          } else if (mk === 'session_hydrate') {
            sessionPet.setState('idle');
          } else {
            recoverThinkingOrIdle();
          }
          if (step.memoryDetail) bubble(step.memoryDetail);
        }
        break;
      default:
        break;
    }
  }

  function resetLiveToolRoundTargets() {
    liveToolRoundRoot = null;
    liveToolRoundVisible = null;
    liveToolRoundCollapsed = null;
    liveToolRoundToggle = null;
    liveToolRoundCount = 0;
  }

  /** 创建单行工具 DOM（历史 / 实时共用） */
  function createToolActionRow(toolName, detail, status) {
    var el = document.createElement('div');
    el.className = 'tool-action';
    el.setAttribute('data-tool', toolName);

    var iconEl = document.createElement('span');
    iconEl.className = 'tool-icon ' + (status || 'pending');
    if (status === 'success') {
      iconEl.textContent = '✓';
    } else if (status === 'error') {
      iconEl.textContent = '✗';
    } else {
      iconEl.textContent = '⟳';
    }
    el.appendChild(iconEl);

    var nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = toolName;
    el.appendChild(nameEl);

    if (detail) {
      var detailEl = document.createElement('span');
      detailEl.className = 'tool-detail';
      detailEl.textContent = detail;
      el.appendChild(detailEl);
    }
    return el;
  }

  function bindToolTraceToggle(btn, collapsedEl) {
    btn.addEventListener('click', function () {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        collapsedEl.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '还有 ' + collapsedEl.children.length + ' 条历史 · 展开';
      } else {
        collapsedEl.style.display = '';
        btn.setAttribute('aria-expanded', 'true');
        btn.textContent = '收起';
      }
    });
    btn.setAttribute('aria-expanded', 'false');
  }

  function refreshCollapsedToggleLabel(btn, collapsedEl) {
    if (!btn || !collapsedEl || collapsedEl.children.length === 0) return;
    if (btn.getAttribute('aria-expanded') === 'true') {
      btn.textContent = '收起';
    } else {
      btn.textContent = '还有 ' + collapsedEl.children.length + ' 条历史 · 展开';
    }
  }

  /** 历史恢复：插入可折叠工具组（插在 insertBefore 节点前）；默认展示最新若干条，更早的折叠 */
  function insertFoldableToolTraceGroup(traces, insertBeforeNode) {
    if (!elMessages || !traces || traces.length === 0) return;

    var wrap = document.createElement('div');
    wrap.className = 'tool-trace-group';
    var visible = document.createElement('div');
    visible.className = 'tool-trace-visible';

    var max = TOOL_TRACE_VISIBLE_MAX;
    var i;
    if (traces.length <= max) {
      for (i = 0; i < traces.length; i++) {
        var tr = traces[i];
        visible.appendChild(createToolActionRow(tr.toolName || '', tr.detail || '', tr.status || 'pending'));
      }
      wrap.appendChild(visible);
      elMessages.insertBefore(wrap, insertBeforeNode);
      return;
    }

    var olderCount = traces.length - max;
    var collapsed = document.createElement('div');
    collapsed.className = 'tool-trace-collapsed';
    collapsed.style.display = 'none';
    for (var j = 0; j < olderCount; j++) {
      var tOld = traces[j];
      collapsed.appendChild(createToolActionRow(tOld.toolName || '', tOld.detail || '', tOld.status || 'pending'));
    }
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-trace-toggle';
    toggle.textContent = '还有 ' + olderCount + ' 条历史 · 展开';
    bindToolTraceToggle(toggle, collapsed);

    for (var k = olderCount; k < traces.length; k++) {
      var tNew = traces[k];
      visible.appendChild(createToolActionRow(tNew.toolName || '', tNew.detail || '', tNew.status || 'pending'));
    }

    wrap.appendChild(collapsed);
    wrap.appendChild(toggle);
    wrap.appendChild(visible);
    elMessages.insertBefore(wrap, insertBeforeNode);
  }

  function ensureLiveToolGroupDom() {
    if (liveToolRoundRoot) return;
    liveToolRoundRoot = document.createElement('div');
    liveToolRoundRoot.className = 'tool-trace-group';
    liveToolRoundCollapsed = document.createElement('div');
    liveToolRoundCollapsed.className = 'tool-trace-collapsed';
    liveToolRoundCollapsed.style.display = 'none';
    liveToolRoundToggle = document.createElement('button');
    liveToolRoundToggle.type = 'button';
    liveToolRoundToggle.className = 'tool-trace-toggle';
    liveToolRoundToggle.style.display = 'none';
    liveToolRoundVisible = document.createElement('div');
    liveToolRoundVisible.className = 'tool-trace-visible';
    liveToolRoundRoot.appendChild(liveToolRoundCollapsed);
    liveToolRoundRoot.appendChild(liveToolRoundToggle);
    liveToolRoundRoot.appendChild(liveToolRoundVisible);
    bindToolTraceToggle(liveToolRoundToggle, liveToolRoundCollapsed);
    elMessages.insertBefore(liveToolRoundRoot, elAnchor);
  }

  /** 在聊天区追加工具调用条目（紧凑行）；实时轮次超阈值时折叠更早记录 */
  function appendToolAction(toolName, detail, status) {
    if (!elMessages) return null;

    var row = createToolActionRow(toolName, detail, status);

    if (liveToolRoundActive) {
      ensureLiveToolGroupDom();
      liveToolRoundCount++;
      liveToolRoundVisible.appendChild(row);
      while (liveToolRoundVisible.children.length > TOOL_TRACE_VISIBLE_MAX) {
        var oldest = liveToolRoundVisible.firstChild;
        if (oldest) liveToolRoundCollapsed.appendChild(oldest);
      }
      if (liveToolRoundCollapsed.children.length > 0) {
        liveToolRoundToggle.style.display = '';
        refreshCollapsedToggleLabel(liveToolRoundToggle, liveToolRoundCollapsed);
      }
      return row;
    }

    elMessages.insertBefore(row, elAnchor);
    return row;
  }

  /** 更新最后一个匹配工具名的条目状态（支持 .tool-trace-group 内） */
  function updateLastToolAction(toolName, status) {
    if (!elMessages) return;
    var node = elAnchor ? elAnchor.previousSibling : elMessages.lastChild;
    while (node) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-trace-group')) {
        var rows = node.querySelectorAll('.tool-action');
        for (var r = rows.length - 1; r >= 0; r--) {
          if (rows[r].getAttribute('data-tool') === toolName) {
            var iconEl = rows[r].querySelector('.tool-icon');
            if (iconEl) {
              iconEl.className = 'tool-icon ' + status;
              iconEl.textContent = status === 'success' ? '✓' : status === 'error' ? '✗' : '⟳';
            }
            return;
          }
        }
      }
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-action') && node.getAttribute('data-tool') === toolName) {
        var iconEl2 = node.querySelector('.tool-icon');
        if (iconEl2) {
          iconEl2.className = 'tool-icon ' + status;
          iconEl2.textContent = status === 'success' ? '✓' : status === 'error' ? '✗' : '⟳';
        }
        return;
      }
      node = node.previousSibling;
    }
  }

  // ---- 渲染 ----

  /** 渲染消息到 DOM（不触发保存，用于只读同步） */
  function renderMessagesOnly(shouldScroll) {
    liveToolRoundActive = false;
    resetLiveToolRoundTargets();

    // 保留锚点，清除其他内容
    while (elMessages.firstChild !== elAnchor) {
      elMessages.removeChild(elMessages.firstChild);
    }
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];

      // 在助手消息前渲染关联的工具调用记录（通过 msg.id 查找）
      var traces = msg.id ? toolTraces[msg.id] : null;
      if (traces && traces.length > 0) {
        insertFoldableToolTraceGroup(traces, elAnchor);
      }

      var el = document.createElement('div');
      el.className = 'message ' + msg.role;

      var label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = msg.role === 'user' ? 'You' : 'Assistant';
      el.appendChild(label);

      // 渲染图片缩略图（如果有）
      if (msg.images && msg.images.length > 0) {
        var imgRow = document.createElement('div');
        imgRow.className = 'msg-images';
        for (var j = 0; j < msg.images.length; j++) {
          var img = document.createElement('img');
          img.src = msg.images[j];
          img.className = 'msg-image-thumb';
          img.alt = '图片 ' + (j + 1);
          imgRow.appendChild(img);
        }
        el.appendChild(imgRow);
      }

      var content = document.createElement('div');
      content.textContent = msg.role === 'agent' ? stripStatusTag(msg.content) : msg.content;
      el.appendChild(content);

      elMessages.insertBefore(el, elAnchor);
    }
    if (shouldScroll !== false) {
      scrollToBottom();
    }
  }

  function renderMessages() {
    renderMessagesOnly();
    saveMessages();
  }

  /** 增量追加单条消息到 DOM（避免全量 innerHTML 重建导致闪烁） */
  function appendMessageEl(msg) {
    if (!elMessages) return;
    var el = document.createElement('div');
    el.className = 'message ' + msg.role;

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = msg.role === 'user' ? 'You' : 'Assistant';
    el.appendChild(label);

    // 渲染图片缩略图（如果有）
    if (msg.images && msg.images.length > 0) {
      var imgRow = document.createElement('div');
      imgRow.className = 'msg-images';
      for (var i = 0; i < msg.images.length; i++) {
        var img = document.createElement('img');
        img.src = msg.images[i];
        img.className = 'msg-image-thumb';
        img.alt = '图片 ' + (i + 1);
        imgRow.appendChild(img);
      }
      el.appendChild(imgRow);
    }

    var content = document.createElement('div');
    content.textContent = msg.role === 'agent' ? stripStatusTag(msg.content) : msg.content;
    el.appendChild(content);

    elMessages.insertBefore(el, elAnchor);
  }

  // ---- 滚动状态（overflow-anchor 自动粘底） ----
  /** 用户是否手动向上滚动过（脱离底部） */
  var userScrolledUp = false;

  function appendStreamChunk(text) {
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'agent' && lastMsg._streaming) {
      // 已有流式消息，更新数据模型
      streamReplyBuffer += text;
      lastMsg.content = streamReplyBuffer;
    } else {
      repairOrphanStreamingIfAny();
      streamReplyBuffer += text;
      // 新建流式消息
      messages.push({ role: 'agent', content: streamReplyBuffer, _streaming: true });

      var el = document.createElement('div');
      el.className = 'message assistant';
      el.setAttribute('id', 'streaming-msg');

      var label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = 'Assistant';
      el.appendChild(label);

      var contentDiv = document.createElement('div');
      contentDiv.textContent = stripStatusTag(streamReplyBuffer);
      el.appendChild(contentDiv);
      el._streamContentEl = contentDiv;

      elMessages.insertBefore(el, elAnchor);
      return;
    }

    // 增量追加文本节点
    var streamEl = document.getElementById('streaming-msg');
    if (!streamEl) {
      // 全量 render 曾移除流式节点：按当前缓冲重建气泡，否则只有内存有字、界面空白
      var wrap = document.createElement('div');
      wrap.className = 'message assistant';
      wrap.setAttribute('id', 'streaming-msg');
      var lab = document.createElement('div');
      lab.className = 'msg-label';
      lab.textContent = 'Assistant';
      wrap.appendChild(lab);
      var contentDiv = document.createElement('div');
      contentDiv.textContent = stripStatusTag(streamReplyBuffer);
      wrap.appendChild(contentDiv);
      wrap._streamContentEl = contentDiv;
      elMessages.insertBefore(wrap, elAnchor);
      return;
    }
    if (streamEl && streamEl._streamContentEl) {
      streamEl._streamContentEl.textContent = stripStatusTag(streamReplyBuffer);
    } else if (streamEl) {
      var contentEl = streamEl.lastChild;
      if (contentEl) {
        contentEl.textContent = stripStatusTag(streamReplyBuffer);
        streamEl._streamContentEl = contentEl;
      }
    }
  }

  function finalizeStreamResponse() {
    var lastMsg = messages[messages.length - 1];
    var wasStreaming = !!(lastMsg && lastMsg._streaming);
    if (lastMsg && lastMsg._streaming) {
      delete lastMsg._streaming;
      streamFinalized = true;
      // 清理 status 标记（与流式展示一致）
      lastMsg.content = stripStatusTag(lastMsg.content);
    }
    streamReplyBuffer = '';
    var streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      if (streamEl._streamContentEl) {
        streamEl._streamContentEl.normalize();
        // 同步清理 DOM 中的 status 标记
        streamEl._streamContentEl.textContent = stripStatusTag(streamEl._streamContentEl.textContent || '');
      }
      streamEl.removeAttribute('id');
      delete streamEl._streamContentEl;
    } else if (wasStreaming && lastMsg && lastMsg.role === 'agent' && (lastMsg.content || '').length > 0) {
      // 流式节点已丢失：补画一条，避免 streamFinalized 跳过 response 后界面无气泡
      appendMessageEl(lastMsg);
    }
    // 将收集的工具调用批次清空（后端已持久化）
    var lastMsgIdx = messages.length - 1;
    if (lastMsgIdx >= 0 && messages[lastMsgIdx].role === 'agent') {
      flushToolBatchLocal();
    }
    setStreamingState(false);
    saveMessages();
  }

  /** 从流式气泡 DOM 读取正文（不含角色标签行） */
  function getStreamingBubbleBodyText(streamEl) {
    if (!streamEl) return '';
    if (streamEl._streamContentEl) {
      return streamEl._streamContentEl.textContent || '';
    }
    var label = streamEl.querySelector('.msg-label');
    var n = label ? label.nextElementSibling : null;
    while (n && n.classList && n.classList.contains('msg-images')) {
      n = n.nextElementSibling;
    }
    return n ? (n.textContent || '') : '';
  }

  /**
   * 模型与 DOM 不一致时收尾：页面上仍有 #streaming-msg，但 messages 最后一项已不是流式助手气泡。
   * 避免重复 id 导致后续 chunk 写到旧气泡（显示在用户气泡上方）。
   */
  function repairOrphanStreamingIfAny() {
    if (!elMessages) return;
    var streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;

    var bodyText = getStreamingBubbleBodyText(streamEl);
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent' && messages[i]._streaming) {
        messages[i].content = stripStatusTag(bodyText);
        delete messages[i]._streaming;
        break;
      }
    }

    streamEl.removeAttribute('id');
    delete streamEl._streamContentEl;
    streamReplyBuffer = '';
    flushToolBatchLocal();
    setStreamingState(false);
    saveMessages();
  }

  /** 发送新用户消息前结束本轮流式，保证新气泡永远在用户气泡之下 */
  function finalizeBeforeUserMessage() {
    if (hasStreamingModelBubble()) {
      finalizeStreamResponse();
    } else {
      repairOrphanStreamingIfAny();
    }
  }

  // ---- 发送/停止按钮状态切换 ----

  function setStreamingState(streaming) {
    if (isStreaming === streaming) return; // 状态未变，不操作 DOM
    isStreaming = streaming;
    if (!elSendBtn) return;

    if (streaming) {
      elSendBtn.innerHTML = '<span class="icon-stop"></span>';
      elSendBtn.title = 'Stop';
      elSendBtn.classList.add('btn-stop');
      elInput.disabled = true;
    } else {
      elSendBtn.innerHTML = '<span class="icon-send"></span>';
      elSendBtn.title = 'Send';
      elSendBtn.classList.remove('btn-stop');
      elInput.disabled = false;
    }
  }

  function handleStop() {
    userStopped = true;
    // 通过 WebSocket 通知后端停止
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'stop' }));
    }

    // 立即结束 UI 状态
    removeThinking();

    if (streamReplyBuffer) {
      // 保留已接收的部分内容，标记为已停止
      var lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg._streaming) {
        var stoppedContent = stripStatusTag(streamReplyBuffer);
        lastMsg.content = stoppedContent ? stoppedContent + '\n\n[已停止]' : '[已停止]';
        delete lastMsg._streaming;
        // 更新 DOM 中流式消息的内容
        var streamEl = document.getElementById('streaming-msg');
        if (streamEl) {
          var contentEl = streamEl._streamContentEl || streamEl.lastChild;
          if (contentEl) {
            // 清理并重写内容（避免残留的半截 status 标记）
            contentEl.textContent = lastMsg.content;
          }
          streamEl.removeAttribute('id');
          delete streamEl._streamContentEl;
        }
        // 清空工具调用批次（后端已持久化）
        flushToolBatchLocal();
      }
    } else {
      // 没有流式内容但正在处理（可能在工具执行阶段）
      // 追加一条中断提示
      var infoMsg = { role: 'agent', content: '[已停止]' };
      messages.push(infoMsg);
      // 清空工具调用批次
      flushToolBatchLocal();
      appendMessageEl(infoMsg);
    }

    streamReplyBuffer = '';
    streamFinalized = false;
    setStreamingState(false);
    wsProcessing = false;
    saveMessages();
  }

  // ---- 文件上传 ----

  function handleFileSelect(file) {
    if (!file) return;

    // 上传到服务器
    var formData = new FormData();
    formData.append('file', file);

    elFileStatus.classList.remove('hidden');
    elFileName.textContent = file.name + ' (uploading…)';

    fetch('/api/chat/upload', {
      method: 'POST',
      body: formData
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          elFileName.textContent = file.name + ' (failed)';
          messages.push({ role: 'agent', content: 'Upload failed: ' + data.error });
          renderMessages();
          uploadedFile = null;
        } else {
          uploadedFile = { fileId: data.fileId, filename: data.filename, size: data.size };
          elFileName.textContent = data.filename + ' (' + formatSize(data.size) + ') — 发送时将自动解析';
        }
      })
      .catch(function () {
        elFileName.textContent = file.name + ' (failed)';
        uploadedFile = null;
      });
  }

  function removeUploadedFile() {
    uploadedFile = null;
    if (elFileStatus) elFileStatus.classList.add('hidden');
    if (elFileName) elFileName.textContent = '';
    if (elFileInput) elFileInput.value = '';
  }

  /** 显示粘贴图片的缩略预览 */
  function showPastePreview(file) {
    // 移除旧预览
    var old = document.getElementById('paste-preview');
    if (old) old.parentNode.removeChild(old);

    var reader = new FileReader();
    reader.onload = function (e) {
      var img = document.createElement('img');
      img.src = e.target.result;
      img.setAttribute('id', 'paste-preview');
      img.style.cssText = 'max-width:120px;max-height:80px;border-radius:6px;margin:6px 16px;border:1px solid var(--border-color);display:block;';
      // 插入到 file-status 后面
      var inputArea = elFileStatus ? elFileStatus.parentNode : null;
      if (inputArea && elFileStatus) {
        inputArea.insertBefore(img, elFileStatus.nextSibling);
      }
    };
    reader.readAsDataURL(file);
  }

  /** 添加待发送图片（粘贴或拖拽） */
  function addPendingImage(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var dataUrl = e.target.result;
      pendingImages.push({ dataUrl: dataUrl, file: file });
      renderPendingImages();
    };
    reader.readAsDataURL(file);
  }

  /** 移除指定索引的待发送图片 */
  function removePendingImage(index) {
    pendingImages.splice(index, 1);
    renderPendingImages();
  }

  /** 清空所有待发送图片 */
  function clearPendingImages() {
    pendingImages = [];
    renderPendingImages();
  }

  /** 渲染待发送图片预览区 */
  function renderPendingImages() {
    var previewArea = document.getElementById('pending-images-preview');
    if (!previewArea) return;

    if (pendingImages.length === 0) {
      previewArea.classList.add('hidden');
      previewArea.innerHTML = '';
      return;
    }

    previewArea.classList.remove('hidden');
    previewArea.innerHTML = '';

    for (var i = 0; i < pendingImages.length; i++) {
      (function (idx) {
        var wrapper = document.createElement('div');
        wrapper.className = 'pending-image-item';

        var img = document.createElement('img');
        img.src = pendingImages[idx].dataUrl;
        img.className = 'pending-image-thumb';
        img.alt = '待发送图片';
        wrapper.appendChild(img);

        var removeBtn = document.createElement('button');
        removeBtn.className = 'pending-image-remove';
        removeBtn.textContent = '×';
        removeBtn.title = '移除图片';
        removeBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          removePendingImage(idx);
        });
        wrapper.appendChild(removeBtn);

        previewArea.appendChild(wrapper);
      })(i);
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- 统一 WebSocket 通信（PC 和移动端共用） ----

  function connectChatWs() {
    if (chatWs) {
      try { chatWs.close(); } catch (_e) { /* ignore */ }
    }
    if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
    if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }

    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/api/chat/ws';
    if (remoteToken) {
      wsUrl += '?token=' + encodeURIComponent(remoteToken);
    }

    chatWs = new WebSocket(wsUrl);

    wsConnectTimeout = setTimeout(function () {
      wsConnectTimeout = null;
      if (chatWs && chatWs.readyState === WebSocket.CONNECTING) {
        try { chatWs.close(); } catch (_e) { /* ignore */ }
      }
    }, 10000);

    chatWs.onopen = function () {
      if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }
      wsReconnectAttempts = 0;
      updateNavStatus(true);
      syncMessages();
      startSyncPolling();
      fetchModelContext();
    };

    chatWs.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        handleWsMessage(data);
      } catch (_err) { /* ignore */ }
    };

    chatWs.onclose = function () {
      if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }
      wsProcessing = false;
      setStreamingState(false);
      updateNavStatus(false);
      scheduleWsReconnect();
    };

    chatWs.onerror = function () { /* onclose handles it */ };

    wsHeartbeatTimer = setInterval(function () {
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
  }

  /** 其它端写入 default.json 后立即拉取服务端快照（含 tool_trace），与轮询互补 */
  function pullServerChatSnapshotAuthoritative() {
    if (wsProcessing || isStreaming || hasStreamingModelBubble()) return;
    fetchServerMessages(function (serverMsgs) {
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = separateToolTraces(raw);
      applyServerChatSnapshot(separated, { fullRender: false, authoritative: true });
    });
  }

  function syncMessages() {
    if (wsProcessing || isStreaming || hasStreamingModelBubble()) return;
    fetchServerMessages(function (serverMsgs) {
      if (!serverMsgs || serverMsgs.length === 0) return;
      var separated = separateToolTraces(serverMsgs);
      applyServerChatSnapshot(separated, { fullRender: false });
    });
  }

  function startSyncPolling() {
    stopSyncPolling();
    wsSyncTimer = setInterval(function () {
      if (!wsProcessing && !isStreaming) {
        syncMessages();
      }
    }, 5000);
  }

  function stopSyncPolling() {
    if (wsSyncTimer) { clearInterval(wsSyncTimer); wsSyncTimer = null; }
  }

  function scheduleWsReconnect() {
    stopSyncPolling();
    if (wsReconnectTimer) return;
    var delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(function () {
      wsReconnectTimer = null;
      connectChatWs();
    }, delay);
  }

  function handleWsMessage(data) {
    switch (data.type) {
      case 'connected':
        break;
      case 'session_updated':
        pullServerChatSnapshotAuthoritative();
        break;
      case 'stream':
        // 流式增量文本：逐 chunk 追加到当前助手侧消息
        if (userStopped) break;
        if (!isStreaming) setStreamingState(true);
        if (sessionPet && sessionPet.isVisible()) {
          sessionPet.setState('thinking');
        }
        appendStreamChunk(data.delta || '');
        break;
      case 'stream_end':
        // 流式结束：定稿当前流式消息
        if (!userStopped) {
          finalizeStreamResponse();
        } else {
          // 用户已停止，清理残留状态
          streamReplyBuffer = '';
          streamFinalized = false;
        }
        break;
      case 'response':
        // 完整响应（流式结束后的最终内容，或非流式模式的回退）
        if (userStopped) {
          // 用户已停止，忽略后续 response
          userStopped = false; // 重置，准备下一轮
          break;
        }
        // 如果刚刚 finalize 了流式消息，response 是冗余的，跳过
        if (streamFinalized) {
          streamFinalized = false;
          break;
        }
        // 非流式模式：直接显示完整响应
        finalizeStreamResponse();
        messages.push({ role: 'agent', content: stripStatusTag(data.content || '') });
        // 清空工具调用批次（后端已持久化）
        flushToolBatchLocal();
        appendMessageEl(messages[messages.length - 1]);
        saveMessages();
        break;
      case 'step':
        handleWsStep(data.step);
        break;
      case 'status':
        wsProcessing = data.status === 'processing';
        if (data.status === 'idle') {
          // 任务结束（正常完成或中断后后端清理完毕）
          if (userStopped) {
            userStopped = false; // 重置停止标记
          }
          removeThinking();
          setStreamingState(false);
        } else {
          setStreamingState(wsProcessing);
          if (sessionPet && sessionPet.isVisible() && wsProcessing) {
            sessionPet.setState('thinking');
          }
        }
        break;
      case 'error':
        finalizeStreamResponse();
        messages.push({ role: 'agent', content: '[err] ' + data.message });
        appendMessageEl(messages[messages.length - 1]);
        saveMessages();
        removeThinking();
        break;
      case 'info':
        // info 消息（如工具调用次数）不写入聊天记录，仅在控制台记录
        console.log('[info]', data.message);
        break;
      case 'memory_notice':
        // v4 被动确认：记忆提取通知，显示为淡化提示
        if (data.notices && data.notices.length > 0) {
          for (var ni = 0; ni < data.notices.length; ni++) {
            messages.push({ role: 'agent', content: data.notices[ni] });
            appendMessageEl(messages[messages.length - 1]);
          }
          saveMessages();
          if (sessionPet) {
            sessionPet.setVisible(true);
            sessionPet.setState('happy');
            var memLine = typeof data.notices[0] === 'string' ? data.notices[0] : '';
            if (petUiSessionActive || wsProcessing || isStreaming) {
              sessionPet.setBubbleText(memLine || '已更新记忆');
            }
            setTimeout(function () {
              if (!sessionPet || !sessionPet.isVisible()) return;
              sessionPet.setState(wsProcessing || isStreaming ? 'thinking' : 'idle');
              sessionPet.setBubbleText('');
            }, 5200);
          }
        }
        break;
      case 'confirm':
        if (sessionPet && sessionPet.isVisible()) {
          sessionPet.setState('alert');
          sessionPet.setBubbleText('请在弹窗中确认危险操作');
        }
        handleWsConfirm(data.toolName, data.args);
        break;
      case 'tokenUsage':
        updateTokenUsage(data.inputTokens || 0, data.outputTokens || 0);
        break;
      case 'tool_output':
        // 工具实时输出（忽略，工具调用已在聊天区展示）
        break;
      case 'pong':
        break;
      case 'pulse':
        if (sessionPet && sessionPet.isVisible()) {
          var hint = lastToolProgressHint || '处理中';
          updateStatusText(hint);
        }
        break;
    }
  }

  function handleWsStep(step) {
    if (!step) return;
    // 更新 token 用量
    if (step.totalTokenUsage) {
      usedInputTokens = step.totalTokenUsage.inputTokens || 0;
      usedOutputTokens = step.totalTokenUsage.outputTokens || 0;
      renderContextBar();
    }
    // 更新轮次指示器
    if (step.iteration) {
      updateTurnCounter(step.iteration);
    }
    if (step.type === 'tool_progress' && step.content) {
      lastToolProgressHint = step.content;
      if (sessionPet && sessionPet.isVisible()) {
        updateStatusText(step.content);
      }
    }
    // 工具调用：在聊天区追加紧凑条目 + 收集到当前批次
    if (step.type === 'tool_call' && step.toolName) {
      var detail = '';
      if (step.toolArgs) {
        // 提取关键参数作为摘要（文件路径、命令等）
        detail = step.toolArgs.path || step.toolArgs.file || step.toolArgs.command || step.toolArgs.query || '';
        if (!detail) {
          var argsStr = JSON.stringify(step.toolArgs);
          detail = argsStr.length > 80 ? argsStr.substring(0, 80) + '…' : argsStr;
        }
      }
      appendToolAction(step.toolName, detail, 'pending');
      // 收集到当前批次（稍后关联到助手消息）
      currentToolBatch.push({ toolName: step.toolName, detail: detail, status: 'pending' });
    }
    // 工具结果：更新对应条目的图标 + 更新批次中的状态
    if (step.type === 'tool_result' && step.toolName) {
      var resultStatus = step.toolSuccess ? 'success' : 'error';
      updateLastToolAction(step.toolName, resultStatus);
      // 更新批次中最后一个匹配的工具状态
      for (var i = currentToolBatch.length - 1; i >= 0; i--) {
        if (currentToolBatch[i].toolName === step.toolName && currentToolBatch[i].status === 'pending') {
          currentToolBatch[i].status = resultStatus;
          break;
        }
      }
    }
    applyHarnessStepToPet(step);
  }

  function handleWsConfirm(toolName, args) {
    var argsText = args ? JSON.stringify(args) : '';
    var ok = window.confirm('AI 请求执行危险操作：\n\n工具: ' + toolName + '\n参数: ' + argsText + '\n\n是否允许？');
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'confirm_reply', approved: ok }));
    }
    var confirmMsg = { role: 'agent', content: ok ? '[ok] 用户已确认: ' + toolName : '[denied] 用户已拒绝: ' + toolName };
    messages.push(confirmMsg);
    appendMessageEl(confirmMsg);
    saveMessages();
    if (sessionPet && sessionPet.isVisible()) {
      sessionPet.setState(isStreaming || wsProcessing ? 'thinking' : 'idle');
      sessionPet.setBubbleText(lastToolProgressHint || '');
    }
  }

  function sendWsMessage(text) {
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
      messages.push({ role: 'agent', content: '[err] 未连接，无法发送' });
      renderMessages();
      return;
    }
    resetLiveToolRoundTargets();
    liveToolRoundActive = true;
    chatWs.send(JSON.stringify({ type: 'message', content: text }));
  }

  // ---- 命令面板 ----

  // ~ 开头：本地命令（不发送到服务器）
  var PC_LOCAL_COMMANDS = [
    { name: 'clear', description: '清空当前聊天显示（记忆保留）', prefix: '~' },
    { name: 'open', description: '打开文件管理器，浏览电脑文件', prefix: '~' },
    { name: 'scan', description: '手机扫码连接，远程控制', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' },
    { name: 'export', description: '导出所有记忆文件', prefix: '~' },
    { name: 'memory', description: '查看/管理记忆文件', prefix: '~' }
  ];

  var REMOTE_LOCAL_COMMANDS = [
    { name: 'clear', description: '清空当前聊天显示（记忆保留）', prefix: '~' },
    { name: 'open', description: '打开文件管理器，浏览电脑文件', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' },
    { name: 'export', description: '导出所有记忆文件', prefix: '~' },
    { name: 'memory', description: '查看/管理记忆文件', prefix: '~' }
  ];

  function getLocalCommands() {
    return remoteMode ? REMOTE_LOCAL_COMMANDS : PC_LOCAL_COMMANDS;
  }

  var LOCAL_COMMANDS = PC_LOCAL_COMMANDS; // 初始值，render 时会更新

  var elCmdDropdown = null;
  var cmdSelectedIndex = 0;
  var cmdVisible = false;
  var cmdFiltered = [];
  var cmdActivePrefix = ''; // 当前激活的前缀 ~ 或 /

  function createCmdDropdown() {
    var el = document.createElement('div');
    el.className = 'cmd-dropdown hidden';
    el.setAttribute('id', 'cmd-dropdown');
    return el;
  }

  function showCmdDropdown(prefix, filter) {
    if (!elCmdDropdown) return;
    if (prefix !== '~') {
      hideCmdDropdown();
      return;
    }
    cmdActivePrefix = prefix;
    var query = (filter || '').toLowerCase();
    var source = getLocalCommands();
    cmdFiltered = source.filter(function (cmd) {
      return cmd.name.toLowerCase().indexOf(query) >= 0;
    });
    if (cmdFiltered.length === 0) {
      hideCmdDropdown();
      return;
    }
    cmdSelectedIndex = 0;
    renderCmdDropdown();
    elCmdDropdown.classList.remove('hidden');
    cmdVisible = true;
  }

  function hideCmdDropdown() {
    if (!elCmdDropdown) return;
    elCmdDropdown.classList.add('hidden');
    cmdVisible = false;
    cmdFiltered = [];
    cmdActivePrefix = '';
  }

  function renderCmdDropdown() {
    if (!elCmdDropdown) return;
    elCmdDropdown.innerHTML = '';
    for (var i = 0; i < cmdFiltered.length; i++) {
      var item = document.createElement('div');
      item.className = 'cmd-item' + (i === cmdSelectedIndex ? ' active' : '');
      item.setAttribute('data-index', i);
      var prefix = cmdFiltered[i].prefix || cmdActivePrefix;
      item.innerHTML =
        '<span class="cmd-name">' + prefix + cmdFiltered[i].name + '</span>' +
        '<span class="cmd-desc">' + cmdFiltered[i].description + '</span>';
      (function (idx) {
        item.addEventListener('mouseenter', function () {
          cmdSelectedIndex = idx;
          renderCmdDropdown();
        });
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          selectCmd(idx);
        });
        // 移动端触摸支持
        item.addEventListener('touchend', function (e) {
          e.preventDefault();
          selectCmd(idx);
        });
      })(i);
      elCmdDropdown.appendChild(item);
    }
  }

  function selectCmd(index) {
    if (index < 0 || index >= cmdFiltered.length) return;
    var cmd = cmdFiltered[index];
    var prefix = cmd.prefix || cmdActivePrefix;
    elInput.value = prefix + cmd.name;
    hideCmdDropdown();
    elInput.focus();
  }

  function handleCmdInput() {
    var val = elInput.value;
    if (val.indexOf('~') === 0) {
      var filter = val.slice(1);
      showCmdDropdown('~', filter);
    } else {
      hideCmdDropdown();
    }
  }

  function handleCmdKeydown(e) {
    if (!cmdVisible) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdFiltered.length;
      renderCmdDropdown();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdFiltered.length) % cmdFiltered.length;
      renderCmdDropdown();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectCmd(cmdSelectedIndex);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideCmdDropdown();
      return true;
    }
    return false;
  }

  // ---- 发送消息 ----

  function handleSend() {
    // 如果正在流式传输，点击按钮执行停止
    if (isStreaming) {
      handleStop();
      return;
    }

    var text = elInput.value.trim();
    if (!text && !uploadedFile && pendingImages.length === 0) return;

    // 处理 ~clear 命令：清空聊天显示和后端缓存（记忆系统不受影响）
    if (text === '~clear') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      clearMessages();
      renderMessages();
      return;
    }

    // 处理 ~scan 命令：生成远程控制二维码
    if (text === '~scan' && !remoteMode) {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      showQrCode();
      return;
    }

    // 处理 ~open 命令：注入文件浏览器指令后发送给 LLM
    if (text === '~open') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      showThinking(false);
      sendWsMessage('~open\n\n' +
        '【文件浏览器模式】忽略之前对话中的所有任务和主题。你现在是文件浏览器。\n\n' +
        '核心规则：\n' +
        '- 每次调用工具后，必须把工具返回的内容（驱动器列表、目录内容）完整展示给用户。\n' +
        '- 展示完内容后等待用户下一条指令。\n' +
        '- 禁止分析、总结、评价、修改任何文件或项目。只做导航和展示。\n\n' +
        '导航规则：\n' +
        '1. 现在立即调用 list_drives，然后把所有驱动器列出来。\n' +
        '2. 用户说"进入 X:"时，调用 browse_directory 浏览该路径，然后列出目录内容。\n' +
        '3. 用户说"进入 XXX"时，拼接到当前路径，调用 browse_directory，然后列出目录内容。\n' +
        '4. 用户说"返回"时，浏览当前目录的父目录，然后列出目录内容。\n' +
        '5. 记住当前路径。\n\n' +
        '展示格式：目录用 [DIR]，文件用 [FILE]，驱动器用 [DRIVE]。');
      return;
    }

    // 处理 ~telemetry 命令：获取并显示记忆系统遥测报告
    if (text === '~telemetry') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      messages.push({ role: 'agent', content: '正在获取记忆系统遥测报告…' });
      renderMessages();

      fetch('/api/memory/telemetry')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          // 移除 "正在获取" 消息
          messages.pop();
          if (data.success && data.report) {
            messages.push({ role: 'agent', content: data.report });
          } else {
            messages.push({ role: 'agent', content: '获取遥测报告失败: ' + (data.error || '未知错误') });
          }
          renderMessages();
        })
        .catch(function () {
          messages.pop();
          messages.push({ role: 'agent', content: '获取遥测报告失败，请检查服务器是否运行' });
          renderMessages();
        });
      return;
    }

    // 处理 ~export 命令：导出记忆文件
    if (text === '~export') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      messages.push({ role: 'agent', content: '正在导出记忆文件…' });
      renderMessages();

      fetch('/api/memory/stats')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.success || data.total === 0) {
            messages.pop();
            messages.push({ role: 'agent', content: '没有可导出的记忆文件。' });
            renderMessages();
            return;
          }
          // 触发下载
          var a = document.createElement('a');
          a.href = '/api/memory/export';
          a.download = '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          messages.pop();
          messages.push({
            role: 'agent',
            content: '记忆导出完成！共 ' + data.total + ' 个文件（项目级 ' + data.project.files + ' + 用户级 ' + data.user.files + '）。\n\n文件已开始下载。'
          });
          renderMessages();
        })
        .catch(function (err) {
          messages.pop();
          messages.push({ role: 'agent', content: '记忆导出失败: ' + (err.message || '未知错误') });
          renderMessages();
        });
      return;
    }

    // 处理 ~memory 命令：查看/管理记忆文件
    if (text === '~memory' || text.indexOf('~memory ') === 0) {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();

      var memArgs = text.substring(7).trim(); // "~memory" 后面的参数

      // ~memory view <filename>
      if (memArgs.indexOf('view ') === 0) {
        var viewFilename = memArgs.substring(5).trim();
        if (!viewFilename) {
          messages.push({ role: 'agent', content: '用法: ~memory view <文件名>' });
          renderMessages();
          return;
        }
        messages.push({ role: 'agent', content: '正在读取: ' + viewFilename + '…' });
        renderMessages();

        fetch('/api/memory/files/' + encodeURIComponent(viewFilename))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            messages.pop();
            if (data.success) {
              messages.push({ role: 'agent', content: '📄 **' + viewFilename + '** (' + data.level + '级)\n\n```markdown\n' + data.content + '\n```' });
            } else {
              messages.push({ role: 'agent', content: '❌ 读取失败: ' + (data.error || '未知错误') });
            }
            renderMessages();
          })
          .catch(function (err) {
            messages.pop();
            messages.push({ role: 'agent', content: '❌ 读取失败: ' + (err.message || '网络错误') });
            renderMessages();
          });
        return;
      }

      // ~memory delete <filename>
      if (memArgs.indexOf('delete ') === 0) {
        var delFilename = memArgs.substring(7).trim();
        if (!delFilename) {
          messages.push({ role: 'agent', content: '用法: ~memory delete <文件名>' });
          renderMessages();
          return;
        }
        messages.push({ role: 'agent', content: '正在删除记忆: ' + delFilename + '…' });
        renderMessages();

        fetch('/api/memory/files/' + encodeURIComponent(delFilename), { method: 'DELETE' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            messages.pop();
            if (data.success) {
              messages.push({ role: 'agent', content: '✅ 已删除记忆: ' + delFilename });
            } else {
              messages.push({ role: 'agent', content: '❌ 删除失败: ' + (data.error || '未知错误') });
            }
            renderMessages();
          })
          .catch(function (err) {
            messages.pop();
            messages.push({ role: 'agent', content: '❌ 删除失败: ' + (err.message || '网络错误') });
            renderMessages();
          });
        return;
      }

      // ~memory (无参数) — 列出所有记忆
      messages.push({ role: 'agent', content: '正在加载记忆列表…' });
      renderMessages();

      fetch('/api/memory/files')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          messages.pop();
          if (!data.success || !data.files || data.files.length === 0) {
            messages.push({ role: 'agent', content: '📭 暂无记忆文件。' });
            renderMessages();
            return;
          }
          var lines = ['📋 **记忆文件** (' + data.files.length + ' 个)\n'];
          for (var fi = 0; fi < data.files.length; fi++) {
            var f = data.files[fi];
            var typeTag = f.type ? '[' + f.type + '] ' : '';
            var desc = f.description ? ' — ' + f.description : '';
            lines.push((fi + 1) + '. ' + typeTag + '`' + f.filename + '`' + desc);
          }
          lines.push('\n查看记忆: `~memory view <文件名>` | 删除记忆: `~memory delete <文件名>`');
          messages.push({ role: 'agent', content: lines.join('\n') });
          renderMessages();
        })
        .catch(function (err) {
          messages.pop();
          messages.push({ role: 'agent', content: '加载记忆列表失败: ' + (err.message || '网络错误') });
          renderMessages();
        });
      return;
    }

    // 统一通过 WebSocket 发送（PC 和移动端共用）
    var displayParts = [];
    if (text) displayParts.push(text);
    if (uploadedFile) displayParts.push('[file] ' + uploadedFile.filename);
    var msgImages = pendingImages.map(function (p) { return p.dataUrl; });
    if (displayParts.length > 0 || msgImages.length > 0) {
      finalizeBeforeUserMessage();
      var userMsg = { role: 'user', content: displayParts.join('\n') || '(图片)', images: msgImages.length > 0 ? msgImages : undefined };
      messages.push(userMsg);
      appendMessageEl(userMsg);
      saveMessages();
    }
    elInput.value = '';
    autoResizeInput();
    hideCmdDropdown();
    userScrolledUp = false; // 发送新消息时重置，确保看到回复
    showThinking(!!uploadedFile || msgImages.length > 0);

    // 如果有文件，先上传，再把 fileId 附加到消息中
    var msgText = text || '';
    if (uploadedFile) {
      msgText = (msgText ? msgText + '\n' : '') + '[file:' + uploadedFile.fileId + '] ' + uploadedFile.filename;
    }
    removeUploadedFile();

    // 构建 WebSocket 消息（可能包含图片）
    if (msgImages.length > 0) {
      resetLiveToolRoundTargets();
      liveToolRoundActive = true;
      // 发送带图片的多模态消息
      chatWs.send(JSON.stringify({
        type: 'message',
        content: msgText || '请分析这些图片',
        images: msgImages,
      }));
    } else {
      sendWsMessage(msgText);
    }
    clearPendingImages();
    userStopped = false; // 新消息发送，重置停止标记
    streamFinalized = false;
  }

  // ---- 输入框自动调整大小 ----

  function autoResizeInput() {
    if (!elInput) return;
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(elInput.scrollHeight, 120) + 'px';
  }

  // ---- 上下文用量显示 ----

  /** 更新导航栏连接状态 */
  function updateNavStatus(connected) {
    var dot = document.getElementById('status-dot');
    if (dot) {
      dot.classList.toggle('connected', connected);
      dot.classList.toggle('disconnected', !connected);
      dot.title = connected ? '已连接' : '未连接';
    }
  }

  var elContextBar = null;

  function fetchModelContext() {
    fetch('/api/config')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var providers = data.providers || [];
        var defaultProvider = providers.find(function (p) { return p.isDefault; }) || providers[0];
        if (defaultProvider) {
          maxContextTokens = defaultProvider.maxContextTokens || 0;
          modelName = defaultProvider.modelName || '';
          renderContextBar();
        }
      })
      .catch(function () { /* ignore */ });
  }

  function updateTokenUsage(inputTokens, outputTokens) {
    // inputTokens = 当前上下文窗口占用（最后一轮 API 调用的输入 token 数）
    // 这就是实际的上下文大小，outputTokens 不计入（下一轮会合并到 input 中）
    usedInputTokens = inputTokens;
    usedOutputTokens = outputTokens;
    renderContextBar();
  }

  function resetTokenUsage() {
    usedInputTokens = 0;
    usedOutputTokens = 0;
    renderContextBar();
  }

  function renderContextBar() {
    if (!elContextBar) return;

    // 上下文占用 = inputTokens（当前窗口大小），不加 outputTokens（避免重复计算）
    var usedTotal = usedInputTokens;
    var pct = maxContextTokens ? Math.min(100, Math.round((usedTotal / maxContextTokens) * 100)) : 0;
    var barColor = pct < 60 ? '#4caf50' : pct < 85 ? '#ff9800' : '#e94560';

    var fill = elContextBar.querySelector('.ctx-bottom-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.style.background = barColor;
    }

    elContextBar.title = '上下文: ' + pct + '%' +
      (maxContextTokens ? ' (' + formatTokenCount(usedTotal) + '/' + formatTokenCount(maxContextTokens) + ')' : '') +
      ' | 本轮输出: ' + formatTokenCount(usedOutputTokens);
  }

  function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return '' + n;
  }

  // ---- 二维码远程控制 ----

  function showQrCode() {
    messages.push({ role: 'agent', content: '正在生成远程控制二维码…' });
    renderMessages();

    fetch('/api/remote/session', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) {
          messages.push({ role: 'agent', content: '生成二维码失败: ' + (data.error || '未知错误') });
          renderMessages();
          return;
        }

        // 移除 "正在生成" 消息
        messages.pop();
        renderMessages();

        // 创建二维码弹窗
        showQrModal(data.url, data.qrDataUrl, data.localIP, data.port, data.tunnel);
      })
      .catch(function () {
        messages.push({ role: 'agent', content: '生成二维码失败，请检查网络连接' });
        renderMessages();
      });
  }

  function showQrModal(url, qrDataUrl, localIP, port, tunnel) {
    // 创建遮罩层
    var overlay = document.createElement('div');
    overlay.className = 'qr-overlay';
    overlay.setAttribute('id', 'qr-overlay');

    var modal = document.createElement('div');
    modal.className = 'qr-modal';

    var title = document.createElement('h3');
    title.textContent = '手机扫码远程控制';
    modal.appendChild(title);

    var desc = document.createElement('p');
    desc.className = 'qr-desc';
    desc.textContent = '请确保手机和电脑在同一局域网内';
    modal.appendChild(desc);

    var qrContainer = document.createElement('div');
    qrContainer.className = 'qr-canvas-container';
    if (qrDataUrl) {
      var img = document.createElement('img');
      img.src = qrDataUrl;
      img.alt = 'QR Code';
      img.style.width = '220px';
      img.style.height = '220px';
      img.style.borderRadius = '8px';
      qrContainer.appendChild(img);
    } else {
      qrContainer.innerHTML = '<p style="word-break:break-all;font-size:12px;color:#a0a0a0;">二维码生成失败，请手动访问:<br>' + escapeHtml(url) + '</p>';
    }
    modal.appendChild(qrContainer);

    var urlText = document.createElement('p');
    urlText.className = 'qr-url';
    urlText.textContent = url;
    modal.appendChild(urlText);

    var info = document.createElement('p');
    info.className = 'qr-info';
    info.textContent = tunnel ? '通过公网隧道访问（任意网络可用）' : '局域网 IP: ' + localIP + ' | 端口: ' + port;
    modal.appendChild(info);

    var hint = document.createElement('p');
    hint.className = 'qr-timer';
    hint.textContent = '链接长期有效，直到下次重新生成';
    modal.appendChild(hint);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'qr-close-btn';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', function () {
      document.body.removeChild(overlay);
    });
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
      }
    });

    document.body.appendChild(overlay);
  }

  // ---- 公共 API ----

  function render(parentEl) {
    container = parentEl;

    // 检测远程模式
    var params = new URLSearchParams(window.location.search);
    remoteToken = params.get('token');
    remoteMode = !!remoteToken;

    container.innerHTML =
      '<div class="chat-page">' +
        // Messages（正序 + overflow-anchor 锚点粘底）
        '<div class="chat-messages" id="chat-messages"><div class="chat-messages-anchor" id="chat-anchor"></div></div>' +
        // 点阵宠物本体 + 头顶气泡（无机身外壳）
        '<div class="session-pet-indicator" id="agent-status-bar">' +
          '<div class="pet-bubble" id="pet-bubble" role="status" aria-live="polite"></div>' +
          '<canvas class="pet-canvas" id="pet-canvas" width="512" height="512" role="img" aria-label="会话状态宠物，拖动移动；双击恢复默认位置" title="拖动：移动；双击：恢复默认位置"></canvas>' +
          '<span class="status-turn" id="status-turn"></span>' +
        '</div>' +
        // Input area（进度条作为上边框）
        '<div class="chat-input-area">' +
          '<div class="ctx-bottom-bar" id="ctx-bar" title="上下文用量">' +
            '<div class="ctx-bottom-fill"></div>' +
          '</div>' +
          '<div class="pending-images-preview hidden" id="pending-images-preview"></div>' +
          '<div class="file-upload-status hidden" id="file-status">' +
            '<span class="file-name" id="file-name"></span>' +
            '<button class="file-remove" id="file-remove" title="Remove file">&times;</button>' +
          '</div>' +
          '<div class="chat-input-row">' +
            '<button class="btn-icon" id="btn-file" title="Upload file"><span class="icon-clip"></span></button>' +
            '<div class="input-wrapper">' +
              '<textarea id="chat-input" rows="1" placeholder="输入指令… (输入 ~ 查看命令)"></textarea>' +
            '</div>' +
            '<button class="btn-icon btn-send" id="btn-send" title="Send"><span class="icon-send"></span></button>' +
          '</div>' +
          '<input type="file" class="hidden-input" id="file-input">' +
        '</div>' +
      '</div>';

    // 缓存 DOM 引用
    elMessages = container.querySelector('#chat-messages');
    elAnchor = container.querySelector('#chat-anchor');
    elInput = container.querySelector('#chat-input');
    elSendBtn = container.querySelector('#btn-send');
    elFileBtn = container.querySelector('#btn-file');
    elFileInput = container.querySelector('#file-input');
    elFileStatus = container.querySelector('#file-status');
    elFileName = container.querySelector('#file-name');
    elFileRemove = container.querySelector('#file-remove');
    elContextBar = container.querySelector('#ctx-bar');
    elStatusBar = container.querySelector('#agent-status-bar');
    if (window.SessionPet) {
      sessionPet = window.SessionPet.create(elStatusBar);
    }
    elStatusTurn = container.querySelector('#status-turn');

    // 立即渲染上下文条（加载状态）
    renderContextBar();

    // 监听用户滚动：检测是否手动向上滚动（脱离底部）
    elMessages.addEventListener('scroll', function () {
      var atBottom = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 80;
      userScrolledUp = !atBottom;
    });

    // 创建命令面板下拉框并插入到 input-wrapper 中
    elCmdDropdown = createCmdDropdown();
    var inputWrapper = container.querySelector('.input-wrapper');
    inputWrapper.appendChild(elCmdDropdown);

    // 初始化会话系统（远程模式在下方单独处理）
    if (!remoteMode) {
      initSession();
    }

    // 获取模型上下文信息
    fetchModelContext();

    if (!remoteMode) {
      // 从后端获取支持的文件格式
      fetchSupportedFormats();
    }

    // 绑定事件
    elSendBtn.addEventListener('click', handleSend);

    elInput.addEventListener('keydown', function (e) {
      // 命令面板键盘导航优先
      if (handleCmdKeydown(e)) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    elInput.addEventListener('input', function () {
      autoResizeInput();
      handleCmdInput();
    });

    elInput.addEventListener('blur', function () {
      // 延迟隐藏，让 mousedown 事件有机会触发
      setTimeout(hideCmdDropdown, 150);
    });

    // 粘贴图片支持：从剪贴板粘贴图片加入待发送列表
    elInput.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          if (file) {
            addPendingImage(file);
          }
          return;
        }
      }
    });

    // 拖拽图片支持：拖拽图片到聊天区
    var chatPage = container.querySelector('.chat-page');
    if (chatPage) {
      chatPage.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chatPage.classList.add('drag-over');
      });
      chatPage.addEventListener('dragleave', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chatPage.classList.remove('drag-over');
      });
      chatPage.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chatPage.classList.remove('drag-over');
        var files = e.dataTransfer && e.dataTransfer.files;
        if (!files) return;
        for (var i = 0; i < files.length; i++) {
          if (files[i].type.indexOf('image/') === 0) {
            addPendingImage(files[i]);
          } else {
            // 非图片文件走文件上传流程
            handleFileSelect(files[i]);
          }
        }
      });
    }

    if (elFileBtn) {
      elFileBtn.addEventListener('click', function () {
        elFileInput.click();
      });
    }

    if (elFileInput) {
      elFileInput.addEventListener('change', function () {
        if (elFileInput.files && elFileInput.files[0]) {
          handleFileSelect(elFileInput.files[0]);
        }
      });
    }

    if (elFileRemove) {
      elFileRemove.addEventListener('click', removeUploadedFile);
    }

    // 渲染已有消息（导航返回时）
    renderMessages();

    // 远程模式：从服务端同步消息
    if (remoteMode) {
      messages = [];
      toolTraces = {};
      lastSessionSyncSig = '';
      renderMessagesOnly();
      fetchServerMessages(function (serverMsgs) {
        if (serverMsgs.length > 0) {
          var separated = separateToolTraces(serverMsgs);
          applyServerChatSnapshot(separated, { fullRender: false, authoritative: true });
        }
      });
    }

    // PC 和移动端统一连接 WebSocket
    connectChatWs();

    // 切回前台时重连 + 刷新消息
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        syncMessages();
        if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
          if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
          wsReconnectAttempts = 0;
          connectChatWs();
        }
      } else {
        stopSyncPolling();
      }
    });
  }

  return { render: render };
})();
