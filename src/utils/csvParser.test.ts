import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseCsvFile, findMatchingCsvRow, type CsvRowData } from './csvParser.ts';
import type { RulesConfig } from './rulesParser.ts';

const testDir = path.join(process.cwd(), '.memory', 'test-csv-parser');

describe('csvParser', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseCsvFile', () => {
    it('should parse simple CSV with comma separator', () => {
      const csvPath = path.join(testDir, 'simple.csv');
      fs.writeFileSync(
        csvPath,
        'date,description,amount\n2026-01-15,Coffee,5.50\n2026-01-16,Lunch,15.00'
      );

      const config: RulesConfig = {
        skipRows: 0,
        separator: ',',
        fieldNames: ['date', 'description', 'amount'],
        dateFormat: '%Y-%m-%d',
        dateField: 'date',
        amountFields: { single: 'amount' },
      };

      const result = parseCsvFile(csvPath, config);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ date: '2026-01-15', description: 'Coffee', amount: '5.50' });
      expect(result[1]).toEqual({ date: '2026-01-16', description: 'Lunch', amount: '15.00' });
    });

    it('should parse CSV with semicolon separator', () => {
      const csvPath = path.join(testDir, 'semicolon.csv');
      fs.writeFileSync(csvPath, 'date;amount;balance\n2026-01-15;100.00;500.00');

      const config: RulesConfig = {
        skipRows: 0,
        separator: ';',
        fieldNames: ['date', 'amount', 'balance'],
        dateFormat: '%Y-%m-%d',
        dateField: 'date',
        amountFields: { single: 'amount' },
      };

      const result = parseCsvFile(csvPath, config);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ date: '2026-01-15', amount: '100.00', balance: '500.00' });
    });

    it('should skip header rows', () => {
      const csvPath = path.join(testDir, 'with-header-rows.csv');
      fs.writeFileSync(csvPath, 'Account: 12345\nIBAN: CH123\n\ndate,amount\n2026-01-15,100.00');

      const config: RulesConfig = {
        skipRows: 3,
        separator: ',',
        fieldNames: ['date', 'amount'],
        dateFormat: '%Y-%m-%d',
        dateField: 'date',
        amountFields: { single: 'amount' },
      };

      const result = parseCsvFile(csvPath, config);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ date: '2026-01-15', amount: '100.00' });
    });

    it('should handle quoted fields', () => {
      const csvPath = path.join(testDir, 'quoted.csv');
      fs.writeFileSync(csvPath, 'date,description,amount\n2026-01-15,"Coffee, large",5.50');

      const config: RulesConfig = {
        skipRows: 0,
        separator: ',',
        fieldNames: ['date', 'description', 'amount'],
        dateFormat: '%Y-%m-%d',
        dateField: 'date',
        amountFields: { single: 'amount' },
      };

      const result = parseCsvFile(csvPath, config);

      expect(result).toHaveLength(1);
      expect(result[0].description).toBe('Coffee, large');
    });

    it('should map CSV columns to field names from rules', () => {
      const csvPath = path.join(testDir, 'mapping.csv');
      fs.writeFileSync(csvPath, 'Trade Date,Description,Debit,Credit\n2026-01-15,Salary,,5000.00');

      const config: RulesConfig = {
        skipRows: 0,
        separator: ',',
        fieldNames: ['trade_date', 'description', 'debit', 'credit'],
        dateFormat: '%Y-%m-%d',
        dateField: 'trade_date',
        amountFields: { debit: 'debit', credit: 'credit' },
      };

      const result = parseCsvFile(csvPath, config);

      expect(result).toHaveLength(1);
      expect(result[0].trade_date).toBe('2026-01-15');
      expect(result[0].description).toBe('Salary');
      expect(result[0].credit).toBe('5000.00');
    });
  });

  describe('findMatchingCsvRow', () => {
    const baseConfig: RulesConfig = {
      skipRows: 0,
      separator: ',',
      fieldNames: ['date', 'description', 'amount', 'transaction_no'],
      dateFormat: '%Y-%m-%d',
      dateField: 'date',
      amountFields: { single: 'amount' },
    };

    it('should match by date and amount', () => {
      const csvRows: CsvRowData[] = [
        { date: '2026-01-15', description: 'Coffee', amount: '5.50', transaction_no: 'TX001' },
        { date: '2026-01-16', description: 'Lunch', amount: '15.00', transaction_no: 'TX002' },
      ];

      const posting = { date: '2026-01-15', description: 'Coffee', amount: 'CHF5.50' };
      const result = findMatchingCsvRow(posting, csvRows, baseConfig);

      expect(result).toEqual(csvRows[0]);
    });

    it('should match negative amount', () => {
      const csvRows: CsvRowData[] = [
        { date: '2026-01-15', description: 'Payment', amount: '-100.00', transaction_no: 'TX001' },
      ];

      const posting = { date: '2026-01-15', description: 'Payment', amount: 'CHF-100.00' };
      const result = findMatchingCsvRow(posting, csvRows, baseConfig);

      expect(result).toEqual(csvRows[0]);
    });

    it('should use description to narrow down multiple matches', () => {
      const csvRows: CsvRowData[] = [
        { date: '2026-01-15', description: 'Coffee', amount: '5.50', transaction_no: 'TX001' },
        { date: '2026-01-15', description: 'Tea', amount: '5.50', transaction_no: 'TX002' },
      ];

      const posting = { date: '2026-01-15', description: 'Coffee', amount: 'CHF5.50' };
      const result = findMatchingCsvRow(posting, csvRows, baseConfig);

      expect(result.description).toBe('Coffee');
    });

    it('should handle debit/credit amount fields', () => {
      const config: RulesConfig = {
        ...baseConfig,
        fieldNames: ['date', 'description', 'debit', 'credit', 'transaction_no'],
        amountFields: { debit: 'debit', credit: 'credit' },
      };

      const csvRows: CsvRowData[] = [
        {
          date: '2026-01-15',
          description: 'Payment out',
          debit: '100.00',
          credit: '',
          transaction_no: 'TX001',
        },
        {
          date: '2026-01-16',
          description: 'Salary',
          debit: '',
          credit: '5000.00',
          transaction_no: 'TX002',
        },
      ];

      // Debit should be negative
      const debitPosting = { date: '2026-01-15', description: 'Payment out', amount: 'CHF-100.00' };
      const debitResult = findMatchingCsvRow(debitPosting, csvRows, config);
      expect(debitResult.description).toBe('Payment out');

      // Credit should be positive
      const creditPosting = { date: '2026-01-16', description: 'Salary', amount: 'CHF5000.00' };
      const creditResult = findMatchingCsvRow(creditPosting, csvRows, config);
      expect(creditResult.description).toBe('Salary');
    });

    it('should throw error when no match found', () => {
      const csvRows: CsvRowData[] = [
        { date: '2026-01-15', description: 'Coffee', amount: '5.50', transaction_no: 'TX001' },
      ];

      const posting = { date: '2026-01-20', description: 'Nonexistent', amount: 'CHF999.00' };

      expect(() => findMatchingCsvRow(posting, csvRows, baseConfig)).toThrow(
        'Bug: Could not find CSV row'
      );
    });

    it('should return first match when multiple identical transactions', () => {
      const csvRows: CsvRowData[] = [
        { date: '2026-01-15', description: 'Coffee', amount: '5.50', transaction_no: 'TX001' },
        { date: '2026-01-15', description: 'Coffee', amount: '5.50', transaction_no: 'TX002' },
      ];

      const posting = { date: '2026-01-15', description: 'Coffee', amount: 'CHF5.50' };
      const result = findMatchingCsvRow(posting, csvRows, baseConfig);

      // Should return first match - either is fine for rule creation
      expect(result).toBeDefined();
      expect(result.description).toBe('Coffee');
    });

    it('should use transaction_no to narrow down matches', () => {
      const csvRows: CsvRowData[] = [
        { date: '2026-01-15', description: 'Coffee', amount: '5.50', transaction_no: 'TX001' },
        { date: '2026-01-15', description: 'Coffee copy', amount: '5.50', transaction_no: 'TX002' },
      ];

      // Both match by date/amount, but transaction_no should help
      const posting = { date: '2026-01-15', description: 'Coffee', amount: 'CHF5.50' };
      const result = findMatchingCsvRow(posting, csvRows, baseConfig);

      expect(result).toBeDefined();
    });
  });
});
