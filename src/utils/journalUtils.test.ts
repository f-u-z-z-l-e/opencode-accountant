import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractDateFromPriceLine, updatePriceJournal, findCsvFiles } from './journalUtils.ts';

describe('journalUtils', () => {
  const testDir = path.join(process.cwd(), '.memory', 'test-journalUtils');
  const testJournal = path.join(testDir, 'test-prices.journal');

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

  describe('extractDateFromPriceLine', () => {
    it('should extract date from price line with timestamp', () => {
      const line = 'P 2025-02-17 00:00:00 EUR 0.944 CHF';
      expect(extractDateFromPriceLine(line)).toBe('2025-02-17');
    });

    it('should extract date from price line without timestamp', () => {
      const line = 'P 2025-02-17 EUR 0.944 CHF';
      expect(extractDateFromPriceLine(line)).toBe('2025-02-17');
    });

    it('should return second field for any space-separated line', () => {
      const line = 'invalid line';
      expect(extractDateFromPriceLine(line)).toBe('line');
    });

    it('should return undefined for single word line', () => {
      const line = 'onlyoneword';
      expect(extractDateFromPriceLine(line)).toBeUndefined();
    });

    it('should return undefined for empty line', () => {
      const line = '';
      expect(extractDateFromPriceLine(line)).toBeUndefined();
    });
  });

  describe('updatePriceJournal', () => {
    it('should create new journal file with price lines', () => {
      const priceLines = [
        'P 2025-02-17 00:00:00 EUR 0.944 CHF',
        'P 2025-02-18 00:00:00 EUR 0.945 CHF',
      ];

      updatePriceJournal(testJournal, priceLines);

      expect(fs.existsSync(testJournal)).toBe(true);
      const content = fs.readFileSync(testJournal, 'utf-8');
      expect(content).toBe(
        'P 2025-02-17 00:00:00 EUR 0.944 CHF\nP 2025-02-18 00:00:00 EUR 0.945 CHF\n'
      );
    });

    it('should merge with existing journal file', () => {
      // Create initial journal
      fs.writeFileSync(
        testJournal,
        'P 2025-02-15 00:00:00 EUR 0.942 CHF\nP 2025-02-16 00:00:00 EUR 0.943 CHF\n'
      );

      // Add new prices
      const newPriceLines = ['P 2025-02-17 00:00:00 EUR 0.944 CHF'];
      updatePriceJournal(testJournal, newPriceLines);

      const content = fs.readFileSync(testJournal, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('P 2025-02-15 00:00:00 EUR 0.942 CHF');
      expect(lines[1]).toBe('P 2025-02-16 00:00:00 EUR 0.943 CHF');
      expect(lines[2]).toBe('P 2025-02-17 00:00:00 EUR 0.944 CHF');
    });

    it('should deduplicate by date (new overrides old)', () => {
      // Create initial journal
      fs.writeFileSync(testJournal, 'P 2025-02-17 00:00:00 EUR 0.940 CHF\n');

      // Update with the new price for the same date
      const newPriceLines = ['P 2025-02-17 00:00:00 EUR 0.950 CHF'];
      updatePriceJournal(testJournal, newPriceLines);

      const content = fs.readFileSync(testJournal, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('P 2025-02-17 00:00:00 EUR 0.950 CHF');
    });

    it('should sort price lines chronologically', () => {
      const priceLines = [
        'P 2025-02-20 00:00:00 EUR 0.945 CHF',
        'P 2025-02-18 00:00:00 EUR 0.943 CHF',
        'P 2025-02-19 00:00:00 EUR 0.944 CHF',
      ];

      updatePriceJournal(testJournal, priceLines);

      const content = fs.readFileSync(testJournal, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines[0]).toContain('2025-02-18');
      expect(lines[1]).toContain('2025-02-19');
      expect(lines[2]).toContain('2025-02-20');
    });

    it('should handle empty new price lines array', () => {
      // Create initial journal
      fs.writeFileSync(testJournal, 'P 2025-02-17 00:00:00 EUR 0.944 CHF\n');

      // Update with an empty array
      updatePriceJournal(testJournal, []);

      const content = fs.readFileSync(testJournal, 'utf-8');
      expect(content).toBe('P 2025-02-17 00:00:00 EUR 0.944 CHF\n');
    });

    it('should preserve format of existing lines', () => {
      // Create a journal with different formats
      fs.writeFileSync(
        testJournal,
        'P 2025-02-15 EUR 0.942 CHF\nP 2025-02-16 00:00:00 EUR 0.943 CHF\n'
      );

      const newPriceLines = ['P 2025-02-17 12:30:45 EUR 0.944 CHF'];
      updatePriceJournal(testJournal, newPriceLines);

      const content = fs.readFileSync(testJournal, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines[0]).toBe('P 2025-02-15 EUR 0.942 CHF');
      expect(lines[1]).toBe('P 2025-02-16 00:00:00 EUR 0.943 CHF');
      expect(lines[2]).toBe('P 2025-02-17 12:30:45 EUR 0.944 CHF');
    });

    it('should add trailing newline', () => {
      const priceLines = ['P 2025-02-17 00:00:00 EUR 0.944 CHF'];
      updatePriceJournal(testJournal, priceLines);

      const content = fs.readFileSync(testJournal, 'utf-8');
      expect(content.endsWith('\n')).toBe(true);
    });

    it('should handle journal with blank lines', () => {
      // Create a journal with blank lines
      fs.writeFileSync(testJournal, 'P 2025-02-15 00:00:00 EUR 0.942 CHF\n\n\n');

      const newPriceLines = ['P 2025-02-16 00:00:00 EUR 0.943 CHF'];
      updatePriceJournal(testJournal, newPriceLines);

      const content = fs.readFileSync(testJournal, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('P 2025-02-15 00:00:00 EUR 0.942 CHF');
      expect(lines[1]).toBe('P 2025-02-16 00:00:00 EUR 0.943 CHF');
    });
  });

  describe('findCsvFiles', () => {
    const csvTestDir = path.join(testDir, 'csv-files');

    beforeEach(() => {
      if (fs.existsSync(csvTestDir)) {
        fs.rmSync(csvTestDir, { recursive: true, force: true });
      }
      fs.mkdirSync(csvTestDir, { recursive: true });
    });

    it('should return empty array when directory does not exist', () => {
      const nonExistentDir = path.join(csvTestDir, 'does-not-exist');
      const result = findCsvFiles(nonExistentDir);
      expect(result).toEqual([]);
    });

    it('should return empty array when directory is empty', () => {
      const result = findCsvFiles(csvTestDir);
      expect(result).toEqual([]);
    });

    it('should find CSV files in root directory', () => {
      fs.writeFileSync(path.join(csvTestDir, 'file1.csv'), 'data');
      fs.writeFileSync(path.join(csvTestDir, 'file2.csv'), 'data');
      fs.writeFileSync(path.join(csvTestDir, 'notcsv.txt'), 'data');

      const result = findCsvFiles(csvTestDir);
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('file1.csv');
      expect(result[1]).toContain('file2.csv');
    });

    it('should find CSV files recursively in subdirectories', () => {
      const subDir1 = path.join(csvTestDir, 'sub1');
      const subDir2 = path.join(csvTestDir, 'sub2');
      fs.mkdirSync(subDir1, { recursive: true });
      fs.mkdirSync(subDir2, { recursive: true });

      fs.writeFileSync(path.join(csvTestDir, 'root.csv'), 'data');
      fs.writeFileSync(path.join(subDir1, 'file1.csv'), 'data');
      fs.writeFileSync(path.join(subDir2, 'file2.csv'), 'data');

      const result = findCsvFiles(csvTestDir);
      expect(result).toHaveLength(3);
      expect(result.some((f) => f.includes('root.csv'))).toBe(true);
      expect(result.some((f) => f.includes('file1.csv'))).toBe(true);
      expect(result.some((f) => f.includes('file2.csv'))).toBe(true);
    });

    it('should return sorted file paths', () => {
      fs.writeFileSync(path.join(csvTestDir, 'zebra.csv'), 'data');
      fs.writeFileSync(path.join(csvTestDir, 'alpha.csv'), 'data');
      fs.writeFileSync(path.join(csvTestDir, 'beta.csv'), 'data');

      const result = findCsvFiles(csvTestDir);
      expect(result).toHaveLength(3);
      expect(result[0]).toContain('alpha.csv');
      expect(result[1]).toContain('beta.csv');
      expect(result[2]).toContain('zebra.csv');
    });

    it('should filter by provider when specified', () => {
      const providerDir = path.join(csvTestDir, 'revolut');
      fs.mkdirSync(providerDir, { recursive: true });
      fs.writeFileSync(path.join(providerDir, 'statement.csv'), 'data');
      fs.writeFileSync(path.join(csvTestDir, 'other.csv'), 'data');

      const result = findCsvFiles(csvTestDir, 'revolut');
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('revolut');
      expect(result[0]).toContain('statement.csv');
    });

    it('should filter by provider and currency when both specified', () => {
      const providerCurrencyDir = path.join(csvTestDir, 'ubs', 'chf');
      const providerOtherDir = path.join(csvTestDir, 'ubs', 'eur');
      fs.mkdirSync(providerCurrencyDir, { recursive: true });
      fs.mkdirSync(providerOtherDir, { recursive: true });

      fs.writeFileSync(path.join(providerCurrencyDir, 'chf-statement.csv'), 'data');
      fs.writeFileSync(path.join(providerOtherDir, 'eur-statement.csv'), 'data');

      const result = findCsvFiles(csvTestDir, 'ubs', 'chf');
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('chf-statement.csv');
      expect(result[0]).not.toContain('eur-statement.csv');
    });

    it('should return empty array when provider filter does not match', () => {
      fs.writeFileSync(path.join(csvTestDir, 'file.csv'), 'data');

      const result = findCsvFiles(csvTestDir, 'nonexistent-provider');
      expect(result).toEqual([]);
    });

    it('should return empty array when currency filter does not match', () => {
      const providerDir = path.join(csvTestDir, 'revolut');
      fs.mkdirSync(providerDir, { recursive: true });
      fs.writeFileSync(path.join(providerDir, 'file.csv'), 'data');

      const result = findCsvFiles(csvTestDir, 'revolut', 'nonexistent-currency');
      expect(result).toEqual([]);
    });

    it('should find files in deeply nested provider/currency structure', () => {
      const deepDir = path.join(csvTestDir, 'ubs', 'chf', 'subdir');
      fs.mkdirSync(deepDir, { recursive: true });
      fs.writeFileSync(path.join(deepDir, 'nested.csv'), 'data');

      const result = findCsvFiles(csvTestDir, 'ubs', 'chf');
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('nested.csv');
    });

    it('should ignore non-CSV files even when filtering', () => {
      const providerDir = path.join(csvTestDir, 'revolut');
      fs.mkdirSync(providerDir, { recursive: true });
      fs.writeFileSync(path.join(providerDir, 'statement.csv'), 'data');
      fs.writeFileSync(path.join(providerDir, 'readme.txt'), 'data');
      fs.writeFileSync(path.join(providerDir, 'rules.rules'), 'data');

      const result = findCsvFiles(csvTestDir, 'revolut');
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('statement.csv');
    });

    it('should handle directory with only subdirectories and no CSV files', () => {
      const emptySubDir = path.join(csvTestDir, 'empty-provider', 'empty-currency');
      fs.mkdirSync(emptySubDir, { recursive: true });

      const result = findCsvFiles(csvTestDir, 'empty-provider', 'empty-currency');
      expect(result).toEqual([]);
    });

    it('should handle case-sensitive file extensions', () => {
      fs.writeFileSync(path.join(csvTestDir, 'lowercase.csv'), 'data');
      fs.writeFileSync(path.join(csvTestDir, 'uppercase.CSV'), 'data');

      const result = findCsvFiles(csvTestDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('lowercase.csv');
    });
  });
});
