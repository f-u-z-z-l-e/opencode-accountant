import type { Plugin } from '@opencode-ai/plugin';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgents } from './loaders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_DIR = join(__dirname, '..', 'agent');

const AccountantPlugin: Plugin = async () => {
  const agents = loadAgents(AGENT_DIR);

  return {
    config: async (config: Record<string, unknown>): Promise<void> => {
      if (Object.keys(agents).length > 0) {
        config.agent = { ...((config.agent as Record<string, unknown>) ?? {}), ...agents };
      }
    },
  };
};

export default AccountantPlugin;
