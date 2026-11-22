import { describe, expect, it } from 'vitest';
import { parseCron, nextRun, previewCron, validateCron } from '../src/cron';

function utc(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0);
}

describe('cron parser', () => {
  it('parses plain fields', () => {
    const f = parseCron('30 2 * * *');
    expect(f.minutes.has(30)).toBe(true);
    expect(f.hours.has(2)).toBe(true);
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(false);
  });

  it('parses steps, ranges and lists', () => {
    const f = parseCron('*/15 0-6,20 1,15 1,6-8 mon-fri');
    expect([...f.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect(f.hours.has(0) && f.hours.has(6) && f.hours.has(20)).toBe(true);
    expect(f.daysOfMonth.has(1) && f.daysOfMonth.has(15)).toBe(true);
    expect(f.months.has(6) && f.months.has(7) && f.months.has(8)).toBe(true);
    expect(f.daysOfWeek.has(1) && f.daysOfWeek.has(5)).toBe(true);
  });

  it('normalizes 7 as sunday', () => {
    const f = parseCron('* * * * 7');
    expect(f.daysOfWeek.has(0)).toBe(true);
  });

  it('rejects malformed expressions', () => {
    expect(validateCron('* * * *')).toMatch(/5 fields/);
    expect(validateCron('61 * * * *')).toMatch(/out of range/);
    expect(validateCron('a * * * *')).toMatch(/invalid cron token/);
    expect(validateCron('5-1 * * * *')).toMatch(/inverted/);
    expect(validateCron('@daily')).toBeNull();
    expect(validateCron('*/10 * * * *')).toBeNull();
  });
});

describe('cron nextRun', () => {
  it('computes the next fixed minute', () => {
    const after = utc(2026, 11, 19, 10, 0);
    expect(nextRun('30 10 * * *', after)).toBe(utc(2026, 11, 19, 10, 30));
  });

  it('rolls to tomorrow when the time passed', () => {
    const after = utc(2026, 11, 19, 10, 31);
    expect(nextRun('30 10 * * *', after)).toBe(utc(2026, 11, 20, 10, 30));
  });

  it('respects day-of-week', () => {
    // 2026-11-19 is a Thursday (dow=4). Next Monday = 2026-11-23.
    const after = utc(2026, 11, 19, 12, 0);
    expect(nextRun('0 9 * * mon', after)).toBe(utc(2026, 11, 23, 9, 0));
  });

  it('handles step expressions', () => {
    const after = utc(2026, 11, 19, 0, 0);
    expect(nextRun('*/15 * * * *', after)).toBe(utc(2026, 11, 19, 0, 15));
    expect(nextRun('*/15 * * * *', utc(2026, 11, 19, 0, 15))).toBe(utc(2026, 11, 19, 0, 30));
  });

  it('handles month boundaries', () => {
    const after = utc(2026, 12, 31, 23, 59);
    expect(nextRun('0 0 1 * *', after)).toBe(utc(2027, 1, 1, 0, 0));
  });

  it('Vixie OR semantics when dom and dow are both restricted', () => {
    // fire on the 1st OR on mondays at 05:00
    const after = utc(2026, 11, 19, 12, 0); // Thursday
    // next: Monday 2026-11-23 05:00 (the 20th/21st/22nd are not the 1st nor Monday)
    expect(nextRun('0 5 1 * 1', after)).toBe(utc(2026, 11, 23, 5, 0));
  });

  it('preview returns N upcoming runs', () => {
    const after = utc(2026, 11, 19, 23, 58);
    const runs = previewCron('0 0 * * *', after, 3) as number[];
    expect(runs).toEqual([utc(2026, 11, 20, 0, 0), utc(2026, 11, 21, 0, 0), utc(2026, 11, 22, 0, 0)]);
  });

  it('named shortcuts work', () => {
    const after = utc(2026, 11, 19, 10, 0);
    expect(nextRun('@hourly', after)).toBe(utc(2026, 11, 19, 11, 0));
  });
});
