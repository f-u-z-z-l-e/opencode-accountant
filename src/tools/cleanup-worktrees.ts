import fs from 'fs/promises';
import path from 'path';
import { tool } from '@opencode-ai/plugin';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';

const exec = promisify(execCallback);

// Types
interface CleanupWorktreesArgs {
  all?: boolean;
  dryRun?: boolean;
  olderThanHours?: number;
  force?: boolean;
}

interface CleanupWorktreesResult {
  found: WorktreeInfo[];
  removed: WorktreeInfo[];
  failed: Array<{ worktree: WorktreeInfo; error: string }>;
  summary: string;
}

interface WorktreeInfo {
  path: string;
  branch: string;
  uuid: string;
  age: string;
  ageHours: number;
  size: string;
}

// Main function
export async function cleanupWorktrees(
  directory: string,
  options: CleanupWorktreesArgs = {}
): Promise<CleanupWorktreesResult> {
  const logger = createLogger({
    logDir: path.join(directory, '.memory'),
    filename: `cleanup-worktrees-${getTimestamp()}.md`,
    autoFlush: true,
  });

  logger.startSection('Cleanup Import Worktrees', 1);

  try {
    // 1. Find all import worktrees
    logger.info('Searching for import worktrees in /tmp...');
    const worktrees = await findImportWorktrees();
    logger.info(`Found ${worktrees.length} import worktrees`);
    logger.info('');

    if (worktrees.length === 0) {
      logger.info('✅ No worktrees to clean up');
      await logger.flush();
      return { found: [], removed: [], failed: [], summary: 'No worktrees found' };
    }

    // 2. Log found worktrees
    logger.startSection('Found Worktrees');
    for (const wt of worktrees) {
      logger.info(`- ${wt.path}`);
      logger.info(`  Branch: ${wt.branch}, Age: ${wt.age}, Size: ${wt.size}`);
    }
    logger.endSection();

    // 3. Filter by age
    const olderThanHours = options.olderThanHours ?? 24;
    const toRemove = options.all
      ? worktrees
      : worktrees.filter((w) => w.ageHours >= olderThanHours);

    if (toRemove.length === 0) {
      logger.info(`✅ No worktrees older than ${olderThanHours} hours`);
      await logger.flush();
      return {
        found: worktrees,
        removed: [],
        failed: [],
        summary: `No worktrees to remove (${worktrees.length} found, all newer than ${olderThanHours}h)`,
      };
    }

    // 4. Show removal plan
    logger.startSection(`Worktrees to Remove (${toRemove.length})`);
    logger.info(`Filter: ${options.all ? 'all' : `older than ${olderThanHours}h`}`);
    logger.info('');
    for (const wt of toRemove) {
      logger.info(`- ${wt.path} (${wt.age})`);
    }
    logger.endSection();

    // 5. Dry run check
    if (options.dryRun) {
      logger.warn('DRY RUN - No changes made');
      await logger.flush();
      return {
        found: worktrees,
        removed: [],
        failed: [],
        summary: `Dry run: would remove ${toRemove.length}/${worktrees.length} worktrees`,
      };
    }

    // 6. Remove worktrees
    logger.startSection('Removing Worktrees');
    const removed: WorktreeInfo[] = [];
    const failed: Array<{ worktree: WorktreeInfo; error: string }> = [];

    for (const wt of toRemove) {
      try {
        logger.info(`Removing ${wt.path}...`);
        await removeWorktreeByPath(wt.path, options.force);
        removed.push(wt);
        logger.info(`✅ Removed`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failed.push({ worktree: wt, error: errMsg });
        logger.error(`❌ Failed to remove ${wt.path}`, err);
      }
    }
    logger.endSection();

    // 7. Summary
    logger.startSection('Summary');
    logger.info(`Found: ${worktrees.length} worktrees`);
    logger.info(`To remove: ${toRemove.length} worktrees`);
    logger.info(`Removed: ${removed.length} worktrees`);
    logger.info(`Failed: ${failed.length} worktrees`);
    logger.info('');
    logger.info(`Log file: ${logger.getLogPath()}`);
    logger.endSection();

    await logger.flush();

    return {
      found: worktrees,
      removed,
      failed,
      summary: `Removed ${removed.length}/${toRemove.length} worktrees`,
    };
  } catch (err) {
    logger.error('Cleanup failed', err);
    await logger.flush();
    throw err;
  }
}

// Helper: Find all import worktrees
async function findImportWorktrees(): Promise<WorktreeInfo[]> {
  const tmpDir = '/tmp';

  try {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    const worktreeDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('import-worktree-'))
      .map((e) => path.join(tmpDir, e.name));

    const worktrees: WorktreeInfo[] = [];
    for (const wtPath of worktreeDirs) {
      const info = await getWorktreeInfo(wtPath);
      if (info) worktrees.push(info);
    }

    return worktrees;
  } catch {
    return [];
  }
}

