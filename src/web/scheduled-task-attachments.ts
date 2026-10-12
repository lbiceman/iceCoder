/**
 * 定时任务附件：把 /api/chat/upload 的临时文件转存为任务长期可用的副本
 * （临时目录会被 FIFO 淘汰、进程退出清空，而任务要反复执行）。
 *
 * - 图片：复制进任务会话的 imagesCache，保存会话图片 API URL，执行时随消息发送。
 * - 其他文件：复制到 {filesRoot}/{sessionId}/{fileId}/{原文件名}，执行时作为引用路径发送。
 *
 * 请求体格式：
 *   images: Array<{ url: string } | { uploadId: string }>   url 只能是任务已有的图片
 *   files:  Array<{ id: string } | { uploadId: string }>    id 只能是任务已有的文件
 * 字段缺省表示不修改。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScheduledTaskFile } from '../session/scheduled-task-store.js';
import { buildSessionImageApiUrl, persistUploadedImageFiles } from './images-cache.js';
import { getUploadedFile } from './routes/upload.js';

export const ATTACHMENT_EXPIRED_MESSAGE = '附件已失效，请重新上传';
export const ATTACHMENT_INVALID_MESSAGE = '附件参数无效';

type UploadLookup = (uploadId: string) => { originalName: string; filePath: string; size: number } | undefined;

type ImageRef = { url: string } | { uploadId: string };
type FileRef = { id: string } | { uploadId: string };

export interface ScheduledTaskAttachmentPatch {
  images?: string[];
  files?: ScheduledTaskFile[];
}

export interface ScheduledTaskAttachmentsCurrent {
  images: string[];
  files: ScheduledTaskFile[];
}

export interface ScheduledTaskAttachments {
  /** 建会话前预检：参数合法且新上传的临时文件仍在，避免失败后留下空会话。 */
  precheck(body: Record<string, unknown>): void;
  resolve(
    sessionId: string,
    body: Record<string, unknown>,
    current?: ScheduledTaskAttachmentsCurrent,
  ): Promise<ScheduledTaskAttachmentPatch>;
  removeFiles(files: ScheduledTaskFile[]): Promise<void>;
}

export interface ScheduledTaskAttachmentsOptions {
  filesRoot: string;
  lookupUpload?: UploadLookup;
  /** 把图片复制进会话图片目录，返回会话图片 API URL；失败返回 null。 */
  persistImage?: (srcPath: string, sessionId: string) => Promise<string | null>;
}

async function defaultPersistImage(srcPath: string, sessionId: string): Promise<string | null> {
  const [persisted] = await persistUploadedImageFiles([srcPath], sessionId);
  return persisted ? buildSessionImageApiUrl(sessionId, persisted.absolutePath) : null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseRefs<T>(raw: unknown, keepKey: string): T[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(ATTACHMENT_INVALID_MESSAGE);
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    if (isNonEmptyString(obj.uploadId)) return { uploadId: obj.uploadId } as T;
    if (isNonEmptyString(obj[keepKey])) return { [keepKey]: obj[keepKey] } as T;
    throw new Error(ATTACHMENT_INVALID_MESSAGE);
  });
}

/** 去掉路径分隔符与 Windows 非法字符，保留原文件名便于 Agent 识别。 */
function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : 'file';
}

export function createScheduledTaskAttachments(opts: ScheduledTaskAttachmentsOptions): ScheduledTaskAttachments {
  const filesRoot = path.resolve(opts.filesRoot);
  const lookupUpload: UploadLookup = opts.lookupUpload ?? getUploadedFile;
  const persistImage = opts.persistImage ?? defaultPersistImage;

  function requireUpload(uploadId: string) {
    const upload = lookupUpload(uploadId);
    if (!upload) throw new Error(ATTACHMENT_EXPIRED_MESSAGE);
    return upload;
  }

  function parseBody(body: Record<string, unknown>) {
    return {
      images: parseRefs<ImageRef>(body.images, 'url'),
      files: parseRefs<FileRef>(body.files, 'id'),
    };
  }

  async function resolveImages(
    sessionId: string,
    refs: ImageRef[],
    current: string[],
  ): Promise<string[]> {
    const out: string[] = [];
    for (const ref of refs) {
      if ('url' in ref) {
        if (current.includes(ref.url) && !out.includes(ref.url)) out.push(ref.url);
        continue;
      }
      const upload = requireUpload(ref.uploadId);
      const url = await persistImage(upload.filePath, sessionId);
      if (!url) throw new Error(`图片保存失败：${upload.originalName}`);
      out.push(url);
    }
    return out;
  }

  async function resolveFiles(
    sessionId: string,
    refs: FileRef[],
    current: ScheduledTaskFile[],
  ): Promise<ScheduledTaskFile[]> {
    const out: ScheduledTaskFile[] = [];
    const created: ScheduledTaskFile[] = [];
    try {
      for (const ref of refs) {
        if ('id' in ref) {
          const kept = current.find((f) => f.id === ref.id);
          if (kept && !out.some((f) => f.id === kept.id)) out.push(kept);
          continue;
        }
        const upload = requireUpload(ref.uploadId);
        const id = randomUUID();
        const dir = path.join(filesRoot, sessionId, id);
        const dest = path.join(dir, safeFileName(upload.originalName));
        const file = { id, name: upload.originalName, path: dest, size: upload.size };
        created.push(file);
        await fs.mkdir(dir, { recursive: true });
        await fs.copyFile(upload.filePath, dest);
        out.push(file);
      }
    } catch (err) {
      await removeFiles(created);
      throw err;
    }
    return out;
  }

  async function removeFiles(files: ScheduledTaskFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      const dir = path.resolve(path.dirname(file.path));
      if (!dir.startsWith(filesRoot + path.sep)) return;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[scheduled-tasks] 清理附件失败:', dir, (err as Error)?.message ?? err);
        return;
      }
      // 会话级目录为空时一并删除；非空（同会话的其他附件）时 rmdir 失败，忽略即可。
      await fs.rmdir(path.dirname(dir)).catch(() => undefined);
    }));
  }

  return {
    precheck(body) {
      const { images, files } = parseBody(body);
      for (const ref of [...(images ?? []), ...(files ?? [])]) {
        if ('uploadId' in ref) requireUpload(ref.uploadId);
      }
    },

    async resolve(sessionId, body, current) {
      const { images, files } = parseBody(body);
      const patch: ScheduledTaskAttachmentPatch = {};
      if (images) patch.images = await resolveImages(sessionId, images, current?.images ?? []);
      if (files) patch.files = await resolveFiles(sessionId, files, current?.files ?? []);
      return patch;
    },

    removeFiles,
  };
}
