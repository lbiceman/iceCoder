/**
 * 用系统自带的 UI Automation 和 Windows.Media.Ocr 查出可点击坐标。
 * 不引入第三方识别库。查询通过参数传入，不拼进脚本。
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScreenHit } from './windows-actions.js';

const SCRIPT_DIR = path.join(os.tmpdir(), 'icecoder-windows');

function powershellExe(): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function writeScript(name: string, source: string): Promise<string> {
  await fs.mkdir(SCRIPT_DIR, { recursive: true });
  const filePath = path.join(SCRIPT_DIR, name);
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')]);
  await fs.writeFile(filePath, body);
  return filePath;
}

function runPowerShell(scriptPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 2_000_000,
        signal,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const text = String(stdout ?? '').trim();
        if (error && !text) {
          const detail = String(stderr ?? '').trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(text);
      },
    );
    child.stdin?.end();
  });
}

function asHits(value: unknown): ScreenHit[] {
  const rows = Array.isArray(value) ? value : [];
  const hits: ScreenHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const x = numberField(item.x);
    const y = numberField(item.y);
    const w = numberField(item.w);
    const h = numberField(item.h);
    const cx = numberField(item.cx);
    const cy = numberField(item.cy);
    if (!text || x === null || y === null || w === null || h === null || cx === null || cy === null) continue;
    if (w < 2 || h < 2) continue;
    hits.push({ text, x, y, w, h, cx, cy });
  }
  return hits;
}

function numberField(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseHits(stdout: string): ScreenHit[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new Error(stdout.slice(0, 500) || 'Locator returned no JSON.');
  }
  return asHits(JSON.parse(stdout.slice(start, end + 1)));
}

const FIND_SCRIPT = `
param([Parameter(Mandatory = $true)][string]$Query)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$q = $Query.Trim()
$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$results = New-Object System.Collections.Generic.List[object]
$seen = 0
function Add-Hit($el) {
  if ($script:results.Count -ge 15) { return }
  try { $name = [string]$el.Current.Name } catch { return }
  if (-not $name) { return }
  if ($name.IndexOf($script:q, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
  try { $rect = $el.Current.BoundingRectangle } catch { return }
  if ([double]::IsInfinity($rect.Width) -or $rect.Width -lt 2 -or $rect.Height -lt 2) { return }
  $null = $script:results.Add([pscustomobject]@{
    text = $name
    x = [int][Math]::Round($rect.X)
    y = [int][Math]::Round($rect.Y)
    w = [int][Math]::Round($rect.Width)
    h = [int][Math]::Round($rect.Height)
    cx = [int][Math]::Round($rect.X + $rect.Width / 2)
    cy = [int][Math]::Round($rect.Y + $rect.Height / 2)
  })
}
function Walk($el, $depth, $limit) {
  if ($script:seen -ge 2500 -or $script:results.Count -ge 15 -or $depth -gt $limit) { return }
  $script:seen++
  Add-Hit $el
  try { $child = $script:walker.GetFirstChild($el) } catch { return }
  while ($child -and $script:results.Count -lt 15 -and $script:seen -lt 2500) {
    Walk $child ($depth + 1) $limit
    try { $child = $script:walker.GetNextSibling($child) } catch { break }
  }
}
$node = $walker.GetFirstChild($root)
while ($node -and $results.Count -lt 15) {
  $className = ''
  $name = ''
  try { $className = [string]$node.Current.ClassName } catch {}
  try { $name = [string]$node.Current.Name } catch {}
  $taskbar = $className -eq 'Shell_TrayWnd' -or $className -eq 'Shell_SecondaryTrayWnd'
  $named = $name.IndexOf($q, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $limit = 2
  if ($taskbar -or $named) { $limit = 6 }
  Walk $node 0 $limit
  try { $node = $walker.GetNextSibling($node) } catch { break }
}
$json = ConvertTo-Json -InputObject @($results.ToArray()) -Compress -Depth 3
if (-not $json) { $json = '[]' }
[Console]::Out.Write($json)
`;

const OCR_SCRIPT = `
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
} | Select-Object -First 1)
function Await-Op($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait()
  if ($task.IsFaulted) { throw $task.Exception.GetBaseException() }
  return $task.Result
}
$file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'zh-Hans'))
}
if (-not $engine) { throw 'Windows OCR has no installed language.' }
$result = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$results = New-Object System.Collections.Generic.List[object]
foreach ($line in $result.Lines) {
  $text = ([string]$line.Text).Trim()
  if (-not $text) { continue }
  $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = [double]::MinValue; $y2 = [double]::MinValue
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    if ($r.X -lt $x1) { $x1 = $r.X }
    if ($r.Y -lt $y1) { $y1 = $r.Y }
    if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
  }
  if ($x1 -eq [double]::MaxValue) { continue }
  $null = $results.Add([pscustomobject]@{
    text = $text
    x = [int][Math]::Round($x1)
    y = [int][Math]::Round($y1)
    w = [int][Math]::Max(2, [Math]::Round($x2 - $x1))
    h = [int][Math]::Max(2, [Math]::Round($y2 - $y1))
    cx = [int][Math]::Round(($x1 + $x2) / 2)
    cy = [int][Math]::Round(($y1 + $y2) / 2)
  })
}
$json = ConvertTo-Json -InputObject @($results.ToArray()) -Compress -Depth 3
if (-not $json) { $json = '[]' }
[Console]::Out.Write($json)
`;

export async function findUiElements(query: string, signal?: AbortSignal): Promise<ScreenHit[]> {
  const scriptPath = await writeScript('windows-find.ps1', FIND_SCRIPT);
  const stdout = await runPowerShell(scriptPath, ['-Query', query], signal);
  return parseHits(stdout);
}

export async function ocrImage(filePath: string, signal?: AbortSignal): Promise<ScreenHit[]> {
  const scriptPath = await writeScript('windows-ocr.ps1', OCR_SCRIPT);
  const stdout = await runPowerShell(scriptPath, ['-Path', filePath], signal);
  return parseHits(stdout);
}

export function offsetHits(hits: ScreenHit[], originX: number, originY: number): ScreenHit[] {
  if (originX === 0 && originY === 0) return hits;
  return hits.map((hit) => ({
    ...hit,
    x: hit.x + originX,
    y: hit.y + originY,
    cx: hit.cx + originX,
    cy: hit.cy + originY,
  }));
}

function compactText(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

export function filterHits(hits: ScreenHit[], query: string): ScreenHit[] {
  const needle = compactText(query);
  if (!needle) return hits.slice(0, 30);
  // Windows OCR 常把汉字拆成「文 件 传 输」。比较时去掉空白，查询「文件传输助手」仍能命中。
  return hits.filter((hit) => compactText(hit.text).includes(needle)).slice(0, 30);
}
