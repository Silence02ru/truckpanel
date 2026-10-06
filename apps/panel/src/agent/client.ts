import { request } from 'node:http';
import {
  containerStateSchema,
  fileStatSchema,
  packageVersionSchema,
  type PackageVersion,
  hostPortsSchema,
  statsSchema,
  installEventSchema,
  queryInfoSchema,
  type ContainerState,
  type FileStat,
  type GameId,
  type HostPorts,
  type Stats,
  type InstallEvent,
  type QueryInfo,
  type ServerFile,
  type StartSpec,
} from '@truckpanel/shared';
import { z } from 'zod';

/** What the panel needs from the agent. The HTTP client implements it; tests use a fake. */
export interface AgentClient {
  hostPorts(): Promise<HostPorts>;
  list(): Promise<Record<string, ContainerState>>;
  state(id: string): Promise<ContainerState>;
  install(id: string, game: GameId, onEvent: (e: InstallEvent) => void): Promise<InstallEvent & { type: 'done' }>;
  start(id: string, spec: StartSpec): Promise<ContainerState>;
  stop(id: string, timeoutSec?: number): Promise<ContainerState>;
  kill(id: string): Promise<ContainerState>;
  remove(id: string, purge: boolean): Promise<void>;
  logs(id: string, tail: number): Promise<string>;
  query(id: string): Promise<QueryInfo | null>;
  readFile(id: string, game: GameId, file: ServerFile): Promise<Buffer | null>;
  writeFile(id: string, game: GameId, file: ServerFile, data: Buffer): Promise<void>;
  statFile(id: string, game: GameId, file: ServerFile): Promise<FileStat>;
  /** Copies the current server_packages pair into the history (null when there is no pair). */
  snapshotPackages(id: string, game: GameId): Promise<PackageVersion | null>;
  packageHistory(id: string, game: GameId): Promise<PackageVersion[]>;
  /** Puts a stored pair back; false when the version does not exist. */
  restorePackages(id: string, game: GameId, version: string): Promise<boolean>;
  /** Backup archive storage (docs/PHASE-7.md §7.4). */
  storeBackup(id: string, backupId: string, data: Buffer): Promise<void>;
  readBackup(id: string, backupId: string): Promise<Buffer | null>;
  deleteBackup(id: string, backupId: string): Promise<void>;
  listBackups(id: string): Promise<Record<string, number>>;
  /** Build id from the installed appmanifest; null when unknown. */
  installedBuild(id: string, game: GameId): Promise<string | null>;
  /** Latest public build id from Steam; null when Steam did not answer. */
  latestBuild(game: GameId): Promise<string | null>;
  stats(): Promise<Stats>;
  /** Live container output; resolves when the container stops or `signal` aborts. */
  followLogs(id: string, sinceSec: number, onText: (text: string) => void, signal: AbortSignal): Promise<void>;
}

export class AgentUnavailableError extends Error {}
export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Target {
  socketPath?: string;
  host?: string;
  port?: number;
}

/** AGENT_URL: "unix:/run/truckpanel/agent.sock" or "http://127.0.0.1:7071". */
export function parseAgentUrl(url: string): Target {
  if (url.startsWith('unix:')) return { socketPath: url.slice('unix:'.length) };
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error('AGENT_URL must be unix:<path> or http://host:port');
  return { host: u.hostname, port: Number(u.port || 80) };
}

export class HttpAgentClient implements AgentClient {
  private readonly target: Target;

  constructor(
    url: string,
    private readonly token: string,
    private readonly timeoutMs = 60_000,
  ) {
    this.target = parseAgentUrl(url);
  }

  private raw(
    method: string,
    path: string,
    body?: Buffer | object,
    onChunk?: (chunk: string) => void,
    timeoutMs = this.timeoutMs,
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          ...this.target,
          method,
          path,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(payload
              ? {
                  'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
                  'content-length': payload.length,
                }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => {
            if (onChunk) onChunk(c.toString('utf8'));
            else chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new AgentUnavailableError('Agent request timed out')));
      req.on('error', (e) =>
        reject(e instanceof AgentUnavailableError ? e : new AgentUnavailableError(`Agent unreachable: ${e.message}`)),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async json<T>(schema: z.ZodType<T>, method: string, path: string, body?: object): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status >= 400) throw new AgentError(res.status, res.body.toString('utf8').slice(0, 500));
    return schema.parse(JSON.parse(res.body.toString('utf8')));
  }

