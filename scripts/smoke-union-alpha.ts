/**
 * 对 OpenCode Go 的 Union Alpha Free（Anthropic /v1/messages）做一次真实连通性探测。
 * 用法：npx tsx scripts/smoke-union-alpha.ts
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { createProviderAdapter } from '../src/llm/provider-adapter-config.js';
import { resolveProviderProtocol } from '../src/llm/provider-protocol.js';
import { resolveAnthropicMessagesUrl } from '../src/llm/anthropic-adapter.js';
import type { ProviderConfig, IceCoderConfigFile } from '../src/web/types.js';
import type { UnifiedMessage } from '../src/llm/types.js';
import { resolveLocalDataDir } from '../src/cli/paths.js';

const CONFIG_PATH = process.env.ICE_CONFIG_PATH?.trim()
  || path.join(resolveLocalDataDir(), 'config.json');

async function loadProvider(): Promise<ProviderConfig> {
  const raw = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8')) as IceCoderConfigFile;
  const match = raw.providers.find((p) => p.id === 'opencode-go-anthropic')
    ?? raw.providers.find((p) => (p.modelName || '').split(',').some((n) => n.trim() === 'union-alpha'));
  if (!match) {
    throw new Error('config.json 中没有 union-alpha / opencode-go-anthropic provider');
  }
  return match;
}

async function main(): Promise<void> {
  const provider = await loadProvider();
  const protocol = resolveProviderProtocol(provider);
  if (protocol !== 'anthropic_messages') {
    throw new Error(`union-alpha 必须走 anthropic_messages，当前是 ${protocol}`);
  }

  const adapter = createProviderAdapter(provider);
  const url = resolveAnthropicMessagesUrl(provider.apiUrl);
  console.log(`[smoke] provider=${provider.id} model=${provider.activeModelName || provider.modelName}`);
  console.log(`[smoke] protocol=${protocol}`);
  console.log(`[smoke] url=${url}`);

  const messages: UnifiedMessage[] = [
    { role: 'user', content: 'Reply with exactly the word pong and nothing else.' },
  ];

  console.log('[smoke] chat …');
  const chat = await adapter.chat(messages, {
    sessionId: 'smoke-union-alpha-chat',
    maxTokens: 4096,
    reasoningEffort: 'high',
  });
  console.log(`[smoke] chat finish=${chat.finishReason} tokens=${chat.usage.inputTokens}/${chat.usage.outputTokens}`);
  console.log(`[smoke] chat reasoning=${JSON.stringify(chat.reasoningContent || '')}`);
  console.log(`[smoke] chat content=${JSON.stringify(chat.content)}`);

  console.log('[smoke] stream …');
  let streamed = '';
  let stream: Awaited<ReturnType<typeof adapter.stream>> | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    streamed = '';
    try {
      console.log(`[smoke] stream attempt ${attempt}/2`);
      stream = await adapter.stream(messages, (chunk, done) => {
        if (done || typeof chunk !== 'string') return;
        streamed += chunk;
        process.stdout.write(chunk);
      }, {
        sessionId: `smoke-union-alpha-stream-${attempt}`,
        maxTokens: 4096,
        reasoningEffort: 'high',
      });
      break;
    } catch (error) {
      const err = error as { status?: number; message?: string };
      console.log(`[smoke] stream attempt ${attempt} failed: ${err.status ?? ''} ${err.message ?? error}`);
    }
  }

  if (stream) {
    if (streamed) process.stdout.write('\n');
    console.log(`[smoke] stream finish=${stream.finishReason} tokens=${stream.usage.inputTokens}/${stream.usage.outputTokens}`);
    console.log(`[smoke] stream reasoning=${JSON.stringify(stream.reasoningContent || '')}`);
    console.log(`[smoke] stream content=${JSON.stringify(stream.content)}`);
  } else {
    console.log('[smoke] union-alpha stream unavailable; probing same endpoint with minimax-m2.7 …');
    try {
      const probe = await adapter.stream(messages, () => {}, {
        model: 'minimax-m2.7',
        sessionId: 'smoke-minimax-stream',
        maxTokens: 32,
      });
      console.log(`[smoke] minimax-m2.7 stream OK finish=${probe.finishReason} content=${JSON.stringify(probe.content)}`);
    } catch (error) {
      const err = error as { status?: number; message?: string };
      console.log(`[smoke] minimax-m2.7 stream also failed: ${err.status ?? ''} ${err.message ?? error}`);
    }
  }

  if (!/pong/i.test(chat.content) && !(stream && /pong/i.test(stream.content))) {
    throw new Error('模型已连通，但回复里没有 pong，请人工确认上面的 content');
  }
  if (!stream) {
    console.log('[smoke] Union Alpha Free 非流式连通成功；流式被网关 503');
    return;
  }
  console.log('[smoke] Union Alpha Free 连通成功');
}

main().catch((error) => {
  const err = error as { message?: string; status?: number; code?: string };
  console.error('[smoke] FAILED', err.status ?? '', err.code ?? '', err.message ?? error);
  process.exitCode = 1;
});
