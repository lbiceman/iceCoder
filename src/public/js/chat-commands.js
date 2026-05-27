/**
 * 命令面板模块
 * 负责：~ 命令下拉框、本地命令处理（open/scan/telemetry/memory）
 */

/* exported ChatCommands */

window.ChatCommands = (function () {
  'use strict';

  var PC_LOCAL_COMMANDS = [
    { name: 'open', description: '列出磁盘与文件夹，便于查找路径', prefix: '~' },
    { name: 'scan', description: '手机扫码连接，远程控制', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' },
    { name: 'supervisor', description: '查看 Supervisor / Execution Mode 事件报告', prefix: '~' },
    { name: 'memory', description: '~memory：打开图谱页；后缀 view/delete 仍在聊天执行', prefix: '~' }
  ];

  var REMOTE_LOCAL_COMMANDS = [
    { name: 'open', description: '列出磁盘与文件夹，便于查找路径', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' },
    { name: 'supervisor', description: '查看 Supervisor / Execution Mode 事件报告', prefix: '~' },
    { name: 'memory', description: '~memory：打开图谱页；后缀 view/delete 仍在聊天执行', prefix: '~' }
  ];

  var elCmdDropdown = null;
  var cmdSelectedIndex = 0;
  var cmdVisible = false;
  var cmdFiltered = [];
  var cmdActivePrefix = '';
  var remoteMode = false;

  function setRemoteMode(isRemote) {
    remoteMode = isRemote;
  }

  function getLocalCommands() {
    return remoteMode ? REMOTE_LOCAL_COMMANDS : PC_LOCAL_COMMANDS;
  }

  function createDropdown() {
    var el = document.createElement('div');
    el.className = 'cmd-dropdown hidden';
    el.setAttribute('id', 'cmd-dropdown');
    return el;
  }

  function show(prefix, filter) {
    if (!elCmdDropdown) return;
    if (prefix !== '~') {
      hide();
      return;
    }
    cmdActivePrefix = prefix;
    var query = (filter || '').toLowerCase();
    var source = getLocalCommands();
    cmdFiltered = source.filter(function (cmd) {
      return cmd.name.toLowerCase().indexOf(query) >= 0;
    });
    if (cmdFiltered.length === 0) {
      hide();
      return;
    }
    cmdSelectedIndex = 0;
    render();
    elCmdDropdown.classList.remove('hidden');
    cmdVisible = true;
  }

  function hide() {
    if (!elCmdDropdown) return;
    elCmdDropdown.classList.add('hidden');
    cmdVisible = false;
    cmdFiltered = [];
    cmdActivePrefix = '';
  }

  function render() {
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
          render();
        });
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          select(idx);
        });
        item.addEventListener('touchend', function (e) {
          e.preventDefault();
          select(idx);
        });
      })(i);
      elCmdDropdown.appendChild(item);
    }
  }

  function select(index) {
    if (index < 0 || index >= cmdFiltered.length) return;
    return cmdFiltered[index];
  }

  function handleKeydown(e, inputEl) {
    if (!cmdVisible) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdFiltered.length;
      render();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdFiltered.length) % cmdFiltered.length;
      render();
      return true;
    }
    // Tab 或 Enter（非 Shift+换行）— 将当前高亮项写入输入框并关闭面板
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      if (inputEl && cmdFiltered.length) {
        var cmd = cmdFiltered[cmdSelectedIndex];
        if (cmd) {
          inputEl.value = cmdActivePrefix + cmd.name;
          hide();
          try {
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          } catch (_err) {
            /* IE / 极旧环境可能无 Event 构造 */
            var ev = document.createEvent('Event');
            ev.initEvent('input', true, true);
            inputEl.dispatchEvent(ev);
          }
        }
      }
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return true;
    }
    return false;
  }

  function handleInput(val) {
    if (val.indexOf('~') === 0) {
      var rest = val.slice(1);
      var restTrim = rest.trim();
      var exactFull =
        rest === restTrim &&
        getLocalCommands().some(function (c) {
          return c.name.toLowerCase() === restTrim.toLowerCase();
        });
      if (exactFull) {
        hide();
        return;
      }
      show('~', rest);
    } else {
      hide();
    }
  }

  function getDropdownEl() {
    return elCmdDropdown;
  }

  function init() {
    elCmdDropdown = createDropdown();
    return elCmdDropdown;
  }

  // ---- 命令处理 ----

  function handleScan(qrModule, messages, appendFn, saveFn) {
    qrModule.showQrCode(messages, appendFn, saveFn);
  }

  function handleOpen(ws, ui) {
    ui.showThinking(false);
    // ~open：发给模型的指令为英文。中文含义——用户若只给文件名，须结合最近一次目录列表里的 `[当前路径]` 拼成绝对路径后再调用 parse_document / parse_pptx_deep / open_file。
    ws.sendMessage(
      '~open\n\n' +
      '[Directory browsing] If the user only gives a file name (no folder path), combine it with the directory from the most recent listing line labeled `[当前路径]` to build the full absolute path, then call parse_document, parse_pptx_deep, or open_file as needed.',
    );
  }

  function handleTelemetry(messages, appendFn, saveFn) {
    messages.push({ role: 'agent', content: '正在获取记忆系统遥测报告…' });
    appendFn(messages[messages.length - 1]);
    saveFn();

    fetch('/api/memory/telemetry')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        messages.pop();
        if (data.success && data.report) {
          messages.push({ role: 'agent', content: data.report });
        } else {
          messages.push({ role: 'agent', content: '获取遥测报告失败: ' + (data.error || '未知错误') });
        }
        appendFn(messages[messages.length - 1]);
        saveFn();
      })
      .catch(function () {
        messages.pop();
        messages.push({ role: 'agent', content: '获取遥测报告失败，请检查服务器是否运行' });
        appendFn(messages[messages.length - 1]);
        saveFn();
      });
  }

  function parseSupervisorCommandArgs(text) {
    var args = { days: 7, event: '', limit: 10 };
    var rest = text.substring('~supervisor'.length).trim();
    if (!rest) return args;
    var parts = rest.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.indexOf('days=') === 0) args.days = parseInt(p.slice(5), 10) || args.days;
      else if (p.indexOf('event=') === 0) args.event = p.slice(6);
      else if (p.indexOf('limit=') === 0) args.limit = parseInt(p.slice(6), 10) || args.limit;
    }
    return args;
  }

  function handleSupervisor(text, messages, appendFn, saveFn) {
    var opts = parseSupervisorCommandArgs(text);
    messages.push({ role: 'agent', content: '正在获取 Supervisor 事件报告…' });
    appendFn(messages[messages.length - 1]);
    saveFn();

    var qs = '?days=' + encodeURIComponent(String(opts.days))
      + '&limit=' + encodeURIComponent(String(opts.limit));
    if (opts.event) qs += '&event=' + encodeURIComponent(opts.event);

    fetch('/api/supervisor/events' + qs)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        messages.pop();
        if (data.success && data.report) {
          messages.push({ role: 'agent', content: data.report });
        } else {
          messages.push({ role: 'agent', content: '获取 Supervisor 报告失败: ' + (data.error || '未知错误') });
        }
        appendFn(messages[messages.length - 1]);
        saveFn();
      })
      .catch(function () {
        messages.pop();
        messages.push({ role: 'agent', content: '获取 Supervisor 报告失败，请检查服务器是否运行' });
        appendFn(messages[messages.length - 1]);
        saveFn();
      });
  }

  function handleMemory(text, messages, appendFn, saveFn) {
    var memArgs = text.substring(7).trim();

    if (memArgs.indexOf('view ') === 0) {
      var viewFilename = memArgs.substring(5).trim();
      if (!viewFilename) {
        messages.push({ role: 'agent', content: '用法: ~memory view <文件名>' });
        appendFn(messages[messages.length - 1]);
        saveFn();
        return;
      }
      messages.push({ role: 'agent', content: '正在读取: ' + viewFilename + '…' });
      appendFn(messages[messages.length - 1]);
      saveFn();

      fetch('/api/memory/files/' + encodeURIComponent(viewFilename))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          messages.pop();
          if (data.success) {
            messages.push({ role: 'agent', content: '📄 **' + viewFilename + '** (' + data.level + '级)\n\n```markdown\n' + data.content + '\n```' });
          } else {
            messages.push({ role: 'agent', content: '❌ 读取失败: ' + (data.error || '未知错误') });
          }
          appendFn(messages[messages.length - 1]);
          saveFn();
        })
        .catch(function (err) {
          messages.pop();
          messages.push({ role: 'agent', content: '❌ 读取失败: ' + (err.message || '网络错误') });
          appendFn(messages[messages.length - 1]);
          saveFn();
        });
      return;
    }

    if (memArgs.indexOf('delete ') === 0) {
      var delFilename = memArgs.substring(7).trim();
      if (!delFilename) {
        messages.push({ role: 'agent', content: '用法: ~memory delete <文件名>' });
        appendFn(messages[messages.length - 1]);
        saveFn();
        return;
      }
      messages.push({ role: 'agent', content: '正在删除记忆: ' + delFilename + '…' });
      appendFn(messages[messages.length - 1]);
      saveFn();

      fetch('/api/memory/files/' + encodeURIComponent(delFilename), { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          messages.pop();
          if (data.success) {
            messages.push({ role: 'agent', content: '✅ 已删除记忆: ' + delFilename });
          } else {
            messages.push({ role: 'agent', content: '❌ 删除失败: ' + (data.error || '未知错误') });
          }
          appendFn(messages[messages.length - 1]);
          saveFn();
        })
        .catch(function (err) {
          messages.pop();
          messages.push({ role: 'agent', content: '❌ 删除失败: ' + (err.message || '网络错误') });
          appendFn(messages[messages.length - 1]);
          saveFn();
        });
      return;
    }

    // 无参数：列出所有记忆
    messages.push({ role: 'agent', content: '正在加载记忆列表…' });
    appendFn(messages[messages.length - 1]);
    saveFn();

    fetch('/api/memory/files')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        messages.pop();
        if (!data.success || !data.files || data.files.length === 0) {
          messages.push({ role: 'agent', content: '📭 暂无记忆文件。' });
          appendFn(messages[messages.length - 1]);
          saveFn();
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
        appendFn(messages[messages.length - 1]);
        saveFn();
      })
      .catch(function (err) {
        messages.pop();
        messages.push({ role: 'agent', content: '加载记忆列表失败: ' + (err.message || '网络错误') });
        appendFn(messages[messages.length - 1]);
        saveFn();
      });
  }

  return {
    init: init,
    show: show,
    hide: hide,
    render: render,
    select: select,
    handleKeydown: handleKeydown,
    handleInput: handleInput,
    getDropdownEl: getDropdownEl,
    setRemoteMode: setRemoteMode,
    handleScan: handleScan,
    handleOpen: handleOpen,
    handleTelemetry: handleTelemetry,
    handleSupervisor: handleSupervisor,
    handleMemory: handleMemory,
  };
})();
