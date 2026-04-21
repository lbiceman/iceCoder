/**
 * PPTX 深度解析工具。
 * 基于 JSZip + xml2js 实现逐页文本提取（含分组形状）、备注、元数据。
 * 相比 officeparser 的纯文本提取，提供更丰富的结构化信息。
 * 源自知识库: PPTX解析工具-Node
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

// ---- 文本提取 ----

function extractTextFromNode(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;

  const texts: string[] = [];

  if (node['a:t']) {
    const t = node['a:t'];
    if (typeof t === 'string') texts.push(t);
    else if (Array.isArray(t))
      t.forEach((item: any) => texts.push(typeof item === 'string' ? item : item._ || ''));
    else if (typeof t === 'object') texts.push(t._ || '');
  }

  for (const key of Object.keys(node)) {
    if (key === '$' || key === 'a:t') continue;
    const child = node[key];
    if (Array.isArray(child))
      child.forEach((item: any) => {
        if (typeof item === 'object') texts.push(extractTextFromNode(item));
      });
    else if (typeof child === 'object') texts.push(extractTextFromNode(child));
  }

  return texts.filter(Boolean).join('');
}

// ---- 形状 ----

interface SlideShape {
  type: string;
  name: string;
  paragraphs: string[];
}

function extractGroupTexts(grpSp: any): SlideShape[] {
  const shapes: SlideShape[] = [];
  if (!grpSp) return shapes;

  const spList = grpSp['p:sp'];
  const spArray = spList ? (Array.isArray(spList) ? spList : [spList]) : [];

  for (const sp of spArray) {
    const shape: SlideShape = { type: 'grouped-shape', name: '', paragraphs: [] };
    const nvSpPr = sp['p:nvSpPr'];
    if (nvSpPr?.['p:cNvPr']?.$?.name) shape.name = nvSpPr['p:cNvPr'].$.name;

    const txBody = sp['p:txBody'];
    if (txBody) {
      const pList = txBody['a:p'];
      const pArray = pList ? (Array.isArray(pList) ? pList : [pList]) : [];
      for (const p of pArray) {
        const text = extractTextFromNode(p);
        if (text.trim()) shape.paragraphs.push(text.trim());
      }
    }
    if (shape.paragraphs.length > 0) shapes.push(shape);
  }

  const nestedGrpSp = grpSp['p:grpSp'];
  if (nestedGrpSp) {
    const nested = Array.isArray(nestedGrpSp) ? nestedGrpSp : [nestedGrpSp];
    nested.forEach((g: any) => shapes.push(...extractGroupTexts(g)));
  }

  return shapes;
}

function extractSlideTexts(slideObj: any): SlideShape[] {
  const shapes: SlideShape[] = [];
  try {
    const spTree = slideObj?.['p:sld']?.['p:cSld']?.['p:spTree'];
    if (!spTree) return shapes;

    const spList = spTree['p:sp'];
    const spArray = spList ? (Array.isArray(spList) ? spList : [spList]) : [];

    for (const sp of spArray) {
      const shape: SlideShape = { type: 'shape', name: '', paragraphs: [] };
      const nvSpPr = sp['p:nvSpPr'];
      if (nvSpPr?.['p:cNvPr']?.$?.name) shape.name = nvSpPr['p:cNvPr'].$.name;

      const txBody = sp['p:txBody'];
      if (txBody) {
        const pList = txBody['a:p'];
        const pArray = pList ? (Array.isArray(pList) ? pList : [pList]) : [];
        for (const p of pArray) {
          const text = extractTextFromNode(p);
          if (text.trim()) shape.paragraphs.push(text.trim());
        }
      }
      if (shape.paragraphs.length > 0) shapes.push(shape);
    }

    const grpSpList = spTree['p:grpSp'];
    const grpSpArray = grpSpList ? (Array.isArray(grpSpList) ? grpSpList : [grpSpList]) : [];
    for (const grpSp of grpSpArray) shapes.push(...extractGroupTexts(grpSp));
  } catch {
    // 忽略解析异常，返回已提取的内容
  }
  return shapes;
}

// ---- 备注 ----

async function extractNotes(zip: JSZip, slideIndex: number): Promise<string> {
  const notesFile = zip.file(`ppt/notesSlides/notesSlide${slideIndex}.xml`);
  if (!notesFile) return '';

  const xml = await notesFile.async('string');
  const obj = await parseXml(xml);

  try {
    const spTree = obj?.['p:notes']?.['p:cSld']?.['p:spTree'];
    if (!spTree) return '';

    const spList = spTree['p:sp'];
    const spArray = spList ? (Array.isArray(spList) ? spList : [spList]) : [];
    const noteTexts: string[] = [];

    for (const sp of spArray) {
      const ph = sp?.['p:nvSpPr']?.['p:nvPr']?.['p:ph'];
      if (ph?.$?.type === 'body' || ph?.$?.idx) {
        const text = extractTextFromNode(sp['p:txBody'] || {});
        if (text.trim()) noteTexts.push(text.trim());
      }
    }
    return noteTexts.join('\n');
  } catch {
    return '';
  }
}

// ---- 元数据 ----

interface PptxMetadata {
  title?: string;
  creator?: string;
  lastModifiedBy?: string;
  created?: string;
  modified?: string;
  revision?: string;
  application?: string;
  totalSlides?: string;
  words?: string;
  paragraphs?: string;
}

async function extractMetadata(zip: JSZip): Promise<PptxMetadata> {
  const metadata: PptxMetadata = {};

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
      metadata.totalSlides = props['Slides'] || '';
      metadata.words = props['Words'] || '';
      metadata.paragraphs = props['Paragraphs'] || '';
    }
  }

  return metadata;
}

// ---- 核心解析函数（直接接收 Buffer，供外部调用） ----

/**
 * 直接从 Buffer 解析 PPTX 文件内容。
 * 不做路径校验和扩展名检查，适合已上传文件的场景。
 */
