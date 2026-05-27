/**
 * ~open 目录列举：服务端对 list_drives / browse_directory 的确定性执行。
 * 与「是否允许解析文件」无关；仅避免模型编造磁盘列表。
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolCall } from '../llm/types.js';

const MARKER_OPEN = /(?:^|\n)\s*~open\b/;
/** 与前端注入标题一致时视为 ~open 会话（兼容旧文案） */
const MARKER_UI_ZH = /【(?:文件浏览器模式|目录列举|目录浏览[^】]*)】/;

/** 用户希望基于目录内容做推理时使用 Harness，但先注入真实 browse 输出 */
const ANALYSIS_HINT =
  /分析|解读|总结|评价|介绍一下|干什么用|什么项目|readme|看看.*项目|了解下|说明一下|讲讲/i;

/** 是否与「分析/总结目录或文件」语义相近（供 chat-ws 注入「最近一次列出路径」提示） */
export function looksLikeFileAnalysisIntent(text: string): boolean {
  return ANALYSIS_HINT.test(normalizeTyping(text));
}

function normalizeTyping(text: string): string {
  return text.replace(/：/g, ':').trim();
}

export function detectFileBrowserOpen(rawMessage: string): boolean {
  const t = rawMessage.trimStart();
  return MARKER_OPEN.test(rawMessage) || (t.startsWith('~open') && MARKER_UI_ZH.test(rawMessage));
}

/**
 * 提取 Windows 绝对路径候选（含 `D:\foo\bar`、`D:`、`D:/`）。
 */
