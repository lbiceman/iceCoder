/**
 * 命令面板模块
 * 负责：~ 命令下拉框、本地命令处理（clear/open/scan/telemetry/export/memory）
 */

/* exported ChatCommands */

window.ChatCommands = (function () {
  'use strict';

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

  function handleClear(session, ui) {
    session.clearMessages();
    ui.renderMessagesOnly(session.getMessages(), session.getToolTraces(), session.stripStatusTag);
  }

  function handleScan(qrModule, messages, appendFn, saveFn) {
    qrModule.showQrCode(messages, appendFn, saveFn);
  }

  function handleOpen(ws, ui) {
    ui.showThinking(false);
    ws.sendMessage('~open\n\n' +
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

  function handleExport(messages, appendFn, saveFn) {
    messages.push({ role: 'agent', content: '正在导出记忆文件…' });
    appendFn(messages[messages.length - 1]);
    saveFn();

    fetch('/api/memory/stats')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.success || data.total === 0) {
          messages.pop();
          messages.push({ role: 'agent', content: '没有可导出的记忆文件。' });
          appendFn(messages[messages.length - 1]);
          saveFn();
          return;
        }
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
        appendFn(messages[messages.length - 1]);
        saveFn();
      })
      .catch(function (err) {
        messages.pop();
        messages.push({ role: 'agent', content: '记忆导出失败: ' + (err.message || '未知错误') });
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
    handleClear: handleClear,
    handleScan: handleScan,
    handleOpen: handleOpen,
    handleTelemetry: handleTelemetry,
    handleExport: handleExport,
    handleMemory: handleMemory,
  };
})();
