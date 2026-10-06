import { describe, expect, it } from 'vitest';
import { isValidTimeZone, nextRun } from './schedule.js';

describe('nextRun', () => {
  it('daily in a fixed-offset zone (Moscow, UTC+3)', () => {
    const after = new Date('2026-10-06T10:00:00Z'); // 13:00 in Moscow
    expect(nextRun({ kind: 'daily', time: '05:00' }, 'Europe/Moscow', after).toISOString()).toBe('2026-10-07T02:00:00.000Z');
    expect(nextRun({ kind: 'daily', time: '14:30' }, 'Europe/Moscow', after).toISOString()).toBe('2026-10-06T11:30:00.000Z');
  });

  it('is strictly after `after` (no catch-up, no double run at the same minute)', () => {
    const at = new Date('2026-10-07T02:00:00Z');
    expect(nextRun({ kind: 'daily', time: '05:00' }, 'Europe/Moscow', at).toISOString()).toBe('2026-10-08T02:00:00.000Z');
  });

  it('weekly picks the next listed weekday', () => {
    // 2026-10-06 is a Tuesday.
    const after = new Date('2026-10-06T12:00:00Z');
    const r = nextRun({ kind: 'weekly', days: [0, 6], time: '04:00' }, 'UTC', after);
    expect(r.toISOString()).toBe('2026-10-10T04:00:00.000Z'); // Saturday
  });

  it('handles DST changes (Berlin, last Sunday of October)', () => {
    // 2026-10-25: CEST (UTC+2) → CET (UTC+1) at 03:00.
    const before = new Date('2026-10-24T12:00:00Z');
    expect(nextRun({ kind: 'daily', time: '05:00' }, 'Europe/Berlin', before).toISOString()).toBe('2026-10-25T04:00:00.000Z');
    expect(nextRun({ kind: 'daily', time: '05:00' }, 'Europe/Berlin', new Date('2026-10-23T12:00:00Z')).toISOString()).toBe('2026-10-24T03:00:00.000Z');
  });

  it('interval: every N hours from the last run, skipping missed slots', () => {
    const last = new Date('2026-10-06T00:00:00Z');
    expect(nextRun({ kind: 'interval', hours: 6 }, 'UTC', new Date('2026-10-06T01:00:00Z'), last).toISOString()).toBe('2026-10-06T06:00:00.000Z');
    // The panel was down for a day: the next slot is in the future, not a burst of missed runs.
    expect(nextRun({ kind: 'interval', hours: 6 }, 'UTC', new Date('2026-10-07T13:00:00Z'), last).toISOString()).toBe('2026-10-07T18:00:00.000Z');
  });

  it('validates time zones', () => {
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
