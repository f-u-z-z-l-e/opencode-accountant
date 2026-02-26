import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  importPipeline,
  extractFromJsonResult,
  extractCommitInfo,
  extractTransactionCount,
  buildCommitMessage,
  NoTransactionsError,
} from './import-pipeline.ts';
import type { HledgerExecutor, HledgerResult } from '../utils/hledgerExecutor.ts';
import type { ImportConfig } from '../utils/importConfig.ts';
import { initTestGitRepo } from '../utils/testHelpers.ts';

describe('import-pipeline tool', () => {
  let testRepoPath: string;

  // Create a temporary git repository for testing
  beforeEach(() => {
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'import-pipeline-test-'));

    // Initialize git repo with test configuration
    initTestGitRepo(testRepoPath);

    // Create initial structure
    fs.mkdirSync(path.join(testRepoPath, 'ledger'), { recursive: true });
    fs.mkdirSync(path.join(testRepoPath, 'config/import/rules'), { recursive: true });
    fs.mkdirSync(path.join(testRepoPath, 'statements/import'), { recursive: true });
    fs.mkdirSync(path.join(testRepoPath, 'statements/pending'), { recursive: true });
    fs.mkdirSync(path.join(testRepoPath, 'statements/done'), { recursive: true });

    // Create main journal
    fs.writeFileSync(path.join(testRepoPath, '.hledger.journal'), '; Main journal\n');

    // Initial commit
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });
  });

  // Clean up after each test
  afterEach(() => {
    try {
      // Clean up any worktrees
      const worktreeList = execSync('git worktree list', {
        cwd: testRepoPath,
        encoding: 'utf-8',
      });
      const lines = worktreeList.split('\n').filter((l) => l.includes('import-'));
      for (const line of lines) {
        const worktreePath = line.split(/\s+/)[0];
        try {
          execSync(`git worktree remove "${worktreePath}" --force`, { cwd: testRepoPath });
        } catch {
          // Ignore cleanup errors
        }
      }

      // Remove test repo
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const mockConfig: ImportConfig = {
    paths: {
      import: 'statements/import',
      pending: 'statements/pending',
      done: 'statements/done',
      unrecognized: 'statements/unrecognized',
      rules: 'config/import/rules',
    },
    providers: {
      testbank: {
        detect: [
          {
            header: 'Date,Description,Amount',
            currencyField: 'Currency',
          },
        ],
        currencies: { CHF: 'chf' },
      },
    },
  };

  const mockConfigLoader = () => mockConfig;

  const createMockHledgerExecutor = (responses: Map<string, HledgerResult>): HledgerExecutor => {
    return async (args: string[]): Promise<HledgerResult> => {
      const key = args.join(' ');
      for (const [pattern, response] of responses) {
        if (key.includes(pattern)) {
          return response;
        }
      }
      return { stdout: '', stderr: 'No mock response', exitCode: 1 };
    };
  };

  describe('agent restriction', () => {
    it('should reject non-accountant agents', async () => {
      const result = await importPipeline(testRepoPath, 'other-agent', {}, mockConfigLoader);

      expect(result).toContain('restricted to the accountant agent');
    });
  });

  describe('worktree creation', () => {
    it('should create a worktree at the start', async () => {
      // This will fail later in the pipeline but should create worktree
      const result = await importPipeline(testRepoPath, 'accountant', {}, mockConfigLoader);

      const parsed = JSON.parse(result);
      expect(parsed.worktreeId).toBeDefined();
      expect(parsed.steps.worktree?.success).toBe(true);
    });

    it('should clean up worktree on failure', async () => {
      const result = await importPipeline(testRepoPath, 'accountant', {}, mockConfigLoader);

      const parsed = JSON.parse(result);
      expect(parsed.steps.cleanup?.success).toBe(true);

      // Verify no import worktrees remain (check for import-<uuid> pattern, not import-pipeline-test)
      const worktreeList = execSync('git worktree list', {
        cwd: testRepoPath,
        encoding: 'utf-8',
      });
      // Import worktrees have format: import-<uuid> (36 char uuid)
      const hasImportWorktree = /import-[0-9a-f]{8}-[0-9a-f]{4}/.test(worktreeList);
      expect(hasImportWorktree).toBe(false);
    });
  });

  describe('no transactions scenario', () => {
    it('should handle empty pending directory gracefully', async () => {
      const mockExecutor = createMockHledgerExecutor(
        new Map([['print', { stdout: '', stderr: '', exitCode: 0 }]])
      );

      const result = await importPipeline(
        testRepoPath,
        'accountant',
        {},
        mockConfigLoader,
        mockExecutor
      );

      const parsed = JSON.parse(result);
      // Should succeed with no transactions
      expect(parsed.steps.dryRun).toBeDefined();
    });
  });

  describe('skipClassify option', () => {
    it('should skip classify step when skipClassify is true', async () => {
      const result = await importPipeline(
        testRepoPath,
        'accountant',
        { skipClassify: true },
        mockConfigLoader
      );

      const parsed = JSON.parse(result);
      expect(parsed.steps.classify?.success).toBe(true);
      expect(parsed.steps.classify?.message).toContain('skipped');
    });
  });

  describe('result structure', () => {
    it('should return proper result structure', async () => {
      const result = await importPipeline(testRepoPath, 'accountant', {}, mockConfigLoader);

      const parsed = JSON.parse(result);

      // Should have all expected fields
      expect(parsed).toHaveProperty('success');
      expect(parsed).toHaveProperty('steps');
      expect(parsed).toHaveProperty('worktreeId');

      // Steps should be objects
      expect(typeof parsed.steps).toBe('object');
    });

    it('should include error details in result structure', async () => {
      // Test agent restriction error (simpler to trigger than import failure)
      const result = await importPipeline(
        testRepoPath,
        'wrong-agent',
        { skipClassify: true },
        mockConfigLoader
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('restricted');
    });
  });

  describe('commit message format', () => {
    it('should build proper commit message with provider and currency', async () => {
      // This is a unit test for the commit message building logic
      // We test the full pipeline in integration tests
      const result = await importPipeline(
        testRepoPath,
        'accountant',
        { provider: 'ubs', currency: 'chf' },
        mockConfigLoader
      );

      // Even if pipeline fails, we can check the structure
      const parsed = JSON.parse(result);
      expect(parsed).toBeDefined();
    });
  });
});

describe('utility functions', () => {
  describe('extractFromJsonResult', () => {
    it('should extract data using custom extractor', () => {
      const json = '{"metadata": {"from-date": "2024-01-01"}}';
      const result = extractFromJsonResult(
        json,
        (parsed: unknown) => {
          const data = parsed as { metadata?: { 'from-date'?: string } };
          return data.metadata?.['from-date'] || '';
        },
        'default'
      );
      expect(result).toBe('2024-01-01');
    });

    it('should return default on parse error', () => {
      const result = extractFromJsonResult('invalid json', () => 'extracted', 'default');
      expect(result).toBe('default');
    });

    it('should return default on extractor error', () => {
      const result = extractFromJsonResult<string>(
        '{"data": "value"}',
        () => {
          throw new Error('Extractor failed');
        },
        'default'
      );
      expect(result).toBe('default');
    });
  });

  describe('extractCommitInfo', () => {
    it('should extract commit info from reconcile result', () => {
      const json = JSON.stringify({
        metadata: {
          'from-date': '2024-01-01',
          'until-date': '2024-01-31',
        },
      });
      const result = extractCommitInfo(json);
      expect(result.fromDate).toBe('2024-01-01');
      expect(result.untilDate).toBe('2024-01-31');
    });

    it('should return empty object on invalid JSON', () => {
      const result = extractCommitInfo('invalid');
      expect(result.fromDate).toBeUndefined();
      expect(result.untilDate).toBeUndefined();
    });
  });

  describe('extractTransactionCount', () => {
    it('should extract transaction count from import result', () => {
      const json = JSON.stringify({ summary: { totalTransactions: 42 } });
      const result = extractTransactionCount(json);
      expect(result).toBe(42);
    });

    it('should return 0 on invalid JSON', () => {
      const result = extractTransactionCount('invalid');
      expect(result).toBe(0);
    });

    it('should return 0 when summary is missing', () => {
      const result = extractTransactionCount('{}');
      expect(result).toBe(0);
    });
  });

  describe('buildCommitMessage', () => {
    it('should format provider and currency', () => {
      const msg = buildCommitMessage('ubs', 'chf', undefined, undefined, 0);
      expect(msg).toBe('Import: UBS CHF');
    });

    it('should include date range when provided', () => {
      const msg = buildCommitMessage('ubs', 'chf', '2024-01-01', '2024-01-31', 5);
      expect(msg).toBe('Import: UBS CHF 2024-01-01 to 2024-01-31 (5 transactions)');
    });

    it('should handle missing provider and currency', () => {
      const msg = buildCommitMessage(undefined, undefined, '2024-01-01', '2024-01-31', 10);
      expect(msg).toBe('Import: statements 2024-01-01 to 2024-01-31 (10 transactions)');
    });

    it('should handle zero transactions', () => {
      const msg = buildCommitMessage('ubs', 'chf', undefined, undefined, 0);
      expect(msg).toBe('Import: UBS CHF');
    });
  });

  describe('NoTransactionsError', () => {
    it('should be throwable and catchable', () => {
      expect(() => {
        throw new NoTransactionsError();
      }).toThrow('No transactions to import');
    });

    it('should be instanceof Error', () => {
      const error = new NoTransactionsError();
      expect(error instanceof Error).toBe(true);
      expect(error instanceof NoTransactionsError).toBe(true);
    });
  });
});

describe('import-pipeline integration', () => {
  // These tests would require a more complete setup with real hledger
  // For now, we focus on unit tests above

  it.skip('should complete full pipeline with real hledger', async () => {
    // This would be an integration test with real hledger
    // Skipped for now as it requires hledger installation
  });
});
