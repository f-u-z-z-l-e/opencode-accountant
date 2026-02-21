import { tool } from '@opencode-ai/plugin';
import * as path from 'path';
import * as fs from 'fs';
import { loadImportConfig, type ImportConfig } from '../utils/importConfig.ts';
import { detectProvider, type DetectionResult } from '../utils/providerDetector.ts';

interface ClassifiedFile {
  filename: string;
  provider: string;
  currency: string;
  targetPath: string;
}

interface UnrecognizedFile {
  filename: string;
  targetPath: string;
}

interface PendingFile {
  provider: string;
  currency: string;
  filename: string;
  path: string;
}

interface ClassifyResult {
  success: boolean;
  classified: ClassifiedFile[];
  unrecognized: UnrecognizedFile[];
  pendingFiles?: PendingFile[];
  error?: string;
}

/**
 * Finds all CSV files in the imports directory
 */
function findCSVFiles(importsDir: string): string[] {
  if (!fs.existsSync(importsDir)) {
    return [];
  }

  return fs
    .readdirSync(importsDir)
    .filter((file) => file.toLowerCase().endsWith('.csv'))
    .filter((file) => {
      const fullPath = path.join(importsDir, file);
      return fs.statSync(fullPath).isFile();
    });
}

/**
 * Checks for any existing files in the pending directories
 * Returns list of pending files if any exist
 */
function checkPendingFiles(directory: string, pendingBasePath: string): PendingFile[] {
  const pendingDir = path.join(directory, pendingBasePath);
  const pendingFiles: PendingFile[] = [];

  if (!fs.existsSync(pendingDir)) {
    return [];
  }

  // Walk through provider directories
  const providers = fs.readdirSync(pendingDir);
  for (const provider of providers) {
    const providerPath = path.join(pendingDir, provider);
    if (!fs.statSync(providerPath).isDirectory()) continue;

    // Walk through currency directories
    const currencies = fs.readdirSync(providerPath);
    for (const currency of currencies) {
      const currencyPath = path.join(providerPath, currency);
      if (!fs.statSync(currencyPath).isDirectory()) continue;

      // Find CSV files
      const files = fs.readdirSync(currencyPath).filter((f) => f.toLowerCase().endsWith('.csv'));
      for (const file of files) {
        pendingFiles.push({
          provider,
          currency,
          filename: file,
          path: path.join(currencyPath, file),
        });
      }
    }
  }

  return pendingFiles;
}

/**
 * Ensures a directory exists, creating it recursively if needed
 */
function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Core logic for classifying statements, extracted for testing
 */
export async function classifyStatementsCore(
  directory: string,
  agent: string,
  // eslint-disable-next-line no-unused-vars
  configLoader: (dir: string) => ImportConfig = loadImportConfig
): Promise<string> {
  // Agent restriction
  if (agent !== 'accountant') {
    return JSON.stringify({
      success: false,
      error: 'This tool is restricted to the accountant agent only.',
      hint: "Use: Task(subagent_type='accountant', prompt='classify statements')",
      caller: agent || 'main assistant',
      classified: [],
      unrecognized: [],
    } satisfies ClassifyResult & { hint: string; caller: string });
  }

  // Load configuration
  let config: ImportConfig;
  try {
    config = configLoader(directory);
  } catch (err) {
    return JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
      classified: [],
      unrecognized: [],
    } satisfies ClassifyResult);
  }

  const importsDir = path.join(directory, config.paths.imports);
  const pendingDir = path.join(directory, config.paths.pending);
  const unrecognizedDir = path.join(directory, config.paths.unrecognized);

  // Check for pending files - abort if any exist
  const pendingFiles = checkPendingFiles(directory, config.paths.pending);
  if (pendingFiles.length > 0) {
    return JSON.stringify({
      success: false,
      error: `Found ${pendingFiles.length} pending file(s) that must be processed before classifying new statements.`,
      pendingFiles,
      classified: [],
      unrecognized: [],
    } satisfies ClassifyResult);
  }

  // Find CSV files to process
  const csvFiles = findCSVFiles(importsDir);
  if (csvFiles.length === 0) {
    return JSON.stringify({
      success: true,
      classified: [],
      unrecognized: [],
      message: `No CSV files found in ${config.paths.imports}`,
    });
  }

  const classified: ClassifiedFile[] = [];
  const unrecognized: UnrecognizedFile[] = [];

  // Process each file
  for (const filename of csvFiles) {
    const sourcePath = path.join(importsDir, filename);
    const content = fs.readFileSync(sourcePath, 'utf-8');

    const detection: DetectionResult | null = detectProvider(filename, content, config);

    if (detection) {
      // Move to provider/currency directory
      const targetDir = path.join(pendingDir, detection.provider, detection.currency);
      ensureDirectory(targetDir);
      const targetPath = path.join(targetDir, filename);

      fs.renameSync(sourcePath, targetPath);

      classified.push({
        filename,
        provider: detection.provider,
        currency: detection.currency,
        targetPath: path.join(
          config.paths.pending,
          detection.provider,
          detection.currency,
          filename
        ),
      });
    } else {
      // Move to unrecognized directory
      ensureDirectory(unrecognizedDir);
      const targetPath = path.join(unrecognizedDir, filename);

      fs.renameSync(sourcePath, targetPath);

      unrecognized.push({
        filename,
        targetPath: path.join(config.paths.unrecognized, filename),
      });
    }
  }

  return JSON.stringify({
    success: true,
    classified,
    unrecognized,
    summary: {
      total: csvFiles.length,
      classified: classified.length,
      unrecognized: unrecognized.length,
    },
  });
}

export default tool({
  description:
    'ACCOUNTANT AGENT ONLY: Classifies bank statement CSV files from the imports directory by detecting their provider and currency, then moves them to the appropriate pending import directories.',
  args: {},
  async execute(_params, context) {
    const { directory, agent } = context;
    return classifyStatementsCore(directory, agent);
  },
});
