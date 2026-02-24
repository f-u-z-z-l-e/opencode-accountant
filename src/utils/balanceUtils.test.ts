import { describe, it, expect } from 'vitest';
import {
  parseAmountValue,
  parseBalance,
  calculateDifference,
  formatBalance,
  balancesMatch,
} from './balanceUtils.ts';

describe('balanceUtils', () => {
  describe('parseAmountValue', () => {
    it('parses positive amount with currency prefix', () => {
      expect(parseAmountValue('CHF95.25')).toBe(95.25);
    });

    it('parses negative amount with currency prefix', () => {
      expect(parseAmountValue('CHF-10.00')).toBe(-10.0);
    });

    it('parses amount with currency prefix and space', () => {
      expect(parseAmountValue('CHF 123.45')).toBe(123.45);
    });

    it('parses pure positive number', () => {
      expect(parseAmountValue('95.25')).toBe(95.25);
    });

    it('parses pure negative number', () => {
      expect(parseAmountValue('-95.25')).toBe(-95.25);
    });

    it('parses amount with comma separator', () => {
      expect(parseAmountValue('1,234.56')).toBe(1234.56);
    });

    it('returns 0 for empty string', () => {
      expect(parseAmountValue('')).toBe(0);
    });

    it('returns 0 for invalid string', () => {
      expect(parseAmountValue('invalid')).toBe(0);
    });

    it('handles EUR currency', () => {
      expect(parseAmountValue('EUR 500.75')).toBe(500.75);
    });

    it('handles USD currency', () => {
      expect(parseAmountValue('USD-25.00')).toBe(-25.0);
    });
  });

  describe('parseBalance', () => {
    it('parses "CHF 2324.79" format', () => {
      const result = parseBalance('CHF 2324.79');
      expect(result).toEqual({ currency: 'CHF', amount: 2324.79 });
    });

    it('parses "2324.79 CHF" format', () => {
      const result = parseBalance('2324.79 CHF');
      expect(result).toEqual({ currency: 'CHF', amount: 2324.79 });
    });

    it('parses "CHF2324.79" format (no space)', () => {
      const result = parseBalance('CHF2324.79');
      expect(result).toEqual({ currency: 'CHF', amount: 2324.79 });
    });

    it('parses pure number without currency', () => {
      const result = parseBalance('2324.79');
      expect(result).toEqual({ currency: '', amount: 2324.79 });
    });

    it('handles negative amounts with currency prefix', () => {
      const result = parseBalance('CHF -100.50');
      expect(result).toEqual({ currency: 'CHF', amount: -100.5 });
    });

    it('handles negative amounts with currency suffix', () => {
      const result = parseBalance('-100.50 CHF');
      expect(result).toEqual({ currency: 'CHF', amount: -100.5 });
    });

    it('handles comma separators', () => {
      const result = parseBalance('CHF 1,234.56');
      expect(result).toEqual({ currency: 'CHF', amount: 1234.56 });
    });

    it('handles comma separators without currency', () => {
      const result = parseBalance('1,234.56');
      expect(result).toEqual({ currency: '', amount: 1234.56 });
    });

    it('returns null for invalid formats', () => {
      expect(parseBalance('invalid')).toBeNull();
    });

    it('returns null for empty strings', () => {
      expect(parseBalance('')).toBeNull();
    });

    it('handles EUR currency', () => {
      const result = parseBalance('EUR 500.00');
      expect(result).toEqual({ currency: 'EUR', amount: 500.0 });
    });

    it('handles USD currency', () => {
      const result = parseBalance('100.25 USD');
      expect(result).toEqual({ currency: 'USD', amount: 100.25 });
    });

    it('handles zero balance', () => {
      const result = parseBalance('CHF 0.00');
      expect(result).toEqual({ currency: 'CHF', amount: 0.0 });
    });

    it('handles zero without currency', () => {
      const result = parseBalance('0');
      expect(result).toEqual({ currency: '', amount: 0.0 });
    });
  });

  describe('calculateDifference', () => {
    it('calculates positive difference', () => {
      const result = calculateDifference('CHF 100.00', 'CHF 105.50');
      expect(result).toBe('CHF +5.50');
    });

    it('calculates negative difference', () => {
      const result = calculateDifference('CHF 100.00', 'CHF 95.00');
      expect(result).toBe('CHF -5.00');
    });

    it('calculates zero difference', () => {
      const result = calculateDifference('CHF 100.00', 'CHF 100.00');
      expect(result).toBe('CHF +0.00');
    });

    it('returns formatted difference with currency', () => {
      const result = calculateDifference('EUR 200.00', 'EUR 210.75');
      expect(result).toBe('EUR +10.75');
    });

    it('handles balances without currency', () => {
      const result = calculateDifference('100.00', '95.50');
      expect(result).toBe('-4.50');
    });

    it('handles one balance with currency, one without', () => {
      const result = calculateDifference('CHF 100.00', '105.00');
      expect(result).toBe('CHF +5.00');
    });

    it('throws error for mismatched currencies', () => {
      expect(() => {
        calculateDifference('CHF 100.00', 'EUR 100.00');
      }).toThrow('Currency mismatch: expected CHF, got EUR');
    });

    it('throws error for unparseable expected balance', () => {
      expect(() => {
        calculateDifference('invalid', 'CHF 100.00');
      }).toThrow('Cannot parse balances');
    });

    it('throws error for unparseable actual balance', () => {
      expect(() => {
        calculateDifference('CHF 100.00', 'invalid');
      }).toThrow('Cannot parse balances');
    });

    it('handles large differences', () => {
      const result = calculateDifference('CHF 100.00', 'CHF 5000.00');
      expect(result).toBe('CHF +4900.00');
    });

    it('handles negative balances', () => {
      const result = calculateDifference('CHF -50.00', 'CHF -30.00');
      expect(result).toBe('CHF +20.00');
    });
  });

  describe('formatBalance', () => {
    it('formats with currency prefix', () => {
      expect(formatBalance(2324.79, 'CHF')).toBe('CHF 2324.79');
    });

    it('handles negative amounts', () => {
      expect(formatBalance(-100.5, 'EUR')).toBe('EUR -100.50');
    });

    it('formats to 2 decimal places', () => {
      expect(formatBalance(100.1, 'USD')).toBe('USD 100.10');
    });

    it('formats without currency when not provided', () => {
      expect(formatBalance(123.45)).toBe('123.45');
    });

    it('handles zero', () => {
      expect(formatBalance(0, 'CHF')).toBe('CHF 0.00');
    });

    it('handles large numbers', () => {
      expect(formatBalance(123456.78, 'CHF')).toBe('CHF 123456.78');
    });

    it('rounds to 2 decimal places', () => {
      expect(formatBalance(100.999, 'CHF')).toBe('CHF 101.00');
    });
  });

  describe('balancesMatch', () => {
    it('returns true for exact matches', () => {
      expect(balancesMatch('CHF 100.00', 'CHF 100.00')).toBe(true);
    });

    it('returns false for different amounts', () => {
      expect(balancesMatch('CHF 100.00', 'CHF 100.01')).toBe(false);
    });

    it('returns false for small differences', () => {
      expect(balancesMatch('CHF 100.00', 'CHF 99.99')).toBe(false);
    });

    it('handles balances without currency', () => {
      expect(balancesMatch('100.00', '100.00')).toBe(true);
    });

    it('returns false when one cannot be parsed', () => {
      expect(balancesMatch('CHF 100.00', 'invalid')).toBe(false);
    });

    it('returns false when both cannot be parsed', () => {
      expect(balancesMatch('invalid1', 'invalid2')).toBe(false);
    });

    it('throws error for currency mismatch', () => {
      expect(() => {
        balancesMatch('CHF 100.00', 'EUR 100.00');
      }).toThrow('Currency mismatch: CHF vs EUR');
    });

    it('handles zero balances', () => {
      expect(balancesMatch('CHF 0.00', 'CHF 0.00')).toBe(true);
    });

    it('handles negative balances', () => {
      expect(balancesMatch('CHF -50.00', 'CHF -50.00')).toBe(true);
    });

    it('handles one balance with currency, one without', () => {
      expect(balancesMatch('CHF 100.00', '100.00')).toBe(true);
    });

    it('returns false for negative vs positive', () => {
      expect(balancesMatch('CHF -100.00', 'CHF 100.00')).toBe(false);
    });
  });
});
