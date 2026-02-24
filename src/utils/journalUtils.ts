import * as fs from 'fs';
import * as path from 'path';

/**
 * Extracts date from a Ledger price line (second field)
 * Example: "P 2025-02-17 00:00:00 EUR 0.944 CHF" → "2025-02-17"
 */
export function extractDateFromPriceLine(line: string): string | undefined {
  return line.split(' ')[1];
}

/**
 * Updates a Ledger price journal file with new price lines,
 * deduplicating by date (newer prices override older ones)
 * and sorting chronologically.
 */
export function updatePriceJournal(journalPath: string, newPriceLines: string[]): void {
  // Read existing lines (or empty array if the file doesn't exist)
  let existingLines: string[] = [];
  if (fs.existsSync(journalPath)) {
    existingLines = fs
      .readFileSync(journalPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '');
  }

  // Build a map of date -> price line (new prices override existing)
  const priceMap = new Map<string, string>();

  // Add existing lines to the map
  for (const line of existingLines) {
    const date = extractDateFromPriceLine(line);
    if (date) priceMap.set(date, line);
  }

  // Add/override with new price lines
  for (const line of newPriceLines) {
    const date = extractDateFromPriceLine(line);
    if (date) priceMap.set(date, line);
  }

  // Convert the map to a sorted array (ascending by date - oldest first)
  const sortedLines = Array.from(priceMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, line]) => line);

  // Write back to the file with a trailing newline
  fs.writeFileSync(journalPath, sortedLines.join('\n') + '\n');
}

/**
 * Generic function to find CSV files in a directory, optionally filtered by provider and currency
 */
export function findCsvFiles(directory: string, provider?: string, currency?: string): string[] {
  const csvFiles: string[] = [];

  if (!fs.existsSync(directory)) {
    return csvFiles;
  }

  // Build the search path based on filters
  let searchPath = directory;
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
  function scanDirectory(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
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
 * Ensures a year-specific journal file exists and is included in the main .hledger.journal.
 * Creates the journal if it doesn't exist and adds the include directive if missing.
 *
 * @param directory The base directory containing the ledger
 * @param year The year for the journal file
 * @returns The path to the year journal file
 */
export function ensureYearJournalExists(directory: string, year: number): string {
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
