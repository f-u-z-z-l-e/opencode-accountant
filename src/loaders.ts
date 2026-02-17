import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import yaml from 'js-yaml';

interface AgentFrontmatter {
  description: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  temperature?: number;
  maxSteps?: number;
  disable?: boolean;
  tools?: Record<string, boolean>;
  permission?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
}

interface AgentConfigOutput {
  description: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  temperature?: number;
  maxSteps?: number;
  disable?: boolean;
  tools?: Record<string, boolean>;
  permissions?: Record<string, unknown>;
  prompt: string;
}

interface ParsedFrontmatter<T> {
  data: T;
  body: string;
}

function parseFrontmatter<T>(content: string): ParsedFrontmatter<T> {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error('Invalid frontmatter format');
  }

  const [, frontmatter, body] = match;
  const data = yaml.load(frontmatter) as T;

  return { data, body: body.trim() };
}

export function loadAgents(dir: string): Record<string, AgentConfigOutput> {
  const agents: Record<string, AgentConfigOutput> = {};

  if (!existsSync(dir)) {
    return agents;
  }

  const files = readdirSync(dir).filter((file) => file.endsWith('.md'));

  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, 'utf-8');
    const name = basename(file, '.md');

    try {
      const { data, body } = parseFrontmatter<AgentFrontmatter>(content);

      agents[name] = {
        description: data.description,
        prompt: body,
        ...(data.mode && { mode: data.mode }),
        ...(data.model && { model: data.model }),
        ...(data.temperature !== undefined && { temperature: data.temperature }),
        ...(data.maxSteps !== undefined && { maxSteps: data.maxSteps }),
        ...(data.disable !== undefined && { disable: data.disable }),
        ...(data.tools && { tools: data.tools }),
        ...((data.permissions || data.permission) && {
          permissions: data.permissions || data.permission,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse agent file ${file}: ${message}`);
    }
  }

  return agents;
}
