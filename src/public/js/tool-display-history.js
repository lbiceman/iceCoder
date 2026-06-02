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
    if (tr.diffSource) return tr.diffSource;
    if (tr.toolCallId && diffByCallId && diffByCallId[tr.toolCallId]) {
      return diffByCallId[tr.toolCallId];
    }
    if (matched && matched.diffSource) return matched.diffSource;
    return null;
  }

  /**
   * 将 structured 工具条目与 UI agent 消息（含 tool_trace）按顺序对齐。
   * 同一 agent 消息下的多条 tool_trace 可对应 structured 中多轮 assistant tool_calls。
   * @returns {Object<string, Array>} agentMsgId → display entries
   */
  function buildAgentDisplayMap(structured, uiMessages, toolTraces) {
    var map = {};
    if (!Array.isArray(uiMessages) || !toolTraces) return map;

    var flat = flattenStructuredToolEntries(structured);
    var diffByCallId = buildToolCallDiffIndex(structured);
    var flatIdx = 0;

    for (var m = 0; m < uiMessages.length; m++) {
      var uiMsg = uiMessages[m];
      if (!uiMsg || !uiMsg.id) continue;
      var traces = toolTraces[uiMsg.id];
      if (!traces || traces.length === 0) continue;

      var displays = [];
      for (var k = 0; k < traces.length; k++) {
        var tr = traces[k];
        var matched = null;

        if (tr.toolCallId) {
          for (var fi = flatIdx; fi < flat.length; fi++) {
            if (flat[fi].toolCallId === tr.toolCallId) {
              matched = flat[fi];
              flatIdx = fi + 1;
              break;
            }
          }
        }
        if (!matched && flatIdx < flat.length) {
          matched = flat[flatIdx];
          flatIdx++;
        }

        displays.push({
          toolCallId: (matched && matched.toolCallId) || tr.toolCallId || '',
          toolName: tr.toolName || (matched && matched.toolName) || '',
          diffSource: resolveTraceDiffSource(tr, matched, diffByCallId),
        });
      }
      map[uiMsg.id] = displays;
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
    buildAgentDisplayMap: buildAgentDisplayMap,
    renderDiffElement: renderDiffElement,
  };
})();
