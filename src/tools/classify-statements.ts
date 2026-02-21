import { tool } from '@opencode-ai/plugin';
import * as path from 'path';
import * as fs from 'fs';
import { loadImportConfig, type ImportConfig } from '../utils/importConfig.ts';
import { detectProvider, type DetectionResult } from '../utils/providerDetector.ts';

interface ClassifiedFile {
  filename: string;
  originalFilename?: string;
  provider: string;
  currency: string;
  targetPath: string;
}

interface UnrecognizedFile {
  filename: string;
  targetPath: string;
}

interface FileCollision {
  filename: string;
  existingPath: string;
}

interface ClassifyResult {
  success: boolean;
  classified: ClassifiedFile[];
  unrecognized: UnrecognizedFile[];
  collisions?: FileCollision[];
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

  const importsDir = path.join(directory, config.paths.import);
  const pendingDir = path.join(directory, config.paths.pending);
  const unrecognizedDir = path.join(directory, config.paths.unrecognized);

  // Find CSV files to process
  const csvFiles = findCSVFiles(importsDir);
  if (csvFiles.length === 0) {
    return JSON.stringify({
      success: true,
      classified: [],
      unrecognized: [],
      message: `No CSV files found in ${config.paths.import}`,
    });
  }

  // First pass: detect all files and check for collisions
  interface PlannedMove {
    filename: string;
    sourcePath: string;
    targetPath: string;
    targetFilename: string;
    detection: DetectionResult | null;
  }

  const plannedMoves: PlannedMove[] = [];
  const collisions: FileCollision[] = [];

  for (const filename of csvFiles) {
    const sourcePath = path.join(importsDir, filename);
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const detection: DetectionResult | null = detectProvider(filename, content, config);

    let targetPath: string;
    let targetFilename: string;

    if (detection) {
      targetFilename = detection.outputFilename || filename;
      const targetDir = path.join(pendingDir, detection.provider, detection.currency);
      targetPath = path.join(targetDir, targetFilename);
    } else {
      targetFilename = filename;
      targetPath = path.join(unrecognizedDir, filename);
    }

    // Check for collision
    if (fs.existsSync(targetPath)) {
      collisions.push({
        filename,
        existingPath: targetPath,
      });
    }

    plannedMoves.push({
      filename,
      sourcePath,
      targetPath,
      targetFilename,
      detection,
    });
  }

  // Abort if any collisions detected
  if (collisions.length > 0) {
    return JSON.stringify({
      success: false,
      error: `Cannot classify: ${collisions.length} file(s) would overwrite existing pending files.`,
      collisions,
      classified: [],
      unrecognized: [],
    } satisfies ClassifyResult);
  }

  // Second pass: execute all moves (no collisions)
  const classified: ClassifiedFile[] = [];
  const unrecognized: UnrecognizedFile[] = [];

  for (const move of plannedMoves) {
    if (move.detection) {
      // Move to provider/currency directory
      const targetDir = path.dirname(move.targetPath);
      ensureDirectory(targetDir);
      fs.renameSync(move.sourcePath, move.targetPath);

      classified.push({
        filename: move.targetFilename,
        originalFilename: move.detection.outputFilename ? move.filename : undefined,
        provider: move.detection.provider,
        currency: move.detection.currency,
        targetPath: path.join(
          config.paths.pending,
          move.detection.provider,
          move.detection.currency,
          move.targetFilename
        ),
      });
    } else {
      // Move to unrecognized directory
      ensureDirectory(unrecognizedDir);
      fs.renameSync(move.sourcePath, move.targetPath);

      unrecognized.push({
        filename: move.filename,
        targetPath: path.join(config.paths.unrecognized, move.filename),
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
