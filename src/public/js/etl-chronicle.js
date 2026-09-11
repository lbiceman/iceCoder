/**
 * 执行流编年史 — 纯装配。
 *
 * 把已有 UI 消息 / structured / 检查点时间轴装配成章 / 轮 / 工具行。
 * 不读写 session 文件、不 fetch、不碰 DOM。
 */

/* exported EtlChronicle */

window.EtlChronicle = (function () {
  'use strict';

  var PREVIEW_MAX = 72;
  var TOOL_PREVIEW_MAX = 40;

  var WRITE_TOOLS = {
    write_file: true, append_file: true, edit_file: true,
    patch_file: true, batch_edit_file: true, fs_operation: true,
    apply_patch: true, undo_edit: true, create_file: true, multi_edit: true,
  };
  var READ_TOOLS = {
    read_file: true, file_info: true, notebook_read: true,
    parse_document: true, parse_pptx_deep: true, parse_doc_legacy: true,
    parse_xmind_deep: true, parse_xlsx_deep: true, open_file: true,
    read_image: true, image_read: true, xmind_parse: true, xlsx_parse: true,
    browse_directory: true, list_drives: true, diff_files: true,
  };
  var SEARCH_TOOLS = { glob: true, grep: true };

  var STATUS_LABELS = {
    running: '进行中',
    done: '完成',
    failed: '失败',
    paused: '已暂停',
    stopped: '用户停止',
  };

  var MARKER_LABELS = {
    supervision: '监管曾介入',
    compaction: '本章发生过压缩',
    circuit: '熔断保护',
    subagent: '子代理',
  };

  function clamp(s, max) {
    s = String(s || '');
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }

  function extractText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (typeof block === 'string') parts.push(block);
      else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }

  function stripSkillWall(text) {
    var raw = String(text || '');
    raw = raw.replace(/\[Active Skill:[^\]]*\]/gi, '');
    raw = raw.replace(/\[skill:[^\]]*\]/gi, '');
    var lines = raw.split(/\r?\n/);
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (/^\[System:/i.test(line)) continue;
      kept.push(line);
    }
    return kept.join(' ').replace(/\s+/g, ' ').trim();
  }

  function isAlsoNote(msg) {
    return !!(msg && msg.alsoNote);
  }

  function isSystemInjectedUserText(text) {
    var t = String(text || '');
    if (!t) return false;
    if (t.indexOf('[System: Skill File Guide]') >= 0) return true;
    if (t.indexOf('[System:') >= 0 && t.indexOf('Skill') >= 0) return true;
    return false;
  }

  function isRealUiUser(msg) {
    if (!msg || msg.role !== 'user' || isAlsoNote(msg)) return false;
    var text = stripSkillWall(extractText(msg.content));
    return text.length > 0;
  }

  function isRealStructuredUser(msg) {
    if (!msg || msg.role !== 'user' || isAlsoNote(msg)) return false;
    var text = extractText(msg.content);
    if (!String(text).trim()) return false;
    return !isSystemInjectedUserText(text);
  }

  function previewFromUser(msg) {
    var text = stripSkillWall(extractText(msg && msg.content));
    if (!text) return '（无消息摘要）';
    return clamp(text, PREVIEW_MAX);
  }

  function parseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return {};
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_e) {
      return {};
    }
  }

  function basename(p) {
    var s = String(p || '').replace(/\\/g, '/');
    var idx = s.lastIndexOf('/');
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  function extractToolTarget(toolName, args) {
    args = parseArgs(args);
    if (toolName === 'run_command') return String(args.command || '');
    if (SEARCH_TOOLS[toolName]) {
      var pattern = args.pattern || args.glob || args.query || '';
      var scope = args.path || args.directory || '';
      if (pattern && scope) return String(pattern) + ' · ' + String(scope);
      return String(pattern || scope || '');
    }
    var pathVal = args.path || args.file || args.filePath || args.filename;
    return pathVal ? String(pathVal) : '';
  }

  function formatToolPreview(toolName, args) {
    var target = extractToolTarget(toolName, args);
    if (target) return clamp(target, TOOL_PREVIEW_MAX);
    return '';
  }

  function inferToolIntent(toolName, target) {
    var hint = target ? '「' + clamp(basename(target), 24) + '」' : '';
    if (toolName === 'read_file') return '读取' + hint + '了解代码与上下文';
    if (toolName === 'grep') return '搜索代码' + (hint || '中的关键词');
    if (toolName === 'glob') return '查找匹配' + (hint || '模式的文件');
    if (toolName === 'write_file' || toolName === 'create_file') return '写入或创建文件' + hint;
    if (toolName === 'edit_file' || toolName === 'patch_file' || toolName === 'apply_patch') {
      return '修改文件' + hint;
    }
    if (toolName === 'append_file') return '追加内容到' + hint;
    if (toolName === 'batch_edit_file' || toolName === 'multi_edit') return '批量修改多个文件';
    if (toolName === 'run_command') {
      var cmd = String(target || '');
      if (/test|vitest|jest|playwright|cypress/i.test(cmd)) return '运行测试验证改动';
      return cmd ? '执行命令 ' + clamp(cmd, 24) : '执行命令验证或推进任务';
    }
    if (READ_TOOLS[toolName]) return '读取资源' + hint;
    if (SEARCH_TOOLS[toolName]) return '搜索项目' + hint;
    if (WRITE_TOOLS[toolName]) return '更新文件' + hint;
    return (toolName ? '调用 ' + toolName.replace(/_/g, ' ') : '调用工具') + hint;
  }

  function toolStatus(raw) {
    if (raw === 'failed' || raw === 'error') return 'failed';
    if (raw === 'running' || raw === 'pending') return 'running';
    return 'done';
  }

  function makeTool(tc, extras) {
    extras = extras || {};
    var name = tc && (tc.name || tc.toolName) ? String(tc.name || tc.toolName) : '';
    var args = tc && (tc.arguments || tc.toolArgs || tc.args);
    var target = extractToolTarget(name, args);
    var preview = formatToolPreview(name, args);
    return {
      toolCallId: (tc && (tc.id || tc.toolCallId)) ? String(tc.id || tc.toolCallId) : '',
      toolName: name,
      intent: inferToolIntent(name, target),
      preview: preview,
      target: target,
      durationMs: typeof extras.durationMs === 'number' ? extras.durationMs : 0,
      status: toolStatus(extras.status || (tc && tc.status)),
    };
  }

  function collectWritePaths(tools) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < tools.length; i++) {
      var tool = tools[i];
      if (!WRITE_TOOLS[tool.toolName]) continue;
      var pathVal = tool.target || '';
      if (!pathVal || seen[pathVal]) continue;
      seen[pathVal] = true;
      out.push(pathVal);
    }
    return out;
  }

  function deriveRoundTitle(tools, isFinal, isLastWithoutTools) {
    if (isFinal || isLastWithoutTools) return '整理结论';
    if (!tools.length) return '理解目标';
    var hasWrite = false;
    var hasRead = false;
    var hasSearch = false;
    var hasTest = false;
    for (var i = 0; i < tools.length; i++) {
      var name = tools[i].toolName;
      if (WRITE_TOOLS[name]) hasWrite = true;
      if (READ_TOOLS[name]) hasRead = true;
      if (SEARCH_TOOLS[name]) hasSearch = true;
      if (name === 'run_command' && /test|vitest|jest|playwright|cypress/i.test(tools[i].target || '')) {
        hasTest = true;
      }
    }
    if (hasTest) return '验证结果';
    if (hasWrite) return '实施修改';
    if (hasRead || hasSearch) return '收集上下文';
    return '推进任务';
  }

  function roundStatusFromTools(tools, fallback) {
    for (var i = 0; i < tools.length; i++) {
      if (tools[i].status === 'failed') return 'failed';
      if (tools[i].status === 'running') return 'running';
    }
    return fallback || 'done';
  }

  function uniqueMarkers(list) {
    var seen = Object.create(null);
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var key = list[i];
      if (!key || seen[key]) continue;
      if (!MARKER_LABELS[key] && key !== 'supervision' && key !== 'compaction'
        && key !== 'circuit' && key !== 'subagent') continue;
      seen[key] = true;
      out.push(key);
    }
    return out;
  }

  function chapterStatusFromRounds(rounds, explicit, isLastIncomplete) {
    if (explicit) return explicit;
    if (!rounds.length) return isLastIncomplete ? 'running' : 'done';
    var last = rounds[rounds.length - 1];
    if (last.stopReason === 'circuit_breaker') return 'failed';
    if (last.stopReason === 'user_stop' || last.stopReason === 'cancelled') return 'stopped';
    if (last.stopReason === 'completion_paused') return 'paused';
    if (last.status === 'failed') return 'failed';
    if (last.status === 'running' || isLastIncomplete) return 'running';
    return 'done';
  }

  function sumDuration(rounds, startTs, endTs) {
    if (typeof startTs === 'number' && typeof endTs === 'number' && endTs >= startTs) {
      return endTs - startTs;
    }
    var total = 0;
    for (var i = 0; i < rounds.length; i++) {
      if (typeof rounds[i].durationMs === 'number') total += rounds[i].durationMs;
    }
    return total;
  }

  function countTools(rounds) {
    var n = 0;
    for (var i = 0; i < rounds.length; i++) {
      n += (rounds[i].tools || []).length;
    }
    return n;
  }

  function attachPlan(chapter, plan, isCurrent) {
    if (!isCurrent || !plan) return;
    chapter.goal = typeof plan.goal === 'string' ? plan.goal : '';
    chapter.phase = typeof plan.phase === 'string' ? plan.phase : '';
    chapter.progress = typeof plan.progress === 'number' ? plan.progress : null;
    chapter.intent = typeof plan.intent === 'string' ? plan.intent : '';
  }

  function buildChapter(opts) {
    var rounds = opts.rounds || [];
    var allTools = [];
    for (var i = 0; i < rounds.length; i++) {
      var ts = rounds[i].tools || [];
      for (var j = 0; j < ts.length; j++) allTools.push(ts[j]);
    }
    var writePaths = collectWritePaths(allTools);
    var chapter = {
      messageId: opts.messageId || '',
      preview: opts.preview || '（无消息摘要）',
      status: chapterStatusFromRounds(rounds, opts.status, opts.isLastIncomplete),
      roundCount: rounds.length,
      filesChangedCount: writePaths.length,
      durationMs: sumDuration(rounds, opts.startTs, opts.endTs),
      markers: uniqueMarkers(opts.markers),
      toolCount: allTools.length,
      rounds: rounds,
      goal: '',
      phase: '',
      progress: null,
      intent: '',
      startTs: typeof opts.startTs === 'number' ? opts.startTs : null,
      endTs: typeof opts.endTs === 'number' ? opts.endTs : null,
    };
    attachPlan(chapter, opts.plan, opts.isCurrent);
    return chapter;
  }

  function assistantToolCalls(msg) {
    if (!msg) return [];
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) return msg.toolCalls;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return msg.tool_calls;
    return [];
  }

  function roundsFromAssistants(slice) {
    var assistants = [];
    for (var i = 0; i < slice.length; i++) {
      if (slice[i] && slice[i].role === 'assistant') assistants.push(slice[i]);
    }
    var rounds = [];
    for (var a = 0; a < assistants.length; a++) {
      var msg = assistants[a];
      var calls = assistantToolCalls(msg);
      var tools = [];
      for (var t = 0; t < calls.length; t++) {
        tools.push(makeTool(calls[t]));
      }
      var isLast = a === assistants.length - 1;
      var isFinal = isLast && tools.length === 0;
      rounds.push({
        iteration: a + 1,
        title: deriveRoundTitle(tools, isFinal, isFinal),
        status: roundStatusFromTools(tools, 'done'),
        durationMs: 0,
        isFinal: isFinal,
        stopReason: '',
        tools: tools,
      });
    }
    return rounds;
  }

  function isAgentMsg(msg) {
    return !!(msg && (msg.role === 'assistant' || msg.role === 'agent'));
  }

  function msgHasText(msg) {
    return stripSkillWall(extractText(msg && msg.content)).length > 0;
  }

  function msgTs(msg) {
    if (!msg) return null;
    if (typeof msg.sentAt === 'number') return msg.sentAt;
    if (typeof msg.completedAt === 'number') return msg.completedAt;
    if (typeof msg.createdAt === 'number') return msg.createdAt;
    if (typeof msg.ts === 'number') return msg.ts;
    return null;
  }

  function guessArgsFromDetail(toolName, detail) {
    var d = String(detail || '');
    if (toolName === 'run_command') return { command: d };
    if (SEARCH_TOOLS[toolName]) return { pattern: d, path: d };
    return { path: d };
  }

  function toolsFromTraceList(traces) {
    var tools = [];
    if (!Array.isArray(traces)) return tools;
    for (var i = 0; i < traces.length; i++) {
      var tr = traces[i];
      if (!tr) continue;
      var name = tr.toolName || tr.name || '';
      if (!name) continue;
      tools.push(makeTool({
        id: tr.toolCallId || tr.id || '',
        name: name,
        arguments: guessArgsFromDetail(name, tr.detail || tr.target || ''),
      }, { status: tr.status }));
    }
    return tools;
  }

  function tracesFromUiMessages(uiMessages) {
    var traces = {};
    if (!Array.isArray(uiMessages)) return traces;
    for (var i = 0; i < uiMessages.length; i++) {
      var m = uiMessages[i];
      if (!m || m.role !== 'tool_trace') continue;
      var pid = m.parentId || '';
      if (!pid) continue;
      if (!traces[pid]) traces[pid] = [];
      traces[pid].push({
        toolName: m.toolName || '',
        detail: m.detail || '',
        status: m.status || 'done',
        toolCallId: m.toolCallId || '',
      });
    }
    return traces;
  }

  function mergeTraceMaps(a, b) {
    var out = {};
    function add(src) {
      if (!src || typeof src !== 'object') return;
      var keys = Object.keys(src);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!out[k]) out[k] = [];
        var list = src[k];
        if (!Array.isArray(list)) continue;
        for (var j = 0; j < list.length; j++) out[k].push(list[j]);
      }
    }
    add(a);
    add(b);
    return out;
  }

  function uiSliceAfterUser(uiMessages, userMsg) {
    var out = [];
    if (!Array.isArray(uiMessages) || !userMsg) return out;
    var started = false;
    for (var i = 0; i < uiMessages.length; i++) {
      var msg = uiMessages[i];
      if (!started) {
        if (msg === userMsg) started = true;
        else if (userMsg && userMsg.id && msg && msg.id && String(msg.id) === String(userMsg.id) && isRealUiUser(msg)) {
          started = true;
        }
        continue;
      }
      if (isRealUiUser(msg)) break;
      out.push(msg);
    }
    return out;
  }

  function makeRound(tools, isFinal) {
    tools = tools || [];
    return {
      iteration: 1,
      title: deriveRoundTitle(tools, isFinal, isFinal),
      status: roundStatusFromTools(tools, 'done'),
      durationMs: 0,
      isFinal: !!isFinal,
      stopReason: '',
      tools: tools,
    };
  }

  function roundsFromUiSlice(userMsg, slice, toolTraces) {
    toolTraces = toolTraces || {};
    var agents = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      if (isAgentMsg(slice[i]) && !slice[i]._streaming) agents.push(slice[i]);
    }
    var rounds = [];
    var usedParents = Object.create(null);
    for (i = 0; i < agents.length; i++) {
      var msg = agents[i];
      var parentKey = msg.id ? String(msg.id) : '';
      var traces = parentKey && toolTraces[parentKey] ? toolTraces[parentKey] : [];
      if (parentKey) usedParents[parentKey] = true;
      var tools = toolsFromTraceList(traces);
      var isLast = i === agents.length - 1;
      if (!tools.length && !isLast) continue;
      var isFinal = isLast && tools.length === 0;
      if (isFinal && !msgHasText(msg)) continue;
      rounds.push(makeRound(tools, isFinal));
    }
    var userKey = userMsg && userMsg.id ? String(userMsg.id) : '';
    if (userKey && toolTraces[userKey] && !usedParents[userKey]) {
      var extra = toolsFromTraceList(toolTraces[userKey]);
      if (extra.length) rounds.unshift(makeRound(extra, false));
    }
    return reindexRounds(rounds);
  }

  function toolKey(tool) {
    if (tool && tool.toolCallId) return 'id:' + tool.toolCallId;
    return 'np:' + ((tool && tool.toolName) || '') + '|' + ((tool && (tool.preview || tool.target)) || '');
  }

  function collectToolKeys(rounds) {
    var seen = Object.create(null);
    for (var i = 0; i < rounds.length; i++) {
      var tools = rounds[i].tools || [];
      for (var j = 0; j < tools.length; j++) seen[toolKey(tools[j])] = true;
    }
    return seen;
  }

  function flattenTools(rounds) {
    var out = [];
    for (var i = 0; i < rounds.length; i++) {
      var tools = rounds[i].tools || [];
      for (var j = 0; j < tools.length; j++) out.push(tools[j]);
    }
    return out;
  }

  function reindexRounds(rounds) {
    for (var i = 0; i < rounds.length; i++) rounds[i].iteration = i + 1;
    return rounds;
  }

  function mergeRoundLists(primary, secondary) {
    if (!primary.length) return reindexRounds(secondary.slice());
    if (!secondary.length) return reindexRounds(primary.slice());
    var base = primary.slice();
    var extra = flattenTools(secondary);
    var seen = collectToolKeys(base);
    var missing = [];
    for (var i = 0; i < extra.length; i++) {
      if (seen[toolKey(extra[i])]) continue;
      seen[toolKey(extra[i])] = true;
      missing.push(extra[i]);
    }
    if (missing.length) {
      var inserted = false;
      for (var r = 0; r < base.length; r++) {
        if (base[r].isFinal) continue;
        base[r].tools = (base[r].tools || []).concat(missing);
        base[r].title = deriveRoundTitle(base[r].tools, false, false);
        base[r].status = roundStatusFromTools(base[r].tools, base[r].status || 'done');
        inserted = true;
        break;
      }
      if (!inserted) {
        base.unshift(makeRound(missing, false));
      }
    }
    var secFinal = secondary.length && secondary[secondary.length - 1].isFinal;
    var baseFinal = base.length && base[base.length - 1].isFinal;
    if (secFinal && !baseFinal) base.push(makeRound([], true));
    return reindexRounds(base);
  }

  function pickRicherRounds(structRounds, uiRounds) {
    if (countTools(uiRounds) > countTools(structRounds)) {
      return mergeRoundLists(uiRounds, structRounds);
    }
    return mergeRoundLists(structRounds, uiRounds);
  }

  function hasCompletedReply(uiSlice, structSlice, rounds) {
    if (rounds && rounds.length) return true;
    var i;
    if (Array.isArray(uiSlice)) {
      for (i = 0; i < uiSlice.length; i++) {
        var m = uiSlice[i];
        if (!isAgentMsg(m) || m._streaming) continue;
        if (msgHasText(m)) return true;
      }
    }
    if (Array.isArray(structSlice)) {
      for (i = 0; i < structSlice.length; i++) {
        if (structSlice[i] && structSlice[i].role === 'assistant') return true;
      }
    }
    return false;
  }

  function collectRealUiUsers(uiMessages) {
    var out = [];
    if (!Array.isArray(uiMessages)) return out;
    for (var i = 0; i < uiMessages.length; i++) {
      if (isRealUiUser(uiMessages[i])) out.push(uiMessages[i]);
    }
    return out;
  }

  function usersFromCheckpoints(entries) {
    var out = [];
    if (!Array.isArray(entries)) return out;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.messageId) continue;
      out.push({
        role: 'user',
        id: String(e.messageId),
        content: e.preview || '',
        sentAt: typeof e.userMessageTime === 'number' ? e.userMessageTime : null,
      });
    }
    return out;
  }

  function usersFromStructured(structured) {
    var out = [];
    if (!Array.isArray(structured)) return out;
    for (var i = 0; i < structured.length; i++) {
      if (!isRealStructuredUser(structured[i])) continue;
      out.push(structured[i]);
    }
    return out;
  }

  function collectChapterUsers(uiMessages, checkpointEntries, structured) {
    var uiUsers = collectRealUiUsers(uiMessages);
    if (uiUsers.length) return uiUsers;
    var fromCp = usersFromCheckpoints(checkpointEntries);
    if (fromCp.length) return fromCp;
    return usersFromStructured(structured);
  }

  function checkpointByMessageId(entries, messageId) {
    if (!messageId || !Array.isArray(entries)) return null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].messageId === messageId) return entries[i];
    }
    return null;
  }

  function normalizeForMatch(msg) {
    return stripSkillWall(extractText(msg && msg.content)).replace(/\s+/g, ' ').trim();
  }

  function findStructuredUserIndex(structured, uiUser, used) {
    var needle = normalizeForMatch(uiUser);
    var fallback = -1;
    for (var i = 0; i < structured.length; i++) {
      if (used[i] || !isRealStructuredUser(structured[i])) continue;
      if (fallback < 0) fallback = i;
      if (!needle) continue;
      var hay = normalizeForMatch(structured[i]);
      if (!hay) continue;
      if (hay === needle || hay.indexOf(needle) >= 0 || needle.indexOf(hay) >= 0) return i;
    }
    return fallback;
  }

  function sliceStructuredBetween(structured, startIdx, nextIdx) {
    if (startIdx < 0) return [];
    var start = startIdx + 1;
    var end = nextIdx >= 0 ? nextIdx : structured.length;
    if (end < start) return [];
    return structured.slice(start, end);
  }

  function lastSliceTs(slice, fallback) {
    if (!Array.isArray(slice)) return fallback;
    for (var i = slice.length - 1; i >= 0; i--) {
      var ts = msgTs(slice[i]);
      if (typeof ts === 'number') return ts;
    }
    return fallback;
  }

  function markersFor(messageId, markersByMessageId) {
    if (!markersByMessageId || !messageId) return [];
    return uniqueMarkers(markersByMessageId[messageId]);
  }

  /**
   * @param {object} input
   * @param {Array} [input.uiMessages]
   * @param {Array} [input.structured]
   * @param {object} [input.toolTraces]  parentId → [{ toolName, detail, status, toolCallId }]
   * @param {Array} [input.checkpointEntries]
   * @param {object} [input.currentPlan] 只填当前（最后）章
   * @param {object} [input.markersByMessageId]
   */
  function assemble(input) {
    input = input || {};
    var uiMessages = Array.isArray(input.uiMessages) ? input.uiMessages : [];
    var structured = Array.isArray(input.structured) ? input.structured : [];
    var uiUsers = collectChapterUsers(uiMessages, input.checkpointEntries, structured);
    var toolTraces = mergeTraceMaps(input.toolTraces, tracesFromUiMessages(uiMessages));
    var chapters = [];

    if (!uiUsers.length) {
      return { chapters: chapters };
    }

    var usedStruct = Object.create(null);
    var structIndexes = [];
    for (var s = 0; s < uiUsers.length; s++) {
      var found = findStructuredUserIndex(structured, uiUsers[s], usedStruct);
      structIndexes.push(found);
      if (found >= 0) usedStruct[found] = true;
    }

    for (var n = 0; n < uiUsers.length; n++) {
      var ui = uiUsers[n];
      var structIdx = structIndexes[n];
      var nextStructIdx = n + 1 < structIndexes.length ? structIndexes[n + 1] : -1;
      var structUser = structIdx >= 0 ? structured[structIdx] : null;
      var structSlice = sliceStructuredBetween(structured, structIdx, nextStructIdx);
      var uiSlice = uiSliceAfterUser(uiMessages, ui);
      var rounds = pickRicherRounds(
        roundsFromAssistants(structSlice),
        roundsFromUiSlice(ui, uiSlice, toolTraces),
      );
      var isLast = n === uiUsers.length - 1;
      var complete = hasCompletedReply(uiSlice, structSlice, rounds);
      var isLastIncomplete = isLast && !complete;
      var messageId = (ui && ui.id) ? String(ui.id) : '';
      var cp = checkpointByMessageId(input.checkpointEntries, messageId);
      var startTs = msgTs(ui);
      if (startTs == null && cp && typeof cp.userMessageTime === 'number') startTs = cp.userMessageTime;
      var endTs = ui && typeof ui.completedAt === 'number' ? ui.completedAt : lastSliceTs(uiSlice, null);
      if (endTs == null && !isLastIncomplete) {
        var nextUser = uiUsers[n + 1];
        endTs = msgTs(nextUser);
      }
      var preview = previewFromUser(ui || structUser);
      if (preview === '（无消息摘要）' && cp && cp.preview) preview = clamp(cp.preview, PREVIEW_MAX);
      chapters.push(buildChapter({
        messageId: messageId,
        preview: preview,
        rounds: rounds,
        markers: markersFor(messageId, input.markersByMessageId),
        plan: input.currentPlan,
        isCurrent: isLast,
        isLastIncomplete: isLastIncomplete,
        startTs: startTs,
        endTs: endTs,
        status: isLastIncomplete ? 'running' : undefined,
      }));
    }
    return { chapters: chapters };
  }

  function durationOf(start, end) {
    if (typeof start !== 'number') return 0;
    var finish = typeof end === 'number' ? end : start;
    return Math.max(0, finish - start);
  }

  function toolFromLiveRecord(rec) {
    return {
      toolCallId: rec.toolCallId || '',
      toolName: rec.toolName || '',
      intent: inferToolIntent(rec.toolName || '', rec.target || rec.detail || ''),
      preview: clamp(rec.detail || rec.target || '', TOOL_PREVIEW_MAX),
      target: rec.target || rec.detail || '',
      durationMs: durationOf(rec.callTs, rec.resultTs),
      status: toolStatus(rec.status),
    };
  }

  /**
   * 把面板当前活章的 roundRecords / toolRecords 封成一章。
   */
  function fromLive(input) {
    input = input || {};
    var toolsById = Object.create(null);
    var toolRecords = Array.isArray(input.toolRecords) ? input.toolRecords : [];
    for (var i = 0; i < toolRecords.length; i++) {
      var raw = toolRecords[i];
      if (raw && raw.toolCallId) toolsById[raw.toolCallId] = raw;
    }
    var roundRecords = Array.isArray(input.roundRecords) ? input.roundRecords : [];
    var rounds = [];
    for (var r = 0; r < roundRecords.length; r++) {
      var rec = roundRecords[r] || {};
      var tools = [];
      var ids = Array.isArray(rec.toolCallIds) ? rec.toolCallIds : [];
      for (var k = 0; k < ids.length; k++) {
        if (toolsById[ids[k]]) tools.push(toolFromLiveRecord(toolsById[ids[k]]));
      }
      var isLast = r === roundRecords.length - 1;
      var isFinal = !!rec.isFinal || (isLast && !tools.length);
      rounds.push({
        iteration: r + 1,
        title: rec.activeTitle
          ? String(rec.activeTitle)
          : deriveRoundTitle(tools, isFinal, isFinal),
        status: rec.status === 'running'
          ? 'running'
          : roundStatusFromTools(tools, rec.status === 'done' ? 'done' : 'done'),
        durationMs: durationOf(rec.startTs, rec.endTs),
        startTs: typeof rec.startTs === 'number' ? rec.startTs : null,
        isFinal: isFinal,
        stopReason: rec.stopReason ? String(rec.stopReason) : '',
        tools: tools,
      });
    }
    return buildChapter({
      messageId: input.messageId || '',
      preview: input.preview || '（无消息摘要）',
      rounds: rounds,
      markers: input.markers,
      plan: input.plan,
      isCurrent: true,
      status: input.status,
      startTs: input.startedAt,
      endTs: input.endedAt,
    });
  }

  return {
    assemble: assemble,
    fromLive: fromLive,
    previewFromUser: previewFromUser,
    stripSkillWall: stripSkillWall,
    inferToolIntent: inferToolIntent,
    STATUS_LABELS: STATUS_LABELS,
    MARKER_LABELS: MARKER_LABELS,
    WRITE_TOOLS: WRITE_TOOLS,
    PREVIEW_MAX: PREVIEW_MAX,
    countTools: countTools,
  };
})();
