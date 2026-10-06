import { z } from 'zod';

/** Scheduled actions and auto-restart (docs/PHASE-7.md §7.5). */
export const SCHEDULE_ACTIONS = ['restart', 'update', 'backup', 'start', 'stop'] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];
export const MAX_SCHEDULES_PER_SERVER = 10;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Simple forms instead of raw cron: every day, chosen weekdays (0 = Sunday), every N hours. */
export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time }),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time }),
  z.object({ kind: z.literal('interval'), hours: z.number().int().min(1).max(168) }),
]);
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export const scheduleInputSchema = z
  .object({
    action: z.enum(SCHEDULE_ACTIONS),
    spec: scheduleSpecSchema,
    /** IANA time zone, e.g. Europe/Moscow. */
    timezone: z.string().min(1).max(64),
    enabled: z.boolean(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const scheduleViewSchema = scheduleInputSchema.extend({
  id: z.uuid(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  /** started | skipped:<reason> | no-update | failed:<code> */
  lastResult: z.string().nullable(),
  createdAt: z.string(),
});
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

export const autoRestartSchema = z.object({ enabled: z.boolean() }).strict();
export const AUTO_RESTART_MAX = 3;
export const AUTO_RESTART_WINDOW_MIN = 10;

// ---------------- next run (time zones without a library) ----------------

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone. */
function zoned(at: Date, tz: string): { y: number; m: number; d: number; h: number; mi: number; wd: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { y: +parts.year!, m: +parts.month!, d: +parts.day!, h: +parts.hour!, mi: +parts.minute!, wd };
}

/** UTC instant for a wall-clock time in a time zone (DST: a skipped time moves forward). */
function fromZoned(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const z = zoned(new Date(guess), tz);
    const shown = Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi);
    guess += target - shown;
  }
  return new Date(guess);
}

/**
 * Next run strictly after `after`. Missed runs are never caught up: the result is always in the
 * future relative to `after` (docs/PHASE-7.md §7.5). `last` anchors interval schedules.
 */
export function nextRun(spec: ScheduleSpec, tz: string, after: Date, last: Date | null = null): Date {
  if (spec.kind === 'interval') {
    const step = spec.hours * 3600_000;
    let next = (last ?? after).getTime() + step;
    if (next <= after.getTime()) next = after.getTime() + step - ((after.getTime() - next) % step);
    return new Date(next);
  }
  const [hh, mm] = spec.time.split(':').map(Number) as [number, number];
  const start = zoned(after, tz);
  for (let i = 0; i < 9; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const wd = day.getUTCDay();
    if (spec.kind === 'weekly' && !spec.days.includes(wd)) continue;
    const at = fromZoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error('No next run within 9 days');
}
