import { describe, it, expect } from 'vitest';
import {
  selectToolsForOffering,
  DEFERRED_TOOLS,
  buildAvailableDocToolsContext,
  summarizeToolCategories,
} from '../../src/tools/tool-offering-selector.js';
import type { ToolDefinition } from '../../src/llm/types.js';

const CORE_NAMES = ['read_file', 'write_file', 'edit_file', 'run_command', 'glob', 'grep'];

function makeDefs(): ToolDefinition[] {
  const names = [
    ...CORE_NAMES,
    ...DEFERRED_TOOLS,
    'request_analysis',
    'mcp_puppeteer_navigate',
  ];
  return names.map((name) => ({
    name,
    description: `desc of ${name}`,
    parameters: { type: 'object', properties: {} },
  }));
}

function offeredNames(result: ReturnType<typeof selectToolsForOffering>): string[] {
  return result.tools.map((t) => t.name).sort();
}

function baseInput(overrides: Partial<Parameters<typeof selectToolsForOffering>[1]> = {}) {
  return {
    userMessage: '',
    uploadedFilePaths: [],
    explicitReferencePaths: [],
    sessionRecentToolCalls: [],
    shellCollabActive: false,
    hasInlineVisionImages: false,
    ...overrides,
  };
}

describe('selectToolsForOffering', () => {
  it('无信号 → 仅 Core，无 parse_*', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '帮我把 utils.ts 里的 foo 改成 bar' }));
    const names = offeredNames(result);
    expect(names).not.toContain('parse_document');
    expect(names).not.toContain('parse_xlsx_deep');
    expect(names).toContain('read_file');
    expect(names).toContain('run_command');
    expect(names).toContain('request_analysis');
    expect(names).toContain('mcp_puppeteer_navigate');
  });

  it('消息含 report.xlsx → parse_document + parse_xlsx_deep', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '分析 report.xlsx' }));
    const names = offeredNames(result);
    expect(names).toContain('parse_document');
    expect(names).toContain('parse_xlsx_deep');
  });

  it('上传 path/to/a.pdf → parse_document', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({
      uploadedFilePaths: ['C:\\uploads\\a.pdf'],
    }));
    const names = offeredNames(result);
    expect(names).toContain('parse_document');
    expect(names).not.toContain('parse_xlsx_deep');
  });

  it('消息含 app.ts → 不激活 parse', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '看看 app.ts 的导入' }));
    expect(offeredNames(result)).not.toContain('parse_document');
  });

  it('sticky：上轮用过 parse_xlsx_deep，本轮无后缀 → 仍携带', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({
      userMessage: '把第 3 列求和',
      sessionRecentToolCalls: ['parse_xlsx_deep'],
    }));
    expect(offeredNames(result)).toContain('parse_xlsx_deep');
  });

  it('sticky 过期：上轮用过但新消息无文档信号 → 仍携带（直至过期策略）', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({
      userMessage: '把 utils.ts 里的 foo 改成 bar',
      sessionRecentToolCalls: ['parse_xlsx_deep'],
    }));
    expect(offeredNames(result)).toContain('parse_xlsx_deep');
  });

  it('shellCollabActive=true → 透传原 toolDefs，不裁剪', () => {
    const defs = makeDefs();
    const result = selectToolsForOffering(defs, baseInput({ shellCollabActive: true }));
    expect(result.tools).toBe(defs);
    expect(offeredNames(result)).toEqual(defs.map((d) => d.name).sort());
  });

  it('hasInlineVisionImages=true → 不携带 image_read', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({
      userMessage: '分析 cat.png',
      hasInlineVisionImages: true,
    }));
    expect(offeredNames(result)).not.toContain('image_read');
    expect(offeredNames(result)).not.toContain('parse_document');
  });

  it('格式词无路径 → 保守激活对应工具', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '分析一下这个 Excel' }));
    const names = offeredNames(result);
    expect(names).toContain('parse_document');
    expect(names).toContain('parse_xlsx_deep');
  });

  it('package.json → 不激活 parse（工程配置文件排除）', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '看看 package.json 的 scripts' }));
    expect(offeredNames(result)).not.toContain('parse_document');
  });

  it('tsconfig.json / lock 文件 → 不激活 parse', () => {
    const r1 = selectToolsForOffering(makeDefs(), baseInput({ userMessage: 'tsconfig.json 报错' }));
    expect(offeredNames(r1)).not.toContain('parse_document');
    const r2 = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '更新 package-lock.json' }));
    expect(offeredNames(r2)).not.toContain('parse_document');
  });

  it('数据类 json（非工程配置）→ 仍激活 parse_document', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '分析 data.json' }));
    expect(offeredNames(result)).toContain('parse_document');
  });

  it('「看看 doc」→ 不激活 parse（doc 格式词严格化）', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '看看 doc 里怎么写的' }));
    expect(offeredNames(result)).not.toContain('parse_document');
  });

  it('「分析 report.docx」→ 激活 parse_document', () => {
    const result = selectToolsForOffering(makeDefs(), baseInput({ userMessage: '分析 report.docx' }));
    expect(offeredNames(result)).toContain('parse_document');
  });
});

describe('summarizeToolCategories', () => {
  it('splits builtin tools into chat, doc lazy, and shell counts', () => {
    const names = makeDefs().map((d) => d.name);
    const summary = summarizeToolCategories(names);
    expect(summary.chat.count).toBe(CORE_NAMES.length + 1); // + request_analysis
    expect(summary.doc.count).toBe(DEFERRED_TOOLS.size);
    expect(summary.doc.lazy).toBe(true);
    expect(summary.shell.count).toBe(8);
  });

  it('excludes mcp tools from chat and doc buckets', () => {
    const summary = summarizeToolCategories(['read_file', 'mcp_foo', 'parse_document']);
    expect(summary.chat.count).toBe(1);
    expect(summary.doc.count).toBe(1);
  });
});

describe('buildAvailableDocToolsContext', () => {
  it('未激活 Tier-1 → 返回空对象（不注入 parse 指引）', () => {
    expect(buildAvailableDocToolsContext([])).toEqual({});
  });

  it('已激活 → 注入 available-doc-tools', () => {
    expect(buildAvailableDocToolsContext(['parse_document', 'parse_xlsx_deep'])).toEqual({
      'available-doc-tools': 'parse_document, parse_xlsx_deep',
    });
  });
});
