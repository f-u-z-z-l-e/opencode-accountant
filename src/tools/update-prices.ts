import { tool } from '@opencode-ai/plugin';
import { $ } from 'bun';
import * as path from 'path';
import * as fs from 'fs';

// Type for the price fetcher function
export type PriceFetcher = (_cmdArgs: string[]) => Promise<string>;

// Default implementation using Bun's shell
export async function defaultPriceFetcher(cmdArgs: string[]): Promise<string> {
  // Bun's template literal shell execution uses cmdArgs
  const result = await $`pricehist ${cmdArgs}`.quiet();
  return result.stdout.toString().trim();
}

const TICKERS: Record<string, { source: string; pair: string; file: string; fmtBase?: string }> = {
  BTC: { source: 'coinmarketcap', pair: 'BTC/CHF', file: 'btc-chf.journal' },
  EUR: { source: 'ecb', pair: 'EUR/CHF', file: 'eur-chf.journal' },
  USD: { source: 'yahoo', pair: 'USDCHF=X', file: 'usd-chf.journal', fmtBase: 'USD' },
};

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

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
  priceFetcher: PriceFetcher = defaultPriceFetcher
): Promise<string> {
  // Agent restriction
  if (agent !== 'accountant') {
    return JSON.stringify({
      error: 'This tool is restricted to the accountant agent only.',
      hint: "Use: Task(subagent_type='accountant', prompt='update prices')",
      caller: agent || 'main assistant',
    });
  }

  const endDate = getYesterday();
  const startDate = backfill ? '2025-12-31' : endDate;
  const results: Array<
    { ticker: string; priceLine: string; file: string } | { ticker: string; error: string }
  > = [];

  for (const [ticker, config] of Object.entries(TICKERS)) {
    try {
      // Build pricehist command arguments
      const cmdArgs = [
        'fetch',
        '-o',
        'ledger',
        '-s',
        startDate,
        '-e',
        endDate,
        config.source,
        config.pair,
      ];
      if (config.fmtBase) {
        cmdArgs.push('--fmt-base', config.fmtBase);
      }

      // Execute pricehist using the injected fetcher
      const output = await priceFetcher(cmdArgs);

      // Split output into lines and filter for price lines only
      const priceLines = output.split('\n').filter((line) => line.startsWith('P '));

      if (priceLines.length === 0) {
        results.push({
          ticker,
          error: `No price lines in pricehist output: ${output}`,
        });
        continue;
      }

      // Update journal file with deduplication
      const journalPath = path.join(directory, 'ledger', 'currencies', config.file);
      updateJournalWithPrices(journalPath, priceLines);

      // Return the last (most recent) price line
      const latestPriceLine = priceLines[priceLines.length - 1];
      results.push({
        ticker,
        priceLine: latestPriceLine,
        file: config.file,
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
    startDate,
    endDate,
    backfill: !!backfill,
    results,
  });
}

export default tool({
  description:
    'ACCOUNTANT AGENT ONLY: Fetches end-of-day prices for all tickers (BTC, EUR, USD in CHF) and appends them to the corresponding price journals.',
  args: {
    backfill: tool.schema
      .boolean()
      .optional()
      .describe('If true, fetch all available history from 2025-12-31'),
  },
  async execute(params, context) {
    const { directory, agent } = context;
    const { backfill } = params;
    return updatePricesCore(directory, agent, backfill || false);
  },
});
