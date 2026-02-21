import Papa from 'papaparse';
import { ImportConfig, DetectionRule } from './importConfig.ts';

export interface DetectionResult {
  provider: string;
  currency: string;
  rule: DetectionRule;
}

export interface ClassificationResult {
  filename: string;
  detected: DetectionResult | null;
  error?: string;
}

/**
 * Parses CSV content and returns the header fields and first data row
 */
function parseCSVPreview(content: string): {
  fields: string[] | undefined;
  firstRow: Record<string, string> | undefined;
} {
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    preview: 1,
    skipEmptyLines: true,
  });

  return {
    fields: result.meta.fields,
    firstRow: result.data[0],
  };
}

/**
 * Normalizes header fields to a comparable string
 * Joins fields with comma, trims whitespace
 */
function normalizeHeader(fields: string[]): string {
  return fields.map((f) => f.trim()).join(',');
}

/**
 * Detects the provider and currency for a given CSV file
 * @param filename The name of the file (not full path)
 * @param content The CSV file content
 * @param config The import configuration
 * @returns Detection result or null if no provider matched
 */
export function detectProvider(
  filename: string,
  content: string,
  config: ImportConfig
): DetectionResult | null {
  const { fields, firstRow } = parseCSVPreview(content);

  if (!fields || fields.length === 0) {
    return null;
  }

  const actualHeader = normalizeHeader(fields);

  // Try each provider
  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    // Try each detection rule for this provider
    for (const rule of providerConfig.detect) {
      // Check filename pattern
      const filenameRegex = new RegExp(rule.filenamePattern);
      if (!filenameRegex.test(filename)) {
        continue;
      }

      // Check header match
      if (actualHeader !== rule.header) {
        continue;
      }

      // Extract currency from the specified field
      if (!firstRow) {
        continue;
      }

      const rawCurrency = firstRow[rule.currencyField];
      if (!rawCurrency) {
        continue;
      }

      // Map currency using provider's currency mapping
      const normalizedCurrency = providerConfig.currencies[rawCurrency];
      if (!normalizedCurrency) {
        // Currency found but not in mapping - still a match but with raw currency lowercased
        return {
          provider: providerName,
          currency: rawCurrency.toLowerCase(),
          rule,
        };
      }

      return {
        provider: providerName,
        currency: normalizedCurrency,
        rule,
      };
    }
  }

  return null;
}

/**
 * Classifies multiple CSV files
 * @param files Array of { filename, content } objects
 * @param config The import configuration
 * @returns Array of classification results
 */
export function classifyFiles(
  files: Array<{ filename: string; content: string }>,
  config: ImportConfig
): ClassificationResult[] {
  return files.map(({ filename, content }) => {
    try {
      const detected = detectProvider(filename, content, config);
      return { filename, detected };
    } catch (err) {
      return {
        filename,
        detected: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
