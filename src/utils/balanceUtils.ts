/**
 * Balance parsing and calculation utilities.
 * Handles various balance format strings and provides comparison functions.
 */

/**
 * Represents a parsed balance with currency and amount.
 */
export interface ParsedBalance {
  currency: string;
  amount: number;
}

/**
 * Parse amount string to extract numeric value.
 * Handles formats like "CHF95.25", "CHF-10.00", "-95.25", "95.25"
 *
 * @param amountStr - Amount string to parse
 * @returns Numeric value
 *
 * @example
 * parseAmountValue("CHF95.25") // returns 95.25
 * parseAmountValue("CHF-10.00") // returns -10.00
 * parseAmountValue("-95.25") // returns -95.25
 * parseAmountValue("1,234.56") // returns 1234.56
 */
export function parseAmountValue(amountStr: string): number {
  const cleaned = amountStr
    .replace(/[A-Z]{3}\s*/g, '')
    .replace(/,/g, '')
    .trim();
  return parseFloat(cleaned) || 0;
}

/**
 * Parse a balance string to extract currency and amount.
 * Supports multiple formats with currency prefix, suffix, or no currency.
 *
 * @param balance - Balance string to parse
 * @returns Parsed balance object with currency and amount, or null if invalid
 *
 * @example
 * parseBalance("CHF 2324.79") // { currency: "CHF", amount: 2324.79 }
 * parseBalance("2324.79 CHF") // { currency: "CHF", amount: 2324.79 }
 * parseBalance("CHF2324.79") // { currency: "CHF", amount: 2324.79 }
 * parseBalance("2324.79") // { currency: "", amount: 2324.79 }
 * parseBalance("-123.45") // { currency: "", amount: -123.45 }
 * parseBalance("1,234.56") // { currency: "", amount: 1234.56 }
 * parseBalance("invalid") // null
 */
export function parseBalance(balance: string): ParsedBalance | null {
  // Handle formats like "CHF 2324.79" or "2324.79 CHF" or "CHF2324.79"
  const match = balance.match(/([A-Z]{3})\s*([-\d.,]+)|([+-]?[\d.,]+)\s*([A-Z]{3})/);
  if (!match) {
    // Try pure number
    const numMatch = balance.match(/^([+-]?[\d.,]+)$/);
    if (numMatch) {
      return { currency: '', amount: parseFloat(numMatch[1].replace(/,/g, '')) };
    }
    return null;
  }

  const currency = match[1] || match[4];
  const amountStr = match[2] || match[3];
  const amount = parseFloat(amountStr.replace(/,/g, ''));

  return { currency, amount };
}

/**
 * Calculate the difference between two balances.
 *
 * @param expected - Expected balance string
 * @param actual - Actual balance string
 * @returns Formatted difference string with currency, or error message
 * @throws Error if currencies don't match
 *
 * @example
 * calculateDifference("CHF 100.00", "CHF 95.00") // "CHF -5.00"
 * calculateDifference("CHF 100.00", "CHF 105.50") // "CHF +5.50"
 * calculateDifference("CHF 100.00", "EUR 100.00") // throws Error
 */
export function calculateDifference(expected: string, actual: string): string {
  const expectedParsed = parseBalance(expected);
  const actualParsed = parseBalance(actual);

  if (!expectedParsed || !actualParsed) {
    throw new Error(`Cannot parse balances: expected="${expected}", actual="${actual}"`);
  }

  // Check currency mismatch
  if (
    expectedParsed.currency &&
    actualParsed.currency &&
    expectedParsed.currency !== actualParsed.currency
  ) {
    throw new Error(
      `Currency mismatch: expected ${expectedParsed.currency}, got ${actualParsed.currency}`
    );
  }

  const diff = actualParsed.amount - expectedParsed.amount;
  const sign = diff >= 0 ? '+' : '';
  const currency = expectedParsed.currency || actualParsed.currency;

  return currency ? `${currency} ${sign}${diff.toFixed(2)}` : `${sign}${diff.toFixed(2)}`;
}

/**
 * Format a balance with currency.
 *
 * @param amount - Numeric amount
 * @param currency - Currency code (optional)
 * @returns Formatted balance string
 *
 * @example
 * formatBalance(2324.79, "CHF") // "CHF 2324.79"
 * formatBalance(-10.5, "EUR") // "EUR -10.50"
 * formatBalance(100) // "100.00"
 */
export function formatBalance(amount: number, currency?: string): string {
  const formattedAmount = amount.toFixed(2);
  return currency ? `${currency} ${formattedAmount}` : formattedAmount;
}

/**
 * Check if two balances match exactly (no tolerance).
 *
 * @param balance1 - First balance string
 * @param balance2 - Second balance string
 * @returns True if balances match exactly
 * @throws Error if currencies don't match
 *
 * @example
 * balancesMatch("CHF 100.00", "CHF 100.00") // true
 * balancesMatch("CHF 100.00", "CHF 100.01") // false
 * balancesMatch("CHF 100.00", "EUR 100.00") // throws Error
 */
export function balancesMatch(balance1: string, balance2: string): boolean {
  const parsed1 = parseBalance(balance1);
  const parsed2 = parseBalance(balance2);

  if (!parsed1 || !parsed2) {
    return false;
  }

  // Check currency mismatch
  if (parsed1.currency && parsed2.currency && parsed1.currency !== parsed2.currency) {
    throw new Error(`Currency mismatch: ${parsed1.currency} vs ${parsed2.currency}`);
  }

  // Exact match (no tolerance)
  return parsed1.amount === parsed2.amount;
}
