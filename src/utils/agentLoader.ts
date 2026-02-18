import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

export interface AgentConfig {
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

type AgentFrontmatter = Omit<AgentConfig, 'prompt'>;

export function loadAgent(filePath: string): AgentConfig | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    throw new Error(`Invalid frontmatter format in ${filePath}`);
  }

  const data = yaml.load(match[1]) as AgentFrontmatter;

  return {
    description: data.description,
    prompt: match[2].trim(),
    ...(data.mode && { mode: data.mode }),
    ...(data.model && { model: data.model }),
    ...(data.temperature !== undefined && { temperature: data.temperature }),
    ...(data.maxSteps !== undefined && { maxSteps: data.maxSteps }),
    ...(data.disable !== undefined && { disable: data.disable }),
    ...(data.tools && { tools: data.tools }),
    ...(data.permissions && { permissions: data.permissions }),
  };
}
