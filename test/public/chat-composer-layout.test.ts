import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const CHAT_CSS = readFileSync(path.join(publicRoot, 'css/chat.css'), 'utf-8');
const TOKENS_CSS = readFileSync(path.join(publicRoot, 'css/tokens.css'), 'utf-8');
const CHAT_UI_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-ui.js'), 'utf-8');
const ETL_CSS = readFileSync(path.join(publicRoot, 'css/chat-execution-plan.css'), 'utf-8');
const ETL_PANEL_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-execution-plan.js'), 'utf-8');
const ETL_BRIDGE_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-execution-plan-bridge.js'), 'utf-8');
const ETL_FLOW_STORE_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-execution-flow-store.js'), 'utf-8');

let browser: Browser;
const openPages = new Set<Page>();

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

afterEach(async () => {
  await Promise.all([...openPages].map(async (page) => {
    try {
      if (!page.isClosed()) await page.close();
    } finally {
      openPages.delete(page);
    }
  }));
});

function readPublic(relativePath: string): string {
  return readFileSync(path.join(publicRoot, relativePath), 'utf-8');
}

describe('聊天输入区与欢迎页布局审计', () => {
  it('CSS 包含可滚动欢迎页与输入区高度联动令牌', () => {
    expect(CHAT_CSS).toMatch(/\.chat-welcome\s*\{[\s\S]*flex:\s*0\s+0\s+auto[\s\S]*min-height:\s*100%/);
    expect(CHAT_CSS).toContain('--chat-composer-stack-height');
    expect(CHAT_CSS).toMatch(/\.chat-jump-bottom[\s\S]*var\(--chat-composer-stack-height/);
    expect(CHAT_CSS).toMatch(/\.session-pet-indicator:not\(\.session-pet-indicator--placed\)[\s\S]*var\(--chat-composer-stack-height/);
    expect(CHAT_CSS).toMatch(/max-height:\s*min\(220px,\s*38vh\)/);
    expect(CHAT_CSS).toMatch(/overflow-y:\s*auto/);
    expect(CHAT_CSS).toContain('overscroll-behavior: contain');
    expect(CHAT_CSS).toContain('field-sizing: content');
    expect(CHAT_CSS).toContain('.composer-file-input');
    expect(CHAT_UI_SOURCE).toContain('ice:composer-layout');
    expect(CHAT_UI_SOURCE).toContain("elInput.style.overflowY = 'auto'");
    expect(CHAT_UI_SOURCE).not.toContain("elInput.style.height = '0px'");
    expect(readPublic('js/session-pet.js')).toContain('ice:composer-layout');
  });

  it('ETL 面板使用统一滚动容器且目标摘要可截断', () => {
    expect(ETL_CSS).toMatch(/\.etl-main-scroll[\s\S]*overflow-y:\s*auto/);
    expect(ETL_PANEL_SOURCE).toContain('etl-main-scroll');
    expect(ETL_PANEL_SOURCE).toContain('function formatGoalDisplay');
    expect(ETL_PANEL_SOURCE).toContain('[Active Skill:');
  });

  it('多行输入时欢迎页仍可滚到顶部且输入框内部滚动', async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 520 } });
    openPages.add(page);

    await page.setContent(
      '<!DOCTYPE html><html data-theme="dark"><head></head><body style="margin:0;height:100vh;display:flex;">' +
        '<div class="chat-page" style="flex:1;min-height:0;display:flex;flex-direction:column;">' +
          '<div class="chat-main" style="flex:1;min-height:0;display:flex;flex-direction:column;">' +
            '<div class="chat-messages has-welcome" id="chat-messages">' +
              '<div class="chat-welcome" id="chat-welcome">' +
                '<div class="chat-welcome-inner">' +
                  '<header class="chat-welcome-header"><h1 class="chat-welcome-title">IceCoder 已就绪</h1></header>' +
                  '<section class="chat-welcome-section"><h2 class="chat-welcome-section-title">快速上手</h2>' +
                    '<div class="chat-welcome-tips">' +
                      Array.from({ length: 14 }, (_, i) =>
                        '<div class="chat-welcome-tip"><div class="chat-welcome-tip-title">提示 ' + (i + 1) + '</div></div>',
                      ).join('') +
                    '</div></section>' +
                  '<section class="chat-welcome-section"><h2 class="chat-welcome-section-title">当前上下文</h2></section>' +
                '</div>' +
              '</div>' +
              '<div class="chat-history-outer"><div class="chat-history-window"></div></div>' +
              '<div class="chat-tail-root"><div class="chat-tail-anchor"></div></div>' +
              '<div class="chat-messages-anchor" id="chat-anchor"></div>' +
            '</div>' +
            '<div class="chat-input-area">' +
              '<div class="chat-composer-stack">' +
                '<div class="chat-composer">' +
                  '<div class="composer-input"><div class="input-wrapper">' +
                    '<textarea id="chat-input" rows="2"></textarea>' +
                  '</div></div>' +
                  '<div class="composer-toolbar"><button type="button">send</button></div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</body></html>',
    );
    await page.addStyleTag({ content: TOKENS_CSS + CHAT_CSS });
    await page.addScriptTag({ content: CHAT_UI_SOURCE });
    await page.evaluate(() => {
      const ui = (window as any).ChatUI;
      ui.init({
        elMessages: document.getElementById('chat-messages'),
        elAnchor: document.getElementById('chat-anchor'),
        elInput: document.getElementById('chat-input') as HTMLTextAreaElement,
        elSendBtn: document.querySelector('.composer-toolbar button'),
      });
      const input = document.getElementById('chat-input') as HTMLTextAreaElement;
      input.value = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
      ui.autoResizeInput();
    });

    const metrics = await page.evaluate(() => {
      const messages = document.getElementById('chat-messages') as HTMLElement;
      const input = document.getElementById('chat-input') as HTMLTextAreaElement;
      const main = document.querySelector('.chat-main') as HTMLElement;
      const welcomeTitle = document.querySelector('.chat-welcome-title') as HTMLElement;
      messages.scrollTop = 0;
      const titleRect = welcomeTitle.getBoundingClientRect();
      const messagesRect = messages.getBoundingClientRect();
      return {
        scrollHeight: messages.scrollHeight,
        clientHeight: messages.clientHeight,
        scrollable: messages.scrollHeight > messages.clientHeight + 8,
        scrollTop: messages.scrollTop,
        titleVisible: titleRect.top >= messagesRect.top - 2,
        composerVar: main.style.getPropertyValue('--chat-composer-stack-height'),
        inputOverflow: window.getComputedStyle(input).overflowY,
        inputHeight: input.getBoundingClientRect().height,
        maxHeight: window.getComputedStyle(input).maxHeight,
      };
    });

    expect(metrics.scrollable).toBe(true);
    expect(metrics.scrollTop).toBe(0);
    expect(metrics.titleVisible).toBe(true);
    expect(metrics.composerVar).not.toBe('');
    expect(metrics.inputOverflow).toBe('auto');
    expect(parseFloat(metrics.maxHeight)).toBeGreaterThan(0);
    expect(metrics.inputHeight).toBeLessThanOrEqual(parseFloat(metrics.maxHeight) + 1);
    await page.close();
  });

  it('监管模式下 ETL 长 skill 目标不会撑破滚动容器', async () => {
    const page = await browser.newPage({ viewport: { width: 420, height: 640 } });
    openPages.add(page);
    await page.setContent(
      '<html data-theme="dark"><body style="margin:0;height:640px;">' +
        '<nav id="top-nav"></nav></body></html>',
    );
    await page.addStyleTag({ content: TOKENS_CSS + ETL_CSS });
    await page.evaluate(() => {
      (window as any).EtlPrefs = {
        getKey: () => true,
        onChange: () => () => {},
      };
      (window as any).ChatPetBridge = { syncExecPlanFoot: () => {} };
      (window as any).ChatSessionStore = { getActiveSessionId: () => 'audit-session' };
      (window as any).fetch = () => new Promise(() => {});
    });
    await page.addScriptTag({ content: ETL_PANEL_SOURCE });
    await page.addScriptTag({ content: ETL_FLOW_STORE_SOURCE });
    await page.addScriptTag({ content: ETL_BRIDGE_SOURCE });
    await page.evaluate(() => {
      (window as any).ChatExecutionPlan.setPageActive(true);
      (window as any).ChatExecutionPlanBridge.notifyConnected({
        features: { executionPlan: true },
      });
      const skillBody = '步骤一\n'.repeat(80);
      const plan = {
        planId: 'audit-plan',
        goal: `[Active Skill: examLogin/skill.md]\n${skillBody}`,
        intent: 'troubleshoot',
        progress: 10,
        activeStepId: 's0',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now(),
        steps: [{ id: 's0', title: '步骤一', status: 'running' }],
      };
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.handleStep({ type: 'task_graph_init', plan });
      bridge.handleStep({
        type: 'execution_mode_enter',
        ts: Date.now(),
        executionMode: {
          executionMode: 'forced',
          enteredByPrimary: 'tool_failure',
          enteredBy: ['tool_failure'],
          primaryReasonHuman: '工具失败',
          round: 3,
        },
      });
    });

    await page.evaluate(() => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      for (let i = 1; i <= 12; i += 1) {
        bridge.handleStep({
          type: 'tool_call',
          iteration: i,
          toolCallId: 'tc-' + i,
          toolName: 'read_file',
          toolArgs: { path: 'src/file-' + i + '.ts' },
        });
        bridge.handleStep({
          type: 'tool_result',
          iteration: i,
          toolCallId: 'tc-' + i,
          toolName: 'read_file',
          toolSuccess: true,
        });
      }
    });

    const result = await page.evaluate(() => {
      const panel = document.getElementById('exec-transparency-panel') as HTMLElement;
      const scroll = panel.querySelector('.etl-main-scroll') as HTMLElement;
      const goal = document.querySelector('#etl-overview-goal')?.textContent || '';
      scroll.scrollTop = scroll.scrollHeight;
      const banner = panel.querySelector('.exec-plan-mode-banner') as HTMLElement;
      const overflowY = window.getComputedStyle(scroll).overflowY;
      return {
        hasScrollRegion: !!scroll,
        overflowY,
        scrollable: scroll.scrollHeight > scroll.clientHeight + 4,
        canReachBottom: scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4,
        goal,
        goalNotFullSkill: !goal.includes('步骤一\n步骤一'),
        bannerVisible: banner && !banner.classList.contains('hidden'),
        roundCount: document.querySelectorAll('#etl-round-timeline .etl-round-node').length,
      };
    });

    expect(result.hasScrollRegion).toBe(true);
    expect(result.overflowY).toBe('auto');
    expect(result.scrollable).toBe(true);
    expect(result.canReachBottom).toBe(true);
    expect(result.roundCount).toBeGreaterThan(0);
    expect(result.goal).toBe('[Active Skill: examLogin/skill.md]');
    expect(result.goalNotFullSkill).toBe(true);
    expect(result.bannerVisible).toBe(true);
    await page.close();
  });
});
