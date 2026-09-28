// @ts-nocheck
/**
 * 技能选择（# 触发）：选中技能显示在输入框上方 chip 栏，下方 textarea 仅输入提示词。
 */

/* exported ChatSkills */

export const ChatSkills = (() => {

  const SKILLS_CHANGED = 'ice-skills-changed';
  /** 光标前出现 # 即触发（中文后无需空格） */
  const SKILL_TRIGGER_RE = /#([^\s#]*)$/;

  let skillSelectedIndex = 0;
  let skillFiltered = [];
  let skillActivePrefix = '';
  let allSkills = [];
  let skillsLoading = false;
  let skillsLoaded = false;
  let applyTargetFn = null;
  let activeInputEl = null;
  let anchorEl = null;
  let chipBarEl = null;

  let selectedSkills = [];
  const pendingSkills = [];
  let chipBarFocused = false;
  let chipFocusIndex = -1;

  function dispatchInput(inputEl) {
    if (!inputEl) return;
    try {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_err) {
      const ev = document.createEvent('Event');
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
    const dd = window.ChatDropdown && window.ChatDropdown.getContainer();
    if (!dd) return;
    const items = dd.querySelectorAll('.cmd-item');
    for (let j = 0; j < items.length; j++) {
      items[j].classList.toggle('active', j === skillSelectedIndex);
    }
  }

  function isOpen() {
    return !!(window.ChatDropdown && window.ChatDropdown.isOpen() && skillActivePrefix === '#');
  }

  function hide() {
    const shouldClose = skillActivePrefix === '#' && window.ChatDropdown && window.ChatDropdown.isOpen();
    skillFiltered = [];
    skillActivePrefix = '';
    if (shouldClose) window.ChatDropdown.close();
  }

  function openDropdown() {
    if (!window.ChatDropdown || !anchorEl) return;
    const activePrefix = skillActivePrefix;
    const filteredItems = skillFiltered.slice();
    window.ChatDropdown.open({
      anchor: anchorEl,
      items: filteredItems,
      placement: 'top',
      placementRef: 'anchor',
      align: 'start',
      fitContent: true,
      minWidth: 200,
      maxWidth: 320,
      markAnchorActive: false,
      onSelect(_item, idx) { applySelection(idx); },
      onHighlight(_item, idx) { skillSelectedIndex = idx; },
      onClose() {
        // 刷新过滤列表时 ChatDropdown.open 会先 close 再 open；状态清理由 hide() 负责。
      },
    });
    skillActivePrefix = activePrefix;
    skillFiltered = filteredItems;
    setTimeout(updateActiveItem, 0);
  }

  function show(prefix, filter, inputEl) {
    if (prefix !== '#') { hide(); return; }
    if (window.ChatCommands && window.ChatCommands.isOpen && window.ChatCommands.isOpen()) {
      window.ChatCommands.hide();
    }
    skillActivePrefix = prefix;
    activeInputEl = inputEl || activeInputEl;
    const query = (filter || '').toLowerCase();

    function renderFiltered() {
      skillFiltered = allSkills
        .filter((sk) => {
          const fn = (sk.filename || '').toLowerCase();
          const nm = (sk.name || '').toLowerCase();
          const desc = (sk.description || '').toLowerCase();
          return fn.includes(query) || nm.includes(query) || desc.includes(query);
        })
        .map(skillToDropdownItem);
      skillSelectedIndex = 0;
      openDropdown();
    }

    if (skillsLoaded) {
      renderFiltered();
      return;
    }
    skillSelectedIndex = 0;
    openDropdown();
    if (skillsLoading) return;
    skillsLoading = true;
    fetchSkills(() => {
      skillsLoading = false;
      if (skillActivePrefix === '#') renderFiltered();
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
    const cursor = getInputCursor(inputEl, val);
    const before = String(val).slice(0, cursor);
    const m = before.match(SKILL_TRIGGER_RE);
    if (!m) return null;
    return { filter: m[1] || '', matchLen: m[0].length, cursorEnd: cursor };
  }

  function isSkillTriggerVal(val, inputEl) {
    return !!parseSkillTrigger(val, inputEl);
  }

  function stripTriggerFromTextarea(inputEl) {
    if (!inputEl) return;
    const val = inputEl.value || '';
    const trigger = parseSkillTrigger(val, inputEl);
    if (!trigger) return;
    const end = trigger.cursorEnd != null ? trigger.cursorEnd : val.length;
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
    for (let i = 0; i < selectedSkills.length; i++) {
      const fn = selectedSkills[i];
      const chip = document.createElement('span');
      chip.className = 'skill-chip';
      chip.setAttribute('role', 'option');
      chip.setAttribute('aria-selected', chipBarFocused && i === chipFocusIndex ? 'true' : 'false');
      chip.dataset.index = String(i);

      const label = document.createElement('span');
      label.className = 'skill-chip-label';
      label.textContent = `#${fn}`;
      chip.appendChild(label);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'skill-chip-remove';
      removeBtn.setAttribute('aria-label', `移除技能 ${fn}`);
      removeBtn.textContent = '\u00D7';
      chip.appendChild(removeBtn);

      if (chipBarFocused && i === chipFocusIndex) chip.classList.add('is-selected');
      chipBarEl.appendChild(chip);
    }
  }

  function addSkill(filename) {
    const fn = String(filename || '').replace(/^#/, '');
    if (!fn) return;
    if (selectedSkills.includes(fn)) return;
    selectedSkills.push(fn);
    chipBarFocused = false;
    chipFocusIndex = -1;
    renderChipBar();
  }

  function focusComposerInput() {
    const input = activeInputEl || document.getElementById('chat-input');
    if (!input) return;
    setTimeout(() => { input.focus(); }, 0);
  }

  function drainPendingSkills() {
    const hadPending = pendingSkills.length > 0;
    while (pendingSkills.length) {
      addSkill(pendingSkills.shift());
    }
    if (hadPending) focusComposerInput();
  }

  /** 从技能库等页面选用技能：写入输入框上方 chip 栏并聚焦输入框 */
  function useSkill(filename) {
    const fn = String(filename || '').replace(/^#/, '');
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
    const parts = [];
    for (let i = 0; i < selectedSkills.length; i++) {
      parts.push('#' + selectedSkills[i]);
    }
    const body = (inputEl && inputEl.value != null ? inputEl.value : '').replace(/\u00A0/g, ' ').trim();
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
    const item = skillFiltered[index];
    const skill = allSkills.find((s) =>  s.filename === item.key);
    const built = skill ? { ref: `#${skill.filename}`, body: '' } : { ref: '#' + (item.key || item.name || ''), body: '' };
    const targetInput = inputEl || activeInputEl;
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

  function isInputCursorOnFirstLine(inputEl) {
    if (!inputEl || typeof inputEl.selectionStart !== 'number') return true;
    if (inputEl.selectionStart !== inputEl.selectionEnd) return false;
    const before = inputEl.value.substring(0, inputEl.selectionStart);
    return !before.includes('\n') && !before.includes('\r');
  }

  function handleChipBarKeydown(e, inputEl) {
    if (isOpen()) return false;
    if (!selectedSkills.length) return false;

    if (!chipBarFocused && e.key === 'ArrowUp' && !isOpen()) {
      if (!isInputCursorOnFirstLine(inputEl)) return false;
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
    const plain = val != null ? String(val) : (inputEl && inputEl.value) || '';
    const trigger = parseSkillTrigger(plain, inputEl);
    if (trigger) {
      show('#', trigger.filter, inputEl);
    } else if (skillActivePrefix === '#') {
      hide();
    }
  }

  function fetchSkills(cb) {
    fetch('/api/skills')
      .then((res) =>  res.json())
      .then((body) => {
        if (body && body.success && Array.isArray(body.skills)) {
          allSkills = body.skills;
          skillsLoaded = true;
        }
        if (typeof cb === 'function') cb(allSkills);
      })
      .catch(() => { if (typeof cb === 'function') cb([]); });
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
      chipBarEl.addEventListener('mousedown', (e) => {
        const removeBtn = e.target.closest('.skill-chip-remove');
        if (removeBtn) {
          e.preventDefault();
          e.stopPropagation();
          const chipFromRemove = removeBtn.closest('.skill-chip');
          if (!chipFromRemove || !chipBarEl.contains(chipFromRemove)) return;
          removeSkillAt(parseInt(chipFromRemove.dataset.index, 10) || 0);
          if (inputEl) inputEl.focus();
          return;
        }
        const chip = e.target.closest('.skill-chip');
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
    window.addEventListener(SKILLS_CHANGED, () => { refreshSkills(); });
    return null;
  }

  return {
    init,
    setAnchor,
    setApplyTarget,
    show,
    hide,
    isOpen,
    handleKeydown,
    handleInput,
    applySelection,
    fetchSkills,
    refreshSkills,
    getSkills,
    notifySkillsChanged,
    initSkillComposer,
    clearSkillChipMode,
    clearInput,
    addSkill,
    useSkill,
    getComposerText,
    getSelectedRefs() {
      return selectedSkills.map((fn) => { return `#${fn}`; });
    },
    getSelectedSkills() {
      return selectedSkills.slice();
    },
    setSelectedSkills(names) {
      selectedSkills = Array.isArray(names) ? names.slice() : [];
      clearChipSelection();
      renderChipBar();
    },
    focusChipBarEnd,
    isChipBarFocused,
    isSkillTriggerVal,
    SKILLS_CHANGED,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatSkills = ChatSkills;
}
