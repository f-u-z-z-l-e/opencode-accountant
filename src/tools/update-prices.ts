import { tool } from '@opencode-ai/plugin';
import { $ } from 'bun';
import * as path from 'path';
import * as fs from 'fs';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import {
  loadPricesConfig,
  getDefaultBackfillDate,
  type PricesConfig,
} from '../utils/pricesConfig.ts';

/**
 * Function type for fetching price data from external sources
 */
// eslint-disable-next-line no-unused-vars
export type PriceFetcher = (args: string[]) => Promise<string>;

/**
 * Executes pricehist command using Bun's shell
 */
export async function defaultPriceFetcher(cmdArgs: string[]): Promise<string> {
  // Bun's template literal shell execution uses cmdArgs
  const result = await $`pricehist ${cmdArgs}`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Returns yesterday's date in YYYY-MM-DD format
 */
function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// Parse a price line and extract date for filtering (keeps original line intact)
// Input: "P 2025-02-17 00:00:00 EUR 0.944 CHF"
// Output: { date: "2025-02-17", formattedLine: "P 2025-02-17 00:00:00 EUR 0.944 CHF" }
export function parsePriceLine(line: string): { date: string; formattedLine: string } | null {
  const match = line.match(/^P (\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2}:\d{2})? .+$/);
  if (!match) return null;
  return {
    date: match[1],
    formattedLine: line, // Keep original line including timestamp
  };
}

/**
 * Filters price lines to date range and sorts chronologically
 */
export function filterPriceLinesByDateRange(
  priceLines: string[],
  startDate: string,
  endDate: string
): string[] {
  return priceLines
    .map(parsePriceLine)
    .filter((parsed): parsed is NonNullable<typeof parsed> => {
      if (!parsed) return false;
      return parsed.date >= startDate && parsed.date <= endDate;
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((parsed) => parsed.formattedLine);
}

/**
 * Updates journal file with new prices, deduplicating by date
 */
function updateJournalWithPrices(journalPath: string, newPriceLines: string[]): void {
  // Read existing lines (or empty array if file doesn't exist)
  let existingLines: string[] = [];
  if (fs.existsSync(journalPath)) {
    existingLines = fs
      .readFileSync(journalPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '');
  }

  // Build a map of date -> price line (new prices override existing)
  const priceMap = new Map<string, string>();

  // Add existing lines to map
  for (const line of existingLines) {
    const date = line.split(' ')[1];
    if (date) priceMap.set(date, line);
  }

  // Add/override with new price lines
  for (const line of newPriceLines) {
    const date = line.split(' ')[1];
    if (date) priceMap.set(date, line);
  }

  // Convert map to sorted array (ascending by date - oldest first, newest at bottom)
  const sortedLines = Array.from(priceMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, line]) => line);

  // Write back to file
  fs.writeFileSync(journalPath, sortedLines.join('\n') + '\n');
}

// Exported core logic for testing
export async function updatePricesCore(
  directory: string,
  agent: string,
  backfill: boolean,
  priceFetcher: PriceFetcher = defaultPriceFetcher,
  // eslint-disable-next-line no-unused-vars
  configLoader: (directory: string) => PricesConfig = loadPricesConfig
): Promise<string> {
  // Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'update prices');
  if (restrictionError) {
    return restrictionError;
  }

  // Load configuration
  let config: PricesConfig;
  try {
    config = configLoader(directory);
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const endDate = getYesterday();
  const defaultBackfillDate = getDefaultBackfillDate();
  const results: Array<
    { ticker: string; priceLine: string; file: string } | { ticker: string; error: string }
  > = [];

  for (const [ticker, currencyConfig] of Object.entries(config.currencies)) {
    try {
      // Determine start date: use per-currency backfill_date, default backfill date, or just today
      const startDate = backfill ? currencyConfig.backfill_date || defaultBackfillDate : endDate;

      // Build pricehist command arguments
      const cmdArgs = [
        'fetch',
        '-o',
        'ledger',
        '-s',
        startDate,
        '-e',
        endDate,
        currencyConfig.source,
        currencyConfig.pair,
      ];
      if (currencyConfig.fmt_base) {
        cmdArgs.push('--fmt-base', currencyConfig.fmt_base);
      }

      // Execute pricehist using the injected fetcher
      const output = await priceFetcher(cmdArgs);

      // Split output into lines and filter for price lines only
      const rawPriceLines = output.split('\n').filter((line) => line.startsWith('P '));

      if (rawPriceLines.length === 0) {
        results.push({
          ticker,
          error: `No price lines in pricehist output: ${output}`,
        });
        continue;
      }

      // Filter to requested date range and reformat (strips timestamp if present)
      const priceLines = filterPriceLinesByDateRange(rawPriceLines, startDate, endDate);

      if (priceLines.length === 0) {
        results.push({
          ticker,
          error: `No price data found within date range ${startDate} to ${endDate}`,
        });
        continue;
      }

      // Update journal file with deduplication
      const journalPath = path.join(directory, 'ledger', 'currencies', currencyConfig.file);
      updateJournalWithPrices(journalPath, priceLines);

      // Return the last (most recent) price line
      const latestPriceLine = priceLines[priceLines.length - 1];
      results.push({
        ticker,
        priceLine: latestPriceLine,
        file: currencyConfig.file,
      });
    } catch (err) {
      results.push({
        ticker,
        error: String(err),
      });
    }
  }

  return JSON.stringify({
    success: results.every((r) => !('error' in r)),
    endDate,
    backfill: !!backfill,
    results,
  });
}

export default tool({
  description:
    'ACCOUNTANT AGENT ONLY: Fetches end-of-day prices for all configured currencies (from config/prices.yaml) and appends them to the corresponding price journals in ledger/currencies/.',
  args: {
    backfill: tool.schema
      .boolean()
      .optional()
      .describe(
        "If true, fetch history from each currency's configured backfill_date (or Jan 1 of current year if not specified)"
      ),
  },
  async execute(params, context) {
    const { directory, agent } = context;
    const { backfill } = params;
    return updatePricesCore(directory, agent, backfill || false);
  },
});
