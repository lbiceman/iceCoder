/**
 * 定时任务附件：把 /api/chat/upload 的临时文件转存为任务长期可用的副本
 * （临时目录会被 FIFO 淘汰、进程退出清空，而任务要反复执行）。
 *
 * 图片与其他文件都复制到 {filesRoot}/{ownerId}/{fileId}/{原文件名}，归任务所有、不随会话删除。
 * ownerId 是任务 id（旧版本按会话 id 归档的附件路径照常可用）：
 * - 图片：执行前复制进当时专属会话的 imagesCache（见 scheduled-task-runtime），随消息发送。
 * - 其他文件：执行时作为引用路径发送。
 *
 * 请求体格式：
 *   images: Array<{ id: string } | { uploadId: string }>   id 只能是任务已有的图片
 *   files:  Array<{ id: string } | { uploadId: string }>   id 只能是任务已有的文件
 * 字段缺省表示不修改。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ScheduledTaskFile } from '../session/scheduled-task-store.js';
import { getUploadedFile } from './routes/upload.js';

export const ATTACHMENT_EXPIRED_MESSAGE = '附件已失效，请重新上传';
export const ATTACHMENT_INVALID_MESSAGE = '附件参数无效';

type UploadLookup = (uploadId: string) => { originalName: string; filePath: string; size: number } | undefined;

type AttachmentRef = { id: string } | { uploadId: string };

export interface ScheduledTaskAttachmentPatch {
  images?: ScheduledTaskFile[];
  files?: ScheduledTaskFile[];
}

export interface ScheduledTaskAttachmentsCurrent {
  images: ScheduledTaskFile[];
  files: ScheduledTaskFile[];
}

export interface ScheduledTaskAttachments {
  /** 建任务前预检：参数合法且新上传的临时文件仍在。 */
  precheck(body: Record<string, unknown>): void;
  resolve(
    ownerId: string,
    body: Record<string, unknown>,
    current?: ScheduledTaskAttachmentsCurrent,
  ): Promise<ScheduledTaskAttachmentPatch>;
  /** 把本地文件复制成任务附件（迁移旧版本的会话图片时用）。 */
  importFile(ownerId: string, srcPath: string, name: string): Promise<ScheduledTaskFile>;
  removeFiles(files: ScheduledTaskFile[]): Promise<void>;
}

export interface ScheduledTaskAttachmentsOptions {
  filesRoot: string;
  lookupUpload?: UploadLookup;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseRefs(raw: unknown): AttachmentRef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(ATTACHMENT_INVALID_MESSAGE);
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    if (isNonEmptyString(obj.uploadId)) return { uploadId: obj.uploadId };
    if (isNonEmptyString(obj.id)) return { id: obj.id };
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

  function requireUpload(uploadId: string) {
    const upload = lookupUpload(uploadId);
    if (!upload) throw new Error(ATTACHMENT_EXPIRED_MESSAGE);
    return upload;
  }

  function parseBody(body: Record<string, unknown>) {
    return {
      images: parseRefs(body.images),
      files: parseRefs(body.files),
    };
  }

  async function copyIn(ownerId: string, srcPath: string, name: string, size: number): Promise<ScheduledTaskFile> {
    if (!ownerId) throw new Error(ATTACHMENT_INVALID_MESSAGE);
    const id = randomUUID();
    const dir = path.join(filesRoot, ownerId, id);
    const dest = path.join(dir, safeFileName(name));
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(srcPath, dest);
    } catch (err) {
      await removeFiles([{ id, name, path: dest, size }]);
      throw err;
    }
    return { id, name, path: dest, size };
  }

  async function resolveRefs(
    ownerId: string,
    refs: AttachmentRef[],
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
        const file = await copyIn(ownerId, upload.filePath, upload.originalName, upload.size);
        created.push(file);
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
      // 任务级目录为空时一并删除；非空（同任务的其他附件）时 rmdir 失败，忽略即可。
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

    async resolve(ownerId, body, current) {
      const { images, files } = parseBody(body);
      const patch: ScheduledTaskAttachmentPatch = {};
      if (images) patch.images = await resolveRefs(ownerId, images, current?.images ?? []);
      if (files) {
        try {
          patch.files = await resolveRefs(ownerId, files, current?.files ?? []);
        } catch (err) {
          await removeFiles((patch.images ?? []).filter((img) => !current?.images.some((c) => c.id === img.id)));
          throw err;
        }
      }
      return patch;
    },

    async importFile(ownerId, srcPath, name) {
      const { size } = await fs.stat(srcPath);
      return copyIn(ownerId, srcPath, name, size);
    },

    removeFiles,
  };
}
