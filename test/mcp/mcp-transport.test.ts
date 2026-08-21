import { describe, it, expect } from 'vitest';
import {
  isRemoteMcpConfig,
  normalizeMcpHeaders,
  resolveMcpHttpUrl,
  resolveMcpTransportKind,
} from '../../src/mcp/mcp-transport.js';

describe('resolveMcpTransportKind', () => {
  it('stdio：有 command 无 url', () => {
    expect(resolveMcpTransportKind({ command: 'npx', args: ['-y', 'pkg'] })).toBe('stdio');
  });

  it('streamablehttp / streamable-http / http 视为 Streamable HTTP', () => {
    expect(resolveMcpTransportKind({ type: 'streamablehttp', url: 'https://mcp.example.com' })).toBe('streamable-http');
    expect(resolveMcpTransportKind({ type: 'streamable-http', url: 'https://mcp.example.com' })).toBe('streamable-http');
    expect(resolveMcpTransportKind({ type: 'http', url: 'https://mcp.example.com' })).toBe('streamable-http');
  });

  it('仅有 url 时按远程 HTTP', () => {
    expect(resolveMcpTransportKind({ url: 'https://mcp.example.com/mcp' })).toBe('streamable-http');
    expect(isRemoteMcpConfig({ url: 'https://mcp.example.com/mcp' })).toBe(true);
  });

  it('type:sse 识别为旧 SSE', () => {
    expect(resolveMcpTransportKind({ type: 'sse', url: 'https://mcp.example.com/sse' })).toBe('sse');
  });
});

describe('resolveMcpHttpUrl', () => {
  it('拒绝缺少 url', () => {
    expect(() => resolveMcpHttpUrl({ type: 'streamablehttp' })).toThrow(/url/);
  });

  it('拒绝非 http(s)', () => {
    expect(() => resolveMcpHttpUrl({ url: 'ftp://example.com' })).toThrow(/http/);
  });

  it('解析 https url', () => {
    expect(resolveMcpHttpUrl({ url: 'https://mcp.mcd.cn' }).host).toBe('mcp.mcd.cn');
  });
});

describe('normalizeMcpHeaders', () => {
  it('接受字符串头', () => {
    expect(normalizeMcpHeaders({ Authorization: 'Bearer x' })).toEqual({ Authorization: 'Bearer x' });
  });

  it('拒绝非字符串值', () => {
    expect(() => normalizeMcpHeaders({ Authorization: 1 })).toThrow(/字符串/);
  });
});
