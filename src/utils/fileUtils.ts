import * as fs from 'fs';
import * as path from 'path';

export function findCSVFiles(importsDir: string): string[] {
  if (!fs.existsSync(importsDir)) {
    return [];
  }

  return fs
    .readdirSync(importsDir)
    .filter((file) => file.toLowerCase().endsWith('.csv'))
    .filter((file) => {
      const fullPath = path.join(importsDir, file);
      return fs.statSync(fullPath).isFile();
    });
}

export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export interface SyncCSVResult {
  synced: string[];
  errors: Array<{ file: string; error: string }>;
}

export function syncCSVFilesToWorktree(
  mainRepoPath: string,
  worktreePath: string,
  importDir: string
): SyncCSVResult {
  const result: SyncCSVResult = {
    synced: [],
    errors: [],
  };

  const mainImportDir = path.join(mainRepoPath, importDir);
  const worktreeImportDir = path.join(worktreePath, importDir);

  // Find all CSV files in main repo
  const csvFiles = findCSVFiles(mainImportDir);

  if (csvFiles.length === 0) {
    return result;
  }

  // Ensure destination directory exists
  ensureDirectory(worktreeImportDir);

  // Copy each CSV file to worktree
  for (const file of csvFiles) {
    try {
      const sourcePath = path.join(mainImportDir, file);
      const destPath = path.join(worktreeImportDir, file);
      fs.copyFileSync(sourcePath, destPath);
      result.synced.push(file);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push({ file, error: errorMsg });
    }
  }

  return result;
}

export interface CleanupCSVResult {
  deleted: string[];
  errors: Array<{ file: string; error: string }>;
}

export function cleanupProcessedCSVFiles(
  mainRepoPath: string,
  importDir: string
): CleanupCSVResult {
  const result: CleanupCSVResult = {
    deleted: [],
    errors: [],
  };

  const mainImportDir = path.join(mainRepoPath, importDir);

  // Find all CSV files in main repo
  const csvFiles = findCSVFiles(mainImportDir);

  if (csvFiles.length === 0) {
    return result;
  }

  // Delete each CSV file
  for (const file of csvFiles) {
    try {
      const filePath = path.join(mainImportDir, file);
      fs.unlinkSync(filePath);
      result.deleted.push(file);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push({ file, error: errorMsg });
    }
  }

  return result;
}
