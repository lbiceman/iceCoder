import { describe, expect, it } from 'vitest';
import { renderChatMarkdown } from '../../src/public/js/chat-markdown.ts';

describe('助手气泡轻量 Markdown', () => {
  it('普通正文没有结构时返回 null，交给原文渲染', () => {
    expect(renderChatMarkdown('改完了，跑过测试。')).toBeNull();
    expect(renderChatMarkdown('第一行\n第二行')).toBeNull();
    expect(renderChatMarkdown('')).toBeNull();
    expect(renderChatMarkdown(null)).toBeNull();
  });

  it('渲染标题、列表、粗体、行内代码和链接', () => {
    const html = renderChatMarkdown([
      '## 结果',
      '',
      '改了 `chat.css`，**已核对**。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '详见 [说明](https://example.com/docs)。',
    ].join('\n'));

    expect(html).toContain('<h2>结果</h2>');
    expect(html).toContain('<code>chat.css</code>');
    expect(html).toContain('<strong>已核对</strong>');
    expect(html).toContain('<ul><li>第一项</li><li>第二项</li></ul>');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('<script');
  });

  it('围栏代码转义 HTML，未闭合围栏也按代码块显示', () => {
    const html = renderChatMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(html).toContain('class="md-code"');
    expect(html).toContain('md-code-lang');
    expect(html).toContain('html');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');

    const open = renderChatMarkdown('```js\nconst x = 1');
    expect(open).toContain('<pre class="md-code">');
    expect(open).toContain('const x = 1');
  });

  it('危险链接和原文 HTML 不会变成可执行节点', () => {
    const html = renderChatMarkdown('**注意** [点我](javascript:alert(1)) <b>hi</b>');
    expect(html).toContain('<strong>注意</strong>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('[点我](javascript:alert(1))');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('管道表格渲染成表格，单元格保留行内格式', () => {
    const html = renderChatMarkdown([
      '难度比例。',
      '',
      '| 段位 | 颜色池 | 要求 |',
      '| --- | ---: | :--- |',
      '| 1-5 | **0.30 → 0.42** | 教学，随手过 |',
      '| 6-15 | 0.45 → 0.62 | 要主动找连消 |',
      '',
      '难度实测单调递增。',
      '',
      '**难度提升的四个维度**',
    ].join('\n'));

    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th>段位</th>');
    expect(html).toContain('<th style="text-align:right">颜色池</th>');
    expect(html).toContain('<th style="text-align:left">要求</th>');
    expect(html).toContain('<td>1-5</td>');
    expect(html).toContain('<strong>0.30 → 0.42</strong>');
    expect(html).toContain('要主动找连消</td>');
    expect(html).toContain('难度实测单调递增。');
    expect(html).toContain('<strong>难度提升的四个维度</strong>');
    expect(html).not.toContain('| 段位 |');
  });

  it('不像表格的管道原文保持原样，代码块里的表格不解析', () => {
    expect(renderChatMarkdown('用 a | b 表示或')).toBeNull();
    expect(renderChatMarkdown('| 只有一行 | 没有分隔 |\n下一句')).toBeNull();

    const fenced = renderChatMarkdown('```md\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```');
    expect(fenced).toContain('<pre class="md-code">');
    expect(fenced).not.toContain('<table');
    expect(fenced).toContain('| A | B |');
  });

  it('任务列表、删除线和裸链接', () => {
    const html = renderChatMarkdown([
      '- [x] 已改完',
      '- [ ] 还要核对',
      '',
      '旧接口 ~~已废弃~~。',
      '文档见 https://example.com/docs。',
    ].join('\n'));

    expect(html).toContain('<li class="md-task is-done"><input type="checkbox" disabled checked>已改完</li>');
    expect(html).toContain('<li class="md-task"><input type="checkbox" disabled>还要核对</li>');
    expect(html).toContain('<del>已废弃</del>');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('>https://example.com/docs</a>');
    expect(html).not.toContain('docs。</a>');
  });

  it('代码块里的删除线和网址保持原文', () => {
    const html = renderChatMarkdown('```txt\n~~nope~~ https://example.com\n```');
    expect(html).toContain('~~nope~~ https://example.com');
    expect(html).not.toContain('<del>');
    expect(html).not.toContain('<a ');
  });

  it('有序列表保留起始序号，引用单独成块', () => {
    const html = renderChatMarkdown('2. 第二项\n3. 第三项\n\n> 备注');
    expect(html).toContain('<ol start="2"><li>第二项</li><li>第三项</li></ol>');
    expect(html).toContain('<blockquote>备注</blockquote>');
  });
});
