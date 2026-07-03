/**
 * 配置页 — MCP 配置面板（左服务器列表 + 右详情 / 工具表）。
 */

/* exported McpConfigPanel */

window.McpConfigPanel = (function () {
  'use strict';

  var container = null;
  var servers = [];
  var selectedName = null;
  var pollTimer = null;
  var configPath = '';

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function statusLabel(status) {
    switch (status) {
      case 'ready': return '运行中';
      case 'error': return '连接失败';
      case 'disabled': return '已停止';
      case 'starting': return '启动中';
      case 'stopped': return '离线';
      default: return status || '未知';
    }
  }

  function statusClass(status) {
    switch (status) {
      case 'ready': return 'is-ready';
      case 'error': return 'is-error';
      case 'disabled': return 'is-disabled';
      case 'starting': return 'is-starting';
      default: return 'is-offline';
    }
  }

  function dotClass(status) {
    switch (status) {
      case 'ready': return 'dot-green';
      case 'error': return 'dot-red';
      case 'disabled': return 'dot-gray';
      default: return 'dot-gray';
    }
  }

  function fetchStatus(callback) {
    fetch('/api/mcp')
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body.success) throw new Error(body.error || '加载失败');
        callback(null, body);
      })
      .catch(function (err) {
        callback(err, null);
      });
  }

  function renderOverview() {
    var el = container && container.querySelector('#mcp-overview');
    if (!el) return;
    var counts = { total: servers.length, ready: 0, error: 0, offline: 0, disabled: 0 };
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i].status;
      if (s === 'ready') counts.ready++;
      else if (s === 'error') counts.error++;
      else if (s === 'disabled') counts.disabled++;
      else counts.offline++;
    }
    el.innerHTML =
      '<span class="mcp-overview-item">全部 <strong>' + counts.total + '</strong></span>' +
      '<span class="mcp-overview-item mcp-st-ready">运行中 <strong>' + counts.ready + '</strong></span>' +
      '<span class="mcp-overview-item mcp-st-error">连接失败 <strong>' + counts.error + '</strong></span>' +
      '<span class="mcp-overview-item mcp-st-offline">离线 <strong>' + counts.offline + '</strong></span>' +
      '<span class="mcp-overview-item mcp-st-disabled">已停止 <strong>' + counts.disabled + '</strong></span>';
  }

  function renderList() {
    var listEl = container.querySelector('#mcp-server-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (!servers.length) {
      listEl.innerHTML = '<div class="config-list-empty">暂无 MCP 服务器，请在 <code>mcp.json</code> 中配置。</div>';
      return;
    }

    for (var i = 0; i < servers.length; i++) {
      (function (srv) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'config-list-item' + (srv.name === selectedName ? ' is-active' : '');
        var toolText = srv.toolCount != null ? srv.toolCount + ' 个工具' : '—';
        btn.innerHTML =
          '<div class="config-list-item-head">' +
            '<span class="config-list-item-name">' + escapeHtml(srv.name) + '</span>' +
            '<span class="config-status-dot ' + dotClass(srv.status) + '" aria-hidden="true"></span>' +
          '</div>' +
          '<div class="config-list-item-sub">' + escapeHtml(toolText) + '</div>';
        btn.addEventListener('click', function () {
          selectedName = srv.name;
          renderAll();
        });
        listEl.appendChild(btn);
      })(servers[i]);
    }
  }

  function isRunningStatus(status) {
    return status === 'ready' || status === 'starting';
  }

  function renderActionButtons(srv) {
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
    return res.text().then(function (text) {
      if (!text) return { success: res.ok, error: res.ok ? null : '空响应' };
      try {
        return JSON.parse(text);
      } catch (_e) {
        if (res.status === 404) {
          throw new Error('接口未就绪，请重启 API 服务（npm run dev）后重试');
        }
        throw new Error('服务返回非 JSON 响应（HTTP ' + res.status + '）');
      }
    });
  }

  function bindServerAction(detailEl, serverName, btnId, endpoint, labels) {
    var btn = detailEl.querySelector(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = labels.loading;
      fetch('/api/mcp/servers/' + encodeURIComponent(serverName) + '/' + endpoint, { method: 'POST' })
        .then(function (res) { return parseApiResponse(res); })
        .then(function (body) {
          if (!body.success) throw new Error(body.error || labels.fail);
          Notification.success(labels.success);
          reloadData();
        })
        .catch(function (err) {
          Notification.error(labels.fail + '：' + (err.message || '未知错误'));
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = labels.idle;
        });
    });
  }

  function bindActionButtons(detailEl, srv) {
    if (isRunningStatus(srv.status)) {
      bindServerAction(detailEl, srv.name, '#mcp-btn-restart', 'restart', {
        idle: '重启',
        loading: '重启中…',
        success: srv.name + ' 已重启',
        fail: '重启失败',
      });
      bindServerAction(detailEl, srv.name, '#mcp-btn-stop', 'stop', {
        idle: '关闭',
        loading: '关闭中…',
        success: srv.name + ' 已关闭',
        fail: '关闭失败',
      });
      return;
    }

    bindServerAction(detailEl, srv.name, '#mcp-btn-start', 'start', {
      idle: '启动',
      loading: '启动中…',
      success: srv.name + ' 已启动',
      fail: '启动失败',
    });
  }

  function renderDetail() {
    var detailEl = container.querySelector('#mcp-detail');
    if (!detailEl) return;

    if (!servers.length) {
      detailEl.innerHTML =
        '<div class="config-detail-placeholder">' +
          '在 <code>.iceCoder/mcp.json</code> 中添加 MCP 服务器配置后，保存文件即可自动热重载。' +
        '</div>';
      return;
    }

    var srv = null;
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].name === selectedName) {
        srv = servers[i];
        break;
      }
    }
    if (!srv) srv = servers[0];

    var cfg = srv.config || {};
    var cmdLine = [cfg.command || ''].concat(cfg.args || []).filter(Boolean).join(' ');
    var tools = srv.toolsDetail || [];
    var toolRows = '';
    for (var t = 0; t < tools.length; t++) {
      toolRows +=
        '<tr>' +
          '<td><code>' + escapeHtml(tools[t].name) + '</code></td>' +
          '<td>' + escapeHtml(tools[t].description || '—') + '</td>' +
          '<td><span class="config-badge is-on">可用</span></td>' +
        '</tr>';
    }

    detailEl.innerHTML =
      '<div class="config-detail-header">' +
        '<div class="config-detail-title-row">' +
          '<h2 class="config-detail-title">' + escapeHtml(srv.name) + '</h2>' +
          '<span class="config-badge ' + statusClass(srv.status) + '">' + escapeHtml(statusLabel(srv.status)) + '</span>' +
        '</div>' +
        renderActionButtons(srv) +
      '</div>' +
      '<div class="mcp-info-section">' +
        '<h3 class="config-section-title">连接信息</h3>' +
        '<dl class="mcp-info-grid">' +
          '<dt>启动命令</dt><dd><code>' + escapeHtml(cmdLine || '—') + '</code></dd>' +
          '<dt>配置文件</dt><dd><code>' + escapeHtml(configPath || '.iceCoder/mcp.json') + '</code></dd>' +
          '<dt>连接状态</dt><dd><span class="config-status-dot ' + dotClass(srv.status) + '"></span> ' + escapeHtml(statusLabel(srv.status)) + '</dd>' +
          (srv.error ? '<dt>错误信息</dt><dd class="mcp-error-text">' + escapeHtml(srv.error) + '</dd>' : '') +
        '</dl>' +
      '</div>' +
      (tools.length ? (
        '<div class="mcp-tools-section">' +
          '<h3 class="config-section-title">工具列表 (' + tools.length + ')</h3>' +
          '<div class="mcp-tools-table-wrap">' +
            '<table class="mcp-tools-table">' +
              '<thead><tr><th>工具名称</th><th>描述</th><th>状态</th></tr></thead>' +
              '<tbody>' + toolRows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>'
      ) : (
        '<div class="mcp-tools-section">' +
          '<h3 class="config-section-title">工具列表</h3>' +
          '<p class="config-detail-placeholder">暂无可用工具</p>' +
        '</div>'
      ));

    bindActionButtons(detailEl, srv);
  }

  function renderAll() {
    renderList();
    renderDetail();
    renderOverview();
  }

  function reloadData() {
    if (!container) return;
    fetchStatus(function (err, body) {
      if (!container) return;
      if (err) {
        var listEl = container.querySelector('#mcp-server-list');
        var detailEl = container.querySelector('#mcp-detail');
        if (listEl) {
          listEl.innerHTML = '<div class="config-list-empty">加载失败：' + escapeHtml(err.message) + '</div>';
        }
        if (detailEl) {
          detailEl.innerHTML = '<div class="config-detail-placeholder">加载失败：' + escapeHtml(err.message) + '</div>';
        }
        renderOverview();
        return;
      }
      servers = body.servers || [];
      configPath = body.configPath || '.iceCoder/mcp.json';
      if (selectedName && !servers.some(function (s) { return s.name === selectedName; })) {
        selectedName = servers.length ? servers[0].name : null;
      }
      if (!selectedName && servers.length) selectedName = servers[0].name;
      renderAll();
    });
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
    parentEl.innerHTML =
      '<div class="config-panel-inner config-panel-mcp">' +
        '<div class="config-split">' +
          '<aside class="config-list-panel">' +
            '<div class="config-list-panel-head">' +
              '<span class="config-list-panel-title">MCP 服务器列表</span>' +
            '</div>' +
            '<div class="config-list" id="mcp-server-list"></div>' +
          '</aside>' +
          '<section class="config-detail-panel" id="mcp-detail"></section>' +
        '</div>' +
        '<footer class="mcp-overview" id="mcp-overview"></footer>' +
      '</div>';

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
  }

  return { render: render, destroy: destroy, reload: reloadData, pause: pause, resume: resume };
})();
