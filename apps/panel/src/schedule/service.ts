import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  MAX_SCHEDULES_PER_SERVER,
  isValidTimeZone,
  nextRun,
  scheduleSpecSchema,
  type ScheduleInput,
  type ScheduleSpec,
  type ScheduleView,
} from '@truckpanel/shared';
import type { AgentClient } from '../agent/client.js';
import type { BackupService } from '../backups/service.js';
import { schema, type Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import type { ServerManager } from '../servers/manager.js';

type Row = typeof schema.serverSchedules.$inferSelect;

/**
 * Scheduled restart / update / backup / start / stop (docs/PHASE-7.md §7.5).
 *
 * - A tick every 30 s picks due schedules. The next run is computed before the action runs and
 *   always lies in the future, so missed runs (panel down) are never caught up.
 * - Actions go through ServerManager / BackupService, i.e. the same per-server serialization as
 *   manual actions. A busy server is skipped ("skipped:busy"), never queued.
 * - `update` only runs when Steam has a newer public build than the installed appmanifest
 *   (same check as LinuxGSM, see docs/research).
 */
export class ScheduleService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly manager: ServerManager,
    private readonly backups: BackupService,
    private readonly agent: AgentClient,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(tickMs = 30_000): void {
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.log.warn({ err }, 'schedule tick failed')), tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------- CRUD ----------------

  async list(serverId: string): Promise<ScheduleView[]> {
    const rows = await this.db.select().from(schema.serverSchedules).where(eq(schema.serverSchedules.serverId, serverId)).orderBy(asc(schema.serverSchedules.createdAt));
    return rows.map((r) => this.view(r));
  }

  private view(r: Row): ScheduleView {
    return {
      id: r.id,
      action: r.action,
      spec: r.spec as ScheduleSpec,
      timezone: r.timezone,
      enabled: r.enabled,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastResult: r.lastResult,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private validate(input: ScheduleInput): void {
    if (!isValidTimeZone(input.timezone)) throw new AppError(400, 'schedule.invalid_timezone', `Unknown time zone: ${input.timezone}`);
    scheduleSpecSchema.parse(input.spec);
  }

  async create(serverId: string, input: ScheduleInput, userId: string, ip?: string): Promise<ScheduleView> {
    this.validate(input);
    const [count] = await this.db.select({ n: sql<number>`count(*)::int` }).from(schema.serverSchedules).where(eq(schema.serverSchedules.serverId, serverId));
    if ((count?.n ?? 0) >= MAX_SCHEDULES_PER_SERVER) {
      throw new AppError(409, 'schedule.limit', `A server can have at most ${MAX_SCHEDULES_PER_SERVER} schedules.`);
    }
    const [row] = await this.db
      .insert(schema.serverSchedules)
      .values({
        serverId,
        action: input.action,
        spec: input.spec,
        timezone: input.timezone,
        enabled: input.enabled,
        nextRunAt: input.enabled ? nextRun(input.spec, input.timezone, this.now()) : null,
        createdBy: userId,
      })
      .returning();
    await audit(this.db, { userId, action: 'server.schedule_create', target: `server:${serverId}`, newValue: input, ip });
    return this.view(row!);
  }

  async update(serverId: string, scheduleId: string, input: ScheduleInput, userId: string, ip?: string): Promise<ScheduleView> {
    this.validate(input);
    const before = await this.load(serverId, scheduleId);
    const [row] = await this.db
      .update(schema.serverSchedules)
      .set({
        action: input.action,
        spec: input.spec,
        timezone: input.timezone,
        enabled: input.enabled,
        nextRunAt: input.enabled ? nextRun(input.spec, input.timezone, this.now()) : null,
      })
      .where(eq(schema.serverSchedules.id, scheduleId))
      .returning();
    await audit(this.db, { userId, action: 'server.schedule_update', target: `server:${serverId}`, oldValue: this.view(before), newValue: input, ip });
    return this.view(row!);
  }

  async remove(serverId: string, scheduleId: string, userId: string, ip?: string): Promise<void> {
    const before = await this.load(serverId, scheduleId);
    await this.db.delete(schema.serverSchedules).where(eq(schema.serverSchedules.id, scheduleId));
    await audit(this.db, { userId, action: 'server.schedule_delete', target: `server:${serverId}`, oldValue: this.view(before), ip });
  }

  private async load(serverId: string, scheduleId: string): Promise<Row> {
    const [r] = await this.db
      .select()
      .from(schema.serverSchedules)
      .where(and(eq(schema.serverSchedules.id, scheduleId), eq(schema.serverSchedules.serverId, serverId)))
      .limit(1);
    if (!r) throw new AppError(404, 'not_found', 'Schedule not found.');
    return r;
  }

  // ---------------- runner ----------------

  async tick(): Promise<void> {
    if (this.ticking) return; // a slow tick (SteamCMD build check) must not overlap the next one
    this.ticking = true;
    try {
      const now = this.now();
      const due = await this.db
        .select()
        .from(schema.serverSchedules)
        .where(and(eq(schema.serverSchedules.enabled, true), lte(schema.serverSchedules.nextRunAt, now)))
        .orderBy(asc(schema.serverSchedules.nextRunAt));
      for (const r of due) {
        // Next run first: whatever happens below, this slot is consumed exactly once.
        const next = nextRun(r.spec as ScheduleSpec, r.timezone, now, r.nextRunAt);
        await this.db.update(schema.serverSchedules).set({ nextRunAt: next, lastRunAt: now }).where(eq(schema.serverSchedules.id, r.id));
        const result = await this.run(r).catch((e: unknown) => `failed:${e instanceof AppError ? e.code : 'internal'}`);
        await this.db.update(schema.serverSchedules).set({ lastResult: result }).where(eq(schema.serverSchedules.id, r.id));
        await audit(this.db, { userId: null, action: `server.scheduled_${r.action}`, target: `server:${r.serverId}`, newValue: { schedule: r.id, result } });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async run(r: Row): Promise<string> {
    try {
      switch (r.action) {
        case 'backup':
          await this.backups.create(r.serverId, null, undefined, 'scheduled');
          return 'started';
        case 'update': {
          const server = await this.manager.getServer(r.serverId);
          const [installed, latest] = await Promise.all([this.agent.installedBuild(r.serverId, server.game), this.agent.latestBuild(server.game)]);
          if (!latest) return 'skipped:steam_unavailable';
          if (installed === latest) return 'no-update';
          await this.manager.requestAction(r.serverId, 'update', null);
          return `started:${installed ?? '?'}→${latest}`;
        }
        default:
          await this.manager.requestAction(r.serverId, r.action, null);
          return 'started';
      }
    } catch (e) {
      if (e instanceof AppError && (e.code === 'server.busy' || e.code === 'server.invalid_state' || e.code === 'server.packages_missing')) {
        return `skipped:${e.code.replace('server.', '')}`;
      }
      throw e;
    }
  }
}
