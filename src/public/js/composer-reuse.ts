/**
 * 把一条用户消息还原成输入框草稿：正文、技能、@ 文件、图片、已上传文件。
 * 不碰 DOM。展示层先拆好 shell / plan / 技能 / 路径后再调用。
 */

export interface ReuseUploadedFile {
  fileId: string;
  filename: string;
  size?: number;
}

export interface ComposerReusePayload {
  text: string;
  skills: string[];
  fileRefs: string[];
  images: string[];
  uploadedFiles: ReuseUploadedFile[];
}

const FILE_ID_RE = /^\[file:([a-f0-9-]+)\]\s*(.*)$/i;
const FILE_PLAIN_RE = /^\[file\]\s+(.+)$/i;
const IMAGE_PLACEHOLDER = '(图片)';

function emptyPayload(): ComposerReusePayload {
  return { text: '', skills: [], fileRefs: [], images: [], uploadedFiles: [] };
}

function normalizeSkillName(raw: string): string {
  return String(raw || '').trim().replace(/^#/, '');
}

/** 把绝对地址收成会话图片接口路径，方便再次发送时被认成已缓存图片。 */
export function normalizeReuseImageUrl(raw: string): string {
  const url = String(raw || '').trim();
  if (!url) return '';
  const marker = '/api/sessions/';
  const idx = url.indexOf(marker);
  if (idx >= 0 && url.includes('/images/')) return url.slice(idx);
  return url;
}

function normalizeAttachedFiles(raw: unknown): ReuseUploadedFile[] {
  if (!Array.isArray(raw)) return [];
  const out: ReuseUploadedFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as { fileId?: unknown; filename?: unknown; size?: unknown };
    if (!item || typeof item !== 'object') continue;
    const fileId = String(item.fileId || '').trim();
    if (!fileId) continue;
    const filename = String(item.filename || '').trim() || 'file';
    const entry: ReuseUploadedFile = { fileId, filename };
    if (typeof item.size === 'number' && Number.isFinite(item.size)) entry.size = item.size;
    out.push(entry);
  }
  return out;
}

function prefixCommand(text: string, command: string): string {
  const cmd = String(command || '').trim();
  const body = String(text || '').trim();
  if (!cmd) return body;
  if (!body) return cmd;
  if (body === cmd || body.startsWith(`${cmd}\n`) || body.startsWith(`${cmd} `)) return body;
  if (cmd === '/shell' || cmd === '/plan' || cmd === '/open' || cmd === '/also') {
    return `${cmd}\n${body}`;
  }
  return `${cmd}\n${body}`;
}

export function composerReuseHasContent(payload: ComposerReusePayload | null | undefined): boolean {
  if (!payload) return false;
  return !!(
    payload.text
    || (payload.skills && payload.skills.length)
    || (payload.fileRefs && payload.fileRefs.length)
    || (payload.images && payload.images.length)
    || (payload.uploadedFiles && payload.uploadedFiles.length)
  );
}

export function buildComposerReusePayload(msg: {
  content?: string;
  images?: string[];
  skills?: string[];
  referencePaths?: string[];
  shellCommand?: string;
  planCommand?: string;
  openCommand?: string;
  alsoNote?: boolean;
  attachedFiles?: unknown;
} | null | undefined): ComposerReusePayload {
  if (!msg) return emptyPayload();

  const skills: string[] = [];
  const seenSkills = new Set<string>();
  const skillList = Array.isArray(msg.skills) ? msg.skills : [];
  for (let i = 0; i < skillList.length; i++) {
    const name = normalizeSkillName(skillList[i]);
    const key = name.toLowerCase();
    if (!name || seenSkills.has(key)) continue;
    seenSkills.add(key);
    skills.push(name);
  }

  const fileRefs: string[] = [];
  const seenRefs = new Set<string>();
  const refList = Array.isArray(msg.referencePaths) ? msg.referencePaths : [];
  for (let i = 0; i < refList.length; i++) {
    const p = String(refList[i] || '').trim();
    const key = p.replace(/\//g, '\\').toLowerCase();
    if (!p || seenRefs.has(key)) continue;
    seenRefs.add(key);
    fileRefs.push(p);
  }

  const images: string[] = [];
  const seenImages = new Set<string>();
  const imageList = Array.isArray(msg.images) ? msg.images : [];
  for (let i = 0; i < imageList.length; i++) {
    const url = normalizeReuseImageUrl(imageList[i]);
    if (!url || seenImages.has(url)) continue;
    seenImages.add(url);
    images.push(url);
  }

  const uploadedFiles: ReuseUploadedFile[] = [];
  const seenFileIds = new Set<string>();
  const attachedNames = new Set<string>();
  const fromMeta = normalizeAttachedFiles(msg.attachedFiles);
  for (let i = 0; i < fromMeta.length; i++) {
    const file = fromMeta[i];
    if (seenFileIds.has(file.fileId)) continue;
    seenFileIds.add(file.fileId);
    attachedNames.add(file.filename.toLowerCase());
    uploadedFiles.push(file);
  }

  const kept: string[] = [];
  const lines = String(msg.content || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const withId = FILE_ID_RE.exec(trimmed);
    if (withId) {
      const fileId = withId[1];
      const filename = (withId[2] || '').trim() || 'file';
      if (!seenFileIds.has(fileId)) {
        seenFileIds.add(fileId);
        attachedNames.add(filename.toLowerCase());
        uploadedFiles.push({ fileId, filename });
      }
      continue;
    }
    const plain = FILE_PLAIN_RE.exec(trimmed);
    if (plain && attachedNames.has(plain[1].trim().toLowerCase())) continue;
    kept.push(lines[i]);
  }

  let text = kept.join('\n').trim();
  if (text === IMAGE_PLACEHOLDER) text = '';

  if (msg.alsoNote) text = prefixCommand(text, '/also');
  else if (msg.shellCommand) text = prefixCommand(text, msg.shellCommand);
  else if (msg.planCommand) text = prefixCommand(text, msg.planCommand);
  else if (msg.openCommand) text = prefixCommand(text, msg.openCommand);

  return { text, skills, fileRefs, images, uploadedFiles };
}

if (typeof window !== 'undefined') {
  window.ComposerReuse = {
    build: buildComposerReusePayload,
    hasContent: composerReuseHasContent,
  };
}
