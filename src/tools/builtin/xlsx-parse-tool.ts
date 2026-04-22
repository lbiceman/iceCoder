/**
 * XLSX 深度解析工具。
 * 基于 JSZip + xml2js 实现逐工作表数据提取（含行、列、单元格值）。
 * 支持合并单元格、共享字符串、元数据提取。
 * 相比 officeparser 的纯文本提取，提供更丰富的结构化信息。
 */

import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

// ---- XML 解析 ----

async function parseXml(xmlString: string): Promise<any> {
  return parseStringPromise(xmlString, {
    explicitArray: false,
    ignoreAttrs: false,
    mergeAttrs: false,
  });
}

// ---- 共享字符串表 ----

async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return [];

  const xml = await file.async('string');
  const obj = await parseXml(xml);
  const siList = obj?.sst?.si;
  if (!siList) return [];

  const items = Array.isArray(siList) ? siList : [siList];
  return items.map((si: any) => {
    if (typeof si === 'string') return si;
    // 处理 <si><t>text</t></si> 或 <si><r><t>text</t></r></si>
    if (si.t) return typeof si.t === 'string' ? si.t : si.t._ || '';
    if (si.r) {
      const runs = Array.isArray(si.r) ? si.r : [si.r];
      return runs.map((r: any) => (r.t ? (typeof r.t === 'string' ? r.t : r.t._ || '') : '')).join('');
    }
    return '';
  });
}

// ---- 样式表（用于判断日期格式等） ----

interface XlsxStyles {
  numFmts: Record<number, string>;
  cellXfs: Array<{ numFmtId: number }>;
}

async function loadStyles(zip: JSZip): Promise<XlsxStyles> {
  const styles: XlsxStyles = { numFmts: {}, cellXfs: [] };

  const file = zip.file('xl/styles.xml');
  if (!file) return styles;

  const xml = await file.async('string');
  const obj = await parseXml(xml);

  // 自定义数字格式
  const numFmts = obj?.styleSheet?.numFmts?.numFmt;
  if (numFmts) {
    const arr = Array.isArray(numFmts) ? numFmts : [numFmts];
    for (const fmt of arr) {
      if (fmt.$?.numFmtId && fmt.$?.formatCode) {
        styles.numFmts[parseInt(fmt.$.numFmtId)] = fmt.$.formatCode;
      }
    }
  }

  // 单元格格式
  const cellXfs = obj?.styleSheet?.cellXfs?.xf;
  if (cellXfs) {
    const arr = Array.isArray(cellXfs) ? cellXfs : [cellXfs];
    styles.cellXfs = arr.map((xf: any) => ({
      numFmtId: xf.$?.numFmtId ? parseInt(xf.$.numFmtId) : 0,
    }));
  }

  return styles;
}

// ---- 判断是否为日期格式 ----

const DATE_FORMAT_PATTERNS = [
  /[yYmMdDhHsS]/,
  /日期|date|time/i,
];

function isDateFormat(formatCode: string): boolean {
  return DATE_FORMAT_PATTERNS.some((p) => p.test(formatCode));
}

function isDateStyle(styles: XlsxStyles, styleIdx: number): boolean {
  const xf = styles.cellXfs[styleIdx];
  if (!xf) return false;

  const fmtId = xf.numFmtId;

  // 内置日期格式 ID: 14-22, 27-36, 45-47, 50-58, 71-81
  if ((fmtId >= 14 && fmtId <= 22) ||
      (fmtId >= 27 && fmtId <= 36) ||
      (fmtId >= 45 && fmtId <= 47) ||
      (fmtId >= 50 && fmtId <= 58) ||
      (fmtId >= 71 && fmtId <= 81)) {
    return true;
  }

  // 自定义格式
  const customFmt = styles.numFmts[fmtId];
  if (customFmt && isDateFormat(customFmt)) {
    return true;
  }

  return false;
}

// ---- 单元格引用解析 ----

/**
 * 将 "A1" 格式的单元格引用转换为 { col: 1, row: 1 }。
 */
function parseCellRef(ref: string): { col: number; row: number } {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return { col: 0, row: 0 };

  const colStr = match[1];
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }

  return { col, row: parseInt(match[2]) };
}

/**
 * 将列号（1-based）转换为字母（如 1 -> A, 27 -> AA）。
 */
function colToLetter(col: number): string {
  let letter = '';
  while (col > 0) {
    col--;
    letter = String.fromCharCode(65 + (col % 26)) + letter;
    col = Math.floor(col / 26);
  }
  return letter;
}

// ---- 合并单元格解析 ----

