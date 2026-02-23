import { spawnSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Context information for an import worktree
 */
export interface WorktreeContext {
  /** Absolute path to the worktree directory (e.g., /tmp/import-worktree-<uuid>) */
  path: string;
  /** Git branch name for this worktree (e.g., import-<uuid>) */
  branch: string;
  /** Unique identifier for this worktree */
  uuid: string;
  /** Path to the main repository */
  mainRepoPath: string;
}

/**
 * Result of a worktree operation
 */
export interface WorktreeResult {
  success: boolean;
  error?: string;
}

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
  /** Base directory for worktrees (default: /tmp) */
  baseDir?: string;
}

/**
 * Executes a git command and returns the output.
 * Uses spawnSync to properly handle arguments with spaces.
 */
function execGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  }
  return (result.stdout || '').trim();
}

/**
 * Executes a git command and returns success/failure
 */
function execGitSafe(args: string[], cwd: string): { success: boolean; output: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    return { success: false, output: result.stderr || result.stdout || `git ${args[0]} failed` };
  }
  return { success: true, output: (result.stdout || '').trim() };
}

/**
 * Creates a new import worktree with a unique UUID.
 *
 * This creates an isolated workspace for import operations:
 * 1. Creates a new branch from HEAD
 * 2. Creates a worktree at /tmp/import-worktree-<uuid>
 *
 * @param mainRepoPath Path to the main repository
 * @param options Optional configuration
 * @returns WorktreeContext with path, branch, and uuid
 * @throws Error if git operations fail
 */
export function createImportWorktree(
  mainRepoPath: string,
  options: CreateWorktreeOptions = {}
): WorktreeContext {
  const baseDir = options.baseDir ?? '/tmp';
  const uuid = uuidv4();
  const branch = `import-${uuid}`;
  const worktreePath = path.join(baseDir, `import-worktree-${uuid}`);

  // Ensure we're in a git repository
  try {
    execGit(['rev-parse', '--git-dir'], mainRepoPath);
  } catch {
    throw new Error(`Not a git repository: ${mainRepoPath}`);
  }

  // Create new branch from HEAD
  execGit(['branch', branch], mainRepoPath);

  // Create worktree
  try {
    execGit(['worktree', 'add', worktreePath, branch], mainRepoPath);
  } catch (error) {
    // Cleanup branch if worktree creation fails
    execGitSafe(['branch', '-D', branch], mainRepoPath);
    throw error;
  }

  return {
    path: worktreePath,
    branch,
    uuid,
    mainRepoPath,
  };
}

/**
 * Commits changes in the worktree and merges back to main with --no-ff.
 *
 * This preserves the import as a distinct merge commit in history.
 *
 * @param context WorktreeContext from createImportWorktree
 * @param commitMessage Message for both the commit and merge
 * @throws Error if git operations fail
 */
export function mergeWorktree(context: WorktreeContext, commitMessage: string): void {
  // Check if there are changes to commit in the worktree
  const status = execGit(['status', '--porcelain'], context.path);

  if (status.length > 0) {
    // Stage all changes
    execGit(['add', '-A'], context.path);

    // Commit changes
    execGit(['commit', '-m', commitMessage], context.path);
  }

  // Get current branch in main repo
  const currentBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], context.mainRepoPath);

  // Merge with --no-ff to preserve merge commit
  execGit(['merge', '--no-ff', context.branch, '-m', commitMessage], context.mainRepoPath);

  // If we were on main and merged, we're done
  // Otherwise, restore original branch (edge case)
  if (currentBranch !== 'main' && currentBranch !== 'master') {
    // This shouldn't happen in normal workflow, but handle gracefully
    execGit(['checkout', currentBranch], context.mainRepoPath);
  }
}

/**
 * Removes a worktree and its associated branch.
 *
 * Use this to clean up after a successful merge or to discard a failed import.
 *
 * @param context WorktreeContext from createImportWorktree
 * @param force Force removal even if worktree has uncommitted changes
 * @returns WorktreeResult indicating success or failure
 */
export function removeWorktree(context: WorktreeContext, force = false): WorktreeResult {
  const forceFlag = force ? '--force' : '';
  const args = ['worktree', 'remove', context.path];
  if (forceFlag) {
    args.push(forceFlag);
  }

  // Remove worktree
  const removeResult = execGitSafe(args, context.mainRepoPath);
  if (!removeResult.success) {
    // If worktree directory doesn't exist, that's fine
    if (!fs.existsSync(context.path)) {
      // Just continue to branch deletion
    } else {
      return { success: false, error: `Failed to remove worktree: ${removeResult.output}` };
    }
  }

  // Prune worktree references
  execGitSafe(['worktree', 'prune'], context.mainRepoPath);

  // Delete the branch
  const branchResult = execGitSafe(['branch', '-D', context.branch], context.mainRepoPath);
  if (!branchResult.success) {
    // Branch might already be deleted or merged, that's okay
    if (!branchResult.output.includes('not found')) {
      return { success: false, error: `Failed to delete branch: ${branchResult.output}` };
    }
  }

  return { success: true };
}

/**
 * Checks if the given directory is inside a git worktree (not the main repo).
 *
 * This is used to enforce that certain operations only run in worktrees.
 *
 * @param directory Path to check
 * @returns true if directory is in a worktree, false if in main repo or not a git repo
 */
export function isInWorktree(directory: string): boolean {
  try {
    // Get the git directory for this repo
    const gitDir = execGit(['rev-parse', '--git-dir'], directory);

    // In a worktree, --git-dir returns something like /path/to/main/.git/worktrees/<name>
    // In the main repo, it returns .git or /path/to/repo/.git
    return gitDir.includes('.git/worktrees/');
  } catch {
    // Not a git repository
    return false;
  }
}

/**
 * Gets the main repository path from a worktree.
 *
 * @param worktreePath Path inside a worktree
 * @returns Path to the main repository, or null if not in a worktree
 */
export function getMainRepoPath(worktreePath: string): string | null {
  try {
    // Get the common git directory (main repo's .git)
    const commonDir = execGit(['rev-parse', '--git-common-dir'], worktreePath);

    // commonDir is like /path/to/main/.git
    // We want /path/to/main
    if (commonDir.endsWith('.git')) {
      return path.dirname(commonDir);
    }

    return commonDir;
  } catch {
    return null;
  }
}

/**
 * Lists all import worktrees (branches starting with 'import-').
 *
 * @param repoPath Path to the git repository
 * @returns Array of WorktreeContext for each import worktree
 */
export function listImportWorktrees(repoPath: string): WorktreeContext[] {
  try {
    const output = execGit(['worktree', 'list', '--porcelain'], repoPath);
    const worktrees: WorktreeContext[] = [];

    // Parse porcelain output
    const blocks = output.split('\n\n').filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.split('\n');
      let worktreePath = '';
      let branch = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.substring(9);
        } else if (line.startsWith('branch ')) {
          // branch refs/heads/import-<uuid>
          const ref = line.substring(7);
          branch = ref.replace('refs/heads/', '');
        }
      }

      // Only include import worktrees
      if (branch.startsWith('import-')) {
        const uuid = branch.replace('import-', '');
        worktrees.push({
          path: worktreePath,
          branch,
          uuid,
          mainRepoPath: repoPath,
        });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}
