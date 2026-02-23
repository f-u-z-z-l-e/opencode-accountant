import { describe, it, expect } from 'vitest';
import { checkAccountantAgent } from './agentRestriction.ts';

describe('checkAccountantAgent', () => {
  describe('when agent is accountant', () => {
    it('should return null', () => {
      const result = checkAccountantAgent('accountant', 'import statements');
      expect(result).toBeNull();
    });
  });

  describe('when agent is not accountant', () => {
    it('should return error JSON for unknown agent', () => {
      const result = checkAccountantAgent('general', 'import statements');
      expect(result).toBeTruthy();

      const parsed = JSON.parse(result!);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('This tool is restricted to the accountant agent only.');
      expect(parsed.hint).toBe("Use: Task(subagent_type='accountant', prompt='import statements')");
      expect(parsed.caller).toBe('general');
    });

    it('should return error JSON for undefined agent', () => {
      const result = checkAccountantAgent('', 'update prices');
      expect(result).toBeTruthy();

      const parsed = JSON.parse(result!);
      expect(parsed.caller).toBe('main assistant');
    });

    it('should include tool-specific prompt in hint', () => {
      const result = checkAccountantAgent('main', 'classify statements');
      expect(result).toBeTruthy();

      const parsed = JSON.parse(result!);
      expect(parsed.hint).toBe(
        "Use: Task(subagent_type='accountant', prompt='classify statements')"
      );
    });

    it('should include additional fields when provided', () => {
      const result = checkAccountantAgent('main', 'classify statements', {
        classified: [],
        unrecognized: [],
      });
      expect(result).toBeTruthy();

      const parsed = JSON.parse(result!);
      expect(parsed.classified).toEqual([]);
      expect(parsed.unrecognized).toEqual([]);
    });

    it('should preserve base fields when additional fields provided', () => {
      const result = checkAccountantAgent('main', 'test', { custom: 'value' });
      expect(result).toBeTruthy();

      const parsed = JSON.parse(result!);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('This tool is restricted to the accountant agent only.');
      expect(parsed.hint).toContain('test');
      expect(parsed.caller).toBe('main');
      expect(parsed.custom).toBe('value');
    });
  });
});
