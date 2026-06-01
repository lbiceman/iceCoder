import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRuntimeDataDir } from '../../cli/paths.js';

import type {
  EventTimelineConfig,
  ExecutionModeConfig,
  ResolvedSupervisorConfig,
  SupervisorConfigFile,
} from '../../types/supervisor.js';
import {
  readSupervisorModeFromMainConfig,
  resolveMainConfigPath,
} from '../../config/main-config-supervisor-mode.js';
import { resolveGlobalPolicy } from './mode-controller.js';
import {
  createSupervisorRuntimeBridge,
  type SupervisorRuntimeBridge,
  type SupervisorRuntimeBridgeOptions,
} from './supervisor-bridge.js';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface LoadSupervisorConfigOptions {
  /** Explicit config path. If omitted, ICE_SUPERVISOR_CONFIG_PATH then ICE_DATA_DIR/supervisor-config.json are used. */
  configPath?: string;
  /** Main LLM config path (data/config.json); `supervisorMode` field overrides supervisor-config `mode`. */
  mainConfigPath?: string;
  /** Env source for Global-only keys (ICE_SUPERVISOR_SHADOW); tests can pass an isolated object. */
  env?: NodeJS.ProcessEnv;
  /** Data directory fallback when ICE_DATA_DIR is not set. */
  dataDir?: string;
}

const DEFAULT_EVENT_TIMELINE: EventTimelineConfig = {
  enabled: true,
  persistPath: 'data/runtime/supervisor-events.jsonl',
};

const DEFAULT_EXECUTION_MODE: ExecutionModeConfig = {
  pendingStepsEnterThreshold: 2,
  writeTargetsEnterThreshold: 1,
  diffLinesEnterThreshold: 200,
  stableRoundsExitThreshold: 2,
  modeLockRounds: 2,
  forcedMinDwellRounds: 1,
  readonlyToolNames: ['read_file', 'grep', 'search', 'list_dir'],
};

/** Built-in §15/§17 defaults; not wired into the Harness loop until later batches. */
export function defaultSupervisorConfig(): SupervisorConfigFile {
  return {
    mode: 'adaptive',
    shadow: false,
    params: {
      strict: {
        firstRoundGraph: true,
        riskThreshold: 0.5,
        maxRecoveryRounds: 5,
        recoveryTokenRatio: 0.3,
        maxRecoveryRetries: 2,
        stabilityWindowRounds: 2,
        handoffCooldownRounds: 2,
      },
      adaptiveFree: {
        firstRoundGraph: false,
        riskThreshold: 0.6,
      },
      adaptiveTakeover: {
        firstRoundGraph: false,
        riskThreshold: 0.6,
        maxRecoveryRounds: 3,
        recoveryTokenRatio: 0.25,
        maxRecoveryRetries: 2,
        stabilityWindowRounds: 3,
        handoffCooldownRounds: 3,
      },
    },
    triggers: {
      toolRepeatFailMin: 2,
      noProgressRoundsMin: 3,
      fileLoopMin: 4,
      goalDriftEnabled: true,
      scopeCreepEnabled: true,
      userForceTakeoverEnabled: true,
    },
    goalDrift: {
      alignmentThreshold: 0.45,
      consecutiveRoundsBelow: 2,
    },
    snapshotConfidence: {
      templateGraphMin: 0.65,
    },
    correctionBudget: {
      freeSegmentMaxPerTask: 1,
    },
    eventTimeline: { ...DEFAULT_EVENT_TIMELINE },
    executionMode: { ...DEFAULT_EXECUTION_MODE },
  };
}

