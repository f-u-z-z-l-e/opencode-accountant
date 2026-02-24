import { tool } from '@opencode-ai/plugin';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { loadImportConfig, type ImportConfig } from '../utils/importConfig.ts';
import {
  createImportWorktree,
  mergeWorktree,
  removeWorktree,
  type WorktreeContext,
} from '../utils/worktreeManager.ts';
import { classifyStatements } from './classify-statements.ts';
import { importStatements } from './import-statements.ts';
import { reconcileStatementCore } from './reconcile-statement.ts';
import { defaultHledgerExecutor, type HledgerExecutor } from '../utils/hledgerExecutor.ts';

/**
 * Arguments for the import-pipeline tool
 */
interface ImportPipelineArgs {
  /** Filter by provider (e.g., "ubs", "revolut") */
  provider?: string;
  /** Filter by currency (e.g., "chf", "eur") */
  currency?: string;
  /** Manual closing balance override (if not in CSV metadata) */
  closingBalance?: string;
  /** Manual account override (auto-detected from rules file if not provided) */
  account?: string;
  /** Skip classify step if rules already exist */
  skipClassify?: boolean;
}

/**
 * Result of a single pipeline step
 */
interface StepResult {
  success: boolean;
  message: string;
  details?: unknown;
}

/**
 * Overall result of the import-pipeline tool
 */
interface ImportPipelineResult {
  success: boolean;
  worktreeId?: string;
  steps: {
    worktree?: StepResult;
    classify?: StepResult;
    dryRun?: StepResult;
    import?: StepResult;
    reconcile?: StepResult;
    merge?: StepResult;
    cleanup?: StepResult;
  };
  summary?: string;
  error?: string;
  hint?: string;
}

/**
 * Extracts metadata from reconcile result for commit message
 */
function extractCommitInfo(reconcileResult: string): {
  fromDate?: string;
  untilDate?: string;
  transactionCount?: number;
} {
  try {
    const parsed = JSON.parse(reconcileResult);
    return {
      fromDate: parsed.metadata?.from_date,
      untilDate: parsed.metadata?.until_date,
      transactionCount: undefined, // Will get from import result
    };
  } catch {
    return {};
  }
}

/**
 * Extracts transaction count from import result
 */
function extractTransactionCount(importResult: string): number {
  try {
    const parsed = JSON.parse(importResult);
    return parsed.summary?.totalTransactions || 0;
  } catch {
    return 0;
  }
}

/**
 * Builds a commit message from import metadata
 */
function buildCommitMessage(
  provider: string | undefined,
  currency: string | undefined,
  fromDate: string | undefined,
  untilDate: string | undefined,
  transactionCount: number
): string {
  const providerStr = provider?.toUpperCase() || 'statements';
  const currencyStr = currency?.toUpperCase() || '';
  const dateRange = fromDate && untilDate ? ` ${fromDate} to ${untilDate}` : '';
  const txStr = transactionCount > 0 ? ` (${transactionCount} transactions)` : '';

  return `Import: ${providerStr} ${currencyStr}${dateRange}${txStr}`.trim();
}

/**
 * Core implementation of the import-pipeline tool
 */
