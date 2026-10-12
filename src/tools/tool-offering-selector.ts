/**
 * Lazy Tool Offering（文档类工具按需携带）选择器。
 *
 * 注册与携带分离：Registry 始终注册全部工具；每轮按信号
 * （上传/引用路径、消息后缀、语义 intent、会话粘性）裁剪
 * 传给 LLM 的工具定义，减少每轮 tool schema token。
 *
 * 分层：
 * - Tier-0 Core / Tier-2 特殊：非 deferred 工具，永远携带
 *   （含 mcp_*、Shell 协作白名单工具）
 * - Tier-1 Deferred：文档/媒体解析工具，按需激活
 *
 * 规格：docs/requirement/文档工具按需携带-lazy-tool-offering.md
 */

import type { ToolDefinition } from '../llm/types.js';
import { looksLikeFileAnalysisIntent } from '../web/file-browser-direct.js';
import { SHELL_COLLAB_TOOL_NAMES } from './shell-collab-tools.js';

/** Tier-1 按需携带的文档/媒体工具 */
export const DEFERRED_TOOLS = new Set([
  'parse_document',
  'parse_doc_legacy',
  'parse_xlsx_deep',
  'parse_pptx_deep',
  'parse_xmind_deep',
  'notebook_read',
  'image_read',
]);

/**
 * 按用户意图携带的工具：消息像在要周期/延时执行或管理任务时激活，会话内成功用过后粘性保留。
 * 不算文档工具（不进 available-doc-tools、不计入 doc 分类）。宁可多激活，漏激活时模型会退回写脚本。
 */
export const INTENT_GATED_TOOLS = new Set(['scheduled_task']);

const CN_NUM = '(?:\\d+|[一二两三四五六七八九十百半几]+)';
const CN_UNIT = '(?:秒钟?|分钟?|个?小时|个?钟头|天|日|周|星期|礼拜|个?月)';
/** 延时类不含秒：「超时 30 秒后重试」这类是代码逻辑，不是要排任务。 */
const CN_LONG_UNIT = '(?:分钟?|个?小时|个?钟头|天|周|星期|个?月)';
const CN_DAY_PART = '(?:明天|明早|明晚|今晚|今天|每天|早上|上午|中午|下午|晚上|凌晨|[周星期礼拜]+[一二三四五六日天])';
/** 「删除任务相关的代码」「任务卡片的颜色」是在改代码，不是管理任务。 */
const NOT_TASK_CODE = '(?![^。！？\\n]{0,4}(?:相关|卡片|页面|样式|组件|代码|颜色|报错|日志|模块|接口|队列|表|管理|进度|类|状态))';
const TASK_VERB = '(?:启用|停用|暂停|恢复|删除|删掉|删了|关掉|关了|关闭|停掉|停一下|打开|开启|别再|不要再|立即执行|跑一[次下]|执行一[次下]|列一下|列出来|间隔|改成|改为)';
const SCHEDULE_INTENT_PATTERNS: RegExp[] = [
  /(?<!生命)周期(?!表)|定时(?!器)|定个时|定期|定点|每隔|每逢|轮询|计划任务|任务计划|提醒我|到点|准时|闹钟/,
  new RegExp(`每(?:个|一)?${CN_UNIT}(?!的)|每\\s*${CN_NUM}\\s*${CN_UNIT}(?!的)|每[晚早年](?!的)|工作日`),
  new RegExp(`(?<!间)隔\\s*(?:${CN_NUM}\\s*)?${CN_UNIT}|隔天|${CN_NUM}\\s*${CN_LONG_UNIT}[^，。！？\\n\\d]{0,6}一[次回]`),
  new RegExp(`${CN_NUM}\\s*${CN_LONG_UNIT}(?:后|之后|以后)(?!过期|失效|超时)|(?:过|等)\\s*(?:一会儿?|${CN_NUM}\\s*${CN_LONG_UNIT})`),
  new RegExp(`${CN_DAY_PART}\\s*的?\\s*(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})\\s*(?:点|[:：]\\d{2})|[周星期礼拜]+[一二三四五六日天](?:早上|上午|中午|下午|晚上|凌晨)`),
  /(?:持续|一直)(?:监控|关注|检查|观察|跟踪|盯)|帮我盯|盯着/,
  new RegExp(`(?:启用|停用|暂停|恢复|删除|删掉|修改|编辑|查看|列出|立即执行)[^。！？\\n]{0,8}任务${NOT_TASK_CODE}|任务列表${NOT_TASK_CODE}`),
  new RegExp(`任务${NOT_TASK_CODE}[^。！？\\n]{0,8}${TASK_VERB}`),
  /\b(?:cron(?!\s*(?:表达式|解析|expression|syntax|parser))|crontab|schtasks|schedul(?:e|es|ed|ing)|hourly|daily(?![-_])|weekly(?![-_])|monthly(?![-_])|nightly|recurring|periodic(?:ally)?)\b/i,
  /\b(?:remind|ping|notify)\s+me\b|\btell\s+me\s+when\b|\bset\s+an?\s+(?:reminder|alarm|timer)\b/i,
  /\bevery\s+(?:other\s+)?(?:\d+\s*)?(?:sec|second|min|minute|hour|day|week|month|morning|night|evening|weekday)s?\b/i,
  /\bonce\s+(?:an?|per|every)\s+(?:min|minute|hour|day|week|month)\b/i,
  /\b(?:in|after)\s+\d+\s*(?:min|minute|hour|day)s?\b/i,
  /\b(?:keep|continuously)\s+(?:checking|polling|monitoring|watching)\b|\bpoll\s+(?:the|this|that|it)\b/i,
  /\b(?:enable|disable|pause|resume|delete|remove|list|stop)\s+(?:the\s+|my\s+|all\s+)?(?:\w+\s+){0,2}tasks?\b(?!\s+(?:component|class|module|file|queue|code|type))/i,
];

