/**
 * 配置页 — 模型配置面板（左列表 + 右详情）。
 */

/* exported ModelConfigPanel */

window.ModelConfigPanel = (function () {
  'use strict';

  var providers = [];
  var container = null;
  var nextId = 1;
  var defaultIndex = 0;
  var selectedIndex = 0;
  var autoSaveDefaultTimer = null;

  var CARD_THEMES = [
    'theme-0', 'theme-1', 'theme-2', 'theme-3', 'theme-4',
    'theme-5', 'theme-6', 'theme-7', 'theme-8', 'theme-9'
  ];

  function pickTheme(index) {
    return CARD_THEMES[((index % CARD_THEMES.length) + CARD_THEMES.length) % CARD_THEMES.length];
  }

  function providerDisplayName(prov) {
    if (!prov) return '新提供者';
    var name = (prov.modelName || '').trim();
    return name || '未设置模型';
  }

  function providerSubtitle(prov) {
    if (!prov || !prov.apiUrl) return '未设置 API 地址';
    try {
      return new URL(prov.apiUrl).host;
    } catch (_e) {
      return prov.apiUrl;
    }
  }

  function isProviderEnabled(prov) {
    return !!(prov && prov.apiUrl && prov.apiKey && prov.modelName
      && !/your-api-key/i.test(prov.apiKey));
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
    autoSaveDefaultTimer = setTimeout(function () {
      autoSaveDefaultTimer = null;
      var data = collectFormData();
      for (var i = 0; i < data.length; i++) {
        if (Object.keys(validateProvider(data[i])).length > 0) return;
      }
      saveConfig(data, function (err) {
        if (err) {
          Notification.error('默认模型未能保存: ' + err.message);
          return;
        }
        loadConfig(function (_err, loaded) {
          if (!_err) {
            providers = loaded.map(function (p) { p._masked = true; return p; });
            defaultIndex = 0;
            for (var j = 0; j < providers.length; j++) {
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
      .then(function (res) { return res.json(); })
      .then(function (data) {
        callback(null, data.providers || [], data);
      })
      .catch(function (err) {
        callback(err, [], null);
      });
  }

  function saveConfig(providerList, callback) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: providerList })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || result.body.error) {
          callback(new Error(result.body.error || '保存失败'));
        } else {
          callback(null, result.body);
        }
      })
      .catch(function (err) {
        callback(err);
      });
  }

  function validateProvider(prov) {
    var errors = {};
    if (!prov.apiUrl || prov.apiUrl.trim() === '') {
      errors.apiUrl = '请填写 API 地址';
    }
    if (!prov.apiKey || prov.apiKey.trim() === '') {
      errors.apiKey = '请填写 API 密钥';
    } else if (/your-api-key/i.test(prov.apiKey)) {
      errors.apiKey = '请填写有效的 API 密钥';
    }
    if (!prov.modelName || prov.modelName.trim() === '') {
      errors.modelName = '请填写模型名称';
    }
    return errors;
  }

  function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function showFieldError(detailEl, fieldName, message) {
    var input = detailEl.querySelector('[data-field="' + fieldName + '"]');
    if (!input) return;
    input.classList.add('error');
    var errEl = detailEl.querySelector('[data-error="' + fieldName + '"]');
    if (errEl) errEl.textContent = message;
  }

  function clearFieldErrors(detailEl) {
    var inputs = detailEl.querySelectorAll('input.error');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].classList.remove('error');
    }
    var errEls = detailEl.querySelectorAll('.error-msg');
    for (var j = 0; j < errEls.length; j++) {
      errEls[j].textContent = '';
    }
  }

  function syncFormToProvider(index) {
    var detailEl = container.querySelector('#model-detail');
    if (!detailEl || !providers[index]) return;
    var prov = providers[index];
    var apiUrl = detailEl.querySelector('[data-field="apiUrl"]');
    var apiKey = detailEl.querySelector('[data-field="apiKey"]');
    var modelName = detailEl.querySelector('[data-field="modelName"]');
    var temperature = detailEl.querySelector('[data-field="temperature"]');
    var maxContext = detailEl.querySelector('[data-field="maxContextTokens"]');
    if (apiUrl) prov.apiUrl = apiUrl.value.trim();
    if (apiKey) prov.apiKey = apiKey.value;
    if (modelName) prov.modelName = modelName.value.trim();
    if (temperature) {
      prov.parameters = prov.parameters || {};
      prov.parameters.temperature = parseFloat(temperature.value);
    }
    if (maxContext) {
      var n = parseInt(maxContext.value, 10);
      prov.maxContextTokens = isNaN(n) ? undefined : n;
    }
  }

  function renderList() {
    var listEl = container.querySelector('#model-provider-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    for (var i = 0; i < providers.length; i++) {
      (function (idx) {
        var prov = providers[idx];
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'config-list-item' + (idx === selectedIndex ? ' is-active' : '');
        var isDefaultItem = idx === defaultIndex;
        btn.innerHTML =
          '<div class="config-list-item-head">' +
            '<span class="config-list-item-name">' + escapeHtml(providerDisplayName(prov)) + '</span>' +
            (isDefaultItem ? '<span class="config-badge is-default">默认</span>' : '') +
          '</div>' +
          '<div class="config-list-item-sub">' + escapeHtml(providerSubtitle(prov)) + '</div>';
        btn.addEventListener('click', function () {
          if (idx !== selectedIndex) {
            syncFormToProvider(selectedIndex);
            selectedIndex = idx;
            renderAll();
          }
        });
        listEl.appendChild(btn);
      })(i);
    }
  }

  function renderDetail() {
    var detailEl = container.querySelector('#model-detail');
    if (!detailEl) return;

    if (!providers.length) {
      detailEl.innerHTML = '<div class="config-detail-placeholder">点击左侧「+ 添加」创建模型提供者。</div>';
      return;
    }

    if (selectedIndex >= providers.length) selectedIndex = providers.length - 1;
    var prov = providers[selectedIndex];
    var index = selectedIndex;
    var isDefault = index === defaultIndex;
    var displayName = providerDisplayName(prov);

    detailEl.innerHTML =
      '<div class="config-detail-header">' +
        '<div class="config-detail-title-row">' +
          '<h2 class="config-detail-title">' + escapeHtml(displayName) + '</h2>' +
          (isDefault ? '<span class="config-badge is-default">默认</span>' : '') +
        '</div>' +
        '<div class="config-detail-actions">' +
          '<button type="button" class="skills-btn skills-btn-danger" id="model-btn-delete">删除</button>' +
        '</div>' +
      '</div>' +
      '<div class="form-grid model-detail-form">' +
        '<div class="form-group full-width">' +
          '<label for="model-apiUrl">API 地址</label>' +
          '<input type="url" id="model-apiUrl" data-field="apiUrl" placeholder="https://api.openai.com/v1" value="' + escapeAttr(prov.apiUrl || '') + '">' +
          '<span class="error-msg" data-error="apiUrl"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-apiKey">API 密钥</label>' +
          '<input type="password" id="model-apiKey" data-field="apiKey" placeholder="sk-..." value="' + escapeAttr(prov.apiKey || '') + '">' +
          '<span class="error-msg" data-error="apiKey"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-modelName">模型名称</label>' +
          '<input type="text" id="model-modelName" data-field="modelName" placeholder="例如 gpt-4o、deepseek-chat" value="' + escapeAttr(prov.modelName || '') + '">' +
          '<span class="error-msg" data-error="modelName"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-temperature">温度</label>' +
          '<div class="slider-group">' +
            '<input type="range" id="model-temperature" data-field="temperature" min="0" max="2" step="0.1" value="' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '">' +
            '<span class="slider-value" data-value="temperature">' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="model-maxContextTokens">上下文上限（Token）</label>' +
          '<input type="number" id="model-maxContextTokens" data-field="maxContextTokens" placeholder="例如 131072" min="1" value="' + (prov.maxContextTokens != null ? prov.maxContextTokens : '') + '">' +
        '</div>' +
      '</div>' +
      '<div class="config-detail-toolbar">' +
        '<label class="config-default-switch" title="设为默认模型">' +
          '<input type="checkbox" data-action="set-default" ' + (isDefault ? 'checked disabled' : '') + '>' +
          '<span class="config-default-switch-track" aria-hidden="true"></span>' +
          '<span class="config-default-switch-text">' +
            '<span class="config-default-switch-label">默认模型</span>' +
            '<span class="config-default-switch-hint">聊天时优先使用</span>' +
          '</span>' +
        '</label>' +
        '<button type="button" class="skills-btn skills-btn-primary" id="model-btn-save">保存配置</button>' +
      '</div>';

    var slider = detailEl.querySelector('[data-field="temperature"]');
    var sliderVal = detailEl.querySelector('[data-value="temperature"]');
    if (slider && sliderVal) {
      slider.addEventListener('input', function () {
        sliderVal.textContent = slider.value;
      });
    }

    var defaultToggle = detailEl.querySelector('[data-action="set-default"]');
    if (defaultToggle) {
      defaultToggle.addEventListener('change', function () {
        if (!defaultToggle.checked) {
          defaultToggle.checked = true;
          return;
        }
        defaultIndex = index;
        renderAll();
        tryAutoSaveDefault();
      });
    }

    detailEl.querySelector('#model-btn-delete').addEventListener('click', handleDelete);

    detailEl.querySelector('#model-btn-save').addEventListener('click', handleSave);
  }

  function renderAll() {
    renderList();
    renderDetail();
  }

  function buildProviderPayload(sourceProviders) {
    var result = [];
    for (var i = 0; i < sourceProviders.length; i++) {
      var original = sourceProviders[i] || {};
      result.push({
        id: original.id || generateId(),
        apiUrl: original.apiUrl || '',
        apiKey: original.apiKey || '',
        modelName: original.modelName || '',
        parameters: Object.assign({}, original.parameters || {}, {
          temperature: original.parameters && original.parameters.temperature != null
            ? original.parameters.temperature : 1
        }),
        isDefault: i === defaultIndex,
        supportsVision: original.supportsVision !== undefined ? original.supportsVision : true,
        maxContextTokens: original.maxContextTokens,
        requestTimeoutMs: original.requestTimeoutMs
      });
    }
    return result;
  }

  function collectFormData() {
    syncFormToProvider(selectedIndex);
    return buildProviderPayload(providers);
  }

  function reloadProvidersFromServer(callback) {
    loadConfig(function (_err, loaded) {
      if (!_err) {
        providers = loaded.map(function (p) { p._masked = true; return p; });
        defaultIndex = 0;
        for (var j = 0; j < providers.length; j++) {
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
    var deleteIndex = selectedIndex;
    var target = providers[deleteIndex];
    if (!target) return;
    var deleteId = target.id;
    var deleteName = providerDisplayName(target);
    var confirmFn = (window.Modal && typeof window.Modal.confirm === 'function')
      ? window.Modal.confirm
      : function (opts) {
        return Promise.resolve(window.confirm((opts && opts.message) || '确认？'));
      };

    confirmFn({
      title: '移除提供者',
      message: '确定要移除「' + deleteName + '」吗？',
      type: 'warning',
      confirmText: '移除',
      cancelText: '取消',
      dangerConfirm: true,
    }).then(function (confirmed) {
      if (!confirmed) return;

      syncFormToProvider(deleteIndex);

      var wasDefault = deleteIndex === defaultIndex;
      providers = providers.filter(function (p) { return p.id !== deleteId; });
      adjustIndicesAfterRemoval(deleteIndex, wasDefault);

      var data = buildProviderPayload(providers);
      for (var i = 0; i < data.length; i++) {
        if (Object.keys(validateProvider(data[i])).length > 0) {
          Notification.error('无法删除：其余提供者配置不完整，请先完善或删除');
          reloadProvidersFromServer();
          return;
        }
      }

      renderAll();

      saveConfig(data, function (err, result) {
        if (err) {
          Notification.error('删除失败：' + err.message);
          reloadProvidersFromServer();
          return;
        }
        Notification.success('「' + deleteName + '」已移除');
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
    var data = collectFormData();
    var detailEl = container.querySelector('#model-detail');
    clearFieldErrors(detailEl);
    var errors = validateProvider(data[selectedIndex]);
    var hasErrors = Object.keys(errors).length > 0;
    if (hasErrors) {
      for (var field in errors) {
        showFieldError(detailEl, field, errors[field]);
      }
      return;
    }

    for (var i = 0; i < data.length; i++) {
      if (i !== selectedIndex && Object.keys(validateProvider(data[i])).length > 0) {
        Notification.error('提供者 #' + (i + 1) + ' 配置不完整，请先完善或删除');
        return;
      }
    }

    saveConfig(data, function (err, result) {
      if (err) {
        Notification.error('保存失败：' + err.message);
      } else {
        Notification.success('配置已保存');
        if (result && result.setupComplete && window.AppRouter && window.AppRouter.clearSetupMode) {
          window.AppRouter.clearSetupMode();
        }
        var banner = container && container.querySelector('#setup-banner');
        if (banner) banner.hidden = true;
        loadConfig(function (_err, loaded) {
          if (!_err) {
            providers = loaded.map(function (p) { p._masked = true; return p; });
            defaultIndex = 0;
            for (var j = 0; j < providers.length; j++) {
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
    renderAll();
  }

  function render(parentEl, options) {
    container = parentEl;
    options = options || {};

    parentEl.innerHTML =
      '<div class="config-panel-inner">' +
        (options.showSetupBanner ? (
          '<div class="setup-banner" id="setup-banner" hidden>' +
            '<strong>首次使用</strong>：请填写 AI 服务商提供的 API 地址、密钥和模型名称，保存后即可开始聊天。' +
          '</div>'
        ) : '') +
        '<div class="config-split">' +
          '<aside class="config-list-panel">' +
            '<div class="config-list-panel-head">' +
              '<span class="config-list-panel-title">模型提供者</span>' +
              '<button type="button" class="chat-sidebar-new-btn" id="model-btn-add" title="添加提供者">' +
                '<span class="chat-sidebar-new-btn-icon" aria-hidden="true">+</span>' +
                '<span class="chat-sidebar-new-btn-label">添加</span>' +
              '</button>' +
            '</div>' +
            '<div class="config-list" id="model-provider-list"></div>' +
          '</aside>' +
          '<section class="config-detail-panel" id="model-detail"></section>' +
        '</div>' +
      '</div>';

    parentEl.querySelector('#model-btn-add').addEventListener('click', handleAddProvider);

    loadConfig(function (err, loaded, meta) {
      if (err) {
        Notification.error('加载配置失败');
        providers = [];
      } else {
        providers = loaded.map(function (p) { p._masked = true; return p; });
        if (options.showSetupBanner && meta && meta.setupRequired) {
          var banner = parentEl.querySelector('#setup-banner');
          if (banner) banner.hidden = false;
        }
        defaultIndex = 0;
        for (var i = 0; i < providers.length; i++) {
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
      renderAll();
    });
  }

  return { render: render };
})();
