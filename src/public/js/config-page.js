/**
 * 设置页面：Tab 切换「通用」「模型配置」与「MCP 配置」。
 */

/* exported ConfigPage, SettingsPage */

window.SettingsPage = (function () {
  'use strict';

  var container = null;
  var activeTab = 'general';

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
      '</div>';

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
      if (parentEl._themeListener) {
        /* 重新 render 时旧 listener 随 DOM 丢弃，仅保留引用便于测试 */
      }
      parentEl._themeListener = function () { syncThemeOptions(parentEl); };
      shell.addThemeChangeListener(parentEl._themeListener);
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
            '<p class="config-center-subtitle">管理外观主题、模型与 MCP 服务器</p>' +
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
