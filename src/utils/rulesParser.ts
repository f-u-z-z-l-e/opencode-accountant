/**
 * Utilities for parsing hledger rules files.
 * Extracts directives like skip, separator, fields, date-format, and amount patterns.
 */

export interface RulesConfig {
  skipRows: number;
  separator: string;
  fieldNames: string[];
  dateFormat: string;
  dateField: string;
  amountFields: AmountFields;
}

export interface AmountFields {
  // Single amount field or separate debit/credit fields
  single?: string;
  debit?: string;
  credit?: string;
}

/**
 * Parse the 'skip' directive from rules file.
 * Example: "skip 9" returns 9
 */
export function parseSkipRows(rulesContent: string): number {
  const match = rulesContent.match(/^skip\s+(\d+)/m);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Parse the 'separator' directive from rules file.
 * Example: "separator ;" returns ";"
 * Default: ","
 */
export function parseSeparator(rulesContent: string): string {
  const match = rulesContent.match(/^separator\s+(.)/m);
  return match ? match[1] : ',';
}

/**
 * Parse the 'fields' directive from rules file.
 * Example: "fields date, description, amount, balance"
 * Returns: ["date", "description", "amount", "balance"]
 */
export function parseFieldNames(rulesContent: string): string[] {
  const match = rulesContent.match(/^fields\s+(.+)$/m);
  if (!match) {
    return [];
  }
  return match[1].split(',').map((field) => field.trim());
}

/**
 * Parse the 'date-format' directive from rules file.
 * Example: "date-format %Y-%m-%d" returns "%Y-%m-%d"
 * Default: "%Y-%m-%d"
 */
export function parseDateFormat(rulesContent: string): string {
  const match = rulesContent.match(/^date-format\s+(.+)$/m);
  return match ? match[1].trim() : '%Y-%m-%d';
}

/**
 * Parse the 'date' field mapping from rules file.
 * Example: "date %trade_date" returns "trade_date"
 * Example: "date %1" returns field at index 0 from fields list
 */
export function parseDateField(rulesContent: string, fieldNames: string[]): string {
  const match = rulesContent.match(/^date\s+%(\w+|\d+)/m);
  if (!match) {
    // Default to first field or 'date'
    return fieldNames[0] || 'date';
  }

  const value = match[1];
  // Check if it's a numeric index (1-indexed in hledger)
  if (/^\d+$/.test(value)) {
    const index = parseInt(value, 10) - 1;
    return fieldNames[index] || value;
  }

  return value;
}

/**
 * Parse amount field configuration from rules file.
 * Handles both single amount field and separate debit/credit fields.
 *
 * Examples:
 *   "amount %amount" -> { single: "amount" }
 *   "if %debit .\n    amount -%debit" -> { debit: "debit" }
 *   "if %credit .\n    amount %credit" -> { credit: "credit" }
 */
export function parseAmountFields(rulesContent: string, fieldNames: string[]): AmountFields {
  const result: AmountFields = {};

  // Check for simple amount field
  const simpleMatch = rulesContent.match(/^amount\s+(-?)%(\w+|\d+)/m);
  if (simpleMatch) {
    const fieldRef = simpleMatch[2];
    if (/^\d+$/.test(fieldRef)) {
      const index = parseInt(fieldRef, 10) - 1;
      result.single = fieldNames[index] || fieldRef;
    } else {
      result.single = fieldRef;
    }
  }

  // Check for conditional debit field
  const debitMatch = rulesContent.match(/if\s+%(\w+)\s+\.\s*\n\s*amount\s+-?%\1/m);
  if (debitMatch) {
    result.debit = debitMatch[1];
  }

  // Check for conditional credit field
  const creditMatch = rulesContent.match(/if\s+%(\w+)\s+\.\s*\n\s*amount\s+%\1(?!\w)/m);
  if (creditMatch && creditMatch[1] !== result.debit) {
    result.credit = creditMatch[1];
  }

  // If we found debit/credit pattern, clear single
  if (result.debit || result.credit) {
    delete result.single;
  }

  // Default to 'amount' if nothing found
  if (!result.single && !result.debit && !result.credit) {
    result.single = 'amount';
  }

  return result;
}

/**
 * Parse the 'account1' directive from rules file.
 * This is the primary account (bank/asset account) for the CSV import.
 * Example: "account1 assets:bank:ubs:checking" returns "assets:bank:ubs:checking"
 */
export function parseAccount1(rulesContent: string): string | null {
  const match = rulesContent.match(/^account1\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Parse all relevant directives from a rules file.
 */
export function parseRulesFile(rulesContent: string): RulesConfig {
  const fieldNames = parseFieldNames(rulesContent);

  return {
    skipRows: parseSkipRows(rulesContent),
    separator: parseSeparator(rulesContent),
    fieldNames,
    dateFormat: parseDateFormat(rulesContent),
    dateField: parseDateField(rulesContent, fieldNames),
    amountFields: parseAmountFields(rulesContent, fieldNames),
  };
}
