import { tool } from '@opencode-ai/plugin';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { loadImportConfig, type ImportConfig } from '../utils/importConfig.ts';
import { classifyStatements } from './classify-statements.ts';
import { importStatements } from './import-statements.ts';
import { reconcileStatement } from './reconcile-statement.ts';
import { defaultHledgerExecutor, type HledgerExecutor } from '../utils/hledgerExecutor.ts';
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
  unknownPostings?: import('../utils/hledgerExecutor.ts').UnknownPostingWithSuggestion[];
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
  steps: {
    classify?: StepResult<ClassifyStepDetails>;
    accountDeclarations?: StepResult<AccountDeclarationsStepDetails>;
    dryRun?: StepResult<DryRunStepDetails>;
    import?: StepResult<ImportStepDetails>;
    reconcile?: StepResult<ReconcileStepDetails>;
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
 * Executes the classify step
 */
export async function executeClassifyStep(
  context: PipelineContext,
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 1: Classify Transactions');
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

  const classifyResult = await classifyStatements(
    context.directory,
    context.agent,
    context.configLoader
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
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 2: Check Account Declarations');
  logger?.logStep('Check Accounts', 'start');
  const config = context.configLoader(context.directory);
  const pendingDir = path.join(context.directory, config.paths.pending);
  const rulesDir = path.join(context.directory, config.paths.rules);

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
        rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(context.directory, f)),
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
        rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(context.directory, f)),
      }
    );
    return;
  }

  // Ensure year journal exists
  let yearJournalPath: string;
  try {
    yearJournalPath = ensureYearJournalExists(context.directory, transactionYear);
  } catch (error) {
    context.result.steps.accountDeclarations = buildStepResult<AccountDeclarationsStepDetails>(
      false,
      `Failed to create year journal: ${error instanceof Error ? error.message : String(error)}`,
      {
        accountsAdded: [],
        journalUpdated: '',
        rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(context.directory, f)),
      }
    );
    return;
  }

  // Add account declarations to year journal
  const result = ensureAccountDeclarations(yearJournalPath, allAccounts);

  const message =
    result.added.length > 0
      ? `Added ${result.added.length} account declaration(s) to ${path.relative(context.directory, yearJournalPath)}`
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
      journalUpdated: path.relative(context.directory, yearJournalPath),
      rulesScanned: Array.from(matchedRulesFiles).map((f) => path.relative(context.directory, f)),
    }
  );
  logger?.endSection();
}

/**
 * Executes the dry run step
 */
