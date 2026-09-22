// @ts-nocheck
/**
 * Electron 桌面版：主窗冰豆 → IPC 快照同步；响应 embedded 显隐。
 * 仅当 preload 注入 window.iceDesktop 时生效。
 */
(() => {

  if (!window.iceDesktop) return;

  let petRef = null;
  const snapshot = {
    state: 'idle',
    bubbleText: '',
    turnLabel: '',
    tokenUsed: 0,
    tokenMax: 0,
    tokenOutput: 0,
    eyeColor: '',
  };

  function pushSnapshot() {
    const api = window.iceDesktop;
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
    const orig = pet[method];
    if (typeof orig !== 'function') return;
    pet[method] = (...args) => {
      orig.apply(pet, args);
      try { apply.apply(null, args); } catch (_e) { /* ignore */ }
      try { pushSnapshot(); } catch (_e2) { /* ignore */ }
    };
  }

  function setEmbeddedVisible(visible) {
    const bar = document.getElementById('agent-status-bar');
    if (!bar) return;
    bar.classList.toggle('session-pet-indicator--desktop-hidden', !visible);
    bar.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function attach(pet) {
    if (!pet) return;
    petRef = pet;
    wrapSetter(pet, 'setState', (s) => {
      snapshot.state = s || 'idle';
    });
    wrapSetter(pet, 'setBubbleText', (t) => {
      snapshot.bubbleText = t || '';
    });
    wrapSetter(pet, 'setTurnLabel', (t) => {
      snapshot.turnLabel = t || '';
    });
    wrapSetter(pet, 'setTokenUsage', (used, max, output) => {
      snapshot.tokenUsed = used || 0;
      snapshot.tokenMax = max || 0;
      snapshot.tokenOutput = output || 0;
    });
    wrapSetter(pet, 'setEyeColor', (hex) => {
      snapshot.eyeColor = hex || '';
    });
    wrapSetter(pet, 'setVisible', () => {
      /* 可见性由 desktop 模式控制，快照仍随状态更新 */
    });

    if (typeof window.iceDesktop.onPetForceVisible === 'function') {
      window.iceDesktop.onPetForceVisible((visible) => {
        setEmbeddedVisible(!!visible);
      });
    }

    pushSnapshot();
  }

  window.DesktopPetBridge = {
    attach,
    setEmbeddedVisible,
  };
})();

export const DesktopPetBridge = typeof window !== 'undefined' ? window.DesktopPetBridge : undefined;
