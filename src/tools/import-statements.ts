import { tool } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { type ImportConfig, loadImportConfig } from '../utils/importConfig.ts';
import { findRulesForCsv, loadRulesMapping, type RulesMapping } from '../utils/rulesMatcher.ts';
import {
  countTransactions,
  defaultHledgerExecutor,
  extractTransactionYears,
  type HledgerExecutor,
  parseUnknownPostings,
  type UnknownPosting,
  validateLedger,
} from '../utils/hledgerExecutor.ts';
import { parseRulesFile } from '../utils/rulesParser.ts';
import { findMatchingCsvRow, parseCsvFile } from '../utils/csvParser.ts';
import { isInWorktree } from '../utils/worktreeManager.ts';
import { ensureYearJournalExists, findCsvFiles } from '../utils/journalUtils.ts';

/**
 * Result for single CSV file processing
 */
interface FileResult {
  csv: string;
  rulesFile: string | null;
  totalTransactions: number;
  matchedTransactions: number;
  unknownPostings: UnknownPosting[];
  transactionYear?: number;
  error?: string;
}

/**
 * Overall result of the import-statements tool
 */
interface ImportStatementsResult {
  success: boolean;
  files: FileResult[];
  summary: {
    filesProcessed: number;
    filesWithErrors: number;
    filesWithoutRules: number;
    totalTransactions: number;
    matched: number;
    unknown: number;
  };
  message?: string;
  error?: string;
  hint?: string;
}

/**
 * Builds an error result with an optional hint
 */
function buildErrorResult(error: string, hint?: string): string {
  return JSON.stringify({
    success: false,
    error,
    hint,
  } satisfies Partial<ImportStatementsResult>);
}

/**
 * Builds an error result with files and summary
 */
function buildErrorResultWithDetails(
  error: string,
  files: FileResult[],
  summary: ImportStatementsResult['summary'],
  hint?: string
): string {
  return JSON.stringify({
    success: false,
    error,
    hint,
    files,
    summary,
  } satisfies ImportStatementsResult);
}

/**
 * Builds a success result
 */
function buildSuccessResult(
  files: FileResult[],
  summary: ImportStatementsResult['summary'],
  message?: string
): string {
  return JSON.stringify({
    success: true,
    files,
    summary,
    message,
  } satisfies ImportStatementsResult);
}

/**
 * Find the CSV file that matches the source directive in a rules file.
 * Returns the newest matching file (matching hledger's behavior).
 * Returns null if no source directive found or no files match.
 */
