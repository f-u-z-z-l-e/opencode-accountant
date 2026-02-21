import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { classifyStatementsCore } from './classify-statements.ts';
import type { ImportConfig } from '../utils/importConfig.ts';

describe('classify-statements', () => {
  const testDir = path.join(process.cwd(), '.memory', 'test-classify-statements');

  const mockConfig: ImportConfig = {
    paths: {
      import: 'statements/import',
      pending: 'doc/agent/todo/import',
      done: 'doc/agent/done/import',
      unrecognized: 'statements/import/unrecognized',
    },
    providers: {
      revolut: {
        detect: [
          {
            filenamePattern: '^account-statement_',
            header:
              'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
            currencyField: 'Currency',
          },
          {
            filenamePattern: '^crypto-account-statement_',
            header: 'Symbol,Type,Quantity,Price,Value,Fees,Date',
            currencyField: 'Symbol',
          },
        ],
        currencies: {
          CHF: 'chf',
          EUR: 'eur',
          USD: 'usd',
          BTC: 'btc',
        },
      },
    },
  };

  const mockConfigLoader = () => mockConfig;

  beforeEach(() => {
    // Clean up and recreate test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(testDir, 'statements/import'), { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('agent restriction', () => {
    it('should reject non-accountant agents', async () => {
      const result = await classifyStatementsCore(testDir, 'user', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('This tool is restricted to the accountant agent only.');
      expect(parsed.caller).toBe('user');
    });

    it('should accept accountant agent', async () => {
      const result = await classifyStatementsCore(testDir, 'accountant', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
    });
  });

  describe('empty imports directory', () => {
    it('should return success with empty arrays when no CSV files', async () => {
      const result = await classifyStatementsCore(testDir, 'accountant', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.classified).toEqual([]);
      expect(parsed.unrecognized).toEqual([]);
    });
  });

  describe('file classification', () => {
    it('should classify Revolut CHF file correctly', async () => {
      const importsDir = path.join(testDir, 'statements/import');
      const filename = 'account-statement_2023-06-12_2026-02-11_en-us_c533c6.csv';
      fs.writeFileSync(
        path.join(importsDir, filename),
        `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12,2023-06-12,Test,100,0,CHF,COMPLETED,100`
      );

      const result = await classifyStatementsCore(testDir, 'accountant', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.classified).toHaveLength(1);
      expect(parsed.classified[0].provider).toBe('revolut');
      expect(parsed.classified[0].currency).toBe('chf');
      expect(parsed.unrecognized).toHaveLength(0);

      // Verify file was moved
      const targetPath = path.join(testDir, 'doc/agent/todo/import/revolut/chf', filename);
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.existsSync(path.join(importsDir, filename))).toBe(false);
    });

    it('should classify Revolut crypto BTC file correctly', async () => {
      const importsDir = path.join(testDir, 'statements/import');
      const filename = 'crypto-account-statement_2024-08-12_2026-02-11_en-us_496a6e.csv';
      fs.writeFileSync(
        path.join(importsDir, filename),
        `Symbol,Type,Quantity,Price,Value,Fees,Date
BTC,Buy,0.001,50000.00,50.00,0.50,"Jan 21, 2025"`
      );

      const result = await classifyStatementsCore(testDir, 'accountant', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.classified).toHaveLength(1);
      expect(parsed.classified[0].provider).toBe('revolut');
      expect(parsed.classified[0].currency).toBe('btc');

      // Verify file was moved
      const targetPath = path.join(testDir, 'doc/agent/todo/import/revolut/btc', filename);
      expect(fs.existsSync(targetPath)).toBe(true);
    });

    it('should move unrecognized files to unrecognized directory', async () => {
      const importsDir = path.join(testDir, 'statements/import');
      const filename = 'unknown-bank-export.csv';
      fs.writeFileSync(
        path.join(importsDir, filename),
        `Date,Description,Amount
2023-06-12,Test,100`
      );

      const result = await classifyStatementsCore(testDir, 'accountant', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.classified).toHaveLength(0);
      expect(parsed.unrecognized).toHaveLength(1);
      expect(parsed.unrecognized[0].filename).toBe(filename);

      // Verify file was moved to unrecognized
      const targetPath = path.join(testDir, 'statements/import/unrecognized', filename);
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.existsSync(path.join(importsDir, filename))).toBe(false);
    });

    it('should classify multiple files of different currencies', async () => {
      const importsDir = path.join(testDir, 'statements/import');

      fs.writeFileSync(
        path.join(importsDir, 'account-statement_chf.csv'),
        `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12,2023-06-12,Test,100,0,CHF,COMPLETED,100`
      );

      fs.writeFileSync(
        path.join(importsDir, 'account-statement_eur.csv'),
        `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Transfer,Current,2024-01-19,2024-01-19,Test,500,0,EUR,COMPLETED,500`
      );

      const result = await classifyStatementsCore(testDir, 'accountant', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.classified).toHaveLength(2);
      expect(parsed.summary.total).toBe(2);
      expect(parsed.summary.classified).toBe(2);
      expect(parsed.summary.unrecognized).toBe(0);

      // Verify files were moved to correct directories
      expect(
        fs.existsSync(
          path.join(testDir, 'doc/agent/todo/import/revolut/chf/account-statement_chf.csv')
        )
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(testDir, 'doc/agent/todo/import/revolut/eur/account-statement_eur.csv')
        )
      ).toBe(true);
    });
  });

  describe('pending files check', () => {
    it('should abort if pending files exist', async () => {
      // Create a pending file
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/revolut/chf');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(path.join(pendingDir, 'existing-pending.csv'), 'test');

      // Add a new file to imports
      const importsDir = path.join(testDir, 'statements/import');
      fs.writeFileSync(
        path.join(importsDir, 'account-statement_new.csv'),
        `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12,2023-06-12,Test,100,0,CHF,COMPLETED,100`
      );

      const result = await classifyStatementsCore(testDir, 'accountant', mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('pending file(s) that must be processed');
      expect(parsed.pendingFiles).toHaveLength(1);
      expect(parsed.pendingFiles[0].provider).toBe('revolut');
      expect(parsed.pendingFiles[0].currency).toBe('chf');
      expect(parsed.pendingFiles[0].filename).toBe('existing-pending.csv');

      // Verify the new file was NOT moved
      expect(fs.existsSync(path.join(importsDir, 'account-statement_new.csv'))).toBe(true);
    });
  });

  describe('file renaming', () => {
    it('should rename file when outputFilename is generated from metadata', async () => {
      const configWithRename: ImportConfig = {
        paths: {
          import: 'statements/import',
          pending: 'doc/agent/todo/import',
          done: 'doc/agent/done/import',
          unrecognized: 'statements/import/unrecognized',
        },
        providers: {
          testbank: {
            detect: [
              {
                header: 'Date,Description,Amount,Currency,Balance',
                currencyField: 'Currency',
                skipRows: 2,
                delimiter: ';',
                renamePattern: 'transactions-testbank-{accountid}.csv',
                metadata: [
                  {
                    field: 'accountid',
                    row: 0,
                    column: 1,
                    normalize: 'spaces-to-dashes',
                  },
                ],
              },
            ],
            currencies: {
              CHF: 'chf',
            },
          },
        },
      };

      const importsDir = path.join(testDir, 'statements/import');
      const originalFilename = 'export-12345.csv';
      // File with 2 metadata rows (semicolon-delimited), then header and data
      fs.writeFileSync(
        path.join(importsDir, originalFilename),
        `AccountID;1234 56789.0
ExportDate;2024-01-15
Date;Description;Amount;Currency;Balance
2024-01-15;Test transaction;100.00;CHF;1000.00`
      );

      const result = await classifyStatementsCore(testDir, 'accountant', () => configWithRename);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.classified).toHaveLength(1);
      expect(parsed.classified[0].filename).toBe('transactions-testbank-1234-56789.0.csv');
      expect(parsed.classified[0].originalFilename).toBe(originalFilename);
      expect(parsed.classified[0].provider).toBe('testbank');
      expect(parsed.classified[0].currency).toBe('chf');

      // Verify file was moved with new name
      const targetPath = path.join(
        testDir,
        'doc/agent/todo/import/testbank/chf',
        'transactions-testbank-1234-56789.0.csv'
      );
      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.existsSync(path.join(importsDir, originalFilename))).toBe(false);
    });
  });

  describe('config loading errors', () => {
    it('should return error when config loader throws', async () => {
      const failingConfigLoader = () => {
        throw new Error('Config file not found');
      };

      const result = await classifyStatementsCore(testDir, 'accountant', failingConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Config file not found');
    });
  });
});
