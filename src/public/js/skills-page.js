/**
 * 技能库页面：列表、查看、删除技能 Markdown 文件。
 */

/* exported SkillsPage */

window.SkillsPage = (function () {
  'use strict';

  var containerEl = null;
  var allSkills = [];
  var selectedFilename = null;
  var listFetchAbort = null;

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function formatZhIso(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_e) {
      return '—';
    }
  }

  function notifySkillsChanged() {
    if (window.ChatSkills && typeof window.ChatSkills.notifySkillsChanged === 'function') {
      window.ChatSkills.notifySkillsChanged();
    } else {
      window.dispatchEvent(new CustomEvent('ice-skills-changed'));
    }
  }

  function destroy() {
    if (listFetchAbort) {
      listFetchAbort.abort();
      listFetchAbort = null;
    }
    containerEl = null;
    allSkills = [];
    selectedFilename = null;
  }

  function renderSkillList(listEl, countEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (countEl) countEl.textContent = allSkills.length + ' 个技能';

    if (!allSkills.length) {
      listEl.innerHTML = '<div class="skills-empty">暂无技能，请在 <code>skills</code> 目录中添加 Markdown 文件。</div>';
      return;
    }

    for (var i = 0; i < allSkills.length; i++) {
      (function (sk) {
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'skills-card' + (sk.filename === selectedFilename ? ' is-active' : '');
        card.setAttribute('data-filename', sk.filename);
        card.innerHTML =
          '<div class="skills-card-head">' +
            '<span class="skills-card-name">' + escapeHtml(sk.name || sk.filename) + '</span>' +
            '<span class="skills-card-file">#' + escapeHtml(sk.filename) + '</span>' +
          '</div>' +
          '<p class="skills-card-desc">' + escapeHtml(sk.description || '（无描述）') + '</p>' +
          '<div class="skills-card-meta">更新于 ' + escapeHtml(formatZhIso(sk.modifiedAt)) + '</div>';

        card.addEventListener('click', function () {
          selectedFilename = sk.filename;
          renderSkillList(listEl, countEl);
          loadSkillDetail(sk.filename);
        });
        listEl.appendChild(card);
      })(allSkills[i]);
    }
  }

  function loadSkillDetail(filename) {
    var detailEl = containerEl && containerEl.querySelector('#skills-detail');
    if (!detailEl) return;
    detailEl.innerHTML = '<div class="skills-detail-loading">载入中…</div>';

    fetch('/api/skills/' + encodeURIComponent(filename))
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (out) {
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || '读取失败');
        }
        var meta = out.body.meta || {};
        var content = out.body.content || '';
        detailEl.innerHTML =
          '<div class="skills-detail-header">' +
            '<div class="skills-detail-title-row">' +
              '<h2 class="skills-detail-title">' + escapeHtml(meta.name || filename) + '</h2>' +
              '<span class="skills-detail-chip">#' + escapeHtml(filename) + '</span>' +
            '</div>' +
            '<p class="skills-detail-desc">' + escapeHtml(meta.description || '') + '</p>' +
            '<div class="skills-detail-actions">' +
              '<button type="button" class="skills-btn skills-btn-danger" id="skills-delete-btn">删除技能</button>' +
            '</div>' +
          '</div>' +
          '<pre class="skills-detail-content">' + escapeHtml(content) + '</pre>';

        var delBtn = detailEl.querySelector('#skills-delete-btn');
        if (delBtn) {
          delBtn.addEventListener('click', function () {
            var doConfirm = function () { doDelete(filename); };
            if (window.Modal && typeof window.Modal.confirm === 'function') {
              window.Modal.confirm({
                title: '删除技能',
                message: '确定删除「' + (meta.name || filename) + '」？此操作不可撤销。',
                confirmText: '删除',
                dangerConfirm: true,
              }).then(function (ok) { if (ok) doConfirm(); });
            } else if (confirm('确定删除技能「' + (meta.name || filename) + '」？')) {
              doConfirm();
            }
          });
        }
      })
      .catch(function (err) {
        detailEl.innerHTML =
          '<div class="skills-detail-error">加载失败：' + escapeHtml(err.message || '未知错误') + '</div>';
      });
  }

  function doDelete(filename) {
    fetch('/api/skills/' + encodeURIComponent(filename), { method: 'DELETE' })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (out) {
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || '删除失败');
        }
        if (window.Notification) Notification.success('技能已删除');
        notifySkillsChanged();
        if (selectedFilename === filename) selectedFilename = null;
        reloadSkills();
      })
      .catch(function (err) {
        if (window.Notification) Notification.error('删除失败：' + (err.message || '未知错误'));
      });
  }

  function reloadSkills() {
    if (!containerEl) return;
    var listEl = containerEl.querySelector('#skills-list');
    var countEl = containerEl.querySelector('#skills-total-count');
    var detailEl = containerEl.querySelector('#skills-detail');

    if (listFetchAbort) listFetchAbort.abort();
    listFetchAbort = new AbortController();

    if (countEl) countEl.textContent = '载入中…';
    fetch('/api/skills', { signal: listFetchAbort.signal })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body.success) throw new Error(body.error || '加载失败');
        allSkills = body.skills || [];
        renderSkillList(listEl, countEl);
        if (selectedFilename) {
          loadSkillDetail(selectedFilename);
        } else if (detailEl) {
          detailEl.innerHTML =
            '<div class="skills-detail-placeholder">选择左侧技能查看详情，或在输入框输入 <code>#</code> 快速选用。</div>';
        }
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (countEl) countEl.textContent = '加载失败';
        if (listEl) {
          listEl.innerHTML =
            '<div class="skills-empty">加载失败：' + escapeHtml(err.message || '未知错误') + '</div>';
        }
      });
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML = '';

    var root = document.createElement('div');
    root.className = 'skills-root';

    var header = document.createElement('header');
    header.className = 'skills-header';
    header.innerHTML =
      '<div class="skills-header-text">' +
        '<h1 class="skills-title">技能库</h1>' +
        '<p class="skills-hint">技能以 Markdown 文件存储，与 <code>user-memory</code> 同级。在聊天输入框输入 <code>#</code> 可快速选用技能。</p>' +
      '</div>' +
      '<div class="skills-header-actions">' +
        '<span class="skills-count" id="skills-total-count">载入中…</span>' +
      '</div>';

    var main = document.createElement('main');
    main.className = 'skills-main';
    main.innerHTML =
      '<aside class="skills-list-panel" id="skills-list-panel">' +
        '<div class="skills-list" id="skills-list"></div>' +
      '</aside>' +
      '<section class="skills-detail-panel" id="skills-detail">' +
        '<div class="skills-detail-placeholder">选择左侧技能查看详情，或在输入框输入 <code>#</code> 快速选用。</div>' +
      '</section>';

    root.appendChild(header);
    root.appendChild(main);
    parentEl.appendChild(root);

    reloadSkills();
  }

  return {
    render: render,
    destroy: destroy,
  };
})();
