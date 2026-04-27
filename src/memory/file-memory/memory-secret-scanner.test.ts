/**
 * memory-secret-scanner 单元测试。
 *
 * 覆盖：各类 API Key/Token 检测、脱敏替换、无秘密内容、边界情况。
 */

import { describe, it, expect } from 'vitest';
import {
  scanForSecrets,
  redactSecrets,
  containsSecrets,
  getSecretLabel,
} from './memory-secret-scanner.js';

// ─── scanForSecrets ───

describe('scanForSecrets', () => {
  describe('云服务商', () => {
    it('检测 AWS Access Key', () => {
      const matches = scanForSecrets('my key is AKIAIOSFODNN7EXAMPLE');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('aws-access-token');
    });

    it('检测 GCP API Key', () => {
      const matches = scanForSecrets('key: AIzaSyA1234567890abcdefghijklmnopqrstuv');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('gcp-api-key');
    });
  });

  describe('AI API', () => {
    it('检测 OpenAI API Key（旧格式）', () => {
      // 旧格式：sk- + 20 chars + T3BlbkFJ + 20 chars
      const fakeKey = 'sk-' + 'a'.repeat(20) + 'T3BlbkFJ' + 'b'.repeat(20);
      const matches = scanForSecrets(`key: ${fakeKey}`);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('openai-api-key');
    });

    it('检测 HuggingFace Token', () => {
      const fakeToken = 'hf_' + 'a'.repeat(34);
      const matches = scanForSecrets(`token: ${fakeToken}`);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('huggingface-access-token');
    });
  });

  describe('版本控制', () => {
    it('检测 GitHub PAT', () => {
      const fakePat = 'ghp_' + 'a'.repeat(36);
      const matches = scanForSecrets(`token: ${fakePat}`);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('github-pat');
    });

    it('检测 GitHub Fine-grained PAT', () => {
      const fakePat = 'github_pat_' + 'a'.repeat(82);
      const matches = scanForSecrets(fakePat);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('github-fine-grained-pat');
    });

    it('检测 GitHub App Token (ghu_)', () => {
      const fakeToken = 'ghu_' + 'a'.repeat(36);
      const matches = scanForSecrets(fakeToken);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('github-app-token');
    });

    it('检测 GitLab PAT', () => {
      const fakeToken = 'glpat-' + 'a'.repeat(20);
      const matches = scanForSecrets(fakeToken);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('gitlab-pat');
    });
  });

  describe('通信', () => {
    it('检测 Slack Bot Token', () => {
      const matches = scanForSecrets('xoxb-1234567890-1234567890-abcdefghij');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('slack-bot-token');
    });

    it('检测 SendGrid API Token', () => {
      const fakeToken = 'SG.' + 'a'.repeat(66);
      const matches = scanForSecrets(fakeToken);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('sendgrid-api-token');
    });
  });

  describe('开发工具', () => {
    it('检测 NPM Access Token', () => {
      const fakeToken = 'npm_' + 'a'.repeat(36);
      const matches = scanForSecrets(fakeToken);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('npm-access-token');
    });
  });

  describe('支付', () => {
    it('检测 Stripe Live Key', () => {
      const fakeKey = 'sk_live_' + 'a'.repeat(24);
      const matches = scanForSecrets(fakeKey);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('stripe-access-token');
    });

    it('检测 Stripe Test Key', () => {
      const fakeKey = 'sk_test_' + 'a'.repeat(24);
      const matches = scanForSecrets(fakeKey);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('stripe-access-token');
    });

    it('检测 Shopify Access Token', () => {
      const fakeToken = 'shpat_' + 'a'.repeat(32);
      const matches = scanForSecrets(fakeToken);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('shopify-access-token');
    });
  });

  describe('私钥', () => {
    it('检测 RSA 私钥', () => {
      const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB
aNPLkMXMPIGKBMt0ePBcmKbKMZoBMwkEMhMNY8TQHIV3GkDqsON25Jnk3STBBBz
${'A'.repeat(100)}
-----END RSA PRIVATE KEY-----`;
      const matches = scanForSecrets(privateKey);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('private-key');
    });

    it('检测 EC 私钥', () => {
      const privateKey = `-----BEGIN EC PRIVATE KEY-----
${'B'.repeat(100)}
-----END EC PRIVATE KEY-----`;
      const matches = scanForSecrets(privateKey);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].ruleId).toBe('private-key');
    });
  });

  describe('无秘密', () => {
    it('普通文本不触发', () => {
      const matches = scanForSecrets('这是一段普通的记忆内容，关于用户偏好 React 框架。');
      expect(matches).toEqual([]);
    });

    it('空字符串不触发', () => {
      expect(scanForSecrets('')).toEqual([]);
    });

    it('代码片段不误报', () => {
      const code = `
function getApiKey() {
  return process.env.API_KEY;
}
const config = { key: "not-a-real-key" };
`;
      const matches = scanForSecrets(code);
      expect(matches).toEqual([]);
    });

    it('短字符串不误报', () => {
      // 确保 "sk_" 这样的短前缀不会误报
      const matches = scanForSecrets('sk_test is a prefix');
      expect(matches).toEqual([]);
    });
  });

  describe('去重', () => {
    it('同一规则多次匹配只返回一条', () => {
      const fakePat1 = 'ghp_' + 'a'.repeat(36);
      const fakePat2 = 'ghp_' + 'b'.repeat(36);
      const matches = scanForSecrets(`${fakePat1} and ${fakePat2}`);

      const githubMatches = matches.filter(m => m.ruleId === 'github-pat');
      expect(githubMatches.length).toBe(1);
    });
  });

  describe('多种秘密', () => {
    it('同时检测多种类型', () => {
      const content = `
AWS Key: AKIAIOSFODNN7EXAMPLE
GitHub: ghp_${'a'.repeat(36)}
`;
      const matches = scanForSecrets(content);
      const ruleIds = matches.map(m => m.ruleId);

      expect(ruleIds).toContain('aws-access-token');
      expect(ruleIds).toContain('github-pat');
    });
  });
});

// ─── redactSecrets ───

describe('redactSecrets', () => {
  it('替换 AWS Key 为 [REDACTED]', () => {
    const content = 'my key is AKIAIOSFODNN7EXAMPLE ok';
    const redacted = redactSecrets(content);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('替换 GitHub PAT 为 [REDACTED]', () => {
    const fakePat = 'ghp_' + 'a'.repeat(36);
    const content = `token: ${fakePat}`;
    const redacted = redactSecrets(content);

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain(fakePat);
  });

  it('替换多个秘密', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const githubPat = 'ghp_' + 'c'.repeat(36);
    const content = `aws: ${awsKey}\ngithub: ${githubPat}`;
    const redacted = redactSecrets(content);

    expect(redacted).not.toContain(awsKey);
    expect(redacted).not.toContain(githubPat);
    // 应该有两处 [REDACTED]
    const count = (redacted.match(/\[REDACTED\]/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('无秘密时原样返回', () => {
    const content = '这是普通内容，没有任何秘密。';
    const redacted = redactSecrets(content);
    expect(redacted).toBe(content);
  });

  it('保留秘密周围的文本', () => {
    const content = 'before AKIAIOSFODNN7EXAMPLE after';
    const redacted = redactSecrets(content);

    expect(redacted).toContain('before');
    expect(redacted).toContain('after');
  });
});

// ─── containsSecrets ───

describe('containsSecrets', () => {
  it('有秘密返回 true', () => {
    expect(containsSecrets('key: AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('无秘密返回 false', () => {
    expect(containsSecrets('普通文本')).toBe(false);
  });

  it('空字符串返回 false', () => {
    expect(containsSecrets('')).toBe(false);
  });
});

// ─── getSecretLabel ───

describe('getSecretLabel', () => {
  it('转换 github-pat 为 GitHub PAT', () => {
    expect(getSecretLabel('github-pat')).toBe('GitHub PAT');
  });

  it('转换 aws-access-token 为 AWS Access Token', () => {
    expect(getSecretLabel('aws-access-token')).toBe('AWS Access Token');
  });

  it('转换 openai-api-key 为 OpenAI API Key', () => {
    expect(getSecretLabel('openai-api-key')).toBe('OpenAI API Key');
  });

  it('未知 ID 使用首字母大写', () => {
    expect(getSecretLabel('some-unknown-rule')).toBe('Some Unknown Rule');
  });
});
