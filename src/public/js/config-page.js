/**
 * 设置页面：Tab 切换「通用」「模型配置」与「MCP 配置」。
 */

/* exported ConfigPage, SettingsPage */

window.SettingsPage = (function () {
  'use strict';

  var container = null;
  var activeTab = 'general';

  function isMobileViewport() {
    return window.innerWidth <= 720;
  }

  function bindMobileBlankDismiss(rootEl) {
    if (!rootEl || rootEl._configMobileBlankBound) return;
    rootEl._configMobileBlankBound = true;
    rootEl.addEventListener('click', function (e) {
      if (!isMobileViewport()) return;
      if (e.target.closest('.config-list-item')) return;
      if (e.target.closest('.config-detail-panel')) return;
      if (e.target.closest('.config-list-panel-head')) return;
      if (e.target.closest('.chat-sidebar-new-btn')) return;
      if (window.ModelConfigPanel && typeof window.ModelConfigPanel.collapseMobile === 'function') {
        window.ModelConfigPanel.collapseMobile();
      }
      if (window.McpConfigPanel && typeof window.McpConfigPanel.collapseMobile === 'function') {
        window.McpConfigPanel.collapseMobile();
      }
    });
  }

  function renderGeneralPanel(parentEl) {
    var shell = window.AppShell;
    var theme = (shell && typeof shell.getTheme === 'function') ? shell.getTheme() : 'dark';

    parentEl.innerHTML =
      '<div class="settings-general">' +
        '<section class="settings-section">' +
          '<h2 class="settings-section-title">外观</h2>' +
          '<p class="settings-section-desc">选择界面主题，可随时在此切换深色与浅色模式</p>' +
          '<div class="settings-theme-options" role="radiogroup" aria-label="界面主题">' +
            '<button type="button" class="settings-theme-option' + (theme === 'dark' ? ' is-active' : '') + '" data-theme="dark" role="radio" aria-checked="' + (theme === 'dark' ? 'true' : 'false') + '">' +
              '<span class="settings-theme-preview settings-theme-preview-dark" aria-hidden="true">' +
                '<span class="settings-theme-preview-bar"></span>' +
                '<span class="settings-theme-preview-body"></span>' +
              '</span>' +
              '<span class="settings-theme-option-label">' +
                '<svg class="settings-theme-option-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>' +
                '深色' +
              '</span>' +
            '</button>' +
            '<button type="button" class="settings-theme-option' + (theme === 'light' ? ' is-active' : '') + '" data-theme="light" role="radio" aria-checked="' + (theme === 'light' ? 'true' : 'false') + '">' +
              '<span class="settings-theme-preview settings-theme-preview-light" aria-hidden="true">' +
                '<span class="settings-theme-preview-bar"></span>' +
                '<span class="settings-theme-preview-body"></span>' +
              '</span>' +
              '<span class="settings-theme-option-label">' +
                '<svg class="settings-theme-option-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1M12.3 12.3l-1.1-1.1M4.8 4.8 3.7 3.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
                '浅色' +
              '</span>' +
            '</button>' +
          '</div>' +
        '</section>' +
        '<section class="settings-section settings-section-spaced" id="settings-security-section">' +
          '<div class="settings-section-head">' +
            '<h2 class="settings-section-title">安全与执行</h2>' +
            '<span class="settings-section-loading" id="settings-security-loading" aria-hidden="true">加载中…</span>' +
          '</div>' +
          '<p class="settings-section-desc">控制 Agent 工具执行时的权限确认与 Shell 命令拦截规则</p>' +
          '<div class="settings-security-grid">' +
          '<div class="settings-card" id="settings-skip-permission-card" hidden>' +
            '<div class="settings-card-row">' +
              '<div class="settings-card-info">' +
                '<div class="settings-card-title-row">' +
                  '<span class="settings-card-title">跳过权限确认</span>' +
                  '<span class="config-badge is-error settings-risk-badge" id="settings-skip-risk-badge" hidden>高风险</span>' +
                '</div>' +
                '<p class="settings-card-desc">开启后 Agent 可直接执行工具，不再弹出确认（新会话生效）</p>' +
              '</div>' +
              '<label class="config-default-switch settings-card-switch" title="跳过权限确认">' +
                '<input type="checkbox" id="settings-skip-permission-input" />' +
                '<span class="config-default-switch-track" aria-hidden="true"></span>' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div class="settings-card settings-blacklist-card" id="settings-blacklist-card" hidden>' +
            '<div class="settings-card-header">' +
              '<div class="settings-card-info">' +
                '<div class="settings-card-title-row">' +
                  '<span class="settings-card-title">Shell 命令黑名单</span>' +
                  '<span class="config-badge is-starting" id="settings-blacklist-count">0 条规则</span>' +
                '</div>' +
                '<p class="settings-card-desc">每行一条正则表达式，匹配的 Shell 命令将被拦截；全部清空并保存可禁用黑名单（宿主进程保护仍生效）</p>' +
              '</div>' +
            '</div>' +
            '<div class="settings-blacklist-editor">' +
              '<textarea class="settings-blacklist-textarea" id="settings-blacklist-textarea" spellcheck="false" placeholder="rm\\s+-rf&#10;git\\s+reset\\s+--hard"></textarea>' +
            '</div>' +
            '<div class="settings-card-footer">' +
              '<button type="button" class="btn btn-secondary" id="settings-blacklist-reset">恢复默认</button>' +
              '<button type="button" class="btn btn-primary" id="settings-blacklist-save">保存黑名单</button>' +
            '</div>' +
          '</div>' +
          '</div>' +
        '</section>' +
      '</div>';

    bindThemeOptions(parentEl, shell);
    loadGeneralSecuritySettings(parentEl);
  }

  function bindThemeOptions(parentEl, shell) {
    var options = parentEl.querySelectorAll('.settings-theme-option');
    for (var i = 0; i < options.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var next = btn.getAttribute('data-theme');
          if (!next || !shell || typeof shell.setTheme !== 'function') return;
          if (shell.getTheme() === next) return;
          shell.setTheme(next);
          syncThemeOptions(parentEl);
        });
      })(options[i]);
    }

    if (shell && typeof shell.addThemeChangeListener === 'function') {
      parentEl._themeListener = function () { syncThemeOptions(parentEl); };
      shell.addThemeChangeListener(parentEl._themeListener);
    }
  }

  function parseBlacklistText(text) {
    return String(text || '')
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });
  }

  function updateBlacklistCount(parentEl, patterns) {
    var countEl = parentEl.querySelector('#settings-blacklist-count');
    if (!countEl) return;
    var n = patterns ? patterns.length : 0;
    countEl.textContent = n + ' 条规则';
  }

  function syncSkipPermissionUi(parentEl, enabled) {
    var input = parentEl.querySelector('#settings-skip-permission-input');
    var badge = parentEl.querySelector('#settings-skip-risk-badge');
    if (input) input.checked = !!enabled;
    if (badge) badge.hidden = !enabled;
  }

  function loadGeneralSecuritySettings(parentEl) {
    fetch('/api/config')
      .then(function (res) {
        if (!res.ok) throw new Error('fetch failed');
        return res.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);

        var loading = parentEl.querySelector('#settings-security-loading');
        var skipCard = parentEl.querySelector('#settings-skip-permission-card');
        var blacklistCard = parentEl.querySelector('#settings-blacklist-card');
        if (loading) loading.hidden = true;
        if (skipCard) skipCard.hidden = false;
        if (blacklistCard) blacklistCard.hidden = false;

        var skipEnabled = data && data.skipPermissionChecks === true;
        syncSkipPermissionUi(parentEl, skipEnabled);

        var patterns = (data && Array.isArray(data.shellBlacklist)) ? data.shellBlacklist : [];
        var textarea = parentEl.querySelector('#settings-blacklist-textarea');
        if (textarea) {
          textarea.value = patterns.join('\n');
          textarea.dataset.savedValue = textarea.value;
        }
        updateBlacklistCount(parentEl, patterns);

        bindGeneralSecurityEvents(parentEl);
      })
      .catch(function () {
        var loading = parentEl.querySelector('#settings-security-loading');
        var skipCard = parentEl.querySelector('#settings-skip-permission-card');
        var blacklistCard = parentEl.querySelector('#settings-blacklist-card');
        if (loading) {
          loading.textContent = '加载失败';
          loading.classList.add('is-error');
        }
        if (skipCard) skipCard.hidden = false;
        if (blacklistCard) blacklistCard.hidden = false;
        bindGeneralSecurityEvents(parentEl);
        if (window.Notification) window.Notification.error('无法加载安全设置');
      });
  }

  function bindGeneralSecurityEvents(parentEl) {
    if (parentEl._securityBound) return;
    parentEl._securityBound = true;

    var skipInput = parentEl.querySelector('#settings-skip-permission-input');
    if (skipInput) {
      skipInput.addEventListener('change', function () {
        var next = skipInput.checked;
        skipInput.disabled = true;
        fetch('/api/config/skip-permission-checks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skipPermissionChecks: next }),
        })
          .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
          .then(function (result) {
            if (result.ok && result.body.success) {
              syncSkipPermissionUi(parentEl, result.body.skipPermissionChecks === true);
              if (window.Notification) {
                window.Notification.success(
                  result.body.skipPermissionChecks
                    ? '已开启跳过权限确认（新会话生效）'
                    : '已关闭跳过权限确认（新会话生效）'
                );
              }
            } else {
              skipInput.checked = !next;
              syncSkipPermissionUi(parentEl, skipInput.checked);
              if (window.Notification) {
                window.Notification.error((result.body && result.body.error) || '更新失败');
              }
            }
          })
          .catch(function () {
            skipInput.checked = !next;
            syncSkipPermissionUi(parentEl, skipInput.checked);
            if (window.Notification) window.Notification.error('更新失败');
          })
          .finally(function () { skipInput.disabled = false; });
      });
    }

    var textarea = parentEl.querySelector('#settings-blacklist-textarea');
    if (textarea) {
      textarea.addEventListener('input', function () {
        updateBlacklistCount(parentEl, parseBlacklistText(textarea.value));
      });
    }

    var saveBtn = parentEl.querySelector('#settings-blacklist-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        if (!textarea) return;
        var patterns = parseBlacklistText(textarea.value);
        saveBtn.disabled = true;
        fetch('/api/config/shell-blacklist', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shellBlacklist: patterns }),
        })
          .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
          .then(function (result) {
            if (result.ok && result.body.success) {
              var saved = result.body.shellBlacklist || [];
              textarea.value = saved.join('\n');
              textarea.dataset.savedValue = textarea.value;
              updateBlacklistCount(parentEl, saved);
              if (window.Notification) window.Notification.success('Shell 黑名单已保存');
            } else if (window.Notification) {
              window.Notification.error((result.body && result.body.error) || '保存失败');
            }
          })
          .catch(function () {
            if (window.Notification) window.Notification.error('保存失败');
          })
          .finally(function () { saveBtn.disabled = false; });
      });
    }

    var resetBtn = parentEl.querySelector('#settings-blacklist-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        resetBtn.disabled = true;
        fetch('/api/config/shell-blacklist-defaults')
          .then(function (res) { return res.json(); })
          .then(function (data) {
            var defaults = (data && Array.isArray(data.shellBlacklist)) ? data.shellBlacklist : [];
            if (textarea) {
              textarea.value = defaults.join('\n');
              updateBlacklistCount(parentEl, defaults);
            }
            if (window.Notification) window.Notification.info('已填入默认规则，点击「保存黑名单」生效');
          })
          .catch(function () {
            if (window.Notification) window.Notification.error('无法加载默认规则');
          })
          .finally(function () { resetBtn.disabled = false; });
      });
    }
  }

  function syncThemeOptions(panelEl) {
    if (!panelEl) return;
    var shell = window.AppShell;
    var theme = (shell && typeof shell.getTheme === 'function') ? shell.getTheme() : 'dark';
    var options = panelEl.querySelectorAll('.settings-theme-option');
    for (var i = 0; i < options.length; i++) {
      var btn = options[i];
      var on = btn.getAttribute('data-theme') === theme;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function render(parentEl) {
    container = parentEl;

    var showSetupBanner = window.AppRouter
      && window.AppRouter.isSetupRequired
      && window.AppRouter.isSetupRequired();
    activeTab = showSetupBanner ? 'model' : 'general';

    parentEl.innerHTML =
      '<div class="config-center settings-center">' +
        '<header class="config-center-header">' +
          '<div class="config-center-header-text">' +
            '<h1 class="config-center-title">设置</h1>' +
            '<p class="config-center-subtitle">管理外观主题、安全选项、模型与 MCP 服务器</p>' +
          '</div>' +
        '</header>' +
        '<nav class="config-tabs" role="tablist" aria-label="设置类型">' +
          '<button type="button" class="config-tab' + (activeTab === 'general' ? ' is-active' : '') + '" data-tab="general" role="tab" aria-selected="' + (activeTab === 'general' ? 'true' : 'false') + '">通用</button>' +
          '<button type="button" class="config-tab' + (activeTab === 'model' ? ' is-active' : '') + '" data-tab="model" role="tab" aria-selected="' + (activeTab === 'model' ? 'true' : 'false') + '">模型配置</button>' +
          '<button type="button" class="config-tab' + (activeTab === 'mcp' ? ' is-active' : '') + '" data-tab="mcp" role="tab" aria-selected="' + (activeTab === 'mcp' ? 'true' : 'false') + '">MCP 配置</button>' +
        '</nav>' +
        '<div class="config-tab-panels">' +
          '<div class="config-tab-panel' + (activeTab === 'general' ? ' is-active' : '') + '" data-panel="general" role="tabpanel" id="config-tab-general"' + (activeTab === 'general' ? '' : ' hidden') + '></div>' +
          '<div class="config-tab-panel' + (activeTab === 'model' ? ' is-active' : '') + '" data-panel="model" role="tabpanel" id="config-tab-model"' + (activeTab === 'model' ? '' : ' hidden') + '></div>' +
          '<div class="config-tab-panel' + (activeTab === 'mcp' ? ' is-active' : '') + '" data-panel="mcp" role="tabpanel" id="config-tab-mcp"' + (activeTab === 'mcp' ? '' : ' hidden') + '></div>' +
        '</div>' +
      '</div>';

    container = parentEl.querySelector('.config-center') || parentEl;
    bindMobileBlankDismiss(container);

    var tabs = parentEl.querySelectorAll('.config-tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          setActiveTab(tab.getAttribute('data-tab'));
        });
      })(tabs[i]);
    }

    renderGeneralPanel(parentEl.querySelector('#config-tab-general'));

    if (window.ModelConfigPanel) {
      window.ModelConfigPanel.render(parentEl.querySelector('#config-tab-model'), {
        showSetupBanner: showSetupBanner
      });
    }

    setActiveTab(activeTab);
  }

  function setActiveTab(tab) {
    if (!tab) return;

    var switching = tab !== activeTab;
    activeTab = tab;

    var tabs = container.querySelectorAll('.config-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === tab;
      tabs[i].classList.toggle('is-active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }

    var panels = container.querySelectorAll('.config-tab-panel');
    for (var j = 0; j < panels.length; j++) {
      var panelOn = panels[j].getAttribute('data-panel') === tab;
      panels[j].classList.toggle('is-active', panelOn);
      panels[j].hidden = !panelOn;
    }

    if (tab === 'mcp' && window.McpConfigPanel) {
      var mcpEl = container.querySelector('#config-tab-mcp');
      if (mcpEl && !mcpEl.dataset.mounted) {
        mcpEl.dataset.mounted = '1';
        window.McpConfigPanel.render(mcpEl);
      } else if (switching && mcpEl && mcpEl.dataset.mounted) {
        if (window.McpConfigPanel.resume) {
          window.McpConfigPanel.resume();
        } else if (window.McpConfigPanel.reload) {
          window.McpConfigPanel.reload();
        }
      }
    } else if (switching && window.McpConfigPanel && window.McpConfigPanel.pause) {
      window.McpConfigPanel.pause();
    }
  }

  function onDeactivate() {
    if (window.McpConfigPanel && window.McpConfigPanel.pause) {
      window.McpConfigPanel.pause();
    }
  }

  return { render: render, onDeactivate: onDeactivate };
})();

window.ConfigPage = window.SettingsPage;
