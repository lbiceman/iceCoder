/**
 * Config Page module.
 * Renders a form for managing LLM provider configurations.
 * Supports multiple providers with add/remove, API key masking, and validation.
 */

/* exported ConfigPage */

var ConfigPage = (function () {
  'use strict';

  // ---- State ----
  var providers = [];
  var container = null;
  var nextId = 1;

  // ---- Helpers ----

  function generateId() {
    return 'provider-' + Date.now() + '-' + (nextId++);
  }

  function maskApiKey(key) {
    if (!key || key.length <= 8) return '****';
    return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
  }

  function showNotification(message, type) {
    // Remove existing notification
    var existing = document.querySelector('.notification');
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.className = 'notification ' + type;
    el.textContent = message;
    document.body.appendChild(el);

    setTimeout(function () {
      if (el.parentNode) el.remove();
    }, 3000);
  }

  // ---- API ----

  function loadConfig(callback) {
    fetch('/api/config')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        callback(null, data.providers || []);
      })
      .catch(function (err) {
        callback(err, []);
      });
  }

  function saveConfig(providerList, callback) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: providerList })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          callback(new Error(data.error));
        } else {
          callback(null, data);
        }
      })
      .catch(function (err) {
        callback(err);
      });
  }

  // ---- Validation ----

  function validateProvider(prov) {
    var errors = {};
    if (!prov.apiUrl || prov.apiUrl.trim() === '') {
      errors.apiUrl = 'API URL is required';
    }
    if (!prov.apiKey || prov.apiKey.trim() === '') {
      errors.apiKey = 'API Key is required';
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

  // ---- Rendering ----

  function createProviderCard(prov, index) {
    var card = document.createElement('div');
    card.className = 'provider-card';
    card.setAttribute('data-index', index);

    var displayKey = prov._masked ? prov.apiKey : (prov.apiKey ? maskApiKey(prov.apiKey) : '');

    card.innerHTML =
      '<div class="provider-card-header">' +
        '<span class="provider-card-title">Provider #' + (index + 1) + '</span>' +
        '<button class="btn-remove-provider" title="Remove provider" data-action="remove">&times;</button>' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="form-group full-width">' +
          '<label for="apiUrl-' + index + '">API URL</label>' +
          '<input type="url" id="apiUrl-' + index + '" data-field="apiUrl" placeholder="https://api.openai.com/v1" value="' + escapeAttr(prov.apiUrl || '') + '">' +
          '<span class="error-msg" data-error="apiUrl"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="apiKey-' + index + '">API Key</label>' +
          '<input type="password" id="apiKey-' + index + '" data-field="apiKey" placeholder="sk-..." value="' + escapeAttr(prov.apiKey || '') + '">' +
          '<span class="error-msg" data-error="apiKey"></span>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="modelName-' + index + '">Model Name</label>' +
          '<input type="text" id="modelName-' + index + '" data-field="modelName" placeholder="gpt-4" value="' + escapeAttr(prov.modelName || '') + '">' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="temperature-' + index + '">Temperature</label>' +
          '<div class="slider-group">' +
            '<input type="range" id="temperature-' + index + '" data-field="temperature" min="0" max="2" step="0.1" value="' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '">' +
            '<span class="slider-value" data-value="temperature">' + (prov.parameters && prov.parameters.temperature != null ? prov.parameters.temperature : 1) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="maxTokens-' + index + '">Max Tokens</label>' +
          '<input type="number" id="maxTokens-' + index + '" data-field="maxTokens" placeholder="4096" min="1" value="' + (prov.parameters && prov.parameters.maxTokens ? prov.parameters.maxTokens : '') + '">' +
        '</div>' +
      '</div>';

    // Wire temperature slider
    var slider = card.querySelector('[data-field="temperature"]');
    var sliderVal = card.querySelector('[data-value="temperature"]');
    slider.addEventListener('input', function () {
      sliderVal.textContent = slider.value;
    });

    // Wire remove button
    card.querySelector('[data-action="remove"]').addEventListener('click', function () {
      providers.splice(index, 1);
      renderProviders();
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
        providerName: original.providerName || 'openai',
        apiUrl: card.querySelector('[data-field="apiUrl"]').value.trim(),
        apiKey: apiKey,
        modelName: card.querySelector('[data-field="modelName"]').value.trim(),
        parameters: {
          temperature: parseFloat(card.querySelector('[data-field="temperature"]').value),
          maxTokens: parseInt(card.querySelector('[data-field="maxTokens"]').value, 10) || undefined
        },
        isDefault: i === 0
      });
    }
    return result;
  }

  function handleSave() {
    var data = collectFormData();
    var hasErrors = false;

    // Validate
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

    saveConfig(data, function (err) {
      if (err) {
        showNotification('Failed to save: ' + err.message, 'error');
      } else {
        showNotification('Configuration saved successfully', 'success');
        // Refresh providers from server to get masked keys
        loadConfig(function (_err, loaded) {
          if (!_err) {
            providers = loaded.map(function (p) { p._masked = true; return p; });
            renderProviders();
          }
        });
        // Refresh system status in nav
        if (window.AppRouter && window.AppRouter.refreshStatus) {
          window.AppRouter.refreshStatus();
        }
      }
    });
  }

  function handleAddProvider() {
    providers.push({
      id: generateId(),
      providerName: 'openai',
      apiUrl: '',
      apiKey: '',
      modelName: '',
      parameters: { temperature: 1 }
    });
    renderProviders();
  }

  // ---- Public API ----

  function render(parentEl) {
    container = parentEl;

    container.innerHTML =
      '<div class="config-page">' +
        '<h1>Model Configuration</h1>' +
        '<p class="subtitle">Manage your LLM provider settings. The first provider is used as the default.</p>' +
        '<div id="provider-list"></div>' +
        '<div class="config-actions">' +
          '<button class="btn btn-primary" id="btn-save">Save Configuration</button>' +
          '<button class="btn btn-secondary" id="btn-add">+ Add Provider</button>' +
        '</div>' +
      '</div>';

    container.querySelector('#btn-save').addEventListener('click', handleSave);
    container.querySelector('#btn-add').addEventListener('click', handleAddProvider);

    // Load existing config
    loadConfig(function (err, loaded) {
      if (err) {
        showNotification('Failed to load configuration', 'error');
        providers = [];
      } else {
        providers = loaded.map(function (p) { p._masked = true; return p; });
      }
      if (providers.length === 0) {
        // Add one empty provider card by default
        providers.push({
          id: generateId(),
          providerName: 'openai',
          apiUrl: '',
          apiKey: '',
          modelName: '',
          parameters: { temperature: 1 }
        });
      }
      renderProviders();
    });
  }

  return { render: render };
})();
