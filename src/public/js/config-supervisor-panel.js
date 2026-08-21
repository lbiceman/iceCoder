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
    '运行模式': '运行模式',
    'params.strict': 'Strict 参数',
    'params.adaptiveFree': 'Adaptive 自由段',
    'params.adaptiveTakeover': 'Adaptive 接管段',
    'triggers': 'L2 触发阈值',
    'goalDrift': '目标漂移',
    'snapshotConfidence': '快照可信度',
    'correctionBudget': '纠偏预算',
    'eventTimeline': '事件时间线',
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
      title: '运行模式',
      desc: '对应 supervisor-config.json 根字段。档位请用侧栏 Adaptive / off / strict 切换。',
      fields: [
        { path: 'shadow', type: 'boolean', label: '影子评测', desc: '照常打分和记事件，但不真正改 supervisorPhase（不接管）。' },
      ],
    },
    {
      title: 'params.strict',
      desc: 'L0 为 strict 时使用的参数列。',
      fields: [
        { path: 'params.strict.firstRoundGraph', type: 'boolean', label: '首轮建图', desc: '关键任务第 1 轮是否强制初始化任务图。' },
        { path: 'params.strict.riskThreshold', type: 'number', label: '风险阈值', desc: '风险分达到该阈值才考虑接管，范围 0～1。' },
        { path: 'params.strict.maxRecoveryRounds', type: 'number', label: '最大恢复轮数', desc: '单次 takeover 最多恢复轮数，超过则停止或交还。' },
        { path: 'params.strict.recoveryTokenRatio', type: 'number', label: '恢复 token 占比', desc: '恢复阶段最多占用任务 token 预算的比例，范围 0～1。' },
        { path: 'params.strict.maxRecoveryRetries', type: 'number', label: '恢复重试上限', desc: '同一恢复路径允许重试的次数上限。' },
        { path: 'params.strict.stabilityWindowRounds', type: 'number', label: '稳定观察轮数', desc: 'handoff 前需连续稳定的观察轮数。' },
        { path: 'params.strict.handoffCooldownRounds', type: 'number', label: '交还冷却轮数', desc: '交还后禁止再次接管的冷却轮数。' },
        { path: 'params.strict.evaluateRoundMode', type: 'string', optional: true, label: '评估深度', desc: '每轮评估深度。full 全量检查；metrics_only 只看指标。' },
        { path: 'params.strict.checkToolCall', type: 'boolean', optional: true, label: '检查工具调用', desc: '是否在图模式下检查工具调用是否符合当前节点合约。' },
      ],
    },
    {
      title: 'params.adaptiveFree',
      desc: 'adaptive 自由段（尚未接管）使用的参数。',
      fields: [
        { path: 'params.adaptiveFree.firstRoundGraph', type: 'boolean', label: '首轮建图', desc: '自由段第 1 轮是否建图。adaptive 下通常为 false。' },
        { path: 'params.adaptiveFree.riskThreshold', type: 'number', label: '风险阈值', desc: '自由段进入 forced / 考虑接管的风险阈值，范围 0～1。' },
      ],
    },
    {
      title: 'params.adaptiveTakeover',
      desc: 'adaptive 已接管（takeover）后使用的参数列。',
      fields: [
        { path: 'params.adaptiveTakeover.firstRoundGraph', type: 'boolean', label: '首轮建图', desc: '接管后是否用任务图引导（通常通过反构图，而不是首轮建图）。' },
        { path: 'params.adaptiveTakeover.riskThreshold', type: 'number', label: '风险阈值', desc: '接管段风险阈值；接管后一般不再反复评估。' },
        { path: 'params.adaptiveTakeover.maxRecoveryRounds', type: 'number', label: '最大恢复轮数', desc: '本次接管最多恢复轮数。' },
        { path: 'params.adaptiveTakeover.recoveryTokenRatio', type: 'number', label: '恢复 token 占比', desc: '接管恢复最多占用 token 预算的比例，范围 0～1。' },
        { path: 'params.adaptiveTakeover.maxRecoveryRetries', type: 'number', label: '恢复重试上限', desc: '接管段同路径重试上限。' },
        { path: 'params.adaptiveTakeover.stabilityWindowRounds', type: 'number', label: '稳定观察轮数', desc: '交还前需连续稳定的轮数。' },
        { path: 'params.adaptiveTakeover.handoffCooldownRounds', type: 'number', label: '交还冷却轮数', desc: '交还后的冷却轮数。' },
        { path: 'params.adaptiveTakeover.evaluateRoundMode', type: 'string', optional: true, label: '评估深度', desc: '接管段每轮评估深度。full 或 metrics_only。' },
        { path: 'params.adaptiveTakeover.checkToolCall', type: 'boolean', optional: true, label: '检查工具调用', desc: '接管段是否检查工具调用是否符合任务图节点。' },
      ],
    },
    {
      title: 'triggers',
      desc: 'L2 异常信号阈值；达到后才可能 takeover。',
      fields: [
        { path: 'triggers.toolRepeatFailMin', type: 'number', label: '工具连续失败', desc: '同一工具连续失败多少次记为 tool_repeat_fail。' },
        { path: 'triggers.noProgressRoundsMin', type: 'number', label: '无进展轮数', desc: '连续多少轮无明显进展记为 no_progress。' },
        { path: 'triggers.fileLoopMin', type: 'number', label: '文件循环次数', desc: '同一文件反复修改多少次记为 file_loop。' },
        { path: 'triggers.goalDriftEnabled', type: 'boolean', label: '目标漂移检测', desc: '是否启用目标漂移检测。' },
        { path: 'triggers.scopeCreepEnabled', type: 'boolean', label: '范围蔓延检测', desc: '是否启用范围蔓延（做了目标外的事）检测。' },
        { path: 'triggers.userForceTakeoverEnabled', type: 'boolean', label: '允许强制接管', desc: '是否允许用户强制触发接管。' },
      ],
    },
    {
      title: 'goalDrift',
      desc: '目标漂移判定。',
      fields: [
        { path: 'goalDrift.alignmentThreshold', type: 'number', label: '对齐分阈值', desc: '当前行为与目标的对齐分低于该值视为漂移，范围 0～1。' },
        { path: 'goalDrift.consecutiveRoundsBelow', type: 'number', label: '连续低于轮数', desc: '对齐分连续低于阈值多少轮才触发漂移信号。' },
        { path: 'goalDrift.llmGrayZoneLow', type: 'number', optional: true, label: 'LLM 灰区下限', desc: '落在灰区时更谨慎，不立刻接管。' },
        { path: 'goalDrift.llmGrayZoneHigh', type: 'number', optional: true, label: 'LLM 灰区上限', desc: 'LLM 灰区上限。' },
      ],
    },
    {
      title: 'snapshotConfidence',
      desc: '工作区快照是否可信，影响接管后能否用模板图 / 反构图。',
      fields: [
        { path: 'snapshotConfidence.templateGraphMin', type: 'number', label: '模板图最低可信度', desc: '低于该可信度则不用一级模板图。' },
        { path: 'snapshotConfidence.weightGitClean', type: 'number', optional: true, label: 'Git 干净度权重', desc: 'git 工作区干净程度在可信度里的权重。' },
        { path: 'snapshotConfidence.weightSnapshotAge', type: 'number', optional: true, label: '快照新鲜度权重', desc: '快照新鲜度权重。' },
        { path: 'snapshotConfidence.weightVerifyPassed', type: 'number', optional: true, label: '验证通过权重', desc: '最近验证通过在可信度里的权重。' },
        { path: 'snapshotConfidence.weightRepoContextMatch', type: 'number', optional: true, label: '仓库匹配权重', desc: '仓库上下文与任务匹配程度的权重。' },
        { path: 'snapshotConfidence.weightBuildSignal', type: 'number', optional: true, label: '构建信号权重', desc: '构建/测试信号在可信度里的权重。' },
      ],
    },
    {
      title: 'correctionBudget',
      desc: '自由段纠偏注入次数。',
      fields: [
        { path: 'correctionBudget.freeSegmentMaxPerTask', type: 'number', label: '每任务纠偏次数', desc: '每个任务在 free 段最多注入多少次监管纠偏文案。' },
      ],
    },
    {
      title: 'eventTimeline',
      desc: '监管事件落盘。',
      fields: [
        { path: 'eventTimeline.enabled', type: 'boolean', label: '写入事件时间线', desc: '是否把监管事件写入 jsonl 时间线。' },
        { path: 'eventTimeline.persistPath', type: 'string', label: '事件文件路径', desc: '事件文件相对数据目录的路径。' },
      ],
    },
    {
      title: 'executionMode',
      desc: 'L1 执行模式（free ↔ forced）门槛。',
      fields: [
        { path: 'executionMode.enabled', type: 'boolean', optional: true, label: '启用自动切换', desc: '是否启用 L1 执行模式自动切换。' },
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
