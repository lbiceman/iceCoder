/**
 * 设置页「监管模式配置」：读写 supervisor-config.json。
 */

/* exported SupervisorConfigPanel */

window.SupervisorConfigPanel = (function () {
  'use strict';

  var rootEl = null;
  var loadedConfig = null;
  var loadedPath = '';
  var saving = false;

  var HEADINGS = {
    'executionMode': 'L1 执行模式',
  };

  function leafName(path) {
    var parts = String(path || '').split('.');
    return parts[parts.length - 1] || path;
  }

  function isConfigKeyTitle(title) {
    return title !== '运行模式';
  }

  var GROUPS = [
    {
      title: 'executionMode',
      desc: '单轴监管参数。档位请使用侧栏 off / adaptive / strict 切换。',
      fields: [
        { path: 'executionMode.pendingStepsEnterThreshold', type: 'number', label: '未完成步骤门槛', desc: '任务图未完成步骤数达到该值时进入 forced。' },
        { path: 'executionMode.writeTargetsEnterThreshold', type: 'number', label: '写入文件数门槛', desc: '本轮写入文件数达到该值时进入 forced。' },
        { path: 'executionMode.diffLinesEnterThreshold', type: 'number', label: 'Diff 行数门槛', desc: '预估 diff 行数达到该值时进入 forced。' },
        { path: 'executionMode.stableRoundsExitThreshold', type: 'number', label: '退出稳定轮数', desc: '连续稳定多少轮后可以退出 forced。' },
        { path: 'executionMode.modeLockRounds', type: 'number', label: '模式锁定轮数', desc: '模式切换后锁定轮数，避免来回抖。' },
        { path: 'executionMode.forcedMinDwellRounds', type: 'number', label: 'Forced 最少停留', desc: '进入 forced 后至少停留的轮数。' },
        { path: 'executionMode.readonlyToolNames', type: 'array', label: '只读工具名单', desc: '只读工具名列表，逗号分隔。这些工具不计入写入风险。' },
      ],
    },
  ];

  function getPath(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) {
        cur[key] = {};
      }
      cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fieldControlHtml(field, value) {
    var id = 'sup-field-' + field.path.replace(/\./g, '-');
    if (field.type === 'boolean') {
      return (
        '<div class="settings-supervisor-control">' +
          '<label class="config-default-switch settings-card-switch" title="' + escapeHtml(field.path) + '">' +
            '<input type="checkbox" id="' + id + '" data-path="' + escapeHtml(field.path) + '" data-type="boolean"' +
              (field.optional ? ' data-optional="1"' : '') +
              (value === true ? ' checked' : '') + ' />' +
            '<span class="config-default-switch-track" aria-hidden="true"></span>' +
          '</label>' +
        '</div>'
      );
    }
    if (field.type === 'number') {
      var num = typeof value === 'number' && isFinite(value) ? String(value) : '';
      return (
        '<div class="settings-supervisor-control">' +
          '<input class="settings-supervisor-input is-number" id="' + id + '" type="number" step="any" spellcheck="false" ' +
            'data-path="' + escapeHtml(field.path) + '" data-type="number"' +
            (field.optional ? ' data-optional="1"' : '') +
            ' value="' + escapeHtml(num) + '" />' +
        '</div>'
      );
    }
    var text = '';
    if (field.type === 'array') {
      text = Array.isArray(value) ? value.join(', ') : '';
    } else if (value != null) {
      text = String(value);
    }
    var wide = field.type === 'array' || field.type === 'string';
    return (
      '<div class="settings-supervisor-control">' +
        '<input class="settings-supervisor-input' + (wide ? ' is-wide' : '') + '" id="' + id + '" type="text" spellcheck="false" ' +
          'data-path="' + escapeHtml(field.path) + '" data-type="' + field.type + '"' +
          (field.optional ? ' data-optional="1"' : '') +
          ' value="' + escapeHtml(text) + '" />' +
      '</div>'
    );
  }

  function renderFields(config) {
    var html = '';
    for (var g = 0; g < GROUPS.length; g++) {
      var group = GROUPS[g];
      var heading = HEADINGS[group.title] || group.title;
      var showKey = isConfigKeyTitle(group.title);
      html +=
        '<section class="settings-section' + (g === 0 ? '' : ' settings-section-spaced') + '">' +
          '<div class="settings-section-head">' +
            '<h2 class="settings-section-title">' + escapeHtml(heading) + '</h2>' +
            (showKey ? '<span class="settings-supervisor-keychip">' + escapeHtml(group.title) + '</span>' : '') +
          '</div>' +
          '<p class="settings-section-desc">' + escapeHtml(group.desc) + '</p>' +
          '<div class="settings-card settings-supervisor-card">';
      for (var f = 0; f < group.fields.length; f++) {
        var field = group.fields[f];
        var stacked = field.type === 'array' || field.type === 'string';
        var title = field.label || leafName(field.path);
        html +=
          '<div class="settings-card-row settings-supervisor-row' + (stacked ? ' is-stack' : '') + '">' +
            '<div class="settings-card-info">' +
              '<span class="settings-card-title" title="' + escapeHtml(field.path) + '">' +
                escapeHtml(title) +
                ' <span class="settings-supervisor-fieldkey">(' + escapeHtml(leafName(field.path)) + ')</span>' +
              '</span>' +
              '<p class="settings-card-desc">' + escapeHtml(field.desc) + '</p>' +
            '</div>' +
            fieldControlHtml(field, getPath(config, field.path)) +
          '</div>';
      }
      html += '</div></section>';
    }
    return html;
  }

  function collectConfig() {
    if (!rootEl) return null;
    var next = loadedConfig ? JSON.parse(JSON.stringify(loadedConfig)) : {};
    var inputs = rootEl.querySelectorAll('[data-path]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var path = el.getAttribute('data-path');
      var type = el.getAttribute('data-type');
      var optional = el.getAttribute('data-optional') === '1';
      if (type === 'boolean') {
        if (optional && getPath(loadedConfig, path) === undefined && el.checked !== true) continue;
        setPath(next, path, el.checked === true);
      } else if (type === 'number') {
        if (optional && String(el.value).trim() === '') continue;
        var n = parseFloat(el.value);
        if (!isFinite(n)) {
          throw new Error(path + ' 须为数字');
        }
        setPath(next, path, n);
      } else if (type === 'array') {
        var items = String(el.value || '')
          .split(',')
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s.length > 0; });
        setPath(next, path, items);
      } else {
        var s = String(el.value || '').trim();
        if (optional && !s) continue;
        setPath(next, path, s);
      }
    }
    return next;
  }

  function setStatus(text, isError) {
    if (!rootEl) return;
    var el = rootEl.querySelector('#settings-supervisor-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function notify(kind, message) {
    if (window.Notification && typeof window.Notification[kind] === 'function') {
      window.Notification[kind](message);
    }
  }

  function bind() {
    if (!rootEl) return;
    var saveBtn = rootEl.querySelector('#settings-supervisor-save');
    var reloadBtn = rootEl.querySelector('#settings-supervisor-reload');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        save().catch(function () { /* toast 已处理 */ });
      });
    }
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function () {
        load().catch(function () { /* toast 已处理 */ });
      });
    }
  }

  function renderShell(parentEl, bodyHtml, pathText) {
    parentEl.innerHTML =
      '<div class="settings-general settings-supervisor">' +
        '<section class="settings-section settings-supervisor-intro">' +
          '<div class="settings-section-head">' +
            '<p class="settings-supervisor-lead">编辑当前数据目录中的监管配置，保存后下一轮对话生效。</p>' +
            '<span class="settings-section-loading" id="settings-supervisor-loading" hidden>加载中…</span>' +
          '</div>' +
          (pathText
            ? '<p class="settings-supervisor-path">' + escapeHtml(pathText) + '</p>'
            : '') +
        '</section>' +
        bodyHtml +
        '<div class="settings-card-footer settings-supervisor-footer">' +
          '<button type="button" class="btn btn-secondary" id="settings-supervisor-reload">重新加载</button>' +
          '<button type="button" class="btn btn-primary" id="settings-supervisor-save">保存</button>' +
        '</div>' +
      '</div>';
    bind();
  }

  function load() {
    if (!rootEl) return Promise.resolve();
    var loading = rootEl.querySelector('#settings-supervisor-loading');
    if (loading) loading.hidden = false;
    setStatus('正在读取配置…', false);
    return fetch('/api/config/supervisor-runtime')
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.config) {
          throw new Error((result.body && result.body.error) || '加载监管配置失败');
        }
        loadedConfig = result.body.config;
        loadedPath = result.body.configPath || '';
        renderShell(rootEl, renderFields(loadedConfig), loadedPath);
        setStatus('已加载文件配置', false);
      })
      .catch(function (err) {
        var message = err instanceof Error ? err.message : '加载监管配置失败';
        if (!rootEl.querySelector('#settings-supervisor-save')) {
          renderShell(rootEl, '', '');
        }
        setStatus(message, true);
        notify('error', message);
      })
      .then(function () {
        var loadingEl = rootEl && rootEl.querySelector('#settings-supervisor-loading');
        if (loadingEl) loadingEl.hidden = true;
      });
  }

  function save() {
    if (!rootEl || saving) return Promise.resolve();
    var config;
    try {
      config = collectConfig();
    } catch (err) {
      var parseMsg = err instanceof Error ? err.message : '表单值无效';
      setStatus(parseMsg, true);
      notify('error', parseMsg);
      return Promise.reject(err);
    }
    saving = true;
    setStatus('正在保存…', false);
    return fetch('/api/config/supervisor-runtime', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: config }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.body || !result.body.success) {
          throw new Error((result.body && result.body.error) || '保存失败');
        }
        loadedConfig = result.body.config;
        renderShell(rootEl, renderFields(loadedConfig), loadedPath);
        setStatus('已保存，下一轮对话生效', false);
        notify('success', '监管配置已保存');
      })
      .catch(function (err) {
        var message = err instanceof Error ? err.message : '保存监管配置失败';
        setStatus(message, true);
        notify('error', message);
      })
      .then(function () {
        saving = false;
      });
  }

  function render(parentEl) {
    rootEl = parentEl;
    renderShell(parentEl, '', '');
    load();
  }

  return { render: render, reload: load };
})();