export function looksLikeScheduleIntent(text: string): boolean {
  return SCHEDULE_INTENT_PATTERNS.some((re) => re.test(text));
}

/** 需要记录会话粘性的工具（文档类 + 意图类）。 */
export function isLazyOfferedTool(name: string): boolean {
  return DEFERRED_TOOLS.has(name) || INTENT_GATED_TOOLS.has(name);
}

/** Lazy Tool Offering 恒定开启（不读取环境变量，无关闭开关） */
export function lazyToolOfferingEnabled(): boolean {
  return true;
}

/** 会话 sticky 恒定开启（不读取环境变量） */
export function lazyToolOfferingStickyEnabled(): boolean {
  return true;
}

/** 激活原因日志默认关闭（不读取环境变量） */
export function lazyToolOfferingLogEnabled(): boolean {
  return false;
}

export interface ToolActivationInput {
  /** 用户消息（[file:xxx] 解析后的文本） */
  userMessage: string;
  /** 上传文件绝对路径（resolveFileReferences 返回） */
  uploadedFilePaths: string[];
  /** 显式 @ 引用路径 */
  explicitReferencePaths: string[];
  /** 本会话最近成功调用过的 deferred 工具名（已去重） */
  sessionRecentToolCalls: string[];
  /** file-browser 最近一次 browse 目录 */
  lastBrowsedPath?: string;
  /** 是否 Shell 协作模式 */
  shellCollabActive: boolean;
  /** 是否已有 vision 多模态 inline 图片（此时不激活 image_read） */
  hasInlineVisionImages: boolean;
}

export interface ToolCategorySummary {
  /** 普通聊天模式默认可用（非 deferred、非 mcp） */
  chat: { count: number };
  /** 文档/媒体解析（Lazy Tool Offering，按需激活） */
  doc: { count: number; lazy: true };
  /** /shell 协作模式专用白名单（不进全局 Registry） */
  shell: { count: number };
}

/** 按聊天 / 文档解析 / Shell 模式汇总工具数量（供欢迎页与 /api/tools） */
export function summarizeToolCategories(toolNames: string[]): ToolCategorySummary {
  const builtin = toolNames.filter((n) => n && !n.startsWith('mcp_'));
  const docCount = builtin.filter((n) => DEFERRED_TOOLS.has(n)).length;
  const chatCount = builtin.length - docCount;
  return {
    chat: { count: chatCount },
    doc: { count: docCount, lazy: true },
    shell: { count: SHELL_COLLAB_TOOL_NAMES.length },
  };
}

export interface ToolOfferingResult {
  /** 裁剪后的工具定义 */
  tools: ToolDefinition[];
  /** 激活集合（含 Core） */
  activated: Set<string>;
  /** 调试原因：'ext:.xlsx'、'path:upload.pdf'、'sticky' 等 */
  reasons: string[];
}

