/**
 * 命令面板：`+` 按钮打开 ~ 本地命令；输入 `/` 在输入区上方打开独立 slash 命令面板。
 */

/* exported ChatCommands */

window.ChatCommands = (function () {
  'use strict';

  /** 行首，或任意空白（空格/换行/制表等）之后输入 / */
  var SLASH_TRIGGER_RE = /(?:^|\s)\/([^\s/]*)$/;

  var SLASH_LOCAL_COMMANDS = [
    { name: 'also', description: '为下次 LLM 调用附加补充说明', prefix: '/' },
    { name: 'next', description: '静默入队下一条任务', prefix: '/' }
  ];

  var TILDE_PC_COMMANDS = [
    { name: 'open', description: '列出磁盘与文件夹，便于查找路径', prefix: '~' },
    { name: 'scan', description: '手机扫码连接，远程控制', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' },
    { name: 'supervisor', description: '查看 Supervisor 报告', prefix: '~' }
  ];

  var TILDE_REMOTE_COMMANDS = [
    { name: 'open', description: '列出磁盘与文件夹，便于查找路径', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' },
    { name: 'supervisor', description: '查看 Supervisor 报告', prefix: '~' }
  ];

  var cmdSelectedIndex = 0;
  var cmdFiltered = [];
  var cmdActivePrefix = '';
  var remoteMode = false;
  var applyTargetFn = null;
  var activeInputEl = null;
  var anchorEl = null;
  var inputAnchorEl = null;

  function dispatchInput(inputEl) {
    if (!inputEl) return;
    try {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_err) {
      var ev = document.createEvent('Event');
      ev.initEvent('input', true, true);
      inputEl.dispatchEvent(ev);
    }
  }

  function setRemoteMode(isRemote) { remoteMode = !!isRemote; }
  function getTildeCommands() { return remoteMode ? TILDE_REMOTE_COMMANDS : TILDE_PC_COMMANDS; }
  function getSlashCommands() { return SLASH_LOCAL_COMMANDS; }
  function getLocalCommands() { return getTildeCommands().concat(getSlashCommands()); }

  function updateActiveItem() {
    var dd = window.ChatDropdown && window.ChatDropdown.getContainer();
    if (!dd) return;
    var items = dd.querySelectorAll('.cmd-item');
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('active', j === cmdSelectedIndex);
    }
  }

  function isOpen() {
    return !!(window.ChatDropdown && window.ChatDropdown.isOpen()
      && (cmdActivePrefix === '~' || cmdActivePrefix === '/'));
  }

  function isTildeOpen() {
    return !!(window.ChatDropdown && window.ChatDropdown.isOpen() && cmdActivePrefix === '~');
  }

  function findSlashCommandMatch(text) {
    if (!text) return null;
    var normalized = String(text);
    if (normalized.indexOf('/') === 0) normalized = normalized.slice(1);
    var commands = getSlashCommands();
    for (var i = 0; i < commands.length; i++) {
      if (normalized === commands[i].name) return commands[i];
    }
    return null;
  }

  function getInputCursor(inputEl, val) {
    if (inputEl && typeof inputEl.selectionStart === 'number') {
      return inputEl.selectionStart;
    }
    return val != null ? String(val).length : 0;
  }

  function parseSlashTrigger(val, inputEl) {
    if (val == null && inputEl) val = inputEl.value || '';
    if (!val) return null;
    var cursor = getInputCursor(inputEl, val);
    var before = String(val).slice(0, cursor);
    var m = before.match(SLASH_TRIGGER_RE);
    if (!m) return null;
    return { filter: (m[1] || '').toLowerCase(), matchLen: m[0].length, cursorEnd: cursor };
  }

  function replaceSlashTriggerInTextarea(inputEl, value) {
    if (!inputEl) return false;
    var val = inputEl.value || '';
    var trigger = parseSlashTrigger(val, inputEl);
    if (!trigger) return false;
    var end = trigger.cursorEnd != null ? trigger.cursorEnd : val.length;
    var start = end - trigger.matchLen;
    var prefix = val.slice(start, start + 1).match(/\s/) ? val.slice(start, start + 1) : '';
    var replacement = prefix + value;
    inputEl.value = val.slice(0, start) + replacement + val.slice(end);
    var cursor = start + replacement.length;
    if (typeof inputEl.setSelectionRange === 'function') {
      try { inputEl.setSelectionRange(cursor, cursor); } catch (_err) { /* ignore */ }
    }
    dispatchInput(inputEl);
    return true;
  }

  function show(prefix, filter, inputEl) {
    if (prefix !== '~' && prefix !== '/') { hide(); return; }
    if (window.ChatSkills && window.ChatSkills.isOpen && window.ChatSkills.isOpen()) {
      window.ChatSkills.hide();
    }
    if (prefix === '/' && isTildeOpen()) hide();
    cmdActivePrefix = prefix;
    activeInputEl = inputEl || activeInputEl;
    var query = (filter || '').toLowerCase();
    var source = prefix === '~' ? getTildeCommands() : getSlashCommands();
    cmdFiltered = source.filter(function (cmd) {
      return cmd.name.toLowerCase().indexOf(query) >= 0;
    });
    if (cmdFiltered.length === 0) { hide(); return; }
    cmdSelectedIndex = 0;
    openDropdown();
  }

  function hide() {
    var shouldClose = (cmdActivePrefix === '~' || cmdActivePrefix === '/')
      && window.ChatDropdown && window.ChatDropdown.isOpen();
    cmdFiltered = [];
    cmdActivePrefix = '';
    if (shouldClose) window.ChatDropdown.close();
  }

  function openDropdown() {
    var isSlash = cmdActivePrefix === '/';
    var anchor = isSlash ? (inputAnchorEl || anchorEl) : anchorEl;
    if (!window.ChatDropdown || !anchor) return;
    var anchorRect = anchor.getBoundingClientRect();
    window.ChatDropdown.open({
      anchor: anchor,
      items: cmdFiltered,
      placement: 'top',
      placementRef: isSlash ? 'anchor' : 'toolbar',
      align: isSlash ? 'start' : 'center',
      fitContent: true,
      minWidth: isSlash ? 200 : Math.ceil(anchorRect.width),
      maxWidth: isSlash ? 320 : 300,
      markAnchorActive: !isSlash,
      onSelect: function (item, idx) {
        applySelection(idx);
      },
      onClose: function () {
        cmdFiltered = [];
        cmdActivePrefix = '';
      },
    });
    // 选中态由 ChatDropdown 渲染时按 isCurrent 处理（命令面板没有 isCurrent 概念，
    // 但保留高亮当前 hover/keyboard 选中项的能力：渲染后立即把 cmdSelectedIndex 标 active）
    setTimeout(updateActiveItem, 0);
  }

  function setApplyTarget(fn) { applyTargetFn = typeof fn === 'function' ? fn : null; }
  function setAnchor(el) { anchorEl = el; }
  function setInputAnchor(el) { inputAnchorEl = el; }

  function applySelection(index, inputEl) {
    if (index < 0 || index >= cmdFiltered.length) return null;
    var cmd = cmdFiltered[index];
    var value = (cmd.prefix || cmdActivePrefix) + cmd.name;
    var targetInput = inputEl || activeInputEl;
    if (applyTargetFn && (cmd.prefix || cmdActivePrefix) === '~') {
      applyTargetFn(value);
    } else if (targetInput) {
      if (!replaceSlashTriggerInTextarea(targetInput, value)) {
        targetInput.value = value;
        dispatchInput(targetInput);
      }
    }
    hide();
    return cmd;
  }

  function handleKeydown(e, inputEl) {
    if (!isOpen()) return false;
    activeInputEl = inputEl || activeInputEl;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex + 1) % Math.max(cmdFiltered.length, 1);
      updateActiveItem();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdFiltered.length) % Math.max(cmdFiltered.length, 1);
      updateActiveItem();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      var trigger = parseSlashTrigger(null, inputEl);
      if (trigger && findSlashCommandMatch(trigger.filter)) {
        hide();
        if (e.key === 'Tab') {
          e.preventDefault();
          return true;
        }
        return false;
      }
      e.preventDefault();
      applySelection(cmdSelectedIndex, inputEl);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return true;
    }
    return false;
  }

  function handleInput(val, inputEl) {
    activeInputEl = inputEl || activeInputEl;
    var trigger = parseSlashTrigger(val, inputEl);
    if (cmdActivePrefix === '~') hide();
    if (!trigger) {
      if (cmdActivePrefix === '/') hide();
      return;
    }
    if (findSlashCommandMatch(trigger.filter)) {
      if (cmdActivePrefix === '/') hide();
      return;
    }
    show('/', trigger.filter, inputEl);
  }

  function init() {
    // 兼容旧调用：直接返回 null（旧版返回 dropdown 元素）。
    // 命令面板的触发元素由外部通过 setAnchor 注入。
    return null;
  }

  // ---- 命令处理 ----

  function handleScan(qrModule, messages, appendFn, saveFn) {
    qrModule.showQrCode(messages, appendFn, saveFn);
  }

  function handleOpen(ws, ui) {
    ui.showThinking(false);
    ws.sendMessage(
      '~open\n\n' +
      '[Directory browsing] If the user only gives a file name (no folder path), combine it with the directory from the most recent listing line labeled `[当前路径]` to build the full absolute path, then call parse_document, parse_pptx_deep, or open_file as needed.',
    );
  }

  function fetchJsonWithTimeout(url, timeoutMs) {
    var ms = timeoutMs || 30000;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return fetch(url, { signal: AbortSignal.timeout(ms) }).then(function (res) { return res.json(); });
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('请求超时')); }, ms);
      fetch(url)
        .then(function (res) { return res.json(); })
        .then(function (body) { clearTimeout(timer); resolve(body); })
        .catch(function (err) { clearTimeout(timer); reject(err); });
    });
  }

  function handleTelemetry(messages, appendFn, saveFn) {
    var telemetryMsg = { role: 'agent', content: '正在获取记忆系统遥测报告…' };
    if (window.ChatSession && typeof window.ChatSession.stampMessageTimestamps === 'function') {
      window.ChatSession.stampMessageTimestamps(telemetryMsg);
    }
    messages.push(telemetryMsg);
    appendFn(telemetryMsg);
    saveFn();

    fetchJsonWithTimeout('/api/memory/telemetry?days=7&format=text', 30000)
      .then(function (body) {
        var report = (body && body.success && body.report)
          ? body.report
          : ('遥测报告获取失败：' + ((body && body.error) || '未知错误'));
        if (window.ChatUI && typeof window.ChatUI.updateMessageContent === 'function') {
          var stripFn = window.ChatSession && window.ChatSession.stripStatusTag;
          window.ChatUI.updateMessageContent(telemetryMsg, report, stripFn || function (s) { return s; });
        } else {
          telemetryMsg.content = report;
        }
        saveFn();
      })
      .catch(function (err) {
        var errText = '遥测报告获取失败：' + (err && err.message ? err.message : '网络错误');
        if (window.ChatUI && typeof window.ChatUI.updateMessageContent === 'function') {
          var stripFn = window.ChatSession && window.ChatSession.stripStatusTag;
          window.ChatUI.updateMessageContent(telemetryMsg, errText, stripFn || function (s) { return s; });
        } else {
          telemetryMsg.content = errText;
        }
        saveFn();
      });
  }

  function parseSupervisorCommand(text) {
    var days = 7;
    var event = '';
    var m = String(text || '').match(/days=(\d+)/i);
    if (m) days = Math.min(Math.max(parseInt(m[1], 10) || 7, 1), 90);
    m = String(text || '').match(/event=([^\s]+)/i);
    if (m) event = m[1];
    return { days: days, event: event };
  }

  function handleSupervisor(text, messages, appendFn, saveFn) {
    var opts = parseSupervisorCommand(text);
    var pendingMsg = { role: 'agent', content: '正在获取 Supervisor 报告…' };
    if (window.ChatSession && typeof window.ChatSession.stampMessageTimestamps === 'function') {
      window.ChatSession.stampMessageTimestamps(pendingMsg);
    }
    messages.push(pendingMsg);
    appendFn(pendingMsg);
    saveFn();

    var qs = '?days=' + encodeURIComponent(String(opts.days)) + '&format=text';
    if (opts.event) qs += '&event=' + encodeURIComponent(opts.event);

    fetchJsonWithTimeout('/api/supervisor/events' + qs, 30000)
      .then(function (body) {
        var report = (body && body.success && body.report)
          ? body.report
          : ('Supervisor 报告获取失败：' + ((body && body.error) || '未知错误'));
        if (window.ChatUI && typeof window.ChatUI.updateMessageContent === 'function') {
          var stripFn = window.ChatSession && window.ChatSession.stripStatusTag;
          window.ChatUI.updateMessageContent(pendingMsg, report, stripFn || function (s) { return s; });
        } else {
          pendingMsg.content = report;
        }
        saveFn();
      })
      .catch(function (err) {
        var errText = 'Supervisor 报告获取失败：' + (err && err.message ? err.message : '网络错误');
        if (window.ChatUI && typeof window.ChatUI.updateMessageContent === 'function') {
          var stripFn = window.ChatSession && window.ChatSession.stripStatusTag;
          window.ChatUI.updateMessageContent(pendingMsg, errText, stripFn || function (s) { return s; });
        } else {
          pendingMsg.content = errText;
        }
        saveFn();
      });
  }

  return {
    init: init,
    setAnchor: setAnchor,
    setInputAnchor: setInputAnchor,
    setRemoteMode: setRemoteMode,
    setApplyTarget: setApplyTarget,
    show: show,
    hide: hide,
    isOpen: isOpen,
    isTildeOpen: isTildeOpen,
    handleKeydown: handleKeydown,
    handleInput: handleInput,
    applySelection: applySelection,
    getLocalCommands: getLocalCommands,
    handleScan: handleScan,
    handleOpen: handleOpen,
    handleTelemetry: handleTelemetry,
    handleSupervisor: handleSupervisor,
  };
})();
