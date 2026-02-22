import * as fs from 'fs';
import * as path from 'path';

/**
 * Mapping of absolute CSV file paths to their corresponding rules file paths
 */
export interface RulesMapping {
  [csvPath: string]: string;
}

/**
 * Parses the 'source' directive from a rules file content.
 * The source directive specifies the CSV file path (can be relative or absolute).
 *
 * @param content The content of the rules file
 * @returns The source path as specified in the file, or null if not found
 */
export function parseSourceDirective(content: string): string | null {
  // Match 'source' at the start of a line, followed by whitespace and the path
  // The path continues until end of line or a comment (#)
  const match = content.match(/^source\s+([^\n#]+)/m);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

/**
 * Resolves a source path from a rules file to an absolute path.
 * The source path is relative to the rules file's directory.
 *
 * @param sourcePath The source path from the rules file
 * @param rulesFilePath The absolute path to the rules file
 * @returns The absolute path to the CSV file
 */
export function resolveSourcePath(sourcePath: string, rulesFilePath: string): string {
  if (path.isAbsolute(sourcePath)) {
    return sourcePath;
  }
  const rulesDir = path.dirname(rulesFilePath);
  return path.resolve(rulesDir, sourcePath);
}

/**
 * Scans a directory for all .rules files and builds a mapping
 * of CSV file paths to their corresponding rules files.
 *
 * @param rulesDir The absolute path to the directory containing .rules files
 * @returns A mapping of absolute CSV paths to absolute rules file paths
 */
export function loadRulesMapping(rulesDir: string): RulesMapping {
  const mapping: RulesMapping = {};

  if (!fs.existsSync(rulesDir)) {
    return mapping;
  }

  const files = fs.readdirSync(rulesDir);

  for (const file of files) {
    if (!file.endsWith('.rules')) {
      continue;
    }

    const rulesFilePath = path.join(rulesDir, file);
    const stat = fs.statSync(rulesFilePath);

    if (!stat.isFile()) {
      continue;
    }

    const content = fs.readFileSync(rulesFilePath, 'utf-8');
    const sourcePath = parseSourceDirective(content);

    if (!sourcePath) {
      continue;
    }

    const absoluteCsvPath = resolveSourcePath(sourcePath, rulesFilePath);
    mapping[absoluteCsvPath] = rulesFilePath;
  }

  return mapping;
}

/**
 * Finds the rules file for a given CSV file path.
 *
 * @param csvPath The absolute path to the CSV file
 * @param mapping The rules mapping from loadRulesMapping
 * @returns The absolute path to the rules file, or null if not found
 */
export function findRulesForCsv(csvPath: string, mapping: RulesMapping): string | null {
  // Direct lookup
  if (mapping[csvPath]) {
    return mapping[csvPath];
  }

  // Normalize paths and try again (handle different path separators, etc.)
  const normalizedCsvPath = path.normalize(csvPath);
  for (const [mappedCsv, rulesFile] of Object.entries(mapping)) {
    if (path.normalize(mappedCsv) === normalizedCsvPath) {
      return rulesFile;
    }
  }

  return null;
}
