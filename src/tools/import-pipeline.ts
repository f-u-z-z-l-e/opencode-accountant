import { tool } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { loadImportConfig, type ImportConfig } from '../utils/importConfig.ts';
import { mergeWorktree, withWorktree, type WorktreeContext } from '../utils/worktreeManager.ts';
import { classifyStatements } from './classify-statements.ts';
import { importStatements } from './import-statements.ts';
import { reconcileStatement } from './reconcile-statement.ts';
import { defaultHledgerExecutor, type HledgerExecutor } from '../utils/hledgerExecutor.ts';
import { syncCSVFilesToWorktree, cleanupProcessedCSVFiles } from '../utils/fileUtils.ts';

/**
 * Arguments for the import-pipeline tool
 */
export interface ImportPipelineArgs {
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
 * Details for CSV sync step result
 */
interface SyncStepDetails {
  synced: string[];
  errors?: Array<{ file: string; error: string }>;
}

/**
 * Details for classify step result
 */
interface ClassifyStepDetails {
  success: boolean;
  unrecognized?: string[];
  classified?: unknown;
}

/**
 * Details for dry run step result
 */
interface DryRunStepDetails {
  success: boolean;
  summary?: {
    totalTransactions: number;
    unknown?: number;
  };
}

/**
 * Details for import step result
 */
interface ImportStepDetails {
  success: boolean;
  summary?: {
    totalTransactions?: number;
  };
  files?: Array<{
    csv?: string;
    [key: string]: unknown;
  }>;
  error?: string;
}

/**
 * Details for reconcile step result
 */
interface ReconcileStepDetails {
  success: boolean;
  actualBalance?: string;
  expectedBalance?: string;
  metadata?: {
    from_date?: string;
    until_date?: string;
  };
  error?: string;
}

/**
 * Details for merge step result
 */
interface MergeStepDetails {
  commitMessage: string;
}

/**
 * Details for cleanup step result
 */
interface CleanupStepDetails {
  cleanedAfterSuccess?: boolean;
  cleanedAfterFailure?: boolean;
  csvCleanup?: {
    deleted: string[];
    errors?: Array<{ file: string; error: string }>;
  };
}

/**
 * Result of a single pipeline step
 */
interface StepResult<T = unknown> {
  success: boolean;
  message: string;
  details?: T;
}

/**
 * Overall result of the import-pipeline tool
 */
export interface ImportPipelineResult {
  success: boolean;
  worktreeId?: string;
  steps: {
    worktree?: StepResult;
    sync?: StepResult<SyncStepDetails>;
    classify?: StepResult<ClassifyStepDetails>;
    dryRun?: StepResult<DryRunStepDetails>;
    import?: StepResult<ImportStepDetails>;
    reconcile?: StepResult<ReconcileStepDetails>;
    merge?: StepResult<MergeStepDetails>;
    cleanup?: StepResult<CleanupStepDetails>;
  };
  summary?: string;
  error?: string;
  hint?: string;
}

/**
 * Pipeline execution context
 */
export interface PipelineContext {
  directory: string;
  agent: string;
  options: ImportPipelineArgs;
  configLoader: (_configDir: string) => ImportConfig;
  hledgerExecutor: HledgerExecutor;
  result: ImportPipelineResult;
}

/**
 * Custom error for no transactions scenario
 */
export class NoTransactionsError extends Error {
  constructor() {
    super('No transactions to import');
    this.name = 'NoTransactionsError';
  }
}

/**
 * Builds a step result with typed details
 */
function buildStepResult<T>(success: boolean, message: string, details?: T): StepResult<T> {
  const result: StepResult<T> = { success, message };
  if (details !== undefined) {
    result.details = details;
  }
  return result;
}

/**
 * Builds a success result
 */
function buildSuccessResult(result: ImportPipelineResult, summary: string): string {
  result.success = true;
  result.summary = summary;
  return JSON.stringify(result);
}

/**
 * Builds an error result
 */
function buildErrorResult(result: ImportPipelineResult, error: string, hint?: string): string {
  result.success = false;
  result.error = error;
  if (hint) {
    result.hint = hint;
  }
  return JSON.stringify(result);
}

/**
 * Generic JSON result extractor
 */
export function extractFromJsonResult<T>(
  jsonString: string,
  extractor: (parsed: unknown) => T,
  defaultValue: T
): T {
  try {
    const parsed = JSON.parse(jsonString);
    return extractor(parsed);
  } catch {
    return defaultValue;
  }
}

/**
 * Extracts metadata from reconcile result for commit message
 */
export function extractCommitInfo(reconcileResult: string): {
  fromDate?: string;
  untilDate?: string;
} {
  return extractFromJsonResult<{ fromDate?: string; untilDate?: string }>(
    reconcileResult,
    (parsed: unknown) => {
      const data = parsed as { metadata?: { from_date?: string; until_date?: string } };
      return {
        fromDate: data.metadata?.from_date,
        untilDate: data.metadata?.until_date,
      };
    },
    { fromDate: undefined, untilDate: undefined }
  );
}

/**
 * Extracts transaction count from import result
 */
export function extractTransactionCount(importResult: string): number {
  return extractFromJsonResult(
    importResult,
    (parsed: unknown) => {
      const data = parsed as { summary?: { totalTransactions?: number } };
      return data.summary?.totalTransactions || 0;
    },
    0
  );
}

/**
 * Builds a commit message from import metadata
 */
export function buildCommitMessage(
  provider: string | undefined,
  currency: string | undefined,
  fromDate: string | undefined,
  untilDate: string | undefined,
  transactionCount: number
): string {
  const providerStr = provider?.toUpperCase() || 'statements';
  const currencyStr = currency?.toUpperCase();
  const dateRange = fromDate && untilDate ? ` ${fromDate} to ${untilDate}` : '';
  const txStr = transactionCount > 0 ? ` (${transactionCount} transactions)` : '';

  const parts = ['Import:', providerStr];
  if (currencyStr) {
    parts.push(currencyStr);
  }

  return `${parts.join(' ')}${dateRange}${txStr}`;
}

/**
 * Clean up original files from main repo's import/incoming/ directory.
 * This runs after successful merge to remove files that were successfully imported.
 */
function cleanupIncomingFiles(worktree: WorktreeContext, context: PipelineContext): void {
  const incomingDir = path.join(worktree.mainRepoPath, 'import/incoming');

  if (!fs.existsSync(incomingDir)) {
    return;
  }

  // Extract filenames from import step results
  const importStep = context.result.steps.import;
  if (!importStep?.success || !importStep.details) {
    return;
  }

  const importResult = importStep.details as ImportStepDetails;
  if (!importResult.files || !Array.isArray(importResult.files)) {
    return;
  }

  let deletedCount = 0;
  for (const fileResult of importResult.files) {
    if (!fileResult.csv) continue;

    // Extract just the filename from the path
    const filename = path.basename(fileResult.csv);
    const filePath = path.join(incomingDir, filename);

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        deletedCount++;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `[ERROR] Failed to delete ${filename}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (deletedCount > 0) {
    // eslint-disable-next-line no-console
    console.log(`[INFO] Cleaned up ${deletedCount} file(s) from import/incoming/`);
  }
}

/**
 * Executes the classify step
 */
export async function executeClassifyStep(
  context: PipelineContext,
  worktree: WorktreeContext
): Promise<void> {
  if (context.options.skipClassify) {
    context.result.steps.classify = buildStepResult(
      true,
      'Classification skipped (skipClassify: true)'
    );
    return;
  }

  const inWorktree = (): boolean => true;
  const classifyResult = await classifyStatements(
    worktree.path,
    context.agent,
    context.configLoader,
    inWorktree
  );

  const classifyParsed = JSON.parse(classifyResult);
  const success = classifyParsed.success !== false;

  let message = success ? 'Classification complete' : 'Classification had issues';

  if (classifyParsed.unrecognized?.length > 0) {
    message = `Classification complete with ${classifyParsed.unrecognized.length} unrecognized file(s)`;
  }

  const details: ClassifyStepDetails = {
    success,
    unrecognized: classifyParsed.unrecognized,
    classified: classifyParsed,
  };

  context.result.steps.classify = buildStepResult<ClassifyStepDetails>(success, message, details);
}

/**
 * Executes the dry run step
 */
export async function executeDryRunStep(
  context: PipelineContext,
  worktree: WorktreeContext
): Promise<void> {
  const inWorktree = (): boolean => true;
  const dryRunResult = await importStatements(
    worktree.path,
    context.agent,
    {
      provider: context.options.provider,
      currency: context.options.currency,
      checkOnly: true,
    },
    context.configLoader,
    context.hledgerExecutor,
    inWorktree
  );

  const dryRunParsed = JSON.parse(dryRunResult);
  const message = dryRunParsed.success
    ? `Dry run passed: ${dryRunParsed.summary?.totalTransactions || 0} transactions ready`
    : `Dry run failed: ${dryRunParsed.summary?.unknown || 0} unknown account(s)`;

  context.result.steps.dryRun = buildStepResult<DryRunStepDetails>(dryRunParsed.success, message, {
    success: dryRunParsed.success,
    summary: dryRunParsed.summary,
  });

  if (!dryRunParsed.success) {
    context.result.error = 'Dry run found unknown accounts or errors';
    context.result.hint = 'Add rules to categorize unknown transactions, then retry';
    throw new Error('Dry run failed');
  }

  // Early exit if no transactions
  if (dryRunParsed.summary?.totalTransactions === 0) {
    throw new NoTransactionsError();
  }
}

/**
 * Executes the import step
 */
export async function executeImportStep(
  context: PipelineContext,
  worktree: WorktreeContext
): Promise<void> {
  const inWorktree = (): boolean => true;
  const importResult = await importStatements(
    worktree.path,
    context.agent,
    {
      provider: context.options.provider,
      currency: context.options.currency,
      checkOnly: false,
    },
    context.configLoader,
    context.hledgerExecutor,
    inWorktree
  );

  const importParsed = JSON.parse(importResult);
  const message = importParsed.success
    ? `Imported ${importParsed.summary?.totalTransactions || 0} transactions`
    : `Import failed: ${importParsed.error || 'Unknown error'}`;

  context.result.steps.import = buildStepResult<ImportStepDetails>(importParsed.success, message, {
    success: importParsed.success,
    summary: importParsed.summary,
    error: importParsed.error,
  });

  if (!importParsed.success) {
    context.result.error = `Import failed: ${importParsed.error || 'Unknown error'}`;
    throw new Error('Import failed');
  }
}

/**
 * Executes the reconcile step
 */
export async function executeReconcileStep(
  context: PipelineContext,
  worktree: WorktreeContext
): Promise<void> {
  const inWorktree = (): boolean => true;
  const reconcileResult = await reconcileStatement(
    worktree.path,
    context.agent,
    {
      provider: context.options.provider,
      currency: context.options.currency,
      closingBalance: context.options.closingBalance,
      account: context.options.account,
    },
    context.configLoader,
    context.hledgerExecutor,
    inWorktree
  );

  const reconcileParsed = JSON.parse(reconcileResult);
  const message = reconcileParsed.success
    ? `Balance reconciled: ${reconcileParsed.actualBalance}`
    : `Balance mismatch: expected ${reconcileParsed.expectedBalance}, got ${reconcileParsed.actualBalance}`;

  context.result.steps.reconcile = buildStepResult<ReconcileStepDetails>(
    reconcileParsed.success,
    message,
    {
      success: reconcileParsed.success,
      actualBalance: reconcileParsed.actualBalance,
      expectedBalance: reconcileParsed.expectedBalance,
      metadata: reconcileParsed.metadata,
      error: reconcileParsed.error,
    }
  );

  if (!reconcileParsed.success) {
    context.result.error = `Reconciliation failed: ${reconcileParsed.error || 'Balance mismatch'}`;
    context.result.hint = 'Check for missing transactions or incorrect rules';
    throw new Error('Reconciliation failed');
  }
}

/**
 * Executes the merge step
 */
export async function executeMergeStep(
  context: PipelineContext,
  worktree: WorktreeContext
): Promise<void> {
  const importDetails = context.result.steps.import?.details;
  const reconcileDetails = context.result.steps.reconcile?.details;

  if (!importDetails || !reconcileDetails) {
    throw new Error('Import or reconcile step not completed before merge');
  }

  const commitInfo = {
    fromDate: reconcileDetails.metadata?.from_date,
    untilDate: reconcileDetails.metadata?.until_date,
  };
  const transactionCount = importDetails.summary?.totalTransactions || 0;

  const commitMessage = buildCommitMessage(
    context.options.provider,
    context.options.currency,
    commitInfo.fromDate,
    commitInfo.untilDate,
    transactionCount
  );

  try {
    mergeWorktree(worktree, commitMessage);
    const mergeDetails: MergeStepDetails = { commitMessage };
    context.result.steps.merge = buildStepResult<MergeStepDetails>(
      true,
      `Merged to main: "${commitMessage}"`,
      mergeDetails
    );

    // Cleanup original files from main repo's incoming directory after successful merge
    cleanupIncomingFiles(worktree, context);
  } catch (error) {
    const message = `Merge failed: ${error instanceof Error ? error.message : String(error)}`;
    context.result.steps.merge = buildStepResult(false, message);
    context.result.error = 'Merge to main branch failed';
    throw new Error('Merge failed');
  }
}

/**
 * Handles the no transactions scenario
 */
function handleNoTransactions(result: ImportPipelineResult): string {
  result.steps.import = buildStepResult(true, 'No transactions to import');
  result.steps.reconcile = buildStepResult(true, 'Reconciliation skipped (no transactions)');
  result.steps.merge = buildStepResult(true, 'Merge skipped (no changes)');

  return buildSuccessResult(result, 'No transactions found to import');
}

/**
 * Implementation of the import-pipeline tool
 */
export async function importPipeline(
  directory: string,
  agent: string,
  options: ImportPipelineArgs,
  configLoader: (_configDir: string) => ImportConfig = loadImportConfig,
  hledgerExecutor: HledgerExecutor = defaultHledgerExecutor
): Promise<string> {
  // Early return for agent restriction
  const restrictionError = checkAccountantAgent(agent, 'import pipeline');
  if (restrictionError) {
    return restrictionError;
  }

  const result: ImportPipelineResult = {
    success: false,
    steps: {},
  };

  const context: PipelineContext = {
    directory,
    agent,
    options,
    configLoader,
    hledgerExecutor,
    result,
  };

  try {
    return await withWorktree(directory, async (worktree) => {
      result.worktreeId = worktree.uuid;
      result.steps.worktree = buildStepResult(true, `Created worktree at ${worktree.path}`, {
        path: worktree.path,
        branch: worktree.branch,
      });

      // Sync CSV files from main repo to worktree
      try {
        const config = configLoader(directory);
        const syncResult = syncCSVFilesToWorktree(directory, worktree.path, config.paths.import);

        if (syncResult.synced.length === 0 && syncResult.errors.length === 0) {
          result.steps.sync = buildStepResult<SyncStepDetails>(true, 'No CSV files to sync', {
            synced: [],
          });
        } else if (syncResult.errors.length > 0) {
          result.steps.sync = buildStepResult<SyncStepDetails>(
            true,
            `Synced ${syncResult.synced.length} file(s) with ${syncResult.errors.length} error(s)`,
            { synced: syncResult.synced, errors: syncResult.errors }
          );
        } else {
          result.steps.sync = buildStepResult<SyncStepDetails>(
            true,
            `Synced ${syncResult.synced.length} CSV file(s) to worktree`,
            { synced: syncResult.synced }
          );
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.steps.sync = buildStepResult<SyncStepDetails>(
          false,
          `Failed to sync CSV files: ${errorMsg}`,
          { synced: [], errors: [{ file: 'unknown', error: errorMsg }] }
        );
      }

      try {
        await executeClassifyStep(context, worktree);
        await executeDryRunStep(context, worktree);
        await executeImportStep(context, worktree);
        await executeReconcileStep(context, worktree);

        // Cleanup CSV files from main repo after successful reconciliation
        try {
          const config = configLoader(directory);
          const cleanupResult = cleanupProcessedCSVFiles(directory, config.paths.import);

          if (cleanupResult.deleted.length === 0 && cleanupResult.errors.length === 0) {
            result.steps.cleanup = buildStepResult<CleanupStepDetails>(
              true,
              'No CSV files to cleanup',
              { csvCleanup: { deleted: [] } }
            );
          } else if (cleanupResult.errors.length > 0) {
            result.steps.cleanup = buildStepResult<CleanupStepDetails>(
              true,
              `Deleted ${cleanupResult.deleted.length} CSV file(s) with ${cleanupResult.errors.length} error(s)`,
              {
                csvCleanup: {
                  deleted: cleanupResult.deleted,
                  errors: cleanupResult.errors,
                },
              }
            );
          } else {
            result.steps.cleanup = buildStepResult<CleanupStepDetails>(
              true,
              `Deleted ${cleanupResult.deleted.length} CSV file(s) from main repo`,
              { csvCleanup: { deleted: cleanupResult.deleted } }
            );
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.steps.cleanup = buildStepResult<CleanupStepDetails>(
            false,
            `Failed to cleanup CSV files: ${errorMsg}`,
            {
              csvCleanup: {
                deleted: [],
                errors: [{ file: 'unknown', error: errorMsg }],
              },
            }
          );
        }

        await executeMergeStep(context, worktree);

        // Update cleanup step to include worktree cleanup status
        const existingCleanup = result.steps.cleanup;
        if (existingCleanup) {
          existingCleanup.message += ', worktree cleaned up';
          existingCleanup.details = {
            ...existingCleanup.details,
            cleanedAfterSuccess: true,
          };
        }

        const transactionCount =
          context.result.steps.import?.details?.summary?.totalTransactions || 0;
        return buildSuccessResult(
          result,
          `Successfully imported ${transactionCount} transaction(s)`
        );
      } catch (error) {
        result.steps.cleanup = buildStepResult<CleanupStepDetails>(
          true,
          'Worktree cleaned up after failure (CSV files preserved for retry)',
          {
            cleanedAfterFailure: true,
            csvCleanup: { deleted: [] },
          }
        );

        if (error instanceof NoTransactionsError) {
          return handleNoTransactions(result);
        }

        if (!result.error) {
          result.error = error instanceof Error ? error.message : String(error);
        }

        return buildErrorResult(result, result.error, result.hint);
      }
    });
  } catch (error) {
    // Worktree creation failed
    result.steps.worktree = buildStepResult(
      false,
      `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
    );
    result.error = 'Failed to create worktree';
    return buildErrorResult(result, result.error);
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
    return importPipeline(directory, agent, {
      provider: params.provider,
      currency: params.currency,
      closingBalance: params.closingBalance,
      account: params.account,
      skipClassify: params.skipClassify,
    });
  },
});
