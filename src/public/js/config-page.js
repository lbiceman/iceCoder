/**
 * 配置页面模块。
 * 渲染 LLM 提供者配置管理表单。
 * 支持多提供者的添加/移除、API 密钥遮蔽和验证。
 */

/* exported ConfigPage */

window.ConfigPage = (function () {
  'use strict';

  // ---- 状态 ----
  var providers = [];
  var container = null;
  var nextId = 1;
  var defaultIndex = 0; // 当前选中的默认提供者索引
  var autoSaveDefaultTimer = null;

  // 10 套卡片主题色（与 config.css 中 .theme-0 ~ .theme-9 一一对应）
  var CARD_THEMES = [
    'theme-0', 'theme-1', 'theme-2', 'theme-3', 'theme-4',
    'theme-5', 'theme-6', 'theme-7', 'theme-8', 'theme-9'
  ];
  function pickTheme(index) {
    return CARD_THEMES[((index % CARD_THEMES.length) + CARD_THEMES.length) % CARD_THEMES.length];
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
            renderProviders();
          }
        });
        if (window.AppRouter && window.AppRouter.refreshStatus) {
          window.AppRouter.refreshStatus();
        }
      });
    }, 320);
  }

  // ---- 辅助函数 ----

  function generateId() {
    return 'provider-' + Date.now() + '-' + (nextId++);
  }

  function maskApiKey(key) {
    if (!key || key.length <= 8) return '****';
    return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
  }

  // ---- API ----

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

  // ---- 验证 ----

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

  function showFieldError(cardEl, fieldName, message) {
    var input = cardEl.querySelector('[data-field="' + fieldName + '"]');
    if (!input) return;
    input.classList.add('error');
    var errEl = cardEl.querySelector('[data-error="' + fieldName + '"]');
    if (errEl) errEl.textContent = message;
  }

  function clearFieldErrors(cardEl) {
    var inputs = cardEl.querySelectorAll('input.error');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].classList.remove('error');
    }
    var errEls = cardEl.querySelectorAll('.error-msg');
    for (var j = 0; j < errEls.length; j++) {
      errEls[j].textContent = '';
    }
  }

  // ---- 渲染 ----

  function createProviderCard(prov, index) {
    var card = document.createElement('div');
    card.className = 'provider-card ' + pickTheme(index);
    card.setAttribute('data-index', index);

    var displayKey = prov._masked ? prov.apiKey : (prov.apiKey ? maskApiKey(prov.apiKey) : '');

    var isDefault = index === defaultIndex;

    card.innerHTML =
      '<div class="provider-card-header">' +
        '<div class="provider-card-title-row">' +
          '<span class="provider-card-title">提供者 #' + (index + 1) + '</span>' +
          '<label class="default-radio-label" title="设为默认模型">' +
            '<input type="radio" name="default-provider" data-action="set-default" ' + (isDefault ? 'checked' : '') + '>' +
            '<span class="default-radio-text">' + (isDefault ? '✓ 默认' : '设为默认') + '</span>' +
          '</label>' +
        '</div>' +
        '<button class="btn-remove-provider" title="移除提供者" data-action="remove">&times;</button>' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="form-group full-width">' +
          '<label for="apiUrl-' + index + '">API 地址</label>' +
          '<input type="url" id="apiUrl-' + index + '" data-field="apiUrl" placeholder="https://api.openai.com/v1" value="' + escapeAttr(prov.apiUrl || '') + '">' +
          '<span class="error-msg" data-error="apiUrl"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="apiKey-' + index + '">API 密钥</label>' +
          '<input type="password" id="apiKey-' + index + '" data-field="apiKey" placeholder="sk-..." value="' + escapeAttr(prov.apiKey || '') + '">' +
          '<span class="error-msg" data-error="apiKey"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="modelName-' + index + '">模型名称</label>' +
          '<input type="text" id="modelName-' + index + '" data-field="modelName" placeholder="例如 gpt-4o、deepseek-chat" value="' + escapeAttr(prov.modelName || '') + '">' +
          '<span class="error-msg" data-error="modelName"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="temperature-' + index + '">温度</label>' +
          '<div class="slider-group">' +
            '<input type="range" id="temperature-' + index + '" data-field="temperature" min="0" max="2" step="0.1" value="' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '">' +
            '<span class="slider-value" data-value="temperature">' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="maxContextTokens-' + index + '">上下文上限（Token）</label>' +
          '<input type="number" id="maxContextTokens-' + index + '" data-field="maxContextTokens" placeholder="例如 131072" min="1" value="' + (prov.maxContextTokens != null ? prov.maxContextTokens : '') + '">' +
        '</div>' +
      '</div>';

    // 连接温度滑块
    var slider = card.querySelector('[data-field="temperature"]');
    var sliderVal = card.querySelector('[data-value="temperature"]');
    slider.addEventListener('input', function () {
      sliderVal.textContent = slider.value;
    });

    // 连接移除按钮
    card.querySelector('[data-action="remove"]').addEventListener('click', function () {
      Modal.confirm({
        title: '移除提供者',
        message: '确定要移除该 LLM 提供者吗？',
        type: 'warning',
        confirmText: '移除',
        cancelText: '取消',
      }).then(function (confirmed) {
        if (!confirmed) return;
        // 如果删除的是默认提供者之前的，调整 defaultIndex
        if (index < defaultIndex) {
          defaultIndex--;
        } else if (index === defaultIndex) {
          defaultIndex = 0;
        }
        providers.splice(index, 1);
        if (providers.length === 0) defaultIndex = 0;
        renderProviders();
      });
    });

    // 连接默认选择按钮
    card.querySelector('[data-action="set-default"]').addEventListener('change', function () {
      defaultIndex = index;
      renderProviders();
      tryAutoSaveDefault();
    });

    return card;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderProviders() {
    var list = container.querySelector('#provider-list');
    list.innerHTML = '';
    for (var i = 0; i < providers.length; i++) {
      list.appendChild(createProviderCard(providers[i], i));
    }
  }

  function collectFormData() {
    var cards = container.querySelectorAll('.provider-card');
    var result = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var apiKey = card.querySelector('[data-field="apiKey"]').value;
      var original = providers[i] || {};

      // If the key looks masked (all asterisks in the middle), keep the original
      // The backend returns masked keys; if user didn't change it, we send the masked version
      // The backend should handle this (keep existing key if masked value is sent)

      result.push({
        id: original.id || generateId(),
        apiUrl: card.querySelector('[data-field="apiUrl"]').value.trim(),
        apiKey: apiKey,
        modelName: card.querySelector('[data-field="modelName"]').value.trim(),
        parameters: Object.assign({}, original.parameters || {}, {
          temperature: parseFloat(card.querySelector('[data-field="temperature"]').value)
        }),
        isDefault: i === defaultIndex,
        supportsVision: original.supportsVision !== undefined ? original.supportsVision : true,
        maxContextTokens: parseInt(card.querySelector('[data-field="maxContextTokens"]').value, 10) || undefined,
        requestTimeoutMs: original.requestTimeoutMs
      });
    }
    return result;
  }

  function handleSave() {
    var data = collectFormData();
    var hasErrors = false;

      // 验证
    var cards = container.querySelectorAll('.provider-card');
    for (var i = 0; i < cards.length; i++) {
      clearFieldErrors(cards[i]);
      var errors = validateProvider(data[i]);
      if (Object.keys(errors).length > 0) {
        hasErrors = true;
        for (var field in errors) {
          showFieldError(cards[i], field, errors[field]);
        }
      }
    }

    if (hasErrors) return;

    saveConfig(data, function (err, result) {
      if (err) {
        Notification.error('保存失败：' + err.message);
      } else {
        Notification.success('配置已保存');
        if (result && result.setupComplete && window.AppRouter && window.AppRouter.exitSetupMode) {
          window.AppRouter.exitSetupMode();
        }
        // 从服务器刷新提供者以获取遮蔽的密钥
        loadConfig(function (_err, loaded) {
          if (!_err) {
            providers = loaded.map(function (p) { p._masked = true; return p; });
            // 恢复默认提供者索引
            defaultIndex = 0;
            for (var i = 0; i < providers.length; i++) {
              if (providers[i].isDefault) {
                defaultIndex = i;
                break;
              }
            }
            renderProviders();
          }
        });
        // 刷新导航中的系统状态
        if (window.AppRouter && window.AppRouter.refreshStatus) {
          window.AppRouter.refreshStatus();
        }
      }
    });
  }

  function handleAddProvider() {
    providers.push({
      id: generateId(),
      apiUrl: '',
      apiKey: '',
      modelName: '',
      parameters: { temperature: 1 },
      supportsVision: true
    });
    renderProviders();
  }

  // ---- 公共 API ----

  function render(parentEl) {
    container = parentEl;

    container.innerHTML =
      '<div class="config-page">' +
        '<div class="setup-banner" id="setup-banner" hidden>' +
          '<strong>首次使用</strong>：请填写 AI 服务商提供的 API 地址、密钥和模型名称，保存后即可开始聊天。' +
        '</div>' +
        '<h1>模型配置</h1>' +
        '<p class="subtitle">管理 LLM 提供者：填写 API 地址与密钥，选择默认模型后即可开始聊天。</p>' +
        '<p class="subtitle">仅支持openAI协议，不支持A社的！！！</p>' +
        '<div id="provider-list"></div>' +
        '<div class="config-actions">' +
          '<button class="btn btn-primary" id="btn-save">保存配置</button>' +
          '<button class="btn btn-secondary" id="btn-add">+ 添加提供者</button>' +
        '</div>' +
      '</div>';

    container.querySelector('#btn-save').addEventListener('click', handleSave);
    container.querySelector('#btn-add').addEventListener('click', handleAddProvider);

    var setupBanner = container.querySelector('#setup-banner');
    if (setupBanner && window.AppRouter && window.AppRouter.isSetupRequired && window.AppRouter.isSetupRequired()) {
      setupBanner.hidden = false;
    }

    // 加载已有配置
    loadConfig(function (err, loaded, meta) {
      if (err) {
        Notification.error('加载配置失败');
        providers = [];
      } else {
        providers = loaded.map(function (p) { p._masked = true; return p; });
        if (setupBanner && meta && meta.setupRequired) {
          setupBanner.hidden = false;
        }
        // 找到标记为默认的提供者
        defaultIndex = 0;
        for (var i = 0; i < providers.length; i++) {
          if (providers[i].isDefault) {
            defaultIndex = i;
            break;
          }
        }
      }
      if (providers.length === 0) {
        // 默认添加一个空的提供者卡片
        providers.push({
          id: generateId(),
          apiUrl: '',
          apiKey: '',
          modelName: '',
          parameters: { temperature: 1 },
          supportsVision: true
        });
      }
      renderProviders();
    });
  }

  return { render: render };
})();
