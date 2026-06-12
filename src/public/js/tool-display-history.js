/**
 * 方案 B — 从 structured messages 构建工具 diff 展示索引，供历史重绘使用。
 * diff 提取语义与 src/web/tool-display-extract.ts 一致（经 DiffViewer.extractUnifiedDiff）。
 */

/* exported ToolDisplayHistory */
window.ToolDisplayHistory = (function () {
  'use strict';

  function normalizeToolArgs(toolArgs) {
    if (!toolArgs) return null;
    if (typeof toolArgs === 'object') return toolArgs;
    if (typeof toolArgs === 'string') {
      try {
        var parsed = JSON.parse(toolArgs);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (_e) {
        return null;
      }
    }
    return null;
  }

  function extractFromToolArgs(toolName, toolArgs) {
    var args = normalizeToolArgs(toolArgs);
    if (!args) return null;
    if (toolName === 'patch_file' && typeof args.patch === 'string' && /^@@\s/m.test(args.patch)) {
      return args.patch;
    }
    return null;
  }

  function extractUnifiedDiffFromOutput(text) {
    if (window.DiffViewer && typeof DiffViewer.extractUnifiedDiff === 'function') {
      return DiffViewer.extractUnifiedDiff(text);
    }
    return null;
  }

  /** 解析单条 tool 调用的 diff 数据源（签名与 tool-display-extract.ts 一致） */
  function extractDiffSource(toolName, toolOutput, toolArgs) {
    var fromArgs = extractFromToolArgs(toolName, toolArgs);
    if (fromArgs) return fromArgs;
    if (!toolOutput || typeof toolOutput !== 'string') return null;
    return extractUnifiedDiffFromOutput(toolOutput);
  }

  /** @deprecated 使用 extractDiffSource(toolName, toolOutput, toolArgs) */
  function resolveDiffSource(toolOutput, toolArgs, toolName) {
    return extractDiffSource(toolName, toolOutput, toolArgs);
  }

  /**
   * 从 structured messages 提取按时间顺序的「工具轮次」。
   * 每轮 = 一次 assistant tool_calls + 紧随其后的 tool 结果。
   * @returns {Array<Array<{ toolCallId: string, toolName: string, diffSource: string|null }>>}
   */
  function parseStructuredToolRounds(structured) {
    if (!Array.isArray(structured) || structured.length === 0) return [];

    var rounds = [];

    for (var i = 0; i < structured.length; i++) {
      var msg = structured[i];
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) {
        continue;
      }

      var entries = [];
      var byId = {};
      for (var t = 0; t < msg.toolCalls.length; t++) {
        var tc = msg.toolCalls[t];
        var entry = {
          toolCallId: tc.id || '',
          toolName: tc.name || '',
          diffSource: extractFromToolArgs(tc.name, normalizeToolArgs(tc.arguments)),
        };
        entries.push(entry);
        if (entry.toolCallId) byId[entry.toolCallId] = entry;
      }

      var j = i + 1;
      while (j < structured.length && structured[j] && structured[j].role === 'tool') {
        var toolMsg = structured[j];
        var hit = toolMsg.toolCallId ? byId[toolMsg.toolCallId] : null;
        if (hit && typeof toolMsg.content === 'string') {
          var outDiff = extractDiffSource(hit.toolName, toolMsg.content, null);
          if (outDiff) hit.diffSource = outDiff;
        }
        j++;
      }

      rounds.push(entries);
      i = j - 1;
    }

    return rounds;
  }

  /**
   * 将 structured 中所有 assistant 工具轮次按顺序展平（一轮 harness 可能有多轮 tool_calls）。
   * @returns {Array<{ toolCallId: string, toolName: string, diffSource: string|null }>}
   */
  function flattenStructuredToolEntries(structured) {
    var rounds = parseStructuredToolRounds(structured);
    var flat = [];
    for (var r = 0; r < rounds.length; r++) {
      flat = flat.concat(rounds[r]);
    }
    return flat;
  }

  /**
   * toolCallId → diffSource（刷新后按 id 还原，不依赖顺序对齐）。
   * @returns {Object<string, string>}
   */
  function buildToolCallDiffIndex(structured) {
    var index = {};
    var flat = flattenStructuredToolEntries(structured);
    for (var i = 0; i < flat.length; i++) {
      var e = flat[i];
      if (e.toolCallId && e.diffSource) index[e.toolCallId] = e.diffSource;
    }
    return index;
  }

  function resolveTraceDiffSource(tr, matched, diffByCallId) {
    if (tr && tr.diffSource) return tr.diffSource;
    if (matched && matched.diffSource) return matched.diffSource;
    if (tr && tr.toolCallId && diffByCallId && diffByCallId[tr.toolCallId]) {
      return diffByCallId[tr.toolCallId];
    }
    return null;
  }

  /**
   * 将 structured 工具条目与 UI agent 消息（含 tool_trace）按顺序对齐。
   * 同一 agent 消息下的多条 tool_trace 可对应 structured 中多轮 assistant tool_calls。
   * @returns {Object<string, Array>} agentMsgId → display entries
   */
  /**
   * 按 structured 时间顺序的 tool 结果行（与 flattenStructuredToolEntries 下标一致）。
   */
  function buildOrderedToolOutputs(structured) {
    var rows = [];
    if (!Array.isArray(structured)) return rows;
    for (var i = 0; i < structured.length; i++) {
      var msg = structured[i];
      if (!msg || msg.role !== 'tool' || typeof msg.content !== 'string') continue;
      var toolCallId = msg.toolCallId || '';
      var toolName = '';
      for (var j = i - 1; j >= 0; j--) {
        var prev = structured[j];
        if (!prev || prev.role !== 'assistant' || !Array.isArray(prev.toolCalls)) continue;
        for (var t = 0; t < prev.toolCalls.length; t++) {
          var tc = prev.toolCalls[t];
          if (tc && tc.id === toolCallId) {
            toolName = tc.name || '';
            break;
          }
        }
        break;
      }
      rows.push({
        toolCallId: toolCallId,
        toolName: toolName,
        content: msg.content,
        diffSource: extractDiffSource(toolName, msg.content, null),
      });
    }
    return rows;
  }

  function computeTraceFlatOffset(uiMessages, toolTraces, agentMsgId) {
    if (!Array.isArray(uiMessages) || !toolTraces || !agentMsgId) return 0;
    var offset = 0;
    for (var m = 0; m < uiMessages.length; m++) {
      var uiMsg = uiMessages[m];
      if (!uiMsg || !uiMsg.id) continue;
      if (uiMsg.id === agentMsgId) break;
      var prevTraces = toolTraces[uiMsg.id];
      if (prevTraces && prevTraces.length) offset += prevTraces.length;
    }
    return offset;
  }

  /**
   * 将单条 agent 的 tool_trace 与 structured tool 输出对齐。
   * UI 中可能有 fs_operation 等未进入 structured 的条目，按 toolName 顺序贪婪匹配，避免 write_file 整体错位。
   */
  var cachedStructuredRef = null;
  var cachedOrderedOutputs = null;
  var cachedFlatByCallId = null;

  function invalidateStructuredCaches() {
    cachedStructuredRef = null;
    cachedOrderedOutputs = null;
    cachedFlatByCallId = null;
  }

  function getOrderedToolOutputs(structured) {
    if (structured === cachedStructuredRef && cachedOrderedOutputs) {
      return cachedOrderedOutputs;
    }
    cachedStructuredRef = structured;
    cachedOrderedOutputs = buildOrderedToolOutputs(structured);
    cachedFlatByCallId = null;
    return cachedOrderedOutputs;
  }

  function getFlatDiffByCallId(structured) {
    if (structured !== cachedStructuredRef) getOrderedToolOutputs(structured);
    if (cachedFlatByCallId) return cachedFlatByCallId;
    var flat = flattenStructuredToolEntries(structured);
    var map = {};
    for (var fi = 0; fi < flat.length; fi++) {
      var fe = flat[fi];
      if (fe.toolCallId && fe.diffSource) map[fe.toolCallId] = fe.diffSource;
    }
    cachedFlatByCallId = map;
    return map;
  }

  function normalizeRelPath(p) {
    return (p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function pathFromWriteDetail(detail) {
    return normalizeRelPath((detail || '').trim());
  }

  function pathFromToolOutput(content) {
    if (!content) return '';
    var m = /^File written:\s*(.+?)(?:\r?\n|\n|$)/m.exec(content);
    return m ? normalizeRelPath(m[1].trim()) : '';
  }

  function pathsMatchForToolAlign(traceDetail, outputContent) {
    var tr = pathFromWriteDetail(traceDetail);
    var op = pathFromToolOutput(outputContent);
    if (!tr || !op) return true;
    return tr === op;
  }

  function alignAgentTracesToOutputs(traces, structured, flatOffset) {
    var outputs = getOrderedToolOutputs(structured);
    var flatByCallId = null;
    var usedOut = {};
    var aligned = [];

    for (var ti = 0; ti < traces.length; ti++) {
      var tr = traces[ti] || {};
      var wantName = tr.toolName || '';
      var row = null;
      var pickIdx = -1;

      if (tr.toolCallId) {
        for (var idScan = 0; idScan < outputs.length; idScan++) {
          if (usedOut[idScan]) continue;
          if (outputs[idScan].toolCallId === tr.toolCallId) {
            row = outputs[idScan];
            pickIdx = idScan;
            break;
          }
        }
      }

      if (!row && wantName) {
        for (var scan = 0; scan < outputs.length; scan++) {
          if (usedOut[scan]) continue;
          if (outputs[scan].toolName !== wantName) continue;
          if (!pathsMatchForToolAlign(tr.detail, outputs[scan].content)) continue;
          row = outputs[scan];
          pickIdx = scan;
          break;
        }
      }

      if (pickIdx >= 0) usedOut[pickIdx] = true;

      var diffSource = tr.diffSource || null;
      var traceCallId = tr.toolCallId || '';
      if (row) {
        if (!diffSource) {
          diffSource = row.diffSource
            || extractDiffSource(row.toolName || wantName, row.content, null);
        }
        if (!diffSource && row.toolCallId) {
          if (!flatByCallId) flatByCallId = getFlatDiffByCallId(structured);
          diffSource = flatByCallId[row.toolCallId] || null;
        }
      }
      if (!diffSource && traceCallId) {
        if (!flatByCallId) flatByCallId = getFlatDiffByCallId(structured);
        diffSource = flatByCallId[traceCallId] || null;
      }

      aligned.push({
        toolCallId: traceCallId,
        toolName: wantName || (row && row.toolName) || '',
        diffSource: diffSource,
      });
    }

    return aligned;
  }

  function resolveDiffByTraceFlatIndex(structured, flatOffset, traceIndex, tr, diffByCallId, traces) {
    if (tr && tr.diffSource) return tr.diffSource;
    if (Array.isArray(traces) && traces.length > 0) {
      var aligned = alignAgentTracesToOutputs(traces, structured, flatOffset);
      if (traceIndex >= 0 && traceIndex < aligned.length && aligned[traceIndex].diffSource) {
        return aligned[traceIndex].diffSource;
      }
    }
    var pos = flatOffset + traceIndex;
    var outputs = getOrderedToolOutputs(structured);
    if (pos >= 0 && pos < outputs.length) {
      var row = outputs[pos];
      if (row.diffSource) return row.diffSource;
      if (tr && tr.toolName && row.toolName && tr.toolName !== row.toolName) return null;
      var fromContent = extractDiffSource(row.toolName || (tr && tr.toolName) || '', row.content, null);
      if (fromContent) return fromContent;
    }
    if (tr && tr.toolCallId && diffByCallId && diffByCallId[tr.toolCallId]) {
      return diffByCallId[tr.toolCallId];
    }
    return null;
  }

  function buildAgentDisplayMap(structured, uiMessages, toolTraces) {
    var map = {};
    if (!Array.isArray(uiMessages) || !toolTraces) return map;

    for (var m = 0; m < uiMessages.length; m++) {
      var uiMsg = uiMessages[m];
      if (!uiMsg || !uiMsg.id) continue;
      var traces = toolTraces[uiMsg.id];
      if (!traces || traces.length === 0) continue;

      var flatOffset = computeTraceFlatOffset(uiMessages, toolTraces, uiMsg.id);
      map[uiMsg.id] = alignAgentTracesToOutputs(traces, structured, flatOffset);
    }

    return map;
  }

  /** 可能产生 unified diff 的工具（点击工具行展开 diff 面板） */
  var DIFF_CAPABLE_TOOL_NAMES = {
    patch_file: true,
    edit_file: true,
    append_file: true,
    write_file: true,
    batch_edit_file: true,
    run_command: true,
    git: true,
    diff_files: true,
  };

  function isDiffCapableTool(toolName) {
    return !!(toolName && DIFF_CAPABLE_TOOL_NAMES[toolName]);
  }

  function renderDiffElement(diffSource) {
    if (!diffSource || !window.DiffViewer || typeof DiffViewer.renderFromText !== 'function') return null;
    return DiffViewer.renderFromText(diffSource, { compact: true });
  }

  return {
    extractDiffSource: extractDiffSource,
    resolveDiffSource: resolveDiffSource,
    isDiffCapableTool: isDiffCapableTool,
    parseStructuredToolRounds: parseStructuredToolRounds,
    flattenStructuredToolEntries: flattenStructuredToolEntries,
    buildToolCallDiffIndex: buildToolCallDiffIndex,
    buildOrderedToolOutputs: buildOrderedToolOutputs,
    alignAgentTracesToOutputs: alignAgentTracesToOutputs,
    computeTraceFlatOffset: computeTraceFlatOffset,
    resolveDiffByTraceFlatIndex: resolveDiffByTraceFlatIndex,
    buildAgentDisplayMap: buildAgentDisplayMap,
    invalidateStructuredCaches: invalidateStructuredCaches,
    renderDiffElement: renderDiffElement,
  };
})();
