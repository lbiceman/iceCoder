// @ts-nocheck
/**
 * 聊天会话管理模块
 * 负责：消息存取、localStorage 持久化、服务端同步、tool_trace 分离
 */

/* exported ChatSession */

export const ChatSession = (() => {

  const STORAGE_KEY_MESSAGES = 'ice-chat-messages';
  const STORAGE_KEY_LAST_ACTIVE = 'ice-chat-last-active-session';

  function readInitialSessionId() {
    if (window.ChatSessionStore && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
      const fromStore = window.ChatSessionStore.getActiveSessionId();
      if (fromStore) return fromStore;
    }
    try {
      return localStorage.getItem(STORAGE_KEY_LAST_ACTIVE) || 'default';
    } catch (_e) {
      return 'default';
    }
  }

  let SESSION_ID = readInitialSessionId();

  function getStorageKey() { return `${STORAGE_KEY_MESSAGES}:${SESSION_ID}`; }

  let messages = [];

  // T1-7: 首次使用多会话时，将旧 localStorage key 迁移到 default session
  (function migrateStorage() {
    try {
      const oldKey = STORAGE_KEY_MESSAGES;
      const newKey = `${STORAGE_KEY_MESSAGES}:default`;
      const oldData = localStorage.getItem(oldKey);
      const newData = localStorage.getItem(newKey);
      if (oldData && !newData) {
        localStorage.setItem(newKey, oldData);
        // 保留旧 key 以兼容降级回退，不删除
      }
    } catch (_e) { /* ignore */ }
  })();
  let toolTraces = {};
  let currentToolBatch = [];
  let lastSessionSyncSig = '';
  let structuredMessagesCache = null;

  function getLiveToolStorageKey() {
    return `ice-chat-live-tools:${SESSION_ID}`;
  }

  function saveLiveToolBatch() {
    try {
      if (!currentToolBatch.length) {
        localStorage.removeItem(getLiveToolStorageKey());
        return;
      }
      localStorage.setItem(getLiveToolStorageKey(), JSON.stringify({
        tools: currentToolBatch.map((t) => {
          const row = {
            toolName: t.toolName || '',
            detail: t.detail || '',
            status: t.status || 'pending',
            toolCallId: t.toolCallId || '',
          };
          if (typeof t.iteration === 'number' && isFinite(t.iteration) && t.iteration > 0) {
            row.iteration = Math.floor(t.iteration);
          }
          return row;
        }),
        savedAt: Date.now(),
      }));
    } catch (_e) { /* ignore */ }
  }

  function loadLiveToolBatch() {
    try {
      const raw = localStorage.getItem(getLiveToolStorageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tools)) return [];
      return parsed.tools.filter((t) =>  t && typeof t.toolName === 'string' && t.toolName).map((t) =>  ({
          toolName: t.toolName,
          detail: typeof t.detail === 'string' ? t.detail : '',
          status: t.status || 'pending',
          toolCallId: t.toolCallId || '',
          iteration: typeof t.iteration === 'number' && t.iteration > 0 ? t.iteration : undefined,
        }));
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
      ? tools.map((t) =>  ({
          toolName: t.toolName || '',
          detail: t.detail || '',
          status: t.status || 'pending',
          toolCallId: t.toolCallId || '',
        }))
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
    const now = Date.now();
    if (msg.role === 'user' && msg.sentAt == null) msg.sentAt = now;
    if (msg.role === 'system' && msg.sentAt == null) msg.sentAt = now;
    if (msg.role === 'agent' && !msg._streaming && msg.completedAt == null) msg.completedAt = now;
    return msg;
  }

  /** 可跨刷新持久化的图片 URL（排除 inline data URL，避免 localStorage 配额溢出）。 */
  function filterPersistableImageUrls(urls) {
    if (!Array.isArray(urls)) return [];
    return urls.filter((u) =>  typeof u === 'string' && u && !u.startsWith('data:'));
  }

  function serializeMessageForStorage(m) {
    let c = m.content;
    if (m.role === 'agent' && typeof c === 'string') c = stripStatusTag(c);
    const o = { role: m.role, content: c };
    if (m.id) o.id = m.id;
    if (typeof m.sentAt === 'number' && isFinite(m.sentAt)) o.sentAt = m.sentAt;
    if (typeof m.completedAt === 'number' && isFinite(m.completedAt)) o.completedAt = m.completedAt;
    const persistableImages = filterPersistableImageUrls(m.images);
    if (persistableImages.length > 0) {
      o.images = persistableImages;
    }
    if (m.shellCommand) o.shellCommand = m.shellCommand;
    if (m.planCommand) o.planCommand = m.planCommand;
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
    const usedModel = typeof m.usedModel === 'string' ? m.usedModel.trim() : '';
    if (usedModel) o.usedModel = usedModel;
    return o;
  }

  function normalizeStoredMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const role = raw.role;
    if (role !== 'user' && role !== 'agent' && role !== 'system') return null;
    const rawContent = typeof raw.content === 'string' ? raw.content : '';
    const content = role === 'agent' ? stripStatusTag(rawContent) : rawContent;
    const o = { role, content };
    if (raw.id) o.id = raw.id;
    if (Array.isArray(raw.images) && raw.images.length > 0) {
      o.images = raw.images.filter((u) =>  typeof u === 'string' && u);
    }
    if (typeof raw.sentAt === 'number' && isFinite(raw.sentAt)) o.sentAt = raw.sentAt;
    if (typeof raw.completedAt === 'number' && isFinite(raw.completedAt)) o.completedAt = raw.completedAt;
    if (raw.shellCommand) o.shellCommand = raw.shellCommand;
    if (raw.planCommand) o.planCommand = raw.planCommand;
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
    const usedModel = typeof raw.usedModel === 'string' ? raw.usedModel.trim() : '';
    if (usedModel) o.usedModel = usedModel;
    return o;
  }

  function saveSessionMessages() {
    const toSave = messages.map((m) =>  serializeMessageForStorage(m));
    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(toSave));
    } catch (_e) { /* ignore */ }
  }

  function loadLocalMessages() {
    try {
      const stored = localStorage.getItem(getStorageKey());
      if (stored) {
        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];
        const out = [];
        for (let i = 0; i < parsed.length; i++) {
          const n = normalizeStoredMessage(parsed[i]);
          if (n) out.push(n);
        }
        return out;
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  function fetchServerMessages(callback) {
    syncSessionIdFromStore();
    const requestedId = SESSION_ID;
    const url = `/api/sessions/${requestedId}?_t=${Date.now()}`;
    fetch(url)
      .then((res) => {
        if (res && 'ok' in res && !res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (SESSION_ID !== requestedId) return;
        const msgs = (data.messages && data.messages.length > 0) ? data.messages : [];
        if (callback) callback(msgs, { ok: true });
      })
      .catch(() => {
        if (SESSION_ID !== requestedId) return;
        if (callback) callback([], { ok: false });
      });
  }

  const structuredEmptyWarnedBySession = {};

  function warnStructuredEmptyOnce(sessionId) {
    if (!sessionId || structuredEmptyWarnedBySession[sessionId]) return;
    if (!messages || messages.length === 0) return;
    structuredEmptyWarnedBySession[sessionId] = true;
    console.warn(
      `[ChatSession] structured messages 为空（session=${sessionId}）。历史 diff 无法还原；新任务完成后会自动生成 .structured.json。`,
    );
  }

  function syncSessionIdFromStore() {
    if (window.ChatSessionStore && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
      const sid = window.ChatSessionStore.getActiveSessionId();
      if (sid && sid !== SESSION_ID) {
        SESSION_ID = sid;
        structuredMessagesCache = null;
        lastSessionSyncSig = '';
      }
    }
  }

  function fetchStructuredMessages(callback) {
    syncSessionIdFromStore();
    const requestedId = SESSION_ID;
    const url = `/api/sessions/${requestedId}/structured?_t=${Date.now()}`;
    fetch(url)
      .then((res) =>  res.json())
      .then((data) => {
        if (SESSION_ID !== requestedId) return;
        structuredMessagesCache = Array.isArray(data.messages) ? data.messages : [];
        if (structuredMessagesCache.length === 0) {
          warnStructuredEmptyOnce(requestedId);
        }
        if (callback) callback(structuredMessagesCache);
      })
      .catch(() => {
        if (SESSION_ID !== requestedId) return;
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
    const last = messages[messages.length - 1];
    return !!(last && last.role === 'agent' && last._streaming);
  }

  function normalizeReferencePath(raw) {
    return String(raw || '').trim().replace(/\//g, '\\').toLowerCase();
  }

  function looksLikeReferencePathLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return false;
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
    if (trimmed.charAt(0) === '/' && !trimmed.startsWith('//') && !isSlashCommandLine(trimmed)) return true;
    return false;
  }

  function isSlashCommandLine(trimmed) {
    return /^\/[a-z]+(?:\s|$)/i.test(trimmed) && !trimmed.slice(1).includes('/');
  }

  function isOpenCommandLine(line) {
    const t = String(line || '').trim();
    return t === '/open' || t.startsWith('/open ')
      || t === '~open' || t.startsWith('~open ');
  }

  function splitOpenCommandFromContent(text, existingOpenCommand) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/);
    let openLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
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
    const re = /(?:^|\s)#([^\s#]+\.md)\b/g;
    const seen = {};
    const result = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const fn = m[1];
      if (!seen[fn]) {
        seen[fn] = true;
        result.push(fn);
      }
    }
    return result;
  }

  function extractReferencePathsFromContent(text) {
    const paths = [];
    const seen = {};
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!looksLikeReferencePathLine(trimmed)) continue;
      const key = normalizeReferencePath(trimmed);
      if (seen[key]) continue;
      seen[key] = true;
      paths.push(trimmed);
    }
    return paths;
  }

  function stripRefsFromDisplayContent(text, skills, referencePaths) {
    const skillSet = {};
    const refSet = {};
    let i;
    for (i = 0; i < (skills || []).length; i++) {
      skillSet[String(skills[i]).toLowerCase()] = true;
    }
    for (i = 0; i < (referencePaths || []).length; i++) {
      refSet[normalizeReferencePath(referencePaths[i])] = true;
    }
    return String(text || '').split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed && refSet[normalizeReferencePath(trimmed)]) return '';
        return line
          .replace(/(?:^|\s)#([^\s#]+\.md)\b/g, (match, fn) =>  skillSet[String(fn).toLowerCase()] ? '' : match)
          .trim();
      })
      .filter((line) =>  line.length > 0)
      .join('\n')
      .trim();
  }

  /**
   * 将 `/shell` / `/shell <prompt>` 拆成模式标记 + 提示词正文。
   * 即使已有 shellCommand，也要剥离正文里残留的 `/shell` 前缀（防止回合刷新后合并回一条）。
   */
  function splitShellCommandFromContent(text, existingShellCommand) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/);
    let shellLineIndex = -1;
    let shellLine = '';
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '/shell' || t.startsWith('/shell ')) {
        if (t === '/shell exit' || t.startsWith('/shell exit ')) {
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
    const after = shellLine.slice('/shell'.length).trim();
    const promptParts = [];
    if (after) promptParts.push(after);
    let rest = lines.slice(shellLineIndex + 1).join('\n').trim();
    if (rest.startsWith('[Shell Copilot Mode]')) rest = '';
    else if (rest.indexOf('[Shell Copilot Mode]') > 0) {
      rest = rest.slice(0, rest.indexOf('[Shell Copilot Mode]')).trim();
    }
    if (rest) promptParts.push(rest);
    return {
      shellCommand: existingShellCommand || '/shell',
      content: promptParts.join('\n').trim(),
    };
  }

  function isPlanCommandMetaLine(trimmed) {
    if (!trimmed) return true;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      let allSkills = true;
      for (let i = 0; i < tokens.length; i++) {
        if (!/^#[^\s#]+\.md$/i.test(tokens[i])) { allSkills = false; break; }
      }
      if (allSkills) return true;
    }
    if (looksLikeReferencePathLine(trimmed)) return true;
    return false;
  }

  function splitPlanCommandFromContent(text, existingPlanCommand) {
    const raw = String(text || '');
    const lines = raw.trim().split(/\r?\n/);
    let planLineIndex = -1;
    let planLine = '';
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (isPlanCommandMetaLine(t)) continue;
      if (t === '/plan' || t === '/plan exit' || t.startsWith('/plan ')) {
        const afterCmd = t.slice('/plan'.length).trim();
        if (afterCmd === 'exit' || afterCmd.startsWith('exit ')) {
          if (t === '/plan exit') {
            planLineIndex = i;
            planLine = t;
          }
          break;
        }
        planLineIndex = i;
        planLine = t;
      }
      break;
    }
    if (planLineIndex < 0) {
      return {
        planCommand: existingPlanCommand || '',
        content: raw.trim(),
      };
    }
    const after = planLine.slice('/plan'.length).trim();
    const promptParts = [];
    if (after && after !== 'exit') promptParts.push(after);
    const rest = lines.slice(planLineIndex + 1).join('\n').trim();
    if (rest) promptParts.push(rest);
    return {
      planCommand: existingPlanCommand || '/plan',
      content: promptParts.join('\n').trim(),
    };
  }

  function enrichUserMessageForDisplay(msg) {
    if (!msg || msg.role !== 'user') return msg;
    const cloned = { ...msg };
    let text = typeof cloned.content === 'string' ? cloned.content : '';
    const shellSplit = splitShellCommandFromContent(text, cloned.shellCommand);
    if (shellSplit.shellCommand) {
      cloned.shellCommand = shellSplit.shellCommand;
      text = shellSplit.content;
      cloned.content = text;
    }
    const planSplit = splitPlanCommandFromContent(text, cloned.planCommand);
    if (planSplit.planCommand) {
      cloned.planCommand = planSplit.planCommand;
      text = planSplit.content;
      cloned.content = text;
    }
    const openSplit = splitOpenCommandFromContent(text, cloned.openCommand);
    if (openSplit.openCommand) {
      cloned.openCommand = openSplit.openCommand;
      text = openSplit.content;
      cloned.content = text;
    }
    const skills = Array.isArray(cloned.skills) && cloned.skills.length
      ? cloned.skills.slice()
      : parseSkillRefsFromContent(text);
    const referencePaths = (Array.isArray(cloned.referencePaths) && cloned.referencePaths.length
      ? cloned.referencePaths.slice()
      : extractReferencePathsFromContent(text)
    ).filter((p) =>  !isSlashCommandLine(String(p || '').trim()));
    cloned.content = stripRefsFromDisplayContent(text, skills, referencePaths);
    if (skills.length > 0) cloned.skills = skills;
    else delete cloned.skills;
    if (referencePaths.length > 0) cloned.referencePaths = referencePaths;
    else delete cloned.referencePaths;
    return cloned;
  }

  function separateToolTraces(serverMsgs) {
    const msgs = [];
    const traces = {};
    for (let i = 0; i < serverMsgs.length; i++) {
      const m = serverMsgs[i];
      if (m.role === 'tool_trace' && m.parentId) {
        if (!traces[m.parentId]) traces[m.parentId] = [];
        const traceRow = {
          toolName: m.toolName || '',
          detail: m.detail || '',
          status: m.status || 'pending',
          toolCallId: m.toolCallId || '',
        };
        if (typeof m.diffSource === 'string' && m.diffSource) {
          traceRow.diffSource = m.diffSource;
        }
        if (typeof m.iteration === 'number' && isFinite(m.iteration) && m.iteration > 0) {
          traceRow.iteration = Math.floor(m.iteration);
        }
        traces[m.parentId].push(traceRow);
      } else {
        let cloned = { ...m };
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
    return { msgs, traces };
  }

  function snapshotTraceTotals(tr) {
    const keys = Object.keys(tr || {}).sort();
    if (!keys.length) return '';
    return keys.map((k) => { return `${k}=${tr[k].length}`; }).join(';');
  }

  function sessionPayloadSig(separated) {
    const ids = separated.msgs.map((m) =>  m.id || '').join(',');
    const usage = [];
    let i;
    for (i = 0; i < separated.msgs.length; i++) {
      const m = separated.msgs[i];
      if (!m || (m.role !== 'agent' && m.role !== 'assistant')) continue;
      const tok = m.turnTokenUsage && typeof m.turnTokenUsage === 'object' ? m.turnTokenUsage : {};
      const input = typeof tok.inputTokens === 'number' ? tok.inputTokens : 0;
      const output = typeof tok.outputTokens === 'number' ? tok.outputTokens : 0;
      const model = typeof m.usedModel === 'string' ? m.usedModel : '';
      usage.push((m.id || '') + ':' + input + ':' + output + ':' + model);
    }
    return `${separated.msgs.length}|${ids}|${snapshotTraceTotals(separated.traces)}|${usage.join(';')}`;
  }

  function hasUserMessageId(id) {
    if (!id) return false;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].id === id) return true;
    }
    return false;
  }

  function userContentKey(msg) {
    return String(msg && msg.content ? msg.content : '').replace(/\s+/g, ' ').trim();
  }

  function findOptimisticUserDuplicate(incoming) {
    const key = userContentKey(incoming);
    if (!key) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'agent' && m._streaming) continue;
      if (m.role !== 'user') return null;
      if (m.id && incoming.id && m.id === incoming.id) return m;
      if (m._pendingServerAck && userContentKey(m) === key) return m;
      return null;
    }
    return null;
  }

  /**
   * 多端同步：在 processing / 流式期间插入远端用户消息（插在当前轮 assistant 流式气泡之前）。
   * @returns {'existing'|'adopted'|'inserted'|''}
   */
  function insertRemoteUserMessage(msg) {
    if (!msg || msg.role !== 'user') return '';
    if (hasUserMessageId(msg.id)) {
      patchUserMessageDisplay(msg.id, msg);
      patchUserMessageImages(msg.id, msg.images || []);
      let same = null;
      for (let si = 0; si < messages.length; si++) {
        if (messages[si].id === msg.id) { same = messages[si]; break; }
      }
      if (same) delete same._pendingServerAck;
      return 'existing';
    }
    const optimistic = findOptimisticUserDuplicate(msg);
    if (optimistic) {
      optimistic._prevId = optimistic.id;
      if (msg.id) optimistic.id = msg.id;
      delete optimistic._pendingServerAck;
      patchUserMessageDisplay(optimistic.id, msg);
      patchUserMessageImages(optimistic.id, msg.images || []);
      return 'adopted';
    }
    stampMessageTimestamps(msg);
    msg = enrichUserMessageForDisplay(msg);
    let insertAt = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent' && messages[i]._streaming) {
        insertAt = i;
        break;
      }
    }
    messages.splice(insertAt, 0, msg);
    reindexMessages();
    return 'inserted';
  }

  function patchUserMessageImages(id, images) {
    if (!id) return false;
    const persistable = filterPersistableImageUrls(images);
    if (persistable.length === 0) return false;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].id !== id) continue;
      messages[i].images = persistable.slice();
      return true;
    }
    return false;
  }

  /** 用服务端用户消息补丁本地条目（含 shellCommand / 正文拆分），返回是否有字段变化。 */
  function patchUserMessageDisplay(id, incoming) {
    if (!id || !incoming) return false;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].id !== id) continue;
      const cur = messages[i];
      const enriched = enrichUserMessageForDisplay(incoming);
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
      if (!enriched.planCommand && cur.planCommand) {
        enriched.planCommand = cur.planCommand;
      }
      if (!enriched.openCommand && cur.openCommand) {
        enriched.openCommand = cur.openCommand;
      }
      let changed = false;
      if (String(cur.content || '') !== String(enriched.content || '')) {
        cur.content = enriched.content || '';
        changed = true;
      }
      if ((cur.shellCommand || '') !== (enriched.shellCommand || '')) {
        if (enriched.shellCommand) cur.shellCommand = enriched.shellCommand;
        else delete cur.shellCommand;
        changed = true;
      }
      if ((cur.planCommand || '') !== (enriched.planCommand || '')) {
        if (enriched.planCommand) cur.planCommand = enriched.planCommand;
        else delete cur.planCommand;
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
      const persistable = filterPersistableImageUrls(enriched.images || incoming.images);
      if (persistable.length > 0) {
        cur.images = persistable.slice();
        changed = true;
      }
      return changed;
    }
    return false;
  }

  function mergeUserMessagesFromServer(serverMsgs) {
    if (!serverMsgs || !serverMsgs.length) return false;
    let added = false;
    for (let i = 0; i < serverMsgs.length; i++) {
      const m = serverMsgs[i];
      if (m.role === 'user' && insertRemoteUserMessage(m) === 'inserted') added = true;
    }
    return added;
  }

  function fetchAndMergeRemoteUserMessages(done) {
    fetchServerMessages((serverMsgs) => {
      const raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      const separated = separateToolTraces(raw);
      const added = mergeUserMessagesFromServer(separated.msgs);
      if (done) done(added);
    });
  }

  /** 服务端快照缺 referencePaths/skills 时，保留本地已展示的用户消息元数据（如 @ 文件 chip）。 */
  function mergeLocalUserDisplayFields(serverMsgs, localMsgs) {
    if (!localMsgs || !localMsgs.length || !serverMsgs || !serverMsgs.length) return;
    const localById = {};
    let i;
    for (i = 0; i < localMsgs.length; i++) {
      const lm = localMsgs[i];
      if (lm && lm.role === 'user' && lm.id) localById[lm.id] = lm;
    }
    for (i = 0; i < serverMsgs.length; i++) {
      const sm = serverMsgs[i];
      if (!sm || sm.role !== 'user' || !sm.id) continue;
      const local = localById[sm.id];
      if (!local) continue;
      const merged = { ...sm };
      let patched = false;
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
      if (!merged.planCommand && local.planCommand) {
        merged.planCommand = local.planCommand;
        patched = true;
      }
      if (!merged.openCommand && local.openCommand) {
        merged.openCommand = local.openCommand;
        patched = true;
      }
      if (patched) serverMsgs[i] = enrichUserMessageForDisplay(merged);
    }
  }

  function copyLocalAgentUsage(from, to) {
    if (!from || !to) return false;
    let patched = false;
    if (!to.usedModel && typeof from.usedModel === 'string' && from.usedModel.trim()) {
      to.usedModel = from.usedModel.trim();
      patched = true;
    }
    if (!to.turnTokenUsage && from.turnTokenUsage && typeof from.turnTokenUsage === 'object') {
      to.turnTokenUsage = {
        inputTokens: from.turnTokenUsage.inputTokens || 0,
        outputTokens: from.turnTokenUsage.outputTokens || 0,
      };
      patched = true;
    }
    return patched;
  }

  /** 服务端快照缺 usedModel / turnTokenUsage 时，保留本地已展示的气泡用量。 */
  function mergeLocalAgentUsageFields(serverMsgs, localMsgs) {
    if (!localMsgs || !localMsgs.length || !serverMsgs || !serverMsgs.length) return;
    const localById = {};
    let lastLocalAgent = null;
    let lastServerAgentIdx = -1;
    let i;
    for (i = 0; i < localMsgs.length; i++) {
      const lm = localMsgs[i];
      if (!lm || (lm.role !== 'agent' && lm.role !== 'assistant')) continue;
      if (lm.id) localById[lm.id] = lm;
      lastLocalAgent = lm;
    }
    for (i = 0; i < serverMsgs.length; i++) {
      const sm = serverMsgs[i];
      if (!sm || (sm.role !== 'agent' && sm.role !== 'assistant')) continue;
      lastServerAgentIdx = i;
      if (sm.id && localById[sm.id]) copyLocalAgentUsage(localById[sm.id], sm);
    }
    if (lastServerAgentIdx < 0 || !lastLocalAgent) return;
    const lastServer = serverMsgs[lastServerAgentIdx];
    if (lastLocalAgent.id && lastServer.id && lastLocalAgent.id !== lastServer.id) return;
    copyLocalAgentUsage(lastLocalAgent, lastServer);
  }

  function applyServerChatSnapshot(separated, options, isStreaming, wsProcessing) {
    const opts = options || {};
    if (hasStreamingModelBubble() || wsProcessing || isStreaming) return false;
    // 非权威快照不得用较短历史覆盖本地待同步消息；权威空快照代表会话确实为空。
    if (!opts.authoritative && separated.msgs.length < messages.length) return false;

    const sig = sessionPayloadSig(separated);
    if (sig === lastSessionSyncSig && separated.msgs.length === messages.length) {
      return false;
    }

    mergeLocalUserDisplayFields(separated.msgs, messages);
    mergeLocalAgentUsageFields(separated.msgs, messages);
    messages = separated.msgs;
    toolTraces = separated.traces;
    reindexMessages();
    lastSessionSyncSig = sig;
    return true;
  }

  function initSession() {
    SESSION_ID = readInitialSessionId();
    messages = loadLocalMessages();
    for (let i = 0; i < messages.length; i++) {
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
    for (let i = 0; i < messages.length; i++) {
      messages[i]._msgIndex = i;
    }
  }

  function appendMessage(msg) {
    stampMessageTimestamps(msg);
    if (msg && msg.role === 'user') {
      const enriched = enrichUserMessageForDisplay(msg);
      msg.content = enriched.content;
      if (enriched.shellCommand) msg.shellCommand = enriched.shellCommand;
      else delete msg.shellCommand;
      if (enriched.planCommand) msg.planCommand = enriched.planCommand;
      else delete msg.planCommand;
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
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
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
    const last = messages[messages.length - 1];
    if (last) last.content = content;
  }

  function markLastMessageStreaming(streaming) {
    const last = messages[messages.length - 1];
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
    for (let i = currentToolBatch.length - 1; i >= 0; i--) {
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
  }

  function getActiveId() { return SESSION_ID; }

  return {
    initSession,
    saveMessages,
    loadLocalMessages,
    fetchServerMessages,
    fetchStructuredMessages,
    getStructuredMessages,
    invalidateStructuredCache,
    separateToolTraces,
    applyServerChatSnapshot,
    flushToolBatchLocal,
    appendMessage,
    removeMessageById,
    stampMessageTimestamps,
    getMessages,
    getToolTraces,
    getLastMessage,
    updateLastMessageContent,
    markLastMessageStreaming,
    getCurrentToolBatch,
    pushToolBatch,
    updateToolBatchStatus,
    loadLiveToolBatch,
    replaceLiveToolBatch,
    clearLiveToolBatch,
    saveLiveToolBatch,
    hasStreamingModelBubble,
    insertRemoteUserMessage,
    patchUserMessageImages,
    patchUserMessageDisplay,
    prepareUserMessageForDisplay: enrichUserMessageForDisplay,
    getMessageById(id) {
      if (!id) return null;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].id === id) return messages[i];
      }
      return null;
    },
    hasUserMessageId,
    mergeUserMessagesFromServer,
    fetchAndMergeRemoteUserMessages,
    stripStatusTag,
    setSessionId,
    getActiveId,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatSession = ChatSession;
}
