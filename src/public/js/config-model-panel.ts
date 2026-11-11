// @ts-nocheck
import { t } from './i18n.ts';
/**
 * 配置页 — 模型配置面板（左列表 + 右详情）。
 */

/* exported ModelConfigPanel */

export const ModelConfigPanel = (() => {

  let providers = [];
  let container = null;
  let nextId = 1;
  let defaultIndex = 0;
  let selectedIndex = 0;
  let mobileExpanded = false;
  let autoSaveDefaultTimer = null;

  function isMobile() {
    return window.innerWidth <= 720;
  }

  function isListItemActive(idx) {
    if (isMobile()) return mobileExpanded && idx === selectedIndex;
    return idx === selectedIndex;
  }

  function getDetailElForIndex(index) {
    if (isMobile()) {
      const inlineItems = container.querySelectorAll('.config-list-item-detail');
      for (let i = 0; i < inlineItems.length; i++) {
        if (parseInt(inlineItems[i].getAttribute('data-index'), 10) === index) {
          return inlineItems[i];
        }
      }
      return null;
    }
    if (index === selectedIndex) {
      return container.querySelector('#model-detail');
    }
    return null;
  }

  function getActiveDetailEl() {
    return getDetailElForIndex(selectedIndex);
  }

  function collapseMobile() {
    if (!isMobile() || !mobileExpanded) return;
    syncFormToProvider(selectedIndex);
    mobileExpanded = false;
    renderAll();
  }

  function handleListItemClick(idx) {
    if (!isMobile()) {
      if (idx !== selectedIndex) {
        syncFormToProvider(selectedIndex);
        selectedIndex = idx;
        renderAll();
      }
      return;
    }
    if (mobileExpanded && idx === selectedIndex) {
      syncFormToProvider(selectedIndex);
      mobileExpanded = false;
      renderAll();
      return;
    }
    if (idx !== selectedIndex) {
      syncFormToProvider(selectedIndex);
    }
    selectedIndex = idx;
    mobileExpanded = true;
    renderAll();
  }

  const CARD_THEMES = [
    'theme-0', 'theme-1', 'theme-2', 'theme-3', 'theme-4',
    'theme-5', 'theme-6', 'theme-7', 'theme-8', 'theme-9'
  ];

  function pickTheme(index) {
    return CARD_THEMES[((index % CARD_THEMES.length) + CARD_THEMES.length) % CARD_THEMES.length];
  }

  function providerDisplayName(prov) {
    if (!prov) return t('model.newProvider');
    if (window.ModelNames && typeof window.ModelNames.providerDisplayLabel === 'function') {
      const label = window.ModelNames.providerDisplayLabel(prov);
      if (!label || label === '未设置模型' || label === t('model.unset')) return t('model.unset');
      return label;
    }
    const name = (prov.modelName || '').trim();
    return name || t('model.unset');
  }

  function defaultDotHtml() {
    const label = escapeAttr(t('model.defaultDot'));
    return '<span class="config-status-dot dot-green" title="' + label + '" aria-label="' + label + '"></span>';
  }

  function parseModelNames(modelName) {
    if (window.ModelNames && typeof window.ModelNames.parseModelNames === 'function') {
      return window.ModelNames.parseModelNames(modelName);
    }
    return (modelName || '').split(',').map((s) =>  s.trim()).filter(Boolean);
  }

  function providerSubtitle(prov) {
    if (!prov || !prov.apiUrl) return t('model.noUrl');
    try {
      return new URL(prov.apiUrl).host;
    } catch (_e) {
      return prov.apiUrl;
    }
  }

  function hasEnvApiKey(prov) {
    return !!(prov && prov.apiKeySource === 'env');
  }

  function isProviderEnabled(prov) {
    if (!prov || !prov.apiUrl || parseModelNames(prov.modelName).length === 0) return false;
    if (hasEnvApiKey(prov)) return true;
    return !!(prov.apiKey && !/your-api-key/i.test(prov.apiKey));
  }

  function notifyModelConfigChanged() {
    if (window.ChatPage && typeof window.ChatPage.reloadModelConfig === 'function') {
      window.ChatPage.reloadModelConfig();
      return;
    }
    if (window.ChatModelPicker && typeof window.ChatModelPicker.refreshFromServer === 'function') {
      window.ChatModelPicker.refreshFromServer();
    }
  }

  function tryAutoSaveDefault() {
    if (autoSaveDefaultTimer) clearTimeout(autoSaveDefaultTimer);
    autoSaveDefaultTimer = setTimeout(() => {
      autoSaveDefaultTimer = null;
      const data = collectFormData();
      for (let i = 0; i < data.length; i++) {
        if (Object.keys(validateProvider(data[i], providers[i])).length > 0) return;
      }
      saveConfig(data, (err) => {
        if (err) {
          Notification.error(t('model.defaultSaveFailed', { message: err.message }));
          return;
        }
        loadConfig((_err, loaded) => {
          if (!_err) {
            providers = loaded.map((p) => { p._masked = true; return p; });
            defaultIndex = 0;
            for (let j = 0; j < providers.length; j++) {
              if (providers[j].isDefault) {
                defaultIndex = j;
                break;
              }
            }
            renderAll();
          }
        });
        if (window.AppRouter && window.AppRouter.refreshStatus) {
          window.AppRouter.refreshStatus();
        }
        notifyModelConfigChanged();
      });
    }, 320);
  }

  function generateId() {
    return 'provider-' + Date.now() + '-' + (nextId++);
  }

  function loadConfig(callback) {
    fetch('/api/config')
      .then((res) =>  res.json())
      .then((data) => {
        callback(null, data.providers || [], data);
      })
      .catch((err) => {
        callback(err, [], null);
      });
  }

  function saveConfig(providerList, callback) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: providerList })
    })
      .then((res) => { return res.json().then((body) =>  ({ ok: res.ok, body })); })
      .then((result) => {
        if (!result.ok || result.body.error) {
          callback(new Error(result.body.error || t('common.saveFailed')));
        } else {
          callback(null, result.body);
        }
      })
      .catch((err) => {
        callback(err);
      });
  }

  function resolveApiMode(prov) {
    if (!prov) return '';
    if (prov.apiMode) return String(prov.apiMode).trim();
    if (prov.parameters && prov.parameters.apiMode) {
      return String(prov.parameters.apiMode).trim();
    }
    return '';
  }

  function normalizeApiModeInput(value) {
    return String(value || '').trim();
  }

  function validateProvider(prov, original) {
    const errors = {};
    const keySource = original || prov;
    if (!prov.apiUrl || prov.apiUrl.trim() === '') {
      errors.apiUrl = t('model.urlRequired');
    }
    // 密钥来自环境变量时允许留空
    if (hasEnvApiKey(keySource)) {
      // 不校验 apiKey
    } else if (!prov.apiKey || prov.apiKey.trim() === '') {
      errors.apiKey = t('model.keyRequired');
    } else if (/your-api-key/i.test(prov.apiKey)) {
      errors.apiKey = t('model.keyInvalid');
    }
    if (parseModelNames(prov.modelName).length === 0) {
      errors.modelName = t('model.nameRequired');
    }
    const apiMode = normalizeApiModeInput(prov.apiMode);
    if (apiMode && apiMode !== 'chat_completions' && apiMode !== 'responses' && apiMode !== 'anthropic_messages') {
      errors.apiMode = t('model.apiModeInvalid');
    }
    if (original && original._headersParseError) {
      errors.headers = original._headersParseError;
    }
    if (original && original._reasoningEffortParseError) {
      errors.reasoningEffort = original._reasoningEffortParseError;
    }
    return errors;
  }

  function formatProviderHeaders(headers) {
    if (!headers || typeof headers !== 'object') return '';
    return Object.keys(headers).map((key) => {
      return `${key}: ${String(headers[key])}`;
    }).join('\n');
  }

  function parseProviderHeadersText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = {};
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      const colon = line.indexOf(':');
      if (colon <= 0) {
        return { error: t('model.headerFormat') };
      }
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (!name) return { error: t('model.headerNameRequired') };
      out[name] = value;
    }
    return { headers: Object.keys(out).length ? out : undefined };
  }

  const REASONING_EFFORT_TOKEN_RE = /^[a-z][\w.-]{0,31}$/i;

  function parseReasoningEffortInput(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { stored: undefined };
    const seen = {};
    const out = [];
    const parts = trimmed.split(',');
    for (let i = 0; i < parts.length; i++) {
      const token = parts[i].trim().toLowerCase();
      if (!token) continue;
      if (!REASONING_EFFORT_TOKEN_RE.test(token)) {
        return { error: t('model.effortInvalid', { value: parts[i].trim() }) };
      }
      if (seen[token]) continue;
      seen[token] = true;
      out.push(token);
    }
    return { stored: out.length ? out.join(',') : undefined };
  }

  function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function showFieldError(detailEl, fieldName, message) {
    const input = detailEl.querySelector(`[data-field="${fieldName}"]`);
    if (!input) return;
    input.classList.add('error');
    const errEl = detailEl.querySelector(`[data-error="${fieldName}"]`);
    if (errEl) errEl.textContent = message;
  }

  function clearFieldErrors(detailEl) {
    const inputs = detailEl.querySelectorAll('input.error, textarea.error');
    for (let i = 0; i < inputs.length; i++) {
      inputs[i].classList.remove('error');
    }
    const errEls = detailEl.querySelectorAll('.error-msg');
    for (let j = 0; j < errEls.length; j++) {
      errEls[j].textContent = '';
    }
  }

  function syncFormToProvider(index) {
    const detailEl = getDetailElForIndex(index);
    if (!detailEl || !providers[index]) return;
    const prov = providers[index];
    const apiUrl = detailEl.querySelector('[data-field="apiUrl"]');
    const apiKey = detailEl.querySelector('[data-field="apiKey"]');
    const modelName = detailEl.querySelector('[data-field="modelName"]');
    const temperature = detailEl.querySelector('[data-field="temperature"]');
    const maxContext = detailEl.querySelector('[data-field="maxContextTokens"]');
    const apiMode = detailEl.querySelector('[data-field="apiMode"]');
    const headersEl = detailEl.querySelector('[data-field="headers"]');
    const reasoningEffortEl = detailEl.querySelector('[data-field="reasoningEffort"]');
    if (apiUrl) prov.apiUrl = apiUrl.value.trim();
    if (apiKey) {
      prov.apiKey = apiKey.value;
      // 用户手动输入非空、非脱敏值 → 视为来自配置，覆盖 env 来源标记
      if (apiKey.value && apiKey.value.trim() !== '' && !apiKey.value.includes('*')) {
        prov.apiKeySource = 'config';
      }
    }
    if (modelName) prov.modelName = modelName.value.trim();
    if (temperature) {
      prov.parameters = prov.parameters || {};
      prov.parameters.temperature = parseFloat(temperature.value);
    }
    if (maxContext) {
      const n = parseInt(maxContext.value, 10);
      prov.maxContextTokens = isNaN(n) ? undefined : n;
    }
    if (apiMode) {
      const mode = normalizeApiModeInput(apiMode.value);
      if (!mode || mode === 'chat_completions') {
        delete prov.apiMode;
        if (prov.parameters) delete prov.parameters.apiMode;
      } else {
        prov.apiMode = mode;
        if (prov.parameters) delete prov.parameters.apiMode;
      }
    }
    if (headersEl) {
      const parsedHeaders = parseProviderHeadersText(headersEl.value);
      if (parsedHeaders.error) {
        prov._headersParseError = parsedHeaders.error;
      } else {
        delete prov._headersParseError;
        if (parsedHeaders.headers) prov.headers = parsedHeaders.headers;
        else delete prov.headers;
      }
    }
    if (reasoningEffortEl) {
      const parsedEffort = parseReasoningEffortInput(reasoningEffortEl.value);
      if (parsedEffort.error) {
        prov._reasoningEffortParseError = parsedEffort.error;
      } else {
        delete prov._reasoningEffortParseError;
        if (parsedEffort.stored) prov.reasoningEffort = parsedEffort.stored;
        else delete prov.reasoningEffort;
      }
    }
  }

  function renderList() {
    const listEl = container.querySelector('#model-provider-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (let i = 0; i < providers.length; i++) {
      ((idx) => {
        const prov = providers[idx];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'config-list-item' + (isListItemActive(idx) ? ' is-active' : '');
        const isDefaultItem = idx === defaultIndex;
        btn.innerHTML =
          '<div class="config-list-item-head">' +
            '<span class="config-list-item-name">' + escapeHtml(providerDisplayName(prov)) + '</span>' +
            (isDefaultItem ? defaultDotHtml() : '') +
          '</div>' +
          '<div class="config-list-item-sub">' + escapeHtml(providerSubtitle(prov)) + '</div>';
        btn.addEventListener('click', (e) => {
          if (e.target.closest('.config-list-item-detail')) return;
          e.stopPropagation();
          handleListItemClick(idx);
        });
        if (isMobile() && mobileExpanded && idx === selectedIndex) {
          btn.classList.add('is-expanded');
          const detailDiv = document.createElement('div');
          detailDiv.className = 'config-list-item-detail';
          detailDiv.setAttribute('data-index', String(idx));
          detailDiv.innerHTML = buildModelDetailHtml(idx);
          btn.appendChild(detailDiv);
          bindModelDetailEvents(detailDiv, idx);
        }
        listEl.appendChild(btn);
      })(i);
    }
  }

  function buildModelDetailHtml(index) {
    if (index >= providers.length) index = providers.length - 1;
    const prov = providers[index];
    const isDefault = index === defaultIndex;
    const displayName = providerDisplayName(prov);

    return (
      '<div class="config-detail-header">' +
        '<div class="config-detail-title-row">' +
          '<h2 class="config-detail-title">' + escapeHtml(displayName) + '</h2>' +
          (isDefault ? defaultDotHtml() : '') +
        '</div>' +
        '<div class="config-detail-actions">' +
          '<button type="button" class="skills-btn skills-btn-danger" id="model-btn-delete">' + t('common.delete') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="form-grid model-detail-form">' +
        '<div class="form-group full-width">' +
          '<label for="model-apiUrl-' + index + '">' + t('model.apiUrl') + '</label>' +
          '<input type="url" id="model-apiUrl-' + index + '" data-field="apiUrl" placeholder="https://api.openai.com/v1" value="' + escapeAttr(prov.apiUrl || '') + '">' +
          '<span class="error-msg" data-error="apiUrl"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-apiKey-' + index + '">' + t('model.apiKey') + '</label>' +
          '<input type="password" id="model-apiKey-' + index + '" data-field="apiKey" placeholder="' + (hasEnvApiKey(prov) ? t('model.keyFromEnv') : 'sk-...') + '" value="' + escapeAttr(prov.apiKey || '') + '">' +
          (hasEnvApiKey(prov)
            ? '<span class="field-hint">' + t('model.keyEnvHint', { name: escapeHtml(prov.apiKeyEnvVar || '') }) + '</span>'
            : '') +
          '<span class="error-msg" data-error="apiKey"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-modelName-' + index + '">' + t('model.name') + '</label>' +
          '<input type="text" id="model-modelName-' + index + '" data-field="modelName" placeholder="' + t('model.namePlaceholder') + '" value="' + escapeAttr(prov.modelName || '') + '">' +
          '<span class="field-hint">' + t('model.nameHint') + '</span>' +
          '<span class="error-msg" data-error="modelName"></span>' +
        '</div>' +
        '<div class="form-group full-width">' +
          '<label for="model-reasoningEffort-' + index + '">' + t('model.effort') + '</label>' +
          '<input type="text" id="model-reasoningEffort-' + index + '" data-field="reasoningEffort" placeholder="low,high,max" value="' + escapeAttr(prov.reasoningEffort || '') + '">' +
          '<span class="field-hint">' + t('model.effortHint') + '</span>' +
          '<span class="error-msg" data-error="reasoningEffort"></span>' +
        '</div>' +
        '<div class="form-group full-width">' +
          '<label for="model-apiMode-' + index + '">' + t('model.apiMode') + '</label>' +
          '<input type="text" id="model-apiMode-' + index + '" data-field="apiMode" placeholder="chat_completions" value="' + escapeAttr(resolveApiMode(prov) === 'chat_completions' ? '' : resolveApiMode(prov)) + '">' +
          '<span class="field-hint">' + t('model.apiModeHint') + '</span>' +
          '<span class="error-msg" data-error="apiMode"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-temperature-' + index + '">' + t('model.temperature') + '</label>' +
          '<div class="slider-group">' +
            '<input type="range" id="model-temperature-' + index + '" data-field="temperature" min="0" max="2" step="0.1" value="' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '">' +
            '<span class="slider-value" data-value="temperature">' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-maxContextTokens-' + index + '">' + t('model.context') + '</label>' +
          '<input type="number" id="model-maxContextTokens-' + index + '" data-field="maxContextTokens" placeholder="' + t('model.contextPlaceholder') + '" min="1" value="' + (prov.maxContextTokens != null ? prov.maxContextTokens : '') + '">' +
        '</div>' +
        '<div class="form-group full-width">' +
          '<label for="model-headers-' + index + '">' + t('model.headers') + '</label>' +
          '<textarea id="model-headers-' + index + '" data-field="headers" rows="3" placeholder="x-opencode-session: {{sessionId}}">' +
            escapeHtml(formatProviderHeaders(prov.headers)) +
          '</textarea>' +
          '<span class="field-hint">' + t('model.headersHint') + '</span>' +
          '<span class="error-msg" data-error="headers"></span>' +
        '</div>' +
      '</div>' +
      '<div class="config-detail-toolbar">' +
        '<label class="config-default-switch" title="' + t('model.setDefault') + '">' +
          '<input type="checkbox" data-action="set-default" ' + (isDefault ? 'checked disabled' : '') + '>' +
          '<span class="config-default-switch-track" aria-hidden="true"></span>' +
          '<span class="config-default-switch-text">' +
            '<span class="config-default-switch-label">' + t('model.defaultModel') + '</span>' +
            '<span class="config-default-switch-hint">' + t('model.prefer') + '</span>' +
          '</span>' +
        '</label>' +
        '<button type="button" class="skills-btn skills-btn-primary" id="model-btn-save">' + t('model.save') + '</button>' +
      '</div>'
    );
  }

  function bindModelDetailEvents(detailEl, index) {
    const slider = detailEl.querySelector('[data-field="temperature"]');
    const sliderVal = detailEl.querySelector('[data-value="temperature"]');
    if (slider && sliderVal) {
      slider.addEventListener('input', () => {
        sliderVal.textContent = slider.value;
      });
    }

    const defaultToggle = detailEl.querySelector('[data-action="set-default"]');
    if (defaultToggle) {
      defaultToggle.addEventListener('change', () => {
        if (!defaultToggle.checked) {
          defaultToggle.checked = true;
          return;
        }
        defaultIndex = index;
        renderAll();
        tryAutoSaveDefault();
      });
    }

    const deleteBtn = detailEl.querySelector('#model-btn-delete');
    if (deleteBtn) deleteBtn.addEventListener('click', handleDelete);

    const saveBtn = detailEl.querySelector('#model-btn-save');
    if (saveBtn) saveBtn.addEventListener('click', handleSave);
  }

  function renderDetail() {
    const detailEl = container.querySelector('#model-detail');
    if (!detailEl) return;

    if (isMobile()) {
      detailEl.innerHTML = '';
      return;
    }

    if (!providers.length) {
      detailEl.innerHTML = '<div class="config-detail-placeholder">' + t('model.addHint') + '</div>';
      return;
    }

    if (selectedIndex >= providers.length) selectedIndex = providers.length - 1;
    detailEl.innerHTML = buildModelDetailHtml(selectedIndex);
    bindModelDetailEvents(detailEl, selectedIndex);
  }

  function renderAll() {
    renderList();
    renderDetail();
  }

  function buildProviderPayload(sourceProviders) {
    const result = [];
    for (let i = 0; i < sourceProviders.length; i++) {
      const original = sourceProviders[i] || {};
      const params = { ...(original.parameters || {}), ...{
          temperature: original.parameters && original.parameters.temperature != null
            ? original.parameters.temperature : 1
        } };
      delete params.apiMode;
      const apiMode = normalizeApiModeInput(resolveApiMode(original));
      result.push({
        id: original.id || generateId(),
        apiUrl: original.apiUrl || '',
        apiKey: original.apiKey || '',
        modelName: original.modelName || '',
        activeModelName: original.activeModelName,
        parameters: params,
        isDefault: i === defaultIndex,
        supportsVision: original.supportsVision !== undefined ? original.supportsVision : true,
        maxContextTokens: original.maxContextTokens,
        requestTimeoutMs: original.requestTimeoutMs,
        ...(original.headers && Object.keys(original.headers).length > 0
          ? { headers: original.headers }
          : {}),
        ...(original.reasoningEffort ? { reasoningEffort: original.reasoningEffort } : {}),
        ...(apiMode && apiMode !== 'chat_completions' ? { apiMode } : {}),
        apiKeySource: original.apiKeySource,
        apiKeyEnvVar: original.apiKeyEnvVar
      });
    }
    return result;
  }

  function collectFormData() {
    syncFormToProvider(selectedIndex);
    return buildProviderPayload(providers);
  }

  function reloadProvidersFromServer(callback) {
    loadConfig((_err, loaded) => {
      if (!_err) {
        providers = loaded.map((p) => { p._masked = true; return p; });
        defaultIndex = 0;
        for (let j = 0; j < providers.length; j++) {
          if (providers[j].isDefault) {
            defaultIndex = j;
            break;
          }
        }
        if (providers.length === 0) {
          providers.push({
            id: generateId(),
            apiUrl: '',
            apiKey: '',
            modelName: '',
            parameters: { temperature: 1 },
            supportsVision: true
          });
        }
        selectedIndex = defaultIndex;
        renderAll();
      }
      if (callback) callback(_err);
    });
  }

  function adjustIndicesAfterRemoval(removedIndex, removedWasDefault) {
    if (providers.length === 0) {
      defaultIndex = 0;
      selectedIndex = 0;
      return;
    }
    if (removedWasDefault) {
      defaultIndex = 0;
    } else if (defaultIndex > removedIndex) {
      defaultIndex--;
    }
    selectedIndex = Math.min(removedIndex, providers.length - 1);
  }

  function handleDelete() {
    const deleteIndex = selectedIndex;
    const target = providers[deleteIndex];
    if (!target) return;
    const deleteId = target.id;
    const deleteName = providerDisplayName(target);
    window.Modal.confirm({
      title: t('model.removeTitle'),
      message: t('model.removeBody', { name: deleteName }),
      type: 'danger',
      confirmText: t('model.remove'),
      cancelText: t('common.cancel'),
      dangerConfirm: true,
    }).then((confirmed) => {
      if (!confirmed) return;

      syncFormToProvider(deleteIndex);

      const wasDefault = deleteIndex === defaultIndex;
      providers = providers.filter((p) =>  p.id !== deleteId);
      adjustIndicesAfterRemoval(deleteIndex, wasDefault);

      const data = buildProviderPayload(providers);
      for (let i = 0; i < data.length; i++) {
        if (Object.keys(validateProvider(data[i], providers[i])).length > 0) {
          Notification.error(t('model.removeBlocked'));
          reloadProvidersFromServer();
          return;
        }
      }

      renderAll();

      saveConfig(data, (err, result) => {
        if (err) {
          Notification.error(t('model.deleteFailed', { message: err.message }));
          reloadProvidersFromServer();
          return;
        }
        Notification.success(t('model.removed', { name: deleteName }));
        if (result && result.setupComplete && window.AppRouter && window.AppRouter.clearSetupMode) {
          window.AppRouter.clearSetupMode();
        }
        reloadProvidersFromServer();
        if (window.AppRouter && window.AppRouter.refreshStatus) {
          window.AppRouter.refreshStatus();
        }
        notifyModelConfigChanged();
      });
    });
  }

  function handleSave() {
    const data = collectFormData();
    const detailEl = getActiveDetailEl();
    clearFieldErrors(detailEl);
    const errors = validateProvider(data[selectedIndex], providers[selectedIndex]);
    const hasErrors = Object.keys(errors).length > 0;
    if (hasErrors) {
      for (const field in errors) {
        showFieldError(detailEl, field, errors[field]);
      }
      return;
    }

    for (let i = 0; i < data.length; i++) {
      if (i !== selectedIndex && Object.keys(validateProvider(data[i], providers[i])).length > 0) {
        Notification.error(t('model.incomplete', { n: i + 1 }));
        return;
      }
    }

    saveConfig(data, (err, result) => {
      if (err) {
        Notification.error(t('model.saveFailedDetail', { message: err.message }));
      } else {
        Notification.success(t('model.saved'));
        if (result && result.setupComplete && window.AppRouter && window.AppRouter.clearSetupMode) {
          window.AppRouter.clearSetupMode();
        }
        const banner = container && container.querySelector('#setup-banner');
        if (banner) banner.hidden = true;
        loadConfig((_err, loaded) => {
          if (!_err) {
            providers = loaded.map((p) => { p._masked = true; return p; });
            defaultIndex = 0;
            for (let j = 0; j < providers.length; j++) {
              if (providers[j].isDefault) {
                defaultIndex = j;
                break;
              }
            }
            renderAll();
          }
        });
        if (window.AppRouter && window.AppRouter.refreshStatus) {
          window.AppRouter.refreshStatus();
        }
        notifyModelConfigChanged();
      }
    });
  }

  function handleAddProvider() {
    syncFormToProvider(selectedIndex);
    providers.push({
      id: generateId(),
      apiUrl: '',
      apiKey: '',
      modelName: '',
      parameters: { temperature: 1 },
      supportsVision: true
    });
    selectedIndex = providers.length - 1;
    if (isMobile()) mobileExpanded = true;
    renderAll();
  }

  function render(parentEl, options) {
    container = parentEl;
    options = options || {};

    parentEl.innerHTML =
      '<div class="config-panel-inner">' +
        (options.showSetupBanner ? (
          '<div class="setup-banner" id="setup-banner" hidden>' +
            t('model.firstRun') +
          '</div>'
        ) : '') +
        '<div class="config-split">' +
          '<aside class="config-list-panel">' +
            '<div class="config-list-panel-head">' +
              '<span class="config-list-panel-title">' + t('model.providers') + '</span>' +
              '<button type="button" class="chat-sidebar-new-btn" id="model-btn-add" title="' + t('model.addProvider') + '">' +
                '<span class="chat-sidebar-new-btn-icon" aria-hidden="true">+</span>' +
                '<span class="chat-sidebar-new-btn-label">' + t('common.add') + '</span>' +
              '</button>' +
            '</div>' +
            '<div class="config-list" id="model-provider-list"></div>' +
          '</aside>' +
          '<section class="config-detail-panel" id="model-detail"></section>' +
        '</div>' +
      '</div>';

    parentEl.querySelector('#model-btn-add').addEventListener('click', handleAddProvider);

    loadConfig((err, loaded, meta) => {
      if (err) {
        Notification.error(t('model.loadFailed'));
        providers = [];
      } else {
        providers = loaded.map((p) => { p._masked = true; return p; });
        if (options.showSetupBanner && meta && meta.setupRequired) {
          const banner = parentEl.querySelector('#setup-banner');
          if (banner) banner.hidden = false;
        }
        defaultIndex = 0;
        for (let i = 0; i < providers.length; i++) {
          if (providers[i].isDefault) {
            defaultIndex = i;
            break;
          }
        }
      }
      if (providers.length === 0) {
        providers.push({
          id: generateId(),
          apiUrl: '',
          apiKey: '',
          modelName: '',
          parameters: { temperature: 1 },
          supportsVision: true
        });
      }
      selectedIndex = defaultIndex;
      mobileExpanded = !isMobile();
      renderAll();
    });
  }

  return { render, collapseMobile };
})();

if (typeof window !== 'undefined') {
  window.ModelConfigPanel = ModelConfigPanel;
}
