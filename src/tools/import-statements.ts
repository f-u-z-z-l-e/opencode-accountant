import { tool } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { loadImportConfig, type ImportConfig } from '../utils/importConfig.ts';
import { loadRulesMapping, findRulesForCsv } from '../utils/rulesMatcher.ts';
import {
  defaultHledgerExecutor,
  parseUnknownPostings,
  countTransactions,
  type HledgerExecutor,
  type UnknownPosting,
} from '../utils/hledgerExecutor.ts';
import { parseRulesFile } from '../utils/rulesParser.ts';
import { parseCsvFile, findMatchingCsvRow } from '../utils/csvParser.ts';

/**
 * Result for a single CSV file processing
 */
interface FileResult {
  csv: string;
  rulesFile: string | null;
  totalTransactions: number;
  matchedTransactions: number;
  unknownPostings: UnknownPosting[];
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
  hledgerExecutor: HledgerExecutor = defaultHledgerExecutor
): Promise<string> {
  // Agent restriction
  if (agent !== 'accountant') {
    return JSON.stringify({
      success: false,
      error: `This tool is restricted to the accountant agent only. Called by: ${agent || 'main assistant'}`,
      hint: "Use: Task(subagent_type='accountant', prompt='import statements')",
    });
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

    // If there are unknown postings, attach the full CSV row data for context
    if (unknownPostings.length > 0) {
      try {
        const rulesContent = fs.readFileSync(rulesFile, 'utf-8');
        const rulesConfig = parseRulesFile(rulesContent);
        const csvRows = parseCsvFile(csvFile, rulesConfig);

        for (const posting of unknownPostings) {
          const csvRow = findMatchingCsvRow(
            {
              date: posting.date,
              description: posting.description,
              amount: posting.amount,
            },
            csvRows,
            rulesConfig
          );
          posting.csvRow = csvRow;
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
  for (const csvFile of csvFiles) {
    const rulesFile = findRulesForCsv(csvFile, rulesMapping);
    if (!rulesFile) continue; // Already handled above

    const result = await hledgerExecutor(['import', csvFile, '--rules-file', rulesFile]);

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
        error: `Import failed for ${path.relative(directory, csvFile)}: ${result.stderr.trim()}`,
      } satisfies ImportStatementsResult);
    }

    importedFiles.push(csvFile);
  }

  // Move imported files to done directory
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

export default tool({
  description: `Import classified bank statement CSVs into hledger using rules files.

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
    return importStatementsCore(directory, agent, {
      provider: params.provider,
      currency: params.currency,
      checkOnly: params.checkOnly,
    });
  },
});
