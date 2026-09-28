// @ts-nocheck
/**
 * 配置页 — MCP 配置面板（左服务器列表 + 右详情 / 工具表 / JSON 编辑）。
 */

/* exported McpConfigPanel */

export const McpConfigPanel = (() => {

  let container = null;
  let servers = [];
  let selectedName = null;
  let pollTimer = null;
  let configPath = '';
  let toolsExpanded = true;
  let configDirty = false;
  let draftServers = {};
  let nextDraftId = 1;
  let loadingConfig = false;
  let pendingDeleteNames = {};
  let mobileExpanded = false;

  function isMobile() {
    return window.innerWidth <= 720;
  }

  function isListItemActive(name) {
    if (isMobile()) return mobileExpanded && name === selectedName;
    return name === selectedName;
  }

  function getDetailElForServer(name) {
    if (isMobile()) {
      const inlineItems = container.querySelectorAll('.config-list-item-detail');
      for (let i = 0; i < inlineItems.length; i++) {
        if (inlineItems[i].getAttribute('data-name') === name) return inlineItems[i];
      }
      return null;
    }
    if (name === selectedName) return container.querySelector('#mcp-detail');
    return null;
  }

  function getActiveDetailEl() {
    if (!selectedName) return container.querySelector('#mcp-detail');
    return getDetailElForServer(selectedName) || container.querySelector('#mcp-detail');
  }

  function collapseMobile() {
    if (!isMobile() || !mobileExpanded) return;
    mobileExpanded = false;
    renderAll();
  }

  function handleListItemClick(name) {
    if (!isMobile()) {
      selectServer(name);
      return;
    }
    if (mobileExpanded && name === selectedName) {
      mobileExpanded = false;
      renderAll();
      return;
    }
    mobileExpanded = true;
    selectServer(name);
  }

  const NEW_SERVER_TEMPLATE = {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-example'],
    disabled: true,
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function isDraftName(name) {
    return !!draftServers[name];
  }

  function statusLabel(status) {
    switch (status) {
      case 'ready': return '运行中';
      case 'error': return '连接失败';
      case 'disabled': return '已停止';
      case 'starting': return '启动中';
      case 'stopped': return '离线';
      case 'draft': return '未保存';
      default: return status || '未知';
    }
  }

  function mcpStatusPresentation(srv) {
    const status = srv && srv.status;
    if (status === 'ready' && srv.backendSession === 'detached') {
      return { label: '运行中 · 未挂上标签', dot: 'dot-warn' };
    }
    return { label: statusLabel(status), dot: dotClass(status) };
  }

  function dotClass(status) {
    switch (status) {
      case 'ready': return 'dot-green';
      case 'error': return 'dot-red';
      case 'disabled': return 'dot-gray';
      case 'draft': return 'dot-gray';
      default: return 'dot-gray';
    }
  }

  function fetchStatus(callback) {
    fetch('/api/mcp')
      .then((res) =>  res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || '加载失败');
        callback(null, body);
      })
      .catch((err) => {
        callback(err, null);
      });
  }

  function fetchServerConfig(name, callback) {
    fetch(`/api/mcp/servers/${encodeURIComponent(name)}/config`)
      .then((res) =>  res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || '加载配置失败');
        callback(null, body.config);
      })
      .catch((err) => {
        callback(err, null);
      });
  }

  function pickSelectedName() {
    if (selectedName && (isDraftName(selectedName) || servers.some((s) =>  s.name === selectedName))) {
      return selectedName;
    }
    const drafts = Object.keys(draftServers);
    if (drafts.length) return drafts[0];
    if (servers.length) return servers[0].name;
    return null;
  }

  function applyStatusBody(body) {
    servers = body.servers || [];
    configPath = body.configPath || configPath || '.iceCoder/mcp.json';

    Object.keys(pendingDeleteNames).forEach((name) => {
      const stillThere = servers.some((s) =>  s.name === name);
      if (!stillThere) {
        delete pendingDeleteNames[name];
      } else {
        servers = servers.filter((s) =>  s.name !== name);
      }
    });

    selectedName = pickSelectedName();
  }

  function removeServerFromLocalState(name) {
    delete draftServers[name];
    pendingDeleteNames[name] = true;
    servers = servers.filter((s) =>  s.name !== name);
    loadingConfig = false;
    configDirty = false;
    selectedName = pickSelectedName();
    renderAll();
  }

  function getAllListItems() {
    const items = servers.slice();
    Object.keys(draftServers).forEach((name) => {
      if (!items.some((s) =>  s.name === name)) {
        items.push({
          name,
          status: 'draft',
          toolCount: 0,
          toolsDetail: [],
          config: draftServers[name],
        });
      }
    });
    return items;
  }

  function applySelectedServer(name) {
    selectedName = name;
    renderAll();
  }

  function selectServer(name) {
    if (configDirty && name !== selectedName) {
      window.Modal.confirm({
        title: '未保存的修改',
        message: '当前配置尚未保存，切换将丢弃修改，是否继续？',
        type: 'warning',
        confirmText: '继续',
        cancelText: '取消',
      }).then((ok) => {
        if (!ok) return;
        configDirty = false;
        applySelectedServer(name);
      });
      return;
    }
    applySelectedServer(name);
  }

  function renderList() {
    const listEl = container.querySelector('#mcp-server-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const list = getAllListItems();
    if (!list.length) {
      listEl.innerHTML = '<div class="config-list-empty">暂无 MCP 服务器，点击「新增」添加。</div>';
      return;
    }

    for (let i = 0; i < list.length; i++) {
      ((srv) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'config-list-item' + (isListItemActive(srv.name) ? ' is-active' : '');
        const present = mcpStatusPresentation(srv);
        const toolText = srv.status === 'draft'
          ? '未保存'
          : (srv.backendSession === 'detached'
            ? '未挂上标签' + (srv.toolCount != null ? ` · ${srv.toolCount} 个工具` : '')
            : (srv.toolCount != null ? `${srv.toolCount} 个工具` : '—'));
        btn.innerHTML =
          `<div class="config-list-item-head"><span class="config-list-item-name">${escapeHtml(srv.name)}</span><span class="config-status-dot ${present.dot}" aria-hidden="true"></span></div><div class="config-list-item-sub">${escapeHtml(toolText)}</div>`;
        btn.addEventListener('click', (e) => {
          if (e.target.closest('.config-list-item-detail')) return;
          e.stopPropagation();
          handleListItemClick(srv.name);
        });
        if (isMobile() && mobileExpanded && srv.name === selectedName) {
          btn.classList.add('is-expanded');
          const detailDiv = document.createElement('div');
          detailDiv.className = 'config-list-item-detail';
          detailDiv.setAttribute('data-name', srv.name);
          detailDiv.innerHTML = buildMcpDetailHtml(srv);
          btn.appendChild(detailDiv);
          populateMcpDetailContent(detailDiv, srv);
        }
        listEl.appendChild(btn);
      })(list[i]);
    }
  }

  function isRunningStatus(status) {
    return status === 'ready' || status === 'starting';
  }

  function renderActionButtons(srv) {
    if (srv.status === 'draft') {
      return '<div class="config-detail-actions"></div>';
    }
    if (isRunningStatus(srv.status)) {
      return (
        '<div class="config-detail-actions">' +
          '<button type="button" class="skills-btn skills-btn-primary" id="mcp-btn-restart">重启</button>' +
          '<button type="button" class="skills-btn skills-btn-danger" id="mcp-btn-stop">关闭</button>' +
        '</div>'
      );
    }

    return (
      '<div class="config-detail-actions">' +
        '<button type="button" class="skills-btn skills-btn-primary" id="mcp-btn-start">启动</button>' +
      '</div>'
    );
  }

  function parseApiResponse(res) {
    return res.text().then((text) => {
      if (!text) return { success: res.ok, error: res.ok ? null : '空响应' };
      try {
        return JSON.parse(text);
      } catch (_e) {
        if (res.status === 404) {
          throw new Error('接口未就绪，请重启 API 服务（npm run dev）后重试');
        }
        throw new Error(`服务返回非 JSON 响应（HTTP ${res.status}）`);
      }
    });
  }

  function bindServerAction(detailEl, serverName, btnId, endpoint, labels) {
    const btn = detailEl.querySelector(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = labels.loading;
      fetch(`/api/mcp/servers/${encodeURIComponent(serverName)}/${endpoint}`, { method: 'POST' })
        .then((res) =>  parseApiResponse(res))
        .then((body) => {
          if (!body.success) throw new Error(body.error || labels.fail);
          Notification.success(labels.success);
          reloadData();
        })
        .catch((err) => {
          Notification.error(labels.fail + '：' + (err.message || '未知错误'));
        })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = labels.idle;
        });
    });
  }

  function bindActionButtons(detailEl, srv) {
    if (srv.status === 'draft') return;
    if (isRunningStatus(srv.status)) {
      bindServerAction(detailEl, srv.name, '#mcp-btn-restart', 'restart', {
        idle: '重启',
        loading: '重启中…',
        success: `${srv.name} 已重启`,
        fail: '重启失败',
      });
      bindServerAction(detailEl, srv.name, '#mcp-btn-stop', 'stop', {
        idle: '关闭',
        loading: '关闭中…',
        success: `${srv.name} 已关闭`,
        fail: '关闭失败',
      });
      return;
    }

    bindServerAction(detailEl, srv.name, '#mcp-btn-start', 'start', {
      idle: '启动',
      loading: '启动中…',
      success: `${srv.name} 已启动`,
      fail: '启动失败',
    });
  }

  function formatConfigJson(config) {
    return JSON.stringify(config, null, 2);
  }

  function renderToolsSection(srv) {
    const tools = srv.toolsDetail || [];
    const expandedClass = toolsExpanded ? ' is-expanded' : '';
    const toggleIcon = toolsExpanded ? '▾' : '▸';
    const bodyHidden = toolsExpanded ? '' : ' hidden';

    if (!tools.length) {
      return (
        '<div class="mcp-tools-section mcp-collapsible' + expandedClass + '">' +
          '<button type="button" class="mcp-collapsible-toggle" id="mcp-tools-toggle" aria-expanded="' + (toolsExpanded ? 'true' : 'false') + '">' +
            '<span class="mcp-collapsible-icon" aria-hidden="true">' + toggleIcon + '</span>' +
            '<span class="config-section-title mcp-collapsible-title">工具列表</span>' +
          '</button>' +
          '<div class="mcp-collapsible-body"' + bodyHidden + '>' +
            '<p class="config-detail-placeholder">暂无可用工具</p>' +
          '</div>' +
        '</div>'
      );
    }

    let toolRows = '';
    for (let t = 0; t < tools.length; t++) {
      toolRows +=
        `<tr><td><code>${escapeHtml(tools[t].name)}</code></td><td>${escapeHtml(tools[t].description || '—')}</td><td><span class="config-badge is-on">可用</span></td></tr>`;
    }

    return (
      '<div class="mcp-tools-section mcp-collapsible' + expandedClass + '">' +
        '<button type="button" class="mcp-collapsible-toggle" id="mcp-tools-toggle" aria-expanded="' + (toolsExpanded ? 'true' : 'false') + '">' +
          '<span class="mcp-collapsible-icon" aria-hidden="true">' + toggleIcon + '</span>' +
          '<span class="config-section-title mcp-collapsible-title">工具列表 (' + tools.length + ')</span>' +
        '</button>' +
        '<div class="mcp-collapsible-body"' + bodyHidden + '>' +
          '<div class="mcp-tools-table-wrap">' +
            '<table class="mcp-tools-table">' +
              '<thead><tr><th>工具名称</th><th>描述</th><th>状态</th></tr></thead>' +
              '<tbody>' + toolRows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function bindToolsToggle(detailEl) {
    const toggle = detailEl.querySelector('#mcp-tools-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      toolsExpanded = !toolsExpanded;
      const section = detailEl.querySelector('.mcp-collapsible');
      const body = detailEl.querySelector('.mcp-collapsible-body');
      const icon = detailEl.querySelector('.mcp-collapsible-icon');
      if (section) section.classList.toggle('is-expanded', toolsExpanded);
      if (body) body.hidden = !toolsExpanded;
      if (icon) icon.textContent = toolsExpanded ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', toolsExpanded ? 'true' : 'false');
    });
  }

  function setConfigTextarea(detailEl, text) {
    const textarea = detailEl.querySelector('#mcp-config-editor');
    if (textarea) textarea.value = text;
  }

  function bindConfigEditor(detailEl) {
    const textarea = detailEl.querySelector('#mcp-config-editor');
    if (!textarea) return;
    textarea.addEventListener('input', () => {
      configDirty = true;
      const errEl = detailEl.querySelector('#mcp-config-error');
      if (errEl) errEl.textContent = '';
    });
  }

  function removeDraftServer(name) {
    delete draftServers[name];
    delete pendingDeleteNames[name];
    configDirty = false;
    loadingConfig = false;
    selectedName = pickSelectedName();
    renderAll();
  }

  function bindDeleteButton(detailEl, srv) {
    const btn = detailEl.querySelector('#mcp-btn-delete');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const isDraft = isDraftName(srv.name);
      const displayName = isDraft
        ? ((detailEl.querySelector('#mcp-server-name') || {}).value || srv.name).trim() || srv.name
        : srv.name;

      const doDelete = function () {
        if (isDraft) {
          removeDraftServer(srv.name);
          Notification.success('已移除未保存的服务器');
          return;
        }

        btn.disabled = true;
        btn.textContent = '删除中…';
        fetch(`/api/mcp/servers/${encodeURIComponent(srv.name)}`, { method: 'DELETE' })
          .then((res) =>  parseApiResponse(res))
          .then((result) => {
            if (!result.success) throw new Error(result.error || '删除失败');
            if (result.servers) {
              delete pendingDeleteNames[srv.name];
              servers = result.servers;
              delete draftServers[srv.name];
              loadingConfig = false;
              configDirty = false;
              selectedName = pickSelectedName();
              renderAll();
            } else {
              removeServerFromLocalState(srv.name);
            }
            Notification.success(`${displayName} 已删除`);
          })
          .catch((err) => {
            Notification.error('删除失败：' + (err.message || '未知错误'));
          })
          .finally(() => {
            btn.disabled = false;
            btn.textContent = '删除';
          });
      };

      window.Modal.confirm({
        title: '删除 MCP 服务器',
        message: `确定要删除「${displayName}」吗？此操作不可恢复。`,
        type: 'danger',
        confirmText: '删除',
        cancelText: '取消',
        dangerConfirm: true,
      }).then((ok) => {
        if (ok) doDelete();
      });
    });
  }

  function bindSaveButton(detailEl, srv) {
    const btn = detailEl.querySelector('#mcp-btn-save');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const nameInput = detailEl.querySelector('#mcp-server-name');
      const textarea = detailEl.querySelector('#mcp-config-editor');
      const errEl = detailEl.querySelector('#mcp-config-error');
      const serverName = (nameInput ? nameInput.value : srv.name).trim();
      let parsed;

      if (!serverName) {
        if (errEl) errEl.textContent = '请填写服务器名称';
        return;
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(serverName)) {
        if (errEl) errEl.textContent = '名称仅允许字母、数字、点、下划线和连字符';
        return;
      }

      try {
        parsed = JSON.parse(textarea.value);
      } catch (e) {
        if (errEl) errEl.textContent = 'JSON 格式错误：' + (e.message || '无法解析');
        return;
      }

      btn.disabled = true;
      btn.textContent = '保存中…';

      const isDraft = isDraftName(srv.name);
      const url = isDraft
        ? '/api/mcp/servers'
        : `/api/mcp/servers/${encodeURIComponent(srv.name)}/config`;
      const method = isDraft ? 'POST' : 'PUT';
      const body = isDraft
        ? JSON.stringify({ name: serverName, config: parsed })
        : JSON.stringify({ config: parsed });

      fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      })
        .then((res) =>  parseApiResponse(res))
        .then((result) => {
          if (!result.success) throw new Error(result.error || '保存失败');
          if (isDraft) {
            delete draftServers[srv.name];
          }
          selectedName = serverName;
          configDirty = false;
          Notification.success(`${serverName} 配置已保存`);
          reloadData();
        })
        .catch((err) => {
          if (errEl) errEl.textContent = err.message || '保存失败';
          Notification.error('保存失败：' + (err.message || '未知错误'));
        })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = '保存';
        });
    });
  }

  function resolveSelectedServer(list) {
    let srv = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].name === selectedName) {
        srv = list[i];
        break;
      }
    }
    if (!srv) srv = list[0];
    selectedName = srv.name;
    return srv;
  }

  function buildMcpDetailHtml(srv) {
    const cfg = srv.config || {};
    const cmdLine = [cfg.command || ''].concat(cfg.args || []).filter(Boolean).join(' ');
    const urlLine = cfg.url || '';
    const launchLabel = urlLine ? '连接地址' : '启动命令';
    const launchValue = urlLine || cmdLine;
    const isDraft = isDraftName(srv.name);

    const present = mcpStatusPresentation(srv);
    return (
      '<div class="config-detail-header">' +
        '<div class="config-detail-title-row">' +
          (isDraft
            ? `<input type="text" class="mcp-server-name-input" id="mcp-server-name" placeholder="服务器名称" value="${escapeAttr(srv.name)}">`
            : `<h2 class="config-detail-title">${escapeHtml(srv.name)}</h2>`) +
        '</div>' +
        renderActionButtons(srv) +
      '</div>' +
      '<div class="mcp-info-section">' +
        '<h3 class="config-section-title">连接信息</h3>' +
        '<dl class="mcp-info-grid">' +
          '<dt>' + launchLabel + '</dt><dd><code>' + escapeHtml(launchValue || '—') + '</code></dd>' +
          '<dt>配置文件</dt><dd><code>' + escapeHtml(configPath || '.iceCoder/mcp.json') + '</code></dd>' +
          '<dt>连接状态</dt><dd><span class="config-status-dot ' + present.dot + '"></span> ' + escapeHtml(present.label) + '</dd>' +
          (srv.error ? `<dt>错误信息</dt><dd class="mcp-error-text">${escapeHtml(srv.error)}</dd>` : '') +
        '</dl>' +
      '</div>' +
      renderToolsSection(srv) +
      '<div class="mcp-config-section">' +
        '<h3 class="config-section-title">服务器配置 (JSON)</h3>' +
        '<textarea class="mcp-config-editor" id="mcp-config-editor" spellcheck="false" rows="12"></textarea>' +
        '<p class="mcp-config-error" id="mcp-config-error" role="alert"></p>' +
      '</div>' +
      '<div class="config-detail-toolbar mcp-config-toolbar">' +
        '<button type="button" class="skills-btn skills-btn-danger" id="mcp-btn-delete">删除</button>' +
        '<button type="button" class="skills-btn skills-btn-primary" id="mcp-btn-save">保存</button>' +
      '</div>'
    );
  }

  function populateMcpDetailContent(detailEl, srv) {
    const isDraft = isDraftName(srv.name);
    const cfg = srv.config || {};
    const initialConfigText = isDraft
      ? formatConfigJson(draftServers[srv.name] || NEW_SERVER_TEMPLATE)
      : formatConfigJson(cfg);

    bindActionButtons(detailEl, srv);
    bindToolsToggle(detailEl);
    bindConfigEditor(detailEl);
    bindDeleteButton(detailEl, srv);
    bindSaveButton(detailEl, srv);

    if (isDraft) {
      setConfigTextarea(detailEl, initialConfigText);
      configDirty = false;
      return;
    }

    loadingConfig = true;
    setConfigTextarea(detailEl, '加载中…');
    fetchServerConfig(srv.name, (err, fullConfig) => {
      loadingConfig = false;
      if (!container || selectedName !== srv.name) return;
      const currentDetail = getDetailElForServer(srv.name);
      if (!currentDetail) return;
      if (err) {
        setConfigTextarea(currentDetail, initialConfigText);
        const errEl = currentDetail.querySelector('#mcp-config-error');
        if (errEl) errEl.textContent = err.message || '加载配置失败';
        return;
      }
      if (!configDirty || selectedName !== srv.name) {
        setConfigTextarea(currentDetail, formatConfigJson(fullConfig));
        configDirty = false;
      }
    });
  }

  function renderDetail() {
    const detailEl = container.querySelector('#mcp-detail');
    if (!detailEl) return;

    if (isMobile()) {
      detailEl.innerHTML = '';
      return;
    }

    const list = getAllListItems();
    if (!list.length) {
      detailEl.innerHTML =
        '<div class="config-detail-placeholder">' +
          '点击左侧「新增」添加 MCP 服务器，在下方编辑 JSON 配置后保存。' +
        '</div>';
      return;
    }

    const srv = resolveSelectedServer(list);
    detailEl.innerHTML = buildMcpDetailHtml(srv);
    populateMcpDetailContent(detailEl, srv);
  }

  function renderAll() {
    renderList();
    renderDetail();
  }

  function addDraftServer() {
    let name = 'new-mcp-' + (nextDraftId++);
    while (draftServers[name] || servers.some((s) =>  s.name === name)) {
      name = 'new-mcp-' + (nextDraftId++);
    }
    draftServers[name] = JSON.parse(JSON.stringify(NEW_SERVER_TEMPLATE));
    selectedName = name;
    if (isMobile()) mobileExpanded = true;
    renderAll();
  }

  function handleAddServer() {
    if (configDirty) {
      window.Modal.confirm({
        title: '未保存的修改',
        message: '当前配置尚未保存，新增将丢弃修改，是否继续？',
        type: 'warning',
        confirmText: '继续',
        cancelText: '取消',
      }).then((ok) => {
        if (!ok) return;
        configDirty = false;
        addDraftServer();
      });
      return;
    }
    addDraftServer();
  }

  function reloadData() {
    if (!container) return;
    fetchStatus((err, body) => {
      if (!container) return;
      if (err) {
        const listEl = container.querySelector('#mcp-server-list');
        const detailEl = container.querySelector('#mcp-detail');
        if (listEl) {
          listEl.innerHTML = `<div class="config-list-empty">加载失败：${escapeHtml(err.message)}</div>`;
        }
        if (detailEl && !configDirty) {
          detailEl.innerHTML = `<div class="config-detail-placeholder">加载失败：${escapeHtml(err.message)}</div>`;
        }
        return;
      }
      applyStatusBody(body);

      if (configDirty) {
        renderList();
        updateDetailStatusOnly();
      } else {
        loadingConfig = false;
        renderAll();
      }
    });
  }

  function updateDetailStatusOnly() {
    if (!selectedName || isDraftName(selectedName)) return;
    let srv = null;
    for (let i = 0; i < servers.length; i++) {
      if (servers[i].name === selectedName) {
        srv = servers[i];
        break;
      }
    }
    if (!srv) return;
    const detailEl = getActiveDetailEl();
    if (!detailEl) return;
    const present = mcpStatusPresentation(srv);
    const dot = detailEl.querySelector('.mcp-info-grid .config-status-dot');
    if (dot) dot.className = `config-status-dot ${present.dot}`;
    const statusText = detailEl.querySelector('.mcp-info-grid dd:nth-of-type(3)');
    if (statusText) {
      statusText.innerHTML = `<span class="config-status-dot ${present.dot}"></span> ${escapeHtml(present.label)}`;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(reloadData, 15000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function render(parentEl) {
    stopPolling();
    container = parentEl;
    configDirty = false;
    mobileExpanded = false;
    parentEl.innerHTML =
      '<div class="config-panel-inner config-panel-mcp">' +
        '<div class="config-split">' +
          '<aside class="config-list-panel">' +
            '<div class="config-list-panel-head">' +
              '<span class="config-list-panel-title">MCP 服务器列表</span>' +
              '<button type="button" class="chat-sidebar-new-btn" id="mcp-btn-add" title="新增 MCP 服务器">' +
                '<span class="chat-sidebar-new-btn-icon" aria-hidden="true">+</span>' +
                '<span class="chat-sidebar-new-btn-label">添加</span>' +
              '</button>' +
            '</div>' +
            '<div class="config-list" id="mcp-server-list"></div>' +
          '</aside>' +
          '<section class="config-detail-panel" id="mcp-detail"></section>' +
        '</div>' +
      '</div>';

    parentEl.querySelector('#mcp-btn-add').addEventListener('click', handleAddServer);

    reloadData();
    startPolling();
  }

  function pause() {
    stopPolling();
  }

  function resume() {
    if (!container) return;
    reloadData();
    startPolling();
  }

  function destroy() {
    stopPolling();
    container = null;
    servers = [];
    selectedName = null;
    mobileExpanded = false;
    draftServers = {};
    configDirty = false;
    loadingConfig = false;
    pendingDeleteNames = {};
  }

  return { render, destroy, reload: reloadData, pause, resume, collapseMobile };
})();

if (typeof window !== 'undefined') {
  window.McpConfigPanel = McpConfigPanel;
}
