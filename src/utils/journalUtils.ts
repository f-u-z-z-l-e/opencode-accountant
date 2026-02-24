import * as fs from 'fs';

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
