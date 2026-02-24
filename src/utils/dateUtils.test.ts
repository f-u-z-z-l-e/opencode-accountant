import { describe, it, expect } from 'vitest';
import { formatDateISO, getYesterday, getNextDay } from './dateUtils.ts';

describe('dateUtils', () => {
  describe('formatDateISO', () => {
    it('formats date to YYYY-MM-DD', () => {
      const date = new Date('2024-03-15T10:30:45.123Z');
      expect(formatDateISO(date)).toBe('2024-03-15');
    });

    it('handles different times of day consistently', () => {
      const morning = new Date('2024-03-15T01:00:00Z');
      const evening = new Date('2024-03-15T23:59:59Z');
      expect(formatDateISO(morning)).toBe('2024-03-15');
      expect(formatDateISO(evening)).toBe('2024-03-15');
    });

    it('handles first day of month', () => {
      const date = new Date('2024-03-01T12:00:00Z');
      expect(formatDateISO(date)).toBe('2024-03-01');
    });

    it('handles last day of month', () => {
      const date = new Date('2024-03-31T12:00:00Z');
      expect(formatDateISO(date)).toBe('2024-03-31');
    });

    it('handles first day of year', () => {
      const date = new Date('2024-01-01T12:00:00Z');
      expect(formatDateISO(date)).toBe('2024-01-01');
    });

    it('handles last day of year', () => {
      const date = new Date('2024-12-31T12:00:00Z');
      expect(formatDateISO(date)).toBe('2024-12-31');
    });
  });

  describe('getYesterday', () => {
    it('returns yesterday in YYYY-MM-DD format', () => {
      const result = getYesterday();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns a date that is one day before today', () => {
      const yesterday = getYesterday();
      const today = new Date().toISOString().split('T')[0];

      const yesterdayDate = new Date(yesterday);
      const todayDate = new Date(today);

      const diffInMs = todayDate.getTime() - yesterdayDate.getTime();
      const diffInDays = Math.round(diffInMs / (1000 * 60 * 60 * 24));

      expect(diffInDays).toBe(1);
    });
  });

  describe('getNextDay', () => {
    it('adds one day to given date string', () => {
      expect(getNextDay('2024-03-15')).toBe('2024-03-16');
    });

    it('handles month boundaries correctly', () => {
      expect(getNextDay('2024-03-31')).toBe('2024-04-01');
      expect(getNextDay('2024-04-30')).toBe('2024-05-01');
    });

    it('handles year boundaries correctly', () => {
      expect(getNextDay('2024-12-31')).toBe('2025-01-01');
    });

    it('handles leap year February correctly', () => {
      expect(getNextDay('2024-02-28')).toBe('2024-02-29');
      expect(getNextDay('2024-02-29')).toBe('2024-03-01');
    });

    it('handles non-leap year February correctly', () => {
      expect(getNextDay('2023-02-28')).toBe('2023-03-01');
    });

    it('handles first day of month', () => {
      expect(getNextDay('2024-03-01')).toBe('2024-03-02');
    });

    it('handles mid-month dates', () => {
      expect(getNextDay('2024-06-15')).toBe('2024-06-16');
    });
  });
});
