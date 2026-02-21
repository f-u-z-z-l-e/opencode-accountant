import Papa from 'papaparse';
import { ImportConfig, DetectionRule, MetadataExtraction } from './importConfig.ts';

export interface DetectionResult {
  provider: string;
  currency: string;
  rule: DetectionRule;
  outputFilename?: string;
  metadata?: Record<string, string>;
}

export interface ClassificationResult {
  filename: string;
  detected: DetectionResult | null;
  error?: string;
}

/**
 * Extracts metadata from the skipped rows based on configuration
 */
function extractMetadata(
  content: string,
  skipRows: number,
  delimiter: string,
  metadataConfig: MetadataExtraction[] | undefined
): Record<string, string> {
  if (!metadataConfig || metadataConfig.length === 0 || skipRows === 0) {
    return {};
  }

  const lines = content.split('\n').slice(0, skipRows);
  const metadata: Record<string, string> = {};

  for (const config of metadataConfig) {
    if (config.row >= lines.length) continue;

    const columns = lines[config.row].split(delimiter);
    if (config.column >= columns.length) continue;

    let value = columns[config.column].trim();

    // Apply normalization
    if (config.normalize === 'spaces-to-dashes') {
      value = value.replace(/\s+/g, '-');
    }

    metadata[config.field] = value;
  }

  return metadata;
}

/**
 * Generates output filename by replacing placeholders in renamePattern
 */
function generateOutputFilename(
  renamePattern: string | undefined,
  metadata: Record<string, string>
): string | undefined {
  if (!renamePattern) {
    return undefined;
  }

  let filename = renamePattern;
  for (const [key, value] of Object.entries(metadata)) {
    filename = filename.replace(`{${key}}`, value);
  }

  return filename;
}

/**
 * Parses CSV content and returns the header fields and first data row
 * @param content The full file content
 * @param skipRows Number of rows to skip before header (default: 0)
 * @param delimiter CSV delimiter character (default: ',')
 */
function parseCSVPreview(
  content: string,
  skipRows: number = 0,
  delimiter: string = ','
): {
  fields: string[] | undefined;
  firstRow: Record<string, string> | undefined;
} {
  // Skip the first N rows if needed
  let csvContent = content;
  if (skipRows > 0) {
    const lines = content.split('\n');
    csvContent = lines.slice(skipRows).join('\n');
  }

  const result = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    preview: 1,
    skipEmptyLines: true,
    delimiter: delimiter,
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
  // Try each provider
  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    // Try each detection rule for this provider
    for (const rule of providerConfig.detect) {
      // Check filename pattern (if specified)
      if (rule.filenamePattern !== undefined) {
        const filenameRegex = new RegExp(rule.filenamePattern);
        if (!filenameRegex.test(filename)) {
          continue;
        }
      }

      // Parse CSV with rule-specific skipRows and delimiter
      const skipRows = rule.skipRows ?? 0;
      const delimiter = rule.delimiter ?? ',';
      const { fields, firstRow } = parseCSVPreview(content, skipRows, delimiter);

      if (!fields || fields.length === 0) {
        continue;
      }

      // Check header match
      const actualHeader = normalizeHeader(fields);
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

      // Extract metadata from skipped rows
      const metadata = extractMetadata(content, skipRows, delimiter, rule.metadata);

      // Generate output filename if renamePattern is specified
      const outputFilename = generateOutputFilename(rule.renamePattern, metadata);

      // Map currency using provider's currency mapping
      const normalizedCurrency = providerConfig.currencies[rawCurrency];
      if (!normalizedCurrency) {
        // Currency found but not in mapping - still a match but with raw currency lowercased
        return {
          provider: providerName,
          currency: rawCurrency.toLowerCase(),
          rule,
          outputFilename,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        };
      }

      return {
        provider: providerName,
        currency: normalizedCurrency,
        rule,
        outputFilename,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
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
