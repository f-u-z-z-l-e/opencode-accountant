import { tool } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { loadImportConfig, type ImportConfig } from '../utils/importConfig.ts';
import { detectProvider, type DetectionResult } from '../utils/providerDetector.ts';
import { isInWorktree } from '../utils/worktreeManager.ts';
import { findCSVFiles, ensureDirectory } from '../utils/fileUtils.ts';

/**
 * Result for a single classified CSV file
 */
interface ClassifiedFile {
  filename: string;
  originalFilename?: string;
  provider: string;
  currency: string;
  targetPath: string;
}

/**
 * Result for a file that couldn't be classified
 */
interface UnrecognizedFile {
  filename: string;
  targetPath: string;
}

/**
 * Collision detected when target file already exists
 */
interface FileCollision {
  filename: string;
  existingPath: string;
}

/**
 * Planned move for a single file
 */
interface PlannedMove {
  filename: string;
  sourcePath: string;
  targetPath: string;
  targetFilename: string;
  detection: DetectionResult | null;
}

/**
 * Overall result of the classify-statements tool
 */
interface ClassifyResult {
  success: boolean;
  classified: ClassifiedFile[];
  unrecognized: UnrecognizedFile[];
  collisions?: FileCollision[];
  error?: string;
  hint?: string;
  message?: string;
  summary?: {
    total: number;
    classified: number;
    unrecognized: number;
  };
}

function buildSuccessResult(
  classified: ClassifiedFile[],
  unrecognized: UnrecognizedFile[],
  message?: string
): string {
  return JSON.stringify({
    success: true,
    classified,
    unrecognized,
    message,
    summary: {
      total: classified.length + unrecognized.length,
      classified: classified.length,
      unrecognized: unrecognized.length,
    },
  });
}

function buildErrorResult(error: string, hint?: string): string {
  return JSON.stringify({
    success: false,
    error,
    hint,
    classified: [],
    unrecognized: [],
  } satisfies ClassifyResult);
}

/**
 * First pass: detect all files and check for collisions (no file operations)
 */
function planMoves(
  csvFiles: string[],
  importsDir: string,
  pendingDir: string,
  unrecognizedDir: string,
  config: ImportConfig
): { plannedMoves: PlannedMove[]; collisions: FileCollision[] } {
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

  return { plannedMoves, collisions };
}

/**
 * Second pass: execute all moves (file operations)
 */
function executeMoves(
  plannedMoves: PlannedMove[],
  config: ImportConfig,
  unrecognizedDir: string
): { classified: ClassifiedFile[]; unrecognized: UnrecognizedFile[] } {
  const classified: ClassifiedFile[] = [];
  const unrecognized: UnrecognizedFile[] = [];

  for (const move of plannedMoves) {
    if (move.detection) {
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
      ensureDirectory(unrecognizedDir);
      fs.renameSync(move.sourcePath, move.targetPath);

      unrecognized.push({
        filename: move.filename,
        targetPath: path.join(config.paths.unrecognized, move.filename),
      });
    }
  }

  return { classified, unrecognized };
}

/**
 * Core logic for classifying statements, extracted for testing
 */
export async function classifyStatementsCore(
  directory: string,
  agent: string,
  // eslint-disable-next-line no-unused-vars
  configLoader: (dir: string) => ImportConfig = loadImportConfig,
  // eslint-disable-next-line no-unused-vars
  worktreeChecker: (dir: string) => boolean = isInWorktree
): Promise<string> {
  // Agent restriction
  const restrictionError = checkAccountantAgent(agent, 'classify statements', {
    classified: [],
    unrecognized: [],
  });
  if (restrictionError) {
    return restrictionError;
  }

  // Enforce worktree requirement
  if (!worktreeChecker(directory)) {
    return buildErrorResult(
      'classify-statements must be run inside an import worktree',
      'Use import-pipeline tool to orchestrate the full workflow'
    );
  }

  // Load configuration
  let config: ImportConfig;
  try {
    config = configLoader(directory);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return buildErrorResult(errorMessage);
  }

  const importsDir = path.join(directory, config.paths.import);
  const pendingDir = path.join(directory, config.paths.pending);
  const unrecognizedDir = path.join(directory, config.paths.unrecognized);

  // Find CSV files to process
  const csvFiles = findCSVFiles(importsDir);
  if (csvFiles.length === 0) {
    return buildSuccessResult([], [], `No CSV files found in ${config.paths.import}`);
  }

  // First pass: detect all files and check for collisions
  const { plannedMoves, collisions } = planMoves(
    csvFiles,
    importsDir,
    pendingDir,
    unrecognizedDir,
    config
  );

  // Abort if any collisions detected
  if (collisions.length > 0) {
    const errorMessage = `Cannot classify: ${collisions.length} file(s) would overwrite existing pending files.`;
    return JSON.stringify({
      success: false,
      error: errorMessage,
      collisions,
      classified: [],
      unrecognized: [],
    } satisfies ClassifyResult);
  }

  // Second pass: execute all moves
  const { classified, unrecognized } = executeMoves(plannedMoves, config, unrecognizedDir);

  return buildSuccessResult(classified, unrecognized);
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
