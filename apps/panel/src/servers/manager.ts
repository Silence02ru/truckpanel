import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  MAX_PLAYERS,
  SERVER_CONFIG_DEFAULTS,
  SERVER_PERMISSIONS,
  AUTO_RESTART_MAX,
  AUTO_RESTART_WINDOW_MIN,
  type Role,
  type ServerAccess,
  type ErrorCode,
  type QueryInfo,
  type ServerAction,
  type ServerConfigValues,
  type ServerDetail,
  type ServerPorts,
  type ServerState,
  type ServerSummary,
  type PackagesInfo,
  type PackagesView,
  type StartSpec,
  type Task,
  type TaskKind,
} from '@truckpanel/shared';
import { AgentError, AgentUnavailableError, type AgentClient } from '../agent/client.js';
import { schema, type Db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { SecretBox, secretFingerprint } from '../lib/secrets.js';
import { ConfigService } from './config-service.js';
import type { FetchFn } from './steam.js';
import type { LiveBus } from '../live/bus.js';
import { AppError } from '../lib/errors.js';
import { renderServerConfig, setCfgVar } from './config.js';
import { NoFreePortsError, allocatePorts, portsFromRows } from './ports.js';
import { checkQuota } from '../users/quota.js';
import { describePackages } from './packages.js';

type ServerRow = typeof schema.servers.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;

/** Printed by the DS when server_packages.sii/.dat are missing; it then exits with code 0. */
const PACKAGES_MISSING_MARKER = 'Server packages file not found';
const LOG_KEEP_LINES = 300;

/**
 * SteamCMD lines that are harmless inside the container and only hide the real error:
 * it tries to lock DMI hardware info in /sys (read-only for an unprivileged container, errno 13).
 */
const LOG_NOISE_RE = /^flock \/sys\/devices\/virtual\/dmi\/id\/\S+ LOCK_SH failed\. errno = 13$/;

const INTERRUPTED_MESSAGE =
  'The connection to the agent was lost while the task was running (for example, the panel was being updated). Start it again: SteamCMD continues the download where it stopped.';

/** Splits agent output into lines; SteamCMD sometimes glues lines with \r or without a newline after "errno = 13". */
export function splitLogLines(raw: string): string[] {
  return raw
    .replace(/(errno = \d+)(?=\S)/g, '$1\n')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && !LOG_NOISE_RE.test(l));
}

/** Last lines worth showing in a failure message: no noise, no progress spam. */
export function meaningfulTail(lines: string[], n = 5): string[] {
  return lines.filter((l) => !LOG_NOISE_RE.test(l) && !/^Update state \(0x[0-9a-f]+\)/i.test(l) && !l.startsWith('ERROR: ')).slice(-n);
}
const EXIT_LOG_LINES = 1000;

/** Which actions are valid from which state (SPEC.md server state machine). */
const ALLOWED_FROM: Record<ServerAction, readonly ServerState[]> = {
  install: ['NEW', 'ERROR', 'STOPPED', 'AWAITING_PACKAGES', 'UNKNOWN'],
  update: ['STOPPED', 'AWAITING_PACKAGES', 'ONLINE', 'STARTING', 'ERROR', 'UNKNOWN'],
  start: ['STOPPED', 'ERROR', 'UNKNOWN'],
  stop: ['ONLINE', 'STARTING', 'ERROR', 'UNKNOWN'],
  restart: ['ONLINE', 'STARTING', 'ERROR', 'UNKNOWN'],
  kill: ['ONLINE', 'STARTING', 'STOPPING', 'ERROR', 'UNKNOWN'],
};

/** Error raised inside a task: carries a UI error code and a human-readable detail. */
class TaskError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly serverState: ServerState = 'ERROR',
  ) {
    super(message);
  }
}

export interface ManagerOptions {
  /** ENCRYPTION_KEY (base64, 32 bytes) for secrets at rest such as logon tokens. */
  encryptionKey: string;
  /** How long a start waits for the A2S answer before handing over to the reconciler. */
  startTimeoutMs?: number;
  pollMs?: number;
  reconcileMs?: number;
  /** Injected in tests; defaults to global fetch (Steam profile lookups only). */
  fetchFn?: FetchFn;
  /** Live event bus for WebSocket clients (phase 5); optional in tests. */
  bus?: LiveBus;
}

/** Printed by the DS after login, e.g. "[MP] Session search id: 90294179854447616/101" (VPS, DS 1.61). */
const SEARCH_ID_RE = /\[MP\] Session search id:\s*(\S+)/g;

export function parseSearchId(log: string): string | null {
  let last: string | null = null;
  for (const m of log.matchAll(SEARCH_ID_RE)) last = m[1]!;
  return last;
}

export class ServerManager {
  private readonly active = new Map<string, Promise<void>>();
  /** Task kinds implemented outside the manager (backups); see registerTask(). */
  private readonly handlers = new Map<TaskKind, TaskHandler>();
  /** Recent auto-restart times per server (in memory: a panel restart resets the window). */
  private readonly autoRestarts = new Map<string, number[]>();
  private readonly queryCache = new Map<string, QueryInfo | null>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly startTimeoutMs: number;
  private readonly pollMs: number;
  private readonly reconcileMs: number;
  private readonly secrets: SecretBox;
  readonly config: ConfigService;
  private readonly bus: LiveBus | null;
  private readonly encryptionKey: string;

