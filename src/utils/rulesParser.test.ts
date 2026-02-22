import { describe, it, expect } from 'vitest';
import {
  parseSkipRows,
  parseSeparator,
  parseFieldNames,
  parseDateFormat,
  parseDateField,
  parseAmountFields,
  parseRulesFile,
} from './rulesParser.ts';

describe('rulesParser', () => {
  describe('parseSkipRows', () => {
    it('should parse skip directive', () => {
      expect(parseSkipRows('skip 9\nfields date,amount')).toBe(9);
    });

    it('should return 0 when no skip directive', () => {
      expect(parseSkipRows('fields date,amount')).toBe(0);
    });

    it('should handle skip 0', () => {
      expect(parseSkipRows('skip 0')).toBe(0);
    });

    it('should parse skip 1', () => {
      expect(parseSkipRows('skip 1')).toBe(1);
    });
  });

  describe('parseSeparator', () => {
    it('should parse semicolon separator', () => {
      expect(parseSeparator('separator ;')).toBe(';');
    });

    it('should parse comma separator', () => {
      expect(parseSeparator('separator ,')).toBe(',');
    });

    it('should parse tab separator', () => {
      expect(parseSeparator('separator \t')).toBe('\t');
    });

    it('should default to comma when no separator directive', () => {
      expect(parseSeparator('skip 1\nfields date')).toBe(',');
    });
  });

  describe('parseFieldNames', () => {
    it('should parse simple fields list', () => {
      const result = parseFieldNames('fields date, description, amount');
      expect(result).toEqual(['date', 'description', 'amount']);
    });

    it('should parse fields with underscores', () => {
      const result = parseFieldNames('fields trade_date, trade_time, booking_date');
      expect(result).toEqual(['trade_date', 'trade_time', 'booking_date']);
    });

    it('should return empty array when no fields directive', () => {
      expect(parseFieldNames('skip 1')).toEqual([]);
    });

    it('should handle UBS-style field list', () => {
      const content =
        'fields trade_date, trade_time, booking_date, value_date, currency, debit, credit, individual_amount, balance, transaction_no, description1, description2, description3, footnotes';
      const result = parseFieldNames(content);
      expect(result).toHaveLength(14);
      expect(result[0]).toBe('trade_date');
      expect(result[9]).toBe('transaction_no');
      expect(result[10]).toBe('description1');
    });
  });

  describe('parseDateFormat', () => {
    it('should parse date-format directive', () => {
      expect(parseDateFormat('date-format %Y-%m-%d')).toBe('%Y-%m-%d');
    });

    it('should parse European date format', () => {
      expect(parseDateFormat('date-format %d.%m.%Y')).toBe('%d.%m.%Y');
    });

    it('should default to %Y-%m-%d when no directive', () => {
      expect(parseDateFormat('skip 1')).toBe('%Y-%m-%d');
    });
  });

  describe('parseDateField', () => {
    const fieldNames = ['trade_date', 'trade_time', 'booking_date', 'amount'];

    it('should parse date field by name', () => {
      expect(parseDateField('date %trade_date', fieldNames)).toBe('trade_date');
    });

    it('should parse date field by index', () => {
      expect(parseDateField('date %1', fieldNames)).toBe('trade_date');
      expect(parseDateField('date %3', fieldNames)).toBe('booking_date');
    });

    it('should default to first field when no date directive', () => {
      expect(parseDateField('skip 1', fieldNames)).toBe('trade_date');
    });

    it('should default to "date" when no fields and no directive', () => {
      expect(parseDateField('skip 1', [])).toBe('date');
    });
  });

  describe('parseAmountFields', () => {
    const fieldNames = ['date', 'description', 'amount', 'balance'];

    it('should parse simple amount field', () => {
      const result = parseAmountFields('amount %amount', fieldNames);
      expect(result).toEqual({ single: 'amount' });
    });

    it('should parse amount field by index', () => {
      const result = parseAmountFields('amount %3', fieldNames);
      expect(result).toEqual({ single: 'amount' });
    });

    it('should parse separate debit/credit fields', () => {
      const content = `
if %debit .
    amount -%debit
if %credit .
    amount %credit
`;
      const result = parseAmountFields(content, ['date', 'debit', 'credit']);
      expect(result.debit).toBe('debit');
      expect(result.credit).toBe('credit');
      expect(result.single).toBeUndefined();
    });

    it('should default to "amount" when no amount directive', () => {
      const result = parseAmountFields('skip 1', fieldNames);
      expect(result).toEqual({ single: 'amount' });
    });
  });

  describe('parseRulesFile', () => {
    it('should parse complete UBS-style rules file', () => {
      const content = `
# UBS account rules
source ../../doc/agent/todo/import/ubs/chf/transactions.csv

skip 9
fields trade_date, trade_time, booking_date, value_date, currency, debit, credit, individual_amount, balance, transaction_no, description1, description2, description3, footnotes
separator ;

date %trade_date
date-format %Y-%m-%d
currency %currency
description %description1

if %debit .
    amount -%debit
if %credit .
    amount %credit

if SALARY
    account1 income:salary

account2 assets:bank:ubs:checking
`;

      const result = parseRulesFile(content);

      expect(result.skipRows).toBe(9);
      expect(result.separator).toBe(';');
      expect(result.fieldNames).toHaveLength(14);
      expect(result.dateFormat).toBe('%Y-%m-%d');
      expect(result.dateField).toBe('trade_date');
      expect(result.amountFields.debit).toBe('debit');
      expect(result.amountFields.credit).toBe('credit');
    });

    it('should parse simple Revolut-style rules file', () => {
      const content = `
skip 1
fields type, product, started_date, completed_date, description, amount, fee, currency, state, balance

date %3
date-format %Y-%m-%d %H:%M:%S
currency %8
amount -%6
description %5

account2 assets:bank:revolut
`;

      const result = parseRulesFile(content);

      expect(result.skipRows).toBe(1);
      expect(result.separator).toBe(',');
      expect(result.fieldNames).toHaveLength(10);
      expect(result.dateField).toBe('started_date'); // %3 -> index 2
      expect(result.amountFields.single).toBe('amount'); // %6 -> index 5
    });
  });
});
