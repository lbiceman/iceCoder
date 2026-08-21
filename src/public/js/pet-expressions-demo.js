/**
 * 冰豆表情联调页入口（ESM，便于 session-pet 再导出 palette）
 */
import './session-pet.js';
import { SESSION_PET_PALETTE_COLORS } from './session-pet-palette.js';
import { HARNESS_PET_DEMO, HARNESS_PET_DEMO_EXTRAS } from './session-pet-harness-expr.js';

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

function selectState(name, btn, title) {
  if (currentBtn) currentBtn.classList.remove('active');
  currentBtn = btn || null;
  if (btn) btn.classList.add('active');
  pet.setState(name);
  label.textContent = title || name;
  pet.setBubbleText(title || name);
  pet.setTurnLabel(name);
}

function addSection(text) {
  var h = document.createElement('div');
  h.className = 'pet-demo-section';
  h.textContent = text;
  panel.appendChild(h);
}

function addHarnessButtons(items) {
  for (var i = 0; i < items.length; i++) {
    (function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pet-demo-btn';
      btn.setAttribute('data-state', item.state);
      btn.appendChild(document.createTextNode(item.title));
      var sub = document.createElement('small');
      sub.textContent = item.why;
      btn.appendChild(sub);
      btn.addEventListener('click', function () {
        selectState(item.state, btn, item.title);
      });
      panel.appendChild(btn);
    })(items[i]);
  }
}

addSection('Harness 候选（JS 绘制 + 动画，未接入）');
addHarnessButtons(HARNESS_PET_DEMO);
addSection('运行中常见（同样未接入）');
addHarnessButtons(HARNESS_PET_DEMO_EXTRAS);

var first = panel.querySelector('[data-state="idle"]');
if (first) selectState('idle', first, '空闲');
