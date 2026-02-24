import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { findCSVFiles, ensureDirectory } from './fileUtils.ts';

describe('fileUtils', () => {
  const testDir = path.join(process.cwd(), '.memory', 'test-fileUtils');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('findCSVFiles', () => {
    it('should return empty array for non-existent directory', () => {
      const result = findCSVFiles(path.join(testDir, 'nonexistent'));
      expect(result).toEqual([]);
    });

    it('should return empty array for empty directory', () => {
      const result = findCSVFiles(testDir);
      expect(result).toEqual([]);
    });

    it('should find only CSV files', () => {
      fs.writeFileSync(path.join(testDir, 'file1.csv'), 'data');
      fs.writeFileSync(path.join(testDir, 'file2.txt'), 'data');
      fs.writeFileSync(path.join(testDir, 'file3.csv'), 'data');

      const result = findCSVFiles(testDir);

      expect(result).toHaveLength(2);
      expect(result).toContain('file1.csv');
      expect(result).toContain('file3.csv');
      expect(result).not.toContain('file2.txt');
    });

    it('should find CSV files case-insensitively', () => {
      fs.writeFileSync(path.join(testDir, 'file1.CSV'), 'data');
      fs.writeFileSync(path.join(testDir, 'file2.Csv'), 'data');

      const result = findCSVFiles(testDir);

      expect(result).toHaveLength(2);
    });

    it('should filter out subdirectories', () => {
      fs.writeFileSync(path.join(testDir, 'file.csv'), 'data');
      fs.mkdirSync(path.join(testDir, 'subdir'));
      fs.writeFileSync(path.join(testDir, 'subdir', 'nested.csv'), 'data');

      const result = findCSVFiles(testDir);

      expect(result).toHaveLength(1);
      expect(result).toContain('file.csv');
    });
  });

  describe('ensureDirectory', () => {
    it('should create directory recursively', () => {
      const newDir = path.join(testDir, 'nested', 'deep', 'directory');

      ensureDirectory(newDir);

      expect(fs.existsSync(newDir)).toBe(true);
    });

    it('should not fail if directory already exists', () => {
      const existingDir = path.join(testDir, 'existing');
      fs.mkdirSync(existingDir);

      expect(() => ensureDirectory(existingDir)).not.toThrow();
    });

    it('should create parent directories as needed', () => {
      const nestedDir = path.join(testDir, 'parent', 'child');

      ensureDirectory(nestedDir);

      expect(fs.existsSync(nestedDir)).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'parent'))).toBe(true);
    });
  });
});
