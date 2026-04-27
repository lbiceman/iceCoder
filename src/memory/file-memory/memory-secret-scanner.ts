/**
 * 记忆内容秘密扫描器。
 *
 * 在记忆写入磁盘前扫描内容中的敏感信息（API Key、Token、私钥等），
 * 防止 LLM 提取器将用户对话中的密钥持久化到记忆文件。
 *
 * 规则来源：gitleaks (https://github.com/gitleaks/gitleaks, MIT license)
 * 只选用有明确前缀的高置信度规则，避免误报。
 *
 * 提供两种处理方式：
 * - scanForSecrets(): 检测是否包含秘密，返回匹配的规则列表
 * - redactSecrets(): 将匹配的秘密替换为 [REDACTED]
 */

// ─── 类型 ───

interface SecretRule {
  /** 规则 ID（kebab-case），用于日志和分析 */
  id: string;
  /** 正则表达式源码 */
  source: string;
  /** 可选的正则标志 */
  flags?: string;
}

export interface SecretMatch {
  /** 匹配的规则 ID */
  ruleId: string;
  /** 人类可读的标签 */
  label: string;
}

// ─── 规则定义 ───
// 按使用频率排序，只选有明确前缀的高置信度规则。

// Anthropic API key 前缀，拆开拼接避免源码扫描工具误报
const ANT_KEY_PFX = ['sk', 'ant', 'api'].join('-');

const SECRET_RULES: SecretRule[] = [
  // — 云服务商 —
  {
    id: 'aws-access-token',
    source: '\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b',
  },
  {
    id: 'gcp-api-key',
    source: '\\b(AIza[\\w-]{35})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'digitalocean-pat',
    source: '\\b(dop_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'digitalocean-access-token',
    source: '\\b(doo_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — AI API —
  {
    id: 'anthropic-api-key',
    source: `\\b(${ANT_KEY_PFX}03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,
  },
  {
    id: 'anthropic-admin-api-key',
    source:
      '\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'openai-api-key',
    source:
      '\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'huggingface-access-token',
    source: '\\b(hf_[a-zA-Z]{34})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — 版本控制 —
  {
    id: 'github-pat',
    source: 'ghp_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-fine-grained-pat',
    source: 'github_pat_\\w{82}',
  },
  {
    id: 'github-app-token',
    source: '(?:ghu|ghs)_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-oauth',
    source: 'gho_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-refresh-token',
    source: 'ghr_[0-9a-zA-Z]{36}',
  },
  {
    id: 'gitlab-pat',
    source: 'glpat-[\\w-]{20}',
  },

  // — 通信 —
  {
    id: 'slack-bot-token',
    source: 'xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*',
  },
  {
    id: 'slack-user-token',
    source: 'xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}',
  },
  {
    id: 'slack-app-token',
    source: 'xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+',
    flags: 'i',
  },
  {
    id: 'sendgrid-api-token',
    source: '\\b(SG\\.[a-zA-Z0-9=_\\-.]{66})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — 开发工具 —
  {
    id: 'npm-access-token',
    source: '\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'pypi-upload-token',
    source: 'pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}',
  },

  // — 可观测性 —
  {
    id: 'grafana-api-key',
    source:
      '\\b(eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'grafana-cloud-api-token',
    source: '\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'sentry-user-token',
    source: '\\b(sntryu_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — 支付 —
  {
    id: 'stripe-access-token',
    source:
      '\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'shopify-access-token',
    source: 'shpat_[a-fA-F0-9]{32}',
  },

  // — 私钥 —
  {
    id: 'private-key',
    source:
      '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----',
    flags: 'i',
  },
];

// ─── 编译缓存 ───

let compiledRules: Array<{ id: string; re: RegExp }> | null = null;

function getCompiledRules(): Array<{ id: string; re: RegExp }> {
  if (compiledRules === null) {
    compiledRules = SECRET_RULES.map(r => ({
      id: r.id,
      re: new RegExp(r.source, r.flags),
    }));
  }
  return compiledRules;
}

let redactRegexes: RegExp[] | null = null;

function getRedactRegexes(): RegExp[] {
  if (redactRegexes === null) {
    redactRegexes = SECRET_RULES.map(
      r => new RegExp(r.source, (r.flags ?? '').replace('g', '') + 'g'),
    );
  }
  return redactRegexes;
}

// ─── 工具函数 ───

/**
 * 将 kebab-case 规则 ID 转为人类可读标签。
 * 例如 "github-pat" → "GitHub PAT"
 */
function ruleIdToLabel(ruleId: string): string {
  const specialCase: Record<string, string> = {
    aws: 'AWS',
    gcp: 'GCP',
    api: 'API',
    pat: 'PAT',
    oauth: 'OAuth',
    npm: 'NPM',
    pypi: 'PyPI',
    github: 'GitHub',
    gitlab: 'GitLab',
    openai: 'OpenAI',
    digitalocean: 'DigitalOcean',
    huggingface: 'HuggingFace',
    sendgrid: 'SendGrid',
    anthropic: 'Anthropic',
    admin: 'Admin',
  };

  return ruleId
    .split('-')
    .map(part => specialCase[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ─── 公开 API ───

/**
 * 扫描内容中的潜在秘密。
 *
 * 返回每条命中规则的匹配信息（按规则 ID 去重）。
 * 故意不返回匹配到的实际文本——永远不记录或显示秘密值。
 */
export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const rule of getCompiledRules()) {
    if (seen.has(rule.id)) continue;
    if (rule.re.test(content)) {
      seen.add(rule.id);
      matches.push({
        ruleId: rule.id,
        label: ruleIdToLabel(rule.id),
      });
    }
  }

  return matches;
}

/**
 * 将内容中匹配到的秘密替换为 [REDACTED]。
 *
 * 只替换捕获组部分（如果有），保留边界字符（空格、引号等）。
 * 如果没有捕获组，替换整个匹配。
 */
export function redactSecrets(content: string): string {
  let result = content;

  for (const re of getRedactRegexes()) {
    result = result.replace(re, (match, g1) =>
      typeof g1 === 'string' ? match.replace(g1, '[REDACTED]') : '[REDACTED]',
    );
  }

  return result;
}

/**
 * 检查内容是否包含秘密（快速布尔检查）。
 */
export function containsSecrets(content: string): boolean {
  return getCompiledRules().some(rule => rule.re.test(content));
}

/**
 * 获取规则 ID 的人类可读标签。
 */
export function getSecretLabel(ruleId: string): string {
  return ruleIdToLabel(ruleId);
}