export async function executeDryRunStep(context: PipelineContext, logger?: Logger): Promise<void> {
  logger?.startSection('Step 3: Dry Run Import');
  logger?.logStep('Dry Run', 'start');
  const dryRunResult = await importStatements(
    context.directory,
    context.agent,
    {
      provider: context.options.provider,
      currency: context.options.currency,
      checkOnly: true,
    },
    context.configLoader,
    context.hledgerExecutor
  );

  const dryRunParsed = JSON.parse(dryRunResult);
  const message = dryRunParsed.success
    ? `Dry run passed: ${dryRunParsed.summary?.totalTransactions || 0} transactions ready`
    : `Dry run failed: ${dryRunParsed.summary?.unknown || 0} unknown account(s)`;

  logger?.logStep('Dry Run', dryRunParsed.success ? 'success' : 'error', message);
  if (dryRunParsed.summary?.totalTransactions) {
    logger?.info(`Found ${dryRunParsed.summary.totalTransactions} transactions`);
  }

  // Collect unknown postings and generate suggestions if dry run failed
  let postingsWithSuggestions: import('../utils/hledgerExecutor.ts').UnknownPostingWithSuggestion[] =
    [];
  if (!dryRunParsed.success) {
    const allUnknownPostings: import('../utils/hledgerExecutor.ts').UnknownPosting[] = [];
    for (const file of dryRunParsed.files ?? []) {
      if (file.unknownPostings && file.unknownPostings.length > 0) {
        allUnknownPostings.push(...file.unknownPostings);
      }
    }

    if (allUnknownPostings.length > 0) {
      try {
        const {
          suggestAccountsForPostingsBatch,
          loadExistingAccounts,
          extractRulePatternsFromFile,
        } = await import('../utils/accountSuggester.ts');

        // Determine year journal path (same logic as account declarations step)
        const config = context.configLoader(context.directory);
        const pendingDir = path.join(context.directory, config.paths.pending);
        const rulesDir = path.join(context.directory, config.paths.rules);
        const csvFiles = findCsvFiles(
          pendingDir,
          context.options.provider,
          context.options.currency
        );
        const rulesMapping = loadRulesMapping(rulesDir);

        let yearJournalPath: string | undefined;
        let firstRulesFile: string | undefined;

        // Find first CSV with rules to determine year
        for (const csvFile of csvFiles) {
          const rulesFile = findRulesForCsv(csvFile, rulesMapping);
          if (rulesFile) {
            firstRulesFile = rulesFile;
            try {
              const result = await context.hledgerExecutor(['print', '-f', rulesFile]);
              if (result.exitCode === 0) {
                const years = extractTransactionYears(result.stdout);
                if (years.size > 0) {
                  const transactionYear = Array.from(years)[0];
                  yearJournalPath = ensureYearJournalExists(context.directory, transactionYear);
                  break;
                }
              }
            } catch {
              continue;
            }
          }
        }

        const suggestionContext = {
          existingAccounts: yearJournalPath ? await loadExistingAccounts(yearJournalPath) : [],
          rulesFilePath: firstRulesFile,
          existingRules: firstRulesFile
            ? await extractRulePatternsFromFile(firstRulesFile)
            : undefined,
          yearJournalPath,
        };

        postingsWithSuggestions = await suggestAccountsForPostingsBatch(
          allUnknownPostings,
          suggestionContext
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          '[WARN] Failed to generate account suggestions:',
          error instanceof Error ? error.message : String(error)
        );
        // Continue without suggestions - they're helpful but not critical
        postingsWithSuggestions = allUnknownPostings;
      }
    }
  }

  context.result.steps.dryRun = buildStepResult<DryRunStepDetails>(dryRunParsed.success, message, {
    success: dryRunParsed.success,
    summary: dryRunParsed.summary,
    unknownPostings: postingsWithSuggestions.length > 0 ? postingsWithSuggestions : undefined,
  });

  if (!dryRunParsed.success) {
    // Log detailed unknown postings with suggestions
    if (postingsWithSuggestions.length > 0) {
      const detailsLog = formatUnknownPostingsLog(postingsWithSuggestions);
      logger?.error('Dry run found unknown accounts or errors');
      // eslint-disable-next-line no-console
      console.log(detailsLog);
    }

    logger?.endSection();
    context.result.error = 'Dry run found unknown accounts or errors';
    context.result.hint =
      'Add rules to categorize unknown transactions, then retry. See details above for suggestions.';
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
 * Format unknown postings with suggestions for logging
 */
function formatUnknownPostingsLog(
  postings: import('../utils/hledgerExecutor.ts').UnknownPostingWithSuggestion[]
): string {
  if (postings.length === 0) return '';

  let log = '\n=== Unknown Postings Details ===\n\n';

  for (const posting of postings) {
    log += `📅 ${posting.date} | ${posting.description}\n`;
    log += `   Amount: ${posting.amount} → ${posting.account}\n`;

    if (posting.suggestedAccount) {
      const icon =
        posting.suggestionConfidence === 'high'
          ? '✅'
          : posting.suggestionConfidence === 'medium'
            ? '⚠️'
            : '💡';
      log += `   ${icon} Suggested: ${posting.suggestedAccount} (${posting.suggestionConfidence})\n`;
      if (posting.suggestionReasoning) {
        log += `      ${posting.suggestionReasoning}\n`;
      }
    }

    if (posting.csvRow) {
      log += `   CSV: ${JSON.stringify(posting.csvRow, null, 2).split('\n').join('\n        ')}\n`;
    }

    log += '\n';
  }

  log += '=== End Unknown Postings ===\n';
  return log;
}

/**
 * Executes the import step
 */
export async function executeImportStep(context: PipelineContext, logger?: Logger): Promise<void> {
  logger?.startSection('Step 4: Import Transactions');
  logger?.logStep('Import', 'start');
  const importResult = await importStatements(
    context.directory,
    context.agent,
    {
      provider: context.options.provider,
      currency: context.options.currency,
      checkOnly: false,
    },
    context.configLoader,
    context.hledgerExecutor
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
  logger?: Logger
): Promise<void> {
  logger?.startSection('Step 5: Reconcile Balance');
  logger?.logStep('Reconcile', 'start');
  const reconcileResult = await reconcileStatement(
    context.directory,
    context.agent,
    {
      provider: context.options.provider,
      currency: context.options.currency,
      closingBalance: context.options.closingBalance,
      account: context.options.account,
    },
    context.configLoader,
    context.hledgerExecutor
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
 * Handles the no transactions scenario
 */
function handleNoTransactions(result: ImportPipelineResult): string {
  result.steps.import = buildStepResult(true, 'No transactions to import');
  result.steps.reconcile = buildStepResult(true, 'Reconciliation skipped (no transactions)');

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
    await executeClassifyStep(context, logger);
    await executeAccountDeclarationsStep(context, logger);
    await executeDryRunStep(context, logger);
    await executeImportStep(context, logger);
    await executeReconcileStep(context, logger);

    const transactionCount = context.result.steps.import?.details?.summary?.totalTransactions || 0;

    // Log final summary
    logger.startSection('Summary');
    logger.info(`Import completed successfully`);
    logger.info(`Total transactions imported: ${transactionCount}`);
    if (context.result.steps.reconcile?.details?.actualBalance) {
      logger.info(`Balance: ${context.result.steps.reconcile.details.actualBalance}`);
    }
    logger.info(`Log file: ${logger.getLogPath()}`);
    logger.endSection();

    return buildSuccessResult(result, `Successfully imported ${transactionCount} transaction(s)`);
  } catch (error) {
    logger.error('Pipeline step failed', error);
    logger.info(`Log file: ${logger.getLogPath()}`);

    if (error instanceof NoTransactionsError) {
      return handleNoTransactions(result);
    }

    if (!result.error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return buildErrorResult(result, result.error, result.hint);
  } finally {
    logger.endSection();
    await logger.flush();
  }
}

export default tool({
  description: `ACCOUNTANT AGENT ONLY: Complete import pipeline with balance reconciliation.

This tool orchestrates the full import workflow:

**Pipeline Steps:**
1. **Classify**: Moves CSVs from import/incoming to import/pending (optional, skip with skipClassify)
2. **Account Declarations**: Ensures all required accounts are declared in year journal
3. **Dry Run**: Validates all transactions have known accounts
4. **Import**: Imports transactions to the journal (moves CSVs to import/done)
5. **Reconcile**: Validates closing balance matches CSV metadata

**Important:**
- All changes remain uncommitted in your working directory
- If any step fails, changes remain in place for inspection
- CSV files move from incoming/ → pending/ → done/ during the process

**Logging:**
- All operations logged to .memory/import-<timestamp>.md
- Log includes command output, timing, and error details

**Usage:**
- Basic: import-pipeline (processes all CSVs in incoming/)
- Filtered: import-pipeline --provider ubs --currency chf
- Manual balance: import-pipeline --closingBalance "CHF 1234.56"
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
