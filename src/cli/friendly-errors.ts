/**
 * 用户友好的错误提示。
 *
 * 将常见的 LLM API 错误、网络错误、配置错误翻译为
 * 人类可读的中文提示 + 修复建议。
 */

interface FriendlyError {
  /** 用户看到的错误标题 */
  title: string;
  /** 修复建议 */
  suggestion: string;
}

/**
 * 错误匹配规则（按优先级排序）。
 */
const ERROR_RULES: Array<{
  test: (msg: string, status?: number) => boolean;
  result: FriendlyError;
}> = [
  // ─── API Key 相关 ───
  {
    test: (msg, status) => status === 401 || /unauthorized|invalid.*api.*key|invalid.*key|authentication/i.test(msg),
    result: {
      title: 'API Key 无效或已过期',
      suggestion: '请检查 data/config.json 中的 apiKey 是否正确。如果使用第三方中转，确认 apiUrl 也正确。',
    },
  },
  {
    test: (msg, status) => status === 403 || /forbidden|access denied|permission/i.test(msg),
    result: {
      title: 'API 访问被拒绝',
      suggestion: '你的 API Key 可能没有访问该模型的权限，或账户已被禁用。请检查提供商控制台。',
    },
  },
  {
    test: (msg) => /insufficient.*quota|billing|payment|exceeded.*limit|credit/i.test(msg),
    result: {
      title: 'API 额度不足',
      suggestion: '你的 API 账户余额不足或已达到用量上限。请到提供商控制台充值或提升额度。',
    },
  },

  // ─── 速率限制 ───
  {
    test: (msg, status) => status === 429 || /rate.?limit|too many requests/i.test(msg),
    result: {
      title: 'API 请求过于频繁',
      suggestion: '已触发速率限制，系统会自动重试。如果持续出现，请稍等几分钟再试，或升级 API 套餐。',
    },
  },

  // ─── 模型相关 ───
  {
    test: (msg) => /model.*not.*found|does not exist|invalid.*model|model_not_found/i.test(msg),
    result: {
      title: '模型不存在',
      suggestion: '请检查 data/config.json 中的 modelName 是否拼写正确。常见模型：gpt-4o、claude-sonnet-4-20250514、deepseek-chat。',
    },
  },
  {
    test: (msg) => /context.*length|token.*limit|maximum.*context|too long/i.test(msg),
    result: {
      title: '上下文长度超限',
      suggestion: '对话内容超过了模型的最大上下文窗口。请使用 ~clear 清空对话，或等待自动压缩生效。',
    },
  },

  // ─── 网络相关 ───
  {
    test: (msg) => /ECONNREFUSED/i.test(msg),
    result: {
      title: '无法连接到 API 服务器',
      suggestion: '请检查：1) 网络是否正常 2) data/config.json 中的 apiUrl 是否正确 3) 如果使用代理，确认代理服务正在运行。',
    },
  },
  {
    test: (msg) => /ENOTFOUND|DNS/i.test(msg),
    result: {
      title: 'API 域名解析失败',
      suggestion: '无法解析 API 服务器域名。请检查网络连接和 DNS 设置，或确认 apiUrl 是否拼写正确。',
    },
  },
  {
    test: (msg) => /ETIMEDOUT|timeout|timed?\s*out/i.test(msg),
    result: {
      title: 'API 请求超时',
      suggestion: '请求超时，可能是网络不稳定或 API 服务器负载过高。系统会自动重试，如果持续超时请稍后再试。',
    },
  },
  {
    test: (msg) => /ECONNRESET|socket hang up|connection reset/i.test(msg),
    result: {
      title: '网络连接中断',
      suggestion: '与 API 服务器的连接被重置。通常是网络波动导致，系统会自动重试。',
    },
  },
  {
    test: (msg) => /fetch failed|network error|EPIPE/i.test(msg),
    result: {
      title: '网络请求失败',
      suggestion: '请检查网络连接是否正常。如果使用 VPN/代理，尝试切换节点。',
    },
  },

  // ─── 服务器错误 ───
  {
    test: (msg, status) => status === 500 || /internal server error/i.test(msg),
    result: {
      title: 'API 服务器内部错误',
      suggestion: 'API 提供商服务器出错，通常是临时问题。系统会自动重试，如果持续出现请稍后再试。',
    },
  },
  {
    test: (msg, status) => (status !== undefined && status >= 502 && status <= 504) || /bad gateway|service unavailable|gateway timeout/i.test(msg),
    result: {
      title: 'API 服务暂时不可用',
      suggestion: 'API 提供商服务暂时不可用（可能在维护或过载）。系统会自动重试。',
    },
  },

  // ─── 配置相关 ───
  {
    test: (msg) => /no provider|not registered|no default/i.test(msg),
    result: {
      title: '未配置 LLM 提供者',
      suggestion: '请编辑 data/config.json，至少配置一个 LLM 提供者（apiKey + modelName）。运行 iceCoder config 查看当前配置。',
    },
  },
  {
    test: (msg) => /ENOENT.*config|config.*not found/i.test(msg),
    result: {
      title: '配置文件不存在',
      suggestion: '找不到 data/config.json。首次运行会自动创建，如果被误删请重新运行 iceCoder start。',
    },
  },
  {
    test: (msg) => /JSON.*parse|Unexpected token|SyntaxError/i.test(msg),
    result: {
      title: '配置文件格式错误',
      suggestion: 'data/config.json 不是有效的 JSON。请检查是否有多余的逗号、缺少引号等语法错误。',
    },
  },
];

/**
 * 将错误转换为用户友好的提示。
 * 如果无法匹配已知模式，返回 null。
 */
export function getFriendlyError(error: unknown): FriendlyError | null {
  if (!(error instanceof Error)) return null;

  const msg = error.message;
  const status = (error as any).status || (error as any).statusCode;

  for (const rule of ERROR_RULES) {
    if (rule.test(msg, status)) {
      return rule.result;
    }
  }

  return null;
}

/**
 * 格式化错误为用户友好的字符串。
 * 如果是已知错误，返回标题 + 建议；否则返回原始错误消息。
 */
export function formatFriendlyError(error: unknown): string {
  const friendly = getFriendlyError(error);
  if (friendly) {
    return `❌ ${friendly.title}\n💡 ${friendly.suggestion}`;
  }

  // 未知错误：返回原始消息
  const msg = error instanceof Error ? error.message : String(error);
  return `❌ ${msg}`;
}
