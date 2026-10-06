import type { ContainerState, FileStat, GameId, HostPorts, InstallEvent, QueryInfo, ServerFile, StartSpec, PackageVersion } from '@truckpanel/shared';
import { AgentError, AgentUnavailableError, type AgentClient } from '../agent/client.js';

const MISSING: ContainerState = { status: 'missing', exitCode: null, oomKilled: false, startedAt: null, finishedAt: null };

/** In-memory agent: behaves like the real one, scriptable per test. */
export class FakeAgent implements AgentClient {
  host: HostPorts = { tcp: [22], udp: [] };
  down = false;
  installOk = true;
  /** Extra SteamCMD output emitted before the result. */
  installLines: string[] = [];
  /** Thrown in the middle of the install stream (e.g. agent restarted). */
  installThrow: Error | null = null;
  /** When true, a started server answers A2S (becomes ONLINE). */
  answersQuery = true;
  /** When set, a started container exits immediately with these logs. */
  exitOnStartLogs: string | null = null;
  /** Docker refuses the port binding at start (race with another program). */
  portAllocatedOnStart = false;
  /** Log a successfully started DS prints (format from the VPS run). */
  startLogs = ['[MP] Session started.', '[MP] Session search id: 90294179854447616/101', '[MP] Maximum number of players: 128'].join('\n');
  /** Set to hold install until released (to test "busy"). */
  installGate: Promise<void> | null = null;
  readonly files = new Map<string, Buffer>();
  readonly containers = new Map<string, ContainerState>();
  readonly logsText = new Map<string, string>();
  readonly calls: string[] = [];
  lastSpec: StartSpec | null = null;

  private guard() {
    if (this.down) throw new AgentUnavailableError('Agent unreachable: connect ENOENT');
  }
  private key(id: string, file: ServerFile) {
    return `${id}/${file}`;
  }

