// @ts-nocheck
import { t, getLocale, setLocale } from './i18n.ts';
/**
 * 设置页面：Tab 切换「通用」「模型配置」与「MCP 配置」。
 */

/* exported ConfigPage, SettingsPage */

export const SettingsPage = (() => {

  let container = null;
  let activeTab = 'general';

  function isMobileViewport() {
    return window.innerWidth <= 720;
  }

  function bindMobileBlankDismiss(rootEl) {
    if (!rootEl || rootEl._configMobileBlankBound) return;
    rootEl._configMobileBlankBound = true;
    rootEl.addEventListener('click', (e) => {
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

  function localeOptionsHtml() {
    const current = getLocale();
    const choices = [
      { id: 'zh', label: t('locale.zh') },
      { id: 'en', label: t('locale.en') },
    ];
    return choices.map((choice) => {
      const on = current === choice.id;
      return '<button type="button" class="settings-locale-option' + (on ? ' is-active' : '') + '" data-locale="' + choice.id + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '">' + choice.label + '</button>';
    }).join('');
  }

  function bindLocaleOptions(parentEl) {
    const options = parentEl.querySelectorAll('.settings-locale-option');
    for (let i = 0; i < options.length; i++) {
      options[i].addEventListener('click', () => {
        const next = options[i].getAttribute('data-locale');
        if (!next || next === getLocale()) return;
        setLocale(next);
      });
    }
  }

  function renderGeneralPanel(parentEl) {
    const shell = window.AppShell;
    const theme = (shell && typeof shell.getTheme === 'function') ? shell.getTheme() : 'dark';
    const dataDirectorySection =
      '<section class="settings-section settings-section-spaced" id="settings-data-directory-section">' +
        '<h2 class="settings-section-title">' + t('settings.data.title') + '</h2>' +
        '<p class="settings-section-desc">' + t('settings.data.desc') + '</p>' +
        '<div class="settings-card" id="settings-data-directory-card">' +
          '<div class="settings-card-info">' +
            '<div class="settings-card-title-row"><span class="settings-card-title">' + t('settings.data.folder') + '</span><span class="config-badge is-off" id="settings-data-directory-env-badge">' + t('settings.data.checking') + '</span></div>' +
            '<p class="settings-card-desc" id="settings-data-directory-desc">' + t('settings.data.pathHint') + '</p>' +
          '</div>' +
          '<div class="settings-data-directory-controls">' +
            '<input class="settings-data-directory-input" id="settings-data-directory-input" type="text" spellcheck="false" aria-label="' + t('settings.data.pathLabel') + '" />' +
            '<button type="button" class="btn btn-secondary" id="settings-data-directory-browse">' + t('settings.data.browse') + '</button>' +
          '</div>' +
          '<p class="settings-data-directory-note" id="settings-data-directory-note"></p>' +
          '<div class="settings-card-footer">' +
            '<button type="button" class="btn btn-secondary" id="settings-data-directory-reset">' + t('settings.data.reset') + '</button>' +
            '<button type="button" class="btn btn-primary" id="settings-data-directory-save">' + t('settings.data.save') + '</button>' +
          '</div>' +
        '</div>' +
      '</section>';

    // 主题预览：用几个色块示意真实界面（左侧栏 + 顶栏 + 用户气泡 + 回复 + 输入框），
    // 具体配色由 CSS 里各主题的 --stp-* 变量提供。
    const themePreview = (variant) =>
      '<span class="settings-theme-preview settings-theme-preview-' + variant + '" aria-hidden="true">' +
        '<span class="stp-side">' +
          '<span class="stp-side-head"></span>' +
          '<span class="stp-side-row"></span>' +
          '<span class="stp-side-row"></span>' +
        '</span>' +
        '<span class="stp-main">' +
          '<span class="stp-topbar"></span>' +
          '<span class="stp-msg stp-msg--user"></span>' +
          '<span class="stp-msg stp-msg--agent"></span>' +
          '<span class="stp-input"></span>' +
        '</span>' +
      '</span>';

    const themeChoices = [
      { id: 'dark', label: t('theme.dark'), icon: 'moon' },
      { id: 'light', label: t('theme.light'), icon: 'sun' },
      { id: 'modern', label: t('theme.modern'), icon: 'work' },
      // 森绿用 spark 而非 sun：浅色已占用 sun，重复图标会让人分不清两张卡
      { id: 'fresh', label: t('theme.fresh'), icon: 'spark' },
    ];
    const themeOptionsHtml = themeChoices.map((choice) => {
      const on = theme === choice.id;
      const icon = window.AppIcon
        ? window.AppIcon.html(choice.icon, { width: 14, className: 'settings-theme-option-icon' })
        : '';
      return '<button type="button" class="settings-theme-option' + (on ? ' is-active' : '') + '" data-theme="' + choice.id + '" role="radio" aria-checked="' + (on ? 'true' : 'false') + '">' +
        themePreview(choice.id) +
        '<span class="settings-theme-option-label">' + icon + choice.label + '</span>' +
      '</button>';
    }).join('');

    parentEl.innerHTML =
      '<div class="settings-general">' +
        '<section class="settings-section">' +
          '<h2 class="settings-section-title">' + t('locale.title') + '</h2>' +
          '<p class="settings-section-desc">' + t('locale.desc') + '</p>' +
          '<div class="settings-locale-options" role="radiogroup" aria-label="' + t('locale.group') + '">' +
            localeOptionsHtml() +
          '</div>' +
        '</section>' +
        '<section class="settings-section settings-section-spaced">' +
          '<h2 class="settings-section-title">' + t('settings.appearance.title') + '</h2>' +
          '<p class="settings-section-desc">' + t('settings.appearance.desc') + '</p>' +
          '<div class="settings-theme-options" role="radiogroup" aria-label="' + t('theme.group') + '">' +
            themeOptionsHtml +
          '</div>' +
        '</section>' +
        dataDirectorySection +
        '<section class="settings-section settings-section-spaced" id="settings-sub-agents-section">' +
          '<h2 class="settings-section-title">' + t('settings.subagents.title') + '</h2>' +
          '<p class="settings-section-desc">' + t('settings.subagents.desc') + '</p>' +
          '<div class="settings-card" id="settings-sub-agents-card" hidden>' +
            '<div class="settings-card-row">' +
              '<div class="settings-card-info">' +
                '<span class="settings-card-title">' + t('settings.subagents.enable') + '</span>' +
                '<p class="settings-card-desc">' + t('settings.subagents.hint') + '</p>' +
              '</div>' +
              '<div class="settings-card-control">' +
                '<label class="config-default-switch settings-card-switch" title="' + t('settings.subagents.enable') + '">' +
                  '<input type="checkbox" id="settings-sub-agents-input" checked />' +
                  '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="settings-section settings-section-spaced" id="settings-use-windows-section">' +
          '<div class="settings-section-head">' +
            '<h2 class="settings-section-title">' + t('settings.windows.title') + '</h2>' +
            '<span class="config-badge is-starting">' + t('settings.windows.badge') + '</span>' +
          '</div>' +
          '<p class="settings-section-desc">' + t('settings.windows.desc') + '</p>' +
          '<div class="settings-card" id="settings-use-windows-card" hidden>' +
            '<div class="settings-card-row">' +
              '<div class="settings-card-info">' +
                '<span class="settings-card-title">' + t('settings.windows.enable') + '</span>' +
                '<p class="settings-card-desc" id="settings-use-windows-desc">' + t('settings.windows.hint') + '</p>' +
              '</div>' +
              '<div class="settings-card-control">' +
                '<label class="config-default-switch settings-card-switch" title="' + t('settings.windows.enable') + '">' +
                  '<input type="checkbox" id="settings-use-windows-input" />' +
                  '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="settings-section settings-section-spaced" id="settings-etl-section">' +
          '<div class="settings-section-head">' +
            '<h2 class="settings-section-title">' + t('settings.workbench.title') + '</h2>' +
          '</div>' +
          '<p class="settings-section-desc">' + t('settings.workbench.desc') + '</p>' +
          '<div class="settings-card" id="settings-etl-main-card">' +
            '<div class="settings-card-row">' +
              '<div class="settings-card-info">' +
                '<div class="settings-card-title-row">' +
                  '<span class="settings-card-title">' + t('settings.workbench.show') + '</span>' +
                '</div>' +
                '<p class="settings-card-desc">' + t('settings.workbench.showHint') + '</p>' +
              '</div>' +
              '<div class="settings-card-control">' +
                '<label class="config-default-switch settings-card-switch" title="' + t('settings.workbench.show') + '">' +
                  '<input type="checkbox" id="etl-show-panel" />' +
                  '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
            '<div class="settings-etl-subgroup" id="settings-etl-subgroup">' +
              '<div class="settings-etl-row">' +
                '<div class="settings-etl-row-info">' +
                  '<span class="settings-etl-row-label">' + t('settings.workbench.expand') + '</span>' +
                  '<span class="settings-etl-row-hint">' + t('settings.workbench.expandHint') + '</span>' +
                '</div>' +
                '<div class="settings-card-control">' +
                  '<label class="config-default-switch settings-etl-switch" title="' + t('settings.workbench.expand') + '">' +
                    '<input type="checkbox" id="etl-panel-default-expanded" />' +
                    '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                  '</label>' +
                '</div>' +
              '</div>' +
              '<div class="settings-etl-row" id="etl-panel-auto-collapse-row">' +
                '<div class="settings-etl-row-info">' +
                  '<span class="settings-etl-row-label">' + t('settings.workbench.idle') + '</span>' +
                  '<span class="settings-etl-row-hint">' + t('settings.workbench.idleHint') + '</span>' +
                '</div>' +
                '<div class="settings-card-control">' +
                  '<label class="config-default-switch settings-etl-switch" title="' + t('settings.workbench.idle') + '">' +
                    '<input type="checkbox" id="etl-panel-auto-collapse" />' +
                    '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                  '</label>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="settings-etl-row settings-etl-desktop-pet" id="etl-show-desktop-pet-row">' +
              '<div class="settings-etl-row-info">' +
                '<span class="settings-etl-row-label">' + t('settings.desktopPet.label') + '</span>' +
                '<span class="settings-etl-row-hint">' + t('settings.desktopPet.hint') + '</span>' +
              '</div>' +
              '<div class="settings-card-control">' +
                '<label class="config-default-switch settings-etl-switch" title="' + t('settings.desktopPet.label') + '">' +
                  '<input type="checkbox" id="etl-show-desktop-pet" />' +
                  '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="settings-section settings-section-spaced" id="settings-task-notification-section">' +
          '<div class="settings-section-head">' +
            '<h2 class="settings-section-title">' + t('settings.notify.title') + '</h2>' +
          '</div>' +
          '<p class="settings-section-desc">' + t('settings.notify.desc') + '</p>' +
          '<div class="settings-card" id="settings-task-notification-card">' +
            '<div class="settings-card-row">' +
              '<div class="settings-card-info">' +
                '<span class="settings-card-title">' + t('settings.notify.label') + '</span>' +
                '<p class="settings-card-desc">' + t('settings.notify.hint') + '</p>' +
              '</div>' +
              '<div class="settings-card-control">' +
                '<label class="config-default-switch settings-card-switch" title="' + t('settings.notify.label') + '">' +
                  '<input type="checkbox" id="settings-task-done-notification" />' +
                  '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="settings-section settings-section-spaced" id="settings-security-section">' +
          '<div class="settings-section-head">' +
            '<h2 class="settings-section-title">' + t('settings.security.title') + '</h2>' +
            '<span class="settings-section-loading" id="settings-security-loading" aria-hidden="true">' + t('common.loading') + '</span>' +
          '</div>' +
          '<p class="settings-section-desc">' + t('settings.security.desc') + '</p>' +
          '<div class="settings-security-grid">' +
          '<div class="settings-card" id="settings-skip-permission-card" hidden>' +
            '<div class="settings-card-row">' +
              '<div class="settings-card-info">' +
                '<div class="settings-card-title-row">' +
                  '<span class="settings-card-title">' + t('settings.skip.label') + '</span>' +
                  '<span class="config-badge is-error settings-risk-badge" id="settings-skip-risk-badge" hidden>' + t('settings.skip.risk') + '</span>' +
                '</div>' +
                '<p class="settings-card-desc">' + t('settings.skip.hint') + '</p>' +
              '</div>' +
              '<div class="settings-card-control">' +
                '<label class="config-default-switch settings-card-switch" title="' + t('settings.skip.label') + '">' +
                  '<input type="checkbox" id="settings-skip-permission-input" />' +
                  '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="settings-card settings-blacklist-card" id="settings-blacklist-card" hidden>' +
            '<div class="settings-card-header">' +
              '<div class="settings-card-info">' +
                '<div class="settings-card-title-row">' +
                  '<span class="settings-card-title">' + t('settings.rules.label') + '</span>' +
                  '<span class="config-badge is-starting" id="settings-blacklist-count">' + t('settings.rules.count', { n: 0 }) + '</span>' +
                '</div>' +
                '<p class="settings-card-desc">' + t('settings.rules.desc') + '</p>' +
                '<div class="settings-shell-rules-panel">' +
                  '<ul class="settings-shell-rules-list">' +
                    '<li>' + t('settings.rules.itemMatch') + '</li>' +
                    '<li>' + t('settings.rules.itemSkip') + '</li>' +
                    '<li>' + t('settings.rules.itemOther') + '</li>' +
                  '</ul>' +
                '</div>' +
                '<p class="settings-card-desc settings-card-desc--footnote">' + t('settings.rules.footnote') + '</p>' +
              '</div>' +
            '</div>' +
            '<div class="settings-blacklist-editor">' +
              '<textarea class="settings-blacklist-textarea" id="settings-blacklist-textarea" spellcheck="false" placeholder="rm\\s+-rf&#10;git\\s+reset\\s+--hard"></textarea>' +
            '</div>' +
            '<div class="settings-card-footer">' +
              '<button type="button" class="btn btn-secondary" id="settings-blacklist-reset">' + t('settings.data.reset') + '</button>' +
              '<button type="button" class="btn btn-primary" id="settings-blacklist-save">' + t('settings.rules.save') + '</button>' +
            '</div>' +
          '</div>' +
          '</div>' +
        '</section>' +
        '<section class="settings-section settings-section-spaced" id="settings-other-section" hidden>' +
          '<h2 class="settings-section-title">' + t('settings.other.title') + '</h2>' +
          '<div class="settings-card" id="settings-screen-ping-row">' +
            '<div class="settings-card-row">' +
              '<div class="settings-card-info">' +
                '<span class="settings-card-title">' + t('settings.wheel.label') + '</span>' +
                '<p class="settings-card-desc" id="settings-screen-ping-hint">' + t('settings.wheel.hint') + '</p>' +
              '</div>' +
              '<div class="settings-card-control">' +
                '<label class="config-default-switch settings-card-switch" title="' + t('settings.wheel.label') + '">' +
                  '<input type="checkbox" id="settings-screen-ping" />' +
                  '<span class="config-default-switch-track" aria-hidden="true"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +
      '</div>';

    if (window.AppIcon) window.AppIcon.hydrate(parentEl);
    bindLocaleOptions(parentEl);
    bindThemeOptions(parentEl, shell);
    bindDataDirectorySettings(parentEl);
    loadGeneralSecuritySettings(parentEl);
    bindEtlSettings(parentEl);
    bindScreenPingSettings(parentEl);
    bindTaskNotificationSettings(parentEl);
  }

  function syncEtlSettingsUi(parentEl, prefs) {
    if (!prefs) {
      prefs = window.EtlPrefs && typeof window.EtlPrefs.get === 'function'
        ? window.EtlPrefs.get()
        : {};
    }

    const showPanel = !!prefs.showTransparencyPanel;
    const subgroupDisabled = !showPanel;

    const showPanelInput = parentEl.querySelector('#etl-show-panel');
    const subgroup = parentEl.querySelector('#settings-etl-subgroup');

    if (showPanelInput) {
      showPanelInput.checked = showPanel;
      showPanelInput.disabled = false;
    }
    if (subgroup) subgroup.classList.toggle('is-disabled', subgroupDisabled);

    const panelDefaultExpanded = parentEl.querySelector('#etl-panel-default-expanded');
    const panelAutoCollapse = parentEl.querySelector('#etl-panel-auto-collapse');
    const showDesktopPet = parentEl.querySelector('#etl-show-desktop-pet');

    if (panelDefaultExpanded) {
      panelDefaultExpanded.checked = prefs.panelDefaultExpanded !== false;
      panelDefaultExpanded.disabled = subgroupDisabled;
    }
    if (panelAutoCollapse) {
      panelAutoCollapse.checked = prefs.panelAutoCollapse === true;
      panelAutoCollapse.disabled = subgroupDisabled;
    }
    if (showDesktopPet) {
      showDesktopPet.checked = prefs.showDesktopPet !== false;
      showDesktopPet.disabled = false;
    }
  }

  function syncTaskNotificationUi(parentEl, prefs) {
    if (!prefs) {
      prefs = window.EtlPrefs && typeof window.EtlPrefs.get === 'function'
        ? window.EtlPrefs.get()
        : {};
    }
    const taskDoneNotification = parentEl.querySelector('#settings-task-done-notification');
    if (taskDoneNotification) {
      taskDoneNotification.checked = prefs.taskDoneNotification === true;
      taskDoneNotification.disabled = !(
        window.iceDesktop
        && typeof window.iceDesktop.notifyTaskDone === 'function'
      );
    }
  }

  function bindTaskNotificationSettings(parentEl) {
    if (!parentEl || !window.EtlPrefs) return;
    if (parentEl._taskNotificationBound) return;
    parentEl._taskNotificationBound = true;

    syncTaskNotificationUi(parentEl);

    const taskDoneNotification = parentEl.querySelector('#settings-task-done-notification');
    if (taskDoneNotification) {
      taskDoneNotification.addEventListener('change', () => {
        const next = taskDoneNotification.checked;
        taskDoneNotification.disabled = true;
        window.EtlPrefs.set({ taskDoneNotification: next })
          .then((ok) => {
            if (!ok) throw new Error(t('common.updateFailed'));
            syncTaskNotificationUi(parentEl);
            if (window.Notification) {
              window.Notification.success(
                next ? t('settings.notify.on') : t('settings.notify.off')
              );
            }
          })
          .catch((err) => {
            taskDoneNotification.checked = !next;
            syncTaskNotificationUi(parentEl);
            if (window.Notification) {
              window.Notification.error((err && err.message) || t('common.updateFailed'));
            }
          })
          .finally(() => { taskDoneNotification.disabled = false; });
      });
    }

    window.EtlPrefs.whenReady().then(() => {
      syncTaskNotificationUi(parentEl);
    });

    if (typeof parentEl._taskNotificationUnsubscribe !== 'function') {
      parentEl._taskNotificationUnsubscribe = window.EtlPrefs.onChange(() => {
        syncTaskNotificationUi(parentEl);
      });
    }
  }

  function bindEtlSettings(parentEl) {
    if (!parentEl || !window.EtlPrefs) return;
    if (parentEl._etlBound) return;
    parentEl._etlBound = true;

    syncEtlSettingsUi(parentEl);

    const showPanelInput = parentEl.querySelector('#etl-show-panel');
    if (showPanelInput) {
      showPanelInput.addEventListener('change', () => {
        const next = showPanelInput.checked;
        showPanelInput.disabled = true;
        window.EtlPrefs.set({ showTransparencyPanel: next })
          .then((ok) => {
            if (!ok) throw new Error(t('common.updateFailed'));
            syncEtlSettingsUi(parentEl);
            if (window.Notification) {
              window.Notification.success(
                next ? t('settings.workbench.on') : t('settings.workbench.off')
              );
            }
          })
          .catch((err) => {
            showPanelInput.checked = !next;
            syncEtlSettingsUi(parentEl);
            if (window.Notification) {
              window.Notification.error((err && err.message) || t('common.updateFailed'));
            }
          })
          .finally(() => { syncEtlSettingsUi(parentEl); });
      });
    }

    const panelDefaultExpanded = parentEl.querySelector('#etl-panel-default-expanded');
    if (panelDefaultExpanded) {
      panelDefaultExpanded.addEventListener('change', () => {
        const next = panelDefaultExpanded.checked;
        panelDefaultExpanded.disabled = true;
        window.EtlPrefs.set({ panelDefaultExpanded: next })
          .catch(() => {
            panelDefaultExpanded.checked = !next;
            if (window.Notification) window.Notification.error(t('common.updateFailed'));
          })
          .finally(() => { syncEtlSettingsUi(parentEl); });
      });
    }

    const panelAutoCollapse = parentEl.querySelector('#etl-panel-auto-collapse');
    if (panelAutoCollapse) {
      panelAutoCollapse.addEventListener('change', () => {
        const next = panelAutoCollapse.checked;
        panelAutoCollapse.disabled = true;
        window.EtlPrefs.set({ panelAutoCollapse: next })
          .catch(() => {
            panelAutoCollapse.checked = !next;
            if (window.Notification) window.Notification.error(t('common.updateFailed'));
          })
          .finally(() => { syncEtlSettingsUi(parentEl); });
      });
    }

    const showDesktopPet = parentEl.querySelector('#etl-show-desktop-pet');
    if (showDesktopPet) {
      showDesktopPet.addEventListener('change', () => {
        const next = showDesktopPet.checked;
        showDesktopPet.disabled = true;
        window.EtlPrefs.set({ showDesktopPet: next })
          .catch(() => {
            showDesktopPet.checked = !next;
            if (window.Notification) window.Notification.error(t('common.updateFailed'));
          })
          .finally(() => { syncEtlSettingsUi(parentEl); });
      });
    }

    window.EtlPrefs.whenReady().then(() => {
      syncEtlSettingsUi(parentEl);
    });

    activateEtlSettings(parentEl);
  }

  function activateEtlSettings(parentEl) {
    if (!parentEl || !window.EtlPrefs) return;
    syncEtlSettingsUi(parentEl);
    if (typeof parentEl._etlUnsubscribe !== 'function') {
      parentEl._etlUnsubscribe = window.EtlPrefs.onChange(() => {
        syncEtlSettingsUi(parentEl);
      });
    }
  }

  function unbindEtlSettings(parentEl) {
    if (!parentEl) return;
    if (typeof parentEl._etlUnsubscribe === 'function') {
      parentEl._etlUnsubscribe();
      parentEl._etlUnsubscribe = null;
    }
  }

  function bindScreenPingSettings(parentEl) {
    const section = parentEl.querySelector('#settings-other-section');
    const row = parentEl.querySelector('#settings-screen-ping-row');
    const input = parentEl.querySelector('#settings-screen-ping');
    const hint = parentEl.querySelector('#settings-screen-ping-hint');
    const desktop = window.iceDesktop;
    if (!section || !row || !input || !desktop || typeof desktop.getScreenPing !== 'function') return;

    section.hidden = false;
    const apply = (state) => {
      input.checked = !!state.enabled;
      input.disabled = !state.supported;
      if (!state.supported && hint) hint.textContent = t('settings.wheel.windowsOnly');
    };
    desktop.getScreenPing().then(apply).catch(() => {
      section.hidden = true;
    });
    input.addEventListener('change', () => {
      const next = input.checked;
      input.disabled = true;
      desktop.setScreenPing({ enabled: next })
        .then((state) => {
          apply(state);
          if (window.Notification) {
            window.Notification.success(state.enabled ? t('settings.wheel.on') : t('settings.wheel.off'));
          }
        })
        .catch(() => {
          input.checked = !next;
          input.disabled = false;
          if (window.Notification) window.Notification.error(t('common.updateFailed'));
        });
    });
  }

  function bindDataDirectorySettings(parentEl) {
    const desktop = window.iceDesktop;
    const migrationTip = t('settings.data.migration');

    const input = parentEl.querySelector('#settings-data-directory-input');
    const browseBtn = parentEl.querySelector('#settings-data-directory-browse');
    const saveBtn = parentEl.querySelector('#settings-data-directory-save');
    const resetBtn = parentEl.querySelector('#settings-data-directory-reset');
    const badge = parentEl.querySelector('#settings-data-directory-env-badge');
    const note = parentEl.querySelector('#settings-data-directory-note');
    if (!input || !browseBtn || !saveBtn || !resetBtn) return;

    const canPickFolder = desktop && typeof desktop.pickDataDirectory === 'function';
    if (!canPickFolder) {
      browseBtn.disabled = true;
      browseBtn.title = t('settings.data.browserPath');
    }

    function applyPayload(data) {
      if (!data) return;
      input.value = data.dataDir || '';
      const persistable = !!data.canPersist;
      input.disabled = !persistable;
      saveBtn.disabled = !persistable;
      resetBtn.disabled = !persistable;
      browseBtn.disabled = !persistable || !canPickFolder;
      if (badge) {
        badge.textContent = persistable ? t('settings.data.editable') : t('settings.data.dev');
        badge.classList.remove('is-off');
        badge.classList.toggle('is-ready', persistable);
        badge.classList.toggle('is-starting', !persistable);
      }
    }

    function showError(err) {
      const message = (err && err.message) || t('common.operationFailed');
      if (window.Notification) window.Notification.error(message);
    }

    if (note) note.textContent = migrationTip;

    fetch('/api/config/data-directory', { cache: 'no-store' })
      .then((res) =>  res.json())
      .then(applyPayload)
      .catch(() => { showError({ message: t('settings.data.readFailed') }); });

    browseBtn.addEventListener('click', () => {
      if (!canPickFolder) return;
      desktop.pickDataDirectory()
        .then((dataDir) => {
          if (dataDir) input.value = dataDir;
        })
        .catch(() => { showError({ message: t('settings.data.pickFailed') }); });
    });

    saveBtn.addEventListener('click', () => {
      const dataDir = input.value.trim();
      if (!dataDir) {
        showError({ message: t('settings.data.required') });
        return;
      }
      saveBtn.disabled = true;
      fetch('/api/config/data-directory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataDir }),
      })
        .then((res) =>  res.json().then((data) => {
            if (!res.ok) throw new Error(data && data.error || t('common.saveFailed'));
            return data;
          }))
        .then((data) => {
          applyPayload(data);
          if (window.Notification) window.Notification.success(t('settings.data.saved'));
        })
        .catch(showError)
        .finally(() => { saveBtn.disabled = false; });
    });

    resetBtn.addEventListener('click', () => {
      resetBtn.disabled = true;
      fetch('/api/config/data-directory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataDir: null }),
      })
        .then((res) =>  res.json().then((data) => {
            if (!res.ok) throw new Error(data && data.error || t('settings.data.restoreFailed'));
            return data;
          }))
        .then((data) => {
          applyPayload(data);
          if (window.Notification) window.Notification.success(t('settings.data.saved'));
        })
        .catch(showError)
        .finally(() => { resetBtn.disabled = false; });
    });
  }

  function bindThemeOptions(parentEl, shell) {
    const options = parentEl.querySelectorAll('.settings-theme-option');
    for (let i = 0; i < options.length; i++) {
      ((btn) => {
        btn.addEventListener('click', () => {
          const next = btn.getAttribute('data-theme');
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
      .map((line) =>  line.trim())
      .filter((line) =>  line.length > 0);
  }

  function updateBlacklistCount(parentEl, patterns) {
    const countEl = parentEl.querySelector('#settings-blacklist-count');
    if (!countEl) return;
    const n = patterns ? patterns.length : 0;
    countEl.textContent = t('settings.rules.count', { n });
  }

  function syncSkipPermissionUi(parentEl, enabled) {
    const input = parentEl.querySelector('#settings-skip-permission-input');
    const badge = parentEl.querySelector('#settings-skip-risk-badge');
    if (input) input.checked = !!enabled;
    if (badge) badge.hidden = !enabled;
  }

  function loadGeneralSecuritySettings(parentEl) {
    fetch('/api/config')
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed');
        return res.json();
      })
      .then((data) => {
        if (data && data.error) throw new Error(data.error);

        const loading = parentEl.querySelector('#settings-security-loading');
        const skipCard = parentEl.querySelector('#settings-skip-permission-card');
        const blacklistCard = parentEl.querySelector('#settings-blacklist-card');
        const subAgentCard = parentEl.querySelector('#settings-sub-agents-card');
        const windowsCard = parentEl.querySelector('#settings-use-windows-card');
        if (loading) loading.hidden = true;
        if (skipCard) skipCard.hidden = false;
        if (blacklistCard) blacklistCard.hidden = false;
        if (subAgentCard) subAgentCard.hidden = false;
        if (windowsCard) windowsCard.hidden = false;

        const skipEnabled = data && data.skipPermissionChecks === true;
        syncSkipPermissionUi(parentEl, skipEnabled);
        const subAgentInput = parentEl.querySelector('#settings-sub-agents-input');
        if (subAgentInput) subAgentInput.checked = !data || data.enableSubAgents !== false;
        syncUseWindowsUi(parentEl, data);

        const patterns = (data && Array.isArray(data.shellBlacklist)) ? data.shellBlacklist : [];
        const textarea = parentEl.querySelector('#settings-blacklist-textarea');
        if (textarea) {
          textarea.value = patterns.join('\n');
          textarea.dataset.savedValue = textarea.value;
        }
        updateBlacklistCount(parentEl, patterns);

        bindGeneralSecurityEvents(parentEl);
      })
      .catch(() => {
        const loading = parentEl.querySelector('#settings-security-loading');
        const skipCard = parentEl.querySelector('#settings-skip-permission-card');
        const blacklistCard = parentEl.querySelector('#settings-blacklist-card');
        const subAgentCard = parentEl.querySelector('#settings-sub-agents-card');
        const windowsCard = parentEl.querySelector('#settings-use-windows-card');
        if (loading) {
          loading.textContent = t('settings.security.failed');
          loading.classList.add('is-error');
        }
        if (skipCard) skipCard.hidden = false;
        if (blacklistCard) blacklistCard.hidden = false;
        if (subAgentCard) subAgentCard.hidden = false;
        if (windowsCard) windowsCard.hidden = false;
        bindGeneralSecurityEvents(parentEl);
        if (window.Notification) window.Notification.error(t('settings.security.loadFailed'));
      });
  }

  function syncUseWindowsUi(parentEl, data) {
    const input = parentEl.querySelector('#settings-use-windows-input');
    const desc = parentEl.querySelector('#settings-use-windows-desc');
    const supported = !data || data.useWindowsSupported !== false;
    if (input) {
      input.checked = !!(data && data.useWindows === true);
      input.disabled = !supported;
      input.dataset.supported = supported ? '1' : '0';
    }
    if (desc && !supported) {
      desc.textContent = t('settings.windows.unsupported');
    }
  }

  function bindGeneralSecurityEvents(parentEl) {
    if (parentEl._securityBound) return;
    parentEl._securityBound = true;

    const windowsInput = parentEl.querySelector('#settings-use-windows-input');
    if (windowsInput) {
      windowsInput.addEventListener('change', () => {
        if (windowsInput.dataset.supported === '0') {
          windowsInput.checked = false;
          return;
        }
        const next = windowsInput.checked;
        windowsInput.disabled = true;
        fetch('/api/config/use-windows', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ useWindows: next }),
        })
          .then((res) => { return res.json().then((body) => ({ ok: res.ok, body })); })
          .then((result) => {
            if (result.ok && result.body.success) {
              windowsInput.checked = result.body.useWindows === true;
              if (window.Notification) {
                window.Notification.success(
                  windowsInput.checked
                    ? t('settings.windows.on')
                    : t('settings.windows.off')
                );
              }
            } else {
              windowsInput.checked = !next;
              if (window.Notification) {
                window.Notification.error((result.body && result.body.error) || t('common.updateFailed'));
              }
            }
          })
          .catch(() => {
            windowsInput.checked = !next;
            if (window.Notification) window.Notification.error(t('common.updateFailed'));
          })
          .finally(() => {
            windowsInput.disabled = windowsInput.dataset.supported === '0';
          });
      });
    }

    const subAgentInput = parentEl.querySelector('#settings-sub-agents-input');
    if (subAgentInput) {
      subAgentInput.addEventListener('change', () => {
        const next = subAgentInput.checked;
        subAgentInput.disabled = true;
        fetch('/api/config/sub-agents', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enableSubAgents: next }),
        })
          .then((res) => { return res.json().then((body) => ({ ok: res.ok, body })); })
          .then((result) => {
            if (result.ok && result.body.success) {
              subAgentInput.checked = result.body.enableSubAgents !== false;
              if (window.Notification) {
                window.Notification.success(
                  subAgentInput.checked
                    ? t('settings.subagents.on')
                    : t('settings.subagents.off')
                );
              }
            } else {
              subAgentInput.checked = !next;
              if (window.Notification) {
                window.Notification.error((result.body && result.body.error) || t('common.updateFailed'));
              }
            }
          })
          .catch(() => {
            subAgentInput.checked = !next;
            if (window.Notification) window.Notification.error(t('common.updateFailed'));
          })
          .finally(() => { subAgentInput.disabled = false; });
      });
    }

    const skipInput = parentEl.querySelector('#settings-skip-permission-input');
    if (skipInput) {
      skipInput.addEventListener('change', () => {
        const next = skipInput.checked;
        skipInput.disabled = true;
        fetch('/api/config/skip-permission-checks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skipPermissionChecks: next }),
        })
          .then((res) => { return res.json().then((body) =>  ({ ok: res.ok, body })); })
          .then((result) => {
            if (result.ok && result.body.success) {
              syncSkipPermissionUi(parentEl, result.body.skipPermissionChecks === true);
              if (window.Notification) {
                window.Notification.success(
                  result.body.skipPermissionChecks
                    ? t('settings.skip.on')
                    : t('settings.skip.off')
                );
              }
            } else {
              skipInput.checked = !next;
              syncSkipPermissionUi(parentEl, skipInput.checked);
              if (window.Notification) {
                window.Notification.error((result.body && result.body.error) || t('common.updateFailed'));
              }
            }
          })
          .catch(() => {
            skipInput.checked = !next;
            syncSkipPermissionUi(parentEl, skipInput.checked);
            if (window.Notification) window.Notification.error(t('common.updateFailed'));
          })
          .finally(() => { skipInput.disabled = false; });
      });
    }

    const textarea = parentEl.querySelector('#settings-blacklist-textarea');
    if (textarea) {
      textarea.addEventListener('input', () => {
        updateBlacklistCount(parentEl, parseBlacklistText(textarea.value));
      });
    }

    const saveBtn = parentEl.querySelector('#settings-blacklist-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        if (!textarea) return;
        const patterns = parseBlacklistText(textarea.value);
        saveBtn.disabled = true;
        fetch('/api/config/shell-blacklist', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shellBlacklist: patterns }),
        })
          .then((res) => { return res.json().then((body) =>  ({ ok: res.ok, body })); })
          .then((result) => {
            if (result.ok && result.body.success) {
              const saved = result.body.shellBlacklist || [];
              textarea.value = saved.join('\n');
              textarea.dataset.savedValue = textarea.value;
              updateBlacklistCount(parentEl, saved);
              if (window.Notification) window.Notification.success(t('settings.rules.saved'));
            } else if (window.Notification) {
              window.Notification.error((result.body && result.body.error) || t('common.saveFailed'));
            }
          })
          .catch(() => {
            if (window.Notification) window.Notification.error(t('common.saveFailed'));
          })
          .finally(() => { saveBtn.disabled = false; });
      });
    }

    const resetBtn = parentEl.querySelector('#settings-blacklist-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        resetBtn.disabled = true;
        fetch('/api/config/shell-blacklist-defaults')
          .then((res) =>  res.json())
          .then((data) => {
            const defaults = (data && Array.isArray(data.shellBlacklist)) ? data.shellBlacklist : [];
            if (textarea) {
              textarea.value = defaults.join('\n');
              updateBlacklistCount(parentEl, defaults);
            }
            if (window.Notification) window.Notification.info(t('settings.rules.filled'));
          })
          .catch(() => {
            if (window.Notification) window.Notification.error(t('settings.rules.defaultsFailed'));
          })
          .finally(() => { resetBtn.disabled = false; });
      });
    }
  }

  function syncThemeOptions(panelEl) {
    if (!panelEl) return;
    const shell = window.AppShell;
    const theme = (shell && typeof shell.getTheme === 'function') ? shell.getTheme() : 'dark';
    const options = panelEl.querySelectorAll('.settings-theme-option');
    for (let i = 0; i < options.length; i++) {
      const btn = options[i];
      const on = btn.getAttribute('data-theme') === theme;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function render(parentEl) {
    container = parentEl;

    const showSetupBanner = window.AppRouter
      && window.AppRouter.isSetupRequired
      && window.AppRouter.isSetupRequired();
    activeTab = showSetupBanner ? 'model' : 'general';

    parentEl.innerHTML =
      '<div class="config-center settings-center">' +
        '<header class="config-center-header">' +
          '<div class="config-center-header-text">' +
            '<h1 class="config-center-title">' + t('settings.title') + '</h1>' +
            '<p class="config-center-subtitle">' + t('settings.subtitle') + '</p>' +
            '<p class="config-center-format-hint">' + t('settings.apiHint') + '</p>' +
          '</div>' +
        '</header>' +
        '<nav class="config-tabs" role="tablist" aria-label="' + t('settings.tabs') + '">' +
          '<button type="button" class="config-tab' + (activeTab === 'general' ? ' is-active' : '') + '" data-tab="general" role="tab" aria-selected="' + (activeTab === 'general' ? 'true' : 'false') + '">' + t('settings.tab.general') + '</button>' +
          '<button type="button" class="config-tab' + (activeTab === 'model' ? ' is-active' : '') + '" data-tab="model" role="tab" aria-selected="' + (activeTab === 'model' ? 'true' : 'false') + '">' + t('settings.tab.models') + '</button>' +
          '<button type="button" class="config-tab' + (activeTab === 'mcp' ? ' is-active' : '') + '" data-tab="mcp" role="tab" aria-selected="' + (activeTab === 'mcp' ? 'true' : 'false') + '">' + t('settings.tab.mcp') + '</button>' +
        '</nav>' +
        '<div class="config-tab-panels">' +
          '<div class="config-tab-panel' + (activeTab === 'general' ? ' is-active' : '') + '" data-panel="general" role="tabpanel" id="config-tab-general"' + (activeTab === 'general' ? '' : ' hidden') + '></div>' +
          '<div class="config-tab-panel' + (activeTab === 'model' ? ' is-active' : '') + '" data-panel="model" role="tabpanel" id="config-tab-model"' + (activeTab === 'model' ? '' : ' hidden') + '></div>' +
          '<div class="config-tab-panel' + (activeTab === 'mcp' ? ' is-active' : '') + '" data-panel="mcp" role="tabpanel" id="config-tab-mcp"' + (activeTab === 'mcp' ? '' : ' hidden') + '></div>' +
        '</div>' +
      '</div>';

    container = parentEl.querySelector('.config-center') || parentEl;
    bindMobileBlankDismiss(container);

    const tabs = parentEl.querySelectorAll('.config-tab');
    for (let i = 0; i < tabs.length; i++) {
      ((tab) => {
        tab.addEventListener('click', () => {
          setActiveTab(tab.getAttribute('data-tab'));
        });
      })(tabs[i]);
    }

    renderGeneralPanel(parentEl.querySelector('#config-tab-general'));

    if (window.ModelConfigPanel) {
      window.ModelConfigPanel.render(parentEl.querySelector('#config-tab-model'), {
        showSetupBanner
      });
    }

    setActiveTab(activeTab);
  }

  function setActiveTab(tab) {
    if (!tab) return;

    const switching = tab !== activeTab;
    activeTab = tab;

    const tabs = container.querySelectorAll('.config-tab');
    for (let i = 0; i < tabs.length; i++) {
      const on = tabs[i].getAttribute('data-tab') === tab;
      tabs[i].classList.toggle('is-active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }

    const panels = container.querySelectorAll('.config-tab-panel');
    for (let j = 0; j < panels.length; j++) {
      const panelOn = panels[j].getAttribute('data-panel') === tab;
      panels[j].classList.toggle('is-active', panelOn);
      panels[j].hidden = !panelOn;
    }

    if (tab === 'mcp' && window.McpConfigPanel) {
      const mcpEl = container.querySelector('#config-tab-mcp');
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
    if (container) {
      unbindEtlSettings(container.querySelector('#config-tab-general'));
    }
  }

  function onActivate() {
    if (container) {
      activateEtlSettings(container.querySelector('#config-tab-general'));
    }
  }

  return { render, onActivate, onDeactivate };
})();

export const ConfigPage = SettingsPage;
if (typeof window !== 'undefined') {
  window.ConfigPage = SettingsPage;
}

if (typeof window !== 'undefined') {
  window.SettingsPage = SettingsPage;
}
