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
import { findRulesForCsv, loadRulesMapping } from '../utils/rulesMatcher.ts';
import { ensureYearJournalExists, findCsvFiles } from '../utils/journalUtils.ts';
import { extractTransactionYears } from '../utils/hledgerExecutor.ts';
import {
  getAllAccountsFromRules,
  ensureAccountDeclarations,
} from '../utils/accountDeclarations.ts';
import { createImportLogger, type Logger } from '../utils/logger.js';

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
  /** Keep worktree on error for debugging (default: true) */
  keepWorktreeOnError?: boolean;
}

/**
 * Details for worktree creation step result
 */
interface WorktreeStepDetails {
  path: string;
  branch: string;
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
 * Details for account declarations step result
 */
interface AccountDeclarationsStepDetails {
  accountsAdded: string[];
  journalUpdated: string;
  rulesScanned: string[];
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
    'from-date'?: string;
    'until-date'?: string;
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
  worktreePreserved?: boolean;
  worktreePath?: string;
  preserveReason?: string;
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
    worktree?: StepResult<WorktreeStepDetails>;
    sync?: StepResult<SyncStepDetails>;
    classify?: StepResult<ClassifyStepDetails>;
    accountDeclarations?: StepResult<AccountDeclarationsStepDetails>;
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
      const data = parsed as { metadata?: { 'from-date'?: string; 'until-date'?: string } };
      return {
        fromDate: data.metadata?.['from-date'],
        untilDate: data.metadata?.['until-date'],
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
  worktree: WorktreeContext,
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 2: Classify Transactions');
  logger?.logStep('Classify', 'start');

  if (context.options.skipClassify) {
    logger?.info('Classification skipped (skipClassify: true)');
    context.result.steps.classify = buildStepResult(
      true,
      'Classification skipped (skipClassify: true)'
    );
    logger?.endSection();
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
    logger?.warn(`${classifyParsed.unrecognized.length} unrecognized file(s)`);
  }

  logger?.logStep('Classify', success ? 'success' : 'error', message);

  const details: ClassifyStepDetails = {
    success,
    unrecognized: classifyParsed.unrecognized,
    classified: classifyParsed,
  };

  context.result.steps.classify = buildStepResult<ClassifyStepDetails>(success, message, details);
  logger?.endSection();
}

/**
 * Executes the account declarations step
 * Scans matched rules files and ensures all required accounts are declared in year journal
 */
export async function executeAccountDeclarationsStep(
  context: PipelineContext,
  worktree: WorktreeContext,
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 3: Check Account Declarations');
  logger?.logStep('Check Accounts', 'start');
  const config = context.configLoader(worktree.path);
  const pendingDir = path.join(worktree.path, config.paths.pending);
  const rulesDir = path.join(worktree.path, config.paths.rules);

  // Find CSV files to process
  const csvFiles = findCsvFiles(pendingDir, context.options.provider, context.options.currency);

  if (csvFiles.length === 0) {
    context.result.steps.accountDeclarations = buildStepResult<AccountDeclarationsStepDetails>(
      true,
      'No CSV files to process',
      {
        accountsAdded: [],
        journalUpdated: '',
        rulesScanned: [],
      }
    );
    return;
  }

  // Load rules mapping and find matched rules files
  const rulesMapping = loadRulesMapping(rulesDir);
  const matchedRulesFiles = new Set<string>();

  for (const csvFile of csvFiles) {
    const rulesFile = findRulesForCsv(csvFile, rulesMapping);
    if (rulesFile) {
      matchedRulesFiles.add(rulesFile);
    }
  }

  if (matchedRulesFiles.size === 0) {
    context.result.steps.accountDeclarations = buildStepResult<AccountDeclarationsStepDetails>(
      true,
      'No matching rules files found',
      {
        accountsAdded: [],
        journalUpdated: '',
        rulesScanned: [],
      }
    );
    return;
  }

  // Extract all accounts from matched rules files
  const allAccounts = getAllAccountsFromRules(Array.from(matchedRulesFiles));

  if (allAccounts.size === 0) {
    context.result.steps.accountDeclarations = buildStepResult<AccountDeclarationsStepDetails>(
      true,
      'No accounts found in rules files',
      {
        accountsAdded: [],
        journalUpdated: '',
        rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(worktree.path, f)),
      }
    );
    return;
  }

