import { tool } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { type ImportConfig, loadImportConfig } from '../utils/importConfig.ts';
import { findRulesForCsv, loadRulesMapping } from '../utils/rulesMatcher.ts';
import { parseAccount1 } from '../utils/rulesParser.ts';
import { isInWorktree } from '../utils/worktreeManager.ts';
import { detectProvider } from '../utils/providerDetector.ts';
import { defaultHledgerExecutor, type HledgerExecutor } from '../utils/hledgerExecutor.ts';
import { findCsvFiles } from '../utils/journalUtils.ts';
import { getNextDay } from '../utils/dateUtils.ts';
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
 * Extracts metadata from a CSV file using provider detection
 */
function extractCsvMetadata(csvFilePath: string, config: ImportConfig): CsvMetadata | null {
  try {
    const content = fs.readFileSync(csvFilePath, 'utf-8');
    const filename = path.basename(csvFilePath);
    const result = detectProvider(filename, content, config);

    if (result && result.metadata) {
      return result.metadata as CsvMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts account1 from a rules file
 */
function getAccountFromRulesFile(rulesFilePath: string): string | null {
  try {
    const content = fs.readFileSync(rulesFilePath, 'utf-8');
    return parseAccount1(content);
  } catch {
    return null;
  }
}

/**
 * Gets the last transaction date for an account using hledger
 */
async function getLastTransactionDate(
  mainJournalPath: string,
  account: string,
  executor: HledgerExecutor
): Promise<string | null> {
  // Use hledger register to get all transactions for the account
  const result = await executor(['register', account, '-f', mainJournalPath, '-O', 'csv']);

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }

  // Parse CSV output to get the last date
  const lines = result.stdout.trim().split('\n');
  if (lines.length < 2) {
    return null; // Only header, no transactions
  }

  // Get the last line (most recent transaction)
  const lastLine = lines[lines.length - 1];
  // CSV format: "txnidx","date","code","description","account","amount","total"
  const match = lastLine.match(/^"?\d+"?,"?(\d{4}-\d{2}-\d{2})"?/);
  return match ? match[1] : null;
}

/**
 * Gets the balance for an account as of a specific date
 */
async function getAccountBalance(
  mainJournalPath: string,
  account: string,
  asOfDate: string,
  executor: HledgerExecutor
): Promise<string | null> {
  // Use hledger balance with end date (exclusive, so add 1 day)
  // Actually, -e is exclusive, so we need to use the day after
  const nextDay = getNextDay(asOfDate);

  const result = await executor([
    'bal',
    account,
    '-f',
    mainJournalPath,
    '-e',
    nextDay,
    '-N', // No total row
    '--flat',
  ]);

  if (result.exitCode !== 0) {
    return null;
  }

  // Parse balance output
  // Format: "                CHF 2324.79  assets:bank:ubs:checking"
  const output = result.stdout.trim();
  if (!output) {
    return '0';
  }

  // Extract the balance value (everything before the account name)
  const match = output.match(/^\s*(.+?)\s{2,}/);
  return match ? match[1].trim() : output.trim();
}

/**
 * Core implementation of the reconcile-statement tool
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
  // Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'reconcile statement');
  if (restrictionError) {
    return restrictionError;
  }

  // Enforce worktree requirement
  if (!worktreeChecker(directory)) {
    return JSON.stringify({
      success: false,
      error: 'reconcile-statement must be run inside an import worktree',
      hint: 'Use import-pipeline tool to orchestrate the full workflow',
    } satisfies Partial<ReconcileResult>);
  }

  // Load configuration
  let config: ImportConfig;
  try {
    config = configLoader(directory);
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'Ensure config/import/providers.yaml exists',
    } satisfies Partial<ReconcileResult>);
  }

  const doneDir = path.join(directory, config.paths.done);
  const rulesDir = path.join(directory, config.paths.rules);
  const mainJournalPath = path.join(directory, '.hledger.journal');

  // Find CSV files in done directory
  const csvFiles = findCsvFiles(doneDir, options.provider, options.currency);

  if (csvFiles.length === 0) {
    return JSON.stringify({
      success: false,
      error: 'No CSV files found in done directory to reconcile',
      hint: 'Run import-statements first to import CSV files',
    } satisfies Partial<ReconcileResult>);
  }

  // For now, reconcile the most recently modified CSV file
  // In the future, we could support reconciling multiple files
  const csvFile = csvFiles[csvFiles.length - 1];
  const relativeCsvPath = path.relative(directory, csvFile);

  // Extract metadata from CSV
  const metadata = extractCsvMetadata(csvFile, config) ?? undefined;

  // Determine closing balance
  let closingBalance = options.closingBalance;
  if (!closingBalance && metadata?.closing_balance) {
    closingBalance = metadata.closing_balance;
    // Add currency if not present and metadata has it
    if (metadata.currency && !closingBalance.includes(metadata.currency)) {
      closingBalance = `${metadata.currency} ${closingBalance}`;
    }
  }

  if (!closingBalance) {
    return JSON.stringify({
      success: false,
      csvFile: relativeCsvPath,
      error: 'No closing balance found in CSV metadata',
      hint: 'Provide closingBalance parameter manually',
      metadata,
    } satisfies Partial<ReconcileResult>);
  }

  // Determine account from rules file
  let account = options.account;
  if (!account) {
    // Find matching rules file
    const rulesMapping = loadRulesMapping(rulesDir);
    const rulesFile = findRulesForCsv(csvFile, rulesMapping);

    if (rulesFile) {
      account = getAccountFromRulesFile(rulesFile) ?? undefined;
    }
  }

  if (!account) {
    return JSON.stringify({
      success: false,
      csvFile: relativeCsvPath,
      error: 'Could not determine account from rules file',
      hint: 'Provide account parameter manually or ensure rules file has account1 directive',
      metadata: metadata ?? undefined,
    } satisfies Partial<ReconcileResult>);
  }

  // Get the last transaction date
  const lastTransactionDate = await getLastTransactionDate(
    mainJournalPath,
    account,
    hledgerExecutor
  );

  if (!lastTransactionDate) {
    return JSON.stringify({
      success: false,
      csvFile: relativeCsvPath,
      account,
      error: 'No transactions found for account',
      hint: 'Ensure import completed successfully',
      metadata,
    } satisfies Partial<ReconcileResult>);
  }

  // Get the actual balance from hledger
  const actualBalance = await getAccountBalance(
    mainJournalPath,
    account,
    lastTransactionDate,
    hledgerExecutor
  );

  if (actualBalance === null) {
    return JSON.stringify({
      success: false,
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      error: 'Failed to query account balance from hledger',
      metadata,
    } satisfies Partial<ReconcileResult>);
  }

  // Compare balances
  let doBalancesMatch: boolean;
  try {
    doBalancesMatch = balancesMatch(closingBalance, actualBalance);
  } catch (error) {
    return JSON.stringify({
      success: false,
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      expectedBalance: closingBalance,
      actualBalance,
      error: `Cannot parse balances for comparison: ${error instanceof Error ? error.message : String(error)}`,
      metadata,
    } satisfies Partial<ReconcileResult>);
  }

  if (doBalancesMatch) {
    return JSON.stringify({
      success: true,
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      expectedBalance: closingBalance,
      actualBalance,
      metadata,
    } satisfies ReconcileResult);
  }

  // Balances don't match
  let difference: string;
  try {
    difference = calculateDifference(closingBalance, actualBalance);
  } catch (error) {
    return JSON.stringify({
      success: false,
      csvFile: relativeCsvPath,
      account,
      lastTransactionDate,
      expectedBalance: closingBalance,
      actualBalance,
      error: `Failed to calculate difference: ${error instanceof Error ? error.message : String(error)}`,
      metadata,
    } satisfies Partial<ReconcileResult>);
  }

  return JSON.stringify({
    success: false,
    csvFile: relativeCsvPath,
    account,
    lastTransactionDate,
    expectedBalance: closingBalance,
    actualBalance,
    difference,
    error: `Balance mismatch: expected ${closingBalance}, got ${actualBalance} (difference: ${difference})`,
    hint: 'Check for missing transactions, duplicate imports, or incorrect rules',
    metadata,
  } satisfies ReconcileResult);
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