  async hostPorts() {
    this.guard();
    return this.host;
  }
  async list() {
    this.guard();
    return Object.fromEntries(this.containers);
  }
  async state(id: string) {
    this.guard();
    return this.containers.get(id) ?? MISSING;
  }
  async install(id: string, _game: GameId, onEvent: (e: InstallEvent) => void) {
    this.guard();
    this.calls.push(`install:${id}`);
    if (this.installGate) await this.installGate;
    onEvent({ type: 'progress', stage: 'downloading', percent: 50 });
    for (const line of this.installLines) onEvent({ type: 'log', line });
    if (this.installThrow) throw this.installThrow;
    onEvent({ type: 'log', line: "Success! App '1948160' fully installed." });
    const done: InstallEvent & { type: 'done' } = this.installOk
      ? { type: 'done', ok: true, exitCode: 0, message: 'installed' }
      : { type: 'done', ok: false, exitCode: 8, message: "ERROR! Failed to install app '1948160'" };
    onEvent(done);
    return done;
  }
  async start(id: string, spec: StartSpec) {
    this.guard();
    this.calls.push(`start:${id}`);
    this.lastSpec = spec;
    if (this.portAllocatedOnStart) throw new AgentError(409, '{"error":"port_in_use"}');
    const exited = this.exitOnStartLogs !== null;
    this.logsText.set(id, exited ? this.exitOnStartLogs! : this.startLogs);
    const st: ContainerState = {
      status: exited ? 'exited' : 'running',
      exitCode: exited ? 0 : null,
      oomKilled: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.containers.set(id, st);
    return st;
  }
  async stop(id: string) {
    this.guard();
    this.calls.push(`stop:${id}`);
    const st = { ...(this.containers.get(id) ?? MISSING), status: 'exited' as const, exitCode: 0 };
    this.containers.set(id, st);
    return st;
  }
  async kill(id: string) {
    this.guard();
    this.calls.push(`kill:${id}`);
    const st = { ...(this.containers.get(id) ?? MISSING), status: 'exited' as const, exitCode: 137 };
    this.containers.set(id, st);
    return st;
  }
  async remove(id: string, purge: boolean) {
    this.guard();
    this.calls.push(`remove:${id}:${purge}`);
    this.containers.delete(id);
    for (const k of [...this.files.keys()]) if (k.startsWith(`${id}/`)) this.files.delete(k);
  }
  async logs(id: string, tail: number) {
    this.guard();
    // Same semantics as docker logs --tail: only the last `tail` lines.
    const lines = (this.logsText.get(id) ?? '').split('\n');
    return lines.slice(Math.max(0, lines.length - tail)).join('\n');
  }
  async query(id: string): Promise<QueryInfo | null> {
    this.guard();
    if (this.containers.get(id)?.status !== 'running' || !this.answersQuery) return null;
    return { name: 'test', map: 'europe', players: 3, maxPlayers: 128, version: '1.61.1.1' };
  }
  async readFile(id: string, _game: GameId, file: ServerFile) {
    this.guard();
    return this.files.get(this.key(id, file)) ?? null;
  }
  async writeFile(id: string, _game: GameId, file: ServerFile, data: Buffer) {
    this.guard();
    this.files.set(this.key(id, file), data);
  }
  /** Lines the next followLogs() call delivers before the stream ends (or waits for abort). */
  followChunks: string[] = [];
  followHold = false;
  async stats() {
    this.guard();
    const servers: Record<string, { cpuPercent: number; memUsedBytes: number; memLimitBytes: number; netRxBytes: number; netTxBytes: number }> = {};
    for (const [id, st] of this.containers) {
      if (st.status === 'running') servers[id] = { cpuPercent: 8.6, memUsedBytes: 231 * 2 ** 20, memLimitBytes: 1536 * 2 ** 20, netRxBytes: 0, netTxBytes: 0 };
    }
    return {
      host: { cpuPercent: 20, cpuCores: 2, memTotalBytes: 2 * 2 ** 30, memUsedBytes: 2 ** 30, diskTotalBytes: 19 * 2 ** 30, diskFreeBytes: 11 * 2 ** 30, uptimeSec: 100 },
      servers,
    };
  }
  async followLogs(_id: string, _since: number, onText: (text: string) => void, signal: AbortSignal) {
    this.guard();
    for (const chunk of this.followChunks) onText(chunk);
    if (this.followHold) await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }
  /** serverId → versions (newest first), like the agent's packages-history. */
  readonly packageVersions = new Map<string, { version: string; sii: Buffer; dat: Buffer }[]>();
  private versionSeq = 0;
  async snapshotPackages(id: string, _game: GameId): Promise<PackageVersion | null> {
    this.guard();
    const sii = this.files.get(this.key(id, 'server_packages.sii'));
    const dat = this.files.get(this.key(id, 'server_packages.dat'));
    if (!sii || !dat) return null;
    const version = `2026100612${String(this.versionSeq++).padStart(7, '0')}Z`.replace(/^(\d{8})(\d{9})Z$/, '$1T$2Z');
    const list = [{ version, sii, dat }, ...(this.packageVersions.get(id) ?? [])].slice(0, 5);
    this.packageVersions.set(id, list);
    return this.describeVersion(list[0]!);
  }
  async packageHistory(id: string, _game: GameId): Promise<PackageVersion[]> {
    this.guard();
    return (this.packageVersions.get(id) ?? []).map((v) => this.describeVersion(v));
  }
  async restorePackages(id: string, _game: GameId, version: string): Promise<boolean> {
    this.guard();
    const v = (this.packageVersions.get(id) ?? []).find((x) => x.version === version);
    if (!v) return false;
    this.files.set(this.key(id, 'server_packages.sii'), v.sii);
    this.files.set(this.key(id, 'server_packages.dat'), v.dat);
    return true;
  }
  private describeVersion(v: { version: string; sii: Buffer; dat: Buffer }): PackageVersion {
    return { version: v.version, createdAt: new Date().toISOString(), sii: { size: v.sii.length, sha256: 'x' }, dat: { size: v.dat.length, sha256: 'y' } };
  }
  /** "<serverId>/<backupId>" → archive bytes */
  readonly backups = new Map<string, Buffer>();
  installed: string | null = '25488155';
  latest: string | null = '25488155';
  async installedBuild() {
    this.guard();
    return this.installed;
  }
  async latestBuild() {
    this.guard();
    return this.latest;
  }
  async storeBackup(id: string, backupId: string, data: Buffer) {
    this.guard();
    this.backups.set(`${id}/${backupId}`, data);
  }
  async readBackup(id: string, backupId: string) {
    this.guard();
    return this.backups.get(`${id}/${backupId}`) ?? null;
  }
  async deleteBackup(id: string, backupId: string) {
    this.guard();
    this.backups.delete(`${id}/${backupId}`);
  }
  async listBackups(id: string) {
    this.guard();
    return Object.fromEntries([...this.backups].filter(([k]) => k.startsWith(`${id}/`)).map(([k, v]) => [k.slice(id.length + 1), v.length]));
  }
  async statFile(id: string, _game: GameId, file: ServerFile): Promise<FileStat> {
    this.guard();
    const buf = this.files.get(this.key(id, file));
    return { exists: Boolean(buf), size: buf?.length ?? 0, sha256: null, modifiedAt: null };
  }
}