export async function parsePptxBuffer(
  data: Buffer,
  options?: { includeNotes?: boolean; includeMetadata?: boolean },
): Promise<{ success: boolean; output: string; error?: string }> {
  const includeNotes = options?.includeNotes !== false;
  const includeMetadata = options?.includeMetadata !== false;

  try {
    const zip = await JSZip.loadAsync(data);

    // 提取元数据
    let metadata: PptxMetadata = {};
    if (includeMetadata) {
      metadata = await extractMetadata(zip);
    }

    // 收集幻灯片文件并排序
    const slideFiles: { path: string; index: number }[] = [];
    zip.forEach((relativePath) => {
      const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      if (match) slideFiles.push({ path: relativePath, index: parseInt(match[1]) });
    });
    slideFiles.sort((a, b) => a.index - b.index);

    // 逐页解析
    const slideOutputs: string[] = [];
    for (const slideFile of slideFiles) {
      const slideXml = await zip.file(slideFile.path)!.async('string');
      const slideObj = await parseXml(slideXml);
      const shapes = extractSlideTexts(slideObj);
      const notes = includeNotes ? await extractNotes(zip, slideFile.index) : '';

      const lines: string[] = [`=== 第 ${slideFile.index} 页 ===`];
      for (const shape of shapes) {
        lines.push(...shape.paragraphs);
      }
      if (notes) lines.push(`[备注] ${notes}`);
      slideOutputs.push(lines.join('\n'));
    }

    // 组装输出
    const parts: string[] = [];

    if (includeMetadata && Object.keys(metadata).length > 0) {
      const metaLines = ['[文档信息]'];
      if (metadata.title) metaLines.push(`标题: ${metadata.title}`);
      if (metadata.creator) metaLines.push(`作者: ${metadata.creator}`);
      if (metadata.totalSlides) metaLines.push(`幻灯片数: ${metadata.totalSlides}`);
      if (metadata.application) metaLines.push(`应用程序: ${metadata.application}`);
      if (metadata.created) metaLines.push(`创建时间: ${metadata.created}`);
      if (metadata.modified) metaLines.push(`修改时间: ${metadata.modified}`);
      parts.push(metaLines.join('\n'));
    }

    parts.push(slideOutputs.join('\n\n'));

    return { success: true, output: parts.join('\n\n') };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return { success: false, output: '', error: `PPTX 解析失败: ${message}` };
  }
}

// ---- 安全路径 ----

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

// ---- 工具导出 ----

/**
 * 创建 PPTX 深度解析工具。
 * @param workDir - 工作目录
 */
export function createPptxParseTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'parse_pptx_deep',
      description:
        '深度解析 PPTX 演示文稿。逐页提取文本（含分组形状）、备注和元数据。比通用 parse_ppt 工具提供更丰富的结构化信息。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'PPTX 文件路径（相对于工作目录）' },
          includeNotes: {
            type: 'boolean',
            description: '是否提取备注内容，默认 true',
            default: true,
          },
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
      const includeNotes = args.includeNotes !== false;
      const includeMetadata = args.includeMetadata !== false;

      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.pptx') {
        return { success: false, output: '', error: '仅支持 .pptx 格式文件' };
      }

      try {
        const data = await fs.readFile(filePath);
        const zip = await JSZip.loadAsync(data);

        // 提取元数据
        let metadata: PptxMetadata = {};
        if (includeMetadata) {
          metadata = await extractMetadata(zip);
        }

        // 收集幻灯片文件并排序
        const slideFiles: { path: string; index: number }[] = [];
        zip.forEach((relativePath) => {
          const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
          if (match) slideFiles.push({ path: relativePath, index: parseInt(match[1]) });
        });
        slideFiles.sort((a, b) => a.index - b.index);

        // 逐页解析
        const slideOutputs: string[] = [];
        for (const slideFile of slideFiles) {
          const slideXml = await zip.file(slideFile.path)!.async('string');
          const slideObj = await parseXml(slideXml);
          const shapes = extractSlideTexts(slideObj);
          const notes = includeNotes ? await extractNotes(zip, slideFile.index) : '';

          const lines: string[] = [`=== 第 ${slideFile.index} 页 ===`];
          for (const shape of shapes) {
            lines.push(...shape.paragraphs);
          }
          if (notes) lines.push(`[备注] ${notes}`);
          slideOutputs.push(lines.join('\n'));
        }

        // 组装输出
        const parts: string[] = [];

        if (includeMetadata && Object.keys(metadata).length > 0) {
          const metaLines = ['[文档信息]'];
          if (metadata.title) metaLines.push(`标题: ${metadata.title}`);
          if (metadata.creator) metaLines.push(`作者: ${metadata.creator}`);
          if (metadata.totalSlides) metaLines.push(`幻灯片数: ${metadata.totalSlides}`);
          if (metadata.application) metaLines.push(`应用程序: ${metadata.application}`);
          if (metadata.created) metaLines.push(`创建时间: ${metadata.created}`);
          if (metadata.modified) metaLines.push(`修改时间: ${metadata.modified}`);
          parts.push(metaLines.join('\n'));
        }

        parts.push(slideOutputs.join('\n\n'));

        return {
          success: true,
          output: parts.join('\n\n'),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        return { success: false, output: '', error: `PPTX 解析失败: ${message}` };
      }
    },
  };
}
