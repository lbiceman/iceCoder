/**
 * Token 用量统计页：合计趋势 + 按模型趋势。
 * 日 / 当周 / 当月为滚动窗口：24 小时 / 7 天 / 30 天。
 */

/* exported StatsPage */

window.StatsPage = (function () {
  'use strict';

  var RANGE_KEYS = [
    { key: 'day', label: '日', hint: '最近 24 小时', days: 1 },
    { key: 'week', label: '当周', hint: '最近 7 天', days: 7 },
    { key: 'month', label: '当月', hint: '最近 30 天', days: 30 },
  ];

  var SIGNAL_LABELS = {
    task_graph_active: '任务图进行中',
    pending_steps: '未完成步骤',
    multi_write: '多文件写入',
    branch_switched: '分支切换',
    checkpoint_resumed: '检查点恢复',
    tool_failure: '工具失败',
    recovery_pending: '等待恢复',
    large_diff: '大范围改动',
    explicit_impl: '明确实现',
    engine_fail_safe: '引擎兜底',
    unknown: '其他',
  };

  var CHART_COLOR_VARS = ['--chart-1', '--chart-2', '--chart-3'];
  var UNKNOWN_MODEL = '未标注';

  var containerEl = null;
  var mainEl = null;
  var tooltipEl = null;
  var abortCtrl = null;
  var auxAbort = null;
  var resizeObs = null;
  var summary = null;
  var memorySummary = null;
  var supervisorSummary = null;
  var rangeKey = 'week';
  var chartSeq = 0;
  var trendChart = null;
  var memoryChart = null;
  var supervisorChart = null;
  var resizeTimer = null;
  var lastChartW = -1;
  var lastChartH = -1;

  function destroy() {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    if (auxAbort) {
      auxAbort.abort();
      auxAbort = null;
    }
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    lastChartW = -1;
    lastChartH = -1;
    unbindChart(trendChart);
    unbindChart(memoryChart);
    unbindChart(supervisorChart);
    trendChart = null;
    memoryChart = null;
    supervisorChart = null;
    tooltipEl = null;
    mainEl = null;
    containerEl = null;
    summary = null;
    memorySummary = null;
    supervisorSummary = null;
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML =
      '<div class="stats-root">' +
        '<header class="stats-header">' +
          '<div class="stats-header-text">' +
            '<h1 class="stats-title">统计</h1>' +
            '<p class="stats-hint">按会话气泡合计 Token；当周为最近 7 天，当月为最近 30 天</p>' +
          '</div>' +
          '<div class="stats-range" role="group" aria-label="时间范围">' + renderRangeButtons() + '</div>' +
        '</header>' +
        '<main class="stats-main"></main>' +
        '<div class="stats-tooltip" hidden></div>' +
      '</div>';
    mainEl = parentEl.querySelector('.stats-main');
    tooltipEl = parentEl.querySelector('.stats-tooltip');
    bindRangeButtons(containerEl);
    paintLoading();
    load();
  }

  function load() {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    var ctrl = abortCtrl;
    var timer = setTimeout(function () { ctrl.abort(); }, 30000);
    fetch('/api/token-usage', {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        }, function () {
          return { ok: res.ok, body: null };
        });
      })
      .then(function (out) {
        clearTimeout(timer);
        if (ctrl !== abortCtrl) return;
        var body = out.body;
        var next = (body && body.success)
          ? ensureChartData(body, ctrl.signal)
          : loadTokenStatsFromSessions(ctrl.signal);
        return next.then(function (ready) {
          if (ctrl !== abortCtrl) return;
          summary = ready;
          paint();
        });
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (ctrl !== abortCtrl) return;
        if (err && err.name === 'AbortError') return;
        paintError(err && err.message ? err.message : '网络错误');
      });
  }

  function fetchJson(url, signal) {
    return fetch(url, { signal: signal, headers: { Accept: 'application/json' } }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
        return body;
      }, function () {
        throw new Error('HTTP ' + res.status);
      });
    });
  }

  function hasSeries(body) {
    return !!(body
      && body.series
      && Array.isArray(body.series.hourly)
      && Array.isArray(body.series.daily)
      && body.series.hourly.length
      && body.series.daily.length);
  }

  function seriesHasTurns(body) {
    var lists = body && body.series ? [body.series.hourly, body.series.daily] : [];
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i];
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        if ((Number(list[j] && list[j].turns) || 0) > 0) return true;
      }
    }
    return false;
  }

  function ensureChartData(body, signal) {
    var seriesReady = hasSeries(body) && seriesHasTurns(body);
    if (seriesReady && body.all) return Promise.resolve(body);
    return loadRecordsFromSessions(signal).then(function (records) {
      if (!seriesReady) body.series = aggregateClientSeries(records);
      var windows = aggregateClientWindows(records);
      if (!body.day) body.day = windows.day;
      if (!body.week) body.week = windows.week;
      if (!body.month) body.month = windows.month;
      if (!body.all) body.all = windows.all;
      if (!body.byModel) {
        body.byModel = aggregateClientByModel(records);
      } else {
        var extra = aggregateClientByModel(records);
        var names = Object.keys(extra);
        for (var i = 0; i < names.length; i++) {
          if (!body.byModel[names[i]]) body.byModel[names[i]] = extra[names[i]];
          else if (!body.byModel[names[i]].all) body.byModel[names[i]].all = extra[names[i]].all;
        }
      }
      return body;
    });
  }

  function loadTokenStatsFromSessions(signal) {
    return loadRecordsFromSessions(signal).then(function (records) {
      var windows = aggregateClientWindows(records);
      return {
        success: true,
        day: windows.day,
        week: windows.week,
        month: windows.month,
        all: windows.all,
        byModel: aggregateClientByModel(records),
        series: aggregateClientSeries(records),
      };
    });
  }

  function loadRecordsFromSessions(signal) {
    return fetchJson('/api/sessions', signal).then(function (body) {
      var sessions = (body && body.sessions) || [];
      return Promise.all(sessions.map(function (session) {
        if (!session || !session.id) return [];
        return fetchJson('/api/sessions/' + encodeURIComponent(session.id), signal)
          .then(function (msgBody) {
            return extractTurnTokenRecords((msgBody && msgBody.messages) || []);
          })
          .catch(function () { return []; });
      })).then(function (batches) {
        var records = [];
        for (var i = 0; i < batches.length; i++) {
          for (var j = 0; j < batches[i].length; j++) records.push(batches[i][j]);
        }
        return records;
      });
    });
  }

  function extractTurnTokenRecords(messages) {
    var records = [];
    if (!Array.isArray(messages)) return records;
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      if (!msg || typeof msg !== 'object' || !msg.turnTokenUsage) continue;
      var usage = msg.turnTokenUsage;
      var input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
      var output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
      if (input <= 0 && output <= 0) continue;
      var ts = typeof msg.completedAt === 'number' && isFinite(msg.completedAt) && msg.completedAt > 0
        ? msg.completedAt
        : (typeof msg.sentAt === 'number' && isFinite(msg.sentAt) && msg.sentAt > 0 ? msg.sentAt : 0);
      if (ts <= 0) continue;
      var usedModel = typeof msg.usedModel === 'string' && msg.usedModel.trim()
        ? msg.usedModel.trim()
        : (typeof usage.usedModel === 'string' && usage.usedModel.trim()
          ? usage.usedModel.trim()
          : (typeof usage.model === 'string' && usage.model.trim() ? usage.model.trim() : ''));
      records.push({
        timestamp: ts,
        inputTokens: input,
        outputTokens: output,
        usedModel: usedModel,
      });
    }
    return records;
  }

  function emptyTotals() {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  function addTotals(target, rec) {
    target.inputTokens += rec.inputTokens;
    target.outputTokens += rec.outputTokens;
    target.totalTokens += rec.inputTokens + rec.outputTokens;
  }

  function aggregateClientWindows(records, now) {
    now = now || Date.now();
    var dayMs = 86400000;
    var windows = { day: emptyTotals(), week: emptyTotals(), month: emptyTotals(), all: emptyTotals() };
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      addTotals(windows.all, rec);
      if (rec.timestamp >= now - 30 * dayMs) addTotals(windows.month, rec);
      if (rec.timestamp >= now - 7 * dayMs) addTotals(windows.week, rec);
      if (rec.timestamp >= now - dayMs) addTotals(windows.day, rec);
    }
    return windows;
  }

  function aggregateClientByModel(records, now) {
    var grouped = {};
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec.usedModel) continue;
      if (!grouped[rec.usedModel]) grouped[rec.usedModel] = [];
      grouped[rec.usedModel].push(rec);
    }
    var out = {};
    var names = Object.keys(grouped);
    for (var j = 0; j < names.length; j++) out[names[j]] = aggregateClientWindows(grouped[names[j]], now);
    return out;
  }

  function emptyBucket(key, timestamp) {
    return {
      key: key,
      timestamp: timestamp,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turns: 0,
      byModel: {},
    };
  }

  function addToClientBucket(bucket, rec) {
    bucket.turns = (Number(bucket.turns) || 0) + 1;
    addTotals(bucket, rec);
    if (!rec.usedModel) return;
    if (!bucket.byModel[rec.usedModel]) bucket.byModel[rec.usedModel] = emptyTotals();
    addTotals(bucket.byModel[rec.usedModel], rec);
  }

  function localDateKeyFromDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function localHourKeyFromDate(d) {
    return localDateKeyFromDate(d) + 'T' + pad2(d.getHours()) + ':00';
  }

  function aggregateClientSeries(records, now) {
    now = now || Date.now();
    var hourMs = 3600000;
    var hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    var hourly = [];
    var hourlyMap = {};
    for (var i = 23; i >= 0; i--) {
      var ts = hourStart.getTime() - i * hourMs;
      var hd = new Date(ts);
      var hKey = localHourKeyFromDate(hd);
      var hBucket = emptyBucket(hKey, ts);
      hourly.push(hBucket);
      hourlyMap[hKey] = hBucket;
    }
    var dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    var daily = [];
    var dailyMap = {};
    for (var d = 30; d >= 0; d--) {
      var day = new Date(dayStart);
      day.setDate(day.getDate() - d);
      var dKey = localDateKeyFromDate(day);
      var dBucket = emptyBucket(dKey, day.getTime());
      daily.push(dBucket);
      dailyMap[dKey] = dBucket;
    }
    var hourCutoff = hourly[0].timestamp;
    var dayCutoff = daily[0].timestamp;
    for (var r = 0; r < records.length; r++) {
      var rec = records[r];
      if (rec.timestamp >= hourCutoff) {
        var recHour = new Date(rec.timestamp);
        recHour.setMinutes(0, 0, 0);
        var hb = hourlyMap[localHourKeyFromDate(recHour)];
        if (hb) addToClientBucket(hb, rec);
      }
      if (rec.timestamp >= dayCutoff) {
        var recDay = new Date(rec.timestamp);
        recDay.setHours(0, 0, 0, 0);
        var db = dailyMap[localDateKeyFromDate(recDay)];
        if (db) addToClientBucket(db, rec);
      }
    }
    return { hourly: hourly, daily: daily };
  }

  function paintLoading() {
    if (!mainEl) return;
    mainEl.innerHTML =
      '<section class="stats-card stats-card-main" aria-busy="true">' +
        '<div class="stats-card-head"><span class="stats-skel is-label"></span></div>' +
        '<div class="stats-aux-metrics">' + skelMetrics() + '</div>' +
        '<div class="stats-skel-chart"></div>' +
      '</section>' +
      '<div class="stats-split stats-split-aux">' +
        '<section class="stats-card" aria-busy="true">' +
          '<div class="stats-card-head"><span class="stats-skel is-label"></span></div>' +
          '<div class="stats-skel-chart"></div>' +
        '</section>' +
        '<section class="stats-card" aria-busy="true">' +
          '<div class="stats-card-head"><span class="stats-skel is-label"></span></div>' +
          '<div class="stats-skel-chart"></div>' +
        '</section>' +
      '</div>';
  }

  function paintError(message) {
    if (!mainEl) return;
    mainEl.innerHTML =
      '<div class="stats-status" role="alert">' +
        '<p>统计失败：' + escapeHtml(message) + '</p>' +
        '<button type="button" class="stats-retry">重试</button>' +
      '</div>';
    var retry = mainEl.querySelector('.stats-retry');
    if (retry) {
      retry.addEventListener('click', function () {
        paintLoading();
        load();
      });
    }
  }

  function paint() {
    if (!mainEl || !summary) return;
    unbindChart(trendChart);
    unbindChart(memoryChart);
    unbindChart(supervisorChart);
    trendChart = null;
    memoryChart = null;
    supervisorChart = null;
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }

    mainEl.innerHTML =
      '<section class="stats-card stats-card-main">' +
        '<div class="stats-card-head">' +
          '<span class="stats-card-label">Token 消耗</span>' +
          '<span class="stats-card-value" data-role="trend-total"></span>' +
        '</div>' +
        '<div class="stats-aux-metrics" data-role="trend-metrics"></div>' +
        '<div class="stats-chart" data-chart="trend"></div>' +
        '<div class="stats-legend" data-role="trend-legend"></div>' +
      '</section>' +
      '<div class="stats-split stats-split-aux">' +
        '<section class="stats-card">' +
          '<div class="stats-card-head">' +
            '<span class="stats-card-label">记忆</span>' +
            '<span class="stats-card-value" data-role="memory-store"></span>' +
          '</div>' +
          '<div class="stats-aux-metrics" data-role="memory-metrics"></div>' +
          '<div class="stats-chart" data-chart="memory"></div>' +
          '<div class="stats-legend" data-role="memory-legend"></div>' +
        '</section>' +
        '<section class="stats-card">' +
          '<div class="stats-card-head">' +
            '<span class="stats-card-label">监管</span>' +
            '<span class="stats-card-value" data-role="supervisor-enter"></span>' +
          '</div>' +
          '<div class="stats-aux-metrics" data-role="supervisor-metrics"></div>' +
          '<div class="stats-chart" data-chart="supervisor"></div>' +
          '<div class="stats-legend" data-role="supervisor-legend"></div>' +
        '</section>' +
      '</div>';

    bindRangeButtons(mainEl);
    paintRangeDependent();
    observeCharts();
    loadAux();
  }

  function renderRangeButtons() {
    var html = '';
    for (var i = 0; i < RANGE_KEYS.length; i++) {
      var row = RANGE_KEYS[i];
      html +=
        '<button type="button" class="stats-range-btn" data-range="' + row.key + '"' +
          ' aria-pressed="' + (rangeKey === row.key ? 'true' : 'false') + '">' +
          escapeHtml(row.label) +
        '</button>';
    }
    return html;
  }

  function bindRangeButtons(root) {
    if (!root) return;
    var buttons = root.querySelectorAll('[data-range]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (ev) {
        var next = ev.currentTarget.getAttribute('data-range');
        setRange(next);
      });
    }
  }

  function setRange(next) {
    if (!next || next === rangeKey) return;
    rangeKey = next;
    if (containerEl) {
      var buttons = containerEl.querySelectorAll('[data-range]');
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].setAttribute('aria-pressed', buttons[j].getAttribute('data-range') === rangeKey ? 'true' : 'false');
      }
    }
    paintRangeDependent();
    loadAux();
  }

  function paintRangeDependent() {
    if (!mainEl || !summary) return;
    var range = currentRange();
    var buckets = bucketsForRange(range.key);
    var mount = mainEl.querySelector('[data-chart="trend"]');
    if (mount) {
      lastChartW = mount.clientWidth;
      lastChartH = mount.clientHeight;
    }
    paintTrendChart(buckets, range);
    paintAuxCharts();
  }

  function daysForRange(key) {
    for (var i = 0; i < RANGE_KEYS.length; i++) {
      if (RANGE_KEYS[i].key === key) return RANGE_KEYS[i].days || 7;
    }
    return 7;
  }

  function loadAux() {
    if (auxAbort) auxAbort.abort();
    auxAbort = new AbortController();
    var ctrl = auxAbort;
    paintAuxLoading();
    var days = daysForRange(rangeKey);
    Promise.all([
      fetchJson('/api/memory/telemetry?days=' + encodeURIComponent(String(days)) + '&format=json', ctrl.signal)
        .catch(function () { return null; }),
      fetchJson('/api/supervisor/events?days=' + encodeURIComponent(String(days)), ctrl.signal)
        .catch(function () { return null; }),
    ]).then(function (pair) {
      if (ctrl !== auxAbort) return;
      memorySummary = pair[0];
      supervisorSummary = pair[1];
      paintAux();
    });
  }

  function paintAuxLoading() {
    var memoryEl = mainEl && mainEl.querySelector('[data-role="memory-metrics"]');
    var supervisorEl = mainEl && mainEl.querySelector('[data-role="supervisor-metrics"]');
    var html = skelMetrics();
    if (memoryEl) memoryEl.innerHTML = html;
    if (supervisorEl) supervisorEl.innerHTML = html;
    paintChartSkeleton(mainEl && mainEl.querySelector('[data-chart="memory"]'), 'memory');
    paintChartSkeleton(mainEl && mainEl.querySelector('[data-chart="supervisor"]'), 'supervisor');
    hideTooltip();
  }

  function paintChartSkeleton(mount, which) {
    if (which === 'memory') {
      unbindChart(memoryChart);
      memoryChart = null;
    } else {
      unbindChart(supervisorChart);
      supervisorChart = null;
    }
    if (!mount) return;
    mount.innerHTML = '<div class="stats-skel-chart"></div>';
  }

  function paintAux() {
    paintMemoryPanel();
    paintSupervisorPanel();
    paintAuxCharts();
  }

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  function paintMemoryPanel() {
    if (!mainEl) return;
    var panel = mainEl.querySelector('[data-role="memory-metrics"]');
    var storeEl = mainEl.querySelector('[data-role="memory-store"]');
    if (!panel) return;
    var log = memorySummary && memorySummary.log ? memorySummary.log : {};
    var store = memorySummary && memorySummary.store ? memorySummary.store : {};
    var recall = log.recall || {};
    var extract = log.extract || {};
    var dream = log.dream || {};
    var files = num(store.totalFiles);
    if (storeEl) storeEl.textContent = files ? (formatTokenCount(files) + ' 条') : '';
    if (!memorySummary) {
      panel.innerHTML = '<p class="stats-muted">暂无记忆遥测。</p>';
      return;
    }
    panel.innerHTML =
        auxMetric('读取', formatTokenCount(num(recall.count)), '选中 ' + formatTokenCount(num(recall.totalSelected)) + ' 条') +
        auxMetric('写入', formatTokenCount(num(extract.totalMemories) || num(extract.count)), '提取 ' + formatTokenCount(num(extract.count)) + ' 次') +
        auxMetric('修改', formatTokenCount(num(dream.totalModified)), 'Dream ' + formatTokenCount(num(dream.count)) + ' 次');
  }

  function paintSupervisorPanel() {
    if (!mainEl) return;
    var panel = mainEl.querySelector('[data-role="supervisor-metrics"]');
    var enterEl = mainEl.querySelector('[data-role="supervisor-enter"]');
    if (!panel) return;
    var mode = supervisorSummary && supervisorSummary.executionMode ? supervisorSummary.executionMode : {};
    var enter = num(mode.enter);
    var exit = num(mode.exit);
    var bySignal = supervisorBySignal(mode);
    var keys = Object.keys(bySignal).sort(function (a, b) { return num(bySignal[b]) - num(bySignal[a]); });
    if (enterEl) enterEl.textContent = enter ? (formatTokenCount(enter) + ' 次') : '';
    if (!supervisorSummary) {
      panel.innerHTML = '<p class="stats-muted">暂无监管触发记录。</p>';
      return;
    }
    panel.innerHTML =
        auxMetric('进入', formatTokenCount(enter), 'forced') +
        auxMetric('退出', formatTokenCount(exit), '回到 free') +
        auxMetric('触发源', formatTokenCount(keys.length), keys.length ? signalLabel(keys[0]) : '暂无');
  }

  function paintAuxCharts() {
    if (!mainEl) return;
    var range = currentRange();
    var colors = chartColors();
    paintMemoryChart(range, colors);
    paintSupervisorChart(range, colors);
  }

  function paintMemoryChart(range, colors) {
    var mount = mainEl.querySelector('[data-chart="memory"]');
    var legendEl = mainEl.querySelector('[data-role="memory-legend"]');
    if (!mount) return;
    unbindChart(memoryChart);
    var buckets = memorySummary && Array.isArray(memorySummary.series) ? memorySummary.series : [];
    if (!buckets.length) {
      mount.innerHTML = '<p class="stats-muted">暂无读取 / 写入 / 修改趋势。</p>';
      if (legendEl) legendEl.innerHTML = '';
      memoryChart = null;
      return;
    }
    var series = [
      { key: 'recall', label: '读取', color: colors[0], values: buckets.map(function (b) { return num(b.recall); }) },
      { key: 'extract', label: '写入', color: colors[1], values: buckets.map(function (b) { return num(b.extract); }) },
      { key: 'dream', label: '修改', color: colors[2], values: buckets.map(function (b) { return num(b.dream); }) },
    ];
    if (legendEl) legendEl.innerHTML = renderLegend(series);
    memoryChart = bindAreaChart(mount, {
      id: 'memory',
      labels: buckets.map(function (b) { return b.key; }),
      series: series,
      stacked: false,
      filled: false,
      emptyText: '该时间范围暂无记忆读写',
      formatX: range.key === 'day' ? formatHourTick : formatDayTick,
      formatTipTitle: range.key === 'day' ? formatHourTip : formatDayTip,
    });
  }

  function paintSupervisorChart(range, colors) {
    var mount = mainEl.querySelector('[data-chart="supervisor"]');
    var legendEl = mainEl.querySelector('[data-role="supervisor-legend"]');
    if (!mount) return;
    unbindChart(supervisorChart);
    var mode = supervisorSummary && supervisorSummary.executionMode ? supervisorSummary.executionMode : {};
    var buckets = Array.isArray(mode.series) ? mode.series : [];
    if (!buckets.length) {
      mount.innerHTML = '<p class="stats-muted">暂无监管触发趋势。</p>';
      if (legendEl) legendEl.innerHTML = '';
      supervisorChart = null;
      return;
    }
    var series = [
      { key: 'enter', label: '进入', color: colors[2], values: buckets.map(function (b) { return num(b.enter); }) },
      { key: 'exit', label: '退出', color: colors[0], values: buckets.map(function (b) { return num(b.exit); }) },
    ];
    if (legendEl) legendEl.innerHTML = renderLegend(series);
    supervisorChart = bindAreaChart(mount, {
      id: 'supervisor',
      labels: buckets.map(function (b) { return b.key; }),
      series: series,
      stacked: false,
      filled: false,
      emptyText: '该时间范围暂无监管触发',
      formatX: range.key === 'day' ? formatHourTick : formatDayTick,
      formatTipTitle: range.key === 'day' ? formatHourTip : formatDayTip,
    });
  }

  function auxMetric(label, value, sub) {
    return (
      '<div class="stats-aux-metric">' +
        '<div class="stats-aux-metric-label">' + escapeHtml(label) + '</div>' +
        '<div class="stats-aux-metric-value">' + escapeHtml(value) + '</div>' +
        '<div class="stats-aux-metric-sub">' + escapeHtml(sub) + '</div>' +
      '</div>'
    );
  }

  function skelMetric() {
    return (
      '<div class="stats-aux-metric">' +
        '<div class="stats-aux-metric-label"><span class="stats-skel is-label"></span></div>' +
        '<div class="stats-aux-metric-value"><span class="stats-skel is-value"></span></div>' +
        '<div class="stats-aux-metric-sub"><span class="stats-skel is-hint"></span></div>' +
      '</div>'
    );
  }

  function skelMetrics() {
    return skelMetric() + skelMetric() + skelMetric();
  }

  function supervisorBySignal(mode) {
    if (mode.bySignal && typeof mode.bySignal === 'object' && Object.keys(mode.bySignal).length) {
      return mode.bySignal;
    }
    var out = {};
    var recent = Array.isArray(mode.recent) ? mode.recent : [];
    for (var i = 0; i < recent.length; i++) {
      var ev = recent[i];
      if (!ev || ev.type !== 'execution_mode_enter') continue;
      var payload = ev.payload || {};
      var signal = payload.enteredByPrimary
        || (Array.isArray(payload.enteredBy) && payload.enteredBy[0])
        || 'unknown';
      out[signal] = (out[signal] || 0) + 1;
    }
    return out;
  }

  function signalLabel(key) {
    return SIGNAL_LABELS[key] || key || '其他';
  }

  function observeCharts() {
    if (!mainEl || typeof ResizeObserver !== 'function') return;
    resizeObs = new ResizeObserver(function () {
      var mount = mainEl.querySelector('[data-chart="trend"]');
      var width = mount ? mount.clientWidth : 0;
      var height = mount ? mount.clientHeight : 0;
      if (Math.abs(width - lastChartW) < 2 && Math.abs(height - lastChartH) < 2) return;
      lastChartW = width;
      lastChartH = height;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        paintRangeDependent();
      }, 80);
    });
    var charts = mainEl.querySelectorAll('.stats-chart');
    for (var i = 0; i < charts.length; i++) resizeObs.observe(charts[i]);
  }

  function paintTrendChart(buckets, range) {
    var mount = mainEl && mainEl.querySelector('[data-chart="trend"]');
    var totalEl = mainEl && mainEl.querySelector('[data-role="trend-total"]');
    var legendEl = mainEl && mainEl.querySelector('[data-role="trend-legend"]');
    if (!mount) return;
    unbindChart(trendChart);
    paintTrendMetrics(buckets);
    var colors = chartColors();
    var totals = buckets.map(function (b) { return Number(b.totalTokens) || 0; });
    var series = buildTokenSeries(buckets, colors);
    if (totalEl) totalEl.textContent = formatTokenCount(sumValues(totals));
    if (legendEl) legendEl.innerHTML = series.length > 1 ? renderLegend(series) : '';
    trendChart = bindAreaChart(mount, {
      id: 'trend',
      labels: buckets.map(function (b) { return b.key; }),
      series: series.length
        ? series
        : [{ key: 'total', label: '合计', color: colors[0], values: totals }],
      stacked: false,
      filled: false,
      emptyText: '该时间范围暂无用量',
      formatX: range.key === 'day' ? formatHourTick : formatDayTick,
      formatTipTitle: range.key === 'day' ? formatHourTip : formatDayTip,
    });
  }

  function paintTrendMetrics(buckets) {
    var panel = mainEl && mainEl.querySelector('[data-role="trend-metrics"]');
    if (!panel) return;
    var usage = sumBucketTotals(buckets);
    var turns = 0;
    for (var i = 0; i < buckets.length; i++) turns += Number(buckets[i].turns) || 0;
    var total = usage.totalTokens;
    var inShare = total > 0 ? Math.round((usage.inputTokens / total) * 100) : 0;
    var outShare = total > 0 ? Math.max(0, 100 - inShare) : 0;
    panel.innerHTML =
      auxMetric('输入', formatTokenCount(usage.inputTokens), inShare + '%') +
      auxMetric('输出', formatTokenCount(usage.outputTokens), outShare + '%') +
      auxMetric('请求次数', formatTokenCount(turns), '次');
  }

  function buildTokenSeries(buckets, colors) {
    var models = modelKeysFromBuckets(buckets);
    var unnamed = unnamedValues(buckets);
    var hasUnnamed = unnamed.some(function (v) { return v > 0; });
    var series = [];
    var colorIdx = 0;
    if (hasUnnamed) {
      series.push({
        key: 'unnamed',
        label: UNKNOWN_MODEL,
        color: colors[0],
        values: unnamed,
      });
      colorIdx = 1;
    }
    var i;
    for (i = 0; i < models.length; i++) {
      series.push({
        key: models[i],
        label: models[i],
        color: colors[colorIdx % colors.length],
        values: valuesForModel(buckets, models[i]),
      });
      colorIdx += 1;
    }
    if (!series.length) {
      series.push({
        key: 'total',
        label: '合计',
        color: colors[0],
        values: buckets.map(function (b) { return Number(b.totalTokens) || 0; }),
      });
    }
    return series;
  }

  function unnamedValues(buckets) {
    return buckets.map(function (b) {
      var named = 0;
      var byModel = b && b.byModel ? b.byModel : {};
      var names = Object.keys(byModel);
      for (var i = 0; i < names.length; i++) {
        named += Number(byModel[names[i]] && byModel[names[i]].totalTokens) || 0;
      }
      return Math.max(0, (Number(b.totalTokens) || 0) - named);
    });
  }

  function renderLegend(series) {
    var html = '';
    for (var i = 0; i < series.length; i++) {
      html +=
        '<span class="stats-legend-item">' +
          '<span class="stats-legend-swatch" style="background:' + series[i].color + '"></span>' +
          escapeHtml(series[i].label) +
        '</span>';
    }
    return html;
  }

  function bindAreaChart(mount, opts) {
    var showX = opts.showX !== false;
    var width = Math.max(120, mount.clientWidth || 0);
    var height = mount.clientHeight > 40 ? mount.clientHeight : 160;
    var pad = { top: 10, right: 8, bottom: showX ? 24 : 8, left: 8 };
    var plotW = Math.max(40, width - pad.left - pad.right);
    var plotH = Math.max(40, height - pad.top - pad.bottom);
    var labels = opts.labels || [];
    var series = opts.series || [];
    var n = labels.length;
    chartSeq += 1;
    var uid = opts.id + '-' + chartSeq;

    if (!n) {
      mount.innerHTML = '<p class="stats-muted">暂无时间序列。</p>';
      return null;
    }

    var stacked = !!opts.stacked;
    var filled = opts.filled !== false;
    var emptyText = opts.emptyText || '该时间范围暂无用量';
    if (stacked && series.length > 1) {
      series = series.slice().sort(function (a, b) {
        return sumValues(a.values) - sumValues(b.values);
      });
    }
    var tops = [];
    var bottoms = [];
    var i;
    var s;
    for (s = 0; s < series.length; s++) {
      tops[s] = [];
      bottoms[s] = [];
      for (i = 0; i < n; i++) {
        var prev = s === 0 ? 0 : tops[s - 1][i];
        var value = Number(series[s].values[i]) || 0;
        bottoms[s][i] = stacked ? prev : 0;
        tops[s][i] = (stacked ? prev : 0) + value;
      }
    }

    var maxY = 0;
    for (s = 0; s < tops.length; s++) {
      for (i = 0; i < n; i++) if (tops[s][i] > maxY) maxY = tops[s][i];
    }
    var empty = maxY <= 0;
    if (empty) maxY = 1;

    var xs = [];
    for (i = 0; i < n; i++) {
      xs[i] = n === 1 ? pad.left + plotW / 2 : pad.left + (plotW * i) / (n - 1);
    }
    function yOf(v) {
      return pad.top + plotH - (v / maxY) * plotH;
    }

    var defs = '';
    var areas = '';
    for (s = 0; s < series.length; s++) {
      var gid = uid + '-g' + s;
      var topYs = tops[s].map(yOf);
      var botYs = bottoms[s].map(yOf);
      if (filled) {
        defs +=
          '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="5%" stop-color="' + series[s].color + '" stop-opacity="0.8"/>' +
            '<stop offset="95%" stop-color="' + series[s].color + '" stop-opacity="0.08"/>' +
          '</linearGradient>';
        areas +=
          '<path class="stats-area-fill" d="' + areaPath(xs, topYs, botYs) + '" fill="url(#' + gid + ')"/>';
      }
      areas +=
        '<path class="stats-area-stroke" d="' + linePath(xs, topYs) + '" stroke="' + series[s].color + '"/>';
    }

    var grid = '';
    for (i = 0; i <= 3; i++) {
      var gy = pad.top + (plotH * i) / 3;
      grid += '<line x1="' + pad.left + '" x2="' + (pad.left + plotW) + '" y1="' + gy + '" y2="' + gy + '" class="stats-grid-line"/>';
    }

    var ticks = showX ? tickIndices(n, n > 16 ? 6 : (n > 8 ? 7 : n)) : [];
    var axis = '';
    for (i = 0; i < ticks.length; i++) {
      var idx = ticks[i];
      var label = opts.formatX ? opts.formatX(labels[idx]) : labels[idx];
      var anchor = idx === 0 ? 'start' : (idx === n - 1 ? 'end' : 'middle');
      axis +=
        '<text x="' + xs[idx] + '" y="' + (height - 6) + '" text-anchor="' + anchor + '" class="stats-axis-label">' +
          escapeHtml(label) +
        '</text>';
    }

    var hoverDots = '';
    for (s = 0; s < series.length; s++) {
      hoverDots +=
        '<circle class="stats-hover-dot" data-series="' + s + '" r="3.5" cx="0" cy="0" fill="' + series[s].color + '"></circle>';
    }

    mount.innerHTML =
      '<svg class="stats-svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '" role="img">' +
        '<defs>' + defs + '</defs>' +
        '<g class="stats-grid">' + grid + '</g>' +
        '<g class="stats-areas">' + areas + '</g>' +
        '<g class="stats-axis">' + axis + '</g>' +
        '<g class="stats-hover" visibility="hidden">' +
          '<line class="stats-hover-line" x1="0" x2="0" y1="' + pad.top + '" y2="' + (pad.top + plotH) + '"/>' +
          hoverDots +
        '</g>' +
      '</svg>' +
      (empty ? '<div class="stats-chart-empty">' + escapeHtml(emptyText) + '</div>' : '');

    var svg = mount.querySelector('.stats-svg');
    var hoverG = mount.querySelector('.stats-hover');
    var hoverLine = mount.querySelector('.stats-hover-line');
    var dots = mount.querySelectorAll('.stats-hover-dot');
    var state = { mount: mount, onMove: null, onLeave: null, svg: svg };

    function nearestIndex(clientX) {
      var rect = svg.getBoundingClientRect();
      var x = ((clientX - rect.left) / rect.width) * width;
      var best = 0;
      var bestDist = Infinity;
      for (var p = 0; p < xs.length; p++) {
        var dist = Math.abs(xs[p] - x);
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      return best;
    }

    function onMove(ev) {
      var idx = nearestIndex(ev.clientX);
      var x = xs[idx];
      hoverG.setAttribute('visibility', 'visible');
      hoverLine.setAttribute('x1', String(x));
      hoverLine.setAttribute('x2', String(x));
      for (var d = 0; d < dots.length; d++) {
        dots[d].setAttribute('cx', String(x));
        dots[d].setAttribute('cy', String(yOf(tops[d][idx])));
      }
      var rows = '';
      var shown = 0;
      for (var r = series.length - 1; r >= 0; r--) {
        var raw = Number(series[r].values[idx]) || 0;
        if (raw <= 0 && series.length > 2) continue;
        shown += 1;
        rows +=
          '<div class="stats-tooltip-row">' +
            '<span class="stats-tooltip-swatch" style="background:' + series[r].color + '"></span>' +
            '<span class="stats-tooltip-name">' + escapeHtml(series[r].label) + '</span>' +
            '<span class="stats-tooltip-value">' + formatTokenCount(raw) + '</span>' +
          '</div>';
      }
      if (!shown) {
        rows =
          '<div class="stats-tooltip-row">' +
            '<span class="stats-tooltip-name">合计</span>' +
            '<span class="stats-tooltip-value">0</span>' +
          '</div>';
      }
      showTooltip(
        ev.clientX,
        ev.clientY,
        '<div class="stats-tooltip-title">' + escapeHtml(opts.formatTipTitle ? opts.formatTipTitle(labels[idx]) : labels[idx]) + '</div>' + rows,
      );
    }

    function onLeave() {
      hoverG.setAttribute('visibility', 'hidden');
      hideTooltip();
    }

    svg.addEventListener('mousemove', onMove);
    svg.addEventListener('mouseleave', onLeave);
    state.onMove = onMove;
    state.onLeave = onLeave;
    return state;
  }

  function unbindChart(chart) {
    if (!chart) return;
    if (chart.svg && chart.onMove) chart.svg.removeEventListener('mousemove', chart.onMove);
    if (chart.svg && chart.onLeave) chart.svg.removeEventListener('mouseleave', chart.onLeave);
  }

  function showTooltip(clientX, clientY, html) {
    if (!tooltipEl) return;
    tooltipEl.hidden = false;
    tooltipEl.innerHTML = html;
    var pad = 12;
    var tw = tooltipEl.offsetWidth || 180;
    var th = tooltipEl.offsetHeight || 80;
    var x = clientX + 16;
    var y = clientY + 16;
    if (x + tw + pad > window.innerWidth) x = clientX - tw - 12;
    if (y + th + pad > window.innerHeight) y = clientY - th - 12;
    tooltipEl.style.left = Math.max(8, x) + 'px';
    tooltipEl.style.top = Math.max(8, y) + 'px';
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.hidden = true;
  }

  function linePath(xs, ys) {
    var n = ys.length;
    if (!n) return '';
    if (n === 1) return 'M' + xs[0] + ',' + ys[0];
    var m = monotoneTangents(xs, ys);
    var d = 'M' + xs[0] + ',' + ys[0];
    for (var i = 0; i < n - 1; i++) {
      var dx = xs[i + 1] - xs[i];
      d += 'C'
        + (xs[i] + dx / 3) + ',' + (ys[i] + m[i] * dx / 3) + ' '
        + (xs[i + 1] - dx / 3) + ',' + (ys[i + 1] - m[i + 1] * dx / 3) + ' '
        + xs[i + 1] + ',' + ys[i + 1];
    }
    return d;
  }

  function areaPath(xs, topYs, bottomYs) {
    var top = linePath(xs, topYs);
    if (!top) return '';
    var revXs = xs.slice().reverse();
    var revYs = bottomYs.slice().reverse();
    var bottom = linePath(revXs, revYs).replace(/^M/, 'L');
    return top + bottom + 'Z';
  }

  function monotoneTangents(xs, ys) {
    var n = ys.length;
    var delta = new Array(Math.max(0, n - 1));
    var m = new Array(n);
    var i;
    for (i = 0; i < n - 1; i++) {
      var dx = xs[i + 1] - xs[i];
      delta[i] = dx ? (ys[i + 1] - ys[i]) / dx : 0;
    }
    if (n === 1) {
      m[0] = 0;
      return m;
    }
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for (i = 1; i < n - 1; i++) {
      m[i] = (delta[i - 1] * delta[i] <= 0) ? 0 : (delta[i - 1] + delta[i]) / 2;
    }
    for (i = 0; i < n - 1; i++) {
      if (delta[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
      } else {
        var a = m[i] / delta[i];
        var b = m[i + 1] / delta[i];
        var ss = a * a + b * b;
        if (ss > 9) {
          var t = 3 / Math.sqrt(ss);
          m[i] = t * a * delta[i];
          m[i + 1] = t * b * delta[i];
        }
      }
    }
    return m;
  }

  function tickIndices(n, maxTicks) {
    if (n <= maxTicks) {
      var all = [];
      for (var i = 0; i < n; i++) all.push(i);
      return all;
    }
    var step = Math.ceil((n - 1) / (maxTicks - 1));
    var out = [];
    for (var j = 0; j < n; j += step) out.push(j);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }

  function currentRange() {
    for (var i = 0; i < RANGE_KEYS.length; i++) {
      if (RANGE_KEYS[i].key === rangeKey) return RANGE_KEYS[i];
    }
    return RANGE_KEYS[1];
  }

  function bucketsForRange(key) {
    var series = (summary && summary.series) || {};
    if (key === 'day') return Array.isArray(series.hourly) ? series.hourly : [];
    var daily = Array.isArray(series.daily) ? series.daily : [];
    if (key === 'week') return daily.slice(Math.max(0, daily.length - 7));
    return daily.slice(Math.max(0, daily.length - 30));
  }

  function sumBucketTotals(buckets) {
    var totals = emptyTotals();
    for (var i = 0; i < buckets.length; i++) {
      totals.inputTokens += Number(buckets[i].inputTokens) || 0;
      totals.outputTokens += Number(buckets[i].outputTokens) || 0;
      totals.totalTokens += Number(buckets[i].totalTokens) || 0;
    }
    return totals;
  }

  function modelKeysFromBuckets(buckets) {
    var totals = {};
    for (var i = 0; i < buckets.length; i++) {
      var byModel = buckets[i] && buckets[i].byModel ? buckets[i].byModel : {};
      var names = Object.keys(byModel);
      for (var j = 0; j < names.length; j++) {
        var name = names[j];
        totals[name] = (totals[name] || 0) + (Number(byModel[name].totalTokens) || 0);
      }
    }
    return Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
  }

  function valuesForModel(buckets, model) {
    return buckets.map(function (b) {
      var row = b && b.byModel && b.byModel[model];
      return row ? (Number(row.totalTokens) || 0) : 0;
    });
  }

  function sumValues(values) {
    var total = 0;
    for (var i = 0; i < values.length; i++) total += Number(values[i]) || 0;
    return total;
  }

  function chartColors() {
    var styles = getComputedStyle(document.documentElement);
    var out = [];
    for (var i = 0; i < CHART_COLOR_VARS.length; i++) {
      var value = styles.getPropertyValue(CHART_COLOR_VARS[i]).trim();
      out.push(value || '#6d8cff');
    }
    return out;
  }

  function formatTokenCount(n) {
    var num = typeof n === 'number' && isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    try {
      return num.toLocaleString();
    } catch (_err) {
      return String(num);
    }
  }

  function parseStamp(key) {
    if (!key) return null;
    if (key.indexOf('T') >= 0) {
      var d = new Date(key.length === 16 ? key + ':00' : key);
      return isNaN(d.getTime()) ? null : d;
    }
    var day = new Date(key + 'T00:00:00');
    return isNaN(day.getTime()) ? null : day;
  }

  function formatHourTick(key) {
    var m = /T(\d{2}):/.exec(key || '');
    return m ? m[1] + ':00' : key;
  }

  function formatDayTick(key) {
    var d = parseStamp(key);
    if (!d) return key;
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function formatHourTip(key) {
    var d = parseStamp(key);
    if (!d) return key;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':00';
  }

  function formatDayTip(key) {
    var d = parseStamp(key);
    if (!d) return key;
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    render: render,
    destroy: destroy,
  };
})();
