import * as fs from 'fs';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { type ImportConfig, loadImportConfig } from '../utils/importConfig.ts';
import { findRulesForCsv, loadRulesMapping } from '../utils/rulesMatcher.ts';
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
 * Ensures a year-specific journal file exists and is included in the main .hledger.journal.
 * Creates the journal if it doesn't exist and adds the include directive if missing.
 *
 * @param directory The base directory containing the ledger
 * @param year The year for the journal file
 * @returns The path to the year journal file
 */
function ensureYearJournalExists(directory: string, year: number): string {
  const ledgerDir = path.join(directory, 'ledger');
  const yearJournalPath = path.join(ledgerDir, `${year}.journal`);
  const mainJournalPath = path.join(directory, '.hledger.journal');

  // Ensure ledger directory exists
  if (!fs.existsSync(ledgerDir)) {
    fs.mkdirSync(ledgerDir, { recursive: true });
  }

  // Create a year journal if it doesn't exist
  if (!fs.existsSync(yearJournalPath)) {
    fs.writeFileSync(yearJournalPath, `; ${year} transactions\n`);
  }

  // Ensure main journal exists
  if (!fs.existsSync(mainJournalPath)) {
    throw new Error(
      `.hledger.journal not found at ${mainJournalPath}. Create it first with appropriate includes.`
    );
  }

  // Check if the include directive already exists (not commented out)
  const mainJournalContent = fs.readFileSync(mainJournalPath, 'utf-8');
  const includeDirective = `include ledger/${year}.journal`;

  const lines = mainJournalContent.split('\n');
  const includeExists = lines.some((line) => {
    const trimmed = line.trim();
    // Must start with 'include' (not commented with # or ;)
    return trimmed === includeDirective || trimmed.startsWith(includeDirective + ' ');
  });

  if (!includeExists) {
    // Append include directive to the main journal
    const newContent = mainJournalContent.trimEnd() + '\n' + includeDirective + '\n';
    fs.writeFileSync(mainJournalPath, newContent);
  }

  return yearJournalPath;
}

/**
 * Finds all CSV files in the pending directory, optionally filtered by provider and currency
 */
function findPendingCsvFiles(pendingDir: string, provider?: string, currency?: string): string[] {
  const csvFiles: string[] = [];

  if (!fs.existsSync(pendingDir)) {
    return csvFiles;
  }

  // Build the search path based on filters
  let searchPath = pendingDir;
  if (provider) {
    searchPath = path.join(searchPath, provider);
    if (currency) {
      searchPath = path.join(searchPath, currency);
    }
  }

  if (!fs.existsSync(searchPath)) {
    return csvFiles;
  }

  // Recursive function to find all CSV files
  function scanDirectory(directory: string): void {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.csv')) {
        csvFiles.push(fullPath);
      }
    }
  }

  scanDirectory(searchPath);
  return csvFiles.sort();
}

/**
 * Core implementation of the import-statements tool
 */
