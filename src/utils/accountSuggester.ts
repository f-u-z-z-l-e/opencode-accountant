/**
 * Account Suggester
 *
 * Provides AI-powered account suggestions for unknown postings.
 * Uses batch processing and caching for efficiency.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { UnknownPosting, UnknownPostingWithSuggestion } from './hledgerExecutor.ts';
import { loadAgent } from './agentLoader.ts';
import type { Logger } from './logger.js';

/**
 * Context needed for generating account suggestions
 */
export interface SuggestionContext {
  existingAccounts: string[];
  rulesFilePath?: string;
  existingRules?: RulePattern[];
  yearJournalPath?: string;
  logger?: Logger;
}

/**
 * Extracted pattern from rules file for learning
 */
export interface RulePattern {
  condition: string;
  account: string;
}

/**
 * Suggestion result from LLM
 */
export interface AccountSuggestion {
  account: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * Cache for storing suggestions by transaction hash
 */
interface SuggestionCache {
  [key: string]: AccountSuggestion;
}

/**
 * Global cache instance (per import run)
 */
const suggestionCache: SuggestionCache = {};

/**
 * Clears the suggestion cache.
 * Useful for testing or starting fresh import runs.
 */
export function clearSuggestionCache(): void {
  Object.keys(suggestionCache).forEach((key) => delete suggestionCache[key]);
}

/**
 * Generates a hash key for a transaction to use in caching
 */
export function hashTransaction(posting: UnknownPosting): string {
  const data = `${posting.description}|${posting.amount}|${posting.account}`;
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Load existing accounts from a year journal file.
 * Extracts all 'account' declarations.
 */
export async function loadExistingAccounts(yearJournalPath: string): Promise<string[]> {
  if (!fs.existsSync(yearJournalPath)) {
    return [];
  }

  const content = fs.readFileSync(yearJournalPath, 'utf-8');
  const lines = content.split('\n');
  const accounts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('account ')) {
      const match = trimmed.match(/^account\s+(.+?)(?:\s+|$)/);
      if (match) {
        accounts.push(match[1].trim());
      }
    }
  }

  return accounts.sort();
}

/**
 * Extract rule patterns from a rules file for learning.
 * Looks for 'if ... account2 ...' patterns.
 */
export async function extractRulePatternsFromFile(rulesPath: string): Promise<RulePattern[]> {
  if (!fs.existsSync(rulesPath)) {
    return [];
  }

  const content = fs.readFileSync(rulesPath, 'utf-8');
  const lines = content.split('\n');
  const patterns: RulePattern[] = [];

  let currentCondition: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed === '') {
      continue;
    }

    // Match 'if' condition
    const ifMatch = trimmed.match(/^if\s+(.+)$/);
    if (ifMatch) {
      currentCondition = ifMatch[1].trim();
      continue;
    }

    // Match 'account2' directive (must follow an 'if')
    const account2Match = trimmed.match(/^\s*account2\s+(.+?)(?:\s+|$)/);
    if (account2Match && currentCondition) {
      patterns.push({
        condition: currentCondition,
        account: account2Match[1].trim(),
      });
      currentCondition = null; // Reset after matching
      continue;
    }

    // Reset condition if we hit a non-account2 line after if
    if (currentCondition && !trimmed.startsWith('account2')) {
      currentCondition = null;
    }
  }

  return patterns;
}

/**
 * Build the prompt for batch account suggestions
 */