  // Determine transaction year from first CSV (assuming single-year constraint)
  // We need to parse at least one CSV to determine the year
  let transactionYear: number | undefined;

  for (const rulesFile of matchedRulesFiles) {
    try {
      const result = await context.hledgerExecutor(['print', '-f', rulesFile]);
      if (result.exitCode === 0) {
        const years = extractTransactionYears(result.stdout);
        if (years.size > 0) {
          transactionYear = Array.from(years)[0];
          break;
        }
      }
    } catch {
      // Continue to next rules file
      continue;
    }
  }

  if (!transactionYear) {
    context.result.steps.accountDeclarations = buildStepResult<AccountDeclarationsStepDetails>(
      false,
      'Could not determine transaction year from CSV files',
      {
        accountsAdded: [],
        journalUpdated: '',
        rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(worktree.path, f)),
      }
    );
    return;
  }

  // Ensure year journal exists
  let yearJournalPath: string;
  try {
    yearJournalPath = ensureYearJournalExists(worktree.path, transactionYear);
  } catch (error) {
    context.result.steps.accountDeclarations = buildStepResult<AccountDeclarationsStepDetails>(
      false,
      `Failed to create year journal: ${error instanceof Error ? error.message : String(error)}`,
      {
        accountsAdded: [],
        journalUpdated: '',
        rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(worktree.path, f)),
      }
    );
    return;
  }

  // Add account declarations to year journal
  const result = ensureAccountDeclarations(yearJournalPath, allAccounts);

  const message =
    result.added.length > 0
      ? `Added ${result.added.length} account declaration(s) to ${path.relative(worktree.path, yearJournalPath)}`
      : 'All required accounts already declared';

  logger?.logStep('Check Accounts', 'success', message);
  if (result.added.length > 0) {
    for (const account of result.added) {
      logger?.info(`  - ${account}`);
    }
  }

  context.result.steps.accountDeclarations = buildStepResult<AccountDeclarationsStepDetails>(
    true,
    message,
    {
      accountsAdded: result.added,
      journalUpdated: path.relative(worktree.path, yearJournalPath),
      rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(worktree.path, f)),
    }
  );
  logger?.endSection();
}

/**
 * Executes the dry run step
 */
export async function executeDryRunStep(
  context: PipelineContext,
  worktree: WorktreeContext,
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 4: Dry Run Import');
  logger?.logStep('Dry Run', 'start');
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

  logger?.logStep('Dry Run', dryRunParsed.success ? 'success' : 'error', message);
  if (dryRunParsed.summary?.totalTransactions) {
    logger?.info(`Found ${dryRunParsed.summary.totalTransactions} transactions`);
  }

  context.result.steps.dryRun = buildStepResult<DryRunStepDetails>(dryRunParsed.success, message, {
    success: dryRunParsed.success,
    summary: dryRunParsed.summary,
  });

  if (!dryRunParsed.success) {
    logger?.error('Dry run found unknown accounts or errors');
    logger?.endSection();
    context.result.error = 'Dry run found unknown accounts or errors';
    context.result.hint = 'Add rules to categorize unknown transactions, then retry';
    throw new Error('Dry run failed');
  }

  // Early exit if no transactions
  if (dryRunParsed.summary?.totalTransactions === 0) {
    logger?.endSection();
    throw new NoTransactionsError();
  }

  logger?.endSection();
}

/**
 * Executes the import step
 */
export async function executeImportStep(
  context: PipelineContext,
  worktree: WorktreeContext,
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 5: Import Transactions');
  logger?.logStep('Import', 'start');
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

  logger?.logStep('Import', importParsed.success ? 'success' : 'error', message);

  context.result.steps.import = buildStepResult<ImportStepDetails>(importParsed.success, message, {
    success: importParsed.success,
    summary: importParsed.summary,
    error: importParsed.error,
  });

  if (!importParsed.success) {
    logger?.error('Import failed', new Error(importParsed.error || 'Unknown error'));
    logger?.endSection();
    context.result.error = `Import failed: ${importParsed.error || 'Unknown error'}`;
    throw new Error('Import failed');
  }

  logger?.endSection();
}

/**
 * Executes the reconcile step
 */
