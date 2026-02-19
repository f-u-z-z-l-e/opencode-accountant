import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadPricesConfig, getDefaultBackfillDate } from './pricesConfig.ts';

describe('pricesConfig', () => {
  const testDir = path.join(process.cwd(), '.memory', 'test-prices-config');
  const configDir = path.join(testDir, 'config');

  beforeAll(() => {
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getDefaultBackfillDate', () => {
    it('should return January 1st of current year', () => {
      const result = getDefaultBackfillDate();
      const expectedYear = new Date().getFullYear();
      expect(result).toBe(`${expectedYear}-01-01`);
    });
  });

  describe('loadPricesConfig', () => {
    it('should load a valid configuration file', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(
        configPath,
        `currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/CHF
    file: btc-chf.journal
    backfill_date: "2025-12-31"
  EUR:
    source: ecb
    pair: EUR/CHF
    file: eur-chf.journal
`
      );

      const config = loadPricesConfig(testDir);

      expect(config.currencies).toBeDefined();
      expect(Object.keys(config.currencies)).toHaveLength(2);

      expect(config.currencies.BTC).toEqual({
        source: 'coinmarketcap',
        pair: 'BTC/CHF',
        file: 'btc-chf.journal',
        backfill_date: '2025-12-31',
        fmt_base: undefined,
      });

      expect(config.currencies.EUR).toEqual({
        source: 'ecb',
        pair: 'EUR/CHF',
        file: 'eur-chf.journal',
        backfill_date: undefined,
        fmt_base: undefined,
      });
    });

    it('should load configuration with fmt_base option', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(
        configPath,
        `currencies:
  USD:
    source: yahoo
    pair: USDCHF=X
    file: usd-chf.journal
    fmt_base: USD
`
      );

      const config = loadPricesConfig(testDir);

      expect(config.currencies.USD.fmt_base).toBe('USD');
    });

    it('should throw error when config file is missing', () => {
      const emptyDir = path.join(testDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      expect(() => loadPricesConfig(emptyDir)).toThrow(
        "Configuration file not found: config/prices.yaml. Please refer to the plugin's GitHub repository for setup instructions."
      );
    });

    it('should throw error for invalid YAML syntax', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(configPath, `currencies:\n  BTC:\n    source: [invalid yaml`);

      expect(() => loadPricesConfig(testDir)).toThrow(/Failed to parse config\/prices\.yaml/);
    });

    it('should throw error when currencies section is missing', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(configPath, `other_key: value`);

      expect(() => loadPricesConfig(testDir)).toThrow(
        "Invalid config: 'currencies' section is required"
      );
    });

    it('should throw error when currencies section is empty', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(configPath, `currencies: {}`);

      expect(() => loadPricesConfig(testDir)).toThrow(
        "Invalid config: 'currencies' section must contain at least one currency"
      );
    });

    it('should throw error when required field is missing', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(
        configPath,
        `currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/CHF
`
      );

      expect(() => loadPricesConfig(testDir)).toThrow(
        "Invalid config for currency 'BTC': missing required field 'file'"
      );
    });

    it('should throw error when required field is empty string', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(
        configPath,
        `currencies:
  BTC:
    source: ""
    pair: BTC/CHF
    file: btc-chf.journal
`
      );

      expect(() => loadPricesConfig(testDir)).toThrow(
        "Invalid config for currency 'BTC': missing required field 'source'"
      );
    });

    it('should handle per-currency backfill dates', () => {
      const configPath = path.join(configDir, 'prices.yaml');
      fs.writeFileSync(
        configPath,
        `currencies:
  BTC:
    source: coinmarketcap
    pair: BTC/CHF
    file: btc-chf.journal
    backfill_date: "2024-06-01"
  EUR:
    source: ecb
    pair: EUR/CHF
    file: eur-chf.journal
    backfill_date: "2025-01-01"
  USD:
    source: yahoo
    pair: USDCHF=X
    file: usd-chf.journal
`
      );

      const config = loadPricesConfig(testDir);

      expect(config.currencies.BTC.backfill_date).toBe('2024-06-01');
      expect(config.currencies.EUR.backfill_date).toBe('2025-01-01');
      expect(config.currencies.USD.backfill_date).toBeUndefined();
    });
  });
});
