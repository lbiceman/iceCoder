/**
 * 聊天 UI 渲染模块
 * 负责：消息渲染、流式输出、工具调用展示、滚动控制、输入框管理
 */

/* exported ChatUI */

window.ChatUI = (function () {
  'use strict';

  var TOOL_TRACE_VISIBLE_MAX = 3;

  var elMessages = null;
  var elAnchor = null;
  var elInput = null;
  var elSendBtn = null;

  var streamReplyBuffer = '';
  var userScrolledUp = false;

  // 实时工具区 DOM
  var liveToolRoundActive = false;
  var liveToolRoundRoot = null;
  var liveToolRoundVisible = null;
  var liveToolRoundCollapsed = null;
  var liveToolRoundToggle = null;
  var liveToolRoundCount = 0;

  function init(els) {
    elMessages = els.elMessages;
    elAnchor = els.elAnchor;
    elInput = els.elInput;
    elSendBtn = els.elSendBtn;

    if (elMessages) {
      elMessages.addEventListener('scroll', function () {
        var atBottom = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 80;
        userScrolledUp = !atBottom;
      });
    }
  }

  function scrollToBottom() {
    if (elMessages) {
      elMessages.scrollTop = elMessages.scrollHeight;
    }
  }

  function isNearBottom() {
    if (!elMessages) return true;
    return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 150;
  }

  function autoResizeInput() {
    if (!elInput) return;
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(elInput.scrollHeight, 120) + 'px';
  }

  // ---- 工具调用行 ----

  function createToolActionRow(toolName, detail, status) {
    var el = document.createElement('div');
    el.className = 'tool-action';
    el.setAttribute('data-tool', toolName);

    var iconEl = document.createElement('span');
    iconEl.className = 'tool-icon ' + (status || 'pending');
    iconEl.textContent = status === 'success' ? '✓' : status === 'error' ? '✗' : '⟳';
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
    btn.textContent = btn.getAttribute('aria-expanded') === 'true' ? '收起' : '还有 ' + collapsedEl.children.length + ' 条历史 · 展开';
  }

  function insertFoldableToolTraceGroup(traces, insertBeforeNode) {
    if (!elMessages || !traces || traces.length === 0) return;

    var wrap = document.createElement('div');
    wrap.className = 'tool-trace-group';
    var visible = document.createElement('div');
    visible.className = 'tool-trace-visible';

    var max = TOOL_TRACE_VISIBLE_MAX;
    if (traces.length <= max) {
      for (var i = 0; i < traces.length; i++) {
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

  function resetLiveToolRoundTargets() {
    liveToolRoundRoot = null;
    liveToolRoundVisible = null;
    liveToolRoundCollapsed = null;
    liveToolRoundToggle = null;
    liveToolRoundCount = 0;
  }

  function setLiveToolRoundActive(active) {
    liveToolRoundActive = active;
  }

  // ---- 消息渲染 ----

  function createMessageEl(msg, stripStatusTagFn) {
    var el = document.createElement('div');
    el.className = 'message ' + msg.role;

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = msg.role === 'user' ? 'You' : 'Assistant';
    el.appendChild(label);

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
    content.textContent = msg.role === 'agent' ? stripStatusTagFn(msg.content) : msg.content;
    el.appendChild(content);

    return el;
  }

  function renderMessagesOnly(messages, toolTraces, stripStatusTagFn, shouldScroll) {
    liveToolRoundActive = false;
    resetLiveToolRoundTargets();

    while (elMessages.firstChild !== elAnchor) {
      elMessages.removeChild(elMessages.firstChild);
    }

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var traces = msg.id ? toolTraces[msg.id] : null;
      if (traces && traces.length > 0) {
        insertFoldableToolTraceGroup(traces, elAnchor);
      }
      elMessages.insertBefore(createMessageEl(msg, stripStatusTagFn), elAnchor);
    }

    if (shouldScroll !== false) {
      scrollToBottom();
    }
  }

  function appendMessageEl(msg, stripStatusTagFn) {
    if (!elMessages) return;
    elMessages.insertBefore(createMessageEl(msg, stripStatusTagFn), elAnchor);
  }

  // ---- 流式输出 ----

  function appendStreamChunk(text, messages, stripStatusTagFn) {
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'agent' && lastMsg._streaming) {
      streamReplyBuffer += text;
      lastMsg.content = streamReplyBuffer;
    } else {
      repairOrphanStreamingIfAny(messages, stripStatusTagFn);
      streamReplyBuffer += text;
      messages.push({ role: 'agent', content: streamReplyBuffer, _streaming: true });

      var el = document.createElement('div');
      el.className = 'message assistant';
      el.setAttribute('id', 'streaming-msg');

      var label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = 'Assistant';
      el.appendChild(label);

      var contentDiv = document.createElement('div');
      contentDiv.textContent = stripStatusTagFn(streamReplyBuffer);
      el.appendChild(contentDiv);
      el._streamContentEl = contentDiv;

      elMessages.insertBefore(el, elAnchor);
      return;
    }

    var streamEl = document.getElementById('streaming-msg');
    if (!streamEl) {
      var wrap = document.createElement('div');
      wrap.className = 'message assistant';
      wrap.setAttribute('id', 'streaming-msg');
      var lab = document.createElement('div');
      lab.className = 'msg-label';
      lab.textContent = 'Assistant';
      wrap.appendChild(lab);
      var contentDiv = document.createElement('div');
      contentDiv.textContent = stripStatusTagFn(streamReplyBuffer);
      wrap.appendChild(contentDiv);
      wrap._streamContentEl = contentDiv;
      elMessages.insertBefore(wrap, elAnchor);
      return;
    }
    if (streamEl && streamEl._streamContentEl) {
      streamEl._streamContentEl.textContent = stripStatusTagFn(streamReplyBuffer);
    } else if (streamEl) {
      var contentEl = streamEl.lastChild;
      if (contentEl) {
        contentEl.textContent = stripStatusTagFn(streamReplyBuffer);
        streamEl._streamContentEl = contentEl;
      }
    }
  }

  function finalizeStreamResponse(messages, stripStatusTagFn) {
    var lastMsg = messages[messages.length - 1];
    var wasStreaming = !!(lastMsg && lastMsg._streaming);
    if (lastMsg && lastMsg._streaming) {
      delete lastMsg._streaming;
      lastMsg.content = stripStatusTagFn(lastMsg.content);
    }
    streamReplyBuffer = '';
    var streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      if (streamEl._streamContentEl) {
        streamEl._streamContentEl.textContent = stripStatusTagFn(streamEl._streamContentEl.textContent || '');
      }
      streamEl.removeAttribute('id');
      delete streamEl._streamContentEl;
    } else if (wasStreaming && lastMsg && lastMsg.role === 'agent' && (lastMsg.content || '').length > 0) {
      appendMessageEl(lastMsg, stripStatusTagFn);
    }
  }

  function getStreamingBubbleBodyText(streamEl) {
    if (!streamEl) return '';
    if (streamEl._streamContentEl) return streamEl._streamContentEl.textContent || '';
    var label = streamEl.querySelector('.msg-label');
    var n = label ? label.nextElementSibling : null;
    while (n && n.classList && n.classList.contains('msg-images')) {
      n = n.nextElementSibling;
    }
    return n ? (n.textContent || '') : '';
  }

  function repairOrphanStreamingIfAny(messages, stripStatusTagFn) {
    if (!elMessages) return;
    var streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;

    var bodyText = getStreamingBubbleBodyText(streamEl);
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent' && messages[i]._streaming) {
        messages[i].content = stripStatusTagFn(bodyText);
        delete messages[i]._streaming;
        break;
      }
    }

    streamEl.removeAttribute('id');
    delete streamEl._streamContentEl;
    streamReplyBuffer = '';
  }

  function finalizeBeforeUserMessage(messages, stripStatusTagFn) {
    var last = messages[messages.length - 1];
    if (last && last.role === 'agent' && last._streaming) {
      finalizeStreamResponse(messages, stripStatusTagFn);
    } else {
      repairOrphanStreamingIfAny(messages, stripStatusTagFn);
    }
  }

  // ---- 发送/停止按钮 ----

  function setStreamingState(streaming) {
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

  function getInputValue() {
    return elInput ? elInput.value : '';
  }

  function setInputValue(val) {
    if (elInput) elInput.value = val;
  }

  function focusInput() {
    if (elInput) elInput.focus();
  }

  return {
    init: init,
    scrollToBottom: scrollToBottom,
    isNearBottom: isNearBottom,
    autoResizeInput: autoResizeInput,
    renderMessagesOnly: renderMessagesOnly,
    appendMessageEl: appendMessageEl,
    appendStreamChunk: appendStreamChunk,
    finalizeStreamResponse: finalizeStreamResponse,
    finalizeBeforeUserMessage: finalizeBeforeUserMessage,
    repairOrphanStreamingIfAny: repairOrphanStreamingIfAny,
    appendToolAction: appendToolAction,
    updateLastToolAction: updateLastToolAction,
    resetLiveToolRoundTargets: resetLiveToolRoundTargets,
    setLiveToolRoundActive: setLiveToolRoundActive,
    setStreamingState: setStreamingState,
    getInputValue: getInputValue,
    setInputValue: setInputValue,
    focusInput: focusInput,
  };
})();
