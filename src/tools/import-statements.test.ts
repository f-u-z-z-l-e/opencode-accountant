import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { importStatementsCore } from './import-statements.ts';
import type { ImportConfig } from '../utils/importConfig.ts';
import type { HledgerExecutor, HledgerResult } from '../utils/hledgerExecutor.ts';

const testDir = path.join(process.cwd(), '.memory', 'test-import-statements');

const createMockConfig = (): ImportConfig => ({
  paths: {
    import: 'statements/import',
    pending: 'doc/agent/todo/import',
    done: 'doc/agent/done/import',
    unrecognized: 'statements/import/unrecognized',
    rules: 'ledger/rules',
  },
  providers: {
    ubs: {
      detect: [{ header: 'Account number', currencyField: 'Currency' }],
      currencies: { CHF: 'chf' },
    },
  },
});

const createMockHledgerExecutor = (responses: Map<string, HledgerResult>): HledgerExecutor => {
  return async (args: string[]): Promise<HledgerResult> => {
    // Create a key from the args to look up the response
    const key = args.join(' ');
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) {
        return response;
      }
    }
    return { stdout: '', stderr: 'No mock response configured', exitCode: 1 };
  };
};

describe('import-statements', () => {
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

  describe('agent restriction', () => {
    it('should reject calls from non-accountant agents', async () => {
      const result = await importStatementsCore(testDir, 'other-agent', {});
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('restricted to the accountant agent');
      expect(parsed.caller).toBe('other-agent');
    });

    it('should reject calls from main assistant', async () => {
      const result = await importStatementsCore(testDir, '', {});
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.caller).toBe('main assistant');
    });
  });

  describe('configuration', () => {
    it('should fail gracefully when config is missing', async () => {
      const mockConfigLoader = () => {
        throw new Error('Config file not found');
      };

      const result = await importStatementsCore(testDir, 'accountant', {}, mockConfigLoader);
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Failed to load configuration');
      expect(parsed.hint).toContain('rules');
    });
  });

  describe('check mode', () => {
    it('should return success with empty files when no CSVs found', async () => {
      // Set up directory structure without any CSV files
      const pendingDir = path.join(testDir, 'doc/agent/todo/import');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const result = await importStatementsCore(testDir, 'accountant', { checkOnly: true }, () =>
        createMockConfig()
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.files).toHaveLength(0);
      expect(parsed.summary.filesProcessed).toBe(0);
      expect(parsed.message).toContain('No CSV files found');
    });

    it('should report CSV without matching rules file', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      // Create CSV without matching rules file
      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'date,amount\n2026-01-01,100');

      const result = await importStatementsCore(testDir, 'accountant', { checkOnly: true }, () =>
        createMockConfig()
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].error).toContain('No matching rules file');
      expect(parsed.summary.filesWithoutRules).toBe(1);
    });

    it('should detect unknown postings in hledger output', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      // Create CSV and rules file
      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'date,amount\n2026-01-01,100');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}\nskip 1`);

      const hledgerOutput = `2026-01-16 Connor, John
    income:unknown                 CHF-95.25 = CHF4746.23
    assets:bank:ubs:checking        CHF95.25

2026-01-30 Balance closing of service prices
    expenses:unknown                CHF10.00 = CHF2364.69
    assets:bank:ubs:checking       CHF-10.00

2026-02-01 Salary Payment
    income:salary                   CHF5000.00
    assets:bank:ubs:checking       CHF-5000.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }]])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: true },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.summary.totalTransactions).toBe(3);
      expect(parsed.summary.matched).toBe(1);
      expect(parsed.summary.unknown).toBe(2);

      const unknowns = parsed.files[0].unknownPostings;
      expect(unknowns).toHaveLength(2);

      expect(unknowns[0].date).toBe('2026-01-16');
      expect(unknowns[0].description).toBe('Connor, John');
      expect(unknowns[0].account).toBe('income:unknown');

      expect(unknowns[1].date).toBe('2026-01-30');
      expect(unknowns[1].description).toBe('Balance closing of service prices');
      expect(unknowns[1].account).toBe('expenses:unknown');
    });

    it('should report success when all transactions match', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'date,amount\n2026-01-01,100');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}\nskip 1`);

      const hledgerOutput = `2026-02-01 Salary Payment
    income:salary                   CHF5000.00
    assets:bank:ubs:checking       CHF-5000.00