function findCsvFromRulesFile(rulesFile: string): string | null {
  const content = fs.readFileSync(rulesFile, 'utf-8');

  // Parse source directive
  const match = content.match(/^source\s+([^\n#]+)/m);
  if (!match) {
    return null;
  }
  const sourcePath = match[1].trim();

  const rulesDir = path.dirname(rulesFile);
  const absolutePattern = path.resolve(rulesDir, sourcePath);

  // Use glob to find matching files
  const matches = glob.sync(absolutePattern);

  if (matches.length === 0) {
    return null;
  }

  // Sort by modification time, newest first (matching hledger's behavior)
  matches.sort((a, b) => {
    const aStat = fs.statSync(a);
    const bStat = fs.statSync(b);
    return bStat.mtime.getTime() - aStat.mtime.getTime();
  });

  return matches[0];
}

/**
 * Executes the actual import of CSV files into hledger
 * Returns success or error with details
 */
async function executeImports(
  fileResults: FileResult[],
  directory: string,
  pendingDir: string,
  doneDir: string,
  hledgerExecutor: HledgerExecutor
): Promise<{ success: boolean; error?: string; hint?: string; importedCount?: number }> {
  const importedFiles: string[] = [];

  for (const fileResult of fileResults) {
    const rulesFile = fileResult.rulesFile ? path.join(directory, fileResult.rulesFile) : null;
    if (!rulesFile) continue; // Already handled above

    // Ensure the year journal exists
    const year = fileResult.transactionYear;
    if (!year) {
      return {
        success: false,
        error: `No transactions found in ${fileResult.csv}`,
      };
    }

    let yearJournalPath: string;
    try {
      yearJournalPath = ensureYearJournalExists(directory, year);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }

    const result = await hledgerExecutor(['import', '-f', yearJournalPath, rulesFile]);

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `Import failed for ${fileResult.csv}: ${result.stderr.trim()}`,
      };
    }

    // Find which CSV was actually imported via the source directive
    const importedCsv = findCsvFromRulesFile(rulesFile);
    if (importedCsv) {
      importedFiles.push(importedCsv);
    }
  }

  // Validate the ledger after all imports to ensure integrity
  const mainJournalPath = path.join(directory, '.hledger.journal');
  const validationResult = await validateLedger(mainJournalPath, hledgerExecutor);

  if (!validationResult.valid) {
    return {
      success: false,
      error: `Ledger validation failed after import: ${validationResult.errors.join('; ')}`,
      hint: 'The import created invalid transactions. Check your rules file configuration. CSV files have NOT been moved to done.',
    };
  }

  // Move imported files to the done directory
  for (const csvFile of importedFiles) {
    const relativePath = path.relative(pendingDir, csvFile);
    const destPath = path.join(doneDir, relativePath);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    fs.renameSync(csvFile, destPath);
  }

  return {
    success: true,
    importedCount: importedFiles.length,
  };
}

/**
 * Processes a single CSV file and returns its processing result
 */
async function processCsvFile(
  csvFile: string,
  rulesMapping: RulesMapping,
  directory: string,
  hledgerExecutor: HledgerExecutor
): Promise<FileResult> {
  const rulesFile = findRulesForCsv(csvFile, rulesMapping);

  if (!rulesFile) {
    return {
      csv: path.relative(directory, csvFile),
      rulesFile: null,
      totalTransactions: 0,
      matchedTransactions: 0,
      unknownPostings: [],
      error: 'No matching rules file found',
    };
  }

  // Run hledger print for dry-run check
  const result = await hledgerExecutor(['print', '-f', rulesFile]);

  if (result.exitCode !== 0) {
    return {
      csv: path.relative(directory, csvFile),
      rulesFile: path.relative(directory, rulesFile),
      totalTransactions: 0,
      matchedTransactions: 0,
      unknownPostings: [],
      error: `hledger error: ${result.stderr.trim() || 'Unknown error'}`,
    };
  }

  const unknownPostings = parseUnknownPostings(result.stdout);
  const transactionCount = countTransactions(result.stdout);
  const matchedCount = transactionCount - unknownPostings.length;

  // Extract transaction years and validate single-year constraint
  const years = extractTransactionYears(result.stdout);
  if (years.size > 1) {
    const yearList = Array.from(years).sort().join(', ');
    return {
      csv: path.relative(directory, csvFile),
      rulesFile: path.relative(directory, rulesFile),
      totalTransactions: transactionCount,
      matchedTransactions: matchedCount,
      unknownPostings: [],
      error: `CSV contains transactions from multiple years (${yearList}). Split the CSV by year before importing.`,
    };
  }

  const transactionYear = years.size === 1 ? Array.from(years)[0] : undefined;

  // If there are unknown postings, attach the full CSV row data for context
  if (unknownPostings.length > 0) {
    try {
      const rulesContent = fs.readFileSync(rulesFile, 'utf-8');
      const rulesConfig = parseRulesFile(rulesContent);
      const csvRows = parseCsvFile(csvFile, rulesConfig);

      for (const posting of unknownPostings) {
        posting.csvRow = findMatchingCsvRow(
          {
            date: posting.date,
            description: posting.description,
            amount: posting.amount,
          },
          csvRows,
          rulesConfig
        );
      }
    } catch {
      // If CSV parsing fails, continue without the row data
      // The posting info from hledger is still useful
      for (const posting of unknownPostings) {
        posting.csvRow = undefined;
      }
    }
  }

  return {
    csv: path.relative(directory, csvFile),
    rulesFile: path.relative(directory, rulesFile),
    totalTransactions: transactionCount,
    matchedTransactions: matchedCount,
    unknownPostings,
    transactionYear,
  };
}

/**
 * Imports bank statement CSV files into hledger using rules files
 */
export async function importStatements(
  directory: string,
  agent: string,
  options: {
    provider?: string;
    currency?: string;
    checkOnly?: boolean;
  },

  configLoader: (configDir: string) => ImportConfig = loadImportConfig,
  hledgerExecutor: HledgerExecutor = defaultHledgerExecutor,

  worktreeChecker: (dir: string) => boolean = isInWorktree
): Promise<string> {
  // Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'import statements');
  if (restrictionError) {
    return restrictionError;
  }

  // Enforce worktree requirement
  if (!worktreeChecker(directory)) {
    return buildErrorResult(
      'import-statements must be run inside an import worktree',
      'Use import-pipeline tool to orchestrate the full workflow'
    );
  }

  // Load configuration
  let config: ImportConfig;
  try {
    config = configLoader(directory);
  } catch (error) {
    const errorMessage = `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`;
    return buildErrorResult(
      errorMessage,
      'Ensure config/import/providers.yaml exists with required paths including "rules"'
    );
  }

  const pendingDir = path.join(directory, config.paths.pending);
  const rulesDir = path.join(directory, config.paths.rules);
  const doneDir = path.join(directory, config.paths.done);

  // Load rules mapping
  const rulesMapping = loadRulesMapping(rulesDir);

  // Find CSV files to process
  const csvFiles = findCsvFiles(pendingDir, options.provider, options.currency);

  if (csvFiles.length === 0) {
    return buildSuccessResult(
      [],
      {
        filesProcessed: 0,
        filesWithErrors: 0,
        filesWithoutRules: 0,
        totalTransactions: 0,
        matched: 0,
        unknown: 0,
      },
      'No CSV files found to process'
    );
  }

  const fileResults: FileResult[] = [];
  let totalTransactions = 0;
  let totalMatched = 0;
  let totalUnknown = 0;
  let filesWithErrors = 0;
  let filesWithoutRules = 0;

  // Group CSV files by their matching rules file
  // When using glob patterns, multiple CSV files may match the same rules file.
  // We only want to process each rules file once, using the newest matching CSV
  // (matching hledger's native behavior).
  const rulesFileToCSVs = new Map<string, string[]>();
  const csvsWithoutRules: string[] = [];

  for (const csvFile of csvFiles) {
    const rulesFile = findRulesForCsv(csvFile, rulesMapping);
    if (!rulesFile) {
      csvsWithoutRules.push(csvFile);
    } else {
      if (!rulesFileToCSVs.has(rulesFile)) {
        rulesFileToCSVs.set(rulesFile, []);
      }
      rulesFileToCSVs.get(rulesFile)!.push(csvFile);
    }
  }

  // Process CSVs without rules
  for (const csvFile of csvsWithoutRules) {
    const fileResult = await processCsvFile(csvFile, rulesMapping, directory, hledgerExecutor);
    fileResults.push(fileResult);

    if (fileResult.error) {
      filesWithoutRules++;
    }

    totalTransactions += fileResult.totalTransactions;
    totalMatched += fileResult.matchedTransactions;
    totalUnknown += fileResult.unknownPostings.length;
  }

  // Process each rules file with its newest matching CSV
  for (const [_rulesFile, matchingCSVs] of rulesFileToCSVs.entries()) {
    // Sort by modification time, newest first (matching hledger's behavior)
    matchingCSVs.sort((a, b) => {
      const aStat = fs.statSync(a);
      const bStat = fs.statSync(b);
      return bStat.mtime.getTime() - aStat.mtime.getTime();
    });

    // Process only the newest CSV
    const newestCSV = matchingCSVs[0];
    const fileResult = await processCsvFile(newestCSV, rulesMapping, directory, hledgerExecutor);
    fileResults.push(fileResult);

    // Update counters
    if (fileResult.error) {
      filesWithErrors++;
    }

    totalTransactions += fileResult.totalTransactions;
    totalMatched += fileResult.matchedTransactions;
    totalUnknown += fileResult.unknownPostings.length;
  }

  const hasUnknowns = totalUnknown > 0;
  const hasErrors = filesWithErrors > 0 || filesWithoutRules > 0;

  // Check-only mode: just report results
  if (options.checkOnly !== false) {
    const result: ImportStatementsResult = {
      success: !hasUnknowns && !hasErrors,
      files: fileResults,
      summary: {
        filesProcessed: fileResults.length, // Count actually processed files, not total CSV files found
        filesWithErrors,
        filesWithoutRules,
        totalTransactions,
        matched: totalMatched,
        unknown: totalUnknown,
      },
    };

    if (hasUnknowns) {
      result.message = `Found ${totalUnknown} transaction(s) with unknown accounts. Add rules to categorize them.`;
    } else if (hasErrors) {
      result.message = `Some files had errors. Check the file results for details.`;
    } else {
      result.message = 'All transactions matched. Ready to import with checkOnly: false';
    }

    return JSON.stringify(result);
  }

  // Import mode: abort if there are any unknowns or errors
  if (hasUnknowns || hasErrors) {
    return buildErrorResultWithDetails(
      'Cannot import: some transactions have unknown accounts or files have errors',
      fileResults,
      {
        filesProcessed: fileResults.length, // Count actually processed files
        filesWithErrors,
        filesWithoutRules,
        totalTransactions,
        matched: totalMatched,
        unknown: totalUnknown,
      },
      'Run with checkOnly: true to see details, then add missing rules'
    );
  }

  // All clear - run actual import for each file
  const importResult = await executeImports(
    fileResults,
    directory,
    pendingDir,
    doneDir,
    hledgerExecutor
  );

  if (!importResult.success) {
    return buildErrorResultWithDetails(
      importResult.error!,
      fileResults,
      {
        filesProcessed: fileResults.length, // Count actually processed files
        filesWithErrors: 1,
        filesWithoutRules,
        totalTransactions,
        matched: totalMatched,
        unknown: totalUnknown,
      },
      importResult.hint
    );
  }

  return buildSuccessResult(
    fileResults.map((f) => ({
      ...f,
      imported: true,
    })),
    {
      filesProcessed: csvFiles.length,
      filesWithErrors: 0,
      filesWithoutRules: 0,
      totalTransactions,
      matched: totalMatched,
      unknown: 0,
    },
    `Successfully imported ${totalTransactions} transaction(s) from ${importResult.importedCount} file(s)`
  );
}

export default tool({
  description: `ACCOUNTANT AGENT ONLY: Import classified bank statement CSVs into hledger using rules files.

This tool processes CSV files in the pending import directory and uses hledger's CSV import capabilities with matching rules files.

**Check Mode (checkOnly: true, default):**
- Runs hledger print to preview transactions
- Identifies transactions with 'income:unknown' or 'expenses:unknown' accounts
- These indicate missing rules that need to be added

**Import Mode (checkOnly: false):**
- First validates all transactions have known accounts
- If any unknowns exist, aborts and reports them
- If all clean, imports transactions and moves CSVs to done directory

**Workflow:**
1. Run with checkOnly: true (or no args)
2. If unknowns found, add rules to the appropriate .rules file
3. Repeat until no unknowns
4. Run with checkOnly: false to import`,
  args: {
    provider: tool.schema
      .string()
      .optional()
      .describe('Filter by provider (e.g., "revolut", "ubs"). If omitted, process all providers.'),
    currency: tool.schema
      .string()
      .optional()
      .describe(
        'Filter by currency (e.g., "chf", "eur"). If omitted, process all currencies for the provider.'
      ),
    checkOnly: tool.schema
      .boolean()
      .optional()
      .describe(
        'If true (default), only check for unknown accounts without importing. Set to false to perform actual import.'
      ),
  },
  async execute(params, context) {
    const { directory, agent } = context;
    return importStatements(directory, agent, {
      provider: params.provider,
      currency: params.currency,
      checkOnly: params.checkOnly,
    });
  },
});
