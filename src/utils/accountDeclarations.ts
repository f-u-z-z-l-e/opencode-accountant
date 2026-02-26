import * as fs from 'fs';

/**
 * Extracts all account names from a hledger rules file.
 * Looks for:
 * - account1 directive (primary account)
 * - account2 directives in if rules (category accounts)
 *
 * @param rulesPath Path to the .rules file
 * @returns Set of unique account names
 */
export function extractAccountsFromRulesFile(rulesPath: string): Set<string> {
  const accounts = new Set<string>();

  if (!fs.existsSync(rulesPath)) {
    return accounts;
  }

  const content = fs.readFileSync(rulesPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed === '') {
      continue;
    }

    // Extract account1 directive
    const account1Match = trimmed.match(/^account1\s+(.+?)(?:\s+|$)/);
    if (account1Match) {
      accounts.add(account1Match[1].trim());
      continue;
    }

    // Extract account2 directives (in if rules or standalone)
    const account2Match = trimmed.match(/account2\s+(.+?)(?:\s+|$)/);
    if (account2Match) {
      accounts.add(account2Match[1].trim());
      continue;
    }
  }

  return accounts;
}

/**
 * Extracts all accounts from multiple rules files.
 *
 * @param rulesPaths Array of paths to .rules files
 * @returns Set of unique account names from all files
 */
export function getAllAccountsFromRules(rulesPaths: string[]): Set<string> {
  const allAccounts = new Set<string>();

  for (const rulesPath of rulesPaths) {
    const accounts = extractAccountsFromRulesFile(rulesPath);
    for (const account of accounts) {
      allAccounts.add(account);
    }
  }

  return allAccounts;
}

/**
 * Sorts account declarations by hierarchy.
 * Accounts are sorted alphabetically, with hierarchy respected.
 *
 * @param accounts Set of account names
 * @returns Sorted array of account names
 *
 * @example
 * sortAccountDeclarations(['expenses:food', 'assets:bank', 'expenses:transport'])
 * // Returns: ['assets:bank', 'expenses:food', 'expenses:transport']
 */
export function sortAccountDeclarations(accounts: Set<string>): string[] {
  return Array.from(accounts).sort((a, b) => a.localeCompare(b));
}

/**
 * Ensures that all required account declarations exist in a year journal file.
 * Adds missing declarations at the top of the file (after comment lines).
 * Existing account declarations and transactions are preserved.
 *
 * @param yearJournalPath Path to the year journal file (e.g., ledger/2026.journal)
 * @param accounts Set of account names that should be declared
 * @returns Object with added accounts and whether the file was updated
 */
export function ensureAccountDeclarations(
  yearJournalPath: string,
  accounts: Set<string>
): { added: string[]; updated: boolean } {
  if (!fs.existsSync(yearJournalPath)) {
    throw new Error(`Year journal not found: ${yearJournalPath}`);
  }

  const content = fs.readFileSync(yearJournalPath, 'utf-8');
  const lines = content.split('\n');

  // Parse existing account declarations
  const existingAccounts = new Set<string>();
  const commentLines: string[] = [];
  const accountLines: string[] = [];
  const otherLines: string[] = [];

  let inAccountSection = false;
  let accountSectionEnded = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Comments at the top
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) {
      if (!accountSectionEnded) {
        commentLines.push(line);
      } else {
        otherLines.push(line);
      }
      continue;
    }

    // Account declaration
    if (trimmed.startsWith('account ')) {
      inAccountSection = true;
      const accountMatch = trimmed.match(/^account\s+(.+?)(?:\s+|$)/);
      if (accountMatch) {
        const accountName = accountMatch[1].trim();
        existingAccounts.add(accountName);
        accountLines.push(line);
      }
      continue;
    }

    // Empty line
    if (trimmed === '') {
      if (inAccountSection && !accountSectionEnded) {
        // Keep empty lines in account section
        accountLines.push(line);
      } else {
        otherLines.push(line);
      }
      continue;
    }

    // Any other content (transactions, includes, etc.)
    if (inAccountSection) {
      accountSectionEnded = true;
    }
    otherLines.push(line);
  }

  // Find missing accounts
  const missingAccounts = new Set<string>();
  for (const account of accounts) {
    if (!existingAccounts.has(account)) {
      missingAccounts.add(account);
    }
  }

  // If nothing to add, return early
  if (missingAccounts.size === 0) {
    return { added: [], updated: false };
  }

  // Combine existing and new accounts, then sort
  const allAccounts = new Set([...existingAccounts, ...missingAccounts]);
  const sortedAccounts = sortAccountDeclarations(allAccounts);

  // Generate sorted account declaration lines
  const newAccountLines = sortedAccounts.map((account) => `account ${account}`);

  // Rebuild the file
  const newContent: string[] = [];

  // Add comments at the top
  newContent.push(...commentLines);

  // Add sorted account declarations
  if (newAccountLines.length > 0) {
    newContent.push('');
    newContent.push(...newAccountLines);
    newContent.push('');
  }

  // Add remaining content
  newContent.push(...otherLines);

  // Write back to file
  fs.writeFileSync(yearJournalPath, newContent.join('\n'));

  return {
    added: Array.from(missingAccounts).sort(),
    updated: true,
  };
}
