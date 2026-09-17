import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface TypeScriptSourceFile {
  absolutePath: string;
  relativePath: string;
  content: string;
}

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
]);
const READ_BATCH_SIZE = 32;

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
        files.push(...await collectTypeScriptFiles(absolutePath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolutePath);
    }
  }

  return files;
}

export async function readTypeScriptSourceFiles(
  sourceRoot: string,
  repoRoot: string,
): Promise<TypeScriptSourceFile[]> {
  const absolutePaths = (await collectTypeScriptFiles(sourceRoot)).sort();
  const sourceFiles: TypeScriptSourceFile[] = [];

  for (let index = 0; index < absolutePaths.length; index += READ_BATCH_SIZE) {
    const batch = absolutePaths.slice(index, index + READ_BATCH_SIZE);
    sourceFiles.push(...await Promise.all(batch.map(async absolutePath => ({
      absolutePath,
      relativePath: path.relative(repoRoot, absolutePath).split(path.sep).join('/'),
      content: await fs.readFile(absolutePath, 'utf-8'),
    }))));
  }

  return sourceFiles;
}
