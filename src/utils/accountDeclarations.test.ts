import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractAccountsFromRulesFile,
  getAllAccountsFromRules,
  sortAccountDeclarations,
  ensureAccountDeclarations,
} from './accountDeclarations.ts';

describe('extractAccountsFromRulesFile', () => {
  let tempDir: string;
  let rulesFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-test-'));
    rulesFile = path.join(tempDir, 'test.rules');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts account1 directive', () => {
    fs.writeFileSync(
      rulesFile,
      `
skip 1
account1 assets:bank:ubs:checking
fields date, description, amount
`
    );

    const accounts = extractAccountsFromRulesFile(rulesFile);
    expect(accounts.has('assets:bank:ubs:checking')).toBe(true);
    expect(accounts.size).toBe(1);
  });

  it('extracts account2 directives', () => {
    fs.writeFileSync(
      rulesFile,
      `
account1 assets:bank:ubs:checking

if %description Migros
  account2 expenses:groceries

if %description Coop
  account2 expenses:groceries

if %description SBB
  account2 expenses:transport
`
    );

    const accounts = extractAccountsFromRulesFile(rulesFile);
    expect(accounts.has('assets:bank:ubs:checking')).toBe(true);
    expect(accounts.has('expenses:groceries')).toBe(true);
    expect(accounts.has('expenses:transport')).toBe(true);
    expect(accounts.size).toBe(3);
  });

  it('ignores comments and empty lines', () => {
    fs.writeFileSync(
      rulesFile,
      `
# This is a comment
; This is also a comment
account1 assets:bank:ubs:checking

; Some commented account
# account2 expenses:fake
if %description Test
  account2 expenses:real
`
    );

    const accounts = extractAccountsFromRulesFile(rulesFile);
    expect(accounts.has('assets:bank:ubs:checking')).toBe(true);
    expect(accounts.has('expenses:real')).toBe(true);
    expect(accounts.has('expenses:fake')).toBe(false);
    expect(accounts.size).toBe(2);
  });

  it('returns empty set for non-existent file', () => {
    const accounts = extractAccountsFromRulesFile('/non/existent/file.rules');
    expect(accounts.size).toBe(0);
  });
});

describe('getAllAccountsFromRules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('combines accounts from multiple rules files', () => {
    const rulesFile1 = path.join(tempDir, 'ubs.rules');
    const rulesFile2 = path.join(tempDir, 'revolut.rules');

    fs.writeFileSync(
      rulesFile1,
      `
account1 assets:bank:ubs:checking
if %description Migros
  account2 expenses:groceries
`
    );

    fs.writeFileSync(
      rulesFile2,
      `
account1 assets:bank:revolut:checking
if %description Amazon
  account2 expenses:shopping
`
    );

    const accounts = getAllAccountsFromRules([rulesFile1, rulesFile2]);
    expect(accounts.has('assets:bank:ubs:checking')).toBe(true);
    expect(accounts.has('assets:bank:revolut:checking')).toBe(true);
    expect(accounts.has('expenses:groceries')).toBe(true);
    expect(accounts.has('expenses:shopping')).toBe(true);
    expect(accounts.size).toBe(4);
  });

  it('deduplicates accounts across files', () => {
    const rulesFile1 = path.join(tempDir, 'ubs.rules');
    const rulesFile2 = path.join(tempDir, 'revolut.rules');

    fs.writeFileSync(
      rulesFile1,
      `
account1 assets:bank:ubs:checking
if %description Migros
  account2 expenses:groceries
`
    );

    fs.writeFileSync(
      rulesFile2,
      `
account1 assets:bank:revolut:checking
if %description Migros
  account2 expenses:groceries
`
    );

    const accounts = getAllAccountsFromRules([rulesFile1, rulesFile2]);
    expect(accounts.has('expenses:groceries')).toBe(true);
    expect(accounts.size).toBe(3); // Not 4, because expenses:groceries appears twice
  });
});

describe('sortAccountDeclarations', () => {
  it('sorts accounts alphabetically', () => {
    const accounts = new Set([
      'expenses:transport',
      'assets:bank:ubs',
      'expenses:groceries',
      'income:salary',
    ]);

    const sorted = sortAccountDeclarations(accounts);
    expect(sorted).toEqual([
      'assets:bank:ubs',
      'expenses:groceries',
      'expenses:transport',
      'income:salary',
    ]);
  });

  it('handles hierarchy correctly', () => {
    const accounts = new Set([
      'assets:bank:ubs:checking',
      'assets:bank:ubs',
      'assets:bank:revolut:checking',
      'assets:bank',
    ]);

    const sorted = sortAccountDeclarations(accounts);
    expect(sorted).toEqual([
      'assets:bank',
      'assets:bank:revolut:checking',
      'assets:bank:ubs',
      'assets:bank:ubs:checking',
    ]);
  });
});

