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
