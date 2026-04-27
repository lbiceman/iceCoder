/**
 * 记忆文件路径安全验证。
 *
 * 防护向量：
 * 1. Null byte 注入（C 层系统调用截断）
 * 2. 路径遍历（../ 逃逸记忆目录）
 * 3. URL 编码遍历（%2e%2e%2f）
 * 4. Unicode 规范化攻击（NFKC 全角字符 → ASCII）
 * 5. 符号链接逃逸（symlink 指向记忆目录外）
 * 6. 绝对路径注入
 * 7. Windows 反斜杠遍历
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 路径安全验证错误。
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * 验证文件路径是否安全（在允许的目录内）。
 *
 * @param filePath - 要验证的文件路径（绝对或相对）
 * @param allowedDir - 允许的目录（绝对路径）
 * @returns 规范化后的绝对路径
 * @throws PathTraversalError 如果路径不安全
 */
export function validatePath(filePath: string, allowedDir: string): string {
  // 1. Null byte 检测
  if (filePath.includes('\0')) {
    throw new PathTraversalError(`Null byte in path: "${filePath}"`);
  }

  // 2. URL 编码遍历检测
  let decoded: string;
  try {
    decoded = decodeURIComponent(filePath);
  } catch {
    decoded = filePath;
  }
  if (decoded !== filePath && (decoded.includes('..') || decoded.includes('/'))) {
    throw new PathTraversalError(`URL-encoded traversal in path: "${filePath}"`);
  }

  // 3. Unicode 规范化攻击检测（NFKC 全角字符）
  const normalized = filePath.normalize('NFKC');
  if (
    normalized !== filePath &&
    (normalized.includes('..') ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0'))
  ) {
    throw new PathTraversalError(`Unicode-normalized traversal in path: "${filePath}"`);
  }

  // 4. 反斜杠检测（Windows 路径分隔符作为遍历向量）
  if (filePath.includes('\\') && path.sep !== '\\') {
    throw new PathTraversalError(`Backslash in path on non-Windows system: "${filePath}"`);
  }

  // 5. 解析为绝对路径并检查是否在允许目录内
  const resolvedPath = path.resolve(allowedDir, filePath);
  const normalizedAllowedDir = path.resolve(allowedDir) + path.sep;

  if (!resolvedPath.startsWith(normalizedAllowedDir) && resolvedPath !== path.resolve(allowedDir)) {
    throw new PathTraversalError(`Path escapes allowed directory: "${filePath}"`);
  }

  return resolvedPath;
}

/**
 * 验证文件路径并检查符号链接逃逸。
 * 递归解析符号链接，确保真实路径仍在允许目录内。
 *
 * @param filePath - 要验证的文件路径
 * @param allowedDir - 允许的目录
 * @returns 规范化后的绝对路径
 * @throws PathTraversalError 如果路径不安全或通过符号链接逃逸
 */
export async function validatePathWithSymlink(
  filePath: string,
  allowedDir: string,
): Promise<string> {
  // 先做基础验证
  const resolvedPath = validatePath(filePath, allowedDir);

  // 解析符号链接
  const realPath = await realpathDeepestExisting(resolvedPath);
  const realAllowedDir = await realpathSafe(allowedDir);

  if (realAllowedDir === null) {
    // 允许目录不存在 — 无法验证，拒绝
    throw new PathTraversalError(`Allowed directory does not exist: "${allowedDir}"`);
  }

  if (!realPath.startsWith(realAllowedDir + path.sep) && realPath !== realAllowedDir) {
    throw new PathTraversalError(`Path escapes allowed directory via symlink: "${filePath}"`);
  }

  return resolvedPath;
}

/**
 * 安全的 realpath — 目录不存在时返回 null 而非抛错。
 */
async function realpathSafe(dirPath: string): Promise<string | null> {
  try {
    return await fs.realpath(dirPath);
  } catch {
    return null;
  }
}

/**
 * 递归解析路径中最深存在的祖先的 realpath。
 * 目标文件可能尚不存在（即将创建），所以沿目录树向上查找
 * 直到 realpath 成功，然后将不存在的尾部拼接回去。
 *
 * 安全性：检测 dangling symlink（链接存在但目标不存在）。
 */
async function realpathDeepestExisting(absolutePath: string): Promise<string> {
  const tail: string[] = [];
  let current = absolutePath;

  for (
    let parent = path.dirname(current);
    current !== parent;
    parent = path.dirname(current)
  ) {
    try {
      const realCurrent = await fs.realpath(current);
      return tail.length === 0
        ? realCurrent
        : path.join(realCurrent, ...tail.reverse());
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        // 可能是真的不存在，也可能是 dangling symlink
        try {
          const st = await fs.lstat(current);
          if (st.isSymbolicLink()) {
            throw new PathTraversalError(
              `Dangling symlink detected (target does not exist): "${current}"`
            );
          }
        } catch (lstatErr: unknown) {
          if (lstatErr instanceof PathTraversalError) {
            throw lstatErr;
          }
          // lstat 也失败 — 真的不存在，安全地向上查找
        }
      } else if (code === 'ELOOP') {
        throw new PathTraversalError(`Symlink loop detected in path: "${current}"`);
      } else if (code !== 'ENOTDIR' && code !== 'ENAMETOOLONG') {
        // EACCES, EIO 等 — 无法验证，拒绝
        throw new PathTraversalError(
          `Cannot verify path containment (${code}): "${current}"`
        );
      }

      tail.push(current.slice(parent.length + path.sep.length));
      current = parent;
    }
  }

  return absolutePath;
}

/**
 * 检查绝对路径是否在记忆目录内。
 */
export function isWithinMemoryDir(absolutePath: string, memoryDir: string): boolean {
  try {
    const normalizedPath = path.resolve(absolutePath);
    const normalizedDir = path.resolve(memoryDir) + path.sep;
    return normalizedPath.startsWith(normalizedDir) || normalizedPath === path.resolve(memoryDir);
  } catch {
    return false;
  }
}

/**
 * 清理相对路径键（用于从外部输入构建文件路径）。
 *
 * @param key - 相对路径键
 * @returns 清理后的键
 * @throws PathTraversalError 如果键包含危险模式
 */
export function sanitizePathKey(key: string): string {
  if (key.includes('\0')) {
    throw new PathTraversalError(`Null byte in path key: "${key}"`);
  }

  // URL 编码遍历
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    decoded = key;
  }
  if (decoded !== key && (decoded.includes('..') || decoded.includes('/'))) {
    throw new PathTraversalError(`URL-encoded traversal in path key: "${key}"`);
  }

  // Unicode 规范化
  const normalized = key.normalize('NFKC');
  if (
    normalized !== key &&
    (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\'))
  ) {
    throw new PathTraversalError(`Unicode-normalized traversal in path key: "${key}"`);
  }

  // 反斜杠
  if (key.includes('\\')) {
    throw new PathTraversalError(`Backslash in path key: "${key}"`);
  }

  // 绝对路径
  if (key.startsWith('/')) {
    throw new PathTraversalError(`Absolute path key: "${key}"`);
  }

  return key;
}