describe('ensureAccountDeclarations', () => {
  let tempDir: string;
  let journalFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-test-'));
    journalFile = path.join(tempDir, '2026.journal');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('adds account declarations to empty journal', () => {
    fs.writeFileSync(journalFile, '; 2026 transactions\n');

    const accounts = new Set(['assets:bank:ubs:checking', 'expenses:groceries']);
    const result = ensureAccountDeclarations(journalFile, accounts);

    expect(result.updated).toBe(true);
    expect(result.added).toEqual(['assets:bank:ubs:checking', 'expenses:groceries']);

    const content = fs.readFileSync(journalFile, 'utf-8');
    expect(content).toContain('account assets:bank:ubs:checking');
    expect(content).toContain('account expenses:groceries');
  });

  it('preserves existing account declarations', () => {
    fs.writeFileSync(
      journalFile,
      `; 2026 transactions

account assets:bank:ubs:checking
account expenses:groceries

2026-01-15 Migros
    assets:bank:ubs:checking  CHF -50.00
    expenses:groceries
`
    );

    const accounts = new Set(['assets:bank:ubs:checking', 'expenses:groceries']);
    const result = ensureAccountDeclarations(journalFile, accounts);

    expect(result.updated).toBe(false);
    expect(result.added).toEqual([]);
  });

  it('adds missing accounts while preserving existing ones', () => {
    fs.writeFileSync(
      journalFile,
      `; 2026 transactions

account assets:bank:ubs:checking

2026-01-15 Migros
    assets:bank:ubs:checking  CHF -50.00
    expenses:groceries
`
    );

    const accounts = new Set([
      'assets:bank:ubs:checking',
      'expenses:groceries',
      'expenses:transport',
    ]);
    const result = ensureAccountDeclarations(journalFile, accounts);

    expect(result.updated).toBe(true);
    expect(result.added.sort()).toEqual(['expenses:groceries', 'expenses:transport']);

    const content = fs.readFileSync(journalFile, 'utf-8');
    expect(content).toContain('account assets:bank:ubs:checking');
    expect(content).toContain('account expenses:groceries');
    expect(content).toContain('account expenses:transport');
  });

  it('sorts all account declarations together', () => {
    fs.writeFileSync(
      journalFile,
      `; 2026 transactions

account expenses:groceries
account assets:bank:ubs:checking
`
    );

    const accounts = new Set([
      'assets:bank:ubs:checking',
      'expenses:groceries',
      'expenses:transport',
    ]);
    const result = ensureAccountDeclarations(journalFile, accounts);

    expect(result.updated).toBe(true);
    expect(result.added).toEqual(['expenses:transport']);

    const content = fs.readFileSync(journalFile, 'utf-8');
    const lines = content.split('\n');

    // Find account declaration lines
    const accountLines = lines
      .filter((line) => line.trim().startsWith('account '))
      .map((line) => line.trim());

    // Should be sorted
    expect(accountLines).toEqual([
      'account assets:bank:ubs:checking',
      'account expenses:groceries',
      'account expenses:transport',
    ]);
  });

  it('preserves transactions and other content', () => {
    fs.writeFileSync(
      journalFile,
      `; 2026 transactions

account assets:bank:ubs:checking

2026-01-15 Migros
    assets:bank:ubs:checking  CHF -50.00
    expenses:groceries

2026-01-20 SBB
    assets:bank:ubs:checking  CHF -30.00
    expenses:transport
`
    );

    const accounts = new Set([
      'assets:bank:ubs:checking',
      'expenses:groceries',
      'expenses:transport',
    ]);
    ensureAccountDeclarations(journalFile, accounts);

    const content = fs.readFileSync(journalFile, 'utf-8');
    expect(content).toContain('2026-01-15 Migros');
    expect(content).toContain('2026-01-20 SBB');
    expect(content).toContain('CHF -50.00');
    expect(content).toContain('CHF -30.00');
  });

  it('throws error for non-existent journal', () => {
    const nonExistentFile = path.join(tempDir, 'non-existent.journal');
    const accounts = new Set(['assets:bank:ubs:checking']);

    expect(() => ensureAccountDeclarations(nonExistentFile, accounts)).toThrow(
      'Year journal not found'
    );
  });
});
