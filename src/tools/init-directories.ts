import { tool } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import { checkAccountantAgent } from '../utils/agentRestriction.ts';
import { loadImportConfig } from '../utils/importConfig.ts';

/**
 * Result of initializing import directories
 */
interface InitDirectoriesResult {
  success: boolean;
  directoriesCreated: string[];
  gitkeepFiles: string[];
  gitignoreCreated: boolean;
  message?: string;
  error?: string;
}

/**
 * Create the directory structure needed for import operations
 */
export async function initDirectories(directory: string): Promise<InitDirectoriesResult> {
  try {
    // Load config to get directory paths
    const config = loadImportConfig(directory);

    const directoriesCreated: string[] = [];
    const gitkeepFiles: string[] = [];

    // Create base import directory
    const importBase = path.join(directory, 'import');
    if (!fs.existsSync(importBase)) {
      fs.mkdirSync(importBase, { recursive: true });
      directoriesCreated.push('import');
    }

    // Create subdirectories from config.paths
    const pathsToCreate = [
      { key: 'import', path: config.paths.import },
      { key: 'pending', path: config.paths.pending },
      { key: 'done', path: config.paths.done },
      { key: 'unrecognized', path: config.paths.unrecognized },
    ];

    for (const { path: dirPath } of pathsToCreate) {
      const fullPath = path.join(directory, dirPath);

      // Create directory if it doesn't exist
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
        directoriesCreated.push(dirPath);
      }

      // Add .gitkeep to track empty directories
      const gitkeepPath = path.join(fullPath, '.gitkeep');
      if (!fs.existsSync(gitkeepPath)) {
        fs.writeFileSync(gitkeepPath, '');
        gitkeepFiles.push(path.join(dirPath, '.gitkeep'));
      }
    }

    // Create .gitignore in import/ directory
    const gitignorePath = path.join(importBase, '.gitignore');
    let gitignoreCreated = false;

    if (!fs.existsSync(gitignorePath)) {
      const gitignoreContent = `# Ignore CSV/PDF files in temporary directories
/incoming/*.csv
/incoming/*.pdf
/pending/**/*.csv
/pending/**/*.pdf
/unrecognized/**/*.csv
/unrecognized/**/*.pdf

# Track processed files in done/ (audit trail)
# No ignore rule needed - tracked by default

# Ignore temporary files
*.tmp
*.temp
.DS_Store
Thumbs.db
`;

      fs.writeFileSync(gitignorePath, gitignoreContent);
      gitignoreCreated = true;
    }

    // Build success message
    const parts: string[] = [];
    if (directoriesCreated.length > 0) {
      parts.push(
        `Created ${directoriesCreated.length} director${directoriesCreated.length === 1 ? 'y' : 'ies'}`
      );
    }
    if (gitkeepFiles.length > 0) {
      parts.push(
        `added ${gitkeepFiles.length} .gitkeep file${gitkeepFiles.length === 1 ? '' : 's'}`
      );
    }
    if (gitignoreCreated) {
      parts.push('created .gitignore');
    }

    const message =
      parts.length > 0
        ? `Import directory structure initialized: ${parts.join(', ')}`
        : 'Import directory structure already exists (no changes needed)';

    return {
      success: true,
      directoriesCreated,
      gitkeepFiles,
      gitignoreCreated,
      message,
    };
  } catch (error) {
    return {
      success: false,
      directoriesCreated: [],
      gitkeepFiles: [],
      gitignoreCreated: false,
      error: error instanceof Error ? error.message : String(error),
      message: 'Failed to initialize import directory structure',
    };
  }
}

/**
 * Tool definition for init-directories
 */
export default tool({
  description:
    'ACCOUNTANT AGENT ONLY: Initialize the import directory structure needed for processing bank statements. Creates import/incoming, import/pending, import/done, and import/unrecognized directories with .gitkeep files and appropriate .gitignore rules. Reads directory paths from config/import/providers.yaml. Safe to run multiple times (idempotent).',
  args: {},
  async execute(_params, context) {
    const restrictionError = checkAccountantAgent(context.agent, 'init directories');
    if (restrictionError) {
      throw new Error(restrictionError);
    }
    const { directory } = context;

    const result = await initDirectories(directory);

    if (!result.success) {
      return `Error: ${result.error}\n\n${result.message}`;
    }

    // Build detailed output
    const output: string[] = [];
    output.push(result.message || '');

    if (result.directoriesCreated.length > 0) {
      output.push('\nDirectories created:');
      for (const dir of result.directoriesCreated) {
        output.push(`  - ${dir}`);
      }
    }

    if (result.gitkeepFiles.length > 0) {
      output.push('\n.gitkeep files added:');
      for (const file of result.gitkeepFiles) {
        output.push(`  - ${file}`);
      }
    }

    if (result.gitignoreCreated) {
      output.push('\nCreated import/.gitignore with rules to:');
      output.push('  - Ignore CSV/PDF files in incoming/, pending/, unrecognized/');
      output.push('  - Track processed files in done/ for audit trail');
    }

    output.push('\nYou can now drop CSV files into import/incoming/ and run import-pipeline.');

    return output.join('\n');
  },
});