interface MergeCell {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

function parseMergeCells(mergeCells: any): MergeCell[] {
  if (!mergeCells) return [];

  const cells = mergeCells.mergeCell;
  if (!cells) return [];

  const arr = Array.isArray(cells) ? cells : [cells];
  return arr.map((mc: any) => {
    const ref = mc.$.ref;
    const [start, end] = ref.split(':');
    const startPos = parseCellRef(start);
    const endPos = end ? parseCellRef(end) : startPos;
    return {
      startCol: startPos.col,
      startRow: startPos.row,
      endCol: endPos.col,
      endRow: endPos.row,
    };
  });
}

// ---- 工作表解析 ----

interface SheetData {
  name: string;
  rows: Record<number, Record<number, string>>;
  mergeCells: MergeCell[];
  maxCol: number;
  maxRow: number;
}

async function parseSheet(
  zip: JSZip,
  sharedStrings: string[],
  styles: XlsxStyles,
  sheetPath: string,
  sheetName: string,
): Promise<SheetData> {
  const result: SheetData = {
    name: sheetName,
    rows: {},
    mergeCells: [],
    maxCol: 0,
    maxRow: 0,
  };

  const file = zip.file(sheetPath);
  if (!file) return result;

  const xml = await file.async('string');
  const obj = await parseXml(xml);

  const worksheet = obj?.worksheet;
  if (!worksheet) return result;

  // 合并单元格
  result.mergeCells = parseMergeCells(worksheet.mergeCells);

  // 行数据
  const sheetData = worksheet.sheetData;
  if (!sheetData?.row) return result;

  const rows = Array.isArray(sheetData.row) ? sheetData.row : [sheetData.row];

  for (const row of rows) {
    const rowNum = parseInt(row.$.r);
    if (!row.c) continue;

    const cells = Array.isArray(row.c) ? row.c : [row.c];
    const rowData: Record<number, string> = {};

    for (const cell of cells) {
      const ref = cell.$.r;
      const { col } = parseCellRef(ref);
      const cellType = cell.$.t || '';  // t="s" 表示共享字符串, t="str" 内联字符串, t="b" 布尔, t="e" 错误
      const cellStyle = cell.$.s ? parseInt(cell.$.s) : undefined;
      const cellValue = cell.v;

      if (cellValue === undefined && cell.is?._ === undefined) continue;

      let value = '';

      if (cellType === 's' && cellValue !== undefined) {
        // 共享字符串
        const idx = parseInt(typeof cellValue === 'string' ? cellValue : cellValue._ || '0');
        value = sharedStrings[idx] || '';
      } else if (cellType === 'str' || cellType === 'inlineStr') {
        // 内联字符串
        value = cell.is?.t || '';
      } else if (cellType === 'b') {
        // 布尔值
        value = cellValue === '1' || cellValue?._ === '1' ? 'TRUE' : 'FALSE';
      } else if (cellType === 'e') {
        // 错误
        value = `#${cellValue || ''}`;
      } else if (cellValue !== undefined) {
        // 数值
        const rawValue = typeof cellValue === 'string' ? cellValue : cellValue._ || '';
        // 检查是否为日期格式
        if (cellStyle !== undefined && isDateStyle(styles, cellStyle) && rawValue) {
          value = `[日期] ${rawValue}`;
        } else {
          value = rawValue;
        }
      }

      if (value !== '') {
        rowData[col] = value;
        if (col > result.maxCol) result.maxCol = col;
      }
    }

    if (Object.keys(rowData).length > 0) {
      result.rows[rowNum] = rowData;
      if (rowNum > result.maxRow) result.maxRow = rowNum;
    }
  }

  return result;
}

// ---- 格式化输出 ----

function formatSheetOutput(sheet: SheetData): string {
  const lines: string[] = [`--- 工作表: ${sheet.name} ---`];

  // 获取所有有数据的列和行
  const colSet = new Set<number>();
  const rowNums = Object.keys(sheet.rows).map(Number).sort((a, b) => a - b);

  for (const rowNum of rowNums) {
    const row = sheet.rows[rowNum];
    for (const col of Object.keys(row).map(Number)) {
      colSet.add(col);
    }
  }

  const cols = Array.from(colSet).sort((a, b) => a - b);

  if (rowNums.length === 0) {
    lines.push('  (空工作表)');
    return lines.join('\n');
  }

  // 输出表头（第一行作为表头提示）
  const firstRow = rowNums[0];
  const headerCells = cols.map((col) => sheet.rows[firstRow]?.[col] || '').join(' | ');
  lines.push(`  行 ${firstRow}: ${headerCells}`);

  // 输出数据行
  for (let i = 1; i < rowNums.length; i++) {
    const rowNum = rowNums[i];
    const row = sheet.rows[rowNum];
    const cells = cols.map((col) => row[col] || '').join(' | ');
    lines.push(`  行 ${rowNum}: ${cells}`);
  }

  // 合并单元格信息
  if (sheet.mergeCells.length > 0) {
    const mergeLines = sheet.mergeCells.map(
      (mc) => `  ${colToLetter(mc.startCol)}${mc.startRow}:${colToLetter(mc.endCol)}${mc.endRow}`,
    );
    lines.push(`  [合并单元格] ${mergeLines.join(', ')}`);
  }

  return lines.join('\n');
}

// ---- 元数据 ----

interface XlsxMetadata {
  title?: string;
  creator?: string;
  lastModifiedBy?: string;
  created?: string;
  modified?: string;
  revision?: string;
  application?: string;
  totalSheets?: string;
}

async function extractMetadata(zip: JSZip): Promise<XlsxMetadata> {
  const metadata: XlsxMetadata = {};

  const corePropFile = zip.file('docProps/core.xml');
  if (corePropFile) {
    const xml = await corePropFile.async('string');
    const obj = await parseXml(xml);
    const props = obj?.['cp:coreProperties'];
    if (props) {
      metadata.title = props['dc:title'] || '';
      metadata.creator = props['dc:creator'] || '';
      metadata.lastModifiedBy = props['cp:lastModifiedBy'] || '';
      metadata.created = props['dcterms:created']?._ || '';
      metadata.modified = props['dcterms:modified']?._ || '';
      metadata.revision = props['cp:revision'] || '';
    }
  }

  const appPropFile = zip.file('docProps/app.xml');
  if (appPropFile) {
    const xml = await appPropFile.async('string');
    const obj = await parseXml(xml);
    const props = obj?.['Properties'];
    if (props) {
      metadata.application = props['Application'] || '';
      metadata.totalSheets = props['Sheets'] || '';
    }
  }

  return metadata;
}

// ---- 获取所有工作表信息 ----

interface SheetInfo {
  name: string;
  path: string;
  id: number;
}

async function getSheets(zip: JSZip): Promise<SheetInfo[]> {
  const workbookFile = zip.file('xl/workbook.xml');
  if (!workbookFile) return [];

  const xml = await workbookFile.async('string');
  const obj = await parseXml(xml);

  const sheets = obj?.workbook?.sheets?.sheet;
  if (!sheets) return [];

  const arr = Array.isArray(sheets) ? sheets : [sheets];
  return arr.map((sheet: any) => ({
    name: sheet.$.name || '未命名',
    path: `xl/worksheets/sheet${sheet.$.sheetId}.xml`,
    id: parseInt(sheet.$.sheetId),
  }));
}

// ---- 核心解析函数（直接接收 Buffer，供外部调用） ----

/**
 * 直接从 Buffer 解析 XLSX 文件内容。
 * 不做路径校验和扩展名检查，适合已上传文件的场景。
 */
export async function parseXlsxBuffer(
  data: Buffer,
  options?: { includeMetadata?: boolean },
): Promise<{ success: boolean; output: string; error?: string }> {
  const includeMetadata = options?.includeMetadata !== false;

  try {
    const zip = await JSZip.loadAsync(data);

    // 加载共享字符串和样式
    const sharedStrings = await loadSharedStrings(zip);
    const styles = await loadStyles(zip);

    // 提取元数据
    let metadata: XlsxMetadata = {};
    if (includeMetadata) {
      metadata = await extractMetadata(zip);
    }

    // 获取工作表列表
    const sheets = await getSheets(zip);

    // 逐工作表解析
    const sheetOutputs: string[] = [];
    for (const sheet of sheets) {
      const sheetData = await parseSheet(zip, sharedStrings, styles, sheet.path, sheet.name);
      sheetOutputs.push(formatSheetOutput(sheetData));
    }

    // 组装输出
    const parts: string[] = [];

    if (includeMetadata && Object.keys(metadata).length > 0) {
      const metaLines = ['[文档信息]'];
      if (metadata.title) metaLines.push(`标题: ${metadata.title}`);
      if (metadata.creator) metaLines.push(`作者: ${metadata.creator}`);
      if (metadata.lastModifiedBy) metaLines.push(`最后修改者: ${metadata.lastModifiedBy}`);
      if (metadata.totalSheets) metaLines.push(`工作表数: ${metadata.totalSheets}`);
      if (metadata.application) metaLines.push(`应用程序: ${metadata.application}`);
      if (metadata.created) metaLines.push(`创建时间: ${metadata.created}`);
      if (metadata.modified) metaLines.push(`修改时间: ${metadata.modified}`);
      parts.push(metaLines.join('\n'));
    }

    if (sheets.length === 0) {
      parts.push('(未找到工作表)');
    } else {
      parts.push(sheetOutputs.join('\n\n'));
    }

    return { success: true, output: parts.join('\n\n') };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return { success: false, output: '', error: `XLSX 解析失败: ${message}` };
  }
}

// ---- 安全路径 ----

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

// ---- 工具导出 ----

/**
 * 创建 XLSX 深度解析工具。
 * @param workDir - 工作目录
 */
export function createXlsxParseTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'parse_xlsx_deep',
      description:
        '深度解析 XLSX 电子表格。逐工作表提取数据（含行、列、单元格值），支持共享字符串、合并单元格、日期格式识别和元数据。比通用 parse_document 工具提供更丰富的结构化信息。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'XLSX 文件路径（相对于工作目录）' },
          includeMetadata: {
            type: 'boolean',
            description: '是否提取文档元数据，默认 true',
            default: true,
          },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const filePath = safePath(args.path, workDir);
      const includeMetadata = args.includeMetadata !== false;

      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.xlsx') {
        return { success: false, output: '', error: '仅支持 .xlsx 格式文件' };
      }

      try {
        const data = await fs.readFile(filePath);
        const result = await parseXlsxBuffer(data, { includeMetadata });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        return { success: false, output: '', error: `XLSX 解析失败: ${message}` };
      }
    },
  };
}
