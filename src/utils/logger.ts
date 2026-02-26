import fs from 'fs/promises';
import path from 'path';

/**
 * Logger interface for structured logging to markdown files
 */
export interface Logger {
  /** Start a new section in the log */
  startSection(title: string, level?: 1 | 2 | 3): void;
  /** End the current section */
  endSection(): void;
  /** Log informational message */
  info(message: string): void;
  /** Log warning message */
  warn(message: string): void;
  /** Log error message with optional error object */
  error(message: string, error?: Error | unknown): void;
  /** Log debug message */
  debug(message: string): void;
  /** Log a step with status indicator */
  logStep(stepName: string, status: 'start' | 'success' | 'error', details?: string): void;
  /** Log command execution with output */
  logCommand(command: string, output?: string): void;
  /** Log structured data as JSON */
  logResult(data: Record<string, unknown>): void;
  /** Set context metadata */
  setContext(key: string, value: string): void;
  /** Flush buffer to file */
  flush(): Promise<void>;
  /** Get the log file path */
  getLogPath(): string;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Directory where log files are stored */
  logDir: string;
  /** Optional filename (defaults to import-<timestamp>.md) */
  filename?: string;
  /** Auto-flush after each log (default: true) */
  autoFlush?: boolean;
  /** Initial context metadata */
  context?: Record<string, string>;
}

/**
 * Markdown-based logger implementation
 */
class MarkdownLogger implements Logger {
  private buffer: string[] = [];
  private logPath: string;
  private context: Record<string, string> = {};
  private autoFlush: boolean;
  private sectionDepth: number = 0;

  constructor(config: LoggerConfig) {
    this.autoFlush = config.autoFlush ?? true;
    this.context = config.context || {};

    const filename = config.filename || `import-${this.getTimestamp()}.md`;
    this.logPath = path.join(config.logDir, filename);

    // Initialize log with header
    this.buffer.push(`# Import Pipeline Log`);
    this.buffer.push(`**Started**: ${new Date().toLocaleString()}`);
    this.buffer.push('');
  }

  startSection(title: string, level: 1 | 2 | 3 = 2): void {
    this.buffer.push('');
    this.buffer.push(`${'#'.repeat(level + 1)} ${title}`);
    this.buffer.push(`**Started**: ${this.getTime()}`);
    this.buffer.push('');
    this.sectionDepth++;
  }

  endSection(): void {
    if (this.sectionDepth > 0) {
      this.buffer.push('');
      this.buffer.push('---');
      this.buffer.push('');
      this.sectionDepth--;
    }
  }

  info(message: string): void {
    this.buffer.push(message);
    if (this.autoFlush) this.flushAsync();
  }

  warn(message: string): void {
    this.buffer.push(`⚠️ **WARNING**: ${message}`);
    if (this.autoFlush) this.flushAsync();
  }

  error(message: string, error?: Error | unknown): void {
    this.buffer.push(`❌ **ERROR**: ${message}`);
    if (error) {
      const errorStr = error instanceof Error ? error.message : String(error);
      this.buffer.push('');
      this.buffer.push('```');
      this.buffer.push(errorStr);
      if (error instanceof Error && error.stack) {
        this.buffer.push('');
        this.buffer.push(error.stack);
      }
      this.buffer.push('```');
      this.buffer.push('');
    }
    if (this.autoFlush) this.flushAsync();
  }

  debug(message: string): void {
    this.buffer.push(`🔍 ${message}`);
    if (this.autoFlush) this.flushAsync();
  }

  logStep(stepName: string, status: 'start' | 'success' | 'error', details?: string): void {
    const icon = status === 'success' ? '✅' : status === 'error' ? '❌' : '▶️';
    const statusText = status.charAt(0).toUpperCase() + status.slice(1);

    this.buffer.push(`**${stepName}**: ${icon} ${statusText}`);
    if (details) {
      this.buffer.push(`  ${details}`);
    }
    this.buffer.push('');
    if (this.autoFlush) this.flushAsync();
  }

  logCommand(command: string, output?: string): void {
    this.buffer.push('```bash');
    this.buffer.push(`$ ${command}`);
    if (output) {
      this.buffer.push('');
      // Truncate output if too long
      const lines = output.trim().split('\n');
      if (lines.length > 50) {
        this.buffer.push(...lines.slice(0, 50));
        this.buffer.push(`... (${lines.length - 50} more lines omitted)`);
      } else {
        this.buffer.push(output.trim());
      }
    }
    this.buffer.push('```');
    this.buffer.push('');
    if (this.autoFlush) this.flushAsync();
  }

  logResult(data: Record<string, unknown>): void {
    this.buffer.push('```json');
    this.buffer.push(JSON.stringify(data, null, 2));
    this.buffer.push('```');
    this.buffer.push('');
    if (this.autoFlush) this.flushAsync();
  }

  setContext(key: string, value: string): void {
    this.context[key] = value;
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });

      // Write buffer to file
      await fs.writeFile(this.logPath, this.buffer.join('\n'), 'utf-8');
    } catch {
      // Silent failure to avoid breaking the import process
      // Could log to stderr in future if needed
    }
  }

  getLogPath(): string {
    return this.logPath;
  }

  private flushAsync(): void {
    this.flush().catch(() => {
      // Silent failure - logging should never break the import
    });
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace(/:/g, '-').split('.')[0];
  }

  private getTime(): string {
    return new Date().toLocaleTimeString();
  }
}

/**
 * Factory function to create a logger
 */
export function createLogger(config: LoggerConfig): Logger {
  return new MarkdownLogger(config);
}

/**
 * Convenience function to create a logger for import operations
 */
export function createImportLogger(
  directory: string,
  worktreeId?: string,
  provider?: string
): Logger {
  const context: Record<string, string> = {};
  if (worktreeId) context.worktreeId = worktreeId;
  if (provider) context.provider = provider;

  const logger = createLogger({
    logDir: path.join(directory, '.memory'),
    autoFlush: true,
    context,
  });

  // Log context
  if (worktreeId) logger.info(`**Worktree ID**: ${worktreeId}`);
  if (provider) logger.info(`**Provider**: ${provider}`);
  logger.info(`**Repository**: ${directory}`);
  logger.info('');

  return logger;
}