  hostPorts() {
    return this.json(hostPortsSchema, 'GET', '/v1/host/ports');
  }
  list() {
    return this.json(z.record(z.string(), containerStateSchema), 'GET', '/v1/servers');
  }
  state(id: string) {
    return this.json(containerStateSchema, 'GET', `/v1/servers/${id}/state`);
  }
  start(id: string, spec: StartSpec) {
    return this.json(containerStateSchema, 'POST', `/v1/servers/${id}/start`, spec);
  }
  stop(id: string, timeoutSec = 30) {
    return this.json(containerStateSchema, 'POST', `/v1/servers/${id}/stop`, { timeoutSec });
  }
  kill(id: string) {
    return this.json(containerStateSchema, 'POST', `/v1/servers/${id}/kill`, {});
  }
  async remove(id: string, purge: boolean) {
    await this.json(z.object({ ok: z.boolean() }), 'DELETE', `/v1/servers/${id}?purge=${purge ? 1 : 0}`);
  }
  async logs(id: string, tail: number) {
    return (await this.json(z.object({ text: z.string() }), 'GET', `/v1/servers/${id}/logs?tail=${tail}`)).text;
  }
  async query(id: string) {
    const res = await this.raw('GET', `/v1/servers/${id}/query`, undefined, undefined, 5000);
    if (res.status !== 200) return null;
    return queryInfoSchema.parse(JSON.parse(res.body.toString('utf8')));
  }
  async readFile(id: string, game: GameId, file: ServerFile) {
    const res = await this.raw('GET', `/v1/servers/${id}/files/${file}?game=${game}`);
    if (res.status === 404) return null;
    if (res.status >= 400) throw new AgentError(res.status, res.body.toString('utf8'));
    return res.body;
  }
  async writeFile(id: string, game: GameId, file: ServerFile, data: Buffer) {
    const res = await this.raw('PUT', `/v1/servers/${id}/files/${file}?game=${game}`, data);
    if (res.status >= 400) throw new AgentError(res.status, res.body.toString('utf8'));
  }
  stats() {
    return this.json(statsSchema, 'GET', '/v1/stats');
  }

  followLogs(id: string, sinceSec: number, onText: (text: string) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = request(
        { ...this.target, method: 'GET', path: `/v1/servers/${id}/logs/stream?since=${sinceSec}`, headers: { authorization: `Bearer ${this.token}` } },
        (res) => {
          if ((res.statusCode ?? 0) >= 400) {
            res.resume();
            reject(new AgentError(res.statusCode ?? 0, 'log stream rejected'));
            return;
          }
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => onText(chunk));
          res.on('end', () => resolve());
          res.on('error', () => resolve());
        },
      );
      // No timeout: the stream is idle while the server is quiet.
      req.on('error', (e) => reject(signal.aborted ? new Error('aborted') : new AgentUnavailableError(`Agent unreachable: ${e.message}`)));
      signal.addEventListener('abort', () => req.destroy(), { once: true });
      req.end();
    });
  }

  statFile(id: string, game: GameId, file: ServerFile) {
    return this.json(fileStatSchema, 'GET', `/v1/servers/${id}/files/${file}/stat?game=${game}`);
  }
  async snapshotPackages(id: string, game: GameId) {
    return (await this.json(z.object({ snapshot: packageVersionSchema.nullable() }), 'POST', `/v1/servers/${id}/packages/snapshot?game=${game}`, {})).snapshot;
  }
  async packageHistory(id: string, game: GameId) {
    return (await this.json(z.object({ history: z.array(packageVersionSchema) }), 'GET', `/v1/servers/${id}/packages/history?game=${game}`)).history;
  }
  async storeBackup(id: string, backupId: string, data: Buffer) {
    const res = await this.raw('PUT', `/v1/servers/${id}/backups/${backupId}`, data);
    if (res.status >= 400) throw new AgentError(res.status, res.body.toString('utf8').slice(0, 500));
  }
  async readBackup(id: string, backupId: string) {
    const res = await this.raw('GET', `/v1/servers/${id}/backups/${backupId}`);
    if (res.status === 404) return null;
    if (res.status >= 400) throw new AgentError(res.status, res.body.toString('utf8').slice(0, 500));
    return res.body;
  }
  async deleteBackup(id: string, backupId: string) {
    await this.json(z.object({ ok: z.boolean() }), 'DELETE', `/v1/servers/${id}/backups/${backupId}`);
  }
  async installedBuild(id: string, game: GameId) {
    return (await this.json(z.object({ installed: z.string().nullable() }), 'GET', `/v1/servers/${id}/build?game=${game}`)).installed;
  }
  async latestBuild(game: GameId) {
    const res = await this.raw('GET', `/v1/games/${game}/latest-build`, undefined, undefined, 180_000);
    if (res.status >= 400) throw new AgentError(res.status, res.body.toString('utf8').slice(0, 500));
    return z.object({ latest: z.string().nullable() }).parse(JSON.parse(res.body.toString('utf8'))).latest;
  }
  async listBackups(id: string) {
    return (await this.json(z.object({ backups: z.record(z.string(), z.number()) }), 'GET', `/v1/servers/${id}/backups`)).backups;
  }
  async restorePackages(id: string, game: GameId, version: string) {
    const res = await this.raw('POST', `/v1/servers/${id}/packages/restore?game=${game}`, { version });
    if (res.status === 404) return false;
    if (res.status >= 400) throw new AgentError(res.status, res.body.toString('utf8').slice(0, 500));
    return true;
  }

  async install(id: string, game: GameId, onEvent: (e: InstallEvent) => void) {
    let pending = '';
    let done: (InstallEvent & { type: 'done' }) | null = null;
    const res = await this.raw(
      'POST',
      `/v1/servers/${id}/install`,
      { game },
      (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = installEventSchema.parse(JSON.parse(line));
          if (event.type === 'done') done = event;
          onEvent(event);
        }
      },
      2 * 60 * 60 * 1000, // downloads can take long; the stream keeps the socket busy
    );
    if (res.status >= 400) throw new AgentError(res.status, 'install request rejected');
    return done ?? { type: 'done' as const, ok: false, exitCode: null, message: 'Agent closed the stream without a result' };
  }
}
