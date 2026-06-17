/**
 * 工作区文件引用（@ 触发）：级联 cmd-dropdown 选文件，选中后以绝对路径 chip 展示。
 * 模块自包含；异常不向外抛出，避免影响聊天主流程。
 */

/* exported ChatFileRef */

window.ChatFileRef = (function () {
  'use strict';

  var FILE_TRIGGER_RE = /(?:^| )@([^\s@]*)$/;

  var anchorEl = null;
  var chipBarEl = null;
  var activeInputEl = null;
  var pickerRootEl = null;

  var activePrefix = '';
  var panels = [];
  var fetchSeq = 0;
  var fetchAbort = null;

  var selectedPaths = [];
  var chipBarFocused = false;
  var chipFocusIndex = -1;
  var lastInputFilter = '';
  var pendingAutoNavFilter = '';
  var searchTimer = null;
  var searchSeq = 0;

  function safeCall(fn) {
    try { return fn(); } catch (_e) { return undefined; }
  }

  function dispatchInput(inputEl) {
    if (!inputEl) return;
    safeCall(function () {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function getSessionId() {
    if (window.ChatSession && typeof window.ChatSession.getActiveId === 'function') {
      return window.ChatSession.getActiveId() || 'default';
    }
    return 'default';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function basename(fullPath) {
    if (!fullPath) return '';
    var parts = String(fullPath).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || fullPath;
  }

  function parseFileTrigger(val) {
    if (!val) return null;
    var m = String(val).match(FILE_TRIGGER_RE);
    if (!m) return null;
    return { filter: m[1] || '', matchLen: m[0].length };
  }

  function stripTriggerFromTextarea(inputEl) {
    if (!inputEl) return;
    var val = inputEl.value || '';
    var trigger = parseFileTrigger(val);
    if (!trigger) return;
    inputEl.value = val.slice(0, val.length - trigger.matchLen);
    dispatchInput(inputEl);
  }

  function isOpen() {
    return activePrefix === '@' && panels.length > 0 && pickerRootEl && !pickerRootEl.classList.contains('hidden');
  }

  function hide() {
    activePrefix = '';
    lastInputFilter = '';
    pendingAutoNavFilter = '';
    clearSearchTimer();
    searchSeq += 1;
    panels = [];
    fetchSeq += 1;
    if (fetchAbort) {
      try { fetchAbort.abort(); } catch (_e) { /* ignore */ }
      fetchAbort = null;
    }
    if (pickerRootEl) {
      pickerRootEl.classList.add('hidden');
      pickerRootEl.innerHTML = '';
    }
    if (window.ChatDropdown && window.ChatDropdown.isOpen && window.ChatDropdown.isOpen()) {
      /* 不主动关 ChatDropdown，由各自模块协调 */
    }
  }

  function ensurePickerRoot() {
    if (pickerRootEl) return pickerRootEl;
    var root = document.createElement('div');
    root.id = 'file-ref-picker';
    root.className = 'file-ref-picker hidden';
    root.setAttribute('role', 'presentation');
    root.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    document.body.appendChild(root);
    pickerRootEl = root;
    return root;
  }

  function getCurrentPanel() {
    return panels.length ? panels[panels.length - 1] : null;
  }

  function isPathNavigation(filter) {
    return /[/\\]/.test(String(filter || ''));
  }

  function getPickerMode(filter) {
    var f = String(filter || '').trim();
    if (!f) return 'browse';
    if (isPathNavigation(f)) return 'browse';
    return 'search';
  }

  function clearSearchTimer() {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  }

  function scheduleSearch(query) {
    clearSearchTimer();
    searchTimer = setTimeout(function () {
      searchTimer = null;
      fetchSearch(query);
    }, 150);
  }

  function fetchSearch(query) {
    var seq = ++searchSeq;
    fetchSeq += 1;
    if (fetchAbort) {
      try { fetchAbort.abort(); } catch (_e) { /* ignore */ }
    }
    fetchAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;

    panels = [{
      mode: 'search',
      query: query,
      entries: [],
      selectedIndex: 0,
      loading: true,
      error: null,
    }];
    renderAllPanels();

    var url = '/api/workspace/search?sessionId=' + encodeURIComponent(getSessionId())
      + '&q=' + encodeURIComponent(query);

    fetch(url, fetchAbort ? { signal: fetchAbort.signal } : undefined)
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (seq !== searchSeq) return;
        if (!body || !body.success) {
          panels[0].loading = false;
          panels[0].error = (body && body.error) || '搜索失败';
          renderAllPanels();
          return;
        }
        panels[0].entries = Array.isArray(body.entries) ? body.entries : [];
        panels[0].loading = false;
        panels[0].error = null;
        panels[0].selectedIndex = 0;
        renderAllPanels();
      })
      .catch(function (err) {
        if (seq !== searchSeq) return;
        if (err && err.name === 'AbortError') return;
        panels[0].loading = false;
        panels[0].error = '搜索失败';
        renderAllPanels();
      });
  }

  function openSearch(query) {
    if (window.ChatSkills && window.ChatSkills.isOpen && window.ChatSkills.isOpen()) {
      window.ChatSkills.hide();
    }
    activePrefix = '@';
    ensurePickerRoot();
    pendingAutoNavFilter = '';
    scheduleSearch(query);
  }

  function getFilterSegments(filter) {
    return String(filter || '').replace(/\\/g, '/').split('/').filter(function (p) { return p.length > 0; });
  }

  function getRelativeFilterForDepth(fullFilter, depth) {
    return getFilterSegments(fullFilter).slice(depth).join('/');
  }

  function panelStackMatchesFilter(fullFilter) {
    var segs = getFilterSegments(fullFilter);
    for (var i = 1; i < panels.length; i++) {
      var expected = segs[i - 1];
      if (!expected) return false;
      if (basename(panels[i].dir).toLowerCase() !== expected.toLowerCase()) return false;
    }
    return true;
  }

  function shouldResetPicker(fullFilter) {
    var mode = getPickerMode(fullFilter);
    if (!isOpen() || !panels.length) return true;
    if (mode === 'search') {
      return panels.length !== 1 || panels[0].mode !== 'search' || panels[0].query !== fullFilter;
    }
    if (panels[0] && panels[0].mode === 'search') return true;
    if (getActiveFilterSegment(fullFilter) !== getActiveFilterSegment(lastInputFilter)) return true;
    if (panels.length > 1 && !panelStackMatchesFilter(fullFilter)) return true;
    if (getFilterSegments(fullFilter).length > 0 && panels.length > getFilterSegments(fullFilter).length) return true;
    return false;
  }

  function attemptAutoNavigate(fullFilter, seq) {
    if (seq !== fetchSeq || !isOpen()) return;
    var panelIdx = panels.length - 1;
    var panel = panels[panelIdx];
    if (!panel || panel.loading) {
      setTimeout(function () { attemptAutoNavigate(fullFilter, seq); }, 30);
      return;
    }
    var segs = getFilterSegments(fullFilter);
    if (panelIdx < segs.length - 1) {
      var navSeg = segs[panelIdx];
      var folder = null;
      for (var i = 0; i < panel.entries.length; i++) {
        var entry = panel.entries[i];
        if (entry.isDirectory && entry.name.toLowerCase() === navSeg.toLowerCase()) {
          folder = entry;
          break;
        }
      }
      if (folder) {
        enterFolderAt(panelIdx, folder, segs.slice(panelIdx + 1).join('/'), fullFilter);
        return;
      }
    }
    panel.filter = getRelativeFilterForDepth(fullFilter, panelIdx);
    panel.selectedIndex = 0;
    renderAllPanels();
  }

  function getActiveFilterSegment(filter) {
    var norm = String(filter || '').replace(/\\/g, '/');
    var parts = norm.split('/').filter(function (p) { return p.length > 0; });
    return parts[0] || norm;
  }

  function computeChildFilter(currentFilter, enteredDirName) {
    var norm = String(currentFilter || '').replace(/\\/g, '/');
    if (!norm) return '';
    var dir = String(enteredDirName || '').toLowerCase();
    var lower = norm.toLowerCase();
    if (lower === dir) return '';
    var prefix = dir + '/';
    if (lower.startsWith(prefix)) return norm.slice(prefix.length);
    if (dir.startsWith(lower)) return '';
    return norm;
  }

  function getFilteredEntries(panel) {
    if (!panel || !panel.entries) return [];
    if (panel.mode === 'search') return panel.entries.slice();
    var segment = getActiveFilterSegment(panel.filter);
    if (!segment) return panel.entries.slice();
    var q = segment.toLowerCase();
    return panel.entries.filter(function (entry) {
      return entry.name.toLowerCase().indexOf(q) >= 0;
    });
  }

  function scrollActiveItemIntoView(panelIndex) {
    if (!pickerRootEl) return;
    var panelEl = pickerRootEl.querySelector('.file-ref-panel[data-panel-index="' + panelIndex + '"]');
    var panel = panels[panelIndex];
    if (!panelEl || !panel || !panelEl.classList.contains('is-scrollable')) return;
    var items = panelEl.querySelectorAll('.cmd-item');
    var activeEl = items[panel.selectedIndex];
    if (!activeEl) return;

    var padding = 4;
    var panelRect = panelEl.getBoundingClientRect();
    var itemRect = activeEl.getBoundingClientRect();

    if (itemRect.top < panelRect.top + padding) {
      panelEl.scrollTop -= panelRect.top - itemRect.top + padding;
    } else if (itemRect.bottom > panelRect.bottom - padding) {
      panelEl.scrollTop += itemRect.bottom - panelRect.bottom + padding;
    }
  }

  function updateActiveItems() {
    if (!pickerRootEl) return;
    for (var p = 0; p < panels.length; p++) {
      var panelEl = pickerRootEl.querySelector('.file-ref-panel[data-panel-index="' + p + '"]');
      if (!panelEl) continue;
      var filtered = getFilteredEntries(panels[p]);
      var items = panelEl.querySelectorAll('.cmd-item');
      for (var j = 0; j < items.length; j++) {
        items[j].classList.toggle('active', j === panels[p].selectedIndex && j < filtered.length);
      }
      if (panels[p].selectedIndex >= filtered.length) {
        panels[p].selectedIndex = Math.max(0, filtered.length - 1);
      }
      scrollActiveItemIntoView(p);
    }
  }

  function positionPanels() {
    if (!pickerRootEl || !anchorEl || !panels.length) return;
    var margin = 6;
    var panelGap = 4;
    var rect = anchorEl.getBoundingClientRect();
    var tb = anchorEl.closest && anchorEl.closest('.composer-toolbar');
    var topRef = tb ? tb.getBoundingClientRect().top : rect.top;
    var panelEls = pickerRootEl.querySelectorAll('.file-ref-panel');
    var left = rect.left;
    var top = topRef - margin;

    for (var i = 0; i < panelEls.length; i++) {
      var el = panelEls[i];
      el.style.position = 'fixed';
      el.style.visibility = 'hidden';
      el.style.left = '0px';
      el.style.top = '0px';
      void el.offsetHeight;
      var w = el.offsetWidth;
      var h = el.offsetHeight;
      el.style.visibility = '';
      if (left + w > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - w - 8);
      }
      var panelTop = top - h;
      if (panelTop < 8) panelTop = 8;
      el.style.left = left + 'px';
      el.style.top = panelTop + 'px';
      left += w + panelGap;
    }
  }

  function renderPanel(panelIndex) {
    var panel = panels[panelIndex];
    if (!panel) return '';
    var filtered = getFilteredEntries(panel);
    if (panel.loading) {
      return '<div class="cmd-empty">加载中…</div>';
    }
    if (panel.error) {
      return '<div class="cmd-empty">' + escapeHtml(panel.error) + '</div>';
    }
    if (!filtered.length) {
      return '<div class="cmd-empty">无匹配项</div>';
    }
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var entry = filtered[i];
      var isActive = i === panel.selectedIndex;
      var arrow = entry.isDirectory
        ? '<span class="file-ref-arrow" aria-hidden="true">›</span>'
        : '';
      var desc = entry.relativePath || '';
      html +=
        '<div class="cmd-item' + (isActive ? ' active' : '') + (entry.isDirectory ? ' is-folder' : ' is-file') + '" data-index="' + i + '" data-panel="' + panelIndex + '" role="menuitem" title="' + escapeHtml(entry.path) + '">' +
          '<span class="cmd-name">' + escapeHtml(entry.name) + '</span>' +
          (desc ? '<span class="cmd-desc">' + escapeHtml(desc) + '</span>' : '') +
          arrow +
        '</div>';
    }
    return html;
  }

  function renderAllPanels() {
    if (!pickerRootEl) return;
    var html = '';
    for (var i = 0; i < panels.length; i++) {
      var scrollable = getFilteredEntries(panels[i]).length > 6 ? ' is-scrollable' : '';
      html += '<div class="cmd-dropdown file-ref-panel' + scrollable + '" data-panel-index="' + i + '" role="menu" aria-label="工作区文件">';
      html += renderPanel(i);
      html += '</div>';
    }
    pickerRootEl.innerHTML = html;
    pickerRootEl.classList.remove('hidden');

    pickerRootEl.querySelectorAll('.cmd-item').forEach(function (itemEl) {
      itemEl.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var pIdx = parseInt(itemEl.getAttribute('data-panel'), 10);
        var idx = parseInt(itemEl.getAttribute('data-index'), 10);
        if (isNaN(pIdx) || isNaN(idx)) return;
        handlePanelSelect(pIdx, idx);
      });
    });

    updateActiveItems();
    positionPanels();
  }

  function fetchDirectory(dirPath, panelIndex, filter, onLoaded) {
    var seq = ++fetchSeq;
    if (fetchAbort) {
      try { fetchAbort.abort(); } catch (_e) { /* ignore */ }
    }
    fetchAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;

    panels = panels.slice(0, panelIndex + 1);
    panels[panelIndex] = {
      dir: dirPath || '',
      entries: [],
      selectedIndex: 0,
      filter: filter || '',
      loading: true,
      error: null,
    };
    renderAllPanels();

    var url = '/api/workspace/browse?sessionId=' + encodeURIComponent(getSessionId());
    if (dirPath) url += '&dir=' + encodeURIComponent(dirPath);

    fetch(url, fetchAbort ? { signal: fetchAbort.signal } : undefined)
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (seq !== fetchSeq) return;
        if (!body || !body.success) {
          panels[panelIndex].loading = false;
          panels[panelIndex].error = (body && body.error) || '无法读取目录';
          renderAllPanels();
          return;
        }
        panels[panelIndex].dir = body.dir;
        panels[panelIndex].entries = Array.isArray(body.entries) ? body.entries : [];
        panels[panelIndex].loading = false;
        panels[panelIndex].error = null;
        panels[panelIndex].selectedIndex = 0;
        renderAllPanels();
        if (typeof onLoaded === 'function') onLoaded(seq);
      })
      .catch(function (err) {
        if (seq !== fetchSeq) return;
        if (err && err.name === 'AbortError') return;
        panels[panelIndex].loading = false;
        panels[panelIndex].error = '读取失败';
        renderAllPanels();
        if (typeof onLoaded === 'function') onLoaded(seq);
      });
  }

  function openRoot(filter) {
    if (window.ChatSkills && window.ChatSkills.isOpen && window.ChatSkills.isOpen()) {
      window.ChatSkills.hide();
    }
    activePrefix = '@';
    ensurePickerRoot();
    pendingAutoNavFilter = filter || '';
    var rootFilter = getRelativeFilterForDepth(filter, 0);
    fetchDirectory('', 0, rootFilter, function (seq) {
      if (pendingAutoNavFilter) attemptAutoNavigate(pendingAutoNavFilter, seq);
    });
  }

  function enterFolderAt(panelIndex, entry, childFilter, autoNavFilter) {
    if (!entry || !entry.isDirectory) return;
    var nextIndex = panelIndex + 1;
    panels = panels.slice(0, panelIndex + 1);
    panels.push({
      dir: entry.path,
      entries: [],
      selectedIndex: 0,
      filter: childFilter || '',
      loading: true,
      error: null,
    });
    renderAllPanels();
    fetchDirectory(entry.path, nextIndex, childFilter || '', function (seq) {
      if (autoNavFilter) attemptAutoNavigate(autoNavFilter, seq);
    });
  }

  function enterFolder(panelIndex, entry) {
    if (!entry || !entry.isDirectory) return;
    var parentPanel = panels[panelIndex];
    var childFilter = parentPanel ? computeChildFilter(parentPanel.filter, entry.name) : '';
    pendingAutoNavFilter = '';
    enterFolderAt(panelIndex, entry, childFilter, null);
  }

  function addPath(absPath) {
    if (!absPath) return;
    if (selectedPaths.indexOf(absPath) >= 0) return;
    selectedPaths.push(absPath);
    chipBarFocused = false;
    chipFocusIndex = -1;
    renderChipBar();
  }

  function applyFileSelection(entry) {
    if (!entry || entry.isDirectory) return;
    stripTriggerFromTextarea(activeInputEl);
    addPath(entry.path);
    hide();
    if (activeInputEl) activeInputEl.focus();
  }

  function handlePanelSelect(panelIndex, itemIndex) {
    var panel = panels[panelIndex];
    if (!panel) return;
    var filtered = getFilteredEntries(panel);
    var entry = filtered[itemIndex];
    if (!entry) return;
    panel.selectedIndex = itemIndex;
    if (panel.mode === 'search') {
      if (entry.isDirectory) {
        pendingAutoNavFilter = '';
        panels = [];
        fetchDirectory(entry.path, 0, '', null);
      } else {
        applyFileSelection(entry);
      }
      return;
    }
    if (entry.isDirectory) {
      enterFolder(panelIndex, entry);
    } else {
      applyFileSelection(entry);
    }
  }

  function renderChipBar() {
    if (!chipBarEl) return;
    chipBarEl.innerHTML = '';
    if (!selectedPaths.length) {
      chipBarEl.classList.add('hidden');
      chipBarFocused = false;
      chipFocusIndex = -1;
      return;
    }
    chipBarEl.classList.remove('hidden');
    for (var i = 0; i < selectedPaths.length; i++) {
      var absPath = selectedPaths[i];
      var chip = document.createElement('span');
      chip.className = 'file-ref-chip';
      chip.setAttribute('role', 'option');
      chip.setAttribute('aria-selected', chipBarFocused && i === chipFocusIndex ? 'true' : 'false');
      chip.dataset.index = String(i);
      chip.title = absPath;

      var label = document.createElement('span');
      label.className = 'file-ref-chip-label';
      label.textContent = '@' + basename(absPath);
      chip.appendChild(label);

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'file-ref-chip-remove';
      removeBtn.setAttribute('aria-label', '移除文件 ' + basename(absPath));
      removeBtn.textContent = '\u00D7';
      chip.appendChild(removeBtn);

      if (chipBarFocused && i === chipFocusIndex) chip.classList.add('is-selected');
      chipBarEl.appendChild(chip);
    }
  }

  function removePathAt(index) {
    if (index < 0 || index >= selectedPaths.length) return;
    selectedPaths.splice(index, 1);
    if (!selectedPaths.length) {
      chipBarFocused = false;
      chipFocusIndex = -1;
    } else if (chipFocusIndex >= selectedPaths.length) {
      chipFocusIndex = selectedPaths.length - 1;
    } else if (chipFocusIndex < 0) {
      chipFocusIndex = 0;
    }
    renderChipBar();
  }

  function clearChipSelection() {
    chipBarFocused = false;
    chipFocusIndex = -1;
    renderChipBar();
  }

  function focusChipBarFromAbove() {
    if (!selectedPaths.length) return false;
    chipBarFocused = true;
    chipFocusIndex = selectedPaths.length - 1;
    renderChipBar();
    return true;
  }

  function getSelectedRefs() {
    return selectedPaths.slice();
  }

  function clearInput(inputEl) {
    selectedPaths = [];
    clearChipSelection();
    lastInputFilter = '';
    pendingAutoNavFilter = '';
    hide();
    stripTriggerFromTextarea(inputEl);
    renderChipBar();
  }

  function handleChipBarKeydown(e, inputEl) {
    if (isOpen()) return false;
    if (!selectedPaths.length) return false;

    if (!chipBarFocused && e.key === 'ArrowUp' && !isOpen()) {
      if (window.ChatSkills && window.ChatSkills.isChipBarFocused && window.ChatSkills.isChipBarFocused()) {
        return false;
      }
      if (window.ChatSkills && window.ChatSkills.isOpen && window.ChatSkills.isOpen()) {
        return false;
      }
      e.preventDefault();
      chipBarFocused = true;
      chipFocusIndex = selectedPaths.length - 1;
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
      chipFocusIndex = Math.min(selectedPaths.length - 1, chipFocusIndex + 1);
      renderChipBar();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (chipFocusIndex <= 0
          && window.ChatSkills
          && typeof window.ChatSkills.focusChipBarEnd === 'function'
          && window.ChatSkills.focusChipBarEnd()) {
        clearChipSelection();
        return true;
      }
      chipFocusIndex = Math.max(0, chipFocusIndex - 1);
      renderChipBar();
      return true;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      clearChipSelection();
      if (inputEl) inputEl.focus();
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      removePathAt(chipFocusIndex);
      if (!selectedPaths.length && inputEl) inputEl.focus();
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
    var panel = getCurrentPanel();
    if (!panel) return false;
    var filtered = getFilteredEntries(panel);
    var panelIndex = panels.length - 1;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      panel.selectedIndex = (panel.selectedIndex + 1) % Math.max(filtered.length, 1);
      updateActiveItems();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      panel.selectedIndex = (panel.selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1);
      updateActiveItems();
      return true;
    }
    if (e.key === 'ArrowLeft') {
      if (panels.length > 1) {
        e.preventDefault();
        panels.pop();
        renderAllPanels();
        return true;
      }
      return false;
    }
    if (e.key === 'ArrowRight') {
      var entryR = filtered[panel.selectedIndex];
      if (entryR && entryR.isDirectory) {
        e.preventDefault();
        enterFolder(panelIndex, entryR);
        return true;
      }
      return false;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      var entry = filtered[panel.selectedIndex];
      if (!entry) return true;
      if (entry.isDirectory) {
        enterFolder(panelIndex, entry);
      } else {
        applyFileSelection(entry);
      }
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
    var trigger = parseFileTrigger(plain);
    if (trigger) {
      if (window.ChatSkills && window.ChatSkills.isOpen && window.ChatSkills.isOpen()) {
        window.ChatSkills.hide();
      }
      activePrefix = '@';
      var fullFilter = trigger.filter || '';
      var pickerMode = getPickerMode(fullFilter);
      if (pickerMode === 'search') {
        if (shouldResetPicker(fullFilter)) {
          openSearch(fullFilter);
        }
      } else if (shouldResetPicker(fullFilter)) {
        openRoot(fullFilter);
      } else {
        var currentPanel = getCurrentPanel();
        if (currentPanel) {
          currentPanel.filter = getRelativeFilterForDepth(fullFilter, panels.length - 1);
          currentPanel.selectedIndex = 0;
          renderAllPanels();
        }
      }
      lastInputFilter = fullFilter;
    } else {
      lastInputFilter = '';
      if (activePrefix === '@') hide();
    }
  }

  function initFileComposer(inputEl, barEl) {
    activeInputEl = inputEl || activeInputEl;
    chipBarEl = barEl || chipBarEl;
    if (inputEl) {
      inputEl.addEventListener('focus', clearChipSelection);
    }
    if (chipBarEl) {
      chipBarEl.addEventListener('mousedown', function (e) {
        var removeBtn = e.target.closest('.file-ref-chip-remove');
        if (removeBtn) {
          e.preventDefault();
          e.stopPropagation();
          var chipFromRemove = removeBtn.closest('.file-ref-chip');
          if (!chipFromRemove || !chipBarEl.contains(chipFromRemove)) return;
          removePathAt(parseInt(chipFromRemove.dataset.index, 10) || 0);
          if (inputEl) inputEl.focus();
          return;
        }
        var chip = e.target.closest('.file-ref-chip');
        if (!chip || !chipBarEl.contains(chip)) return;
        e.preventDefault();
        chipBarFocused = true;
        chipFocusIndex = parseInt(chip.dataset.index, 10) || 0;
        renderChipBar();
        if (inputEl) inputEl.focus();
      });
    }
    renderChipBar();
  }

  function setAnchor(el) { anchorEl = el; }

  function bindOutsideClose() {
    if (window.__fileRefOutsideBound) return;
    window.__fileRefOutsideBound = true;
    document.addEventListener('mousedown', function (e) {
      if (!isOpen()) return;
      if (pickerRootEl && pickerRootEl.contains(e.target)) return;
      if (anchorEl && anchorEl.contains && anchorEl.contains(e.target)) return;
      if (activeInputEl && activeInputEl.contains && activeInputEl.contains(e.target)) return;
      hide();
    });
    window.addEventListener('resize', function () { if (isOpen()) positionPanels(); });
    window.addEventListener('scroll', function () { if (isOpen()) positionPanels(); }, true);
  }

  function init() {
    bindOutsideClose();
    return null;
  }

  return {
    init: init,
    setAnchor: setAnchor,
    show: openRoot,
    hide: hide,
    isOpen: isOpen,
    handleKeydown: handleKeydown,
    handleInput: handleInput,
    initFileComposer: initFileComposer,
    clearInput: clearInput,
    getSelectedRefs: getSelectedRefs,
    focusChipBarFromAbove: focusChipBarFromAbove,
  };
})();
