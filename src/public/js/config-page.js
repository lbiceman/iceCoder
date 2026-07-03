/**
 * 配置中心页面：Tab 切换「模型配置」与「MCP 配置」。
 */

/* exported ConfigPage */

window.ConfigPage = (function () {
  'use strict';

  var container = null;
  var activeTab = 'model';

  function render(parentEl) {
    container = parentEl;
    activeTab = 'model';

    parentEl.innerHTML =
      '<div class="config-center">' +
        '<header class="config-center-header">' +
          '<div class="config-center-header-text">' +
            '<h1 class="config-center-title">配置中心</h1>' +
            '<p class="config-center-subtitle">配置模型与 MCP 服务器，管理 LLM 与工具集成</p>' +
          '</div>' +
        '</header>' +
        '<nav class="config-tabs" role="tablist" aria-label="配置类型">' +
          '<button type="button" class="config-tab is-active" data-tab="model" role="tab" aria-selected="true">模型配置</button>' +
          '<button type="button" class="config-tab" data-tab="mcp" role="tab" aria-selected="false">MCP 配置</button>' +
        '</nav>' +
        '<div class="config-tab-panels">' +
          '<div class="config-tab-panel is-active" data-panel="model" role="tabpanel" id="config-tab-model"></div>' +
          '<div class="config-tab-panel" data-panel="mcp" role="tabpanel" id="config-tab-mcp" hidden></div>' +
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

    var showSetupBanner = window.AppRouter
      && window.AppRouter.isSetupRequired
      && window.AppRouter.isSetupRequired();

    if (window.ModelConfigPanel) {
      window.ModelConfigPanel.render(parentEl.querySelector('#config-tab-model'), {
        showSetupBanner: showSetupBanner
      });
    }

    setActiveTab('model');
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