/** 后缀 → 工具映射（deep 工具仅接受对应单一格式） */
const EXT_TOOL_MAP: Record<string, string[]> = {
  pdf: ['parse_document'],
  docx: ['parse_document'],
  odt: ['parse_document'],
  odp: ['parse_document'],
  ods: ['parse_document'],
  rtf: ['parse_document'],
  pptx: ['parse_document', 'parse_pptx_deep'],
  ppt: ['parse_document'],
  xlsx: ['parse_document', 'parse_xlsx_deep'],
  xls: ['parse_document'],
  xlsm: ['parse_document'],
  doc: ['parse_document', 'parse_doc_legacy'],
  xmind: ['parse_document', 'parse_xmind_deep'],
  ipynb: ['notebook_read'],
  md: ['parse_document'],
  markdown: ['parse_document'],
  csv: ['parse_document'],
  html: ['parse_document'],
  htm: ['parse_document'],
  txt: ['parse_document'],
  json: ['parse_document'],
  xml: ['parse_document'],
  png: ['image_read'],
  jpg: ['image_read'],
  jpeg: ['image_read'],
  gif: ['image_read'],
  webp: ['image_read'],
  bmp: ['image_read'],
};

/** 语义兜底：消息中出现的具体文档格式词 → 工具（无路径时的保守激活） */
const FORMAT_WORD_RE = /\b(pdf|excel|xlsx|xls|xlsm|word|docx|odt|rtf|ppt|pptx|xmind|ipynb)\b/gi;
const FORMAT_WORD_TOOL_MAP: Record<string, string[]> = {
  pdf: ['parse_document'],
  excel: ['parse_document', 'parse_xlsx_deep'],
  xlsx: ['parse_document', 'parse_xlsx_deep'],
  xls: ['parse_document'],
  xlsm: ['parse_document'],
  word: ['parse_document'],
  doc: ['parse_document', 'parse_doc_legacy'],
  docx: ['parse_document'],
  odt: ['parse_document'],
  rtf: ['parse_document'],
  ppt: ['parse_document'],
  pptx: ['parse_document', 'parse_pptx_deep'],
  xmind: ['parse_document', 'parse_xmind_deep'],
  ipynb: ['notebook_read'],
};

/** 宽泛文档语义词（仅在有上传/引用时作为兜底） */
const DOC_INTENT_RE = /分析|解读|总结|提取|翻译|对比|表格|幻灯|文档|pdf|excel|word|ppt|pptx|xlsx|xmind/i;

/** 工程配置文件（package.json、tsconfig.json、*.lock 等）——消息中提及不激活 parse */
const CONFIG_JSON_RE = /\b(?:package|tsconfig|jsconfig|composer|bower)[\w.-]*\.json\b|\b[\w.-]*\.lock(?:\.json)?\b/i;

