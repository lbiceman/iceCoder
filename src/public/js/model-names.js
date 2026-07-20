/**
 * 模型名称解析（与 src/config/parse-model-names.ts 语义一致）。
 */

/* exported ModelNames */

window.ModelNames = (function () {
  'use strict';

  function parseModelNames(modelName) {
    if (!modelName || !String(modelName).trim()) return [];
    var seen = {};
    var result = [];
    var parts = String(modelName).split(',');
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].trim();
      if (!name || seen[name]) continue;
      seen[name] = true;
      result.push(name);
    }
    return result;
  }

  function resolveActiveModelName(provider) {
    if (!provider) return '';
    var names = parseModelNames(provider.modelName);
    if (!names.length) return (provider.modelName || '').trim();
    var active = provider.activeModelName && String(provider.activeModelName).trim();
    if (active && names.indexOf(active) >= 0) return active;
    return names[0];
  }

  function providerDisplayLabel(provider) {
    var names = parseModelNames(provider && provider.modelName);
    if (!names.length) return '未设置模型';
    if (names.length === 1) return names[0];
    return names.join(', ');
  }

  /** 从 API 地址 hostname 取中间段，如 www.baidu.com → baidu */
  function apiUrlGroupLabel(apiUrl) {
    if (!apiUrl || !String(apiUrl).trim()) return '';
    var host = '';
    try {
      host = new URL(String(apiUrl).trim()).hostname;
    } catch (_e) {
      host = String(apiUrl).replace(/^https?:\/\//i, '').split('/')[0];
    }
    var parts = host.split('.').filter(Boolean);
    if (!parts.length) return '';
    if (parts.length <= 2) return parts[0];
    return parts[Math.floor(parts.length / 2)];
  }

  return {
    parseModelNames: parseModelNames,
    resolveActiveModelName: resolveActiveModelName,
    providerDisplayLabel: providerDisplayLabel,
    apiUrlGroupLabel: apiUrlGroupLabel,
  };
})();