2026-02-02 Coffee Shop
    expenses:food:coffee            CHF5.50
    assets:bank:ubs:checking       CHF-5.50
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }]])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: true },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.summary.totalTransactions).toBe(2);
      expect(parsed.summary.matched).toBe(2);
      expect(parsed.summary.unknown).toBe(0);
      expect(parsed.message).toContain('Ready to import');
    });

    it('should filter by provider', async () => {
      const ubsDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const revolutDir = path.join(testDir, 'doc/agent/todo/import/revolut/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(ubsDir, { recursive: true });
      fs.mkdirSync(revolutDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      // Create CSVs for both providers
      const ubsCsv = path.join(ubsDir, 'ubs.csv');
      const revolutCsv = path.join(revolutDir, 'revolut.csv');
      fs.writeFileSync(ubsCsv, 'data');
      fs.writeFileSync(revolutCsv, 'data');

      // Create rules files
      fs.writeFileSync(path.join(rulesDir, 'ubs.rules'), `source ${ubsCsv}`);
      fs.writeFileSync(path.join(rulesDir, 'revolut.rules'), `source ${revolutCsv}`);

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          [
            'print',
            {
              stdout: '2026-01-01 Test\n    expenses:test  CHF1\n    assets:bank CHF-1',
              stderr: '',
              exitCode: 0,
            },
          ],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { provider: 'ubs', checkOnly: true },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.summary.filesProcessed).toBe(1);
      expect(parsed.files[0].csv).toContain('ubs');
    });

    it('should filter by provider and currency', async () => {
      const chfDir = path.join(testDir, 'doc/agent/todo/import/revolut/chf');
      const eurDir = path.join(testDir, 'doc/agent/todo/import/revolut/eur');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(chfDir, { recursive: true });
      fs.mkdirSync(eurDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const chfCsv = path.join(chfDir, 'chf.csv');
      const eurCsv = path.join(eurDir, 'eur.csv');
      fs.writeFileSync(chfCsv, 'data');
      fs.writeFileSync(eurCsv, 'data');

      fs.writeFileSync(path.join(rulesDir, 'chf.rules'), `source ${chfCsv}`);
      fs.writeFileSync(path.join(rulesDir, 'eur.rules'), `source ${eurCsv}`);

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          [
            'print',
            {
              stdout: '2026-01-01 Test\n    expenses:test  EUR1\n    assets:bank EUR-1',
              stderr: '',
              exitCode: 0,
            },
          ],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { provider: 'revolut', currency: 'eur', checkOnly: true },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.summary.filesProcessed).toBe(1);
      expect(parsed.files[0].csv).toContain('eur');
    });
  });

  describe('import mode', () => {
    it('should abort import if unknowns exist', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const hledgerOutput = `2026-01-16 Unknown Transaction
    expenses:unknown                CHF10.00
    assets:bank:ubs:checking       CHF-10.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }]])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: false },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Cannot import');
      expect(parsed.hint).toContain('checkOnly: true');
    });

    it('should import and move files when all transactions match', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const doneDir = path.join(testDir, 'doc/agent/done/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      const ledgerDir = path.join(testDir, 'ledger');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(ledgerDir, { recursive: true });

      // Create .hledger.journal (required for year-based import)
      fs.writeFileSync(path.join(testDir, '.hledger.journal'), '; main journal\n');

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const hledgerOutput = `2026-02-01 Clean Transaction
    expenses:food                   CHF10.00
    assets:bank:ubs:checking       CHF-10.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          ['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }],
          ['import', { stdout: '', stderr: '', exitCode: 0 }],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: false },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('Successfully imported');

      // Check file was moved
      expect(fs.existsSync(csvPath)).toBe(false);
      expect(fs.existsSync(path.join(doneDir, 'transactions.csv'))).toBe(true);

      // Check year journal was created
      expect(fs.existsSync(path.join(ledgerDir, '2026.journal'))).toBe(true);

      // Check include was added to main journal
      const mainJournal = fs.readFileSync(path.join(testDir, '.hledger.journal'), 'utf-8');
      expect(mainJournal).toContain('include ledger/2026.journal');
    });

    it('should handle hledger import errors', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      const ledgerDir = path.join(testDir, 'ledger');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(ledgerDir, { recursive: true });

      // Create .hledger.journal (required for year-based import)
      fs.writeFileSync(path.join(testDir, '.hledger.journal'), '; main journal\n');

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          [
            'print',
            {
              stdout: '2026-01-01 Test\n    expenses:test CHF1\n    assets:bank CHF-1',
              stderr: '',
              exitCode: 0,
            },
          ],
          ['import', { stdout: '', stderr: 'Parse error at line 5', exitCode: 1 }],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: false },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Import failed');
      expect(parsed.error).toContain('Parse error');
    });

    it('should fail if .hledger.journal does not exist', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          [
            'print',
            {
              stdout: '2026-01-01 Test\n    expenses:test CHF1\n    assets:bank CHF-1',
              stderr: '',
              exitCode: 0,
            },
          ],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: false },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('.hledger.journal not found');
    });
  });

  describe('year-based journal routing', () => {
    it('should reject CSV with transactions from multiple years', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      // Transactions spanning December 2025 and January 2026
      const hledgerOutput = `2025-12-30 December Transaction
    expenses:food                   CHF50.00
    assets:bank:ubs:checking       CHF-50.00

2026-01-05 January Transaction
    expenses:food                   CHF25.00
    assets:bank:ubs:checking       CHF-25.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }]])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: true },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.files[0].error).toContain('multiple years');
      expect(parsed.files[0].error).toContain('2025');
      expect(parsed.files[0].error).toContain('2026');
      expect(parsed.summary.filesWithErrors).toBe(1);
    });

    it('should include transactionYear in file result for single-year CSV', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const hledgerOutput = `2026-02-01 Transaction One
    expenses:food                   CHF10.00
    assets:bank:ubs:checking       CHF-10.00

2026-02-15 Transaction Two
    expenses:travel                 CHF200.00
    assets:bank:ubs:checking       CHF-200.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }]])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: true },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.files[0].transactionYear).toBe(2026);
    });

    it('should add include directive when existing one is commented out with #', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      const ledgerDir = path.join(testDir, 'ledger');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(ledgerDir, { recursive: true });

      // Create .hledger.journal with commented-out include
      fs.writeFileSync(
        path.join(testDir, '.hledger.journal'),
        '; main journal\ninclude ledger/2025.journal\n#include ledger/2026.journal\n'
      );

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const hledgerOutput = `2026-03-01 Transaction
    expenses:office                 CHF100.00
    assets:bank:ubs:checking       CHF-100.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          ['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }],
          ['import', { stdout: '', stderr: '', exitCode: 0 }],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: false },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);

      // Check that a new (uncommented) include directive was added
      const mainJournal = fs.readFileSync(path.join(testDir, '.hledger.journal'), 'utf-8');
      const lines = mainJournal.split('\n');
      const uncommentedIncludes = lines.filter(
        (line) => line.trim() === 'include ledger/2026.journal'
      );
      expect(uncommentedIncludes.length).toBe(1);

      // The commented one should still be there
      expect(mainJournal).toContain('#include ledger/2026.journal');
    });

    it('should add include directive when existing one is commented out with ;', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      const ledgerDir = path.join(testDir, 'ledger');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(ledgerDir, { recursive: true });

      // Create .hledger.journal with semicolon-commented include
      fs.writeFileSync(
        path.join(testDir, '.hledger.journal'),
        '; main journal\ninclude ledger/2025.journal\n; include ledger/2026.journal\n'
      );

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const hledgerOutput = `2026-03-01 Transaction
    expenses:office                 CHF100.00
    assets:bank:ubs:checking       CHF-100.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          ['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }],
          ['import', { stdout: '', stderr: '', exitCode: 0 }],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: false },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);

      // Check that a new (uncommented) include directive was added
      const mainJournal = fs.readFileSync(path.join(testDir, '.hledger.journal'), 'utf-8');
      const lines = mainJournal.split('\n');
      const uncommentedIncludes = lines.filter(
        (line) => line.trim() === 'include ledger/2026.journal'
      );
      expect(uncommentedIncludes.length).toBe(1);

      // The commented one should still be there
      expect(mainJournal).toContain('; include ledger/2026.journal');
    });

    it('should not duplicate include directive on subsequent imports', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      const ledgerDir = path.join(testDir, 'ledger');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(ledgerDir, { recursive: true });

      // Create .hledger.journal with existing include
      fs.writeFileSync(
        path.join(testDir, '.hledger.journal'),
        '; main journal\ninclude ledger/2026.journal\n'
      );
      // Create existing year journal
      fs.writeFileSync(path.join(ledgerDir, '2026.journal'), '; 2026 transactions\n');

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const hledgerOutput = `2026-03-01 Another Transaction
    expenses:office                 CHF100.00
    assets:bank:ubs:checking       CHF-100.00
`;

      const mockExecutor = createMockHledgerExecutor(
        new Map([
          ['print', { stdout: hledgerOutput, stderr: '', exitCode: 0 }],
          ['import', { stdout: '', stderr: '', exitCode: 0 }],
        ])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: false },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);

      // Check include was not duplicated
      const mainJournal = fs.readFileSync(path.join(testDir, '.hledger.journal'), 'utf-8');
      const includeCount = (mainJournal.match(/include ledger\/2026\.journal/g) || []).length;
      expect(includeCount).toBe(1);
    });
  });

  describe('hledger error handling', () => {
    it('should handle hledger print errors gracefully', async () => {
      const pendingDir = path.join(testDir, 'doc/agent/todo/import/ubs/chf');
      const rulesDir = path.join(testDir, 'ledger/rules');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const csvPath = path.join(pendingDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'data');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ${csvPath}`);

      const mockExecutor = createMockHledgerExecutor(
        new Map([['print', { stdout: '', stderr: 'Invalid CSV format', exitCode: 1 }]])
      );

      const result = await importStatementsCore(
        testDir,
        'accountant',
        { checkOnly: true },
        () => createMockConfig(),
        mockExecutor
      );
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.files[0].error).toContain('hledger error');
      expect(parsed.files[0].error).toContain('Invalid CSV format');
      expect(parsed.summary.filesWithErrors).toBe(1);
    });
  });
});