export async function importStatementsCore(
  directory: string,
  agent: string,
  options: {
    provider?: string;
    currency?: string;
    checkOnly?: boolean;
  },
  // eslint-disable-next-line no-unused-vars
  configLoader: (configDir: string) => ImportConfig = loadImportConfig,
  hledgerExecutor: HledgerExecutor = defaultHledgerExecutor,
  // eslint-disable-next-line no-unused-vars
  worktreeChecker: (dir: string) => boolean = isInWorktree
): Promise<string> {
  // Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'import statements');
  if (restrictionError) {
    return restrictionError;
  }

  // Enforce worktree requirement
  if (!worktreeChecker(directory)) {
    return JSON.stringify({
      success: false,
      error: 'import-statements must be run inside an import worktree',
      hint: 'Use import-pipeline tool to orchestrate the full workflow',
    } satisfies Partial<ImportStatementsResult>);
  }

  // Load configuration
  let config: ImportConfig;
  try {
    config = configLoader(directory);
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'Ensure config/import/providers.yaml exists with required paths including "rules"',
    } satisfies Partial<ImportStatementsResult>);
  }

  const pendingDir = path.join(directory, config.paths.pending);
  const rulesDir = path.join(directory, config.paths.rules);
  const doneDir = path.join(directory, config.paths.done);

  // Load rules mapping
  const rulesMapping = loadRulesMapping(rulesDir);

  // Find CSV files to process
  const csvFiles = findPendingCsvFiles(pendingDir, options.provider, options.currency);

  if (csvFiles.length === 0) {
    return JSON.stringify({
      success: true,
      files: [],
      summary: {
        filesProcessed: 0,
        filesWithErrors: 0,
        filesWithoutRules: 0,
        totalTransactions: 0,
        matched: 0,
        unknown: 0,
      },
      message: 'No CSV files found to process',
    } satisfies ImportStatementsResult);
  }

  const fileResults: FileResult[] = [];
  let totalTransactions = 0;
  let totalMatched = 0;
  let totalUnknown = 0;
  let filesWithErrors = 0;
  let filesWithoutRules = 0;

  // Process each CSV file
  for (const csvFile of csvFiles) {
    const rulesFile = findRulesForCsv(csvFile, rulesMapping);

    if (!rulesFile) {
      filesWithoutRules++;
      fileResults.push({
        csv: path.relative(directory, csvFile),
        rulesFile: null,
        totalTransactions: 0,
        matchedTransactions: 0,
        unknownPostings: [],
        error: 'No matching rules file found',
      });
      continue;
    }

    // Run hledger print for dry-run check
    const result = await hledgerExecutor(['print', '-f', csvFile, '--rules-file', rulesFile]);

    if (result.exitCode !== 0) {
      filesWithErrors++;
      fileResults.push({
        csv: path.relative(directory, csvFile),
        rulesFile: path.relative(directory, rulesFile),
        totalTransactions: 0,
        matchedTransactions: 0,
        unknownPostings: [],
        error: `hledger error: ${result.stderr.trim() || 'Unknown error'}`,
      });
      continue;
    }

    const unknownPostings = parseUnknownPostings(result.stdout);
    const transactionCount = countTransactions(result.stdout);
    const matchedCount = transactionCount - unknownPostings.length;

    // Extract transaction years and validate single-year constraint
    const years = extractTransactionYears(result.stdout);
    if (years.size > 1) {
      const yearList = Array.from(years).sort().join(', ');
      filesWithErrors++;
      fileResults.push({
        csv: path.relative(directory, csvFile),
        rulesFile: path.relative(directory, rulesFile),
        totalTransactions: transactionCount,
        matchedTransactions: matchedCount,
        unknownPostings: [],
        error: `CSV contains transactions from multiple years (${yearList}). Split the CSV by year before importing.`,
      });
      continue;
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

    totalTransactions += transactionCount;
    totalMatched += matchedCount;
    totalUnknown += unknownPostings.length;

    fileResults.push({
      csv: path.relative(directory, csvFile),
      rulesFile: path.relative(directory, rulesFile),
      totalTransactions: transactionCount,
      matchedTransactions: matchedCount,
      unknownPostings,
      transactionYear,
    });
  }

  const hasUnknowns = totalUnknown > 0;
  const hasErrors = filesWithErrors > 0 || filesWithoutRules > 0;

  // Check-only mode: just report results
  if (options.checkOnly !== false) {
    const result: ImportStatementsResult = {
      success: !hasUnknowns && !hasErrors,
      files: fileResults,
      summary: {
        filesProcessed: csvFiles.length,
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
    return JSON.stringify({
      success: false,
      files: fileResults,
      summary: {
        filesProcessed: csvFiles.length,
        filesWithErrors,
        filesWithoutRules,
        totalTransactions,
        matched: totalMatched,
        unknown: totalUnknown,
      },
      error: 'Cannot import: some transactions have unknown accounts or files have errors',
      hint: 'Run with checkOnly: true to see details, then add missing rules',
    } satisfies ImportStatementsResult);
  }

  // All clear - run actual import for each file
  const importedFiles: string[] = [];
  for (const fileResult of fileResults) {
    const csvFile = path.join(directory, fileResult.csv);
    const rulesFile = fileResult.rulesFile ? path.join(directory, fileResult.rulesFile) : null;
    if (!rulesFile) continue; // Already handled above

    // Ensure the year journal exists
    const year = fileResult.transactionYear;
    if (!year) {
      return JSON.stringify({
        success: false,
        files: fileResults,
        summary: {
          filesProcessed: csvFiles.length,
          filesWithErrors: 1,
          filesWithoutRules,
          totalTransactions,
          matched: totalMatched,
          unknown: totalUnknown,
        },
        error: `No transactions found in ${fileResult.csv}`,
      } satisfies ImportStatementsResult);
    }

    let yearJournalPath: string;
    try {
      yearJournalPath = ensureYearJournalExists(directory, year);
    } catch (error) {
      return JSON.stringify({
        success: false,
        files: fileResults,
        summary: {
          filesProcessed: csvFiles.length,
          filesWithErrors: 1,
          filesWithoutRules,
          totalTransactions,
          matched: totalMatched,
          unknown: totalUnknown,
        },
        error: error instanceof Error ? error.message : String(error),
      } satisfies ImportStatementsResult);
    }

    const result = await hledgerExecutor([
      'import',
      '-f',
      yearJournalPath,
      csvFile,
      '--rules-file',
      rulesFile,
    ]);

    if (result.exitCode !== 0) {
      return JSON.stringify({
        success: false,
        files: fileResults,
        summary: {
          filesProcessed: csvFiles.length,
          filesWithErrors: 1,
          filesWithoutRules,
          totalTransactions,
          matched: totalMatched,
          unknown: totalUnknown,
        },
        error: `Import failed for ${fileResult.csv}: ${result.stderr.trim()}`,
      } satisfies ImportStatementsResult);
    }

    importedFiles.push(csvFile);
  }

  // Validate the ledger after all imports to ensure integrity
  const mainJournalPath = path.join(directory, '.hledger.journal');
  const validationResult = await validateLedger(mainJournalPath, hledgerExecutor);

  if (!validationResult.valid) {
    return JSON.stringify({
      success: false,
      files: fileResults,
      summary: {
        filesProcessed: csvFiles.length,
        filesWithErrors: 1,
        filesWithoutRules,
        totalTransactions,
        matched: totalMatched,
        unknown: totalUnknown,
      },
      error: `Ledger validation failed after import: ${validationResult.errors.join('; ')}`,
      hint: 'The import created invalid transactions. Check your rules file configuration. CSV files have NOT been moved to done.',
    } satisfies ImportStatementsResult);
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

  return JSON.stringify({
    success: true,
    files: fileResults.map((f) => ({
      ...f,
      imported: true,
    })),
    summary: {
      filesProcessed: csvFiles.length,
      filesWithErrors: 0,
      filesWithoutRules: 0,
      totalTransactions,
      matched: totalMatched,
      unknown: 0,
    },
    message: `Successfully imported ${totalTransactions} transaction(s) from ${importedFiles.length} file(s)`,
  } satisfies ImportStatementsResult);
}
