/**
 * 轻量命令行参数解析器。
 * 不依赖外部库，支持子命令、--flag、--key=value、--key value 格式。
 */

export interface ParsedArgs {
  /** 子命令（第一个非 flag 参数） */
  command: string;
  /** 位置参数（子命令之后的非 flag 参数） */
  positional: string[];
  /** 命名参数（--key value 或 --key=value） */
  flags: Record<string, string | boolean>;
}

/**
 * 解析 process.argv（跳过前两个：node 和脚本路径）。
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const result: ParsedArgs = {
    command: '',
    positional: [],
    flags: {},
  };

  let i = 0;

  // 第一个非 flag 参数作为子命令
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    result.command = argv[0];
    i = 1;
  }

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      // -- 之后的全部作为位置参数
      result.positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value
        const key = arg.substring(2, eqIdx);
        result.flags[key] = arg.substring(eqIdx + 1);
      } else {
        const key = arg.substring(2);
        // 检查下一个参数是否是值（不以 - 开头）
        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          result.flags[key] = argv[i + 1];
          i++;
        } else {
          result.flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // 短参数 -p 3000
      const key = arg.substring(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        result.flags[key] = argv[i + 1];
        i++;
      } else {
        result.flags[key] = true;
      }
    } else {
      result.positional.push(arg);
    }

    i++;
  }

  return result;
}

/**
 * 获取 flag 值，支持别名。
 */
export function getFlag(flags: Record<string, string | boolean>, ...names: string[]): string | boolean | undefined {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name];
  }
  return undefined;
}

/**
 * 获取字符串 flag 值。
 */
export function getFlagStr(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  const val = getFlag(flags, ...names);
  return typeof val === 'string' ? val : undefined;
}

/**
 * 获取数字 flag 值。
 */
export function getFlagNum(flags: Record<string, string | boolean>, ...names: string[]): number | undefined {
  const val = getFlagStr(flags, ...names);
  return val !== undefined ? parseInt(val, 10) : undefined;
}

/**
 * 检查 flag 是否存在。
 */
export function hasFlag(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return getFlag(flags, ...names) !== undefined;
}
