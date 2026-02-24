import { tool } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { type ImportConfig, loadImportConfig } from '../utils/importConfig.ts';
import { findRulesForCsv, loadRulesMapping } from '../utils/rulesMatcher.ts';
import { getAccountFromRulesFile } from '../utils/rulesParser.ts';
import { isInWorktree } from '../utils/worktreeManager.ts';
import { detectProvider } from '../utils/providerDetector.ts';
import {
  defaultHledgerExecutor,
  type HledgerExecutor,
  getLastTransactionDate,
  getAccountBalance,
} from '../utils/hledgerExecutor.ts';
import { findCsvFiles } from '../utils/journalUtils.ts';
import { calculateDifference, balancesMatch } from '../utils/balanceUtils.ts';

/**
 * Arguments for the reconcile-statement tool
 */
interface ReconcileStatementsArgs {
  /** Filter by provider (e.g., "ubs", "revolut") */
  provider?: string;
  /** Filter by currency (e.g., "chf", "eur") */
  currency?: string;
  /** Manual closing balance override (if not in CSV metadata) */
  closingBalance?: string;
  /** Manual account override (if cannot be detected from rules file) */
  account?: string;
}

/**
 * CSV metadata extracted for reconciliation
 */
interface CsvMetadata {
  from_date?: string;
  until_date?: string;
  opening_balance?: string;
  closing_balance?: string;
  currency?: string;
  account_number?: string;
}

/**
 * Result of the reconcile-statement tool
 */
interface ReconcileResult {
  success: boolean;
  account: string;
  expectedBalance: string;
  actualBalance: string;
  difference?: string;
  lastTransactionDate: string;
  csvFile: string;
  metadata?: CsvMetadata;
  error?: string;
  hint?: string;
}

/**
 * Build an error result for the reconcile-statement tool.
 *
 * Creates a standardized JSON error response with optional context fields.
 *
 * @param params - Error result parameters
 * @param params.csvFile - Path to the CSV file being reconciled (optional)
 * @param params.account - The account being reconciled (optional)
 * @param params.lastTransactionDate - Date of last transaction (optional)
 * @param params.expectedBalance - Expected closing balance (optional)
 * @param params.actualBalance - Actual balance from hledger (optional)
 * @param params.difference - Calculated difference (optional)
 * @param params.metadata - CSV metadata (optional)
 * @param params.error - Error message (required)
 * @param params.hint - Helpful hint for resolving the error (optional)
 * @returns JSON string with success: false
 */
function buildErrorResult(params: {
  csvFile?: string;
  account?: string;
  lastTransactionDate?: string;
  expectedBalance?: string;
  actualBalance?: string;
  difference?: string;
  metadata?: CsvMetadata;
  error: string;
  hint?: string;
}): string {
  return JSON.stringify({
    success: false,
    ...params,
  } satisfies Partial<ReconcileResult>);
}

/**
 * Build a success result for the reconcile-statement tool.
 *
 * Creates a standardized JSON success response.
 *
 * @param params - Success result parameters
 * @param params.csvFile - Path to the CSV file being reconciled
 * @param params.account - The account being reconciled
 * @param params.lastTransactionDate - Date of last transaction
 * @param params.expectedBalance - Expected closing balance
 * @param params.actualBalance - Actual balance from hledger
 * @param params.metadata - CSV metadata (optional)
 * @returns JSON string with success: true
 */
function buildSuccessResult(params: {
  csvFile: string;
  account: string;
  lastTransactionDate: string;
  expectedBalance: string;
  actualBalance: string;
  metadata?: CsvMetadata;
}): string {
  return JSON.stringify({
    success: true,
    ...params,
  } satisfies ReconcileResult);
}

/**
 * Validate that the directory is an import worktree.
 *
 * Ensures the tool is being run in the correct context (inside an import worktree).
 *
 * @param directory - Directory to check
 * @param worktreeChecker - Function that checks if directory is a worktree
 * @returns Error result string if validation fails, null if valid
 */
function validateWorktree(
  directory: string,
  // eslint-disable-next-line no-unused-vars
  worktreeChecker: (dir: string) => boolean
): string | null {
  if (!worktreeChecker(directory)) {
    return buildErrorResult({
      error: 'reconcile-statement must be run inside an import worktree',
      hint: 'Use import-pipeline tool to orchestrate the full workflow',
    });
  }
  return null;
}

/**
 * Load import configuration from the directory.
 *
 * Attempts to load the import configuration file (providers.yaml).
 *
 * @param directory - Directory containing the configuration
 * @param configLoader - Function to load the configuration
 * @returns Config object on success, or error object with error message
 */
