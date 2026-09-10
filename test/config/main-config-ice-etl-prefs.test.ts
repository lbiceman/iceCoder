import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ICE_ETL_PREFS,
  readIceEtlPrefsFromMainConfig,
  sanitizeIceEtlPrefs,
  writeIceEtlPrefsToMainConfig,
} from '../../src/config/main-config-ice-etl-prefs.js';

describe('main-config-ice-etl-prefs', () => {
  it('sanitizeIceEtlPrefs 夹紧 panelWidth 并补默认', () => {
    expect(sanitizeIceEtlPrefs({ panelWidth: 9999 })).toEqual({
      ...DEFAULT_ICE_ETL_PREFS,
      panelWidth: 380,
    });
    expect(sanitizeIceEtlPrefs({ panelWidth: 10 }).panelWidth).toBe(280);
    expect(sanitizeIceEtlPrefs({ panelWidth: 280 }).panelWidth).toBe(280);
    expect(sanitizeIceEtlPrefs({ panelWidth: 320 }).panelWidth).toBe(320);
    expect(sanitizeIceEtlPrefs({ panelWidth: 380 }).panelWidth).toBe(380);
    expect(sanitizeIceEtlPrefs(null)).toEqual(DEFAULT_ICE_ETL_PREFS);
  });

  it('writeIceEtlPrefsToMainConfig 写入 config.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ice-etl-prefs-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ providers: [] }, null, 2), 'utf-8');

    const saved = await writeIceEtlPrefsToMainConfig(configPath, {
      showTransparencyPanel: false,
      panelWidth: 380,
    });
    expect(saved).toEqual({
      showTransparencyPanel: false,
      panelDefaultExpanded: true,
      panelWidth: 380,
      taskDoneNotification: false,
      panelAutoCollapse: false,
    });

    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as { iceEtlPrefs: unknown };
    expect(raw.iceEtlPrefs).toEqual(saved);
    expect(await readIceEtlPrefsFromMainConfig(configPath)).toEqual(saved);
  });
});
