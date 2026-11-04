// @ts-nocheck
import { t } from './i18n.ts';
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
      case 'ready': return t('mcp.running');
      case 'error': return t('mcp.connectFailed');
      case 'disabled': return t('mcp.stopped');
      case 'starting': return t('mcp.starting');
      case 'stopped': return t('mcp.offline');
      case 'draft': return t('mcp.unsaved');
      default: return status || t('mcp.unknown');
    }
  }

  function mcpStatusPresentation(srv) {
    const status = srv && srv.status;
    if (status === 'ready' && srv.backendSession === 'detached') {
      return { label: t('mcp.detached'), dot: 'dot-warn' };
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
        if (!body.success) throw new Error(body.error || t('mcp.loadFailedShort'));
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
        if (!body.success) throw new Error(body.error || t('mcp.loadConfigFailed'));
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
        title: t('mcp.unsavedTitle'),
        message: t('mcp.unsavedSwitch'),
        type: 'warning',
        confirmText: t('mcp.continue'),
        cancelText: t('common.cancel'),
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
      listEl.innerHTML = '<div class="config-list-empty">' + t('mcp.empty') + '</div>';
      return;
    }

    for (let i = 0; i < list.length; i++) {
      ((srv) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'config-list-item' + (isListItemActive(srv.name) ? ' is-active' : '');
        const present = mcpStatusPresentation(srv);
        const toolText = srv.status === 'draft'
          ? t('mcp.unsaved')
          : (srv.backendSession === 'detached'
            ? (srv.toolCount != null ? t('mcp.detachedTools', { n: srv.toolCount }) : t('mcp.detachedShort'))
            : (srv.toolCount != null ? t('mcp.toolCount', { n: srv.toolCount }) : '—'));
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
          '<button type="button" class="skills-btn skills-btn-primary" id="mcp-btn-restart">' + t('mcp.restart') + '</button>' +
          '<button type="button" class="skills-btn skills-btn-danger" id="mcp-btn-stop">' + t('mcp.stop') + '</button>' +
        '</div>'
      );
    }

    return (
      '<div class="config-detail-actions">' +
        '<button type="button" class="skills-btn skills-btn-primary" id="mcp-btn-start">' + t('mcp.start') + '</button>' +
      '</div>'
    );
  }

  function parseApiResponse(res) {
    return res.text().then((text) => {
      if (!text) return { success: res.ok, error: res.ok ? null : t('mcp.emptyResponse') };
      try {
        return JSON.parse(text);
      } catch (_e) {
        if (res.status === 404) {
          throw new Error(t('mcp.apiNotReady'));
        }
        throw new Error(t('mcp.nonJson', { status: res.status }));
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
          Notification.error(t('mcp.actionFailed', { action: labels.fail, message: err.message || t('mcp.unknown') }));
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
        idle: t('mcp.restart'),
        loading: t('mcp.restarting'),
        success: t('mcp.restarted', { name: srv.name }),
        fail: t('mcp.restartFailed'),
      });
      bindServerAction(detailEl, srv.name, '#mcp-btn-stop', 'stop', {
        idle: t('mcp.stop'),
        loading: t('mcp.stopping'),
        success: t('mcp.stoppedDone', { name: srv.name }),
        fail: t('mcp.stopFailed'),
      });
      return;
    }

    bindServerAction(detailEl, srv.name, '#mcp-btn-start', 'start', {
      idle: t('mcp.start'),
      loading: t('mcp.startingNow'),
      success: t('mcp.started', { name: srv.name }),
      fail: t('mcp.startFailed'),
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
            '<span class="config-section-title mcp-collapsible-title">' + t('mcp.tools') + '</span>' +
          '</button>' +
          '<div class="mcp-collapsible-body"' + bodyHidden + '>' +
            '<p class="config-detail-placeholder">' + t('mcp.noTools') + '</p>' +
          '</div>' +
        '</div>'
      );
    }

    let toolRows = '';
    const available = t('mcp.available');
    for (let i = 0; i < tools.length; i++) {
      toolRows +=
        `<tr><td><code>${escapeHtml(tools[i].name)}</code></td><td>${escapeHtml(tools[i].description || '—')}</td><td><span class="config-badge is-on">${available}</span></td></tr>`;
    }

    return (
      '<div class="mcp-tools-section mcp-collapsible' + expandedClass + '">' +
        '<button type="button" class="mcp-collapsible-toggle" id="mcp-tools-toggle" aria-expanded="' + (toolsExpanded ? 'true' : 'false') + '">' +
          '<span class="mcp-collapsible-icon" aria-hidden="true">' + toggleIcon + '</span>' +
          '<span class="config-section-title mcp-collapsible-title">' + t('mcp.toolsCount', { n: tools.length }) + '</span>' +
        '</button>' +
        '<div class="mcp-collapsible-body"' + bodyHidden + '>' +
          '<div class="mcp-tools-table-wrap">' +
            '<table class="mcp-tools-table">' +
              '<thead><tr><th>' + t('mcp.toolName') + '</th><th>' + t('mcp.description') + '</th><th>' + t('mcp.statusCol') + '</th></tr></thead>' +
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
          Notification.success(t('mcp.removedDraft'));
          return;
        }

        btn.disabled = true;
        btn.textContent = t('mcp.deleting');
        fetch(`/api/mcp/servers/${encodeURIComponent(srv.name)}`, { method: 'DELETE' })
          .then((res) =>  parseApiResponse(res))
          .then((result) => {
            if (!result.success) throw new Error(result.error || t('common.deleteFailed'));
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
            Notification.success(t('mcp.deleted', { name: displayName }));
          })
          .catch((err) => {
            Notification.error(t('mcp.deleteFailed', { message: err.message || t('mcp.unknown') }));
          })
          .finally(() => {
            btn.disabled = false;
            btn.textContent = t('common.delete');
          });
      };

      window.Modal.confirm({
        title: t('mcp.deleteTitle'),
        message: t('mcp.deleteBody', { name: displayName }),
        type: 'danger',
        confirmText: t('common.delete'),
        cancelText: t('common.cancel'),
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
        if (errEl) errEl.textContent = t('mcp.nameRequired');
        return;
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(serverName)) {
        if (errEl) errEl.textContent = t('mcp.nameInvalid');
        return;
      }

      try {
        parsed = JSON.parse(textarea.value);
      } catch (e) {
        if (errEl) errEl.textContent = t('mcp.jsonError', { message: e.message || t('mcp.jsonParse') });
        return;
      }

      btn.disabled = true;
      btn.textContent = t('mcp.saving');

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
          if (!result.success) throw new Error(result.error || t('common.saveFailed'));
          if (isDraft) {
            delete draftServers[srv.name];
          }
          selectedName = serverName;
          configDirty = false;
          Notification.success(t('mcp.saved', { name: serverName }));
          reloadData();
        })
        .catch((err) => {
          if (errEl) errEl.textContent = err.message || t('common.saveFailed');
          Notification.error(t('mcp.saveFailed', { message: err.message || t('mcp.unknown') }));
        })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = t('common.save');
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
    const launchLabel = urlLine ? t('mcp.address') : t('mcp.command');
    const launchValue = urlLine || cmdLine;
    const isDraft = isDraftName(srv.name);

    const present = mcpStatusPresentation(srv);
    return (
      '<div class="config-detail-header">' +
        '<div class="config-detail-title-row">' +
          (isDraft
            ? `<input type="text" class="mcp-server-name-input" id="mcp-server-name" placeholder="${t('mcp.serverName')}" value="${escapeAttr(srv.name)}">`
            : `<h2 class="config-detail-title">${escapeHtml(srv.name)}</h2>`) +
        '</div>' +
        renderActionButtons(srv) +
      '</div>' +
      '<div class="mcp-info-section">' +
        '<h3 class="config-section-title">' + t('mcp.connection') + '</h3>' +
        '<dl class="mcp-info-grid">' +
          '<dt>' + launchLabel + '</dt><dd><code>' + escapeHtml(launchValue || '—') + '</code></dd>' +
          '<dt>' + t('mcp.configFile') + '</dt><dd><code>' + escapeHtml(configPath || '.iceCoder/mcp.json') + '</code></dd>' +
          '<dt>' + t('mcp.status') + '</dt><dd><span class="config-status-dot ' + present.dot + '"></span> ' + escapeHtml(present.label) + '</dd>' +
          (srv.error ? `<dt>${t('mcp.error')}</dt><dd class="mcp-error-text">${escapeHtml(srv.error)}</dd>` : '') +
        '</dl>' +
      '</div>' +
      renderToolsSection(srv) +
      '<div class="mcp-config-section">' +
        '<h3 class="config-section-title">' + t('mcp.json') + '</h3>' +
        '<textarea class="mcp-config-editor" id="mcp-config-editor" spellcheck="false" rows="12"></textarea>' +
        '<p class="mcp-config-error" id="mcp-config-error" role="alert"></p>' +
      '</div>' +
      '<div class="config-detail-toolbar mcp-config-toolbar">' +
        '<button type="button" class="skills-btn skills-btn-danger" id="mcp-btn-delete">' + t('common.delete') + '</button>' +
        '<button type="button" class="skills-btn skills-btn-primary" id="mcp-btn-save">' + t('common.save') + '</button>' +
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
    setConfigTextarea(detailEl, t('common.loading'));
    fetchServerConfig(srv.name, (err, fullConfig) => {
      loadingConfig = false;
      if (!container || selectedName !== srv.name) return;
      const currentDetail = getDetailElForServer(srv.name);
      if (!currentDetail) return;
      if (err) {
        setConfigTextarea(currentDetail, initialConfigText);
        const errEl = currentDetail.querySelector('#mcp-config-error');
        if (errEl) errEl.textContent = err.message || t('mcp.loadConfigFailed');
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
          t('mcp.emptyDetail') +
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
        title: t('mcp.unsavedTitle'),
        message: t('mcp.unsavedAdd'),
        type: 'warning',
        confirmText: t('mcp.continue'),
        cancelText: t('common.cancel'),
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
          listEl.innerHTML = `<div class="config-list-empty">${escapeHtml(t('mcp.loadFailed', { message: err.message }))}</div>`;
        }
        if (detailEl && !configDirty) {
          detailEl.innerHTML = `<div class="config-detail-placeholder">${escapeHtml(t('mcp.loadFailed', { message: err.message }))}</div>`;
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
              '<span class="config-list-panel-title">' + t('mcp.list') + '</span>' +
              '<button type="button" class="chat-sidebar-new-btn" id="mcp-btn-add" title="' + t('mcp.addServer') + '">' +
                '<span class="chat-sidebar-new-btn-icon" aria-hidden="true">+</span>' +
                '<span class="chat-sidebar-new-btn-label">' + t('common.add') + '</span>' +
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