  constructor(
    private readonly db: Db,
    private readonly agent: AgentClient,
    private readonly log: FastifyBaseLogger,
    opts: ManagerOptions,
  ) {
    this.encryptionKey = opts.encryptionKey;
    this.secrets = new SecretBox(opts.encryptionKey);
    this.config = new ConfigService(db, this.secrets, opts.fetchFn ?? (fetch as unknown as FetchFn));
    this.bus = opts.bus ?? null;
    this.startTimeoutMs = opts.startTimeoutMs ?? 180_000;
    this.pollMs = opts.pollMs ?? 3_000;
    this.reconcileMs = opts.reconcileMs ?? 10_000;
  }

  // ---------------------------------------------------------------- queries

  private async loadServer(id: string): Promise<ServerRow> {
    const [row] = await this.db.select().from(schema.servers).where(eq(schema.servers.id, id)).limit(1);
    if (!row) throw new AppError(404, 'not_found', 'Server not found.');
    return row;
  }

  private async loadPorts(id: string): Promise<ServerPorts> {
    const rows = await this.db.select().from(schema.serverPorts).where(eq(schema.serverPorts.serverId, id));
    return portsFromRows(rows);
  }

  private async activeTask(serverId: string): Promise<TaskRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.serverId, serverId), inArray(schema.tasks.state, ['queued', 'running'])))
      .orderBy(desc(schema.tasks.createdAt))
      .limit(1);
    return row ?? null;
  }

  toTask(row: TaskRow): Task {
    return {
      id: row.id,
      serverId: row.serverId,
      kind: row.kind,
      state: row.state,
      progress: row.progress,
      stage: row.stage,
      message: row.message,
      code: row.code,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }

  /** Owner of every server (one owner per server, see server_members). */
  private async owners(ids?: string[]): Promise<Map<string, { id: string; username: string }>> {
    const rows = await this.db
      .select({ serverId: schema.serverMembers.serverId, id: schema.users.id, username: schema.users.username })
      .from(schema.serverMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.serverMembers.userId))
      .where(
        ids
          ? and(eq(schema.serverMembers.role, 'owner'), inArray(schema.serverMembers.serverId, ids))
          : eq(schema.serverMembers.role, 'owner'),
      );
    return new Map(rows.map((r) => [r.serverId, { id: r.id, username: r.username }]));
  }

  /**
   * Summaries carry administrator access; routes and the WebSocket hub replace `access` with the
   * caller's own (see auth/access.ts).
   */
  async listServers(): Promise<ServerSummary[]> {
    const rows = await this.db.select().from(schema.servers).orderBy(asc(schema.servers.createdAt));
    const owners = await this.owners();
    const portRows = await this.db.select().from(schema.serverPorts);
    const taskRows = await this.db
      .select()
      .from(schema.tasks)
      .where(inArray(schema.tasks.state, ['queued', 'running']));
    return rows.map((s) =>
      this.summary(s, portsFromRows(portRows.filter((p) => p.serverId === s.id)), taskRows.find((t) => t.serverId === s.id) ?? null, owners.get(s.id) ?? null),
    );
  }

  private summary(s: ServerRow, ports: ServerPorts, task: TaskRow | null, owner: { id: string; username: string } | null): ServerSummary {
    const q = this.queryCache.get(s.id) ?? null;
    return {
      id: s.id,
      name: s.name,
      game: s.game,
      state: s.state,
      ports,
      maxPlayers: MAX_PLAYERS,
      players: s.state === 'ONLINE' && q ? q.players : null,
      packages: { sii: s.hasPackagesSii, dat: s.hasPackagesDat },
      lastError: s.lastError,
      activeTask: task ? this.toTask(task) : null,
      sessionSearchId: s.sessionSearchId,
      logonTokenSet: Boolean(s.logonTokenEnc),
      restartRequired: s.pendingRestart && (s.state === 'ONLINE' || s.state === 'STARTING'),
      owner,
      autoRestart: s.autoRestart,
      memoryMb: s.memoryMb,
      cpus: s.cpus,
      access: ADMIN_ACCESS,
    };
  }

  async getServer(id: string): Promise<ServerDetail> {
    const s = await this.loadServer(id);
    const [ports, task] = await Promise.all([this.loadPorts(id), this.activeTask(id)]);
    let container = null;
    try {
      container = await this.agent.state(id);
    } catch {
      container = null;
    }
    const owner = (await this.owners([id])).get(id) ?? null;
    return {
      ...this.summary(s, ports, task, owner),
      container,
      query: this.queryCache.get(id) ?? null,
      memoryMb: s.memoryMb,
      cpus: s.cpus,
      createdAt: s.createdAt.toISOString(),
      gameVersion: s.gameVersion,
    };
  }

  async listTasks(serverId: string, limit = 20): Promise<Task[]> {
    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.serverId, serverId))
      .orderBy(desc(schema.tasks.createdAt))
      .limit(limit);
    return rows.map((r) => this.toTask(r));
  }

  async getTask(id: string): Promise<Task & { log: string }> {
    const [row] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    if (!row) throw new AppError(404, 'not_found', 'Task not found.');
    return { ...this.toTask(row), log: row.log };
  }

  /** Server of a task, for access checks on /api/tasks/:id (null for unknown tasks → 404). */
  async taskServerId(taskId: string): Promise<string | null> {
    const [row] = await this.db.select({ serverId: schema.tasks.serverId }).from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
    return row?.serverId ?? null;
  }

  async logs(id: string, tail = 300): Promise<string> {
    await this.loadServer(id);
    try {
      return await this.agent.logs(id, tail);
    } catch (e) {
      throw agentAppError(e);
    }
  }

  // ---------------------------------------------------------------- create / delete

  async createServer(
    input: { name: string; game: 'ets2' | 'ats' },
    user: { id: string; role: Role },
    ip?: string,
  ): Promise<{ server: ServerSummary; task: Task }> {
    const userId = user.id;
    let host;
    try {
      host = await this.agent.hostPorts();
    } catch (e) {
      throw agentAppError(e);
    }
    let serverId: string;
    try {
      serverId = await this.db.transaction(async (tx) => {
        if (user.role !== 'administrator') await checkQuota(tx, userId);
        const [server] = await tx.insert(schema.servers).values({ name: input.name, game: input.game }).returning();
        await tx.insert(schema.serverMembers).values({ serverId: server!.id, userId, role: 'owner', addedBy: userId });
        await allocatePorts(tx, server!.id, host);
        await tx.insert(schema.serverConfigs).values({
          serverId: server!.id,
          version: 1,
          values: { ...SERVER_CONFIG_DEFAULTS, lobby_name: input.name },
          createdBy: userId,
        });
        return server!.id;
      });
    } catch (e) {
      if (e instanceof NoFreePortsError) throw new AppError(409, 'server.no_free_ports', 'No free ports left for a new server.');
      if (isUniqueViolation(e, 'servers_name_lower_uq')) throw new AppError(409, 'server.name_taken', 'A server with this name already exists.');
      throw e;
    }
    await audit(this.db, { userId, action: 'server.create', target: `server:${serverId}`, newValue: input, ip });
    const task = await this.enqueue(serverId, 'install', userId, ip);
    const server = (await this.listServers()).find((s) => s.id === serverId)!;
    return { server, task };
  }

  async deleteServer(id: string, userId: string, ip?: string): Promise<void> {
    const s = await this.loadServer(id);
    if (this.active.has(id) || (await this.activeTask(id))) {
      throw new AppError(409, 'server.busy', 'Another operation is running on this server. Wait for it to finish.');
    }
    try {
      await this.agent.remove(id, true);
    } catch (e) {
      throw agentAppError(e);
    }
    await this.db.delete(schema.servers).where(eq(schema.servers.id, id)); // ports/configs cascade
    this.bus?.publish({ event: 'server.removed', serverId: id, data: null });
    this.queryCache.delete(id);
    await audit(this.db, { userId, action: 'server.delete', target: `server:${id}`, oldValue: { name: s.name, game: s.game }, ip });
  }

  // ---------------------------------------------------------------- packages

  async uploadPackages(id: string, files: { sii?: Buffer; dat?: Buffer }, userId: string, ip?: string): Promise<ServerSummary> {
    const s = await this.loadServer(id);
    if (s.state === 'INSTALLING' || s.state === 'UPDATING') {
      throw new AppError(409, 'server.busy', 'Wait until the installation finishes.');
    }
    // Parsed, not just sniffed: a broken export would only fail when the server starts.
    const info = files.sii ? describePackages(files.sii) : null;
    if (files.dat && files.dat.length === 0) {
      throw new AppError(400, 'server.packages_invalid', 'server_packages.dat is empty.');
    }
    try {
      // Keep the pair that is being replaced (history of PACKAGE_HISTORY_KEEP versions, §7.3).
      if (s.hasPackagesSii && s.hasPackagesDat) await this.agent.snapshotPackages(id, s.game);
      if (files.sii) await this.agent.writeFile(id, s.game, 'server_packages.sii', files.sii);
      if (files.dat) await this.agent.writeFile(id, s.game, 'server_packages.dat', files.dat);
    } catch (e) {
      throw agentAppError(e);
    }
    const hasSii = s.hasPackagesSii || Boolean(files.sii);
    const hasDat = s.hasPackagesDat || Boolean(files.dat);
    const nextState: ServerState = s.state === 'AWAITING_PACKAGES' && hasSii && hasDat ? 'STOPPED' : s.state;
    await this.db
      .update(schema.servers)
      .set({
        hasPackagesSii: hasSii,
        hasPackagesDat: hasDat,
        state: nextState,
        lastError: null,
        lastErrorCode: null,
        // The DS reads server_packages when it starts: a running server needs a restart.
        pendingRestart: s.pendingRestart || s.state === 'ONLINE' || s.state === 'STARTING',
        updatedAt: new Date(),
      })
      .where(eq(schema.servers.id, id));
    await audit(this.db, {
      userId,
      action: 'server.packages_upload',
      target: `server:${id}`,
      newValue: { sii: files.sii?.length ?? null, dat: files.dat?.length ?? null, ...(info ?? {}) },
      ip,
    });
    await this.publishStatus(id);
    return (await this.listServers()).find((x) => x.id === id)!;
  }

  /** Current pair (size, sha256, what it contains, who uploaded it) and the stored history. */
  async packagesView(id: string): Promise<PackagesView> {
    const s = await this.loadServer(id);
    let sii, dat, history, siiBuf;
    try {
      [sii, dat, history, siiBuf] = await Promise.all([
        this.agent.statFile(id, s.game, 'server_packages.sii'),
        this.agent.statFile(id, s.game, 'server_packages.dat'),
        this.agent.packageHistory(id, s.game),
        this.agent.readFile(id, s.game, 'server_packages.sii'),
      ]);
    } catch (e) {
      throw agentAppError(e);
    }
    let info: PackagesInfo | null = null;
    try {
      info = siiBuf ? describePackages(siiBuf) : null;
    } catch {
      info = null;
    }
    const [last] = await this.db
      .select({ ts: schema.auditLogs.ts, username: schema.users.username })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId))
      .where(and(eq(schema.auditLogs.target, `server:${id}`), inArray(schema.auditLogs.action, ['server.packages_upload', 'server.packages_restore'])))
      .orderBy(desc(schema.auditLogs.ts))
      .limit(1);
    return {
      current: { sii, dat, info, uploadedBy: last?.username ?? null, uploadedAt: last?.ts.toISOString() ?? null },
      history,
    };
  }

  /** Current server_packages file for download (server.files). */
  async packageFile(id: string, file: 'server_packages.sii' | 'server_packages.dat'): Promise<Buffer> {
    const s = await this.loadServer(id);
    let buf: Buffer | null;
    try {
      buf = await this.agent.readFile(id, s.game, file);
    } catch (e) {
      throw agentAppError(e);
    }
    if (!buf) throw new AppError(404, 'not_found', 'The file has not been uploaded yet.');
    return buf;
  }

  /** Rollback: the current pair goes to the history, the chosen one becomes current. */
  async restorePackages(id: string, version: string, userId: string, ip?: string): Promise<ServerSummary> {
    const s = await this.loadServer(id);
    if (s.state === 'INSTALLING' || s.state === 'UPDATING') {
      throw new AppError(409, 'server.busy', 'Wait until the installation finishes.');
    }
    let restored: boolean;
    try {
      if (s.hasPackagesSii && s.hasPackagesDat) await this.agent.snapshotPackages(id, s.game);
      restored = await this.agent.restorePackages(id, s.game, version);
    } catch (e) {
      throw agentAppError(e);
    }
    if (!restored) throw new AppError(404, 'not_found', 'This version is no longer stored.');
    await this.db
      .update(schema.servers)
      .set({
        hasPackagesSii: true,
        hasPackagesDat: true,
        state: s.state === 'AWAITING_PACKAGES' ? 'STOPPED' : s.state,
        pendingRestart: s.pendingRestart || s.state === 'ONLINE' || s.state === 'STARTING',
        updatedAt: new Date(),
      })
      .where(eq(schema.servers.id, id));
    await audit(this.db, { userId, action: 'server.packages_restore', target: `server:${id}`, newValue: { version }, ip });
    await this.publishStatus(id);
    return (await this.listServers()).find((x) => x.id === id)!;
  }

  // ---------------------------------------------------------------- logon token & search id

  /**
   * Sets or clears the Steam logon token. With a token the DS logs in with a persistent game
   * server account, so its session search id stays the same across restarts (SCS wiki).
   * The token is encrypted at rest and never returned; equal tokens on two servers are refused
   * (SCS: "ports and logon token must be different for each session instance").
   */
  async setLogonToken(id: string, token: string | null, userId: string, ip?: string): Promise<ServerSummary> {
    await this.loadServer(id); // 404 for unknown ids
    const values = token
      ? { logonTokenEnc: this.secrets.seal(token), logonTokenHash: secretFingerprint(this.encryptionKey, token) }
      : { logonTokenEnc: null, logonTokenHash: null };
    try {
      // The search id belongs to the old account; it changes on the next start.
      await this.setServer(id, { ...values, sessionSearchId: null, pendingRestart: true });
    } catch (e) {
      if (isUniqueViolation(e, 'servers_logon_token_hash_uq')) {
        throw new AppError(409, 'server.token_in_use', 'This logon token is already used by another server. Create a separate token for each server.');
      }
      throw e;
    }
    await audit(this.db, {
      userId,
      action: token ? 'server.logon_token_set' : 'server.logon_token_cleared',
      target: `server:${id}`,
      ip, // the token itself is never written to the audit log
    });
    return (await this.listServers()).find((x) => x.id === id)!;
  }

  private async captureSearchId(id: string): Promise<void> {
    const text = await this.agent.logs(id, EXIT_LOG_LINES).catch(() => '');
    const searchId = parseSearchId(text);
    if (searchId) await this.setServer(id, { sessionSearchId: searchId });
  }

  // ---------------------------------------------------------------- actions & tasks

  /** userId null = the panel itself (scheduler, auto-restart). */
  async requestAction(id: string, action: ServerAction, userId: string | null, ip?: string): Promise<Task> {
    const s = await this.loadServer(id);
    // "Busy" first: during a running task the state is transitional and would otherwise
    // produce a less helpful "invalid state" error.
    if (this.active.has(id) || (await this.activeTask(id))) {
      throw new AppError(409, 'server.busy', 'Another operation is already running on this server.');
    }
    if (action === 'start' && (!s.hasPackagesSii || !s.hasPackagesDat || s.state === 'AWAITING_PACKAGES')) {
      throw new AppError(409, 'server.packages_missing', 'Upload server_packages.sii and server_packages.dat before starting.');
    }
    if (!ALLOWED_FROM[action].includes(s.state)) {
      throw new AppError(409, 'server.invalid_state', `Cannot ${action} while the server is ${s.state}.`);
    }
    if ((action === 'start' || action === 'restart') && !s.installedAt) {
      throw new AppError(409, 'server.invalid_state', 'The game server is not installed yet.');
    }
    return this.enqueue(id, action, userId, ip);
  }

  /** Background task with the same per-server serialization as lifecycle actions. */
  async runTask(serverId: string, kind: TaskKind, userId: string | null, ip?: string, params?: Record<string, unknown>): Promise<Task> {
    await this.loadServer(serverId);
    return this.enqueue(serverId, kind, userId, ip, params);
  }

  /** For services that store data through the agent (backups). */
  get agentClient(): AgentClient {
    return this.agent;
  }

  registerTask(kind: TaskKind, handler: TaskHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Stops a running server for maintenance (restore); returns whether it was running. */
  async maintenanceStop(id: string, ctx: TaskContext): Promise<boolean> {
    const s = await this.loadServer(id);
    const running = s.state === 'ONLINE' || s.state === 'STARTING';
    if (running) await this.doStop(id, ctx);
    return running;
  }

  async maintenanceStart(id: string, ctx: TaskContext): Promise<string> {
    return this.doStart(id, ctx);
  }

  private async enqueue(serverId: string, kind: TaskKind, userId: string | null, ip?: string, params?: Record<string, unknown>): Promise<Task> {
    // In-process map: one panel instance per host. The DB check also covers tasks
    // left "queued/running" by a previous process (recover() fails them on boot).
    const running = await this.activeTask(serverId);
    if (this.active.has(serverId) || running) {
      throw new AppError(409, 'server.busy', 'Another operation is already running on this server.');
    }
    const [task] = await this.db.insert(schema.tasks).values({ serverId, kind, createdBy: userId, params: params ?? null }).returning();
    await audit(this.db, { userId, action: `server.${kind}`, target: `server:${serverId}`, newValue: { task: task!.id }, ip });
    const run = this.execute(task!).finally(() => this.active.delete(serverId));
    this.active.set(serverId, run);
    return this.toTask(task!);
  }

  /** For tests and graceful shutdown. */
  async idle(): Promise<void> {
    await Promise.all([...this.active.values()]);
  }

  private async setServer(id: string, values: Partial<typeof schema.servers.$inferInsert>): Promise<void> {
    await this.db.update(schema.servers).set({ ...values, updatedAt: new Date() }).where(eq(schema.servers.id, id));
    await this.publishStatus(id);
  }

  /** Pushes the current summary to WebSocket clients (REST stays the source of truth). */
  private async publishStatus(id: string): Promise<void> {
    if (!this.bus) return;
    const summary = (await this.listServers()).find((s) => s.id === id);
    if (summary) this.bus.publish({ event: 'server.status', serverId: id, data: summary });
  }

  private async publishTask(taskId: string): Promise<void> {
    if (!this.bus) return;
    const [row] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
    if (row?.serverId) this.bus.publish({ event: 'task.progress', serverId: row.serverId, data: this.toTask(row) });
  }

  private async execute(task: TaskRow): Promise<void> {
    const id = task.serverId!;
    const logLines: string[] = [];
    let lastFlush = 0;
    let progress = 0;
    let stage: string | null = null;
    const flush = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastFlush < 1000) return;
      lastFlush = now;
      await this.db
        .update(schema.tasks)
        .set({ progress: Math.round(progress), stage, log: logLines.slice(-LOG_KEEP_LINES).join('\n') })
        .where(eq(schema.tasks.id, task.id));
      await this.publishTask(task.id);
    };
    const ctx: TaskContext = {
      progress: async (p, s) => {
        progress = p;
        stage = s;
        await flush(false);
      },
      log: (raw) => {
        for (const line of splitLogLines(raw)) {
          if (line === logLines[logLines.length - 1]) continue; // repeated progress lines
          logLines.push(line);
        }
        if (logLines.length > LOG_KEEP_LINES * 2) logLines.splice(0, logLines.length - LOG_KEEP_LINES);
      },
    };

    await this.db.update(schema.tasks).set({ state: 'running', startedAt: new Date() }).where(eq(schema.tasks.id, task.id));
    try {
      const message = await this.runKind(task.kind, id, ctx, task);
      progress = 100;
      await flush(true);
      await this.db
        .update(schema.tasks)
        .set({ state: 'succeeded', progress: 100, message, finishedAt: new Date() })
        .where(eq(schema.tasks.id, task.id));
      await this.publishTask(task.id);
    } catch (e) {
      const err = toTaskError(e);
      ctx.log(`ERROR: ${err.message}`);
      await flush(true);
      await this.db
        .update(schema.tasks)
        .set({ state: 'failed', message: err.message, code: err.code, finishedAt: new Date() })
        .where(eq(schema.tasks.id, task.id));
      await this.publishTask(task.id);
      try {
        await this.setServer(id, { state: err.serverState, lastError: err.message, lastErrorCode: err.code });
      } catch {
        // server row deleted meanwhile
      }
      this.log.warn({ task: task.id, server: id, kind: task.kind, code: err.code }, 'task failed');
    }
  }

  private async runKind(kind: TaskKind, id: string, ctx: TaskContext, task: TaskRow): Promise<string> {
    const handler = this.handlers.get(kind);
    if (handler) return handler({ id: task.id, serverId: id, params: (task.params ?? {}) as Record<string, unknown>, createdBy: task.createdBy }, ctx);
    switch (kind) {
      case 'install':
      case 'update':
        return this.doInstall(id, kind, ctx);
      case 'start':
        return this.doStart(id, ctx);
      case 'stop':
        await this.doStop(id, ctx);
        return 'stopped';
      case 'restart':
        await this.doStop(id, ctx);
        return this.doStart(id, ctx);
      case 'kill':
        await this.agentCall(() => this.agent.kill(id));
        await this.setServer(id, { state: 'STOPPED', desiredRunning: false, lastError: null, lastErrorCode: null });
        this.queryCache.delete(id);
        return 'killed';
      case 'delete':
      case 'backup':
      case 'restore':
        throw new TaskError('server.invalid_state', `${kind} is not handled by the server manager.`);
    }
  }

  private async agentCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AgentUnavailableError) throw new TaskError('agent.unavailable', e.message, 'UNKNOWN');
      if (e instanceof AgentError && e.status === 409) {
        // Docker refused to bind: something grabbed the port between our check and the start.
        throw new TaskError('server.port_in_use', 'A server port is already in use on the host. Stop the other program or recreate the server.');
      }
      if (e instanceof AgentError) throw new TaskError('agent.failed', e.message);
      throw e;
    }
  }

  private async doInstall(id: string, kind: 'install' | 'update', ctx: TaskContext): Promise<string> {
    const s = await this.loadServer(id);
    const wasRunning = s.state === 'ONLINE' || s.state === 'STARTING';
    if (wasRunning) {
      await ctx.progress(0, 'stopping');
      await this.doStop(id, ctx);
    }
    await this.setServer(id, { state: kind === 'install' ? 'INSTALLING' : 'UPDATING', lastError: null, lastErrorCode: null });
    await ctx.progress(0, 'starting SteamCMD');

    const recent: string[] = [];
    const done = await this.agentCall(() =>
      this.agent.install(id, s.game, (e) => {
        if (e.type === 'progress') void ctx.progress(e.percent, e.stage);
        else if (e.type === 'log') {
          ctx.log(e.line);
          recent.push(...splitLogLines(e.line));
          if (recent.length > 200) recent.splice(0, recent.length - 100);
        }
      }),
    );
    if (!done.ok) {
      const tail = meaningfulTail(recent);
      throw new TaskError('steamcmd.failed', [`SteamCMD could not install the game server: ${done.message}`, ...tail].join('\n'));
    }
    const [sii, dat] = await this.agentCall(() =>
      Promise.all([this.agent.statFile(id, s.game, 'server_packages.sii'), this.agent.statFile(id, s.game, 'server_packages.dat')]),
    );
    const ready = sii.exists && dat.exists;
    await this.setServer(id, {
      installedAt: new Date(),
      hasPackagesSii: sii.exists,
      hasPackagesDat: dat.exists,
      state: ready ? 'STOPPED' : 'AWAITING_PACKAGES',
    });
    if (wasRunning && ready) return this.doStart(id, ctx);
    return ready ? 'installed' : 'installed; waiting for server_packages';
  }

  private async doStart(id: string, ctx: TaskContext): Promise<string> {
    const s = await this.loadServer(id);
    if (!s.hasPackagesSii || !s.hasPackagesDat) {
      throw new TaskError('server.packages_missing', 'server_packages.sii/.dat are missing.', 'AWAITING_PACKAGES');
    }
    const ports = await this.loadPorts(id);
    // The token never lives in server_configs.values; it is decrypted only for rendering.
    const values = { ...(await this.config.renderValues(id)), server_logon_token: s.logonTokenEnc ? this.secrets.open(s.logonTokenEnc) : '' };

    await ctx.progress(10, 'writing configuration');
    let configText: string;
    try {
      configText = renderServerConfig(values, ports);
    } catch (e) {
      // Rendering failed: the current file on disk is left untouched (CLAUDE.md §13).
      throw new TaskError('agent.failed', `Could not render server_config.sii: ${(e as Error).message}`);
    }
    await this.agentCall(async () => {
      await this.agent.writeFile(id, s.game, 'server_config.sii', Buffer.from(configText, 'utf8'));
      const cfg = await this.agent.readFile(id, s.game, 'config_ds.cfg');
      const next = setCfgVar(cfg?.toString('utf8') ?? null, 'g_max_convoy_size', String(MAX_PLAYERS));
      await this.agent.writeFile(id, s.game, 'config_ds.cfg', Buffer.from(next, 'utf8'));
    });

    await ctx.progress(20, 'checking ports');
    const [container, host] = await this.agentCall(() => Promise.all([this.agent.state(id), this.agent.hostPorts()]));
    if (container.status !== 'running') {
      const busy = [ports.connection, ports.query].filter((p) => host.tcp.includes(p) || host.udp.includes(p));
      if (busy.length) {
        throw new TaskError('server.port_in_use', `Port ${busy.join(', ')} is already used by another program on this host.`);
      }
    }

    await ctx.progress(30, 'starting container');
    const spec: StartSpec = {
      game: s.game,
      ports: { connection: ports.connection, query: ports.query },
      memoryMb: s.memoryMb,
      cpus: s.cpus,
    };
    await this.agentCall(() => this.agent.start(id, spec));
    await this.setServer(id, { state: 'STARTING', desiredRunning: true, pendingRestart: false, lastError: null, lastErrorCode: null });

    await ctx.progress(40, 'waiting for the server to answer');
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      const st = await this.agentCall(() => this.agent.state(id));
      if (st.status !== 'running') {
        await this.handleExited(id, st.exitCode);
        const fresh = await this.loadServer(id);
        throw new TaskError((fresh.lastErrorCode as ErrorCode) ?? 'agent.failed', fresh.lastError ?? 'Server stopped.', fresh.state);
      }
      const info = await this.agent.query(id).catch(() => null);
      if (info) {
        this.queryCache.set(id, info);
        await this.setServer(id, { state: 'ONLINE' });
        await this.captureSearchId(id);
        return 'online';
      }
    }
    // Container runs but A2S has not answered yet; the reconciler keeps checking.
    return 'started; waiting for the query port to answer';
  }

  private async doStop(id: string, ctx: TaskContext): Promise<void> {
    await this.setServer(id, { state: 'STOPPING', desiredRunning: false });
    await ctx.progress(50, 'stopping');
    await this.agentCall(() => this.agent.stop(id, 30));
    this.queryCache.delete(id);
    await this.setServer(id, { state: 'STOPPED', lastError: null, lastErrorCode: null });
  }

  /**
   * Auto-restart after a crash (docs/PHASE-7.md §7.5): at most AUTO_RESTART_MAX starts within
   * AUTO_RESTART_WINDOW_MIN minutes, then the server stays in ERROR so a crash loop cannot
   * hammer the host. Missing server_packages are never retried (handleExited stops that).
   */
  private async maybeAutoRestart(id: string): Promise<void> {
    const s = await this.loadServer(id);
    if (!s.autoRestart || s.state !== 'ERROR') return;
    const now = Date.now();
    const recent = (this.autoRestarts.get(id) ?? []).filter((t) => now - t < AUTO_RESTART_WINDOW_MIN * 60_000);
    if (recent.length >= AUTO_RESTART_MAX) {
      this.autoRestarts.set(id, recent);
      await this.setServer(id, {
        lastError: `${s.lastError ?? ''}\nAuto-restart stopped after ${AUTO_RESTART_MAX} attempts in ${AUTO_RESTART_WINDOW_MIN} minutes. Check the console and start the server manually.`.trim(),
      });
      await audit(this.db, { userId: null, action: 'server.auto_restart_gave_up', target: `server:${id}` });
      return;
    }
    recent.push(now);
    this.autoRestarts.set(id, recent);
    try {
      await this.requestAction(id, 'start', null);
      await audit(this.db, { userId: null, action: 'server.auto_restart', target: `server:${id}`, newValue: { attempt: recent.length } });
    } catch (e) {
      this.log.warn({ err: e, server: id }, 'auto-restart could not start the server');
    }
  }

  async setAutoRestart(id: string, enabled: boolean, userId: string, ip?: string): Promise<ServerSummary> {
    await this.loadServer(id);
    await this.db.update(schema.servers).set({ autoRestart: enabled, updatedAt: new Date() }).where(eq(schema.servers.id, id));
    this.autoRestarts.delete(id);
    await audit(this.db, { userId, action: 'server.auto_restart_set', target: `server:${id}`, newValue: { enabled }, ip });
    await this.publishStatus(id);
    return (await this.listServers()).find((x) => x.id === id)!;
  }

  /** Classifies a container that exited on its own. */
  private async handleExited(id: string, exitCode: number | null): Promise<void> {
    // The DS prints the packages error FIRST and then ~80 shutdown lines (VPS, DS 1.61),
    // so read the whole short log, not just its tail.
    const text = await this.agent.logs(id, EXIT_LOG_LINES).catch(() => '');
    this.queryCache.delete(id);
    if (text.includes(PACKAGES_MISSING_MARKER)) {
      await this.setServer(id, {
        state: 'AWAITING_PACKAGES',
        desiredRunning: false,
        hasPackagesSii: false,
        hasPackagesDat: false,
        lastError: 'The server reported that server_packages are missing. Upload server_packages.sii and .dat exported from the game.',
        lastErrorCode: 'server.packages_missing',
      });
      return;
    }
    const tail = text.trim().split('\n').slice(-5).join('\n');
    await this.setServer(id, {
      state: 'ERROR',
      lastError: `The server stopped unexpectedly (exit code ${exitCode ?? 'unknown'}).${tail ? `\nLast log lines:\n${tail}` : ''}`,
      lastErrorCode: 'agent.failed',
    });
  }

  // ---------------------------------------------------------------- reconciliation

  /** On boot: tasks from a previous process cannot continue; mark them and resync states. */
  async recover(): Promise<void> {
    await this.db
      .update(schema.tasks)
      .set({ state: 'failed', message: INTERRUPTED_MESSAGE, code: 'task.interrupted', finishedAt: new Date() })
      .where(inArray(schema.tasks.state, ['queued', 'running']));
    await this.db
      .update(schema.servers)
      .set({ state: 'UNKNOWN', updatedAt: new Date() })
      .where(inArray(schema.servers.state, ['INSTALLING', 'UPDATING', 'STARTING', 'STOPPING']));
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    let states: Record<string, { status: string; exitCode: number | null }>;
    try {
      states = await this.agent.list();
    } catch {
      // Agent down: running servers are unknown, everything else keeps its state.
      await this.db
        .update(schema.servers)
        .set({ state: 'UNKNOWN', updatedAt: new Date() })
        .where(inArray(schema.servers.state, ['ONLINE', 'STARTING']));
      return;
    }
    const rows = await this.db.select().from(schema.servers);
    for (const s of rows) {
      if (this.active.has(s.id)) continue;
      const st = states[s.id] ?? { status: 'missing', exitCode: null };
      const running = st.status === 'running';
      try {
        if (running && ['ONLINE', 'STARTING', 'STOPPED', 'ERROR', 'UNKNOWN', 'AWAITING_PACKAGES'].includes(s.state)) {
          const info = await this.agent.query(s.id).catch(() => null);
          this.queryCache.set(s.id, info);
          const next: ServerState = info ? 'ONLINE' : 'STARTING';
          if (next !== s.state) await this.setServer(s.id, { state: next, lastError: null, lastErrorCode: null });
          if (next === 'ONLINE' && (s.state !== 'ONLINE' || !s.sessionSearchId)) await this.captureSearchId(s.id);
        } else if (!running && (s.state === 'ONLINE' || s.state === 'STARTING')) {
          await this.handleExited(s.id, st.exitCode); // crashed or stopped outside the panel
          await this.maybeAutoRestart(s.id);
        } else if (!running && s.state === 'UNKNOWN') {
          await this.setServer(s.id, { state: s.installedAt ? (s.hasPackagesSii && s.hasPackagesDat ? 'STOPPED' : 'AWAITING_PACKAGES') : 'NEW' });
        }
      } catch (e) {
        this.log.warn({ err: e, server: s.id }, 'reconcile failed for server');
      }
    }
  }

  startReconciler(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((e: unknown) => this.log.warn({ err: e }, 'reconcile failed'));
    }, this.reconcileMs);
    this.reconcileTimer.unref();
  }

  stopReconciler(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }
}

