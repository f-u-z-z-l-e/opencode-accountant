import { execSync } from 'child_process';

/**
 * Initialize a git repository for testing with proper configuration.
 *
 * This function:
 * - Initializes a new git repository
 * - Configures user.email and user.name for commits
 * - Disables GPG signing to prevent popups during automated tests
 * - Disables verbose commit messages for cleaner test output
 * - Disables detached HEAD warnings that clutter test output
 *
 * @param repoPath - Path to the directory where the git repo should be initialized
 */
export function initTestGitRepo(repoPath: string): void {
  execSync('git init', { cwd: repoPath });
  execSync('git config user.email "test@test.com"', { cwd: repoPath });
  execSync('git config user.name "Test User"', { cwd: repoPath });
  execSync('git config commit.gpgsign false', { cwd: repoPath });
  execSync('git config commit.verbose false', { cwd: repoPath });
  execSync('git config advice.detachedHead false', { cwd: repoPath });
}
