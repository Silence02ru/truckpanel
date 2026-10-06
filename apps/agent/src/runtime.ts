import { createHash } from 'node:crypto';
import { chown, mkdir } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { GAMES, type ContainerState, type ContainerStatus, type GameId, type ServerMetrics, type StartSpec } from '@truckpanel/shared';
import { containerMetrics, type DockerStats } from './metrics.js';
import type { ServerPaths } from './paths.js';
import { cleanLine } from './steamcmd.js';

export const GAME_UID = 1000;
const LABEL = 'truckpanel.server';

export interface Runtime {
  /** Runs SteamCMD in a one-shot container; calls onLine for every output line. */
  install(id: string, game: GameId, paths: ServerPaths, onLine: (line: string) => void): Promise<number>;
  start(id: string, spec: StartSpec, paths: ServerPaths): Promise<void>;
  stop(id: string, timeoutSec: number): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  state(id: string): Promise<ContainerState>;
  list(): Promise<Record<string, ContainerState>>;
  logs(id: string, tail: number): Promise<string>;
  queryPort(id: string): Promise<number | null>;
  /** CPU/RAM/network of a running container, null when it is not running. */
  stats(id: string): Promise<ServerMetrics | null>;
  /** Streams container output (docker logs --follow) until the container stops or `signal` aborts. */
  followLogs(id: string, sinceSec: number, onText: (text: string) => void, signal: AbortSignal): Promise<void>;
  /** Latest public build id from Steam (SteamCMD app_info_print), null when Steam did not answer. */
  latestBuild(game: GameId): Promise<string | null>;
}

const MISSING: ContainerState = { status: 'missing', exitCode: null, oomKilled: false, startedAt: null, finishedAt: null };

export const containerName = (id: string) => `tp-srv-${id}`;
export const installerName = (id: string) => `tp-install-${id}`;

export function specHash(spec: StartSpec, image: string): string {
  return createHash('sha256').update(JSON.stringify({ spec, image })).digest('hex').slice(0, 16);
}

/** Creates server directories owned by the game user (uid 1000) when running as root. */
export async function prepareDirs(paths: ServerPaths, extra: string[] = []): Promise<void> {
  for (const dir of [paths.root, paths.game, paths.home, paths.dataDir, ...extra]) {
    await mkdir(dir, { recursive: true });
    if (process.getuid?.() === 0) await chown(dir, GAME_UID, GAME_UID);
  }
}