export type TaskHandler = (
  task: { id: string; serverId: string; params: Record<string, unknown>; createdBy: string | null },
  ctx: TaskContext,
) => Promise<string>;

export interface TaskContext {
  progress(percent: number, stage: string): Promise<void>;
  log(line: string): void;
}

const ADMIN_ACCESS: ServerAccess = { role: 'administrator', permissions: [...SERVER_PERMISSIONS] };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toTaskError(e: unknown): TaskError {
  if (e instanceof TaskError) return e;
  if (e instanceof AgentUnavailableError) return new TaskError('agent.unavailable', e.message, 'UNKNOWN');
  if (e instanceof AgentError) return new TaskError('agent.failed', e.message);
  if (e instanceof AppError) return new TaskError(e.code, e.message);
  // A stream cut in the middle (agent or panel restarted): Node reports "aborted" / ECONNRESET.
  const code = (e as { code?: string }).code;
  if (e instanceof Error && (e.message === 'aborted' || code === 'ECONNRESET' || code === 'EPIPE')) {
    return new TaskError('task.interrupted', INTERRUPTED_MESSAGE, 'UNKNOWN');
  }
  return new TaskError('internal', e instanceof Error ? e.message : String(e));
}

export function agentAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof AgentUnavailableError) {
    return new AppError(503, 'agent.unavailable', 'TruckPanel cannot reach its agent. Check that the agent container is running.');
  }
  if (e instanceof AgentError) return new AppError(502, 'agent.failed', `The agent reported an error: ${e.message}`);
  throw e;
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string; message?: string }; message?: string };
  const code = err.code ?? err.cause?.code;
  const name = err.constraint ?? err.cause?.constraint ?? '';
  const msg = `${err.message ?? ''} ${err.cause?.message ?? ''}`;
  return code === '23505' && (name === constraint || msg.includes(constraint));
}

