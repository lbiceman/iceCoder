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

function initFloatingWindowDrag(el) {
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

var dragState = canvas ? initFloatingWindowDrag(canvas) : null;

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
