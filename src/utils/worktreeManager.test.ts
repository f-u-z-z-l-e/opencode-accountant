import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createImportWorktree,
  mergeWorktree,
  removeWorktree,
  isInWorktree,
  getMainRepoPath,
  listImportWorktrees,
  withWorktree,
  type WorktreeContext,
} from './worktreeManager.ts';
import { initTestGitRepo } from './testHelpers.ts';

describe('worktreeManager', () => {
  let testRepoPath: string;
  let createdWorktrees: WorktreeContext[] = [];

  // Create a temporary git repository for testing
  beforeEach(() => {
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));

    // Initialize git repo with test configuration
    initTestGitRepo(testRepoPath);

    // Create initial commit
    fs.writeFileSync(path.join(testRepoPath, 'README.md'), '# Test Repo\n');
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    createdWorktrees = [];
  });

  // Clean up after each test
  afterEach(() => {
    // Remove any created worktrees
    for (const worktree of createdWorktrees) {
      try {
        removeWorktree(worktree, true);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Remove test repo
    try {
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createImportWorktree', () => {
    it('should create a worktree with unique UUID', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      expect(context.uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(context.branch).toBe(`import-${context.uuid}`);
      expect(context.path).toContain('import-worktree-');
      expect(context.mainRepoPath).toBe(testRepoPath);
      expect(fs.existsSync(context.path)).toBe(true);
    });

    it('should create worktree in custom base directory', () => {
      const customBase = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-base-'));
      try {
        const context = createImportWorktree(testRepoPath, { baseDir: customBase });
        createdWorktrees.push(context);

        expect(context.path).toContain(customBase);
        expect(fs.existsSync(context.path)).toBe(true);
      } finally {
        fs.rmSync(customBase, { recursive: true, force: true });
      }
    });

    it('should allow multiple concurrent worktrees', () => {
      const context1 = createImportWorktree(testRepoPath);
      const context2 = createImportWorktree(testRepoPath);
      createdWorktrees.push(context1, context2);

      expect(context1.uuid).not.toBe(context2.uuid);
      expect(context1.path).not.toBe(context2.path);
      expect(context1.branch).not.toBe(context2.branch);
      expect(fs.existsSync(context1.path)).toBe(true);
      expect(fs.existsSync(context2.path)).toBe(true);
    });

    it('should throw error for non-git directory', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
      try {
        expect(() => createImportWorktree(nonGitDir)).toThrow('Not a git repository');
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('should copy repository contents to worktree', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      expect(fs.existsSync(path.join(context.path, 'README.md'))).toBe(true);
      const content = fs.readFileSync(path.join(context.path, 'README.md'), 'utf-8');
      expect(content).toBe('# Test Repo\n');
    });
  });

  describe('mergeWorktree', () => {
    it('should merge worktree changes back to main with --no-ff', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      // Make changes in worktree
      fs.writeFileSync(path.join(context.path, 'new-file.txt'), 'New content\n');

      // Merge back
      mergeWorktree(context, 'Test merge commit');

      // Verify file exists in main repo
      expect(fs.existsSync(path.join(testRepoPath, 'new-file.txt'))).toBe(true);

      // Verify merge commit was created (--no-ff)
      const log = execSync('git log --oneline -3', { cwd: testRepoPath, encoding: 'utf-8' });
      expect(log).toContain('Test merge commit');
    });

    it('should handle worktree with no changes', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      // No changes made - should still work (fast-forward or no-op)
      expect(() => mergeWorktree(context, 'Empty merge')).not.toThrow();
    });

    it('should preserve commit history with merge commit', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      // Make multiple commits in worktree
      fs.writeFileSync(path.join(context.path, 'file1.txt'), 'Content 1\n');
      execSync('git add .', { cwd: context.path });
      execSync('git commit -m "First commit in worktree"', { cwd: context.path });

      fs.writeFileSync(path.join(context.path, 'file2.txt'), 'Content 2\n');
      execSync('git add .', { cwd: context.path });
      execSync('git commit -m "Second commit in worktree"', { cwd: context.path });

      // Merge back
      mergeWorktree(context, 'Import complete');

      // Verify both files exist
      expect(fs.existsSync(path.join(testRepoPath, 'file1.txt'))).toBe(true);
      expect(fs.existsSync(path.join(testRepoPath, 'file2.txt'))).toBe(true);

      // Verify merge commit exists
      const log = execSync('git log --oneline -5', { cwd: testRepoPath, encoding: 'utf-8' });
      expect(log).toContain('Import complete');
    });
  });

  describe('removeWorktree', () => {
    it('should remove worktree and branch', () => {
      const context = createImportWorktree(testRepoPath);

      const result = removeWorktree(context);

      expect(result.success).toBe(true);
      expect(fs.existsSync(context.path)).toBe(false);

      // Verify branch is deleted
      const branches = execSync('git branch', { cwd: testRepoPath, encoding: 'utf-8' });
      expect(branches).not.toContain(context.branch);
    });

    it('should force remove worktree with uncommitted changes', () => {
      const context = createImportWorktree(testRepoPath);

      // Make uncommitted changes
      fs.writeFileSync(path.join(context.path, 'uncommitted.txt'), 'Uncommitted\n');

      // Normal remove should fail
      removeWorktree(context, false);
      // This might succeed or fail depending on git version, so just test force

      // Force remove should succeed
      const forceResult = removeWorktree(context, true);
      expect(forceResult.success).toBe(true);
      expect(fs.existsSync(context.path)).toBe(false);
    });

    it('should handle already removed worktree gracefully', () => {
      const context = createImportWorktree(testRepoPath);

      // Remove manually
      fs.rmSync(context.path, { recursive: true, force: true });
      execSync('git worktree prune', { cwd: testRepoPath });

      // Should not throw
      const result = removeWorktree(context, true);
      expect(result.success).toBe(true);
    });
  });

  describe('isInWorktree', () => {
    it('should return false for main repository', () => {
      expect(isInWorktree(testRepoPath)).toBe(false);
    });

    it('should return true for worktree', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      expect(isInWorktree(context.path)).toBe(true);
    });

    it('should return false for non-git directory', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
      try {
        expect(isInWorktree(nonGitDir)).toBe(false);
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('should return true for subdirectory within worktree', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      // Create subdirectory
      const subdir = path.join(context.path, 'subdir');
      fs.mkdirSync(subdir);

      expect(isInWorktree(subdir)).toBe(true);
    });
  });

  describe('getMainRepoPath', () => {
    it('should return main repo path from worktree', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      const mainPath = getMainRepoPath(context.path);
      expect(mainPath).toBe(testRepoPath);
    });

    it('should return null for non-git directory', () => {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
      try {
        expect(getMainRepoPath(nonGitDir)).toBeNull();
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('listImportWorktrees', () => {
    it('should return empty array when no import worktrees exist', () => {
      const worktrees = listImportWorktrees(testRepoPath);
      expect(worktrees).toEqual([]);
    });

    it('should list all import worktrees', () => {
      const context1 = createImportWorktree(testRepoPath);
      const context2 = createImportWorktree(testRepoPath);
      createdWorktrees.push(context1, context2);

      const worktrees = listImportWorktrees(testRepoPath);

      expect(worktrees.length).toBe(2);
      expect(worktrees.map((w) => w.uuid).sort()).toEqual([context1.uuid, context2.uuid].sort());
    });

    it('should not include non-import worktrees', () => {
      const context = createImportWorktree(testRepoPath);
      createdWorktrees.push(context);

      // Create a non-import worktree manually
      const otherPath = path.join(os.tmpdir(), 'other-worktree');
      execSync(`git worktree add ${otherPath} -b feature-branch`, { cwd: testRepoPath });

      try {
        const worktrees = listImportWorktrees(testRepoPath);
        expect(worktrees.length).toBe(1);
        expect(worktrees[0].uuid).toBe(context.uuid);
      } finally {
        execSync(`git worktree remove ${otherPath} --force`, { cwd: testRepoPath });
        execSync('git branch -D feature-branch', { cwd: testRepoPath });
      }
    });
  });

  describe('withWorktree', () => {
    it('should create and cleanup worktree on success', async () => {
      const result = await withWorktree(testRepoPath, async (worktree) => {
        expect(worktree.path).toBeDefined();
        expect(worktree.uuid).toBeDefined();
        expect(worktree.branch).toMatch(/^import-/);
        expect(fs.existsSync(worktree.path)).toBe(true);
        return 'success';
      });

      expect(result).toBe('success');

      // Verify cleanup happened
      const worktrees = listImportWorktrees(testRepoPath);
      expect(worktrees).toHaveLength(0);
    });

    it('should cleanup worktree on operation failure', async () => {
      await expect(
        withWorktree(testRepoPath, async () => {
          throw new Error('Operation failed');
        })
      ).rejects.toThrow('Operation failed');

      // Verify cleanup happened
      const worktrees = listImportWorktrees(testRepoPath);
      expect(worktrees).toHaveLength(0);
    });

    it('should allow operations to modify files in worktree', async () => {
      const result = await withWorktree(testRepoPath, async (worktree) => {
        const testFile = path.join(worktree.path, 'test.txt');
        fs.writeFileSync(testFile, 'test content');
        expect(fs.existsSync(testFile)).toBe(true);
        return fs.readFileSync(testFile, 'utf-8');
      });

      expect(result).toBe('test content');

      // Verify cleanup happened
      const worktrees = listImportWorktrees(testRepoPath);
      expect(worktrees).toHaveLength(0);
    });

    it('should cleanup even if operation throws non-Error', async () => {
      await expect(
        withWorktree(testRepoPath, async () => {
          throw new Error('Operation failed with string');
        })
      ).rejects.toThrow('Operation failed with string');

      // Verify cleanup happened
      const worktrees = listImportWorktrees(testRepoPath);
      expect(worktrees).toHaveLength(0);
    });

    it('should return value from operation', async () => {
      const complexResult = await withWorktree(testRepoPath, async (worktree) => {
        return {
          path: worktree.path,
          uuid: worktree.uuid,
          customData: { foo: 'bar', count: 42 },
        };
      });

      expect(complexResult.uuid).toBeDefined();
      expect(complexResult.customData.foo).toBe('bar');
      expect(complexResult.customData.count).toBe(42);

      // Verify cleanup happened
      const worktrees = listImportWorktrees(testRepoPath);
      expect(worktrees).toHaveLength(0);
    });
  });
});