// Helper: Get worktree info
async function getWorktreeInfo(wtPath: string): Promise<WorktreeInfo | null> {
  try {
    const uuid = path.basename(wtPath).replace('import-worktree-', '');

    // Get age from directory mtime
    const stats = await fs.stat(wtPath);
    const ageMs = Date.now() - stats.mtimeMs;
    const ageHours = ageMs / (1000 * 60 * 60);

    // Get size
    const sizeBytes = await getDirectorySize(wtPath);
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

    // Get branch name
    let branch = 'unknown';
    const gitFile = path.join(wtPath, '.git');
    try {
      const gitContent = await fs.readFile(gitFile, 'utf-8');
      const match = gitContent.match(/gitdir: .+\/worktrees\/(.+)/);
      if (match) branch = match[1];
    } catch {
      // Ignore error, use 'unknown'
    }

    return {
      path: wtPath,
      branch,
      uuid,
      age: formatAge(ageHours),
      ageHours,
      size: `${sizeMB} MB`,
    };
  } catch {
    return null;
  }
}

// Helper: Get directory size
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          totalSize += await getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
        }
      } catch {
        // Skip files/dirs that can't be accessed
      }
    }
  } catch {
    // Return 0 if directory can't be read
  }

  return totalSize;
}

// Helper: Format age
function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes ago`;
  if (hours < 24) return `${Math.round(hours)} hours ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// Helper: Remove worktree by path
async function removeWorktreeByPath(wtPath: string, force?: boolean): Promise<void> {
  const forceFlag = force ? '--force' : '';
  const { stderr } = await exec(`git worktree remove ${forceFlag} ${wtPath}`);
  if (stderr && stderr.includes('error')) {
    throw new Error(stderr);
  }
}

// Helper: Get timestamp
function getTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-').split('.')[0];
}

// Tool definition
export default tool({
  description: `ACCOUNTANT AGENT: Clean up stale import worktrees from /tmp.

This utility removes old import worktrees that were preserved after errors.

**Safety:**
- Default: only removes worktrees older than 24 hours
- Dry run mode available to preview changes
- Force mode available for locked worktrees

**Worktrees in /tmp are automatically cleaned on system reboot**

**Usage:**
- List all: cleanup-worktrees --dryRun true
- Clean old (default): cleanup-worktrees
- Clean all: cleanup-worktrees --all true
- Clean >48h: cleanup-worktrees --olderThanHours 48
- Force removal: cleanup-worktrees --force true

**Output:**
- Lists found worktrees with age and size
- Shows which worktrees will be/were removed
- Logs to .memory/cleanup-worktrees-<timestamp>.md`,

  args: {
    all: tool.schema
      .boolean()
      .optional()
      .describe('Remove all import worktrees regardless of age (default: false)'),
    dryRun: tool.schema
      .boolean()
      .optional()
      .describe('Show what would be removed without making changes (default: false)'),
    olderThanHours: tool.schema
      .number()
      .optional()
      .describe('Remove worktrees older than N hours (default: 24)'),
    force: tool.schema
      .boolean()
      .optional()
      .describe('Force removal even if worktree is locked (default: false)'),
  },

  async execute(params, context) {
    const { directory } = context;
    const result = await cleanupWorktrees(directory, params);
    return JSON.stringify(result, null, 2);
  },
});
