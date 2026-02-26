import { describe, it, expect } from 'vitest';
import { reconcileStatement } from './reconcile-statement.ts';
import type { HledgerExecutor } from '../utils/hledgerExecutor.ts';
import type { ImportConfig } from '../utils/importConfig.ts';

describe('reconcile-statement tool', () => {
  const mockConfig: ImportConfig = {
    paths: {
      import: 'statements/import',
      pending: 'statements/pending',
      done: 'statements/done',
      unrecognized: 'statements/unrecognized',
      rules: 'config/rules',
    },
    providers: {
      ubs: {
        detect: [
          {
            header: 'Date;Description;Amount',
            currencyField: 'Currency',
            skipRows: 8,
            delimiter: ';',
            metadata: [
              { field: 'closing-balance', row: 5, column: 1 },
              { field: 'from-date', row: 2, column: 1 },
              { field: 'until-date', row: 3, column: 1 },
            ],
          },
        ],
        currencies: { CHF: 'chf' },
      },
    },
  };

  const mockConfigLoader = () => mockConfig;

  const mockHledgerExecutor: HledgerExecutor = async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  });

  // Worktree checker functions for testing
  const inWorktree = () => true;
  const notInWorktree = () => false;

  describe('worktree enforcement', () => {
    it('should reject execution outside worktree', async () => {
      const result = await reconcileStatement(
        '/test/dir',
        'accountant',
        {},
        mockConfigLoader,
        mockHledgerExecutor,
        notInWorktree
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('must be run inside an import worktree');
    });

    it('should allow execution inside worktree', async () => {
      const result = await reconcileStatement(
        '/test/dir',
        'accountant',
        {},
        mockConfigLoader,
        mockHledgerExecutor,
        inWorktree
      );

      const parsed = JSON.parse(result);
      // Should not fail due to worktree check (may fail for other reasons)
      expect(parsed.error).not.toContain('must be run inside an import worktree');
    });
  });

  describe('agent restriction', () => {
    it('should reject non-accountant agent', async () => {
      const result = await reconcileStatement(
        '/test/dir',
        'developer',
        {},
        mockConfigLoader,
        mockHledgerExecutor,
        inWorktree
      );

      expect(result).toContain('restricted');
      expect(result).toContain('accountant');
    });
  });

  describe('closing balance detection', () => {
    it('should use manually provided closing balance', async () => {
      const result = await reconcileStatement(
        '/test/dir',
        'accountant',
        { closingBalance: '1234.56' },
        mockConfigLoader,
        mockHledgerExecutor,
        inWorktree
      );

      const parsed = JSON.parse(result);
      // Should not fail due to missing closing balance
      // (will fail for other reasons like missing CSV files, but that's expected)
      if (parsed.error) {
        expect(parsed.error).not.toContain('closing balance');
      }
    });
  });

  describe('result structure', () => {
    it('should return proper error structure when no CSV found', async () => {
      const result = await reconcileStatement(
        '/test/dir',
        'accountant',
        {},
        mockConfigLoader,
        mockHledgerExecutor,
        inWorktree
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBeDefined();
      expect(typeof parsed.error).toBe('string');
    });
  });
});

describe('parseAccount1', async () => {
  // Import the function directly for unit testing
  const { parseAccount1 } = await import('../utils/rulesParser.ts');

  it('should extract account1 from rules content', () => {
    const rulesContent = `
skip 8
separator ;
fields date, description, amount
account1 assets:bank:ubs:checking
`;
    expect(parseAccount1(rulesContent)).toBe('assets:bank:ubs:checking');
  });

  it('should return null when no account1 directive', () => {
    const rulesContent = `
skip 8
separator ;
fields date, description, amount
`;
    expect(parseAccount1(rulesContent)).toBeNull();
  });

  it('should handle account1 with colons in name', () => {
    const rulesContent = `account1 assets:bank:revolut:personal:eur`;
    expect(parseAccount1(rulesContent)).toBe('assets:bank:revolut:personal:eur');
  });

  it('should handle leading/trailing whitespace', () => {
    const rulesContent = `account1   assets:bank:test:account   `;
    expect(parseAccount1(rulesContent)).toBe('assets:bank:test:account');
  });
});
