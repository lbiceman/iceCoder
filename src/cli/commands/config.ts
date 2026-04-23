/**
 * ice config — 查看和管理配置。
 */

import { promises as fs } from 'node:fs';
import type { ParsedArgs } from '../utils/args-parser.js';
import { c, table, info, success, error } from '../utils/terminal-ui.js';
import { CONFIG_PATH, loadConfig } from '../bootstrap.js';

export async function runConfig(_args: ParsedArgs): Promise<void> {
  const subCmd = _args.positional[0];

  if (subCmd === 'set') {
    await handleSet(_args);
    return;
  }

  // 默认：显示当前配置
  await showConfig();
}

async function showConfig(): Promise<void> {
  try {
    const providers = await loadConfig();

    console.log(`\n${c.bold}LLM 提供者配置${c.reset}\n`);

    const rows = providers.map((p) => [
      p.isDefault ? `${c.green}★${c.reset} ${p.id}` : `  ${p.id}`,
      p.providerName,
      p.modelName,
      p.apiUrl.substring(0, 40),
    ]);

    table(['ID', '类型', '模型', 'API URL'], rows);
    console.log(`\n${c.dim}配置文件: ${CONFIG_PATH}${c.reset}`);
    console.log(`${c.dim}使用 "ice config set default <id>" 切换默认提供者${c.reset}\n`);
  } catch (err) {
    error('读取配置失败: ' + (err instanceof Error ? err.message : String(err)));
  }
}

async function handleSet(args: ParsedArgs): Promise<void> {
  const key = args.positional[1];
  const value = args.positional[2];

  if (key === 'default' && value) {
    try {
      const data = await fs.readFile(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(data) as { providers: Array<{ id: string; isDefault?: boolean }> };

      const target = config.providers.find((p) => p.id === value);
      if (!target) {
        error(`未找到提供者: ${value}`);
        info('可用的提供者 ID:');
        for (const p of config.providers) {
          console.log(`  ${p.id}`);
        }
        return;
      }

      // 更新默认标记
      for (const p of config.providers) {
        p.isDefault = p.id === value;
      }

      await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
      success(`默认提供者已切换为: ${value}`);
    } catch (err) {
      error('更新配置失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  } else {
    error('用法: ice config set default <provider-id>');
  }
}
