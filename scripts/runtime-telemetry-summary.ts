import path from 'node:path';

import { getRuntimeDataDir } from '../src/cli/paths.js';
import {
  formatRuntimeTelemetryMarkdown,
  summarizeRuntimeTelemetry,
} from '../src/harness/runtime-telemetry-summary.js';

interface CliArgs {
  file: string;
  days: number;
  format: 'json' | 'markdown';
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  const summary = await summarizeRuntimeTelemetry(args.file, { days: args.days });
  if (args.format === 'json') {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatRuntimeTelemetryMarkdown(summary));
  }
}

function parseArgs(): CliArgs {
  const format = getArg('--format') ?? 'markdown';
  if (format !== 'json' && format !== 'markdown') {
    throw new Error(`Invalid --format: ${format}. Expected "json" or "markdown".`);
  }

  const daysRaw = getArg('--days') ?? '30';
  const days = Number.parseInt(daysRaw, 10);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    throw new Error(`Invalid --days: ${daysRaw}. Expected 1..365.`);
  }

  return {
    file: path.resolve(getArg('--file') ?? process.env.ICE_RUNTIME_TELEMETRY ?? path.join(getRuntimeDataDir(), 'runtime', 'telemetry.jsonl')),
    days,
    format,
    help: process.argv.includes('--help') || process.argv.includes('-h'),
  };
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function printHelp(): void {
  console.log(`Usage: npm run telemetry:runtime -- [options]

Options:
  --file <path>              telemetry JSONL path (default: data/runtime/telemetry.jsonl)
  --days <n>                 include events from the last n days (default: 30)
  --format json|markdown     output format (default: markdown)
  -h, --help                 show this help
`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
