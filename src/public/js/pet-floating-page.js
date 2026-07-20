/**
 * 桌面悬浮冰豆 — 复用 SessionPet（与聊天页同一套 Canvas 渲染）
 */
import './session-pet.js';

function applyTheme(theme) {
  var t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
}

function readStoredTheme() {
  try {
    return localStorage.getItem('ice-theme') || 'dark';
  } catch (_e) {
    return 'dark';
  }
}

applyTheme(readStoredTheme());
window.addEventListener('storage', function (e) {
  if (e.key === 'ice-theme') applyTheme(e.newValue);
});

var DRAG_THRESHOLD = 5;

var root = document.getElementById('pet-root');
var canvas = document.getElementById('pet-canvas');
var pet = window.SessionPet.create(root, { enableDrag: false });

/**
 * 透明区 OS 级点击穿透：默认穿透，鼠标在 canvas 上时取消穿透以便拖/双击。
 * 依赖主进程 setIgnoreMouseEvents(true, { forward: true })。
 */
function initFloatingClickThrough(el, dragHooks) {
  var api = window.iceDesktop;
  if (!api || typeof api.petSetMousePassthrough !== 'function' || !el) return null;

  var passthrough = true;
  var pointerLocked = false;

  function setPassthrough(next) {
    if (passthrough === next) return;
    passthrough = next;
    api.petSetMousePassthrough(next);
  }

  function isOverInteractive(clientX, clientY) {
    var rect = el.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function syncFromPoint(clientX, clientY) {
    if (pointerLocked) {
      setPassthrough(false);
      return;
    }
    setPassthrough(!isOverInteractive(clientX, clientY));
  }

  document.addEventListener('mousemove', function (e) {
    syncFromPoint(e.clientX, e.clientY);
  });

  document.addEventListener('mouseleave', function () {
    if (!pointerLocked) setPassthrough(true);
  });

  if (dragHooks) {
    dragHooks.onPointerDown = function () {
      pointerLocked = true;
      setPassthrough(false);
    };
    dragHooks.onPointerUp = function (clientX, clientY) {
      pointerLocked = false;
      syncFromPoint(clientX, clientY);
    };
  }

  setPassthrough(true);
  return { syncFromPoint: syncFromPoint };
}

function initFloatingWindowDrag(el, dragHooks) {
  var api = window.iceDesktop;
  if (!api || typeof api.petDragMove !== 'function' || !el) return { moved: false };

  var dragId = null;
  var dragActive = false;
  var moved = false;
  var startX = 0;
  var startY = 0;
  var lastX = 0;
  var lastY = 0;

  el.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    dragId = e.pointerId;
    dragActive = false;
    moved = false;
    startX = e.screenX;
    startY = e.screenY;
    lastX = e.screenX;
    lastY = e.screenY;
    if (dragHooks && typeof dragHooks.onPointerDown === 'function') {
      dragHooks.onPointerDown();
    }
    try { el.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    e.preventDefault();
  });

  el.addEventListener('pointermove', function (e) {
    if (dragId === null || e.pointerId !== dragId) return;
    var totalDx = e.screenX - startX;
    var totalDy = e.screenY - startY;
    if (!dragActive) {
      if (Math.hypot(totalDx, totalDy) < DRAG_THRESHOLD) return;
      dragActive = true;
      moved = true;
      el.classList.add('pet-dragging');
    }
    var dx = e.screenX - lastX;
    var dy = e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;
    api.petDragMove(dx, dy);
  });

  function endDrag(e) {
    if (dragId === null || (e && e.pointerId !== dragId)) return;
    dragId = null;
    dragActive = false;
    el.classList.remove('pet-dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    if (dragHooks && typeof dragHooks.onPointerUp === 'function') {
      dragHooks.onPointerUp(e.clientX, e.clientY);
    }
  }

  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  return {
    consumeIfMoved: function () {
      if (!moved) return false;
      moved = false;
      return true;
    },
  };
}

var dragHooks = {};
var dragState = canvas ? initFloatingWindowDrag(canvas, dragHooks) : null;
initFloatingClickThrough(canvas, dragHooks);

function applySnapshot(snap) {
  if (!snap || !pet) return;
  if (snap.state) pet.setState(snap.state);
  if (snap.bubbleText !== undefined) pet.setBubbleText(snap.bubbleText);
  if (snap.turnLabel !== undefined) pet.setTurnLabel(snap.turnLabel);
  if (snap.eyeColor) pet.setEyeColor(snap.eyeColor);
  if (snap.tokenUsed !== undefined || snap.tokenMax !== undefined) {
    pet.setTokenUsage(snap.tokenUsed || 0, snap.tokenMax || 0, snap.tokenOutput || 0);
  }
  pet.setVisible(true);
}

var api = window.iceDesktop;
if (api) {
  if (typeof api.onPetStateSnapshot === 'function') {
    api.onPetStateSnapshot(applySnapshot);
  }
  if (typeof api.onPetMode === 'function') {
    api.onPetMode(function (mode) {
      pet.setVisible(mode === 'floating');
    });
  }
}

if (canvas) {
  canvas.setAttribute('tabindex', '-1');
  canvas.addEventListener('dblclick', function () {
    if (dragState && dragState.consumeIfMoved()) return;
    if (api && typeof api.petRequestShowMain === 'function') {
      api.petRequestShowMain();
    }
  });
  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });
}
