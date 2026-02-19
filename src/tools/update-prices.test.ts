import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { updatePricesCore } from './update-prices.ts';

describe('update-prices tool', () => {
  const testDir = path.join(process.cwd(), '.memory', 'test-update-prices');
  const ledgerDir = path.join(testDir, 'ledger', 'currencies');

  beforeAll(() => {
    // Create test directory structure
    fs.mkdirSync(ledgerDir, { recursive: true });
  });

  afterAll(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should reject non-accountant agents', async () => {
    const result = await updatePricesCore(testDir, 'other-agent', false);
    const parsed = JSON.parse(result);

    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('restricted to the accountant agent');
  });

  it('should write price files to ledger/currencies/ directory for all tickers', async () => {
    // Mock pricehist responses with real data format
    const mockPriceFetcher = async (cmdArgs: string[]): Promise<string> => {
      // The pair is the last arg, but for USD with --fmt-base, it's before the last two args
      const pairIndex =
        cmdArgs.indexOf('--fmt-base') !== -1
          ? cmdArgs.length - 3 // If --fmt-base exists, pair is 3rd from end
          : cmdArgs.length - 1; // Otherwise, pair is last
      const pair = cmdArgs[pairIndex];

      if (pair === 'BTC/CHF') {
        return 'P 2026-02-18 00:00:00 BTC 88494.8925094421 CHF';
      } else if (pair === 'EUR/CHF') {
        return 'P 2026-02-18 00:00:00 EUR 0.9124 CHF';
      } else if (pair === 'USDCHF=X') {
        return 'P 2026-02-18 00:00:00 USD 0.7702000141143799 CHF';
      }
      return '';
    };

    const result = await updatePricesCore(testDir, 'accountant', false, mockPriceFetcher);
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.results).toHaveLength(3);

    // Verify BTC file
    const btcPath = path.join(ledgerDir, 'btc-chf.journal');
    expect(fs.existsSync(btcPath)).toBe(true);
    const btcContent = fs.readFileSync(btcPath, 'utf-8');
    expect(btcContent).toContain('P 2026-02-18 00:00:00 BTC');
    expect(btcContent).toContain('CHF');

    // Verify EUR file
    const eurPath = path.join(ledgerDir, 'eur-chf.journal');
    expect(fs.existsSync(eurPath)).toBe(true);
    const eurContent = fs.readFileSync(eurPath, 'utf-8');
    expect(eurContent).toContain('P 2026-02-18 00:00:00 EUR');
    expect(eurContent).toContain('0.9124 CHF');

    // Verify USD file
    const usdPath = path.join(ledgerDir, 'usd-chf.journal');
    expect(fs.existsSync(usdPath)).toBe(true);
    const usdContent = fs.readFileSync(usdPath, 'utf-8');
    expect(usdContent).toContain('P 2026-02-18 00:00:00 USD');
    expect(usdContent).toContain('CHF');
  });

  it('should deduplicate prices by date and sort chronologically', async () => {
    // Pre-populate BTC file with existing prices
    const btcPath = path.join(ledgerDir, 'btc-chf.journal');
    fs.writeFileSync(
      btcPath,
      'P 2026-02-17 00:00:00 BTC 87000.00 CHF\nP 2026-02-19 00:00:00 BTC 90000.00 CHF\n'
    );

    const mockPriceFetcher = async (cmdArgs: string[]): Promise<string> => {
      const pair = cmdArgs[cmdArgs.length - 1];

      if (pair === 'BTC/CHF') {
        // Return price for 2026-02-18 (middle date) - should be inserted in order
        return 'P 2026-02-18 00:00:00 BTC 88494.8925094421 CHF';
      } else if (pair === 'EUR/CHF') {
        return 'P 2026-02-18 00:00:00 EUR 0.9124 CHF';
      } else if (pair === 'USDCHF=X') {
        return 'P 2026-02-18 00:00:00 USD 0.7702000141143799 CHF';
      }
      return '';
    };

    await updatePricesCore(testDir, 'accountant', false, mockPriceFetcher);

    // Read BTC file and verify sorting
    const btcContent = fs.readFileSync(btcPath, 'utf-8');
    const lines = btcContent.trim().split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('2026-02-17'); // Oldest first
    expect(lines[1]).toContain('2026-02-18'); // Middle
    expect(lines[2]).toContain('2026-02-19'); // Newest last
  });

  it('should use correct date range for backfill mode', async () => {
    let capturedStartDate = '';

    const mockPriceFetcher = async (cmdArgs: string[]): Promise<string> => {
      // Find the -s flag and capture the date after it
      const sIndex = cmdArgs.indexOf('-s');
      if (sIndex !== -1 && sIndex + 1 < cmdArgs.length) {
        capturedStartDate = cmdArgs[sIndex + 1];
      }
      return 'P 2026-02-18 00:00:00 BTC 88494.8925094421 CHF';
    };

    const result = await updatePricesCore(testDir, 'accountant', true, mockPriceFetcher);
    const parsed = JSON.parse(result);

    expect(parsed.backfill).toBe(true);
    expect(parsed.startDate).toBe('2025-12-31');
    expect(capturedStartDate).toBe('2025-12-31');
  });
});
