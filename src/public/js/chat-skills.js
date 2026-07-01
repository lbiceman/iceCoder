/**
 * 技能选择（# 触发）：选中技能显示在输入框上方 chip 栏，下方 textarea 仅输入提示词。
 */

/* exported ChatSkills */

window.ChatSkills = (function () {
  'use strict';

  var SKILLS_CHANGED = 'ice-skills-changed';
  /** 行首，或任意空白（空格/换行/制表等）之后输入 # */
  var SKILL_TRIGGER_RE = /(?:^|\s)#([^\s#]*)$/;

  var skillSelectedIndex = 0;
  var skillFiltered = [];
  var skillActivePrefix = '';
  var allSkills = [];
  var skillsLoading = false;
  var skillsLoaded = false;
  var applyTargetFn = null;
  var activeInputEl = null;
  var anchorEl = null;
  var chipBarEl = null;

  var selectedSkills = [];
  var pendingSkills = [];
  var chipBarFocused = false;
  var chipFocusIndex = -1;

  function dispatchInput(inputEl) {
    if (!inputEl) return;
    try {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_err) {
      var ev = document.createEvent('Event');
      ev.initEvent('input', true, true);
      inputEl.dispatchEvent(ev);
    }
  }

  function notifySkillsChanged() {
    window.dispatchEvent(new CustomEvent(SKILLS_CHANGED));
  }

  function skillToDropdownItem(skill) {
    return {
      name: skill.name || skill.filename,
      key: skill.filename,
      prefix: '',
    };
  }

  function updateActiveItem() {
    var dd = window.ChatDropdown && window.ChatDropdown.getContainer();
    if (!dd) return;
    var items = dd.querySelectorAll('.cmd-item');
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('active', j === skillSelectedIndex);
    }
  }

  function isOpen() {
    return !!(window.ChatDropdown && window.ChatDropdown.isOpen() && skillActivePrefix === '#');
  }

  function hide() {
    var shouldClose = skillActivePrefix === '#' && window.ChatDropdown && window.ChatDropdown.isOpen();
    skillFiltered = [];
    skillActivePrefix = '';
    if (shouldClose) window.ChatDropdown.close();
  }

  function openDropdown() {
    if (!window.ChatDropdown || !anchorEl) return;
    window.ChatDropdown.open({
      anchor: anchorEl,
      items: skillFiltered,
      placement: 'top',
      placementRef: 'anchor',
      align: 'start',
      fitContent: true,
      minWidth: 200,
      maxWidth: 320,
      markAnchorActive: false,
      onSelect: function (_item, idx) { applySelection(idx); },
      onClose: function () {
        skillFiltered = [];
        skillActivePrefix = '';
      },
    });
    setTimeout(updateActiveItem, 0);
  }

  function show(prefix, filter, inputEl) {
    if (prefix !== '#') { hide(); return; }
    if (window.ChatCommands && window.ChatCommands.isOpen && window.ChatCommands.isOpen()) {
      window.ChatCommands.hide();
    }
    skillActivePrefix = prefix;
    activeInputEl = inputEl || activeInputEl;
    var query = (filter || '').toLowerCase();

    function renderFiltered() {
      skillFiltered = allSkills
        .filter(function (sk) {
          var fn = (sk.filename || '').toLowerCase();
          var nm = (sk.name || '').toLowerCase();
          var desc = (sk.description || '').toLowerCase();
          return fn.indexOf(query) >= 0 || nm.indexOf(query) >= 0 || desc.indexOf(query) >= 0;
        })
        .map(skillToDropdownItem);
      if (skillFiltered.length === 0) { hide(); return; }
      skillSelectedIndex = 0;
      openDropdown();
    }

    if (skillsLoaded) {
      renderFiltered();
      return;
    }
    if (skillsLoading) return;
    skillsLoading = true;
    fetchSkills(function () {
      skillsLoading = false;
      renderFiltered();
    });
  }

  function setApplyTarget(fn) { applyTargetFn = typeof fn === 'function' ? fn : null; }
  function setAnchor(el) { anchorEl = el; }

  function getInputCursor(inputEl, val) {
    if (inputEl && typeof inputEl.selectionStart === 'number') {
      return inputEl.selectionStart;
    }
    return val != null ? String(val).length : 0;
  }

  function parseSkillTrigger(val, inputEl) {
    if (val == null && inputEl) val = inputEl.value || '';
    if (!val) return null;
    var cursor = getInputCursor(inputEl, val);
    var before = String(val).slice(0, cursor);
    var m = before.match(SKILL_TRIGGER_RE);
    if (!m) return null;
    return { filter: m[1] || '', matchLen: m[0].length, cursorEnd: cursor };
  }

  function isSkillTriggerVal(val, inputEl) {
    return !!parseSkillTrigger(val, inputEl);
  }

  function stripTriggerFromTextarea(inputEl) {
    if (!inputEl) return;
    var val = inputEl.value || '';
    var trigger = parseSkillTrigger(val, inputEl);
    if (!trigger) return;
    var end = trigger.cursorEnd != null ? trigger.cursorEnd : val.length;
    inputEl.value = val.slice(0, end - trigger.matchLen) + val.slice(end);
    dispatchInput(inputEl);
  }

  function renderChipBar() {
    if (!chipBarEl) return;
    chipBarEl.innerHTML = '';
    if (!selectedSkills.length) {
      chipBarEl.classList.add('hidden');
      chipBarFocused = false;
      chipFocusIndex = -1;
      return;
    }
    chipBarEl.classList.remove('hidden');
    for (var i = 0; i < selectedSkills.length; i++) {
      var fn = selectedSkills[i];
      var chip = document.createElement('span');
      chip.className = 'skill-chip';
      chip.setAttribute('role', 'option');
      chip.setAttribute('aria-selected', chipBarFocused && i === chipFocusIndex ? 'true' : 'false');
      chip.dataset.index = String(i);

      var label = document.createElement('span');
      label.className = 'skill-chip-label';
      label.textContent = '#' + fn;
      chip.appendChild(label);

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'skill-chip-remove';
      removeBtn.setAttribute('aria-label', '移除技能 ' + fn);
      removeBtn.textContent = '\u00D7';
      chip.appendChild(removeBtn);

      if (chipBarFocused && i === chipFocusIndex) chip.classList.add('is-selected');
      chipBarEl.appendChild(chip);
    }
  }

  function addSkill(filename) {
    var fn = String(filename || '').replace(/^#/, '');
    if (!fn) return;
    if (selectedSkills.indexOf(fn) >= 0) return;
    selectedSkills.push(fn);
    chipBarFocused = false;
    chipFocusIndex = -1;
    renderChipBar();
  }

  function focusComposerInput() {
    var input = activeInputEl || document.getElementById('chat-input');
    if (!input) return;
    setTimeout(function () { input.focus(); }, 0);
  }

  function drainPendingSkills() {
    var hadPending = pendingSkills.length > 0;
    while (pendingSkills.length) {
      addSkill(pendingSkills.shift());
    }
    if (hadPending) focusComposerInput();
  }

  /** 从技能库等页面选用技能：写入输入框上方 chip 栏并聚焦输入框 */
  function useSkill(filename) {
    var fn = String(filename || '').replace(/^#/, '');
    if (!fn) return;
    if (chipBarEl) {
      addSkill(fn);
      focusComposerInput();
    } else {
      pendingSkills.push(fn);
    }
  }

  function removeSkillAt(index) {
    if (index < 0 || index >= selectedSkills.length) return;
    selectedSkills.splice(index, 1);
    if (!selectedSkills.length) {
      chipBarFocused = false;
      chipFocusIndex = -1;
    } else if (chipFocusIndex >= selectedSkills.length) {
      chipFocusIndex = selectedSkills.length - 1;
    } else if (chipFocusIndex < 0) {
      chipFocusIndex = 0;
    }
    renderChipBar();
  }

  function focusChipBarEnd() {
    if (!selectedSkills.length) return false;
    chipBarFocused = true;
    chipFocusIndex = selectedSkills.length - 1;
    renderChipBar();
    return true;
  }

  function isChipBarFocused() {
    return chipBarFocused;
  }

  function clearChipSelection() {
    chipBarFocused = false;
    chipFocusIndex = -1;
    renderChipBar();
  }

  function getComposerText(inputEl) {
    var parts = [];
    for (var i = 0; i < selectedSkills.length; i++) {
      parts.push('#' + selectedSkills[i]);
    }
    var body = (inputEl && inputEl.value != null ? inputEl.value : '').replace(/\u00A0/g, ' ').trim();
    if (body) parts.push(body);
    return parts.join(' ');
  }

  function clearInput(inputEl) {
    selectedSkills = [];
    clearChipSelection();
    if (inputEl) inputEl.value = '';
    renderChipBar();
  }

  function clearSkillChipMode(inputEl) {
    clearInput(inputEl);
  }

  function applySelection(index, inputEl) {
    if (index < 0 || index >= skillFiltered.length) return null;
    var item = skillFiltered[index];
    var skill = allSkills.find(function (s) { return s.filename === item.key; });
    var built = skill ? { ref: '#' + skill.filename, body: '' } : { ref: '#' + (item.key || item.name || ''), body: '' };
    var targetInput = inputEl || activeInputEl;
    if (applyTargetFn) {
      applyTargetFn(built.ref);
    } else if (targetInput) {
      stripTriggerFromTextarea(targetInput);
      addSkill(built.ref.slice(1));
      targetInput.focus();
    }
    hide();
    return skill || item;
  }

  function handleChipBarKeydown(e, inputEl) {
    if (isOpen()) return false;
    if (!selectedSkills.length) return false;

    if (!chipBarFocused && e.key === 'ArrowUp' && !isOpen()) {
      e.preventDefault();
      chipBarFocused = true;
      chipFocusIndex = selectedSkills.length - 1;
      renderChipBar();
      return true;
    }

    if (!chipBarFocused) return false;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      chipFocusIndex = Math.max(0, chipFocusIndex - 1);
      renderChipBar();
      return true;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      chipFocusIndex = Math.min(selectedSkills.length - 1, chipFocusIndex + 1);
      renderChipBar();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      chipFocusIndex = Math.max(0, chipFocusIndex - 1);
      renderChipBar();
      return true;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (window.ChatFileRef && typeof window.ChatFileRef.focusChipBarFromAbove === 'function'
          && window.ChatFileRef.focusChipBarFromAbove()) {
        clearChipSelection();
        return true;
      }
      clearChipSelection();
      if (inputEl) inputEl.focus();
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      removeSkillAt(chipFocusIndex);
      if (!selectedSkills.length && inputEl) inputEl.focus();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      clearChipSelection();
      if (inputEl) inputEl.focus();
      return true;
    }
    return false;
  }

  function handleKeydown(e, inputEl) {
    if (handleChipBarKeydown(e, inputEl)) return true;
    if (!isOpen()) return false;
    activeInputEl = inputEl || activeInputEl;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      skillSelectedIndex = (skillSelectedIndex + 1) % Math.max(skillFiltered.length, 1);
      updateActiveItem();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      skillSelectedIndex = (skillSelectedIndex - 1 + skillFiltered.length) % Math.max(skillFiltered.length, 1);
      updateActiveItem();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applySelection(skillSelectedIndex, inputEl);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return true;
    }
    return false;
  }

  function handleInput(val, inputEl) {
    activeInputEl = inputEl || activeInputEl;
    if (chipBarFocused) clearChipSelection();
    var plain = val != null ? String(val) : (inputEl && inputEl.value) || '';
    var trigger = parseSkillTrigger(plain, inputEl);
    if (trigger) {
      show('#', trigger.filter, inputEl);
    } else if (skillActivePrefix === '#') {
      hide();
    }
  }

  function fetchSkills(cb) {
    fetch('/api/skills')
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body && body.success && Array.isArray(body.skills)) {
          allSkills = body.skills;
          skillsLoaded = true;
        }
        if (typeof cb === 'function') cb(allSkills);
      })
      .catch(function () { if (typeof cb === 'function') cb([]); });
  }

  function refreshSkills(cb) {
    skillsLoaded = false;
    fetchSkills(cb);
  }

  function getSkills() { return allSkills.slice(); }

  function initSkillComposer(inputEl, barEl) {
    activeInputEl = inputEl || activeInputEl;
    chipBarEl = barEl || chipBarEl;
    if (inputEl) {
      inputEl.setAttribute('placeholder', '输入消息… (输入 # 选用技能，@ 引用文件)');
      inputEl.addEventListener('focus', clearChipSelection);
    }
    if (chipBarEl) {
      chipBarEl.addEventListener('mousedown', function (e) {
        var removeBtn = e.target.closest('.skill-chip-remove');
        if (removeBtn) {
          e.preventDefault();
          e.stopPropagation();
          var chipFromRemove = removeBtn.closest('.skill-chip');
          if (!chipFromRemove || !chipBarEl.contains(chipFromRemove)) return;
          removeSkillAt(parseInt(chipFromRemove.dataset.index, 10) || 0);
          if (inputEl) inputEl.focus();
          return;
        }
        var chip = e.target.closest('.skill-chip');
        if (!chip || !chipBarEl.contains(chip)) return;
        e.preventDefault();
        chipBarFocused = true;
        chipFocusIndex = parseInt(chip.dataset.index, 10) || 0;
        renderChipBar();
        if (inputEl) inputEl.focus();
      });
    }
    drainPendingSkills();
    renderChipBar();
  }

  function init() {
    fetchSkills();
    window.addEventListener(SKILLS_CHANGED, function () { refreshSkills(); });
    return null;
  }

  return {
    init: init,
    setAnchor: setAnchor,
    setApplyTarget: setApplyTarget,
    show: show,
    hide: hide,
    isOpen: isOpen,
    handleKeydown: handleKeydown,
    handleInput: handleInput,
    applySelection: applySelection,
    fetchSkills: fetchSkills,
    refreshSkills: refreshSkills,
    getSkills: getSkills,
    notifySkillsChanged: notifySkillsChanged,
    initSkillComposer: initSkillComposer,
    clearSkillChipMode: clearSkillChipMode,
    clearInput: clearInput,
    addSkill: addSkill,
    useSkill: useSkill,
    getComposerText: getComposerText,
    getSelectedRefs: function () {
      return selectedSkills.map(function (fn) { return '#' + fn; });
    },
    focusChipBarEnd: focusChipBarEnd,
    isChipBarFocused: isChipBarFocused,
    isSkillTriggerVal: isSkillTriggerVal,
    SKILLS_CHANGED: SKILLS_CHANGED,
  };
})();
