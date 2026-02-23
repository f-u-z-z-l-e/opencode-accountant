import { describe, it, expect } from 'vitest';
import { detectProvider, classifyFiles } from './providerDetector.ts';
import type { ImportConfig } from './importConfig.ts';

describe('providerDetector', () => {
  const mockConfig: ImportConfig = {
    paths: {
      import: 'statements/import',
      pending: 'doc/agent/todo/import',
      done: 'doc/agent/done/import',
      unrecognized: 'statements/import/unrecognized',
      rules: 'config/import/rules',
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

    it('should detect provider with header-only matching (no filenamePattern)', () => {
      const headerOnlyConfig: ImportConfig = {
        ...mockConfig,
        providers: {
          testbank: {
            detect: [
              {
                // No filenamePattern - header-only matching
                header: 'Date,Description,Amount,Currency',
                currencyField: 'Currency',
              },
            ],
            currencies: {
              CHF: 'chf',
            },
          },
        },
      };

      const filename = 'any-random-filename.csv';
      const content = `Date,Description,Amount,Currency
2023-06-12,Test transaction,100.00,CHF`;

      const result = detectProvider(filename, content, headerOnlyConfig);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('testbank');
      expect(result!.currency).toBe('chf');
    });

    it('should handle skipRows and custom delimiter', () => {
      const configWithSkipRows: ImportConfig = {
        ...mockConfig,
        providers: {
          bankwithmetadata: {
            detect: [
              {
                header: 'Date,Description,Amount,Currency',
                currencyField: 'Currency',
                skipRows: 3,
                delimiter: ';',
              },
            ],
            currencies: {
              CHF: 'chf',
            },
          },
        },
      };

      const filename = 'export.csv';
      const content = `Account:;12345;
From:;2024-01-01;
To:;2024-12-31;
Date;Description;Amount;Currency
2024-01-15;Test;100.00;CHF`;

      const result = detectProvider(filename, content, configWithSkipRows);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('bankwithmetadata');
      expect(result!.currency).toBe('chf');
    });

    it('should extract metadata and generate outputFilename', () => {
      const configWithMetadata: ImportConfig = {
        ...mockConfig,
        providers: {
          bankwithmetadata: {
            detect: [
              {
                header: 'Date,Description,Amount,Currency',
                currencyField: 'Currency',
                skipRows: 3,
                delimiter: ';',
                renamePattern: 'transactions-bank-{accountnumber}.csv',
                metadata: [
                  {
                    field: 'accountnumber',
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

      const filename = 'export.csv';
      const content = `Account:;1234 56789.0;
From:;2024-01-01;
To:;2024-12-31;
Date;Description;Amount;Currency
2024-01-15;Test;100.00;CHF`;

      const result = detectProvider(filename, content, configWithMetadata);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('bankwithmetadata');
      expect(result!.currency).toBe('chf');
      expect(result!.metadata).toEqual({ accountnumber: '1234-56789.0' });
      expect(result!.outputFilename).toBe('transactions-bank-1234-56789.0.csv');
    });

    it('should handle metadata extraction without normalization', () => {
      const configWithMetadata: ImportConfig = {
        ...mockConfig,
        providers: {
          bankwithmetadata: {
            detect: [
              {
                header: 'Date,Description,Amount,Currency',
                currencyField: 'Currency',
                skipRows: 2,
                delimiter: ';',
                renamePattern: 'export-{iban}.csv',
                metadata: [
                  {
                    field: 'iban',
                    row: 1,
                    column: 1,
                  },
                ],
              },
            ],
            currencies: {
              EUR: 'eur',
            },
          },
        },
      };

      const filename = 'bank-export.csv';
      const content = `Account:;12345;
IBAN:;CH12 3456 7890;
Date;Description;Amount;Currency
2024-01-15;Test;100.00;EUR`;

      const result = detectProvider(filename, content, configWithMetadata);

      expect(result).not.toBeNull();
      expect(result!.metadata).toEqual({ iban: 'CH12 3456 7890' });
      expect(result!.outputFilename).toBe('export-CH12 3456 7890.csv');
    });

    it('should return undefined outputFilename when no renamePattern is set', () => {
      const filename = 'account-statement_2023-06-12_2026-02-11_en-us_c533c6.csv';
      const content = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Deposit,Current,2023-06-12 10:00:00,2023-06-12 10:00:00,Initial deposit,1000.00,0.00,CHF,COMPLETED,1000.00`;

      const result = detectProvider(filename, content, mockConfig);

      expect(result).not.toBeNull();
      expect(result!.outputFilename).toBeUndefined();
      expect(result!.metadata).toBeUndefined();
    });

    it('should extract multiple metadata fields including balance info (UBS-style)', () => {
      const configWithBalanceMetadata: ImportConfig = {
        ...mockConfig,
        providers: {
          ubsbank: {
            detect: [
              {
                header: 'Date,Description,Amount,Currency',
                currencyField: 'Currency',
                skipRows: 8,
                delimiter: ';',
                renamePattern: 'ubs-{account_number}-{from_date}-{until_date}.csv',
                metadata: [
                  { field: 'account_number', row: 0, column: 1, normalize: 'spaces-to-dashes' },
                  { field: 'iban', row: 1, column: 1 },
                  { field: 'from_date', row: 2, column: 1 },
                  { field: 'until_date', row: 3, column: 1 },
                  { field: 'opening_balance', row: 4, column: 1 },
                  { field: 'closing_balance', row: 5, column: 1 },
                  { field: 'currency', row: 6, column: 1 },
                ],
              },
            ],
            currencies: {
              CHF: 'chf',
            },
          },
        },
      };

      const filename = 'export.csv';
      const content = `Account number:;1234 56789012.3;
IBAN:;CH93 0076 2011 6238 5295 7;
From:;2026-01-05;
Until:;2026-01-31;
Opening balance:;1632.63;
Closing balance:;2324.79;
Valued in:;CHF;
Numbers of transactions in this period:;24;
Date;Description;Amount;Currency
2026-01-15;Test payment;-100.00;CHF`;

      const result = detectProvider(filename, content, configWithBalanceMetadata);

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('ubsbank');
      expect(result!.currency).toBe('chf');
      expect(result!.metadata).toEqual({
        account_number: '1234-56789012.3',
        iban: 'CH93 0076 2011 6238 5295 7',
        from_date: '2026-01-05',
        until_date: '2026-01-31',
        opening_balance: '1632.63',
        closing_balance: '2324.79',
        currency: 'CHF',
      });
      expect(result!.outputFilename).toBe('ubs-1234-56789012.3-2026-01-05-2026-01-31.csv');
    });

    it('should fail to match when CSV header has trailing delimiter (creates empty field)', () => {
      const configWithoutTrailingField: ImportConfig = {
        paths: {
          import: 'statements/import',
          pending: 'doc/agent/todo/import',
          done: 'doc/agent/done/import',
          unrecognized: 'statements/import/unrecognized',
          rules: 'config/import/rules',
        },
        providers: {
          testbank: {
            detect: [
              {
                // Header configured WITHOUT the trailing empty field
                header: 'Date,Description,Amount,Currency',
                currencyField: 'Currency',
                delimiter: ';',
              },
            ],
            currencies: {
              CHF: 'chf',
            },
          },
        },
      };

      const filename = 'test.csv';
      // CSV with trailing semicolon - this creates an empty field when parsed
      const content = `Date;Description;Amount;Currency;
2024-01-15;Test;100.00;CHF;`;

      const result = detectProvider(filename, content, configWithoutTrailingField);

      // Detection FAILS because the actual header becomes "Date,Description,Amount,Currency,"
      // (with trailing comma from empty field) but config expects "Date,Description,Amount,Currency"
      expect(result).toBeNull();
    });

    it('should match when config header includes trailing comma to account for trailing delimiter', () => {
      const configWithTrailingField: ImportConfig = {
        paths: {
          import: 'statements/import',
          pending: 'doc/agent/todo/import',
          done: 'doc/agent/done/import',
          unrecognized: 'statements/import/unrecognized',
          rules: 'config/import/rules',
        },
        providers: {
          testbank: {
            detect: [
              {
                // Header configured WITH the trailing empty field (trailing comma)
                header: 'Date,Description,Amount,Currency,',
                currencyField: 'Currency',
                delimiter: ';',
              },
            ],
            currencies: {
              CHF: 'chf',
            },
          },
        },
      };

      const filename = 'test.csv';
      // CSV with trailing semicolon - this creates an empty field when parsed
      const content = `Date;Description;Amount;Currency;
2024-01-15;Test;100.00;CHF;`;

      const result = detectProvider(filename, content, configWithTrailingField);

      // Detection SUCCEEDS because the config header has trailing comma to match the empty field
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('testbank');
      expect(result!.currency).toBe('chf');
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
