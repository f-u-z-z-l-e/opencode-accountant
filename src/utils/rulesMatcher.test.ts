import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseSourceDirective,
  resolveSourcePath,
  loadRulesMapping,
  findRulesForCsv,
} from './rulesMatcher.ts';

const testDir = path.join(process.cwd(), '.memory', 'test-rules-matcher');

describe('rulesMatcher', () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseSourceDirective', () => {
    it('should parse a simple source directive', () => {
      const content = `source transactions.csv
skip 1
fields date,description,amount`;
      expect(parseSourceDirective(content)).toBe('transactions.csv');
    });

    it('should parse source directive with relative path', () => {
      const content = `# Rules for UBS account
source ../../doc/agent/todo/import/ubs/chf/transactions.csv
skip 9`;
      expect(parseSourceDirective(content)).toBe(
        '../../doc/agent/todo/import/ubs/chf/transactions.csv'
      );
    });

    it('should handle source directive with trailing comment', () => {
      const content = `source transactions.csv # the input file
fields date,amount`;
      expect(parseSourceDirective(content)).toBe('transactions.csv');
    });

    it('should return null when no source directive exists', () => {
      const content = `skip 1
fields date,description,amount`;
      expect(parseSourceDirective(content)).toBeNull();
    });

    it('should handle source directive with extra whitespace', () => {
      const content = `source   path/to/file.csv  
fields date`;
      expect(parseSourceDirective(content)).toBe('path/to/file.csv');
    });

    it('should ignore commented source directive', () => {
      const content = `# source old-file.csv
source actual-file.csv`;
      expect(parseSourceDirective(content)).toBe('actual-file.csv');
    });
  });

  describe('resolveSourcePath', () => {
    it('should resolve relative path from rules file location', () => {
      const sourcePath = '../../data/transactions.csv';
      const rulesFilePath = '/project/ledger/rules/ubs.rules';
      const result = resolveSourcePath(sourcePath, rulesFilePath);
      expect(result).toBe('/project/data/transactions.csv');
    });

    it('should return absolute path unchanged', () => {
      const sourcePath = '/absolute/path/to/file.csv';
      const rulesFilePath = '/project/ledger/rules/ubs.rules';
      const result = resolveSourcePath(sourcePath, rulesFilePath);
      expect(result).toBe('/absolute/path/to/file.csv');
    });

    it('should resolve simple relative path', () => {
      const sourcePath = 'transactions.csv';
      const rulesFilePath = '/project/rules/ubs.rules';
      const result = resolveSourcePath(sourcePath, rulesFilePath);
      expect(result).toBe('/project/rules/transactions.csv');
    });
  });

  describe('loadRulesMapping', () => {
    it('should return empty mapping for non-existent directory', () => {
      const result = loadRulesMapping('/non/existent/path');
      expect(result).toEqual({});
    });

    it('should return empty mapping for empty directory', () => {
      const result = loadRulesMapping(testDir);
      expect(result).toEqual({});
    });

    it('should map CSV to rules file based on source directive', () => {
      const rulesDir = path.join(testDir, 'rules');
      const dataDir = path.join(testDir, 'data');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });

      const csvPath = path.join(dataDir, 'transactions.csv');
      fs.writeFileSync(csvPath, 'date,amount\n2026-01-01,100');

      const rulesPath = path.join(rulesDir, 'ubs.rules');
      fs.writeFileSync(rulesPath, `source ../data/transactions.csv\nskip 1`);

      const mapping = loadRulesMapping(rulesDir);
      expect(mapping[csvPath]).toBe(rulesPath);
    });

    it('should handle multiple rules files', () => {
      const rulesDir = path.join(testDir, 'rules');
      const dataDir = path.join(testDir, 'data');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });

      const csv1 = path.join(dataDir, 'ubs.csv');
      const csv2 = path.join(dataDir, 'revolut.csv');
      fs.writeFileSync(csv1, 'data');
      fs.writeFileSync(csv2, 'data');

      const rules1 = path.join(rulesDir, 'ubs.rules');
      const rules2 = path.join(rulesDir, 'revolut.rules');
      fs.writeFileSync(rules1, 'source ../data/ubs.csv');
      fs.writeFileSync(rules2, 'source ../data/revolut.csv');

      const mapping = loadRulesMapping(rulesDir);
      expect(mapping[csv1]).toBe(rules1);
      expect(mapping[csv2]).toBe(rules2);
    });

    it('should ignore files without .rules extension', () => {
      const rulesDir = path.join(testDir, 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });

      fs.writeFileSync(path.join(rulesDir, 'readme.txt'), 'source fake.csv');
      fs.writeFileSync(path.join(rulesDir, 'config.yaml'), 'source fake.csv');

      const mapping = loadRulesMapping(rulesDir);
      expect(Object.keys(mapping)).toHaveLength(0);
    });

    it('should skip rules files without source directive', () => {
      const rulesDir = path.join(testDir, 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });

      fs.writeFileSync(path.join(rulesDir, 'incomplete.rules'), 'skip 1\nfields date,amount');

      const mapping = loadRulesMapping(rulesDir);
      expect(Object.keys(mapping)).toHaveLength(0);
    });
  });

  describe('findRulesForCsv', () => {
    it('should find rules file by direct path match', () => {
      const mapping = {
        '/project/data/transactions.csv': '/project/rules/ubs.rules',
      };
      const result = findRulesForCsv('/project/data/transactions.csv', mapping);
      expect(result).toBe('/project/rules/ubs.rules');
    });

    it('should return null when no match found', () => {
      const mapping = {
        '/project/data/transactions.csv': '/project/rules/ubs.rules',
      };
      const result = findRulesForCsv('/project/data/other.csv', mapping);
      expect(result).toBeNull();
    });

    it('should match normalized paths', () => {
      const mapping = {
        '/project/data/../data/transactions.csv': '/project/rules/ubs.rules',
      };
      const result = findRulesForCsv('/project/data/transactions.csv', mapping);
      expect(result).toBe('/project/rules/ubs.rules');
    });

    describe('filename-based matching', () => {
      it('should match CSV by filename when path matching fails', () => {
        const mapping = {
          '/repo/import/pending/ubs/chf/ubs-0235*.csv': '/repo/rules/ubs-0235-90250546.0.rules',
        };
        // CSV is in done directory, path matching fails, filename matching succeeds
        const csvPath =
          '/repo/import/done/ubs/chf/ubs-0235-90250546.0-transactions-2026-01-05-to-2026-01-31.csv';
        expect(findRulesForCsv(csvPath, mapping)).toBe('/repo/rules/ubs-0235-90250546.0.rules');
      });

      it('should use longest-match strategy for ambiguous filenames', () => {
        const mapping = {
          '/repo/import/pending/a/account1*.csv': '/repo/rules/account1.rules',
          '/repo/import/pending/b/account10*.csv': '/repo/rules/account10.rules',
        };
        const csvPath = '/repo/import/done/a/account10-transactions.csv';
        // account10.rules should match (longer prefix) instead of account1.rules
        expect(findRulesForCsv(csvPath, mapping)).toBe('/repo/rules/account10.rules');
      });

      it('should prefer path/glob matching over filename matching', () => {
        const mapping = {
          '/repo/import/done/ubs/chf/ubs-0235*.csv': '/repo/rules/ubs-exact-path.rules',
          '/repo/import/pending/other/ubs-0235*.csv': '/repo/rules/ubs-other.rules',
        };
        const csvPath = '/repo/import/done/ubs/chf/ubs-0235-90250546.0-transactions.csv';
        // Glob pattern matches (tier 3), should prefer that over filename matching (tier 4)
        expect(findRulesForCsv(csvPath, mapping)).toBe('/repo/rules/ubs-exact-path.rules');
      });

      it('should handle multiple filename matches by choosing longest', () => {
        const mapping = {
          '/repo/import/pending/a/ubs*.csv': '/repo/rules/ubs.rules',
          '/repo/import/pending/b/ubs-0235*.csv': '/repo/rules/ubs-0235.rules',
          '/repo/import/pending/c/ubs-0235-90250546.0*.csv':
            '/repo/rules/ubs-0235-90250546.0.rules',
        };
        const csvPath = '/repo/import/done/ubs/chf/ubs-0235-90250546.0-transactions-2026-01.csv';
        // Most specific (longest) match should win
        expect(findRulesForCsv(csvPath, mapping)).toBe('/repo/rules/ubs-0235-90250546.0.rules');
      });

      it('should match exact filename without additional suffix', () => {
        const mapping = {
          '/repo/import/pending/ubs/ubs-0235-90250546.0*.csv':
            '/repo/rules/ubs-0235-90250546.0.rules',
        };
        const csvPath = '/repo/import/done/ubs/ubs-0235-90250546.0.csv';
        expect(findRulesForCsv(csvPath, mapping)).toBe('/repo/rules/ubs-0235-90250546.0.rules');
      });

      it('should return null when no filename match exists', () => {
        const mapping = {
          '/repo/import/pending/postfinance/pf*.csv': '/repo/rules/postfinance.rules',
        };
        const csvPath = '/repo/import/done/ubs/ubs-account-transactions.csv';
        expect(findRulesForCsv(csvPath, mapping)).toBeNull();
      });
    });
  });
});
