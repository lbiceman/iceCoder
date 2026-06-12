/**
 * 命令面板模块（~ 命令）。
 * 浮层本身已统一为 ChatDropdown；本模块只负责数据 + 行为（键盘 / 输入过滤 / 应用选中的命令）。
 */

/* exported ChatCommands */

window.ChatCommands = (function () {
  'use strict';

  var PC_LOCAL_COMMANDS = [
    { name: 'open', description: '列出磁盘与文件夹，便于查找路径', prefix: '~' },
    { name: 'scan', description: '手机扫码连接，远程控制', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' },
    { name: 'supervisor', description: '查看 Supervisor 报告', prefix: '~' }
  ];

  var REMOTE_LOCAL_COMMANDS = [
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
  function getLocalCommands() { return remoteMode ? REMOTE_LOCAL_COMMANDS : PC_LOCAL_COMMANDS; }

  function updateActiveItem() {
    var dd = window.ChatDropdown && window.ChatDropdown.getContainer();
    if (!dd) return;
    var items = dd.querySelectorAll('.cmd-item');
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('active', j === cmdSelectedIndex);
    }
  }

  function isOpen() { return !!(window.ChatDropdown && window.ChatDropdown.isOpen()); }

  function show(prefix, filter, inputEl) {
    if (prefix !== '~') { hide(); return; }
    cmdActivePrefix = prefix;
    activeInputEl = inputEl || activeInputEl;
    var query = (filter || '').toLowerCase();
    var source = getLocalCommands();
    cmdFiltered = source.filter(function (cmd) {
      return cmd.name.toLowerCase().indexOf(query) >= 0;
    });
    if (cmdFiltered.length === 0) { hide(); return; }
    cmdSelectedIndex = 0;
    openDropdown();
  }

  function hide() {
    cmdFiltered = [];
    cmdActivePrefix = '';
    if (window.ChatDropdown && window.ChatDropdown.isOpen()) {
      window.ChatDropdown.close();
    }
  }

  function openDropdown() {
    if (!window.ChatDropdown || !anchorEl) return;
    var anchorRect = anchorEl.getBoundingClientRect();
    window.ChatDropdown.open({
      anchor: anchorEl,
      items: cmdFiltered,
      placement: 'top',
      placementRef: 'toolbar',
      align: 'center',
      fitContent: true,
      minWidth: Math.ceil(anchorRect.width),
      maxWidth: 300,
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

  function applySelection(index, inputEl) {
    if (index < 0 || index >= cmdFiltered.length) return null;
    var cmd = cmdFiltered[index];
    var value = cmdActivePrefix + cmd.name;
    var targetInput = inputEl || activeInputEl;
    if (applyTargetFn) {
      applyTargetFn(value);
    } else if (targetInput) {
      targetInput.value = value;
      dispatchInput(targetInput);
    }
    hide();
    return cmd;
  }

  function handleKeydown(e, inputEl) {
    var visible = !!(window.ChatDropdown && window.ChatDropdown.isOpen());
    if (!visible) return false;
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
    if (val.indexOf('~') === 0) {
      var rest = val.slice(1);
      var restTrim = rest.trim();
      var exactFull =
        rest === restTrim &&
        getLocalCommands().some(function (c) {
          return c.name.toLowerCase() === restTrim.toLowerCase();
        });
      if (exactFull) { hide(); return; }
      show('~', rest, inputEl);
    } else {
      hide();
    }
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

  function handleTelemetry(messages, appendFn, saveFn) {
    messages.push({ role: 'agent', content: '正在获取记忆系统遥测报告…' });
    appendFn(messages[messages.length - 1]);
    saveFn();
  }

  return {
    init: init,
    setAnchor: setAnchor,
    setRemoteMode: setRemoteMode,
    setApplyTarget: setApplyTarget,
    show: show,
    hide: hide,
    isOpen: isOpen,
    handleKeydown: handleKeydown,
    handleInput: handleInput,
    applySelection: applySelection,
    getLocalCommands: getLocalCommands,
    handleScan: handleScan,
    handleOpen: handleOpen,
    handleTelemetry: handleTelemetry,
  };
})();
