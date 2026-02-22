import { $ } from 'bun';
import type { CsvRowData } from './csvParser.ts';

/**
 * Result of executing an hledger command
 */
export interface HledgerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Type for the hledger executor function (allows dependency injection for testing)
 */
// eslint-disable-next-line no-unused-vars
export type HledgerExecutor = (cmdArgs: string[]) => Promise<HledgerResult>;

/**
 * Default hledger executor using Bun's shell
 */
export async function defaultHledgerExecutor(cmdArgs: string[]): Promise<HledgerResult> {
  try {
    const result = await $`hledger ${cmdArgs}`.quiet().nothrow();
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

/**
 * Represents an unknown posting that couldn't be matched to a known account
 */
export interface UnknownPosting {
  date: string;
  description: string;
  amount: string;
  account: 'income:unknown' | 'expenses:unknown';
  balance?: string;
  csvRow?: CsvRowData;
}

/**
 * Parses hledger print output to extract postings with unknown accounts.
 *
 * Example hledger output format:
 * ```
 * 2026-01-16 Kaeser, Joel
 *     income:unknown                 CHF-95.25 = CHF4746.23
 *     assets:bank:ubs:checking        CHF95.25
 * ```
 *
 * @param hledgerOutput The stdout from hledger print command
 * @returns Array of unknown postings
 */
export function parseUnknownPostings(hledgerOutput: string): UnknownPosting[] {
  const unknownPostings: UnknownPosting[] = [];
  const lines = hledgerOutput.split('\n');

  let currentDate = '';
  let currentDescription = '';

  for (const line of lines) {
    // Match transaction header: date and description
    // Format: "2026-01-16 Description text"
    const headerMatch = line.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
    if (headerMatch) {
      currentDate = headerMatch[1];
      currentDescription = headerMatch[2].trim();
      continue;
    }

    // Match posting line with unknown account
    // Format: "    income:unknown                 CHF-95.25 = CHF4746.23"
    // or:     "    expenses:unknown               CHF10.00 = CHF2364.69"
    const postingMatch = line.match(
      /^\s+(income:unknown|expenses:unknown)\s+([^\s]+(?:\s+[^\s=]+)?)\s*(?:=\s*(.+))?$/
    );
    if (postingMatch && currentDate) {
      unknownPostings.push({
        date: currentDate,
        description: currentDescription,
        amount: postingMatch[2].trim(),
        account: postingMatch[1] as 'income:unknown' | 'expenses:unknown',
        balance: postingMatch[3]?.trim(),
      });
    }
  }

  return unknownPostings;
}

/**
 * Counts the total number of transactions in hledger print output.
 * A transaction starts with a date at the beginning of a line.
 *
 * @param hledgerOutput The stdout from hledger print command
 * @returns The number of transactions
 */
export function countTransactions(hledgerOutput: string): number {
  const lines = hledgerOutput.split('\n');
  let count = 0;

  for (const line of lines) {
    // Transaction header starts with a date
    if (/^\d{4}-\d{2}-\d{2}\s+/.test(line)) {
      count++;
    }
  }

  return count;
}

/**
 * Extracts all unique years from transaction dates in hledger print output.
 *
 * @param hledgerOutput The stdout from hledger print command
 * @returns Set of unique years found in transactions
 */
export function extractTransactionYears(hledgerOutput: string): Set<number> {
  const years = new Set<number>();
  const lines = hledgerOutput.split('\n');

  for (const line of lines) {
    // Transaction header starts with a date: YYYY-MM-DD
    const match = line.match(/^(\d{4})-\d{2}-\d{2}\s+/);
    if (match) {
      years.add(parseInt(match[1], 10));
    }
  }

  return years;
}

/**
 * Result of ledger validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates the ledger by running hledger check --strict and hledger bal.
 * This ensures the ledger is in a valid state with no balance assertion failures,
 * undeclared accounts, or other issues.
 *
 * @param mainJournalPath Path to the main .hledger.journal file
 * @param executor Optional hledger executor (for testing)
 * @returns Validation result with any errors found
 */
export async function validateLedger(
  mainJournalPath: string,
  executor: HledgerExecutor = defaultHledgerExecutor
): Promise<ValidationResult> {
  const errors: string[] = [];

  // Run hledger check --strict to verify ledger integrity
  // This checks balance assertions, account declarations, and more
  const checkResult = await executor(['check', '--strict', '-f', mainJournalPath]);
  if (checkResult.exitCode !== 0) {
    const errorMsg = checkResult.stderr.trim() || checkResult.stdout.trim();
    errors.push(`hledger check --strict failed: ${errorMsg}`);
  }

  // Run hledger bal to verify the ledger parses correctly and balances compute
  const balResult = await executor(['bal', '-f', mainJournalPath]);
  if (balResult.exitCode !== 0) {
    const errorMsg = balResult.stderr.trim() || balResult.stdout.trim();
    errors.push(`hledger bal failed: ${errorMsg}`);
  }

  return { valid: errors.length === 0, errors };
}
