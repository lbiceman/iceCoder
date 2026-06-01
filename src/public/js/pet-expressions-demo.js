/**
 * 冰豆表情联调页入口（ESM，便于 session-pet 再导出 palette）
 */
import './session-pet.js';
import { SESSION_PET_PALETTE_COLORS } from './session-pet-palette.js';

var EXPRESSIONS = [
  'idle',
  'happy',
  'thinking',
  'working',
  'confused',
  'alert',
  'anxious',
  'rest',
  'surprised',
  'sad',
  'crying',
  'angry',
  'curious',
  'dizzy',
  'shy',
  'love',
  'weary',
  'focused',
  'read',
  'determined',
  'playful',
];

var root = document.getElementById('pet-root');
var label = document.getElementById('state-label');
var panel = document.getElementById('pet-demo-panel');
var pet = window.SessionPet.create(root);
var currentBtn = null;

var ringSlider = document.getElementById('pet-ring-slider');
var ringValueEl = document.getElementById('pet-ring-value');
var colorsWrap = document.getElementById('pet-demo-colors');
var selectedSwatch = null;

function syncRingFromSlider() {
  var v = Math.max(0, Math.min(100, Number(ringSlider.value) || 0));
  ringSlider.value = String(v);
  ringValueEl.textContent = v + '%';
  ringSlider.setAttribute('aria-valuenow', String(v));
  pet.setTokenUsage(v, 100, 0);
}

if (ringSlider && ringValueEl) {
  ringSlider.addEventListener('input', syncRingFromSlider);
  ringSlider.addEventListener('change', syncRingFromSlider);
  syncRingFromSlider();
}

if (colorsWrap) {
  for (var c = 0; c < SESSION_PET_PALETTE_COLORS.length; c++) {
    (function (hex) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pet-demo-swatch';
      btn.style.backgroundColor = hex;
      btn.title = hex;
      btn.setAttribute('aria-label', '眼睛颜色 ' + hex);
      btn.addEventListener('click', function () {
        pet.setEyeColor(hex);
        if (selectedSwatch) selectedSwatch.classList.remove('selected');
        btn.classList.add('selected');
        selectedSwatch = btn;
      });
      colorsWrap.appendChild(btn);
    })(SESSION_PET_PALETTE_COLORS[c]);
  }
}

function selectState(name, btn) {
  if (currentBtn) currentBtn.classList.remove('active');
  currentBtn = btn || null;
  if (btn) btn.classList.add('active');
  pet.setState(name);
  label.textContent = name;
  pet.setBubbleText(name);
}

for (var i = 0; i < EXPRESSIONS.length; i++) {
  (function (name) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pet-demo-btn';
    btn.textContent = name;
    btn.setAttribute('data-state', name);
    btn.addEventListener('click', function () {
      selectState(name, btn);
    });
    panel.appendChild(btn);
  })(EXPRESSIONS[i]);
}

if (panel.firstChild) {
  selectState('idle', panel.firstChild);
}
