/**
 * Token 用量统计页：按会话气泡合计与使用模型画图。
 * 口径与 ~tokens 弹框相同（滚动 24 小时 / 7 天 / 30 天），图表另用小时/日桶。
 */

/* exported StatsPage */

window.StatsPage = (function () {
  'use strict';

  var RANGE_KEYS = [
    { key: 'day', label: '24 小时', hint: '24 小时', windowKey: 'day' },
    { key: 'week', label: '7 天', hint: '7 天', windowKey: 'week' },
    { key: 'month', label: '30 天', hint: '30 天', windowKey: 'month' },
  ];

  var KPI_ROWS = [
    { key: 'day', label: '最近一天', hint: '24 小时' },
    { key: 'week', label: '最近一周', hint: '7 天' },
    { key: 'month', label: '最近一个月', hint: '30 天' },
    { key: 'all', label: '全部', hint: '历史合计' },
  ];

  var CHART_COLOR_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

  var containerEl = null;
  var mainEl = null;
  var tooltipEl = null;
  var abortCtrl = null;
  var resizeObs = null;
  var summary = null;
  var rangeKey = 'week';
  var chartSeq = 0;
  var trendChart = null;
  var ioChart = null;
  var modelChart = null;
  var resizeTimer = null;
  var lastChartWidth = -1;

  function destroy() {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    lastChartWidth = -1;
    unbindChart(trendChart);
    unbindChart(ioChart);
    unbindChart(modelChart);
    trendChart = null;
    ioChart = null;
    modelChart = null;
    tooltipEl = null;
    mainEl = null;
    containerEl = null;
    summary = null;
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML =
      '<div class="stats-root">' +
        '<header class="stats-header">' +
          '<div class="stats-header-text">' +
            '<h1 class="stats-title">统计</h1>' +
            '<p class="stats-hint">按会话气泡底部的合计 Token 与模型名称汇总，口径与 ~tokens 一致。</p>' +
          '</div>' +
        '</header>' +
        '<main class="stats-main"></main>' +
        '<div class="stats-tooltip" hidden></div>' +
      '</div>';
    mainEl = parentEl.querySelector('.stats-main');
    tooltipEl = parentEl.querySelector('.stats-tooltip');
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

  function ensureChartData(body, signal) {
    if (hasSeries(body) && body.all) return Promise.resolve(body);
    return loadRecordsFromSessions(signal).then(function (records) {
      if (!hasSeries(body)) body.series = aggregateClientSeries(records);
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
      byModel: {},
    };
  }

  function addToClientBucket(bucket, rec) {
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
    for (var d = 29; d >= 0; d--) {
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
      '<div class="stats-kpi-grid" aria-busy="true">' +
        kpiSkeleton() + kpiSkeleton() + kpiSkeleton() + kpiSkeleton() +
      '</div>' +
      '<section class="stats-card"><div class="stats-skel-chart"></div></section>' +
      '<div class="stats-split">' +
        '<section class="stats-card"><div class="stats-skel-chart is-short"></div></section>' +
        '<section class="stats-card"><div class="stats-skel-chart is-short"></div></section>' +
      '</div>';
  }

  function kpiSkeleton() {
    return (
      '<div class="stats-kpi">' +
        '<span class="stats-skel is-label"></span>' +
        '<span class="stats-skel is-value"></span>' +
        '<span class="stats-skel is-hint"></span>' +
      '</div>'
    );
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
    unbindChart(ioChart);
    unbindChart(modelChart);
    trendChart = null;
    ioChart = null;
    modelChart = null;
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }

    mainEl.innerHTML =
      '<div class="stats-kpi-grid">' + renderKpis() + '</div>' +
      '<section class="stats-card">' +
        '<div class="stats-card-header">' +
          '<div class="stats-card-heading">' +
            '<h2 class="stats-card-title">Token 消耗</h2>' +
            '<p class="stats-card-desc" data-role="trend-desc"></p>' +
          '</div>' +
          '<div class="stats-range" role="group" aria-label="时间范围">' + renderRangeButtons() + '</div>' +
        '</div>' +
        '<p class="stats-card-total" data-role="trend-total"></p>' +
        '<div class="stats-chart" data-chart="trend"></div>' +
        '<div class="stats-legend" data-role="trend-legend"></div>' +
      '</section>' +
      '<div class="stats-split">' +
        '<section class="stats-card">' +
          '<div class="stats-card-header">' +
            '<div class="stats-card-heading">' +
              '<h2 class="stats-card-title">输入 / 输出</h2>' +
              '<p class="stats-card-desc">气泡底部的输入与输出 Token</p>' +
            '</div>' +
          '</div>' +
          '<div class="stats-chart" data-chart="io"></div>' +
          '<div class="stats-legend" data-role="io-legend"></div>' +
        '</section>' +
        '<section class="stats-card">' +
          '<div class="stats-card-header">' +
            '<div class="stats-card-heading">' +
              '<h2 class="stats-card-title">模型消耗</h2>' +
              '<p class="stats-card-desc" data-role="model-desc"></p>' +
            '</div>' +
          '</div>' +
          '<div class="stats-chart" data-chart="model"></div>' +
          '<div class="stats-legend" data-role="model-legend"></div>' +
        '</section>' +
      '</div>' +
      '<section class="stats-card">' +
        '<div class="stats-card-header">' +
          '<div class="stats-card-heading">' +
            '<h2 class="stats-card-title">模型明细</h2>' +
            '<p class="stats-card-desc">各时间窗口的气泡合计，与 ~tokens 弹框同一口径</p>' +
          '</div>' +
        '</div>' +
        '<div class="stats-table-wrap">' + renderModelTable() + '</div>' +
      '</section>';

    bindRangeButtons();
    paintRangeDependent();
    observeCharts();
  }

  function renderKpis() {
    var html = '';
    for (var i = 0; i < KPI_ROWS.length; i++) {
      var row = KPI_ROWS[i];
      var usage = totalsOf(summary[row.key]);
      html +=
        '<article class="stats-kpi">' +
          '<div class="stats-kpi-label">' +
            '<span>' + escapeHtml(row.label) + '</span>' +
            '<span class="stats-kpi-hint">' + escapeHtml(row.hint) + '</span>' +
          '</div>' +
          '<div class="stats-kpi-value">' + formatTokenCount(usage.totalTokens) + '</div>' +
          '<div class="stats-kpi-sub">输入 ' + formatTokenCount(usage.inputTokens) +
            ' · 输出 ' + formatTokenCount(usage.outputTokens) + '</div>' +
        '</article>';
    }
    return html;
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

  function bindRangeButtons() {
    if (!mainEl) return;
    var buttons = mainEl.querySelectorAll('.stats-range-btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (ev) {
        var next = ev.currentTarget.getAttribute('data-range');
        if (!next || next === rangeKey) return;
        rangeKey = next;
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].setAttribute('aria-pressed', buttons[j].getAttribute('data-range') === rangeKey ? 'true' : 'false');
        }
        paintRangeDependent();
      });
    }
  }

  function paintRangeDependent() {
    if (!mainEl || !summary) return;
    var range = currentRange();
    var buckets = bucketsForRange(range.key);
    var desc = mainEl.querySelector('[data-role="trend-desc"]');
    var totalEl = mainEl.querySelector('[data-role="trend-total"]');
    var modelDesc = mainEl.querySelector('[data-role="model-desc"]');
    if (desc) desc.textContent = '会话气泡合计 · ' + range.hint;
    if (totalEl) totalEl.textContent = formatTokenCount(sumBuckets(buckets));
    if (modelDesc) modelDesc.textContent = range.label + '内已记录模型名称的用量';
    var trendMount = mainEl.querySelector('[data-chart="trend"]');
    if (trendMount) lastChartWidth = trendMount.clientWidth;

    paintTrendChart(buckets, range);
    paintIoChart(buckets, range);
    paintModelChart(buckets, range);
  }

  function observeCharts() {
    if (!mainEl || typeof ResizeObserver !== 'function') return;
    resizeObs = new ResizeObserver(function () {
      var mount = mainEl.querySelector('[data-chart="trend"]');
      var width = mount ? mount.clientWidth : 0;
      if (Math.abs(width - lastChartWidth) < 2) return;
      lastChartWidth = width;
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
    var legendEl = mainEl && mainEl.querySelector('[data-role="trend-legend"]');
    if (!mount) return;
    unbindChart(trendChart);
    var colors = chartColors();
    var series = [{
      key: 'total',
      label: '合计',
      color: colors[0],
      values: buckets.map(function (b) { return Number(b.totalTokens) || 0; }),
    }];
    if (legendEl) legendEl.innerHTML = '';
    trendChart = bindAreaChart(mount, {
      id: 'trend',
      labels: buckets.map(function (b) { return b.key; }),
      series: series,
      stacked: false,
      formatX: range.key === 'day' ? formatHourTick : formatDayTick,
      formatTipTitle: range.key === 'day' ? formatHourTip : formatDayTip,
    });
  }

  function paintIoChart(buckets, range) {
    var mount = mainEl && mainEl.querySelector('[data-chart="io"]');
    var legendEl = mainEl && mainEl.querySelector('[data-role="io-legend"]');
    if (!mount) return;
    unbindChart(ioChart);
    var colors = chartColors();
    var series = [
      {
        key: 'output',
        label: '输出',
        color: colors[0],
        mode: 'area',
        values: buckets.map(function (b) { return Number(b.outputTokens) || 0; }),
      },
      {
        key: 'input',
        label: '输入',
        color: colors[1],
        mode: 'line',
        values: buckets.map(function (b) { return Number(b.inputTokens) || 0; }),
      },
    ];
    if (legendEl) legendEl.innerHTML = renderLegend([series[1], series[0]]);
    ioChart = bindAreaChart(mount, {
      id: 'io',
      labels: buckets.map(function (b) { return b.key; }),
      series: series,
      stacked: false,
      formatX: range.key === 'day' ? formatHourTick : formatDayTick,
      formatTipTitle: range.key === 'day' ? formatHourTip : formatDayTip,
    });
  }

  function paintModelChart(buckets, range) {
    var mount = mainEl && mainEl.querySelector('[data-chart="model"]');
    var legendEl = mainEl && mainEl.querySelector('[data-role="model-legend"]');
    if (!mount) return;
    unbindChart(modelChart);
    var models = modelKeysFromBuckets(buckets);
    var colors = chartColors();
    var series = [];
    for (var i = 0; i < models.length; i++) {
      series.push({
        key: models[i],
        label: models[i],
        color: colors[i % colors.length],
        values: valuesForModel(buckets, models[i]),
      });
    }
    if (!series.length) {
      mount.innerHTML = '';
      mount.hidden = true;
      if (legendEl) legendEl.innerHTML = '';
      modelChart = null;
      return;
    }
    mount.hidden = false;
    if (legendEl) legendEl.innerHTML = renderLegend(series);
    modelChart = bindAreaChart(mount, {
      id: 'model',
      labels: buckets.map(function (b) { return b.key; }),
      series: series,
      stacked: true,
      formatX: range.key === 'day' ? formatHourTick : formatDayTick,
      formatTipTitle: range.key === 'day' ? formatHourTip : formatDayTip,
    });
  }

  function renderModelTable() {
    var byModel = summary.byModel || {};
    var names = Object.keys(byModel);
    names.sort(function (a, b) {
      return totalsOf(byModel[b] && byModel[b].month).totalTokens
        - totalsOf(byModel[a] && byModel[a].month).totalTokens;
    });
    if (!names.length) {
      return '<p class="stats-muted">还没有带模型名称的气泡用量。</p>';
    }
    var html =
      '<table class="stats-table">' +
        '<thead><tr>' +
          '<th>模型</th><th>24 小时</th><th>7 天</th><th>30 天</th><th>全部</th>' +
        '</tr></thead><tbody>';
    for (var i = 0; i < names.length; i++) {
      var row = byModel[names[i]] || {};
      html +=
        '<tr>' +
          '<td class="stats-table-name" title="' + escapeHtml(names[i]) + '">' + escapeHtml(names[i]) + '</td>' +
          '<td>' + formatTokenCount(totalsOf(row.day).totalTokens) + '</td>' +
          '<td>' + formatTokenCount(totalsOf(row.week).totalTokens) + '</td>' +
          '<td>' + formatTokenCount(totalsOf(row.month).totalTokens) + '</td>' +
          '<td>' + formatTokenCount(totalsOf(row.all).totalTokens) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    return html;
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
    var width = Math.max(120, mount.clientWidth || 0);
    var height = Math.max(160, mount.clientHeight || 0);
    var pad = { top: 12, right: 8, bottom: 28, left: 8 };
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
      var mode = series[s].mode || 'area';
      var topYs = tops[s].map(yOf);
      var botYs = bottoms[s].map(yOf);
      if (mode !== 'line') {
        defs +=
          '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="5%" stop-color="' + series[s].color + '" stop-opacity="0.8"/>' +
            '<stop offset="95%" stop-color="' + series[s].color + '" stop-opacity="0.08"/>' +
          '</linearGradient>';
        areas +=
          '<path class="stats-area-fill" d="' + areaPath(xs, topYs, botYs) + '" fill="url(#' + gid + ')"/>';
      }
      areas +=
        '<path class="stats-area-stroke' + (mode === 'line' ? ' is-line' : '') +
          '" d="' + linePath(xs, topYs) + '" stroke="' + series[s].color + '"/>';
    }

    var grid = '';
    var gridCount = 3;
    for (i = 0; i <= gridCount; i++) {
      var gy = pad.top + (plotH * i) / gridCount;
      grid += '<line x1="' + pad.left + '" x2="' + (pad.left + plotW) + '" y1="' + gy + '" y2="' + gy + '" class="stats-grid-line"/>';
    }

    var ticks = tickIndices(n, n > 16 ? 6 : (n > 8 ? 7 : n));
    var axis = '';
    for (i = 0; i < ticks.length; i++) {
      var idx = ticks[i];
      var label = opts.formatX ? opts.formatX(labels[idx]) : labels[idx];
      var anchor = idx === 0 ? 'start' : (idx === n - 1 ? 'end' : 'middle');
      axis +=
        '<text x="' + xs[idx] + '" y="' + (height - 8) + '" text-anchor="' + anchor + '" class="stats-axis-label">' +
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
      (empty ? '<div class="stats-chart-empty">该时间范围暂无用量</div>' : '');

    var svg = mount.querySelector('.stats-svg');
    var hoverG = mount.querySelector('.stats-hover');
    var hoverLine = mount.querySelector('.stats-hover-line');
    var dots = mount.querySelectorAll('.stats-hover-dot');
    var state = {
      mount: mount,
      onMove: null,
      onLeave: null,
    };

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
        var y = yOf(tops[d][idx]);
        dots[d].setAttribute('cx', String(x));
        dots[d].setAttribute('cy', String(y));
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
    state.svg = svg;
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
    return daily;
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

  function sumBuckets(buckets) {
    var total = 0;
    for (var i = 0; i < buckets.length; i++) total += Number(buckets[i].totalTokens) || 0;
    return total;
  }

  function totalsOf(usage) {
    return {
      inputTokens: usage && typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
      outputTokens: usage && typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
      totalTokens: usage && typeof usage.totalTokens === 'number' ? usage.totalTokens : 0,
    };
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
