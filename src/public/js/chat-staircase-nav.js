/**
 * 楼梯导航：会话消息超过阈值时，在聊天区右侧展示横线导航；
 * 悬停显示用户输入列表，点击滚动到对应位置。
 */

/* exported ChatStaircaseNav */

window.ChatStaircaseNav = (function () {
  'use strict';

  var MESSAGE_THRESHOLD = 10;
  var MAX_COLLAPSED_LINES = 15;
  var POPOVER_HOVER_DELAY_MS = 120;
  var POPOVER_LEAVE_DELAY_MS = 200;

  var elNav = null;
  var elLines = null;
  var elPopover = null;
  var elPopoverList = null;
  var elMessages = null;
  var getMessages = null;
  var hoverTimer = null;
  var leaveTimer = null;
  var isPopoverOpen = false;
  var userTurnsCache = [];

  function init(opts) {
    elMessages = opts.elMessages || null;
    getMessages = typeof opts.getMessages === 'function' ? opts.getMessages : null;
    ensureNav(opts.elMain);
    if (elMessages) {
      elMessages.addEventListener('scroll', onScroll, { passive: true });
    }
    refresh();
  }

  function ensureNav(host) {
    if (elNav || !host) return;

    elNav = document.createElement('div');
    elNav.className = 'chat-staircase-nav hidden';
    elNav.setAttribute('aria-label', '消息导航');

    elLines = document.createElement('div');
    elLines.className = 'chat-staircase-lines';

    elPopover = document.createElement('div');
    elPopover.className = 'chat-staircase-popover hidden';
    elPopover.setAttribute('role', 'tooltip');

    elPopoverList = document.createElement('ul');
    elPopoverList.className = 'chat-staircase-popover-list';
    elPopover.appendChild(elPopoverList);

    elNav.appendChild(elPopover);
    elNav.appendChild(elLines);

    elNav.addEventListener('mouseenter', onNavEnter);
    elNav.addEventListener('mouseleave', onNavLeave);

    host.appendChild(elNav);
  }

  function getUserTurns(messages) {
    var turns = [];
    if (!Array.isArray(messages)) return turns;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        turns.push({
          msgIndex: i,
          content: typeof messages[i].content === 'string' ? messages[i].content : '',
        });
      }
    }
    return turns;
  }

  /** 根据用户轮次数量决定横线分组步长：≤30 每条一线，≤50 每 3 条一线，>50 每 5 条一线 */
  function getLineGroupStep(userTurnCount) {
    if (userTurnCount <= 30) return 1;
    if (userTurnCount <= 50) return 3;
    return 5;
  }

  function resolveLineGroupStep(userTurnCount) {
    var step = getLineGroupStep(userTurnCount);
    while (userTurnCount > 0 && Math.ceil(userTurnCount / step) > MAX_COLLAPSED_LINES) {
      step += 1;
    }
    return step;
  }

  function truncateText(text, maxLen) {
    var s = (text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '（空消息）';
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '…';
  }

  function buildLineGroups(turns, step) {
    var groups = [];
    for (var i = 0; i < turns.length; i += step) {
      groups.push({
        turns: turns.slice(i, i + step),
        firstMsgIndex: turns[i].msgIndex,
      });
    }
    return groups;
  }

  function scrollToTurn(msgIndex) {
    if (window.ChatUI && typeof window.ChatUI.scrollToMessageIndex === 'function') {
      window.ChatUI.scrollToMessageIndex(msgIndex, getMessages ? getMessages() : []);
    }
  }

  function renderLines() {
    if (!elLines) return;
    elLines.innerHTML = '';

    var step = resolveLineGroupStep(userTurnsCache.length);
    var groups = buildLineGroups(userTurnsCache, step);

    for (var g = 0; g < groups.length; g++) {
      (function (group, groupIndex) {
        var line = document.createElement('button');
        line.type = 'button';
        line.className = 'chat-staircase-line';
        line.setAttribute('data-msg-index', String(group.firstMsgIndex));
        line.setAttribute('aria-label', '跳转到第 ' + (groupIndex + 1) + ' 段对话');

        var widthLevel = (groupIndex % 4) + 1;
        line.style.setProperty('--stair-width-level', String(widthLevel));

        line.addEventListener('click', function (e) {
          e.stopPropagation();
          scrollToTurn(group.firstMsgIndex);
        });

        elLines.appendChild(line);
      })(groups[g], g);
    }
  }

  function renderPopoverList() {
    if (!elPopoverList) return;
    elPopoverList.innerHTML = '';

    for (var i = 0; i < userTurnsCache.length; i++) {
      (function (turn, turnIndex) {
        var item = document.createElement('li');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-staircase-popover-item';
        btn.setAttribute('data-msg-index', String(turn.msgIndex));

        var indexEl = document.createElement('span');
        indexEl.className = 'chat-staircase-popover-index';
        indexEl.textContent = String(turnIndex + 1);

        var textEl = document.createElement('span');
        textEl.className = 'chat-staircase-popover-text';
        textEl.textContent = truncateText(turn.content, 80);

        btn.appendChild(indexEl);
        btn.appendChild(textEl);
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          scrollToTurn(turn.msgIndex);
          closePopover();
        });

        item.appendChild(btn);
        elPopoverList.appendChild(item);
      })(userTurnsCache[i], i);
    }
  }

  function openPopover() {
    if (!elPopover || !elLines) return;
    isPopoverOpen = true;
    elPopover.classList.remove('hidden');
    elLines.classList.add('is-hidden');
    elNav.classList.add('is-expanded');
  }

  function closePopover() {
    if (!elPopover || !elLines) return;
    isPopoverOpen = false;
    elPopover.classList.add('hidden');
    elLines.classList.remove('is-hidden');
    elNav.classList.remove('is-expanded');
  }

  function onNavEnter() {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = 0;
    }
    if (isPopoverOpen) return;
    hoverTimer = setTimeout(function () {
      hoverTimer = 0;
      openPopover();
    }, POPOVER_HOVER_DELAY_MS);
  }

  function onNavLeave() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = 0;
    }
    leaveTimer = setTimeout(function () {
      leaveTimer = 0;
      closePopover();
    }, POPOVER_LEAVE_DELAY_MS);
  }

  function applyActiveHighlight(activeIndex) {
    var lineBtns = elLines ? elLines.querySelectorAll('.chat-staircase-line') : [];
    for (var li = 0; li < lineBtns.length; li++) {
      var lineIdx = parseInt(lineBtns[li].getAttribute('data-msg-index') || '-1', 10);
      var nextLineIdx = li + 1 < lineBtns.length
        ? parseInt(lineBtns[li + 1].getAttribute('data-msg-index') || '-1', 10)
        : Infinity;
      if (activeIndex >= lineIdx && activeIndex < nextLineIdx) {
        lineBtns[li].classList.add('is-active');
      } else {
        lineBtns[li].classList.remove('is-active');
      }
    }

    var popItems = elPopoverList ? elPopoverList.querySelectorAll('.chat-staircase-popover-item') : [];
    for (var pi = 0; pi < popItems.length; pi++) {
      var itemIdx = parseInt(popItems[pi].getAttribute('data-msg-index') || '-1', 10);
      if (itemIdx === activeIndex) popItems[pi].classList.add('is-active');
      else popItems[pi].classList.remove('is-active');
    }
  }

  function updateActiveHighlight() {
    if (!elMessages || !elNav || elNav.classList.contains('hidden')) return;

    var activeIndex = -1;
    if (window.ChatUI && typeof window.ChatUI.getActiveUserMsgIndex === 'function') {
      activeIndex = window.ChatUI.getActiveUserMsgIndex();
    }

    if (activeIndex < 0 && userTurnsCache.length > 0) {
      activeIndex = userTurnsCache[0].msgIndex;
    }

    applyActiveHighlight(activeIndex);
  }

  var scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      updateActiveHighlight();
    });
  }

  function notifyScrollSync() {
    onScroll();
  }

  function refresh() {
    if (!elNav) return;

    var messages = getMessages ? getMessages() : [];
    userTurnsCache = getUserTurns(messages);

    if (messages.length <= MESSAGE_THRESHOLD || userTurnsCache.length === 0) {
      elNav.classList.add('hidden');
      closePopover();
      return;
    }

    elNav.classList.remove('hidden');
    renderLines();
    renderPopoverList();
    updateActiveHighlight();
  }

  return {
    init: init,
    refresh: refresh,
    notifyScrollSync: notifyScrollSync,
  };
})();
