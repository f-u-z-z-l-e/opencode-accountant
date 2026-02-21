import { describe, it, expect } from 'vitest';
import { detectProvider, classifyFiles } from './providerDetector.ts';
import type { ImportConfig } from './importConfig.ts';

describe('providerDetector', () => {
  const mockConfig: ImportConfig = {
    paths: {
      imports: 'statements/imports',
      pending: 'doc/agent/todo/import',
      done: 'doc/agent/done/import',
      unrecognized: 'statements/imports/unrecognized',
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

  describe('detectProvider', () => {
    it('should detect Revolut CHF account', () => {
      const filename = 'account-statement_2023-06-12_2026-02-11_en-us_c533c6.csv';
      const content = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12 10:00:00,2023-06-12 10:00:00,Initial deposit,1000.00,0.00,CHF,COMPLETED,1000.00`;

      const result = detectProvider(filename, content, mockConfig);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('revolut');
      expect(result!.currency).toBe('chf');
    });

    it('should detect Revolut EUR account', () => {
      const filename = 'account-statement_2024-01-19_2026-02-11_en-us_122682.csv';
      const content = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Transfer,Current,2024-01-19 10:00:00,2024-01-19 10:00:00,Transfer,500.00,0.00,EUR,COMPLETED,500.00`;

      const result = detectProvider(filename, content, mockConfig);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('revolut');
      expect(result!.currency).toBe('eur');
    });

    it('should detect Revolut crypto BTC account', () => {
      const filename = 'crypto-account-statement_2024-08-12_2026-02-11_en-us_496a6e.csv';
      const content = `Symbol,Type,Quantity,Price,Value,Fees,Date
BTC,Buy,0.001,50000.00,50.00,0.50,"Jan 21, 2025, 12:12:16 PM"`;

      const result = detectProvider(filename, content, mockConfig);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('revolut');
      expect(result!.currency).toBe('btc');
    });

    it('should return null for non-matching filename', () => {
      const filename = 'unknown-bank-export.csv';
      const content = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12 10:00:00,2023-06-12 10:00:00,Initial deposit,1000.00,0.00,CHF,COMPLETED,1000.00`;

      const result = detectProvider(filename, content, mockConfig);

      expect(result).toBeNull();
    });

    it('should return null for matching filename but non-matching header', () => {
      const filename = 'account-statement_2023-06-12_2026-02-11_en-us_c533c6.csv';
      const content = `Date,Description,Amount,Balance
2023-06-12,Initial deposit,1000.00,1000.00`;

      const result = detectProvider(filename, content, mockConfig);

      expect(result).toBeNull();
    });

    it('should return null for empty CSV content', () => {
      const filename = 'account-statement_2023-06-12_2026-02-11_en-us_c533c6.csv';
      const content = '';

      const result = detectProvider(filename, content, mockConfig);

      expect(result).toBeNull();
    });

    it('should handle unmapped currency by lowercasing', () => {
      const configWithLimitedCurrencies: ImportConfig = {
        ...mockConfig,
        providers: {
          revolut: {
            ...mockConfig.providers.revolut,
            currencies: {
              CHF: 'chf',
              // EUR is not mapped
            },
          },
        },
      };

      const filename = 'account-statement_2024-01-19_2026-02-11_en-us_122682.csv';
      const content = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Transfer,Current,2024-01-19 10:00:00,2024-01-19 10:00:00,Transfer,500.00,0.00,EUR,COMPLETED,500.00`;

      const result = detectProvider(filename, content, configWithLimitedCurrencies);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('revolut');
      expect(result!.currency).toBe('eur'); // Lowercased because not in mapping
    });
  });

  describe('classifyFiles', () => {
    it('should classify multiple files', () => {
      const files = [
        {
          filename: 'account-statement_2023-06-12_2026-02-11_en-us_c533c6.csv',
          content: `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12 10:00:00,2023-06-12 10:00:00,Initial deposit,1000.00,0.00,CHF,COMPLETED,1000.00`,
        },
        {
          filename: 'unknown-bank.csv',
          content: `Date,Amount
2023-06-12,100`,
        },
      ];

      const results = classifyFiles(files, mockConfig);

      expect(results).toHaveLength(2);
      expect(results[0].detected).not.toBeNull();
      expect(results[0].detected!.currency).toBe('chf');
      expect(results[1].detected).toBeNull();
    });

    it('should handle errors gracefully', () => {
      const files = [
        {
          filename: 'account-statement_test.csv',
          content: `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12,2023-06-12,Test,100,0,CHF,COMPLETED,100`,
        },
      ];

      const results = classifyFiles(files, mockConfig);

      // Should not throw, should return result with detected value
      expect(results).toHaveLength(1);
      expect(results[0].error).toBeUndefined();
    });
  });
});
