import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadImportConfig } from './importConfig.ts';

describe('importConfig', () => {
  const testDir = path.join(process.cwd(), '.memory', 'test-import-config');
  const configDir = path.join(testDir, 'config', 'import');

  beforeAll(() => {
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadImportConfig', () => {
    it('should load a valid configuration file', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  revolut:
    detect:
      - filenamePattern: "^account-statement_"
        header: "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"
        currencyField: Currency
    currencies:
      CHF: chf
      EUR: eur
`
      );

      const config = loadImportConfig(testDir);

      expect(config.paths).toEqual({
        import: 'statements/import',
        pending: 'doc/agent/todo/import',
        done: 'doc/agent/done/import',
        unrecognized: 'statements/import/unrecognized',
      });

      expect(config.providers.revolut).toBeDefined();
      expect(config.providers.revolut.detect).toHaveLength(1);
      expect(config.providers.revolut.detect[0]).toEqual({
        filenamePattern: '^account-statement_',
        header:
          'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
        currencyField: 'Currency',
      });
      expect(config.providers.revolut.currencies).toEqual({
        CHF: 'chf',
        EUR: 'eur',
      });
    });

    it('should load configuration with multiple detection rules', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  revolut:
    detect:
      - filenamePattern: "^account-statement_"
        header: "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance"
        currencyField: Currency
      - filenamePattern: "^crypto-account-statement_"
        header: "Symbol,Type,Quantity,Price,Value,Fees,Date"
        currencyField: Symbol
    currencies:
      CHF: chf
      BTC: btc
`
      );

      const config = loadImportConfig(testDir);

      expect(config.providers.revolut.detect).toHaveLength(2);
      expect(config.providers.revolut.detect[1].filenamePattern).toBe('^crypto-account-statement_');
      expect(config.providers.revolut.detect[1].currencyField).toBe('Symbol');
    });

    it('should throw error when config file is missing', () => {
      const emptyDir = path.join(testDir, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });

      expect(() => loadImportConfig(emptyDir)).toThrow(
        'Configuration file not found: config/import/providers.yaml'
      );
    });

    it('should throw error for invalid YAML syntax', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(configPath, `paths:\n  imports: [invalid yaml`);

      expect(() => loadImportConfig(testDir)).toThrow(
        /Failed to parse config\/import\/providers\.yaml/
      );
    });

    it('should throw error when paths section is missing', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `providers:
  revolut:
    detect:
      - filenamePattern: "^account-statement_"
        header: "Type,Product"
        currencyField: Currency
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: 'paths' section is required"
      );
    });

    it('should throw error when required path field is missing', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import

providers:
  revolut:
    detect:
      - filenamePattern: "^account-statement_"
        header: "Type,Product"
        currencyField: Currency
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: 'paths.unrecognized' is required"
      );
    });

    it('should throw error when providers section is missing', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: 'providers' section is required"
      );
    });

    it('should throw error when providers section is empty', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers: {}
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: 'providers' section must contain at least one provider"
      );
    });

    it('should throw error when detect array is empty', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  revolut:
    detect: []
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config for provider 'revolut': 'detect' must be a non-empty array"
      );
    });

    it('should throw error when detection rule is missing required field', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  revolut:
    detect:
      - filenamePattern: "^account-statement_"
        header: "Type,Product"
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: provider 'revolut' detect[0].currencyField is required"
      );
    });

    it('should throw error when filenamePattern is not a valid regex', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  revolut:
    detect:
      - filenamePattern: "[invalid("
        header: "Type,Product"
        currencyField: Currency
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: provider 'revolut' detect[0].filenamePattern is not a valid regex"
      );
    });

    it('should throw error when currencies mapping is empty', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  revolut:
    detect:
      - filenamePattern: "^account-statement_"
        header: "Type,Product"
        currencyField: Currency
    currencies: {}
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config for provider 'revolut': 'currencies' must contain at least one mapping"
      );
    });

    it('should accept detection rule without filenamePattern (header-only matching)', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  ubs:
    detect:
      - header: "Date,Amount,Balance"
        currencyField: Currency
    currencies:
      CHF: chf
`
      );

      const config = loadImportConfig(testDir);

      expect(config.providers.ubs.detect[0].filenamePattern).toBeUndefined();
      expect(config.providers.ubs.detect[0].header).toBe('Date,Amount,Balance');
    });

    it('should accept detection rule with skipRows, delimiter, and renamePattern', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  ubs:
    detect:
      - header: "Date,Amount,Balance"
        currencyField: Currency
        skipRows: 9
        delimiter: ";"
        renamePattern: "transactions-ubs-{kontonummer}.csv"
    currencies:
      CHF: chf
`
      );

      const config = loadImportConfig(testDir);

      expect(config.providers.ubs.detect[0].skipRows).toBe(9);
      expect(config.providers.ubs.detect[0].delimiter).toBe(';');
      expect(config.providers.ubs.detect[0].renamePattern).toBe(
        'transactions-ubs-{kontonummer}.csv'
      );
    });

    it('should accept detection rule with metadata extraction config', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  ubs:
    detect:
      - header: "Date,Amount,Balance"
        currencyField: Currency
        skipRows: 9
        metadata:
          - field: kontonummer
            row: 0
            column: 1
            normalize: spaces-to-dashes
          - field: iban
            row: 1
            column: 1
    currencies:
      CHF: chf
`
      );

      const config = loadImportConfig(testDir);

      expect(config.providers.ubs.detect[0].metadata).toHaveLength(2);
      expect(config.providers.ubs.detect[0].metadata![0]).toEqual({
        field: 'kontonummer',
        row: 0,
        column: 1,
        normalize: 'spaces-to-dashes',
      });
      expect(config.providers.ubs.detect[0].metadata![1]).toEqual({
        field: 'iban',
        row: 1,
        column: 1,
      });
    });

    it('should throw error when skipRows is negative', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  ubs:
    detect:
      - header: "Date,Amount,Balance"
        currencyField: Currency
        skipRows: -1
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: provider 'ubs' detect[0].skipRows must be a non-negative number"
      );
    });

    it('should throw error when delimiter is not a single character', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  ubs:
    detect:
      - header: "Date,Amount,Balance"
        currencyField: Currency
        delimiter: "::"
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: provider 'ubs' detect[0].delimiter must be a single character"
      );
    });

    it('should throw error when metadata field is missing required properties', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  ubs:
    detect:
      - header: "Date,Amount,Balance"
        currencyField: Currency
        metadata:
          - field: kontonummer
            row: 0
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: provider 'ubs' detect[0].metadata[0].column must be a non-negative number"
      );
    });

    it('should throw error when metadata normalize has invalid value', () => {
      const configPath = path.join(configDir, 'providers.yaml');
      fs.writeFileSync(
        configPath,
        `paths:
  import: statements/import
  pending: doc/agent/todo/import
  done: doc/agent/done/import
  unrecognized: statements/import/unrecognized

providers:
  ubs:
    detect:
      - header: "Date,Amount,Balance"
        currencyField: Currency
        metadata:
          - field: kontonummer
            row: 0
            column: 1
            normalize: invalid-type
    currencies:
      CHF: chf
`
      );

      expect(() => loadImportConfig(testDir)).toThrow(
        "Invalid config: provider 'ubs' detect[0].metadata[0].normalize must be 'spaces-to-dashes'"
      );
    });
  });
});