function buildBatchSuggestionPrompt(
  postings: UnknownPosting[],
  context: SuggestionContext
): string {
  let prompt = `You are an accounting assistant helping categorize bank transactions.\n\n`;
  prompt += `I have ${postings.length} transaction(s) that need account classification:\n\n`;

  // Add existing account hierarchy
  if (context.existingAccounts.length > 0) {
    prompt += `## Existing Account Hierarchy\n\n`;
    prompt += context.existingAccounts.map((acc) => `- ${acc}`).join('\n');
    prompt += '\n\n';
  }

  // Add example patterns from rules
  if (context.existingRules && context.existingRules.length > 0) {
    prompt += `## Example Classification Patterns from Rules\n\n`;
    const sampleSize = Math.min(10, context.existingRules.length);
    for (let i = 0; i < sampleSize; i++) {
      const pattern = context.existingRules[i];
      prompt += `- If description matches "${pattern.condition}" → ${pattern.account}\n`;
    }
    prompt += '\n';
  }

  // Add transactions to classify
  prompt += `## Transactions to Classify\n\n`;
  postings.forEach((posting, index) => {
    prompt += `Transaction ${index + 1}:\n`;
    prompt += `- Type: ${posting.account === 'income:unknown' ? 'Income' : 'Expense'}\n`;
    prompt += `- Date: ${posting.date}\n`;
    prompt += `- Description: ${posting.description}\n`;
    prompt += `- Amount: ${posting.amount}\n`;

    if (posting.csvRow) {
      prompt += `- CSV Data: ${JSON.stringify(posting.csvRow)}\n`;
    }

    prompt += '\n';
  });

  // Add task instructions
  prompt += `## Task\n\n`;
  prompt += `For EACH transaction, suggest the most appropriate account. You may:\n`;
  prompt += `1. Suggest an existing account from the hierarchy above\n`;
  prompt += `2. Propose a NEW account following the existing naming patterns\n\n`;

  prompt += `## Response Format\n\n`;
  prompt += `Respond with suggestions for ALL transactions in this exact format:\n\n`;
  prompt += `TRANSACTION 1:\n`;
  prompt += `ACCOUNT: {account_name}\n`;
  prompt += `CONFIDENCE: {high|medium|low}\n`;
  prompt += `REASONING: {brief one-sentence explanation}\n\n`;
  prompt += `TRANSACTION 2:\n`;
  prompt += `ACCOUNT: {account_name}\n`;
  prompt += `CONFIDENCE: {high|medium|low}\n`;
  prompt += `REASONING: {brief one-sentence explanation}\n\n`;
  prompt += `... (continue for all transactions)\n`;

  return prompt;
}

/**
 * Parse the batch response from the LLM
 */
function parseBatchSuggestionResponse(response: string): AccountSuggestion[] {
  const suggestions: AccountSuggestion[] = [];
  const transactionBlocks = response.split(/TRANSACTION\s+\d+:/i).filter((b) => b.trim());

  for (const block of transactionBlocks) {
    const accountMatch = block.match(/ACCOUNT:\s*(.+?)$/im);
    const confidenceMatch = block.match(/CONFIDENCE:\s*(high|medium|low)/i);
    const reasoningMatch = block.match(/REASONING:\s*(.+?)$/im);

    if (accountMatch && confidenceMatch) {
      suggestions.push({
        account: accountMatch[1].trim(),
        confidence: confidenceMatch[1].toLowerCase() as 'high' | 'medium' | 'low',
        reasoning: reasoningMatch ? reasoningMatch[1].trim() : '',
      });
    }
  }

  return suggestions;
}

/**
 * Generate account suggestions for multiple postings using batch processing and caching.
 *
 * @param postings Array of unknown postings to classify
 * @param context Suggestion context with existing accounts and rules
 * @returns Array of postings enriched with suggestions
 */