export async function importPipelineCore(
  directory: string,
  agent: string,
  options: ImportPipelineArgs,
  // eslint-disable-next-line no-unused-vars
  configLoader: (configDir: string) => ImportConfig = loadImportConfig,
  hledgerExecutor: HledgerExecutor = defaultHledgerExecutor
): Promise<string> {
  // Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'import pipeline');
  if (restrictionError) {
    return restrictionError;
  }

  const result: ImportPipelineResult = {
    success: false,
    steps: {},
  };

  let worktree: WorktreeContext | null = null;

  try {
    // Step 1: Create worktree
    try {
      worktree = createImportWorktree(directory);
      result.worktreeId = worktree.uuid;
      result.steps.worktree = {
        success: true,
        message: `Created worktree at ${worktree.path}`,
        details: { path: worktree.path, branch: worktree.branch },
      };
    } catch (error) {
      result.steps.worktree = {
        success: false,
        message: `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
      };
      throw new Error('Failed to create worktree');
    }

    // Worktree checker that always returns true (we're inside the worktree we just created)
    const inWorktree = () => true;

    // Step 2: Classify (if not skipped)
    if (!options.skipClassify) {
      const classifyResult = await classifyStatements(
        worktree.path,
        agent,
        configLoader,
        inWorktree
      );

      const classifyParsed = JSON.parse(classifyResult);
      result.steps.classify = {
        success: classifyParsed.success !== false,
        message:
          classifyParsed.success !== false
            ? 'Classification complete'
            : 'Classification had issues',
        details: classifyParsed,
      };

      // Classification failure is not fatal - there might be no new files to classify
      // But if there are unrecognized files, we should note that
      if (classifyParsed.unrecognized?.length > 0) {
        result.steps.classify.message = `Classification complete with ${classifyParsed.unrecognized.length} unrecognized file(s)`;
      }
    } else {
      result.steps.classify = {
        success: true,
        message: 'Classification skipped (skipClassify: true)',
      };
    }

    // Step 3: Dry run (check for unknowns)
    const dryRunResult = await importStatements(
      worktree.path,
      agent,
      {
        provider: options.provider,
        currency: options.currency,
        checkOnly: true,
      },
      configLoader,
      hledgerExecutor,
      inWorktree
    );

    const dryRunParsed = JSON.parse(dryRunResult);
    result.steps.dryRun = {
      success: dryRunParsed.success,
      message: dryRunParsed.success
        ? `Dry run passed: ${dryRunParsed.summary?.totalTransactions || 0} transactions ready`
        : `Dry run failed: ${dryRunParsed.summary?.unknown || 0} unknown account(s)`,
      details: dryRunParsed,
    };

    if (!dryRunParsed.success) {
      result.error = 'Dry run found unknown accounts or errors';
      result.hint = 'Add rules to categorize unknown transactions, then retry';
      throw new Error('Dry run failed');
    }

    // Check if there are any transactions to import
    if (dryRunParsed.summary?.totalTransactions === 0) {
      result.steps.import = {
        success: true,
        message: 'No transactions to import',
      };
      result.steps.reconcile = {
        success: true,
        message: 'Reconciliation skipped (no transactions)',
      };
      result.steps.merge = {
        success: true,
        message: 'Merge skipped (no changes)',
      };
      result.success = true;
      result.summary = 'No transactions found to import';

      // Cleanup worktree
      removeWorktree(worktree, true);
      result.steps.cleanup = {
        success: true,
        message: 'Worktree cleaned up',
      };

      return JSON.stringify(result);
    }

    // Step 4: Actual import
    const importResult = await importStatements(
      worktree.path,
      agent,
      {
        provider: options.provider,
        currency: options.currency,
        checkOnly: false,
      },
      configLoader,
      hledgerExecutor,
      inWorktree
    );

    const importParsed = JSON.parse(importResult);
    result.steps.import = {
      success: importParsed.success,
      message: importParsed.success
        ? `Imported ${importParsed.summary?.totalTransactions || 0} transactions`
        : `Import failed: ${importParsed.error || 'Unknown error'}`,
      details: importParsed,
    };

    if (!importParsed.success) {
      result.error = `Import failed: ${importParsed.error || 'Unknown error'}`;
      throw new Error('Import failed');
    }

    // Step 5: Reconcile closing balance
    const reconcileResult = await reconcileStatementCore(
      worktree.path,
      agent,
      {
        provider: options.provider,
        currency: options.currency,
        closingBalance: options.closingBalance,
        account: options.account,
      },
      configLoader,
      hledgerExecutor,
      inWorktree
    );

    const reconcileParsed = JSON.parse(reconcileResult);
    result.steps.reconcile = {
      success: reconcileParsed.success,
      message: reconcileParsed.success
        ? `Balance reconciled: ${reconcileParsed.actualBalance}`
        : `Balance mismatch: expected ${reconcileParsed.expectedBalance}, got ${reconcileParsed.actualBalance}`,
      details: reconcileParsed,
    };

    if (!reconcileParsed.success) {
      result.error = `Reconciliation failed: ${reconcileParsed.error || 'Balance mismatch'}`;
      result.hint = 'Check for missing transactions or incorrect rules';
      throw new Error('Reconciliation failed');
    }

    // Step 6: Merge to main with --no-ff
    const commitInfo = extractCommitInfo(reconcileResult);
    const transactionCount = extractTransactionCount(importResult);
    const commitMessage = buildCommitMessage(
      options.provider,
      options.currency,
      commitInfo.fromDate,
      commitInfo.untilDate,
      transactionCount
    );

    try {
      mergeWorktree(worktree, commitMessage);
      result.steps.merge = {
        success: true,
        message: `Merged to main: "${commitMessage}"`,
        details: { commitMessage },
      };
    } catch (error) {
      result.steps.merge = {
        success: false,
        message: `Merge failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      result.error = 'Merge to main branch failed';
      throw new Error('Merge failed');
    }

    // Step 7: Cleanup worktree (after successful merge)
    try {
      removeWorktree(worktree, true);
      result.steps.cleanup = {
        success: true,
        message: 'Worktree cleaned up',
      };
    } catch (error) {
      // Cleanup failure is not fatal
      result.steps.cleanup = {
        success: false,
        message: `Cleanup warning: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Success!
    result.success = true;
    result.summary = `Successfully imported ${transactionCount} transaction(s)`;

    return JSON.stringify(result);
  } catch (error) {
    // Cleanup worktree on failure
    if (worktree) {
      try {
        removeWorktree(worktree, true);
        result.steps.cleanup = {
          success: true,
          message: 'Worktree cleaned up after failure',
        };
      } catch (cleanupError) {
        result.steps.cleanup = {
          success: false,
          message: `Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        };
      }
    }

    // Error is already set in result
    if (!result.error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return JSON.stringify(result);
  }
}

export default tool({
  description: `ACCOUNTANT AGENT ONLY: Complete import pipeline with git worktree isolation and balance reconciliation.

This tool orchestrates the full import workflow in an isolated git worktree:

**Pipeline Steps:**
1. **Create Worktree**: Creates an isolated git worktree for safe import
2. **Classify**: Moves CSVs from import to pending directory (optional, skip with skipClassify)
3. **Dry Run**: Validates all transactions have known accounts
4. **Import**: Imports transactions to the journal
5. **Reconcile**: Validates closing balance matches CSV metadata
6. **Merge**: Merges worktree to main with --no-ff
7. **Cleanup**: Removes worktree

**Safety Features:**
- All changes happen in isolated worktree
- If any step fails, worktree is discarded (main branch untouched)
- Balance reconciliation ensures data integrity
- Atomic commit with merge --no-ff preserves history

**Usage:**
- Basic: import-pipeline (processes all pending CSVs)
- Filtered: import-pipeline --provider ubs --currency chf
- With manual balance: import-pipeline --closingBalance "CHF 1234.56"
- Skip classify: import-pipeline --skipClassify true`,
  args: {
    provider: tool.schema
      .string()
      .optional()
      .describe('Filter by provider (e.g., "ubs", "revolut")'),
    currency: tool.schema.string().optional().describe('Filter by currency (e.g., "chf", "eur")'),
    closingBalance: tool.schema
      .string()
      .optional()
      .describe('Manual closing balance override (if not in CSV metadata)'),
    account: tool.schema
      .string()
      .optional()
      .describe('Manual account override (auto-detected from rules file if not provided)'),
    skipClassify: tool.schema
      .boolean()
      .optional()
      .describe('Skip the classify step (default: false)'),
  },
  async execute(params, context) {
    const { directory, agent } = context;
    return importPipelineCore(directory, agent, {
      provider: params.provider,
      currency: params.currency,
      closingBalance: params.closingBalance,
      account: params.account,
      skipClassify: params.skipClassify,
    });
  },
});