function loadConfiguration(
  directory: string,
  // eslint-disable-next-line no-unused-vars
  configLoader: (configDir: string) => ImportConfig
): { config: ImportConfig } | { error: string } {
  try {
    const config = configLoader(directory);
    return { config };
  } catch (error) {
    return {
      error: buildErrorResult({
        error: `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'Ensure config/import/providers.yaml exists',
      }),
    };
  }
}

/**
 * Find CSV file to reconcile in the done directory.
 *
 * Searches for CSV files matching the optional provider and currency filters.
 * Returns the most recently modified file.
 *
 * @param doneDir - Directory containing completed CSV imports
 * @param options - Filter options (provider, currency)
 * @returns CSV file path and relative path on success, or error object
 */
function findCsvToReconcile(
  doneDir: string,
  options: ReconcileStatementsArgs
): { csvFile: string; relativePath: string } | { error: string } {
  const csvFiles = findCsvFiles(doneDir, options.provider, options.currency);

  if (csvFiles.length === 0) {
    const providerFilter = options.provider ? ` --provider=${options.provider}` : '';
    const currencyFilter = options.currency ? ` --currency=${options.currency}` : '';
    return {
      error: buildErrorResult({
        error: `No CSV files found in ${doneDir}`,
        hint: `Run: import-statements${providerFilter}${currencyFilter}`,
      }),
    };
  }

  const csvFile = csvFiles[csvFiles.length - 1];
  const relativePath = path.relative(path.dirname(path.dirname(doneDir)), csvFile);

  return { csvFile, relativePath };
}

/**
 * Determine closing balance from CSV metadata or manual override.
 *
 * Attempts to extract the closing balance from CSV header metadata.
 * Falls back to manual override if provided, or returns error if neither available.
 *
 * @param csvFile - Path to the CSV file
 * @param config - Import configuration
 * @param options - Reconciliation options (may include manual closingBalance)
 * @param relativeCsvPath - Relative path to CSV for error messages
 * @returns Closing balance and metadata on success, or error object
 */
function determineClosingBalance(
  csvFile: string,
  config: ImportConfig,
  options: ReconcileStatementsArgs,
  relativeCsvPath: string
): { closingBalance: string; metadata?: CsvMetadata } | { error: string } {
  // Extract metadata from CSV
  let metadata: CsvMetadata | undefined;
  try {
    const content = fs.readFileSync(csvFile, 'utf-8');
    const filename = path.basename(csvFile);
    const detectionResult = detectProvider(filename, content, config);
    metadata = detectionResult?.metadata as CsvMetadata | undefined;
  } catch {
    metadata = undefined;
  }

  let closingBalance = options.closingBalance;

  if (!closingBalance && metadata?.closing_balance) {
    closingBalance = metadata.closing_balance;
    // Add currency if not present and metadata has it
    if (metadata.currency && !closingBalance.includes(metadata.currency)) {
      closingBalance = `${metadata.currency} ${closingBalance}`;
    }
  }

  if (!closingBalance) {
    return {
      error: buildErrorResult({
        csvFile: relativeCsvPath,
        error: 'No closing balance found in CSV metadata',
        hint: 'Provide closingBalance parameter manually',
        metadata,
      }),
    };
  }

  return { closingBalance, metadata };
}

/**
 * Determine account from rules file or manual override.
 *
 * Attempts to find the matching rules file and extract the account1 directive.
 * Falls back to manual override if provided, or returns error if neither available.
 *
 * @param csvFile - Path to the CSV file
 * @param rulesDir - Directory containing rules files
 * @param options - Reconciliation options (may include manual account)
 * @param relativeCsvPath - Relative path to CSV for error messages
 * @param metadata - CSV metadata (for error context)
 * @returns Account name on success, or error object
 */
function determineAccount(
  csvFile: string,
  rulesDir: string,
  options: ReconcileStatementsArgs,
  relativeCsvPath: string,
  metadata?: CsvMetadata
): { account: string } | { error: string } {
  let account = options.account;

  if (!account) {
    const rulesMapping = loadRulesMapping(rulesDir);
    const rulesFile = findRulesForCsv(csvFile, rulesMapping);

    if (rulesFile) {
      account = getAccountFromRulesFile(rulesFile) ?? undefined;
    }
  }

  if (!account) {
    const rulesMapping = loadRulesMapping(rulesDir);
    const rulesFile = findRulesForCsv(csvFile, rulesMapping);
    const rulesHint = rulesFile
      ? `Add 'account1 assets:bank:...' to ${rulesFile} or use --account parameter`
      : `Create a rules file in ${rulesDir} with 'account1' directive or use --account parameter`;
    return {
      error: buildErrorResult({
        csvFile: relativeCsvPath,
        error: 'Could not determine account from rules file',
        hint: rulesHint,
        metadata,
      }),
    };
  }

  return { account };
}

/**
 * Core implementation of the reconcile-statement tool
 *
 * This function performs the following steps:
 * 1. Validates the directory is an import worktree
 * 2. Finds the most recently imported CSV file
 * 3. Determines the expected closing balance (from CSV or manual override)
 * 4. Determines the account (from rules file or manual override)
 * 5. Queries hledger for the actual balance as of the last transaction
 * 6. Compares expected vs actual balance
 */
export async function reconcileStatementCore(
  directory: string,
  agent: string,
  options: ReconcileStatementsArgs,
  // eslint-disable-next-line no-unused-vars
  configLoader: (configDir: string) => ImportConfig = loadImportConfig,
  hledgerExecutor: HledgerExecutor = defaultHledgerExecutor,
  // eslint-disable-next-line no-unused-vars
  worktreeChecker: (dir: string) => boolean = isInWorktree
): Promise<string> {
  // 1. Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'reconcile statement');
  if (restrictionError) {
    return restrictionError;
  }

  // 2. Validate worktree
  const worktreeError = validateWorktree(directory, worktreeChecker);
  if (worktreeError) {
    return worktreeError;
  }

  // 3. Load configuration
  const configResult = loadConfiguration(directory, configLoader);
  if ('error' in configResult) {
    return configResult.error;
  }
  const { config } = configResult;

  const doneDir = path.join(directory, config.paths.done);
  const rulesDir = path.join(directory, config.paths.rules);
  const mainJournalPath = path.join(directory, '.hledger.journal');

  // 4. Find CSV file
  const csvResult = findCsvToReconcile(doneDir, options);
  if ('error' in csvResult) {
    return csvResult.error;
  }
  const { csvFile, relativePath: relativeCsvPath } = csvResult;

  // 5. Determine closing balance
  const balanceResult = determineClosingBalance(csvFile, config, options, relativeCsvPath);
  if ('error' in balanceResult) {
    return balanceResult.error;
  }
  const { closingBalance, metadata } = balanceResult;

  // 6. Determine account
  const accountResult = determineAccount(csvFile, rulesDir, options, relativeCsvPath, metadata);
  if ('error' in accountResult) {
    return accountResult.error;
  }
  const { account } = accountResult;

  // 7. Get last transaction date
  const lastTransactionDate = await getLastTransactionDate(
    mainJournalPath,
    account,
    hledgerExecutor
  );

  if (!lastTransactionDate) {
    return buildErrorResult({
      csvFile: relativeCsvPath,
      account,
      error: 'No transactions found for account',
      hint: 'Ensure import completed successfully',
      metadata,
    });
  }

  // 8. Get actual balance
  const actualBalance = await getAccountBalance(
    mainJournalPath,
    account,
    lastTransactionDate,
    hledgerExecutor
  );

  if (actualBalance === null) {
    return buildErrorResult({
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      error: 'Failed to query account balance from hledger',
      hint: `Check journal syntax: hledger check -f ${mainJournalPath}`,
      metadata,
    });
  }

  // 9. Compare balances
  let doBalancesMatch: boolean;
  try {
    doBalancesMatch = balancesMatch(closingBalance, actualBalance);
  } catch (error) {
    return buildErrorResult({
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      expectedBalance: closingBalance,
      actualBalance,
      error: `Cannot parse balances for comparison: ${error instanceof Error ? error.message : String(error)}`,
      metadata,
    });
  }

  if (doBalancesMatch) {
    return buildSuccessResult({
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      expectedBalance: closingBalance,
      actualBalance,
      metadata,
    });
  }

  // 10. Balance mismatch
  let difference: string;
  try {
    difference = calculateDifference(closingBalance, actualBalance);
  } catch (error) {
    return buildErrorResult({
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      expectedBalance: closingBalance,
      actualBalance,
      error: `Failed to calculate difference: ${error instanceof Error ? error.message : String(error)}`,
      metadata,
    });
  }

  return buildErrorResult({
    csvFile: relativeCsvPath,
    account,
    lastTransactionDate,
    expectedBalance: closingBalance,
    actualBalance,
    difference,
    error: `Balance mismatch: expected ${closingBalance}, got ${actualBalance} (difference: ${difference})`,
    hint: 'Check for missing transactions, duplicate imports, or incorrect rules',
    metadata,
  });
}

export default tool({
  description: `ACCOUNTANT AGENT ONLY: Reconcile imported bank statement against closing balance.

This tool validates that the imported transactions result in the correct closing balance.
It must be run inside an import worktree (use import-pipeline for the full workflow).

**Workflow:**
1. Finds the most recently imported CSV in the done directory
2. Extracts closing balance from CSV metadata (or uses manual override)
3. Determines the account from the matching rules file (or uses manual override)
4. Queries hledger for the actual balance as of the last transaction date
5. Compares expected vs actual balance

**Balance Sources:**
- Automatic: Extracted from CSV header metadata (e.g., UBS files have "Closing balance:" row)
- Manual: Provided via closingBalance parameter (required for providers like Revolut)

**Account Detection:**
- Automatic: Parsed from account1 directive in matching rules file
- Manual: Provided via account parameter`,
  args: {
    provider: tool.schema
      .string()
      .optional()
      .describe('Filter by provider (e.g., "ubs", "revolut")'),
    currency: tool.schema.string().optional().describe('Filter by currency (e.g., "chf", "eur")'),
    closingBalance: tool.schema
      .string()
      .optional()
      .describe('Manual closing balance (e.g., "CHF 2324.79"). Required if not in CSV metadata.'),
    account: tool.schema
      .string()
      .optional()
      .describe(
        'Manual account (e.g., "assets:bank:ubs:checking"). Auto-detected from rules file if not provided.'
      ),
  },
  async execute(params, context) {
    const { directory, agent } = context;
    return reconcileStatementCore(directory, agent, {
      provider: params.provider,
      currency: params.currency,
      closingBalance: params.closingBalance,
      account: params.account,
    });
  },
});
