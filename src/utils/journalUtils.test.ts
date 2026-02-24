import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractDateFromPriceLine, updatePriceJournal } from './journalUtils.ts';

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
});