export async function suggestAccountsForPostingsBatch(
  postings: UnknownPosting[],
  context: SuggestionContext
): Promise<UnknownPostingWithSuggestion[]> {
  if (postings.length === 0) {
    return [];
  }

  // Separate cached and uncached postings
  const uncachedPostings: UnknownPosting[] = [];
  const cachedResults: Map<number, AccountSuggestion> = new Map();

  postings.forEach((posting, index) => {
    const hash = hashTransaction(posting);
    if (suggestionCache[hash]) {
      cachedResults.set(index, suggestionCache[hash]);
    } else {
      uncachedPostings.push(posting);
    }
  });

  context.logger?.info(
    `Account suggestions: ${cachedResults.size} cached, ${uncachedPostings.length} to generate`
  );

  // Generate suggestions for uncached postings
  let newSuggestions: AccountSuggestion[] = [];
  if (uncachedPostings.length > 0) {
    try {
      // Load agent configuration
      const agentPath = './agent/account-suggester.md';
      const agentConfig = loadAgent(agentPath);

      if (!agentConfig) {
        throw new Error(`Agent configuration not found: ${agentPath}`);
      }

      // Build batch prompt
      const userPrompt = buildBatchSuggestionPrompt(uncachedPostings, context);

      // Combine agent prompt with user prompt
      const fullPrompt = `${agentConfig.prompt}\n\n---\n\n${userPrompt}`;

      // TODO: Actually invoke LLM here with agent config
      // For now, we'll simulate the response parsing
      // In production, this would call an LLM API with the agent config

      context.logger?.info('Invoking LLM for account suggestions...');
      context.logger?.info(`Agent model: ${agentConfig.model}`);
      context.logger?.info(`Agent temperature: ${agentConfig.temperature}`);
      context.logger?.info(`Prompt length: ${fullPrompt.length}`);

      // TEMPORARY: Mock response for development
      // TODO: Replace with actual LLM invocation
      const mockResponse = generateMockSuggestions(uncachedPostings);
      newSuggestions = parseBatchSuggestionResponse(mockResponse);

      // Cache the new suggestions
      uncachedPostings.forEach((posting, index) => {
        if (newSuggestions[index]) {
          const hash = hashTransaction(posting);
          suggestionCache[hash] = newSuggestions[index];
        }
      });
    } catch (error) {
      context.logger?.error(
        `[ERROR] Failed to generate account suggestions: ${error instanceof Error ? error.message : String(error)}`
      );
      // Return postings without suggestions on error
      return postings;
    }
  }

  // Merge cached and new suggestions back into original order
  const results: UnknownPostingWithSuggestion[] = [];
  let uncachedIndex = 0;

  postings.forEach((posting, index) => {
    const cachedSuggestion = cachedResults.get(index);
    const suggestion = cachedSuggestion || newSuggestions[uncachedIndex++];

    results.push({
      ...posting,
      suggestedAccount: suggestion?.account,
      suggestionConfidence: suggestion?.confidence,
      suggestionReasoning: suggestion?.reasoning,
    });
  });

  return results;
}

/**
 * TEMPORARY: Generate mock suggestions for development.
 * TODO: Remove this once LLM integration is complete.
 */
function generateMockSuggestions(postings: UnknownPosting[]): string {
  let response = '';

  postings.forEach((posting, index) => {
    response += `TRANSACTION ${index + 1}:\n`;

    // Simple heuristic-based mock suggestions
    const desc = posting.description.toLowerCase();
    const isIncome = posting.account === 'income:unknown';

    let account = isIncome ? 'income:other' : 'expenses:other';
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let reasoning = 'Generic classification based on transaction type';

    // Simple pattern matching for mock
    if (desc.includes('migros') || desc.includes('coop')) {
      account = 'expenses:groceries';
      confidence = 'high';
      reasoning = 'Transaction from known grocery store';
    } else if (desc.includes('salary') || desc.includes('lohn')) {
      account = 'income:salary';
      confidence = 'high';
      reasoning = 'Salary payment detected';
    } else if (desc.includes('sbb') || desc.includes('train')) {
      account = 'expenses:transport';
      confidence = 'medium';
      reasoning = 'Transportation-related transaction';
    }

    response += `ACCOUNT: ${account}\n`;
    response += `CONFIDENCE: ${confidence}\n`;
    response += `REASONING: ${reasoning}\n\n`;
  });

  return response;
}
