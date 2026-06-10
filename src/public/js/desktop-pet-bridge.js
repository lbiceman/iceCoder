/**
 * Electron 桌面版：主窗冰豆 → IPC 快照同步；响应 embedded 显隐。
 * 仅当 preload 注入 window.iceDesktop 时生效。
 */
(function () {
  'use strict';

  if (!window.iceDesktop) return;

  var petRef = null;
  var snapshot = {
    state: 'idle',
    bubbleText: '',
    turnLabel: '',
    tokenUsed: 0,
    tokenMax: 0,
    tokenOutput: 0,
    eyeColor: '',
  };

  function pushSnapshot() {
    var api = window.iceDesktop;
    if (!api || typeof api.petPushState !== 'function') return;
    api.petPushState({
      state: snapshot.state,
      bubbleText: snapshot.bubbleText,
      turnLabel: snapshot.turnLabel,
      tokenUsed: snapshot.tokenUsed,
      tokenMax: snapshot.tokenMax,
      tokenOutput: snapshot.tokenOutput,
      eyeColor: snapshot.eyeColor,
    });
  }

  function wrapSetter(pet, method, apply) {
    var orig = pet[method];
    if (typeof orig !== 'function') return;
    pet[method] = function () {
      orig.apply(pet, arguments);
      apply.apply(null, arguments);
      pushSnapshot();
    };
  }

  function setEmbeddedVisible(visible) {
    var bar = document.getElementById('agent-status-bar');
    if (!bar) return;
    bar.classList.toggle('session-pet-indicator--desktop-hidden', !visible);
    bar.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function attach(pet) {
    if (!pet) return;
    petRef = pet;
    wrapSetter(pet, 'setState', function (s) {
      snapshot.state = s || 'idle';
    });
    wrapSetter(pet, 'setBubbleText', function (t) {
      snapshot.bubbleText = t || '';
    });
    wrapSetter(pet, 'setTurnLabel', function (t) {
      snapshot.turnLabel = t || '';
    });
    wrapSetter(pet, 'setTokenUsage', function (used, max, output) {
      snapshot.tokenUsed = used || 0;
      snapshot.tokenMax = max || 0;
      snapshot.tokenOutput = output || 0;
    });
    wrapSetter(pet, 'setEyeColor', function (hex) {
      snapshot.eyeColor = hex || '';
    });
    wrapSetter(pet, 'setVisible', function () {
      /* 可见性由 desktop 模式控制，快照仍随状态更新 */
    });

    if (typeof window.iceDesktop.onPetForceVisible === 'function') {
      window.iceDesktop.onPetForceVisible(function (visible) {
        setEmbeddedVisible(!!visible);
      });
    }

    pushSnapshot();
  }

  window.DesktopPetBridge = {
    attach: attach,
    setEmbeddedVisible: setEmbeddedVisible,
  };
})();
