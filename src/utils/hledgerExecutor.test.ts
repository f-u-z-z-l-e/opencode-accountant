import { describe, it, expect, vi } from 'vitest';
import {
  parseUnknownPostings,
  countTransactions,
  extractTransactionYears,
  validateLedger,
  getLastTransactionDate,
  getAccountBalance,
  type HledgerExecutor,
} from './hledgerExecutor.ts';

describe('hledgerExecutor', () => {
  describe('parseUnknownPostings', () => {
    it('parses unknown income postings', () => {
      const output = `
2026-01-16 Kaeser, Joel
    income:unknown                 CHF-95.25 = CHF4746.23
    assets:bank:ubs:checking        CHF95.25
`;
      const result = parseUnknownPostings(output);
      expect(result).toEqual([
        {
          date: '2026-01-16',
          description: 'Kaeser, Joel',
          amount: 'CHF-95.25',
          account: 'income:unknown',
          balance: 'CHF4746.23',
        },
      ]);
    });

    it('parses unknown expense postings', () => {
      const output = `
2026-01-20 Some Store
    expenses:unknown               CHF10.00 = CHF2364.69
    assets:bank:ubs:checking       CHF-10.00
`;
      const result = parseUnknownPostings(output);
      expect(result).toEqual([
        {
          date: '2026-01-20',
          description: 'Some Store',
          amount: 'CHF10.00',
          account: 'expenses:unknown',
          balance: 'CHF2364.69',
        },
      ]);
    });

    it('parses multiple unknown postings', () => {
      const output = `
2026-01-16 Kaeser, Joel
    income:unknown                 CHF-95.25 = CHF4746.23
    assets:bank:ubs:checking        CHF95.25

2026-01-20 Some Store
    expenses:unknown               CHF10.00 = CHF2364.69
    assets:bank:ubs:checking       CHF-10.00
`;
      const result = parseUnknownPostings(output);
      expect(result).toHaveLength(2);
    });

    it('returns empty array for empty output', () => {
      const result = parseUnknownPostings('');
      expect(result).toEqual([]);
    });

    it('ignores known account postings', () => {
      const output = `
2026-01-16 Known Transaction
    expenses:groceries              CHF50.00
    assets:bank:ubs:checking       CHF-50.00
`;
      const result = parseUnknownPostings(output);
      expect(result).toEqual([]);
    });
  });

  describe('countTransactions', () => {
    it('counts single transaction', () => {
      const output = `
2026-01-16 Transaction 1
    income:unknown                 CHF-95.25
    assets:bank:ubs:checking        CHF95.25
`;
      expect(countTransactions(output)).toBe(1);
    });

    it('counts multiple transactions', () => {
      const output = `
2026-01-16 Transaction 1
    income:unknown                 CHF-95.25
    assets:bank:ubs:checking        CHF95.25

2026-01-20 Transaction 2
    expenses:unknown               CHF10.00
    assets:bank:ubs:checking       CHF-10.00

2026-01-25 Transaction 3
    expenses:groceries             CHF30.00
    assets:bank:ubs:checking       CHF-30.00
`;
      expect(countTransactions(output)).toBe(3);
    });

    it('returns 0 for empty output', () => {
      expect(countTransactions('')).toBe(0);
    });

    it('returns 0 for output with no transactions', () => {
      const output = `
    Some posting without date
    Another line
`;
      expect(countTransactions(output)).toBe(0);
    });
  });

  describe('extractTransactionYears', () => {
    it('extracts single year', () => {
      const output = `
2026-01-16 Transaction 1
    income:unknown                 CHF-95.25
    assets:bank:ubs:checking        CHF95.25
`;
      const years = extractTransactionYears(output);
      expect(years).toEqual(new Set([2026]));
    });

    it('extracts multiple years', () => {
      const output = `
2025-12-31 Transaction 1
    income:unknown                 CHF-95.25
    assets:bank:ubs:checking        CHF95.25

2026-01-16 Transaction 2
    expenses:unknown               CHF10.00
    assets:bank:ubs:checking       CHF-10.00

2027-06-01 Transaction 3
    expenses:groceries             CHF30.00
    assets:bank:ubs:checking       CHF-30.00
`;
      const years = extractTransactionYears(output);
      expect(years).toEqual(new Set([2025, 2026, 2027]));
    });

    it('returns empty set for empty output', () => {
      const years = extractTransactionYears('');
      expect(years).toEqual(new Set());
    });
  });

  describe('validateLedger', () => {
    it('returns valid when both commands succeed', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: 'Success',
        stderr: '',
        exitCode: 0,
      });

      const result = await validateLedger('/path/to/.hledger.journal', mockExecutor);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(mockExecutor).toHaveBeenCalledTimes(2);
    });

    it('returns invalid when check fails', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'check') {
          return {
            stdout: '',
            stderr: 'Balance assertion failed',
            exitCode: 1,
          };
        }
        return { stdout: 'Success', stderr: '', exitCode: 0 };
      });

      const result = await validateLedger('/path/to/.hledger.journal', mockExecutor);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('hledger check --strict failed');
    });

    it('returns invalid when bal fails', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'bal') {
          return {
            stdout: '',
            stderr: 'Parse error',
            exitCode: 1,
          };
        }
        return { stdout: 'Success', stderr: '', exitCode: 0 };
      });

      const result = await validateLedger('/path/to/.hledger.journal', mockExecutor);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('hledger bal failed');
    });

    it('returns both errors when both commands fail', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'Error',
        exitCode: 1,
      });

      const result = await validateLedger('/path/to/.hledger.journal', mockExecutor);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('getLastTransactionDate', () => {
    it('returns last transaction date from register output', async () => {
      const csvOutput = `"txnidx","date","code","description","account","amount","total"
"1","2026-01-15","","First Transaction","assets:bank:ubs:checking","CHF 100.00","CHF 100.00"
"2","2026-01-20","","Second Transaction","assets:bank:ubs:checking","CHF 50.00","CHF 150.00"
"3","2026-01-31","","Last Transaction","assets:bank:ubs:checking","CHF -25.00","CHF 125.00"`;

      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: csvOutput,
        stderr: '',
        exitCode: 0,
      });

      const result = await getLastTransactionDate(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        mockExecutor
      );

      expect(result).toBe('2026-01-31');
      expect(mockExecutor).toHaveBeenCalledWith([
        'register',
        'assets:bank:ubs:checking',
        '-f',
        '/path/to/.hledger.journal',
        '-O',
        'csv',
      ]);
    });

    it('handles empty register output', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await getLastTransactionDate(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        mockExecutor
      );

      expect(result).toBeNull();
    });

    it('handles only header in output', async () => {
      const csvOutput = `"txnidx","date","code","description","account","amount","total"`;

      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: csvOutput,
        stderr: '',
        exitCode: 0,
      });

      const result = await getLastTransactionDate(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        mockExecutor
      );

      expect(result).toBeNull();
    });

    it('parses CSV format correctly', async () => {
      const csvOutput = `"txnidx","date","code","description","account","amount","total"
"1","2026-02-24","","Test Transaction","assets:bank:ubs:checking","CHF 100.00","CHF 100.00"`;

      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: csvOutput,
        stderr: '',
        exitCode: 0,
      });

      const result = await getLastTransactionDate(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        mockExecutor
      );

      expect(result).toBe('2026-02-24');
    });

    it('handles hledger execution errors', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'Account not found',
        exitCode: 1,
      });

      const result = await getLastTransactionDate(
        '/path/to/.hledger.journal',
        'assets:bank:invalid',
        mockExecutor
      );

      expect(result).toBeNull();
    });

    it('uses provided executor for dependency injection', async () => {
      const customExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: `"txnidx","date","code","description","account","amount","total"
"1","2026-01-15","","Test","assets:bank:ubs:checking","CHF 100.00","CHF 100.00"`,
        stderr: '',
        exitCode: 0,
      });

      const result = await getLastTransactionDate(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        customExecutor
      );

      expect(result).toBe('2026-01-15');
      expect(customExecutor).toHaveBeenCalled();
    });
  });

  describe('getAccountBalance', () => {
    it('returns balance for account as of date', async () => {
      const balOutput = `                CHF 2324.79  assets:bank:ubs:checking`;

      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: balOutput,
        stderr: '',
        exitCode: 0,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        '2026-01-31',
        mockExecutor
      );

      expect(result).toBe('CHF 2324.79');
      expect(mockExecutor).toHaveBeenCalledWith([
        'bal',
        'assets:bank:ubs:checking',
        '-f',
        '/path/to/.hledger.journal',
        '-e',
        '2026-02-01', // Next day after 2026-01-31
        '-N',
        '--flat',
      ]);
    });

    it('uses next day for exclusive end date', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: 'CHF 100.00  assets:bank:ubs:checking',
        stderr: '',
        exitCode: 0,
      });

      await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        '2026-01-31',
        mockExecutor
      );

      expect(mockExecutor).toHaveBeenCalledWith(expect.arrayContaining(['-e', '2026-02-01']));
    });

    it('handles zero balance', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        '2026-01-31',
        mockExecutor
      );

      expect(result).toBe('0');
    });

    it('handles no balance output', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:new:account',
        '2026-01-31',
        mockExecutor
      );

      expect(result).toBe('0');
    });

    it('extracts balance from formatted output', async () => {
      const balOutput = `                EUR 1234.56  assets:bank:ubs:checking`;

      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: balOutput,
        stderr: '',
        exitCode: 0,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        '2026-01-31',
        mockExecutor
      );

      expect(result).toBe('EUR 1234.56');
    });

    it('handles hledger execution errors', async () => {
      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'Error',
        exitCode: 1,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:invalid',
        '2026-01-31',
        mockExecutor
      );

      expect(result).toBeNull();
    });

    it('uses provided executor for dependency injection', async () => {
      const customExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: 'CHF 500.00  assets:bank:ubs:checking',
        stderr: '',
        exitCode: 0,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        '2026-01-31',
        customExecutor
      );

      expect(result).toBe('CHF 500.00');
      expect(customExecutor).toHaveBeenCalled();
    });

    it('handles negative balance', async () => {
      const balOutput = `                CHF -100.50  assets:bank:ubs:checking`;

      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: balOutput,
        stderr: '',
        exitCode: 0,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        '2026-01-31',
        mockExecutor
      );

      expect(result).toBe('CHF -100.50');
    });

    it('handles balance with large spacing', async () => {
      const balOutput = `                          CHF 999999.99  assets:bank:ubs:checking`;

      const mockExecutor: HledgerExecutor = vi.fn().mockResolvedValue({
        stdout: balOutput,
        stderr: '',
        exitCode: 0,
      });

      const result = await getAccountBalance(
        '/path/to/.hledger.journal',
        'assets:bank:ubs:checking',
        '2026-01-31',
        mockExecutor
      );

      expect(result).toBe('CHF 999999.99');
    });
  });
});