/** 路径型：D:\foo\bar.xlsx、./src/a.pdf、/tmp/report.docx */
const PATH_EXT_RE = /(?:^|[\s"'`(]|[/\\])[\w.-]+\.([a-z0-9]{1,8})\b/gi;

/** 纯文件名型：report.xlsx、需求.doc */
const BARE_FILE_RE = /\b([\w\u4e00-\u9fff.-]+)\.([a-z0-9]{1,8})\b/gi;

/** 提取路径后缀（纯字母数字 1-8 位） */
function pathExt(p: string): string {
  const i = p.lastIndexOf('.');
  if (i < 0) return '';
  const base = p.slice(i + 1);
  return /^[a-z0-9]{1,8}$/i.test(base) ? base.toLowerCase() : '';
}

function collectExtsFromMessage(text: string): string[] {
  const exts: string[] = [];
  const pushExt = (ext: string): void => {
    const e = ext.toLowerCase();
    if (!exts.includes(e)) exts.push(e);
  };
  let m: RegExpExecArray | null;
  PATH_EXT_RE.lastIndex = 0;
  while ((m = PATH_EXT_RE.exec(text)) !== null) pushExt(m[1]);
  BARE_FILE_RE.lastIndex = 0;
  while ((m = BARE_FILE_RE.exec(text)) !== null) pushExt(m[2]);
  return exts;
}

function matchFormatWords(text: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  FORMAT_WORD_RE.lastIndex = 0;
  while ((m = FORMAT_WORD_RE.exec(text)) !== null) {
    const w = m[1].toLowerCase();
    if (!found.includes(w)) found.push(w);
  }
  return found;
}

/**
 * 按信号筛选本轮携带的工具定义。
 *
 * - 开关关闭或 Shell 协作模式：全量透传，不裁剪
 * - 其余：Core（非 deferred）恒在；deferred 按 路径 → 消息后缀 → 语义 → 会话粘性 激活
 */
export function selectToolsForOffering(
  allDefs: ToolDefinition[],
  input: ToolActivationInput,
): ToolOfferingResult {
  const reasons: string[] = [];

  if (!lazyToolOfferingEnabled() || input.shellCollabActive) {
    return {
      tools: allDefs,
      activated: new Set(allDefs.map((d) => d.name)),
      reasons: ['lazy-off'],
    };
  }

  const activated = new Set<string>();
  const add = (name: string, reason: string): void => {
    if (!activated.has(name)) {
      activated.add(name);
      reasons.push(`${reason}:${name}`);
    }
  };

  // 1. 上传/引用路径激活（优先级最高）
  for (const p of [...input.uploadedFilePaths, ...input.explicitReferencePaths]) {
    const tools = EXT_TOOL_MAP[pathExt(p)];
    if (tools) {
      for (const t of tools) add(t, 'path');
    }
  }

  // 2. 消息正则（路径型 + 裸文件名型）
  for (const ext of collectExtsFromMessage(input.userMessage)) {
    if (ext === 'json' && CONFIG_JSON_RE.test(input.userMessage)) continue;
    const tools = EXT_TOOL_MAP[ext];
    if (tools) {
      for (const t of tools) add(t, `ext:.${ext}`);
    }
  }

  // 3. 语义兜底
  if (looksLikeFileAnalysisIntent(input.userMessage) && input.lastBrowsedPath) {
    add('parse_document', 'intent+browse');
    add('parse_pptx_deep', 'intent+browse');
  }
  if (
    DOC_INTENT_RE.test(input.userMessage)
    && (input.uploadedFilePaths.length > 0 || input.explicitReferencePaths.length > 0)
  ) {
    add('parse_document', 'doc-intent');
  }
  for (const fmt of matchFormatWords(input.userMessage)) {
    const tools = FORMAT_WORD_TOOL_MAP[fmt];
    if (tools) {
      for (const t of tools) add(t, `format:${fmt}`);
    }
  }

  if (looksLikeScheduleIntent(input.userMessage)) {
    for (const name of INTENT_GATED_TOOLS) add(name, 'schedule-intent');
  }

  // 4. 会话粘性
  if (lazyToolOfferingStickyEnabled()) {
    for (const name of input.sessionRecentToolCalls) {
      if (isLazyOfferedTool(name)) add(name, 'sticky');
    }
  }

  // 5. 多模态 inline 图片已随消息发送 → 不激活 image_read
  if (input.hasInlineVisionImages) {
    activated.delete('image_read');
  }

  // 组装：Core（非 deferred）恒在，deferred / 意图类仅保留激活项
  const tools = allDefs.filter((d) => !isLazyOfferedTool(d.name) || activated.has(d.name));

  return { tools, activated, reasons };
}

/**
 * 生成注入 Harness systemContext 的文档工具说明（Prompt 与 tools 对齐，Phase 3）。
 * 未激活任何 Tier-1 或开关关闭时返回空对象，不注入任何 parse 指引。
 */
export function buildAvailableDocToolsContext(activatedDocTools: string[]): Record<string, string> {
  if (!lazyToolOfferingEnabled() || activatedDocTools.length === 0) return {};
  return { 'available-doc-tools': activatedDocTools.join(', ') };
}

/** CLI 端会话级 deferred 工具采集（进程内存；sessionId 通常为 'default'） */
const cliSessionDeferredToolCalls = new Map<string, string[]>();

export function recordCliDeferredToolCall(sessionId: string, toolName: string): void {
  if (!DEFERRED_TOOLS.has(toolName)) return;
  const list = cliSessionDeferredToolCalls.get(sessionId) ?? [];
  if (!list.includes(toolName)) {
    list.push(toolName);
    cliSessionDeferredToolCalls.set(sessionId, list);
  }
}

export function getCliDeferredToolCalls(sessionId: string): string[] {
  return cliSessionDeferredToolCalls.get(sessionId) ?? [];
}