export function resolveSupervisorConfig(
  config: DeepPartial<SupervisorConfigFile> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSupervisorConfig {
  const merged = mergeConfig(defaultSupervisorConfig(), config);
  const resolved: ResolvedSupervisorConfig = {
    ...merged,
    eventTimeline: {
      ...DEFAULT_EVENT_TIMELINE,
      ...(merged.eventTimeline ?? {}),
    },
    executionMode: {
      ...DEFAULT_EXECUTION_MODE,
      ...(merged.executionMode ?? {}),
    },
    globalPolicy: resolveGlobalPolicy(merged, env),
  };
  return resolved;
}

/** Loads supervisor-config.json without applying any per-round behavior. */
export async function loadSupervisorConfig(
  options: LoadSupervisorConfigOptions = {},
): Promise<ResolvedSupervisorConfig> {
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(options, env);
  const loaded = await readConfigFile(configPath);
  const mainConfigPath = options.mainConfigPath ?? resolveMainConfigPath(env);
  const modeFromMain = await readSupervisorModeFromMainConfig(mainConfigPath);
  const merged = modeFromMain != null ? { ...loaded, mode: modeFromMain } : loaded;
  return resolveSupervisorConfig(merged, env);
}

/**
 * F2 — Harness 入口（cli/web/remote）统一调用的 supervisor runtime 加载器。
 *
 * 行为：
 *   - 优先按 ICE_SUPERVISOR_CONFIG_PATH / dataDir/supervisor-config.json 加载磁盘配置；
 *   - 加载失败或文件缺失时回落到 defaultSupervisorConfig()（mode=adaptive）；
 *   - `data/config.json` 的 `supervisorMode` 覆盖 supervisor-config.json 的 `mode`；
 *   - env 仅 `ICE_SUPERVISOR_SHADOW` 可覆盖 shadow；
 *   - 任意异常（解析错误、IO 失败）均**降级为 off**，绝不阻断 Harness 启动，
 *     以保证 dual-mode 接入不会让现有产品入口"启动失败"。
 *
 * 返回 { supervisorConfig, globalPolicy, bridge }；调用方将 config/policy 塞进 HarnessConfig，
 * bridge 在 L2-6 接入四钩子前可先忽略。
 */
export async function loadHarnessSupervisorRuntime(
  options: LoadSupervisorConfigOptions & SupervisorRuntimeBridgeOptions = {},
): Promise<{
  supervisorConfig: ResolvedSupervisorConfig;
  globalPolicy: ResolvedSupervisorConfig['globalPolicy'];
  bridge: SupervisorRuntimeBridge;
}> {
  try {
    const supervisorConfig = await loadSupervisorConfig(options);
    const bridge = createSupervisorRuntimeBridge(supervisorConfig, options);
    return { supervisorConfig, globalPolicy: supervisorConfig.globalPolicy, bridge };
  } catch (err) {
    console.debug(
      '[supervisor-config] load failed, fallback to off:',
      err instanceof Error ? err.message : err,
    );
    const supervisorConfig = resolveSupervisorConfig({ mode: 'off' }, options.env);
    const bridge = createSupervisorRuntimeBridge(supervisorConfig, options);
    return { supervisorConfig, globalPolicy: supervisorConfig.globalPolicy, bridge };
  }
}

function resolveConfigPath(
  options: LoadSupervisorConfigOptions,
  env: NodeJS.ProcessEnv,
): string {
  const explicitPath = options.configPath ?? env.ICE_SUPERVISOR_CONFIG_PATH;
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const dataDir = options.dataDir ?? env.ICE_DATA_DIR ?? getRuntimeDataDir();
  return path.join(dataDir, 'supervisor-config.json');
}

async function readConfigFile(configPath: string): Promise<DeepPartial<SupervisorConfigFile>> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(raw) as DeepPartial<SupervisorConfigFile>;
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}

function mergeConfig(
  base: SupervisorConfigFile,
  override: DeepPartial<SupervisorConfigFile>,
): SupervisorConfigFile {
  return {
    ...base,
    ...override,
    params: {
      strict: {
        ...base.params.strict,
        ...(override.params?.strict ?? {}),
      },
      adaptiveFree: {
        ...base.params.adaptiveFree,
        ...(override.params?.adaptiveFree ?? {}),
      },
      adaptiveTakeover: {
        ...base.params.adaptiveTakeover,
        ...(override.params?.adaptiveTakeover ?? {}),
      },
    },
    triggers: {
      ...base.triggers,
      ...(override.triggers ?? {}),
    },
    goalDrift: {
      ...base.goalDrift,
      ...(override.goalDrift ?? {}),
    },
    snapshotConfidence: {
      ...base.snapshotConfidence,
      ...(override.snapshotConfidence ?? {}),
    },
    correctionBudget: {
      ...base.correctionBudget,
      ...(override.correctionBudget ?? {}),
    },
    eventTimeline: {
      ...(base.eventTimeline ?? DEFAULT_EVENT_TIMELINE),
      ...(override.eventTimeline ?? {}),
    },
    executionMode: {
      ...(base.executionMode ?? DEFAULT_EXECUTION_MODE),
      ...(override.executionMode ?? {}),
    },
  };
}
