import type { Plugin } from '@opencode-ai/plugin';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgent } from './utils/agentLoader.ts';
import {
  fetchCurrencyPrices,
  classifyStatements,
  importStatements,
  reconcileStatement,
  importPipeline,
} from './tools/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_FILE = join(__dirname, '..', 'agent', 'accountant.md');

const AccountantPlugin: Plugin = async () => {
  const agent = loadAgent(AGENT_FILE);

  return {
    tool: {
      'fetch-currency-prices': fetchCurrencyPrices,
      'classify-statements': classifyStatements,
      'import-statements': importStatements,
      'reconcile-statements': reconcileStatement,
      'import-pipeline': importPipeline,
    },
    config: async (config: Record<string, unknown>): Promise<void> => {
      if (agent) {
        config.agent = { ...((config.agent as Record<string, unknown>) ?? {}), accountant: agent };
      }
    },
  };
};

export default AccountantPlugin;
