/**
 * Date utility functions for working with ISO date strings (YYYY-MM-DD format)
 */

/**
 * Formats a Date object to YYYY-MM-DD format
 *
 * @param date - The date to format
 * @returns Date string in YYYY-MM-DD format
 *
 * @example
 * ```typescript
 * formatDateISO(new Date('2024-03-15T10:30:00Z')) // '2024-03-15'
 * ```
 */
export function formatDateISO(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Returns yesterday's date in YYYY-MM-DD format
 *
 * @returns Yesterday's date string
 *
 * @example
 * ```typescript
 * // If today is 2024-03-15
 * getYesterday() // '2024-03-14'
 * ```
 */
export function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDateISO(d);
}

/**
 * Gets the next day after a given date in YYYY-MM-DD format
 *
 * @param dateStr - Date string in YYYY-MM-DD format
 * @returns Next day's date string
 *
 * @example
 * ```typescript
 * getNextDay('2024-03-15') // '2024-03-16'
 * getNextDay('2024-03-31') // '2024-04-01'
 * getNextDay('2024-12-31') // '2025-01-01'
 * ```
 */
export function getNextDay(dateStr: string): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + 1);
  return formatDateISO(date);
}
