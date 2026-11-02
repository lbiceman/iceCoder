// @ts-nocheck
/**
 * 命令面板：`+` 按钮打开 ~ 本地命令；输入 `/` 在输入区上方打开独立 slash 命令面板。
 */

/* exported ChatCommands */

export const ChatCommands = (() => {

  /** 行首，或任意空白（空格/换行/制表等）之后输入 / */
  const SLASH_TRIGGER_RE = /(?:^|\s)\/([^\s/]*)$/;

  const SLASH_COMMAND_GROUPS = [
    {
      key: 'followup',
      label: '跟进',
      commands: [
        { name: 'also', description: '运行中注入用户备注（与主任务同等约束）', prefix: '/' },
        { name: 'next', description: '静默入队下一条任务', prefix: '/' }
      ]
    },
    {
      key: 'mode',
      label: '模式',
      commands: [
        { name: 'plan', description: '进入规划模式；可在同一条消息中继续写任务', prefix: '/' },
        { name: 'shell', description: '进入 Shell 协作模式；可在同一条消息中继续写连接说明或任务', prefix: '/' }
      ]
    },
    {
      key: 'browse',
      label: '浏览',
      commands: [
        { name: 'open', description: '列出磁盘与文件夹，便于查找路径', prefix: '/' }
      ]
    }
  ];

  const TILDE_PC_COMMANDS = [
    { name: 'scan', description: '手机扫码连接，远程控制', prefix: '~' },
    { name: 'tokens', description: '查看 Token 消耗统计', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' }
  ];

  const TILDE_REMOTE_COMMANDS = [
    { name: 'tokens', description: '查看 Token 消耗统计', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' }
  ];

  let cmdSelectedIndex = 0;
  let cmdFiltered = [];
  let cmdActivePrefix = '';
  let remoteMode = false;
  let applyTargetFn = null;
  let activeInputEl = null;
  let anchorEl = null;
  let inputAnchorEl = null;

  function dispatchInput(inputEl) {
    if (!inputEl) return;
    try {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_err) {
      const ev = document.createEvent('Event');
      ev.initEvent('input', true, true);
      inputEl.dispatchEvent(ev);
    }
  }

  function setRemoteMode(isRemote) { remoteMode = !!isRemote; }
  function getTildeCommands() { return remoteMode ? TILDE_REMOTE_COMMANDS : TILDE_PC_COMMANDS; }

  function getSlashCommands() {
    const list = [];
    for (let i = 0; i < SLASH_COMMAND_GROUPS.length; i++) {
      const cmds = SLASH_COMMAND_GROUPS[i].commands;
      for (let j = 0; j < cmds.length; j++) list.push(cmds[j]);
    }
    return list;
  }

  function buildSlashDropdownItems(filtered) {
    const byName = {};
    for (let i = 0; i < filtered.length; i++) byName[filtered[i].name] = filtered[i];
    const items = [];
    for (let g = 0; g < SLASH_COMMAND_GROUPS.length; g++) {
      const group = SLASH_COMMAND_GROUPS[g];
      const cmds = [];
      for (let j = 0; j < group.commands.length; j++) {
        const cmd = byName[group.commands[j].name];
        if (cmd) cmds.push(cmd);
      }
      if (!cmds.length) continue;
      items.push({ type: 'separator', label: group.label });
      for (let k = 0; k < cmds.length; k++) items.push(cmds[k]);
    }
    return items;
  }

  function indexOfFilteredCommand(item) {
    if (!item || item.type === 'separator' || item.isSeparator) return -1;
    for (let i = 0; i < cmdFiltered.length; i++) {
      if (cmdFiltered[i] === item || cmdFiltered[i].name === item.name) return i;
    }
    return -1;
  }

  function updateActiveItem() {
    const dd = window.ChatDropdown && window.ChatDropdown.getContainer();
    if (!dd) return;
    const items = dd.querySelectorAll('.cmd-item:not(.is-separator)');
    for (let j = 0; j < items.length; j++) {
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
    let normalized = String(text);
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
    const commands = getSlashCommands();
    for (let i = 0; i < commands.length; i++) {
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
    const cursor = getInputCursor(inputEl, val);
    const before = String(val).slice(0, cursor);
    const m = before.match(SLASH_TRIGGER_RE);
    if (!m) return null;
    return { filter: (m[1] || '').toLowerCase(), matchLen: m[0].length, cursorEnd: cursor };
  }

  function replaceSlashTriggerInTextarea(inputEl, value) {
    if (!inputEl) return false;
    const val = inputEl.value || '';
    const trigger = parseSlashTrigger(val, inputEl);
    if (!trigger) return false;
    const end = trigger.cursorEnd != null ? trigger.cursorEnd : val.length;
    const start = end - trigger.matchLen;
    const prefix = val.slice(start, start + 1).match(/\s/) ? val.slice(start, start + 1) : '';
    const replacement = prefix + value;
    inputEl.value = val.slice(0, start) + replacement + val.slice(end);
    const cursor = start + replacement.length;
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
    const query = (filter || '').toLowerCase();
    const source = prefix === '~' ? getTildeCommands() : getSlashCommands();
    cmdFiltered = source.filter((cmd) =>  cmd.name.toLowerCase().includes(query));
    if (cmdFiltered.length === 0) { hide(); return; }
    cmdSelectedIndex = 0;
    openDropdown();
  }

  function hide() {
    const shouldClose = (cmdActivePrefix === '~' || cmdActivePrefix === '/')
      && window.ChatDropdown && window.ChatDropdown.isOpen();
    cmdFiltered = [];
    cmdActivePrefix = '';
    if (shouldClose) window.ChatDropdown.close();
  }

  function openDropdown() {
    const isSlash = cmdActivePrefix === '/';
    const anchor = isSlash ? (inputAnchorEl || anchorEl) : anchorEl;
    if (!window.ChatDropdown || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const activePrefix = cmdActivePrefix;
    const filteredItems = cmdFiltered.slice();
    const displayItems = isSlash ? buildSlashDropdownItems(filteredItems) : filteredItems;
    window.ChatDropdown.open({
      anchor,
      items: displayItems,
      placement: 'top',
      placementRef: isSlash ? 'anchor' : 'toolbar',
      align: isSlash ? 'start' : 'center',
      fitContent: true,
      minWidth: isSlash ? 200 : Math.ceil(anchorRect.width),
      maxWidth: isSlash ? 320 : 300,
      markAnchorActive: !isSlash,
      onSelect(item) {
        const idx = indexOfFilteredCommand(item);
        if (idx >= 0) applySelection(idx);
      },
      onHighlight(item) {
        const idx = indexOfFilteredCommand(item);
        if (idx >= 0) cmdSelectedIndex = idx;
      },
      onClose() {
        // 刷新过滤列表时 ChatDropdown.open 会先 close 再 open；状态清理由 hide() 负责。
      },
    });
    cmdActivePrefix = activePrefix;
    cmdFiltered = filteredItems;
    // 选中态由 ChatDropdown 渲染时按 isCurrent 处理（命令面板没有 isCurrent 概念，
    // 但保留高亮当前 hover/keyboard 选中项的能力：渲染后立即把 cmdSelectedIndex 标 active）
    setTimeout(updateActiveItem, 0);
  }

  function setApplyTarget(fn) { applyTargetFn = typeof fn === 'function' ? fn : null; }
  function setAnchor(el) { anchorEl = el; }
  function setInputAnchor(el) { inputAnchorEl = el; }

  function applySelection(index, inputEl) {
    if (index < 0 || index >= cmdFiltered.length) return null;
    const cmd = cmdFiltered[index];
    const value = (cmd.prefix || cmdActivePrefix) + cmd.name;
    const targetInput = inputEl || activeInputEl;
    if (applyTargetFn && (cmd.prefix || cmdActivePrefix) === '~') {
      applyTargetFn(value);
    } else if (targetInput) {
      let slashValue = value;
      if (cmd.name === 'shell' || cmd.name === 'plan') slashValue = `${slashValue} `;
      if (!replaceSlashTriggerInTextarea(targetInput, slashValue)) {
        targetInput.value = slashValue;
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
      const trigger = parseSlashTrigger(null, inputEl);
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
    const trigger = parseSlashTrigger(val, inputEl);
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

  function fetchJsonWithTimeout(url, timeoutMs) {
    const ms = timeoutMs || 30000;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return fetch(url, { signal: AbortSignal.timeout(ms) }).then((res) =>  res.json());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('请求超时')); }, ms);
      fetch(url)
        .then((res) =>  res.json())
        .then((body) => { clearTimeout(timer); resolve(body); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  // Token 与记忆遥测共用一个弹层（reuseKey: usage），只切换标题和正文。
  const USAGE_VIEWS = {
    tokens: {
      title: 'Token 消耗',
      description: '按每次模型调用记账，与会话无关',
      label: 'Token 消耗',
    },
    telemetry: {
      title: '记忆遥测',
      description: '运行记录为最近 7 天，记忆库为当前存量',
      label: '记忆遥测',
    },
  };

  let usageSeq = 0;
  let usageView = '';
  const usageCache = { tokens: '', telemetry: '' };
  const usageCacheSeq = { tokens: 0, telemetry: 0 };

  function finiteNum(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return typeof n === 'number' && isFinite(n) ? n : 0;
  }

  function formatAgeDays(value) {
    const n = typeof value === 'number' && isFinite(value) ? value : 0;
    const rounded = Math.round(n * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 1e-6) return formatTokenCount(Math.round(rounded));
    return String(rounded);
  }

  function panelRow(label, hint, value, empty) {
    const valueClass = empty ? 'modal-panel-row-value is-empty' : 'modal-panel-row-value';
    return (
      '<div class="modal-panel-row">' +
        '<div class="modal-panel-row-meta">' +
          `<span class="modal-panel-row-label">${escapeTokenStatsText(label)}</span>` +
          `<span class="modal-panel-row-hint">${escapeTokenStatsText(hint)}</span>` +
        '</div>' +
        `<span class="${valueClass}">${escapeTokenStatsText(value)}</span>` +
      '</div>'
    );
  }

  function renderUsageSwitch(active) {
    const keys = ['tokens', 'telemetry'];
    let html = '<div class="modal-panel-switch" role="group" aria-label="统计内容">';
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const pressed = key === active ? 'true' : 'false';
      html +=
        `<button type="button" class="modal-panel-switch-btn" data-usage-view="${key}" aria-pressed="${pressed}">${escapeTokenStatsText(USAGE_VIEWS[key].label)}</button>`;
    }
    html += '</div>';
    return html;
  }

  function renderTelemetryReport(body) {
    const days = finiteNum(body && body.days) || 7;
    const log = (body && body.log) || {};
    const proc = (body && body.process) || {};
    const store = (body && body.store) || {};
    const recallLog = log.recall || {};
    const extractLog = log.extract || {};
    const dreamLog = log.dream || {};
    const capLog = log.capEvict || {};

    const recallLogCount = finiteNum(recallLog.count);
    const recallCount = recallLogCount || finiteNum(proc.totalRecalls);
    let activity = '';
    if (recallCount > 0) {
      const llmRate = Math.round(recallLogCount > 0 ? finiteNum(recallLog.llmRate) : finiteNum(proc.llmRecallRate));
      const keywordRate = Math.max(0, 100 - llmRate);
      const avgMs = recallLogCount > 0 ? finiteNum(recallLog.avgMs) : finiteNum(proc.avgRecallMs);
      const selected = finiteNum(recallLog.totalSelected) || finiteNum(proc.totalMemoriesSelected);
      activity += panelRow(
        '召回',
        `LLM ${formatTokenCount(llmRate)}% · 关键词 ${formatTokenCount(keywordRate)}% · 平均 ${formatTokenCount(avgMs)}ms · 选中 ${formatTokenCount(selected)} 条`,
        `${formatTokenCount(recallCount)} 次`,
      );
    } else {
      activity += panelRow('召回', `最近 ${days} 天`, '暂无', true);
    }

    const extractLogCount = finiteNum(extractLog.count);
    const extractCount = extractLogCount || finiteNum(proc.totalExtracts);
    const skipCount = finiteNum(extractLog.skipCount);
    if (extractCount > 0) {
      const cacheRate = Math.round(extractLogCount > 0 ? finiteNum(extractLog.cacheHitRate) : finiteNum(proc.cacheHitRate));
      const avgMs = extractLogCount > 0 ? finiteNum(extractLog.avgMs) : finiteNum(proc.avgExtractMs);
      const total = finiteNum(extractLog.totalMemories) || finiteNum(proc.totalMemoriesExtracted);
      let hint = `cache 命中 ${formatTokenCount(cacheRate)}% · 平均 ${formatTokenCount(avgMs)}ms · 提取 ${formatTokenCount(total)} 条`;
      if (skipCount > 0) hint += ` · 跳过 ${formatTokenCount(skipCount)}`;
      activity += panelRow('提取', hint, `${formatTokenCount(extractCount)} 次`);
    } else if (skipCount > 0) {
      activity += panelRow('提取', `跳过 ${formatTokenCount(skipCount)}`, '0 次');
    } else {
      activity += panelRow('提取', `最近 ${days} 天`, '暂无', true);
    }

    const dreamCount = finiteNum(dreamLog.count) || finiteNum(proc.totalDreams);
    if (dreamCount > 0) {
      const evicted = finiteNum(dreamLog.totalEvicted);
      let hint = `Dream · 修改 ${formatTokenCount(finiteNum(dreamLog.totalModified))} · 删除 ${formatTokenCount(finiteNum(dreamLog.totalDeleted))}`;
      if (evicted > 0) hint += ` · 淘汰 ${formatTokenCount(evicted)}`;
      hint += ` · 平均 ${formatTokenCount(finiteNum(dreamLog.avgMs))}ms`;
      activity += panelRow('整合', hint, `${formatTokenCount(dreamCount)} 次`);
    } else {
      activity += panelRow('整合', 'Dream', '暂无', true);
    }

    const capCount = finiteNum(capLog.count);
    if (capCount > 0) {
      activity += panelRow(
        '条数淘汰',
        `归档 ${formatTokenCount(finiteNum(capLog.totalFilesEvicted))} 条 · 平均 ${formatTokenCount(finiteNum(capLog.avgMs))}ms`,
        `${formatTokenCount(capCount)} 次`,
      );
    }

    const files = finiteNum(store.totalFiles);
    let storeHtml = '';
    if (files > 0) {
      const byType = store.byType && typeof store.byType === 'object' ? store.byType : {};
      const typeNames = Object.keys(byType);
      const typeHint = typeNames.length
        ? typeNames.map((name) => `${name} ${formatTokenCount(finiteNum(byType[name]))}`).join(' · ')
        : '当前存量';
      storeHtml += panelRow('记忆库', typeHint, formatTokenCount(files));
      storeHtml += panelRow(
        '库龄',
        `最老 ${formatAgeDays(store.maxAgeDays)} 天`,
        `${formatAgeDays(store.avgAgeDays)} 天`,
      );
    } else {
      storeHtml += panelRow('记忆库', '尚未创建记忆文件', '空', true);
    }

    return `<div class="modal-panel-card">${activity}</div><div class="modal-panel-card">${storeHtml}</div>`;
  }

  function bindUsageSwitch(panel) {
    if (!panel || panel._usageBound || !panel.toolbar) return;
    panel._usageBound = true;
    panel.toolbar.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-usage-view]') : null;
      if (!btn || !panel.toolbar.contains(btn)) return;
      const view = btn.getAttribute('data-usage-view');
      if (!view || view === usageView || !USAGE_VIEWS[view]) return;
      showUsagePanel(view);
    });
  }

  function publishUsage(panel, seq, view, html) {
    if (seq >= usageCacheSeq[view]) {
      usageCacheSeq[view] = seq;
      usageCache[view] = html;
    }
    if (seq !== usageSeq || !panel) return;
    panel.setBody(html);
  }

  function publishUsageError(panel, seq, message) {
    if (seq !== usageSeq || !panel) return;
    panel.setBody(`<p class="modal-panel-error">${escapeTokenStatsText(message)}</p>`);
  }

  function loadTokenStats(panel, seq) {
    fetchJsonWithTimeout('/api/token-usage', 30000)
      .then((body) => {
        if (body && body.success) {
          publishUsage(panel, seq, 'tokens', renderTokenStatsWindows(body));
          return;
        }
        publishUsageError(panel, seq, '统计失败：' + ((body && body.error) || '统计失败'));
      })
      .catch((err) => {
        publishUsageError(panel, seq, '统计失败：' + (err && err.message ? err.message : '网络错误'));
      });
  }

  function loadTelemetry(panel, seq) {
    fetchJsonWithTimeout('/api/memory/telemetry?days=7&format=json', 30000)
      .then((body) => {
        if (body && body.success) {
          publishUsage(panel, seq, 'telemetry', renderTelemetryReport(body));
          return;
        }
        publishUsageError(panel, seq, '遥测报告获取失败：' + ((body && body.error) || '未知错误'));
      })
      .catch((err) => {
        publishUsageError(panel, seq, '遥测报告获取失败：' + (err && err.message ? err.message : '网络错误'));
      });
  }

  function showUsagePanel(view) {
    const meta = USAGE_VIEWS[view];
    if (!meta) return;
    if (!window.Modal || typeof window.Modal.panel !== 'function') return;
    const seq = ++usageSeq;
    usageView = view;
    const panel = window.Modal.panel({
      reuseKey: 'usage',
      title: meta.title,
      description: meta.description,
      toolbarHtml: renderUsageSwitch(view),
      bodyHtml: usageCache[view] || usageLoadingHtml(),
    });
    if (!panel) return;
    bindUsageSwitch(panel);
    if (view === 'tokens') loadTokenStats(panel, seq);
    else loadTelemetry(panel, seq);
  }

  function handleTelemetry() {
    showUsagePanel('telemetry');
  }

  function formatTokenCount(n) {
    const num = typeof n === 'number' && isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    try {
      return num.toLocaleString();
    } catch (_err) {
      return String(num);
    }
  }

  function escapeTokenStatsText(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderTokenStatsWindows(windows) {
    const rows = [
      { key: 'day', label: '最近一天', hint: '24 小时' },
      { key: 'week', label: '最近一周', hint: '7 天' },
      { key: 'month', label: '最近一个月', hint: '30 天' },
    ];
    let html = '<div class="modal-panel-card">';
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const usage = windows && windows[row.key] ? windows[row.key] : {};
      const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : 0;
      html +=
        `<div class="modal-panel-row"><div class="modal-panel-row-meta"><span class="modal-panel-row-label">${row.label}</span><span class="modal-panel-row-hint">${row.hint}</span></div><span class="modal-panel-row-value">${formatTokenCount(total)}</span></div>`;
    }
    html += '</div>';
    const byModel = windows && windows.byModel ? windows.byModel : null;
    const modelNames = byModel ? Object.keys(byModel).sort() : [];
    if (modelNames.length > 0) {
      html += '<div class="modal-panel-card">';
      for (let j = 0; j < modelNames.length; j++) {
        const name = modelNames[j];
        const modelUsage = byModel[name] && byModel[name].month ? byModel[name].month : {};
        const modelTotal = typeof modelUsage.totalTokens === 'number' ? modelUsage.totalTokens : 0;
        html +=
          `<div class="modal-panel-row"><div class="modal-panel-row-meta"><span class="modal-panel-row-label">${escapeTokenStatsText(name)}</span><span class="modal-panel-row-hint">最近一个月</span></div><span class="modal-panel-row-value">${formatTokenCount(modelTotal)}</span></div>`;
      }
      html += '</div>';
    }
    return html;
  }

  function usageLoadingHtml() {
    return (
      '<div class="modal-panel-card" aria-busy="true">' +
        '<div class="modal-panel-row"><span class="modal-panel-skel"></span><span class="modal-panel-skel is-value"></span></div>' +
        '<div class="modal-panel-row"><span class="modal-panel-skel"></span><span class="modal-panel-skel is-value"></span></div>' +
        '<div class="modal-panel-row"><span class="modal-panel-skel"></span><span class="modal-panel-skel is-value"></span></div>' +
      '</div>'
    );
  }

  function handleTokenStats() {
    showUsagePanel('tokens');
  }

  return {
    init,
    setAnchor,
    setInputAnchor,
    setRemoteMode,
    setApplyTarget,
    show,
    hide,
    isOpen,
    isTildeOpen,
    handleKeydown,
    handleInput,
    applySelection,
    handleTelemetry,
    handleTokenStats,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatCommands = ChatCommands;
}
