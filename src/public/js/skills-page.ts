// @ts-nocheck
/**
 * 技能库页面：列表、查看、删除技能 Markdown 文件。
 */

/* exported SkillsPage */

export const SkillsPage = (() => {

  let containerEl = null;
  let allSkills = [];
  let selectedFilename = null;
  let listFetchAbort = null;
  let skillsChangedHandler = null;

  function isMobile() {
    return window.innerWidth <= 720;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function formatZhIso(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
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
    if (skillsChangedHandler) {
      window.removeEventListener('ice-skills-changed', skillsChangedHandler);
      skillsChangedHandler = null;
    }
    containerEl = null;
    allSkills = [];
    selectedFilename = null;
  }

  function renderSkillList(listEl, countEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (countEl) countEl.textContent = `${allSkills.length} 个技能`;

    if (!allSkills.length) {
      listEl.innerHTML = '<div class="skills-empty">暂无技能，请在 <code>skills</code> 目录中添加 Markdown 文件。</div>';
      return;
    }

    for (let i = 0; i < allSkills.length; i++) {
      ((sk) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'skills-card' + (sk.filename === selectedFilename ? ' is-active' : '');
        card.setAttribute('data-filename', sk.filename);
        card.innerHTML =
          `<div class="skills-card-head"><span class="skills-card-name">${escapeHtml(sk.name || sk.filename)}</span><span class="skills-card-file">#${escapeHtml(sk.filename)}</span></div><p class="skills-card-desc">${escapeHtml(sk.description || '（无描述）')}</p><div class="skills-card-meta">更新于 ${escapeHtml(formatZhIso(sk.modifiedAt))}</div><div class="skills-card-actions"><button type="button" class="skills-btn skills-btn-danger" data-action="delete">删除技能</button><button type="button" class="skills-btn skills-btn-primary" data-action="use">使用技能</button></div>`;

        if (isMobile()) {
          card.addEventListener('click', (e) => {
            if (e.target.closest('.skills-btn')) return;
            toggleSkillExpand(card, sk);
          });
          const delBtn = card.querySelector('[data-action="delete"]');
          if (delBtn) delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            confirmDeleteSkill(sk);
          });
          const useBtn = card.querySelector('[data-action="use"]');
          if (useBtn) useBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            useSkillAction(sk);
          });
        } else {
          card.addEventListener('click', () => {
            selectedFilename = sk.filename;
            renderSkillList(listEl, countEl);
            loadSkillDetail(sk.filename);
          });
        }
        listEl.appendChild(card);
      })(allSkills[i]);
    }
  }

  function toggleSkillExpand(card, sk) {
    const wasExpanded = card.classList.contains('is-expanded');
    // 收起其他已展开的卡片
    const expanded = containerEl.querySelectorAll('.skills-card.is-expanded');
    for (let i = 0; i < expanded.length; i++) {
      expanded[i].classList.remove('is-expanded');
      const old = expanded[i].querySelector('.skills-card-detail');
      if (old) old.remove();
    }
    if (wasExpanded) return;
    // 展开当前卡片
    card.classList.add('is-expanded');
    const detailDiv = document.createElement('div');
    detailDiv.className = 'skills-card-detail';
    detailDiv.innerHTML = '<div class="skills-detail-loading">载入中…</div>';
    card.appendChild(detailDiv);
    fetch(`/api/skills/${encodeURIComponent(sk.filename)}`)
      .then((res) =>  res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || '加载失败');
        detailDiv.innerHTML =
          `<pre class="skills-detail-content">${escapeHtml(body.content || '')}</pre>`;
      })
      .catch((err) => {
        detailDiv.innerHTML = `<div class="skills-detail-error">加载失败：${escapeHtml(err.message || '未知错误')}</div>`;
      });
  }

  function confirmDeleteSkill(sk) {
    const name = sk.name || sk.filename;
    window.Modal.confirm({
      title: '删除技能',
      message: `确定删除「${name}」？此操作不可撤销。`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      dangerConfirm: true,
    }).then((ok) => {
      if (ok) doDelete(sk.filename);
    });
  }

  function navigateToChatComposer() {
    const router = window.AppRouter;
    if (router && typeof router.getShell === 'function' && router.getShell() === 'mobile') {
      if (typeof router.navigate === 'function') {
        router.navigate('work');
      }
      return;
    }
    const targetHash = '#/chat';
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    } else {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }

  function focusChatInputSoon() {
    setTimeout(() => {
      const input = document.getElementById('chat-input');
      if (input) input.focus();
    }, 0);
  }

  function useSkillAction(sk) {
    if (window.ChatSkills && typeof window.ChatSkills.useSkill === 'function') {
      window.ChatSkills.useSkill(sk.filename);
    }
    navigateToChatComposer();
    focusChatInputSoon();
  }

  function loadSkillDetail(filename) {
    const detailEl = containerEl && containerEl.querySelector('#skills-detail');
    if (!detailEl) return;
    detailEl.innerHTML = '<div class="skills-detail-loading">载入中…</div>';

    fetch(`/api/skills/${encodeURIComponent(filename)}`)
      .then((res) => { return res.json().then((body) =>  ({ ok: res.ok, body })); })
      .then((out) => {
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || '读取失败');
        }
        const meta = out.body.meta || {};
        const content = out.body.content || '';
        detailEl.innerHTML =
          `<div class="skills-detail-header"><div class="skills-detail-title-row"><h2 class="skills-detail-title">${escapeHtml(meta.name || filename)}</h2><span class="skills-detail-chip">#${escapeHtml(filename)}</span></div><p class="skills-detail-desc">${escapeHtml(meta.description || '')}</p><div class="skills-detail-actions"><button type="button" class="skills-btn skills-btn-danger" id="skills-delete-btn">删除技能</button><button type="button" class="skills-btn skills-btn-primary" id="skills-use-btn">使用技能</button></div></div><pre class="skills-detail-content">${escapeHtml(content)}</pre>`;

        const useBtn = detailEl.querySelector('#skills-use-btn');
        if (useBtn) {
          useBtn.addEventListener('click', () => {
            if (window.ChatSkills && typeof window.ChatSkills.useSkill === 'function') {
              window.ChatSkills.useSkill(filename);
            }
            navigateToChatComposer();
            focusChatInputSoon();
          });
        }

        const delBtn = detailEl.querySelector('#skills-delete-btn');
        if (delBtn) {
          delBtn.addEventListener('click', () => {
            confirmDeleteSkill({ name: meta.name || filename, filename });
          });
        }
      })
      .catch((err) => {
        detailEl.innerHTML =
          `<div class="skills-detail-error">加载失败：${escapeHtml(err.message || '未知错误')}</div>`;
      });
  }

  function doDelete(filename) {
    fetch(`/api/skills/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      .then((res) => { return res.json().then((body) =>  ({ ok: res.ok, body })); })
      .then((out) => {
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || '删除失败');
        }
        if (window.Notification) Notification.success('技能已删除');
        notifySkillsChanged();
        if (selectedFilename === filename) selectedFilename = null;
        reloadSkills();
      })
      .catch((err) => {
        if (window.Notification) Notification.error('删除失败：' + (err.message || '未知错误'));
      });
  }

  function reloadSkills() {
    if (!containerEl) return;
    const listEl = containerEl.querySelector('#skills-list');
    const countEl = containerEl.querySelector('#skills-total-count');
    const detailEl = containerEl.querySelector('#skills-detail');

    if (listFetchAbort) listFetchAbort.abort();
    listFetchAbort = new AbortController();

    if (countEl) countEl.textContent = '载入中…';
    fetch('/api/skills', { signal: listFetchAbort.signal })
      .then((res) =>  res.json())
      .then((body) => {
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
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (countEl) countEl.textContent = '加载失败';
        if (listEl) {
          listEl.innerHTML =
            `<div class="skills-empty">加载失败：${escapeHtml(err.message || '未知错误')}</div>`;
        }
      });
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML = '';

    const root = document.createElement('div');
    root.className = 'skills-root';

    const header = document.createElement('header');
    header.className = 'skills-header';
    header.innerHTML =
      '<div class="skills-header-text">' +
        '<h1 class="skills-title">技能库</h1>' +
        '<p class="skills-hint">技能以 Markdown 文件存储，与 <code>user-memory</code> 同级。在聊天输入框输入 <code>#</code> 可快速选用技能。</p>' +
      '</div>' +
      '<div class="skills-header-actions">' +
        '<span class="skills-count" id="skills-total-count">载入中…</span>' +
      '</div>';

    const main = document.createElement('main');
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

    skillsChangedHandler = function () { reloadSkills(); };
    window.addEventListener('ice-skills-changed', skillsChangedHandler);

    reloadSkills();
  }

  return {
    render,
    destroy,
  };
})();

if (typeof window !== 'undefined') {
  window.SkillsPage = SkillsPage;
}
