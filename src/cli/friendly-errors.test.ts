/**
 * friendly-errors 单元测试。
 * 覆盖：API Key 错误、网络错误、速率限制、模型错误、配置错误、未知错误。
 */

import { describe, it, expect } from 'vitest';
import { getFriendlyError, formatFriendlyError } from './friendly-errors.js';

function makeError(message: string, status?: number): Error {
  const err = new Error(message);
  if (status !== undefined) (err as any).status = status;
  return err;
}

describe('getFriendlyError', () => {
  describe('API Key 错误', () => {
    it('401 状态码', () => {
      const result = getFriendlyError(makeError('Unauthorized', 401));
      expect(result?.title).toContain('API Key');
    });

    it('invalid api key 消息', () => {
      const result = getFriendlyError(makeError('Invalid API key provided'));
      expect(result?.title).toContain('API Key');
    });

    it('403 状态码', () => {
      const result = getFriendlyError(makeError('Forbidden', 403));
      expect(result?.title).toContain('拒绝');
    });
  });

  describe('额度不足', () => {
    it('insufficient quota', () => {
      const result = getFriendlyError(makeError('You have insufficient quota'));
      expect(result?.title).toContain('额度');
    });

    it('billing', () => {
      const result = getFriendlyError(makeError('Billing hard limit reached'));
      expect(result?.title).toContain('额度');
    });
  });

  describe('速率限制', () => {
    it('429 状态码', () => {
      const result = getFriendlyError(makeError('Too Many Requests', 429));
      expect(result?.title).toContain('频繁');
    });

    it('rate limit 消息', () => {
      const result = getFriendlyError(makeError('Rate limit exceeded'));
      expect(result?.title).toContain('频繁');
    });
  });

  describe('模型错误', () => {
    it('model not found', () => {
      const result = getFriendlyError(makeError('The model gpt-5 does not exist'));
      expect(result?.title).toContain('模型');
    });

    it('context length', () => {
      const result = getFriendlyError(makeError("This model's maximum context length is 128000"));
      expect(result?.title).toContain('上下文');
    });
  });

  describe('网络错误', () => {
    it('ECONNREFUSED', () => {
      const err = makeError('connect ECONNREFUSED 127.0.0.1:443');
      (err as any).code = 'ECONNREFUSED';
      const result = getFriendlyError(err);
      expect(result?.title).toContain('连接');
    });

    it('ENOTFOUND', () => {
      const result = getFriendlyError(makeError('getaddrinfo ENOTFOUND api.openai.com'));
      expect(result?.title).toContain('域名');
    });

    it('ETIMEDOUT', () => {
      const result = getFriendlyError(makeError('connect ETIMEDOUT'));
      expect(result?.title).toContain('超时');
    });

    it('socket hang up', () => {
      const result = getFriendlyError(makeError('socket hang up'));
      expect(result?.title).toContain('中断');
    });

    it('fetch failed', () => {
      const result = getFriendlyError(makeError('fetch failed'));
      expect(result?.title).toContain('网络');
    });
  });

  describe('服务器错误', () => {
    it('500 状态码', () => {
      const result = getFriendlyError(makeError('Internal Server Error', 500));
      expect(result?.title).toContain('内部错误');
    });

    it('502 bad gateway', () => {
      const result = getFriendlyError(makeError('Bad Gateway', 502));
      expect(result?.title).toContain('不可用');
    });
  });

  describe('配置错误', () => {
    it('no provider', () => {
      const result = getFriendlyError(makeError('No provider specified and no default provider is set'));
      expect(result?.title).toContain('未配置');
    });

    it('JSON parse error', () => {
      const result = getFriendlyError(makeError('Unexpected token } in JSON'));
      expect(result?.title).toContain('格式错误');
    });
  });

  describe('未知错误', () => {
    it('无法匹配时返回 null', () => {
      const result = getFriendlyError(makeError('Something completely unknown'));
      expect(result).toBeNull();
    });

    it('非 Error 对象返回 null', () => {
      expect(getFriendlyError('string error')).toBeNull();
      expect(getFriendlyError(42)).toBeNull();
      expect(getFriendlyError(null)).toBeNull();
    });
  });
});

describe('formatFriendlyError', () => {
  it('已知错误返回标题 + 建议', () => {
    const result = formatFriendlyError(makeError('Unauthorized', 401));
    expect(result).toContain('❌');
    expect(result).toContain('💡');
    expect(result).toContain('apiKey');
  });

  it('未知错误返回原始消息', () => {
    const result = formatFriendlyError(makeError('weird error'));
    expect(result).toContain('❌');
    expect(result).toContain('weird error');
    expect(result).not.toContain('💡');
  });

  it('非 Error 对象也能处理', () => {
    const result = formatFriendlyError('string error');
    expect(result).toContain('string error');
  });
});
