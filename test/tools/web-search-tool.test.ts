import { describe, expect, it, beforeAll } from 'vitest';
import { createWebSearchTool, parseBingCnHtml } from '../../src/tools/builtin/web-search-tool.js';

const BING_FIXTURE = `
<ul id="b_results">
  <li class="b_algo">
    <h2><a href="https://example.com/a">Result A</a></h2>
    <div class="b_caption"><p>Snippet for A</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://example.com/b">Result B</a></h2>
    <p class="b_lineclamp2">Snippet for B</p>
  </li>
</ul>`;

describe('web_search tool', () => {
  it('parseBingCnHtml extracts title, url, and snippet', () => {
    const results = parseBingCnHtml(BING_FIXTURE, 8);
    expect(results).toEqual([
      { title: 'Result A', url: 'https://example.com/a', snippet: 'Snippet for A' },
      { title: 'Result B', url: 'https://example.com/b', snippet: 'Snippet for B' },
    ]);
  });

  it('defaults engine to bing_cn', () => {
    const tool = createWebSearchTool();
    expect(tool.definition.parameters.properties.engine.default).toBe('bing_cn');
    expect(tool.definition.parameters.properties.engine.enum).toContain('bing_cn');
  });

  describe('integration', () => {
    let bingAvailable = false;

    beforeAll(async () => {
      try {
        const response = await fetch('https://cn.bing.com/search?q=test&ensearch=0', {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        bingAvailable = response.ok;
      } catch {
        bingAvailable = false;
      }
    });

    it('searches via bing_cn by default', async () => {
      if (!bingAvailable) return;
      const tool = createWebSearchTool();
      const result = await tool.handler({ query: 'deepseek', maxResults: 3 });
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/找到 \d+ 条结果/);
      expect(result.output).toMatch(/https?:\/\//);
    });
  });
});
