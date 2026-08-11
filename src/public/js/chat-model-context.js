/**
 * ChatPage 的模型配置 + Token 用量管理（从 chat-page.js 拆分，2026-08-11）。
 * 职责：维护当前模型信息与 token 用量状态，供冰豆、欢迎页、模型下拉共享。
 * 依赖：window.ModelNames（resolveActiveModelName）、window.ChatModelPicker（setProviders）、
 *       window.ChatWelcome（sync）、window.MobileWorkPage（syncChatActivity）。
 * 外部注入回调：setPetTokenUsage(sessionPet 的 setTokenUsage 包装)、syncWelcomeState。
 * 暴露：window.ChatModelContext。
 */

/* exported ChatModelContext */

window.ChatModelContext = (function () {
  'use strict';

  var maxContextTokens = 0;
  var usedInputTokens = 0;
  var usedOutputTokens = 0;
  var modelName = '';

  var onUsageChanged = null;

  function setUsageChangedHandler(handler) {
    onUsageChanged = handler;
  }

  function resolveActiveModelName(provider) {
    if (window.ModelNames && typeof window.ModelNames.resolveActiveModelName === 'function') {
      return window.ModelNames.resolveActiveModelName(provider);
    }
    return provider && provider.modelName ? provider.modelName : '';
  }

  function applyModelContextFromWs(data) {
    if (!data || !data.modelContext) return false;
    var mc = data.modelContext;
    if (typeof mc.maxContextTokens === 'number' && mc.maxContextTokens > 0) {
      maxContextTokens = mc.maxContextTokens;
    }
    if (typeof mc.modelName === 'string') {
      modelName = mc.modelName;
    }
    notifyUsageChanged();
    return true;
  }

  // 拉取一次即可覆盖两件事：
  //   1) Token 用量（maxContextTokens / modelName → 冰豆）
  //   2) 底部 #chip-model-label 显示当前默认 provider 的 modelName
  // 失败时也要回填 chip，避免一直停在"加载中…"
  function loadModelConfig() {
    fetch('/api/config')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var providers = data.providers || [];
        var defaultProvider = providers.find(function (p) { return p.isDefault; }) || providers[0];
        if (defaultProvider) {
          maxContextTokens = defaultProvider.maxContextTokens || 0;
          modelName = resolveActiveModelName(defaultProvider);
          notifyUsageChanged();
        }
        if (window.ChatModelPicker && window.ChatModelPicker.setProviders) {
          window.ChatModelPicker.setProviders(providers);
        }
        updateChipModelLabel(providers);
        if (onUsageChanged) onUsageChanged();
      })
      .catch(function () {
        if (window.ChatModelPicker && window.ChatModelPicker.setProviders) {
          window.ChatModelPicker.setProviders([]);
        }
        updateChipModelLabel(null);
      });
  }

  // 没有 provider 或请求失败时回退到"未配置"
  // DOM 还没渲染好时（chat 页面异步插入 chip-model-label）轮询重试，避免卡在"加载中…"
  function updateChipModelLabel(providers) {
    function apply() {
      var el = document.getElementById('chip-model-label');
      if (!el) return false;
      if (!providers || !providers.length) {
        el.textContent = '未配置';
        return true;
      }
      var def = providers.find(function (p) { return p.isDefault; }) || providers[0];
      var label = def ? resolveActiveModelName(def) : '';
      el.textContent = label || '未配置';
      return true;
    }
    if (apply()) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (apply() || tries >= 10) clearInterval(timer);
    }, 50);
  }

  // 从 WS 初始连接 payload 同步 chip（避免再走一次 fetch）
  // 兼容两种结构：data.providers (数组) 或 data.modelName (单值)
  function syncChipModelLabelFromWs(data) {
    var providers = null;
    if (data && data.providers && data.providers.length) {
      providers = data.providers;
    } else if (data && data.modelName) {
      providers = [{ isDefault: true, modelName: data.modelName }];
    }
    updateChipModelLabel(providers);
  }

  function fetchSupportedFormats() {
    fetch('/api/chat/supported-formats')
      .then(function (res) { return res.json(); })
      .then(function () { /* ignore */ })
      .catch(function () { /* ignore */ });
  }

  function updateTokenUsage(inputTokens, outputTokens, contextOpts) {
    contextOpts = contextOpts || {};
    if (typeof contextOpts.effectiveUsed === 'number' && contextOpts.effectiveUsed > 0) {
      usedInputTokens = contextOpts.effectiveUsed;
    } else {
      usedInputTokens = inputTokens;
    }
    usedOutputTokens = outputTokens;
    if (typeof contextOpts.contextWindow === 'number' && contextOpts.contextWindow > 0) {
      maxContextTokens = contextOpts.contextWindow;
    }
    notifyUsageChanged();
  }

  function applyTotalTokenUsageFromStep(totalTokenUsage) {
    if (!totalTokenUsage) return;
    updateTokenUsage(
      totalTokenUsage.inputTokens || 0,
      totalTokenUsage.outputTokens || 0,
      {
        effectiveUsed: totalTokenUsage.effectiveUsed,
        contextWindow: totalTokenUsage.contextWindow,
      },
    );
  }

  function resetTokenUsage() {
    usedInputTokens = 0;
    usedOutputTokens = 0;
    notifyUsageChanged();
  }

  function notifyUsageChanged() {
    if (onUsageChanged) onUsageChanged();
  }

  return {
    setUsageChangedHandler: setUsageChangedHandler,
    resolveActiveModelName: resolveActiveModelName,
    applyModelContextFromWs: applyModelContextFromWs,
    loadModelConfig: loadModelConfig,
    updateChipModelLabel: updateChipModelLabel,
    syncChipModelLabelFromWs: syncChipModelLabelFromWs,
    fetchSupportedFormats: fetchSupportedFormats,
    updateTokenUsage: updateTokenUsage,
    applyTotalTokenUsageFromStep: applyTotalTokenUsageFromStep,
    resetTokenUsage: resetTokenUsage,
    getMaxContextTokens: function () { return maxContextTokens; },
    getUsedInputTokens: function () { return usedInputTokens; },
    getUsedOutputTokens: function () { return usedOutputTokens; },
    getModelName: function () { return modelName; },
  };
})();
