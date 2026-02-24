import { tool } from '@opencode-ai/plugin';
import { $ } from 'bun';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import {
  loadPricesConfig,
  getDefaultBackfillDate,
  type PricesConfig,
} from '../utils/pricesConfig.ts';
import { updatePriceJournal } from '../utils/journalUtils.ts';
import { getYesterday } from '../utils/dateUtils.ts';

/**
 * Function type for fetching price data from external sources
 */
// eslint-disable-next-line no-unused-vars
export type PriceFetcher = (args: string[]) => Promise<string>;

/**
 * Successful price fetch result
 */
export type PriceSuccess = {
  ticker: string;
  priceLine: string;
  file: string;
};

/**
 * Failed price fetch result
 */
export type PriceError = {
  ticker: string;
  error: string;
};

/**
 * Result of fetching a single currency price
 */
export type PriceResult = PriceSuccess | PriceError;

/**
 * Executes pricehist command using Bun's shell
 */
export async function defaultPriceFetcher(cmdArgs: string[]): Promise<string> {
  // Bun's template literal shell execution uses cmdArgs
  const result = await $`pricehist ${cmdArgs}`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Builds pricehist command arguments
 */
function buildPricehistArgs(
  startDate: string,
  endDate: string,
  currencyConfig: { source: string; pair: string; fmt_base?: string }
): string[] {
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
  return cmdArgs;
}

/**
 * Builds error result JSON
 */
function buildErrorResult(error: string): string {
  return JSON.stringify({ error });
}

/**
 * Builds success result JSON
 */
function buildSuccessResult(results: PriceResult[], endDate: string, backfill: boolean): string {
  return JSON.stringify({
    success: results.every((r) => !('error' in r)),
    endDate,
    backfill,
    results,
  });
}

// Parse a price line and extract date for filtering (keeps original line intact)
// Input: "P 2025-02-17 00:00:00 EUR 0.944 CHF"
// Output: { date: "2025-02-17", formattedLine: "P 2025-02-17 00:00:00 EUR 0.944 CHF" }
function parsePriceLine(line: string): { date: string; formattedLine: string } | null {
  const match = line.match(/^P (\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2}:\d{2})? .+$/);
  if (!match) return null;
  return {
    date: match[1],
    formattedLine: line, // Keep the original line including the timestamp
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
 * Fetches currency price data for all configured currencies
 */
export async function fetchCurrencyPrices(
  directory: string,
  agent: string,
  backfill: boolean,
  priceFetcher: PriceFetcher = defaultPriceFetcher,
  // eslint-disable-next-line no-unused-vars
  configLoader: (directory: string) => PricesConfig = loadPricesConfig
): Promise<string> {
  // Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'fetch currency prices');
  if (restrictionError) {
    return restrictionError;
  }

  // Load configuration
  let config: PricesConfig;
  try {
    config = configLoader(directory);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return buildErrorResult(errorMessage);
  }

  const endDate = getYesterday();
  const defaultBackfillDate = getDefaultBackfillDate();
  const results: PriceResult[] = [];

  for (const [ticker, currencyConfig] of Object.entries(config.currencies)) {
    try {
      // Determine the start date: use per-currency backfill_date, default backfill date, or just today
      const startDate = backfill ? currencyConfig.backfill_date || defaultBackfillDate : endDate;

      // Build pricehist command arguments
      const cmdArgs = buildPricehistArgs(startDate, endDate, currencyConfig);

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
      updatePriceJournal(journalPath, priceLines);

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

  return buildSuccessResult(results, endDate, backfill);
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
    return fetchCurrencyPrices(directory, agent, backfill || false);
  },
});