export async function executeReconcileStep(
  context: PipelineContext,
  worktree: WorktreeContext,
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 6: Reconcile Balance');
  logger?.logStep('Reconcile', 'start');
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

  logger?.logStep('Reconcile', reconcileParsed.success ? 'success' : 'error', message);
  if (reconcileParsed.success) {
    logger?.info(`Actual: ${reconcileParsed.actualBalance}`);
    logger?.info(`Expected: ${reconcileParsed.expectedBalance}`);
  }

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
    logger?.error('Reconciliation failed', new Error(reconcileParsed.error || 'Balance mismatch'));
    logger?.endSection();
    context.result.error = `Reconciliation failed: ${reconcileParsed.error || 'Balance mismatch'}`;
    context.result.hint = 'Check for missing transactions or incorrect rules';
    throw new Error('Reconciliation failed');
  }

  logger?.endSection();
}

/**
 * Executes the merge step
 */
export async function executeMergeStep(
  context: PipelineContext,
  worktree: WorktreeContext,
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 7: Merge to Main');
  logger?.logStep('Merge', 'start');
  const importDetails = context.result.steps.import?.details;
  const reconcileDetails = context.result.steps.reconcile?.details;

  if (!importDetails || !reconcileDetails) {
    throw new Error('Import or reconcile step not completed before merge');
  }

  const commitInfo = {
    fromDate: reconcileDetails.metadata?.['from-date'],
    untilDate: reconcileDetails.metadata?.['until-date'],
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
    logger?.info(`Commit message: "${commitMessage}"`);
    mergeWorktree(worktree, commitMessage);
    logger?.logStep('Merge', 'success', 'Merged to main branch');

    const mergeDetails: MergeStepDetails = { commitMessage };
    context.result.steps.merge = buildStepResult<MergeStepDetails>(
      true,
      `Merged to main: "${commitMessage}"`,
      mergeDetails
    );

    // Cleanup original files from main repo's incoming directory after successful merge
    cleanupIncomingFiles(worktree, context);
    logger?.endSection();
  } catch (error) {
    logger?.logStep('Merge', 'error');
    logger?.error('Merge to main branch failed', error);
    logger?.endSection();
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

  // Create logger for this import run
  const logger = createImportLogger(directory, undefined, options.provider);

  logger.startSection('Import Pipeline', 1);
  logger.info(`Provider filter: ${options.provider || 'all'}`);
  logger.info(`Currency filter: ${options.currency || 'all'}`);
  logger.info(`Skip classify: ${options.skipClassify || false}`);
  logger.info(`Keep worktree on error: ${options.keepWorktreeOnError ?? true}`);
  logger.info('');

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
    return await withWorktree(
      directory,
      async (worktree) => {
        // Set logger context with worktree info
        logger.setContext('worktreeId', worktree.uuid);
        logger.setContext('worktreePath', worktree.path);
        result.worktreeId = worktree.uuid;
        result.steps.worktree = buildStepResult(true, `Created worktree at ${worktree.path}`, {
          path: worktree.path,
          branch: worktree.branch,
        });

        // Sync CSV files from main repo to worktree
        logger.startSection('Step 1: Sync Files');
        logger.logStep('Sync Files', 'start');
        try {
          const config = configLoader(directory);
          const syncResult = syncCSVFilesToWorktree(directory, worktree.path, config.paths.import);

          if (syncResult.synced.length === 0 && syncResult.errors.length === 0) {
            logger.logStep('Sync Files', 'success', 'No CSV files to sync');
            result.steps.sync = buildStepResult<SyncStepDetails>(true, 'No CSV files to sync', {
              synced: [],
            });
          } else if (syncResult.errors.length > 0) {
            logger.warn(
              `Synced ${syncResult.synced.length} file(s) with ${syncResult.errors.length} error(s)`
            );
            result.steps.sync = buildStepResult<SyncStepDetails>(
              true,
              `Synced ${syncResult.synced.length} file(s) with ${syncResult.errors.length} error(s)`,
              { synced: syncResult.synced, errors: syncResult.errors }
            );
          } else {
            logger.logStep(
              'Sync Files',
              'success',
              `Synced ${syncResult.synced.length} CSV file(s)`
            );
            for (const file of syncResult.synced) {
              logger.info(`  - ${file}`);
            }
            result.steps.sync = buildStepResult<SyncStepDetails>(
              true,
              `Synced ${syncResult.synced.length} CSV file(s) to worktree`,
              { synced: syncResult.synced }
            );
          }
          logger.endSection();
        } catch (error) {
          logger.logStep('Sync Files', 'error');
          logger.error('Failed to sync CSV files', error);
          logger.endSection();
          const errorMsg = error instanceof Error ? error.message : String(error);
          result.steps.sync = buildStepResult<SyncStepDetails>(
            false,
            `Failed to sync CSV files: ${errorMsg}`,
            { synced: [], errors: [{ file: 'unknown', error: errorMsg }] }
          );
        }

        try {
          await executeClassifyStep(context, worktree, logger);
          await executeAccountDeclarationsStep(context, worktree, logger);
          await executeDryRunStep(context, worktree, logger);
          await executeImportStep(context, worktree, logger);
          await executeReconcileStep(context, worktree, logger);

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

          await executeMergeStep(context, worktree, logger);

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

          // Log final summary
          logger.startSection('Summary');
          logger.info(`✅ Import completed successfully`);
          logger.info(`Total transactions imported: ${transactionCount}`);
          if (context.result.steps.reconcile?.details?.actualBalance) {
            logger.info(
              `Balance reconciliation: ✅ Matched (${context.result.steps.reconcile.details.actualBalance})`
            );
          }
          logger.info(`Log file: ${logger.getLogPath()}`);
          logger.endSection();

          return buildSuccessResult(
            result,
            `Successfully imported ${transactionCount} transaction(s)`
          );
        } catch (error) {
          const worktreePath = context.result.steps.worktree?.details?.path;
          const keepWorktree = options.keepWorktreeOnError ?? true;

          logger.error('Pipeline step failed', error);

          if (keepWorktree && worktreePath) {
            logger.warn(`Worktree preserved at: ${worktreePath}`);
            logger.info(`To continue manually: cd ${worktreePath}`);
            logger.info(`To clean up: git worktree remove ${worktreePath}`);
          }

          logger.info(`Log file: ${logger.getLogPath()}`);

          result.steps.cleanup = buildStepResult<CleanupStepDetails>(
            true,
            keepWorktree
              ? `Worktree preserved for debugging (CSV files preserved for retry)`
              : 'Worktree cleaned up after failure (CSV files preserved for retry)',
            {
              cleanedAfterFailure: !keepWorktree,
              worktreePreserved: keepWorktree,
              worktreePath: worktreePath,
              preserveReason: keepWorktree ? 'error occurred' : undefined,
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
      },
      {
        keepOnError: options.keepWorktreeOnError ?? true,
        logger: logger,
      }
    );
  } catch (error) {
    logger.error('Pipeline failed', error);
    // Worktree creation failed
    result.steps.worktree = buildStepResult(
      false,
      `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
    );
    result.error = 'Failed to create worktree';
    return buildErrorResult(result, result.error);
  } finally {
    logger.endSection();
    await logger.flush();
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
7. **Cleanup**: Removes worktree (or preserves on error)

**Safety Features:**
- All changes happen in isolated worktree
- If any step fails, worktree is preserved by default for debugging
- Balance reconciliation ensures data integrity
- Atomic commit with merge --no-ff preserves history

**Worktree Cleanup:**
- On success: Worktree is always cleaned up
- On error (default): Worktree is kept at /tmp/import-worktree-<uuid> for debugging
- On error (--keepWorktreeOnError false): Worktree is removed (old behavior)
- Manual cleanup: git worktree remove /tmp/import-worktree-<uuid>
- Auto cleanup: System reboot (worktrees are in /tmp)

**Logging:**
- All operations are logged to .memory/import-<timestamp>.md
- Log includes full command output, timing, and error details
- Log path is included in tool output for easy access
- NO console output (avoids polluting OpenCode TUI)

**Usage:**
- Basic: import-pipeline (processes all pending CSVs)
- Filtered: import-pipeline --provider ubs --currency chf
- With manual balance: import-pipeline --closingBalance "CHF 1234.56"
- Skip classify: import-pipeline --skipClassify true
- Always cleanup: import-pipeline --keepWorktreeOnError false`,
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
    keepWorktreeOnError: tool.schema
      .boolean()
      .optional()
      .describe('Keep worktree on error for debugging (default: true)'),
  },
  async execute(params, context) {
    const { directory, agent } = context;
    return importPipeline(directory, agent, {
      provider: params.provider,
      currency: params.currency,
      closingBalance: params.closingBalance,
      account: params.account,
      skipClassify: params.skipClassify,
      keepWorktreeOnError: params.keepWorktreeOnError,
    });
  },
});