/** Container definition for a game server. Built only from validated, typed inputs. */
export function serverContainerOptions(
  id: string,
  spec: StartSpec,
  paths: ServerPaths,
  image: string,
): Docker.ContainerCreateOptions {
  const { connection, query } = spec.ports;
  const ports = [`${connection}/tcp`, `${connection}/udp`, `${query}/tcp`, `${query}/udp`];
  return {
    name: containerName(id),
    Image: image,
    User: `${GAME_UID}:${GAME_UID}`,
    WorkingDir: '/srv/game/bin/linux_x64',
    // Same flags as the legacy production setup; files are relative to the server home.
    Cmd: [`./${GAMES[spec.game].binary}`, '-nosingle', '-server', 'server_packages.sii', '-server_cfg', 'server_config.sii'],
    Env: ['HOME=/srv/home', 'XDG_DATA_HOME=/srv/home', 'LD_LIBRARY_PATH=/srv/game/linux64'],
    StopSignal: 'SIGINT', // the DS shuts down cleanly on Ctrl+C (SCS wiki)
    StopTimeout: 30,
    ExposedPorts: Object.fromEntries(ports.map((p) => [p, {}])),
    Labels: {
      [LABEL]: id,
      'truckpanel.game': spec.game,
      'truckpanel.query_port': String(query),
      'truckpanel.spec': specHash(spec, image),
    },
    HostConfig: {
      Binds: [`${paths.game}:/srv/game`, `${paths.home}:/srv/home`],
      PortBindings: Object.fromEntries(ports.map((p) => [p, [{ HostPort: p.split('/')[0] }]])),
      Memory: spec.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(spec.cpus * 1e9),
      PidsLimit: 512,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=64m' },
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
}

function toState(info: Docker.ContainerInspectInfo): ContainerState {
  const s = info.State;
  const time = (t: string | undefined) => (t && !t.startsWith('0001-') ? t : null);
  return {
    status: (s.Status as ContainerStatus) ?? 'dead',
    exitCode: s.Running ? null : s.ExitCode,
    oomKilled: Boolean(s.OOMKilled),
    startedAt: time(s.StartedAt),
    finishedAt: s.Running ? null : time(s.FinishedAt),
  };
}

function isNotFound(e: unknown): boolean {
  return (e as { statusCode?: number }).statusCode === 404;
}

export class DockerRuntime implements Runtime {
  constructor(
    private readonly docker: Docker,
    private readonly image: string,
    private readonly steamcmdDir: string,
  ) {}

  private async removeIfExists(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async install(id: string, game: GameId, paths: ServerPaths, onLine: (line: string) => void): Promise<number> {
    await prepareDirs(paths);
    await mkdir(this.steamcmdDir, { recursive: true });
    if (process.getuid?.() === 0) await chown(this.steamcmdDir, GAME_UID, GAME_UID);
    await this.removeIfExists(installerName(id));

    const container = await this.docker.createContainer({
      name: installerName(id),
      Image: this.image,
      User: `${GAME_UID}:${GAME_UID}`,
      Cmd: ['tp-steamcmd-install', String(GAMES[game].appId)],
      Labels: { 'truckpanel.install': id },
      HostConfig: {
        Binds: [`${paths.game}:/srv/game`, `${this.steamcmdDir}:/opt/steamcmd`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
      },
    });
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const out = new PassThrough();
      this.docker.modem.demuxStream(stream, out, out);
      let pending = '';
      out.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        // SteamCMD redraws progress with \r; treat it as a line break.
        const parts = pending.split(/\r?\n|\r/);
        pending = parts.pop() ?? '';
        for (const p of parts) {
          const line = cleanLine(p);
          if (line) onLine(line);
        }
      });
      await container.start();
      const result = (await container.wait()) as { StatusCode: number };
      if (pending.trim()) onLine(cleanLine(pending));
      return result.StatusCode;
    } finally {
      await this.removeIfExists(installerName(id));
    }
  }

  async latestBuild(game: GameId): Promise<string | null> {
    await mkdir(this.steamcmdDir, { recursive: true });
    if (process.getuid?.() === 0) await chown(this.steamcmdDir, GAME_UID, GAME_UID);
    const name = `tp-buildinfo-${game}`;
    await this.removeIfExists(name);
    const container = await this.docker.createContainer({
      name,
      Image: this.image,
      User: `${GAME_UID}:${GAME_UID}`,
      Cmd: ['tp-steamcmd-buildid', String(GAMES[game].appId)],
      HostConfig: {
        Binds: [`${this.steamcmdDir}:/opt/steamcmd`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
    });
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const out = new PassThrough();
      this.docker.modem.demuxStream(stream, out, out);
      let text = '';
      out.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      await container.start();
      await container.wait();
      return /^buildid=(\d+)$/m.exec(text)?.[1] ?? null;
    } finally {
      await this.removeIfExists(name);
    }
  }

  async start(id: string, spec: StartSpec, paths: ServerPaths): Promise<void> {
    await prepareDirs(paths);
    const wanted = specHash(spec, this.image);
    const container = this.docker.getContainer(containerName(id));
    let current: Docker.ContainerInspectInfo | null = null;
    try {
      current = await container.inspect();
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (current && current.Config.Labels?.['truckpanel.spec'] !== wanted) {
      // Ports/limits/image changed: recreate. Data lives in bind mounts, nothing is lost.
      await this.removeIfExists(containerName(id));
      current = null;
    }
    if (!current) {
      await this.docker.createContainer(serverContainerOptions(id, spec, paths, this.image));
    } else if (current.State.Running) {
      return;
    }
    try {
      await this.docker.getContainer(containerName(id)).start();
    } catch (e) {
      // e.g. "port is already allocated": do not leave a half-created container behind;
      // the next start recreates it from the spec.
      await this.removeIfExists(containerName(id)).catch(() => undefined);
      throw e;
    }
  }

  async stop(id: string, timeoutSec: number): Promise<void> {
    try {
      await this.docker.getContainer(containerName(id)).stop({ t: timeoutSec });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code !== 304 && !isNotFound(e)) throw e; // 304 = already stopped
    }
  }

  async kill(id: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(id)).kill();
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code !== 409 && !isNotFound(e)) throw e; // 409 = not running
    }
  }

  async remove(id: string): Promise<void> {
    await this.removeIfExists(containerName(id));
    await this.removeIfExists(installerName(id));
  }

  async state(id: string): Promise<ContainerState> {
    try {
      return toState(await this.docker.getContainer(containerName(id)).inspect());
    } catch (e) {
      if (isNotFound(e)) return MISSING;
      throw e;
    }
  }

  async list(): Promise<Record<string, ContainerState>> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [LABEL] } });
    const out: Record<string, ContainerState> = {};
    for (const c of containers) {
      const id = c.Labels[LABEL];
      if (id) out[id] = await this.state(id);
    }
    return out;
  }

  async logs(id: string, tail: number): Promise<string> {
    try {
      const buf = (await this.docker
        .getContainer(containerName(id))
        .logs({ stdout: true, stderr: true, tail, follow: false })) as unknown as Buffer;
      return demuxBuffer(buf);
    } catch (e) {
      if (isNotFound(e)) return '';
      throw e;
    }
  }

  async stats(id: string): Promise<ServerMetrics | null> {
    try {
      const raw = (await this.docker.getContainer(containerName(id)).stats({ stream: false })) as unknown as DockerStats;
      return containerMetrics(raw);
    } catch (e) {
      if (isNotFound(e) || (e as { statusCode?: number }).statusCode === 409) return null;
      throw e;
    }
  }

  async followLogs(id: string, sinceSec: number, onText: (text: string) => void, signal: AbortSignal): Promise<void> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = (await this.docker
        .getContainer(containerName(id))
        .logs({ follow: true, stdout: true, stderr: true, since: sinceSec, timestamps: false })) as unknown as NodeJS.ReadableStream;
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
    const out = new PassThrough();
    this.docker.modem.demuxStream(stream, out, out);
    out.on('data', (chunk: Buffer) => onText(chunk.toString('utf8')));
    await new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        (stream as unknown as { destroy?: () => void }).destroy?.();
        done();
      };
      signal.addEventListener('abort', abort);
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', done);
    });
  }

  async queryPort(id: string): Promise<number | null> {
    try {
      const info = await this.docker.getContainer(containerName(id)).inspect();
      const p = Number(info.Config.Labels?.['truckpanel.query_port']);
      return Number.isInteger(p) && p > 0 ? p : null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }
}

/** Docker multiplexed log frames: [stream(1) 0 0 0 size(4 BE)] payload. Non-TTY containers use it. */
export function demuxBuffer(buf: Buffer): string {
  const parts: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.toString('utf8', i + 8, i + 8 + size));
    i += 8 + size;
  }
  return i === 0 && buf.length > 0 ? buf.toString('utf8') : parts.join('');
}
