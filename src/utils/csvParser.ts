/**
 * CSV parsing utilities using convert-csv-to-json library.
 * Parses CSV files using rules file configuration and matches rows to postings.
 */

import * as fs from 'fs';
import csvToJson from 'convert-csv-to-json';
import type { RulesConfig, AmountFields } from './rulesParser.ts';
import { parseAmountValue } from './balanceUtils.ts';

/**
 * Represents a single CSV row with field names as keys.
 */
export interface CsvRowData {
  [field: string]: string;
}

/**
 * Posting data to match against CSV rows.
 */
export interface PostingToMatch {
  date: string;
  description: string;
  amount: string; // e.g., "CHF95.25" or "CHF-10.00"
}

/**
 * Parse a CSV file using the configuration from a rules file.
 *
 * @param csvPath Path to the CSV file
 * @param config Configuration parsed from the rules file
 * @returns Array of row objects with field names from the rules file
 */
export function parseCsvFile(csvPath: string, config: RulesConfig): CsvRowData[] {
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = csvContent.split('\n');

  const headerIndex = config.skipRows;
  if (headerIndex >= lines.length) {
    return [];
  }

  const headerLine = lines[headerIndex];
  const dataLines = lines.slice(headerIndex + 1).filter((line) => line.trim() !== '');

  const csvWithHeader = [headerLine, ...dataLines].join('\n');

  const rawRows = csvToJson
    .indexHeader(0)
    .fieldDelimiter(config.separator)
    .supportQuotedField(true)
    .csvStringToJson(csvWithHeader) as Record<string, string>[];

  const fieldNames =
    config.fieldNames.length > 0 ? config.fieldNames : Object.keys(rawRows[0] || {});

  const mappedRows: CsvRowData[] = [];
  for (const parsedRow of rawRows) {
    const row: CsvRowData = {};
    const values = Object.values(parsedRow);

    for (let i = 0; i < fieldNames.length && i < values.length; i++) {
      row[fieldNames[i]] = values[i];
    }

    mappedRows.push(row);
  }

  return mappedRows;
}

/**
 * Get the amount value from a CSV row using the amount field configuration.
 */
function getRowAmount(row: CsvRowData, amountFields: AmountFields): number {
  if (amountFields.single) {
    return parseAmountValue(row[amountFields.single] || '0');
  }

  const debitValue = amountFields.debit ? parseAmountValue(row[amountFields.debit] || '0') : 0;
  const creditValue = amountFields.credit ? parseAmountValue(row[amountFields.credit] || '0') : 0;

  if (debitValue !== 0) {
    return -Math.abs(debitValue);
  }
  if (creditValue !== 0) {
    return Math.abs(creditValue);
  }

  return 0;
}

/**
 * Parse date string according to format.
 * Converts to ISO format (YYYY-MM-DD) for comparison.
 */
function parseDateToIso(dateStr: string, dateFormat: string): string {
  if (!dateStr) return '';

  if (dateFormat === '%Y-%m-%d' || dateFormat === '%F') {
    return dateStr.trim();
  }

  if (dateFormat === '%d.%m.%Y') {
    const parts = dateStr.split('.');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }

  if (dateFormat === '%m/%d/%Y') {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    }
  }

  if (dateFormat === '%d/%m/%Y') {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }

  return dateStr.trim();
}

/**
 * Check if a field looks like a transaction ID/reference number.
 * Pattern detection for numeric/alphanumeric ID-like fields.
 */
function looksLikeTransactionId(fieldName: string, value: string): boolean {
  if (!value || value.trim() === '') return false;

  const idFieldPatterns = [
    /transaction/i,
    /trans_?no/i,
    /trans_?id/i,
    /reference/i,
    /ref_?no/i,
    /ref_?id/i,
    /booking_?id/i,
    /payment_?id/i,
    /order_?id/i,
  ];

  const nameMatches = idFieldPatterns.some((pattern) => pattern.test(fieldName));
  if (!nameMatches) return false;

  const trimmedValue = value.trim();
  const looksLikeId = /^[A-Za-z0-9_-]+$/.test(trimmedValue) && trimmedValue.length >= 3;

  return looksLikeId;
}

/**
 * Find the transaction ID field and value from a CSV row.
 */
function findTransactionId(row: CsvRowData): { field: string; value: string } | null {
  for (const [field, value] of Object.entries(row)) {
    if (looksLikeTransactionId(field, value)) {
      return { field, value: value.trim() };
    }
  }
  return null;
}

/**
 * Find the CSV row that matches a posting.
 * Strategy:
 * 1. Match by date + amount
 * 2. If transaction ID available, use it to narrow down
 * 3. If multiple matches, use description fields
 *
 * @throws Error if no match found (should never happen)
 */
export function findMatchingCsvRow(
  posting: PostingToMatch,
  csvRows: CsvRowData[],
  config: RulesConfig
): CsvRowData {
  const postingAmount = parseAmountValue(posting.amount);

  let candidates = csvRows.filter((row) => {
    const rowDate = parseDateToIso(row[config.dateField] || '', config.dateFormat);
    const rowAmount = getRowAmount(row, config.amountFields);

    if (rowDate !== posting.date) return false;

    if (Math.abs(rowAmount - postingAmount) > 0.001) return false;

    return true;
  });

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error(
      `Bug: Could not find CSV row for posting: ${posting.date} ${posting.description} ${posting.amount}. ` +
        `This indicates a mismatch between hledger output and CSV parsing.`
    );
  }

  for (const candidate of candidates) {
    const txId = findTransactionId(candidate);
    if (txId) {
      const withSameTxId = candidates.filter((row) => row[txId.field] === txId.value);
      if (withSameTxId.length === 1) {
        return withSameTxId[0];
      }
    }
  }

  const descriptionLower = posting.description.toLowerCase();
  const descMatches = candidates.filter((row) => {
    return Object.values(row).some(
      (value) => value && value.toLowerCase().includes(descriptionLower)
    );
  });

  if (descMatches.length === 1) {
    return descMatches[0];
  }

  if (descMatches.length > 1) {
    return descMatches[0];
  }

  return candidates[0];
}
