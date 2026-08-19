/**
 * 聊天会话管理模块
 * 负责：消息存取、localStorage 持久化、服务端同步、tool_trace 分离
 */

/* exported ChatSession */

window.ChatSession = (function () {
  'use strict';

  var STORAGE_KEY_MESSAGES = 'ice-chat-messages';
  var STORAGE_KEY_LAST_ACTIVE = 'ice-chat-last-active-session';

  function readInitialSessionId() {
    if (window.ChatSessionStore && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
      var fromStore = window.ChatSessionStore.getActiveSessionId();
      if (fromStore) return fromStore;
    }
    try {
      return localStorage.getItem(STORAGE_KEY_LAST_ACTIVE) || 'default';
    } catch (_e) {
      return 'default';
    }
  }

  var SESSION_ID = readInitialSessionId();

  function getStorageKey() { return STORAGE_KEY_MESSAGES + ':' + SESSION_ID; }

  var messages = [];

  // T1-7: 首次使用多会话时，将旧 localStorage key 迁移到 default session
  (function migrateStorage() {
    try {
      var oldKey = STORAGE_KEY_MESSAGES;
      var newKey = STORAGE_KEY_MESSAGES + ':default';
      var oldData = localStorage.getItem(oldKey);
      var newData = localStorage.getItem(newKey);
      if (oldData && !newData) {
        localStorage.setItem(newKey, oldData);
        // 保留旧 key 以兼容降级回退，不删除
      }
    } catch (_e) { /* ignore */ }
  })();
  var toolTraces = {};
  var currentToolBatch = [];
  var lastSessionSyncSig = '';
  var structuredMessagesCache = null;

  function getLiveToolStorageKey() {
    return 'ice-chat-live-tools:' + SESSION_ID;
  }

  function saveLiveToolBatch() {
    try {
      if (!currentToolBatch.length) {
        localStorage.removeItem(getLiveToolStorageKey());
        return;
      }
      localStorage.setItem(getLiveToolStorageKey(), JSON.stringify({
        tools: currentToolBatch.map(function (t) {
          return {
            toolName: t.toolName || '',
            detail: t.detail || '',
            status: t.status || 'pending',
            toolCallId: t.toolCallId || '',
          };
        }),
        savedAt: Date.now(),
      }));
    } catch (_e) { /* ignore */ }
  }

  function loadLiveToolBatch() {
    try {
      var raw = localStorage.getItem(getLiveToolStorageKey());
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tools)) return [];
      return parsed.tools.filter(function (t) {
        return t && typeof t.toolName === 'string' && t.toolName;
      }).map(function (t) {
        return {
          toolName: t.toolName,
          detail: typeof t.detail === 'string' ? t.detail : '',
          status: t.status || 'pending',
          toolCallId: t.toolCallId || '',
        };
      });
    } catch (_e) {
      return [];
    }
  }

  function clearLiveToolBatch() {
    currentToolBatch = [];
    try {
      localStorage.removeItem(getLiveToolStorageKey());
    } catch (_e) { /* ignore */ }
  }

  function replaceLiveToolBatch(tools) {
    currentToolBatch = Array.isArray(tools)
      ? tools.map(function (t) {
        return {
          toolName: t.toolName || '',
          detail: t.detail || '',
          status: t.status || 'pending',
          toolCallId: t.toolCallId || '',
        };
      })
      : [];
    saveLiveToolBatch();
    return currentToolBatch;
  }

  function stripStatusTag(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/<status>\s*(?:complete|incomplete)\s*<\/status>/gi, '')
      .replace(/<system-context>[\s\S]*?<\/system-context>/gi, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(/<system>[\s\S]*?<\/system>/gi, '')
      .replace(/<\/?system(?:-(?:reminder|context))?\s*>/gi, '')
      .replace(/^\s*\n+/, '')
      .replace(/\s*$/, '');
  }

  function stampMessageTimestamps(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    var now = Date.now();
    if (msg.role === 'user' && msg.sentAt == null) msg.sentAt = now;
    if (msg.role === 'system' && msg.sentAt == null) msg.sentAt = now;
    if (msg.role === 'agent' && !msg._streaming && msg.completedAt == null) msg.completedAt = now;
    return msg;
  }

  /** 可跨刷新持久化的图片 URL（排除 inline data URL，避免 localStorage 配额溢出）。 */
  function filterPersistableImageUrls(urls) {
    if (!Array.isArray(urls)) return [];
    return urls.filter(function (u) {
      return typeof u === 'string' && u && u.indexOf('data:') !== 0;
    });
  }

  function serializeMessageForStorage(m) {
    var c = m.content;
    if (m.role === 'agent' && typeof c === 'string') c = stripStatusTag(c);
    var o = { role: m.role, content: c };
    if (m.id) o.id = m.id;
    if (typeof m.sentAt === 'number' && isFinite(m.sentAt)) o.sentAt = m.sentAt;
    if (typeof m.completedAt === 'number' && isFinite(m.completedAt)) o.completedAt = m.completedAt;
    var persistableImages = filterPersistableImageUrls(m.images);
    if (persistableImages.length > 0) {
      o.images = persistableImages;
    }
    if (m.shellCommand) o.shellCommand = m.shellCommand;
    if (m.openCommand) o.openCommand = m.openCommand;
    if (m.alsoNote) o.alsoNote = true;
    if (Array.isArray(m.skills) && m.skills.length) o.skills = m.skills.slice();
    if (Array.isArray(m.referencePaths) && m.referencePaths.length) {
      o.referencePaths = m.referencePaths.slice();
    }
    if (m.turnTokenUsage && typeof m.turnTokenUsage === 'object') {
      o.turnTokenUsage = {
        inputTokens: m.turnTokenUsage.inputTokens || 0,
        outputTokens: m.turnTokenUsage.outputTokens || 0,
      };
    }
    return o;
  }

  function normalizeStoredMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var role = raw.role;
    if (role !== 'user' && role !== 'agent' && role !== 'system') return null;
    var rawContent = typeof raw.content === 'string' ? raw.content : '';
    var content = role === 'agent' ? stripStatusTag(rawContent) : rawContent;
    var o = { role: role, content: content };
    if (raw.id) o.id = raw.id;
    if (Array.isArray(raw.images) && raw.images.length > 0) {
      o.images = raw.images.filter(function (u) { return typeof u === 'string' && u; });
    }
    if (typeof raw.sentAt === 'number' && isFinite(raw.sentAt)) o.sentAt = raw.sentAt;
    if (typeof raw.completedAt === 'number' && isFinite(raw.completedAt)) o.completedAt = raw.completedAt;
    if (raw.shellCommand) o.shellCommand = raw.shellCommand;
    if (raw.openCommand) o.openCommand = raw.openCommand;
    if (raw.alsoNote) o.alsoNote = true;
    if (Array.isArray(raw.skills) && raw.skills.length) o.skills = raw.skills.slice();
    if (Array.isArray(raw.referencePaths) && raw.referencePaths.length) {
      o.referencePaths = raw.referencePaths.slice();
    }
    if (raw.turnTokenUsage && typeof raw.turnTokenUsage === 'object') {
      o.turnTokenUsage = {
        inputTokens: raw.turnTokenUsage.inputTokens || 0,
        outputTokens: raw.turnTokenUsage.outputTokens || 0,
      };
    }
    return o;
  }

  function saveSessionMessages() {
    var toSave = messages.map(function (m) { return serializeMessageForStorage(m); });
    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(toSave));
    } catch (_e) { /* ignore */ }
  }

  function loadLocalMessages() {
    try {
      var stored = localStorage.getItem(getStorageKey());
      if (stored) {
        var parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];
        var out = [];
        for (var i = 0; i < parsed.length; i++) {
          var n = normalizeStoredMessage(parsed[i]);
          if (n) out.push(n);
        }
        return out;
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  function fetchServerMessages(callback) {
    syncSessionIdFromStore();
    var url = '/api/sessions/' + SESSION_ID + '?_t=' + Date.now();
    fetch(url)
      .then(function (res) {
        if (res && 'ok' in res && !res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        var msgs = (data.messages && data.messages.length > 0) ? data.messages : [];
        if (callback) callback(msgs, { ok: true });
      })
      .catch(function () {
        if (callback) callback([], { ok: false });
      });
  }

  var structuredEmptyWarned = false;

  function warnStructuredEmptyOnce(sessionId) {
    if (structuredEmptyWarned) return;
    structuredEmptyWarned = true;
    console.warn(
      '[ChatSession] structured messages 为空（session=' + sessionId + '）。'
      + '历史 diff 无法还原；新任务完成后会自动生成 .structured.json。',
    );
  }

  function syncSessionIdFromStore() {
    if (window.ChatSessionStore && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
      var sid = window.ChatSessionStore.getActiveSessionId();
      if (sid && sid !== SESSION_ID) {
        SESSION_ID = sid;
        structuredMessagesCache = null;
        lastSessionSyncSig = '';
      }
    }
  }

  function fetchStructuredMessages(callback) {
    syncSessionIdFromStore();
    var url = '/api/sessions/' + SESSION_ID + '/structured?_t=' + Date.now();
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        structuredMessagesCache = Array.isArray(data.messages) ? data.messages : [];
        if (structuredMessagesCache.length === 0) {
          warnStructuredEmptyOnce(SESSION_ID);
        }
        if (callback) callback(structuredMessagesCache);
      })
      .catch(function () {
        structuredMessagesCache = [];
        if (callback) callback([]);
      });
  }

  function getStructuredMessages() {
    return structuredMessagesCache || [];
  }

  function invalidateStructuredCache() {
    structuredMessagesCache = null;
  }

  function hasStreamingModelBubble() {
    var last = messages[messages.length - 1];
    return !!(last && last.role === 'agent' && last._streaming);
  }

  function normalizeReferencePath(raw) {
    return String(raw || '').trim().replace(/\//g, '\\').toLowerCase();
  }

  function looksLikeReferencePathLine(line) {
    var trimmed = String(line || '').trim();
    if (!trimmed) return false;
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
    if (trimmed.charAt(0) === '/' && trimmed.indexOf('//') !== 0 && !isSlashCommandLine(trimmed)) return true;
    return false;
  }

  function isSlashCommandLine(trimmed) {
    return /^\/[a-z]+(?:\s|$)/i.test(trimmed) && trimmed.slice(1).indexOf('/') < 0;
  }

  function isOpenCommandLine(line) {
    var t = String(line || '').trim();
    return t === '/open' || t.indexOf('/open ') === 0
      || t === '~open' || t.indexOf('~open ') === 0;
  }

  function splitOpenCommandFromContent(text, existingOpenCommand) {
    var raw = String(text || '');
    var lines = raw.split(/\r?\n/);
    var openLineIndex = -1;
    for (var i = 0; i < lines.length; i++) {
      if (isOpenCommandLine(lines[i])) {
        openLineIndex = i;
        break;
      }
    }
    if (openLineIndex < 0) {
      return { openCommand: existingOpenCommand || '', content: raw.trim() };
    }
    return {
      openCommand: existingOpenCommand || '/open',
      content: lines.slice(openLineIndex + 1).join('\n').trim(),
    };
  }

  function parseSkillRefsFromContent(text) {
    var re = /(?:^|\s)#([^\s#]+\.md)\b/g;
    var seen = {};
    var result = [];
    var m;
    while ((m = re.exec(text)) !== null) {
      var fn = m[1];
      if (!seen[fn]) {
        seen[fn] = true;
        result.push(fn);
      }
    }
    return result;
  }

  function extractReferencePathsFromContent(text) {
    var paths = [];
    var seen = {};
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!looksLikeReferencePathLine(trimmed)) continue;
      var key = normalizeReferencePath(trimmed);
      if (seen[key]) continue;
      seen[key] = true;
      paths.push(trimmed);
    }
    return paths;
  }

  function stripRefsFromDisplayContent(text, skills, referencePaths) {
    var skillSet = {};
    var refSet = {};
    var i;
    for (i = 0; i < (skills || []).length; i++) {
      skillSet[String(skills[i]).toLowerCase()] = true;
    }
    for (i = 0; i < (referencePaths || []).length; i++) {
      refSet[normalizeReferencePath(referencePaths[i])] = true;
    }
    return String(text || '').split(/\r?\n/)
      .map(function (line) {
        var trimmed = line.trim();
        if (trimmed && refSet[normalizeReferencePath(trimmed)]) return '';
        return line
          .replace(/(?:^|\s)#([^\s#]+\.md)\b/g, function (match, fn) {
            return skillSet[String(fn).toLowerCase()] ? '' : match;
          })
          .trim();
      })
      .filter(function (line) { return line.length > 0; })
      .join('\n')
      .trim();
  }

  /**
   * 将 `/shell` / `/shell <prompt>` 拆成模式标记 + 提示词正文。
   * 即使已有 shellCommand，也要剥离正文里残留的 `/shell` 前缀（防止回合刷新后合并回一条）。
   */
  function splitShellCommandFromContent(text, existingShellCommand) {
    var raw = String(text || '');
    var lines = raw.split(/\r?\n/);
    var shellLineIndex = -1;
    var shellLine = '';
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t === '/shell' || t.startsWith('/shell ')) {
        if (t === '/shell exit' || t.indexOf('/shell exit ') === 0) {
          return { shellCommand: '', content: raw };
        }
        shellLineIndex = i;
        shellLine = t;
        break;
      }
    }
    if (shellLineIndex < 0) {
      return {
        shellCommand: existingShellCommand || '',
        content: raw.trim(),
      };
    }
    var after = shellLine.slice('/shell'.length).trim();
    var promptParts = [];
    if (after) promptParts.push(after);
    var rest = lines.slice(shellLineIndex + 1).join('\n').trim();
    if (rest.indexOf('[Shell Copilot Mode]') === 0) rest = '';
    else if (rest.indexOf('[Shell Copilot Mode]') > 0) {
      rest = rest.slice(0, rest.indexOf('[Shell Copilot Mode]')).trim();
    }
    if (rest) promptParts.push(rest);
    return {
      shellCommand: existingShellCommand || '/shell',
      content: promptParts.join('\n').trim(),
    };
  }

  function enrichUserMessageForDisplay(msg) {
    if (!msg || msg.role !== 'user') return msg;
    var cloned = Object.assign({}, msg);
    var text = typeof cloned.content === 'string' ? cloned.content : '';
    var shellSplit = splitShellCommandFromContent(text, cloned.shellCommand);
    if (shellSplit.shellCommand) {
      cloned.shellCommand = shellSplit.shellCommand;
      text = shellSplit.content;
      cloned.content = text;
    }
    var openSplit = splitOpenCommandFromContent(text, cloned.openCommand);
    if (openSplit.openCommand) {
      cloned.openCommand = openSplit.openCommand;
      text = openSplit.content;
      cloned.content = text;
    }
    var skills = Array.isArray(cloned.skills) && cloned.skills.length
      ? cloned.skills.slice()
      : parseSkillRefsFromContent(text);
    var referencePaths = (Array.isArray(cloned.referencePaths) && cloned.referencePaths.length
      ? cloned.referencePaths.slice()
      : extractReferencePathsFromContent(text)
    ).filter(function (p) { return !isSlashCommandLine(String(p || '').trim()); });
    cloned.content = stripRefsFromDisplayContent(text, skills, referencePaths);
    if (skills.length > 0) cloned.skills = skills;
    else delete cloned.skills;
    if (referencePaths.length > 0) cloned.referencePaths = referencePaths;
    else delete cloned.referencePaths;
    return cloned;
  }

  function separateToolTraces(serverMsgs) {
    var msgs = [];
    var traces = {};
    for (var i = 0; i < serverMsgs.length; i++) {
      var m = serverMsgs[i];
      if (m.role === 'tool_trace' && m.parentId) {
        if (!traces[m.parentId]) traces[m.parentId] = [];
        var traceRow = {
          toolName: m.toolName || '',
          detail: m.detail || '',
          status: m.status || 'pending',
          toolCallId: m.toolCallId || '',
        };
        if (typeof m.diffSource === 'string' && m.diffSource) {
          traceRow.diffSource = m.diffSource;
        }
        traces[m.parentId].push(traceRow);
      } else {
        var cloned = Object.assign({}, m);
        if ((m.role === 'agent' || m.role === 'assistant') && typeof m.content === 'string') {
          cloned.content = stripStatusTag(m.content);
        }
        if (Array.isArray(m.images) && m.images.length > 0) {
          cloned.images = m.images.slice();
        }
        if (cloned.role === 'user') {
          cloned = enrichUserMessageForDisplay(cloned);
        }
        msgs.push(cloned);
      }
    }
    return { msgs: msgs, traces: traces };
  }

  function snapshotTraceTotals(tr) {
    var keys = Object.keys(tr || {}).sort();
    if (!keys.length) return '';
    return keys.map(function (k) { return k + '=' + tr[k].length; }).join(';');
  }

  function sessionPayloadSig(separated) {
    var ids = separated.msgs.map(function (m) { return m.id || ''; }).join(',');
    return separated.msgs.length + '|' + ids + '|' + snapshotTraceTotals(separated.traces);
  }

  function hasUserMessageId(id) {
    if (!id) return false;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].id === id) return true;
    }
    return false;
  }

  /**
   * 多端同步：在 processing / 流式期间插入远端用户消息（插在当前轮 assistant 流式气泡之前）。
   * @returns {boolean} 是否新增了消息
   */
  function patchUserMessageImages(id, images) {
    if (!id) return false;
    var persistable = filterPersistableImageUrls(images);
    if (persistable.length === 0) return false;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].id !== id) continue;
      messages[i].images = persistable.slice();
      return true;
    }
    return false;
  }

  /** 用服务端用户消息补丁本地条目（含 shellCommand / 正文拆分），返回是否有字段变化。 */
  function patchUserMessageDisplay(id, incoming) {
    if (!id || !incoming) return false;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].id !== id) continue;
      var cur = messages[i];
      var enriched = enrichUserMessageForDisplay(incoming);
      if ((!enriched.referencePaths || !enriched.referencePaths.length)
          && cur.referencePaths && cur.referencePaths.length) {
        enriched.referencePaths = cur.referencePaths.slice();
      }
      if ((!enriched.skills || !enriched.skills.length) && cur.skills && cur.skills.length) {
        enriched.skills = cur.skills.slice();
      }
      if (!enriched.shellCommand && cur.shellCommand) {
        enriched.shellCommand = cur.shellCommand;
      }
      if (!enriched.openCommand && cur.openCommand) {
        enriched.openCommand = cur.openCommand;
      }
      var changed = false;
      if (String(cur.content || '') !== String(enriched.content || '')) {
        cur.content = enriched.content || '';
        changed = true;
      }
      if ((cur.shellCommand || '') !== (enriched.shellCommand || '')) {
        if (enriched.shellCommand) cur.shellCommand = enriched.shellCommand;
        else delete cur.shellCommand;
        changed = true;
      }
      if ((cur.openCommand || '') !== (enriched.openCommand || '')) {
        if (enriched.openCommand) cur.openCommand = enriched.openCommand;
        else delete cur.openCommand;
        changed = true;
      }
      if (enriched.alsoNote) {
        if (!cur.alsoNote) { cur.alsoNote = true; changed = true; }
      }
      if (Array.isArray(enriched.skills)) {
        cur.skills = enriched.skills.slice();
        changed = true;
      }
      if (Array.isArray(enriched.referencePaths)) {
        cur.referencePaths = enriched.referencePaths.slice();
        changed = true;
      }
      var persistable = filterPersistableImageUrls(enriched.images || incoming.images);
      if (persistable.length > 0) {
        cur.images = persistable.slice();
        changed = true;
      }
      return changed;
    }
    return false;
  }

  function insertRemoteUserMessage(msg) {
    if (!msg || msg.role !== 'user') return false;
    if (hasUserMessageId(msg.id)) {
      patchUserMessageDisplay(msg.id, msg);
      patchUserMessageImages(msg.id, msg.images || []);
      return true;
    }
    stampMessageTimestamps(msg);
    msg = enrichUserMessageForDisplay(msg);
    var insertAt = messages.length;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent' && messages[i]._streaming) {
        insertAt = i;
        break;
      }
    }
    messages.splice(insertAt, 0, msg);
    reindexMessages();
    return true;
  }

  function mergeUserMessagesFromServer(serverMsgs) {
    if (!serverMsgs || !serverMsgs.length) return false;
    var added = false;
    for (var i = 0; i < serverMsgs.length; i++) {
      var m = serverMsgs[i];
      if (m.role === 'user' && insertRemoteUserMessage(m)) added = true;
    }
    return added;
  }

  function fetchAndMergeRemoteUserMessages(done) {
    fetchServerMessages(function (serverMsgs) {
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = separateToolTraces(raw);
      var added = mergeUserMessagesFromServer(separated.msgs);
      if (done) done(added);
    });
  }

  /** 服务端快照缺 referencePaths/skills 时，保留本地已展示的用户消息元数据（如 @ 文件 chip）。 */
  function mergeLocalUserDisplayFields(serverMsgs, localMsgs) {
    if (!localMsgs || !localMsgs.length || !serverMsgs || !serverMsgs.length) return;
    var localById = {};
    var i;
    for (i = 0; i < localMsgs.length; i++) {
      var lm = localMsgs[i];
      if (lm && lm.role === 'user' && lm.id) localById[lm.id] = lm;
    }
    for (i = 0; i < serverMsgs.length; i++) {
      var sm = serverMsgs[i];
      if (!sm || sm.role !== 'user' || !sm.id) continue;
      var local = localById[sm.id];
      if (!local) continue;
      var merged = Object.assign({}, sm);
      var patched = false;
      if ((!merged.referencePaths || !merged.referencePaths.length)
          && local.referencePaths && local.referencePaths.length) {
        merged.referencePaths = local.referencePaths.slice();
        patched = true;
      }
      if ((!merged.skills || !merged.skills.length) && local.skills && local.skills.length) {
        merged.skills = local.skills.slice();
        patched = true;
      }
      if (!merged.shellCommand && local.shellCommand) {
        merged.shellCommand = local.shellCommand;
        patched = true;
      }
      if (!merged.openCommand && local.openCommand) {
        merged.openCommand = local.openCommand;
        patched = true;
      }
      if (patched) serverMsgs[i] = enrichUserMessageForDisplay(merged);
    }
  }

  function applyServerChatSnapshot(separated, options, isStreaming, wsProcessing) {
    var opts = options || {};
    if (hasStreamingModelBubble() || wsProcessing || isStreaming) return false;
    // 非权威快照不得用较短历史覆盖本地待同步消息；权威空快照代表会话确实为空。
    if (!opts.authoritative && separated.msgs.length < messages.length) return false;

    var sig = sessionPayloadSig(separated);
    if (sig === lastSessionSyncSig && separated.msgs.length === messages.length) {
      return false;
    }

    mergeLocalUserDisplayFields(separated.msgs, messages);
    messages = separated.msgs;
    toolTraces = separated.traces;
    reindexMessages();
    lastSessionSyncSig = sig;
    return true;
  }

  function initSession() {
    SESSION_ID = readInitialSessionId();
    messages = loadLocalMessages();
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        messages[i] = enrichUserMessageForDisplay(messages[i]);
      }
    }
    reindexMessages();
    toolTraces = {};
    currentToolBatch = loadLiveToolBatch();
    return messages;
  }

  function saveMessages() {
    saveSessionMessages();
  }

  function flushToolBatchLocal() {
    clearLiveToolBatch();
  }

  function reindexMessages() {
    for (var i = 0; i < messages.length; i++) {
      messages[i]._msgIndex = i;
    }
  }

  function appendMessage(msg) {
    stampMessageTimestamps(msg);
    if (msg && msg.role === 'user') {
      var enriched = enrichUserMessageForDisplay(msg);
      msg.content = enriched.content;
      if (enriched.shellCommand) msg.shellCommand = enriched.shellCommand;
      else delete msg.shellCommand;
      if (enriched.openCommand) msg.openCommand = enriched.openCommand;
      else delete msg.openCommand;
      if (enriched.skills) msg.skills = enriched.skills;
      else delete msg.skills;
      if (enriched.referencePaths) msg.referencePaths = enriched.referencePaths;
      else delete msg.referencePaths;
    }
    msg._msgIndex = messages.length;
    messages.push(msg);
  }

  function removeMessageById(messageId) {
    if (!messageId) return false;
    var idx = -1;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].id === messageId) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;
    messages.splice(idx, 1);
    reindexMessages();
    return true;
  }

  function getMessages() {
    return messages;
  }

  function getToolTraces() {
    return toolTraces;
  }

  function getLastMessage() {
    return messages[messages.length - 1] || null;
  }

  function updateLastMessageContent(content) {
    var last = messages[messages.length - 1];
    if (last) last.content = content;
  }

  function markLastMessageStreaming(streaming) {
    var last = messages[messages.length - 1];
    if (!last) return;
    if (streaming) {
      last._streaming = true;
    } else {
      delete last._streaming;
    }
  }

  function getCurrentToolBatch() {
    return currentToolBatch;
  }

  function pushToolBatch(item) {
    currentToolBatch.push(item);
    saveLiveToolBatch();
  }

  function updateToolBatchStatus(toolName, status, toolCallId) {
    for (var i = currentToolBatch.length - 1; i >= 0; i--) {
      if (toolCallId && currentToolBatch[i].toolCallId === toolCallId) {
        currentToolBatch[i].status = status;
        break;
      }
      if (currentToolBatch[i].toolName === toolName
        && (currentToolBatch[i].status === 'pending' || currentToolBatch[i].status === 'background')) {
        currentToolBatch[i].status = status;
        break;
      }
    }
    saveLiveToolBatch();
  }

  /** 切换会话 ID（前端侧栏切换时调用） */
  function setSessionId(id) {
    saveSessionMessages();
    SESSION_ID = id || 'default';
    messages = loadLocalMessages();
    toolTraces = {};
    currentToolBatch = loadLiveToolBatch();
    lastSessionSyncSig = '';
    structuredMessagesCache = null;
    structuredEmptyWarned = false;
  }

  function getActiveId() { return SESSION_ID; }

  return {
    initSession: initSession,
    saveMessages: saveMessages,
    loadLocalMessages: loadLocalMessages,
    fetchServerMessages: fetchServerMessages,
    fetchStructuredMessages: fetchStructuredMessages,
    getStructuredMessages: getStructuredMessages,
    invalidateStructuredCache: invalidateStructuredCache,
    separateToolTraces: separateToolTraces,
    applyServerChatSnapshot: applyServerChatSnapshot,
    flushToolBatchLocal: flushToolBatchLocal,
    appendMessage: appendMessage,
    removeMessageById: removeMessageById,
    stampMessageTimestamps: stampMessageTimestamps,
    getMessages: getMessages,
    getToolTraces: getToolTraces,
    getLastMessage: getLastMessage,
    updateLastMessageContent: updateLastMessageContent,
    markLastMessageStreaming: markLastMessageStreaming,
    getCurrentToolBatch: getCurrentToolBatch,
    pushToolBatch: pushToolBatch,
    updateToolBatchStatus: updateToolBatchStatus,
    loadLiveToolBatch: loadLiveToolBatch,
    replaceLiveToolBatch: replaceLiveToolBatch,
    clearLiveToolBatch: clearLiveToolBatch,
    saveLiveToolBatch: saveLiveToolBatch,
    hasStreamingModelBubble: hasStreamingModelBubble,
    insertRemoteUserMessage: insertRemoteUserMessage,
    patchUserMessageImages: patchUserMessageImages,
    patchUserMessageDisplay: patchUserMessageDisplay,
    prepareUserMessageForDisplay: enrichUserMessageForDisplay,
    getMessageById: function (id) {
      if (!id) return null;
      for (var i = 0; i < messages.length; i++) {
        if (messages[i].id === id) return messages[i];
      }
      return null;
    },
    hasUserMessageId: hasUserMessageId,
    mergeUserMessagesFromServer: mergeUserMessagesFromServer,
    fetchAndMergeRemoteUserMessages: fetchAndMergeRemoteUserMessages,
    stripStatusTag: stripStatusTag,
    setSessionId: setSessionId,
    getActiveId: getActiveId,
  };
})();