export function extractWindowsAbsolutePaths(text: string): string[] {
  const n = normalizeTyping(text);
  const found = new Set<string>();

  const fullRe = /\b([a-zA-Z]:)([/\\][^\s\n"'`|<>?*]+)+/gi;
  let m: RegExpExecArray | null;
  while ((m = fullRe.exec(n)) !== null) {
    found.add(path.win32.normalize(m[0].replace(/\//g, '\\')));
  }

  const bareRe = /\b([a-zA-Z]):(?=\s|$|[，。．,!；;])/gi;
  while ((m = bareRe.exec(n)) !== null) {
    found.add(`${m[1].toUpperCase()}:\\`);
  }

  return [...found];
}

function longestPath(paths: string[]): string {
  return paths.reduce((a, b) => (b.length > a.length ? b : a), paths[0] ?? '');
}

/** 是否像「目录导航」短指令（避免在长代码对话里误抢） */
export function looksLikeBrowserNavigation(text: string): boolean {
  const t = normalizeTyping(text);
  if (t.length <= 140) return true;
  if (/进入|打开|返回|上一级|后退|刷新|重新列出|重新加载|盘\b|驱动器/i.test(t)) return true;
  if (/[a-zA-Z]:[/\\]/i.test(t)) return true;
  return false;
}

/** 解析「进入D盘」「打开 D:」等为根路径 */
export function parseDriveLetterIntent(text: string): string | null {
  const t = normalizeTyping(text);
  const patterns: RegExp[] = [
    /(?:进入|打开)\s*([a-zA-Z])\s*盘/i,
    /(?:进入|打开)\s*([a-zA-Z])\s*:?\s*$/i,
    /^\s*([a-zA-Z])\s*盘\s*[!！。.]*$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) {
      return `${m[1].toUpperCase()}:\\`;
    }
  }
  return null;
}

export type DirectTurnResult =
  | { handled: false }
  | {
      handled: true;
      variant: 'deterministic';
      toolName: string;
      toolDetail: string;
      assistantMarkdown: string;
      success: boolean;
      newLastBrowsedPath: string | null;
    }
  | {
      handled: true;
      variant: 'harness_augment';
      augmentedUserText: string;
      newLastBrowsedPath: string | null;
    };

async function execTool(
  toolExecutor: ToolExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; output: string; error?: string }> {
  const tc: ToolCall = {
    id: randomUUID(),
    name,
    arguments: args,
  };
  const r = await toolExecutor.executeTool(tc);
  return { success: r.success, output: r.output || '', error: r.error };
}

/** 根据 browse 参数推断会话里的「当前目录」 */
export function inferLastBrowsedDir(browseArgPath: string): string {
  const norm = path.win32.normalize(browseArgPath.replace(/\//g, '\\'));
  return norm.endsWith('\\') ? norm : `${norm}\\`;
}

function winParentOrRoot(dirPath: string): string | 'list_drives' {
  const norm = path.win32.normalize(dirPath.replace(/\//g, '\\'));
  const withSlash = norm.endsWith('\\') ? norm : `${norm}\\`;
  const parent = path.win32.dirname(withSlash);
  if (parent === withSlash || /^[a-zA-Z]:\\?$/i.test(withSlash.replace(/\\+$/, '\\'))) {
    return 'list_drives';
  }
  return parent.endsWith('\\') ? parent : `${parent}\\`;
}

/**
 * 尝试在本机直接执行 list_drives / browse_directory，完全绕过模型。
 */
export async function tryDirectFileBrowserTurn(options: {
  toolExecutor: ToolExecutor;
  resolvedText: string;
  opensBrowser: boolean;
  /** 上一 successful browse 目录（以 \\ 结尾） */
  lastBrowsedPath: string | null;
  platform: NodeJS.Platform;
  hasImages: boolean;
  /** 当前是否在目录列举会话中（本进程内曾发送过 ~open，直至切换/删除会话；用于确定性导航） */
  active: boolean;
}): Promise<DirectTurnResult> {
  const {
    toolExecutor,
    resolvedText,
    opensBrowser,
    lastBrowsedPath,
    platform,
    hasImages,
    active,
  } = options;

  if (hasImages || platform !== 'win32') return { handled: false };

  const text = normalizeTyping(resolvedText);

  // ~open 同条消息：强制真实 list_drives
  if (opensBrowser) {
    const r = await execTool(toolExecutor, 'list_drives', {});
    const body = r.success ? r.output : (r.error ?? '列出驱动器失败');
    return {
      handled: true,
      variant: 'deterministic',
      toolName: 'list_drives',
      toolDetail: '',
      assistantMarkdown: formatAssistantFromToolOutput(body, r.success),
      success: r.success,
      newLastBrowsedPath: null,
    };
  }

  if (!active) return { handled: false };

  const paths = extractWindowsAbsolutePaths(text);
  const wantsAnalysis = looksLikeFileAnalysisIntent(text);

  if (wantsAnalysis && paths.length > 0) {
    const target = longestPath(paths);
    const r = await execTool(toolExecutor, 'browse_directory', { path: target });
    const body = r.success ? r.output : (r.error ?? 'browse_directory 失败');
    const augmentedUserText = [
      '[SERVER_REAL_TOOL_OUTPUT browse_directory — 禁止编造磁盘列表；下列内容为工具真实返回]',
      body,
      '',
      '---',
      '用户原始请求：',
      resolvedText,
    ].join('\n');
    return {
      handled: true,
      variant: 'harness_augment',
      augmentedUserText,
      newLastBrowsedPath: r.success ? inferLastBrowsedDir(target) : lastBrowsedPath,
    };
  }

  if (!looksLikeBrowserNavigation(text)) return { handled: false };

  // 刷新驱动器列表
  if (/^(刷新|重新列出|重新加载)$/i.test(text) || /^列出.*驱动/i.test(text)) {
    const r = await execTool(toolExecutor, 'list_drives', {});
    const body = r.success ? r.output : (r.error ?? '');
    return {
      handled: true,
      variant: 'deterministic',
      toolName: 'list_drives',
      toolDetail: '',
      assistantMarkdown: formatAssistantFromToolOutput(body, r.success),
      success: r.success,
      newLastBrowsedPath: lastBrowsedPath,
    };
  }

  // 上一级 / 返回根视图
  if (/^(返回|上一级|后退)$/i.test(text) || text === '..') {
    if (!lastBrowsedPath) {
      const r = await execTool(toolExecutor, 'list_drives', {});
      const body = r.success ? r.output : (r.error ?? '');
      return {
        handled: true,
        variant: 'deterministic',
        toolName: 'list_drives',
        toolDetail: '',
        assistantMarkdown: formatAssistantFromToolOutput(body, r.success),
        success: r.success,
        newLastBrowsedPath: null,
      };
    }
    const next = winParentOrRoot(lastBrowsedPath);
    if (next === 'list_drives') {
      const r = await execTool(toolExecutor, 'list_drives', {});
      const body = r.success ? r.output : (r.error ?? '');
      return {
        handled: true,
        variant: 'deterministic',
        toolName: 'list_drives',
        toolDetail: '',
        assistantMarkdown: formatAssistantFromToolOutput(body, r.success),
        success: r.success,
        newLastBrowsedPath: null,
      };
    }
    const r = await execTool(toolExecutor, 'browse_directory', { path: next });
    const body = r.success ? r.output : (r.error ?? '');
    return {
      handled: true,
      variant: 'deterministic',
      toolName: 'browse_directory',
      toolDetail: next,
      assistantMarkdown: formatAssistantFromToolOutput(body, r.success),
      success: r.success,
      newLastBrowsedPath: r.success ? inferLastBrowsedDir(next) : lastBrowsedPath,
    };
  }

  const driveIntent = parseDriveLetterIntent(text);
  if (driveIntent) {
    const r = await execTool(toolExecutor, 'browse_directory', { path: driveIntent });
    const body = r.success ? r.output : (r.error ?? '');
    return {
      handled: true,
      variant: 'deterministic',
      toolName: 'browse_directory',
      toolDetail: driveIntent,
      assistantMarkdown: formatAssistantFromToolOutput(body, r.success),
      success: r.success,
      newLastBrowsedPath: r.success ? inferLastBrowsedDir(driveIntent) : lastBrowsedPath,
    };
  }

  // 整条消息基本就是一个路径（常见于粘贴）
  if (paths.length >= 1 && text.length <= 400 && !/[\r\n]/.test(text)) {
    const target = longestPath(paths);
    const r = await execTool(toolExecutor, 'browse_directory', { path: target });
    const body = r.success ? r.output : (r.error ?? '');
    return {
      handled: true,
      variant: 'deterministic',
      toolName: 'browse_directory',
      toolDetail: target,
      assistantMarkdown: formatAssistantFromToolOutput(body, r.success),
      success: r.success,
      newLastBrowsedPath: r.success ? inferLastBrowsedDir(target) : lastBrowsedPath,
    };
  }

  return { handled: false };
}

function formatAssistantFromToolOutput(toolBody: string, success: boolean): string {
  const tag = success ? 'complete' : 'error';
  return `${toolBody.trim()}\n\n<status>${tag}</status>`;
}
