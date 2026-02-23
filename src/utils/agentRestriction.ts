/**
 * Agent restriction utilities for tool access control
 */

export interface AgentRestrictionError {
  success: false;
  error: string;
  hint: string;
  caller: string;
}

/**
 * Checks if the calling agent is the accountant agent.
 * Returns null if authorized, or a JSON string error response if denied.
 *
 * @param agent - The agent identifier making the request
 * @param toolPrompt - The tool-specific prompt string for the hint message (e.g., 'import statements')
 * @param additionalFields - Optional additional fields to include in error response
 * @returns null if authorized, JSON string error if denied
 *
 * @example
 * const error = checkAccountantAgent(agent, 'import statements');
 * if (error) return error;
 */
export function checkAccountantAgent(
  agent: string,
  toolPrompt: string,
  additionalFields?: Record<string, unknown>
): string | null {
  if (agent === 'accountant') {
    return null;
  }

  const errorResponse: AgentRestrictionError & Record<string, unknown> = {
    success: false,
    error: 'This tool is restricted to the accountant agent only.',
    hint: `Use: Task(subagent_type='accountant', prompt='${toolPrompt}')`,
    caller: agent || 'main assistant',
    ...additionalFields,
  };

  return JSON.stringify(errorResponse);
}
