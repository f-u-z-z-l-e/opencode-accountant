import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { updatePrices } from './update-prices.ts';
import { getDefaultBackfillDate } from '../utils/pricesConfig.ts';

describe('update-prices tool', () => {
  const testDir = path.join(process.cwd(), '.memory', 'test-update-prices');
  const ledgerDir = path.join(testDir, 'ledger', 'currencies');
  const configDir = path.join(testDir, 'config');

  // Standard test config with all three currencies
  const standardConfig = `currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/CHF
    file: btc-chf.journal
    backfill_date: "2025-12-31"
  EUR:
    source: ecb
    pair: EUR/CHF
    file: eur-chf.journal
    backfill_date: "2025-06-01"
  USD:
    source: yahoo
    pair: USDCHF=X
    file: usd-chf.journal
    fmt_base: USD
`;

  beforeAll(() => {
    // Create test directory structure
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
  });

  beforeEach(() => {
    // Write standard config before each test
    fs.writeFileSync(path.join(configDir, 'prices.yaml'), standardConfig);

    // Clean up any existing journal files
    for (const file of ['btc-chf.journal', 'eur-chf.journal', 'usd-chf.journal']) {
      const filePath = path.join(ledgerDir, file);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  afterAll(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should reject non-accountant agents', async () => {
    const result = await updatePrices(testDir, 'other-agent', false);
    const parsed = JSON.parse(result);

    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('restricted to the accountant agent');
  });

  it('should return error when config file is missing', async () => {
    const emptyDir = path.join(testDir, 'empty-project');
    fs.mkdirSync(emptyDir, { recursive: true });

    const result = await updatePrices(emptyDir, 'accountant', false);
    const parsed = JSON.parse(result);

    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('Configuration file not found');
    expect(parsed.error).toContain("plugin's GitHub repository");
  });

  it('should write price files to ledger/currencies/ directory for all configured tickers', async () => {
    // Get yesterday's date dynamically to match what the tool expects
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    // Mock pricehist responses with real data format
    const mockPriceFetcher = async (cmdArgs: string[]): Promise<string> => {
      // The pair is the last arg, but for USD with --fmt-base, it's before the last two args
      const pairIndex =
        cmdArgs.indexOf('--fmt-base') !== -1
          ? cmdArgs.length - 3 // If --fmt-base exists, pair is 3rd from end
          : cmdArgs.length - 1; // Otherwise, pair is last
      const pair = cmdArgs[pairIndex];

      if (pair === 'BTC/CHF') {
        return `P ${dateStr} 00:00:00 BTC 88494.8925094421 CHF`;
      } else if (pair === 'EUR/CHF') {
        return `P ${dateStr} 00:00:00 EUR 0.9124 CHF`;
      } else if (pair === 'USDCHF=X') {
        return `P ${dateStr} 00:00:00 USD 0.7702000141143799 CHF`;
      }
      return '';
    };

    const result = await updatePrices(testDir, 'accountant', false, mockPriceFetcher);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.results).toHaveLength(3);

    // Verify BTC file
    const btcPath = path.join(ledgerDir, 'btc-chf.journal');
    expect(fs.existsSync(btcPath)).toBe(true);
    const btcContent = fs.readFileSync(btcPath, 'utf-8');
    expect(btcContent).toContain(`P ${dateStr} 00:00:00 BTC`);
    expect(btcContent).toContain('CHF');

    // Verify EUR file
    const eurPath = path.join(ledgerDir, 'eur-chf.journal');
    expect(fs.existsSync(eurPath)).toBe(true);
    const eurContent = fs.readFileSync(eurPath, 'utf-8');
    expect(eurContent).toContain(`P ${dateStr} 00:00:00 EUR`);
    expect(eurContent).toContain('0.9124 CHF');

    // Verify USD file
    const usdPath = path.join(ledgerDir, 'usd-chf.journal');
    expect(fs.existsSync(usdPath)).toBe(true);
    const usdContent = fs.readFileSync(usdPath, 'utf-8');
    expect(usdContent).toContain(`P ${dateStr} 00:00:00 USD`);
    expect(usdContent).toContain('CHF');
  });

  it('should deduplicate prices by date and sort chronologically', async () => {
    // Get yesterday's date dynamically
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    // Create dates around yesterday for testing sort order
    const dayBefore = new Date(yesterday);
    dayBefore.setDate(dayBefore.getDate() - 1);
    const dayBeforeStr = dayBefore.toISOString().split('T')[0];

    const dayAfter = new Date(yesterday);
    dayAfter.setDate(dayAfter.getDate() + 1);
    const dayAfterStr = dayAfter.toISOString().split('T')[0];

    // Pre-populate BTC file with existing prices (day before and day after yesterday)
    const btcPath = path.join(ledgerDir, 'btc-chf.journal');
    fs.writeFileSync(
      btcPath,
      `P ${dayBeforeStr} 00:00:00 BTC 87000.00 CHF\nP ${dayAfterStr} 00:00:00 BTC 90000.00 CHF\n`
    );

    const mockPriceFetcher = async (cmdArgs: string[]): Promise<string> => {
      const pairIndex =
        cmdArgs.indexOf('--fmt-base') !== -1 ? cmdArgs.length - 3 : cmdArgs.length - 1;
      const pair = cmdArgs[pairIndex];

      if (pair === 'BTC/CHF') {
        // Return price for yesterday (middle date) - should be inserted in order
        return `P ${dateStr} 00:00:00 BTC 88494.8925094421 CHF`;
      } else if (pair === 'EUR/CHF') {
        return `P ${dateStr} 00:00:00 EUR 0.9124 CHF`;
      } else if (pair === 'USDCHF=X') {
        return `P ${dateStr} 00:00:00 USD 0.7702000141143799 CHF`;
      }
      return '';
    };

    await updatePrices(testDir, 'accountant', false, mockPriceFetcher);

    // Read BTC file and verify sorting
    const btcContent = fs.readFileSync(btcPath, 'utf-8');
    const lines = btcContent.trim().split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(dayBeforeStr); // Oldest first
    expect(lines[1]).toContain(dateStr); // Middle (yesterday)
    expect(lines[2]).toContain(dayAfterStr); // Newest last
  });

  it('should use per-currency backfill_date when backfill mode is enabled', async () => {
    const capturedDates: Record<string, string> = {};

    const mockPriceFetcher = async (cmdArgs: string[]): Promise<string> => {
      // Find the -s flag and capture the date after it
      const sIndex = cmdArgs.indexOf('-s');
      const pairIndex =
        cmdArgs.indexOf('--fmt-base') !== -1 ? cmdArgs.length - 3 : cmdArgs.length - 1;
      const pair = cmdArgs[pairIndex];

      if (sIndex !== -1 && sIndex + 1 < cmdArgs.length) {
        capturedDates[pair] = cmdArgs[sIndex + 1];
      }

      if (pair === 'BTC/CHF') {
        return 'P 2026-02-18 00:00:00 BTC 88494.8925094421 CHF';
      } else if (pair === 'EUR/CHF') {
        return 'P 2026-02-18 00:00:00 EUR 0.9124 CHF';
      } else if (pair === 'USDCHF=X') {
        return 'P 2026-02-18 00:00:00 USD 0.7702000141143799 CHF';
      }
      return '';
    };

    const result = await updatePrices(testDir, 'accountant', true, mockPriceFetcher);
    const parsed = JSON.parse(result);

    expect(parsed.backfill).toBe(true);

    // BTC has backfill_date: "2025-12-31"
    expect(capturedDates['BTC/CHF']).toBe('2025-12-31');

    // EUR has backfill_date: "2025-06-01"
    expect(capturedDates['EUR/CHF']).toBe('2025-06-01');

    // USD has no backfill_date, should use default (Jan 1 of current year)
    expect(capturedDates['USDCHF=X']).toBe(getDefaultBackfillDate());
  });

  it('should use default backfill date (Jan 1 of current year) when not specified', async () => {
    // Write config without backfill_date for any currency
    fs.writeFileSync(
      path.join(configDir, 'prices.yaml'),
      `currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/CHF
    file: btc-chf.journal
`
    );

    let capturedStartDate = '';

    const mockPriceFetcher = async (cmdArgs: string[]): Promise<string> => {
      const sIndex = cmdArgs.indexOf('-s');
      if (sIndex !== -1 && sIndex + 1 < cmdArgs.length) {
        capturedStartDate = cmdArgs[sIndex + 1];
      }
      return 'P 2026-02-18 00:00:00 BTC 88494.8925094421 CHF';
    };

    await updatePrices(testDir, 'accountant', true, mockPriceFetcher);

    const expectedDate = getDefaultBackfillDate();
    expect(capturedStartDate).toBe(expectedDate);
  });
});
