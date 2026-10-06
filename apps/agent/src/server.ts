import { createHash, timingSafeEqual } from 'node:crypto';
import { chown, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GAMES,
  PACKAGE_VERSION_RE,
  gameIdSchema,
  installRequestSchema,
  serverFileSchema,
  startSpecSchema,
  type InstallEvent,
  type ServerMetrics,
} from '@truckpanel/shared';
import { queryInfo } from './a2s.js';
import { hostPorts } from './hostports.js';
import { hostMetrics } from './metrics.js';
import { BACKUP_ID_RE, deleteBackup, listBackups, purgeBackups, readBackup, storeBackup } from './backups.js';
import { history as packageHistory, restore as restorePackages, snapshot as snapshotPackages } from './packages.js';
import { PathError, SERVER_ID_RE, resolveInside, serverFilePath, serverPaths } from './paths.js';
import { GAME_UID, prepareDirs, type Runtime } from './runtime.js';
import { isErrorLine, isSuccessLine, parseProgress } from './steamcmd.js';

export interface AgentDeps {
  runtime: Runtime;
  token: string;
  serversRoot: string;
  /** Backup archives (docs/PHASE-7.md §7.4). */
  backupsRoot: string;
  procRoot?: string;
  logger?: boolean;
}

const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** Serializes operations per key so two actions on one server never overlap. */
class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    // Cleanup must not create a second, unobserved promise that rejects together with `next`:
    // an unhandled rejection terminates Node and took the whole agent down (seen on the VPS).
    const cleanup = () => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

const idParams = z.object({ id: z.string().regex(SERVER_ID_RE) });
const gameQuery = z.object({ game: gameIdSchema });

function safeTokenEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function buildAgent(deps: AgentDeps): Promise<FastifyInstance> {
  const { runtime, serversRoot } = deps;
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: MAX_FILE_BYTES });
  const locks = new KeyedLock();

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !safeTokenEqual(token, deps.token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError || error instanceof PathError) {
      return reply.code(400).send({ error: 'bad_request', message: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/port is already allocated|address already in use/i.test(message)) {
      return reply.code(409).send({ error: 'port_in_use', message: 'A server port is already in use on the host.' });
    }
    app.log.error({ err: error }, 'agent error');
    return reply.code(500).send({ error: 'internal', message: error instanceof Error ? error.message : String(error) });
  });

  app.get('/v1/health', async () => ({ status: 'ok' }));

  app.get('/v1/host/ports', { logLevel: 'warn' }, async () => hostPorts(deps.procRoot));

  // Polled every few seconds by the panel reconciler: keep them out of info logs.
  const quiet = { logLevel: 'warn' as const };

  app.get('/v1/servers', quiet, async () => runtime.list());

  app.get('/v1/servers/:id/state', quiet, async (request) => {
    const { id } = idParams.parse(request.params);
    return runtime.state(id);
  });

  app.post('/v1/servers/:id/start', async (request) => {
    const { id } = idParams.parse(request.params);
    const spec = startSpecSchema.parse(request.body);
    await locks.run(id, () => runtime.start(id, spec, serverPaths(serversRoot, id, spec.game)));
    return runtime.state(id);
  });

  app.post('/v1/servers/:id/stop', async (request) => {
    const { id } = idParams.parse(request.params);
    const { timeoutSec } = z.object({ timeoutSec: z.number().int().min(1).max(300).default(30) }).parse(request.body ?? {});
    await locks.run(id, () => runtime.stop(id, timeoutSec));
    return runtime.state(id);
  });

  app.post('/v1/servers/:id/kill', async (request) => {
    const { id } = idParams.parse(request.params);
    await locks.run(id, () => runtime.kill(id));
    return runtime.state(id);
  });

  app.delete('/v1/servers/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const { purge } = z.object({ purge: z.enum(['0', '1']).default('0') }).parse(request.query);
    await locks.run(id, async () => {
      await runtime.remove(id);
      if (purge === '1') {
        // Only ever <serversRoot>/<uuid>; serverPaths() validated the id format.
        await rm(serverPaths(serversRoot, id, 'ets2').root, { recursive: true, force: true });
        await purgeBackups(deps.backupsRoot, id);
      }
    });
    return { ok: true };
  });

  app.get('/v1/stats', quiet, async () => {
    const [host, states] = await Promise.all([hostMetrics(serversRoot, deps.procRoot), runtime.list()]);
    const running = Object.entries(states).filter(([, st]) => st.status === 'running').map(([id]) => id);
    const servers: Record<string, ServerMetrics> = {};
    await Promise.all(
      running.map(async (id) => {
        const m = await runtime.stats(id).catch(() => null);
        if (m) servers[id] = m;
      }),
    );
    return { host, servers };
  });

  // Live console: chunked text until the container stops or the panel disconnects.
  app.get('/v1/servers/:id/logs/stream', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { since } = z.object({ since: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    const abort = new AbortController();
    request.raw.on('close', () => abort.abort());
    try {
      await runtime.followLogs(id, since, (text) => raw.write(text), abort.signal);
    } catch (e) {
      app.log.warn({ err: e, server: id }, 'log stream failed');
    } finally {
      raw.end();
    }
  });

  app.get('/v1/servers/:id/logs', async (request) => {
    const { id } = idParams.parse(request.params);
    const { tail } = z.object({ tail: z.coerce.number().int().min(1).max(5000).default(200) }).parse(request.query);
    return { text: await runtime.logs(id, tail) };
  });

  app.get('/v1/servers/:id/query', quiet, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const port = await runtime.queryPort(id);
    if (!port) return reply.code(404).send({ error: 'not_running' });
    try {
      return await queryInfo('127.0.0.1', port);
    } catch {
      return reply.code(504).send({ error: 'no_answer' });
    }
  });

  // ---- files in the server home (whitelist only) ----

  const fileParams = z.object({ id: z.string().regex(SERVER_ID_RE), file: serverFileSchema });

  app.get('/v1/servers/:id/files/:file', async (request, reply) => {
    const { id, file } = fileParams.parse(request.params);
    const { game } = gameQuery.parse(request.query);
    const path = serverFilePath(serverPaths(serversRoot, id, game), file);
    try {
      const buf = await readFile(path);
      return reply.type('application/octet-stream').send(buf);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  app.get('/v1/servers/:id/files/:file/stat', async (request) => {
    const { id, file } = fileParams.parse(request.params);
    const { game } = gameQuery.parse(request.query);
    const path = serverFilePath(serverPaths(serversRoot, id, game), file);
    try {
      const [st, buf] = await Promise.all([stat(path), readFile(path)]);
      return {
        exists: true,
        size: st.size,
        sha256: createHash('sha256').update(buf).digest('hex'),
        modifiedAt: st.mtime.toISOString(),
      };
    } catch {
      return { exists: false, size: 0, sha256: null, modifiedAt: null };
    }
  });

  app.put('/v1/servers/:id/files/:file', async (request) => {
    const { id, file } = fileParams.parse(request.params);
    const { game } = gameQuery.parse(request.query);
    const body = request.body;
    if (!Buffer.isBuffer(body)) throw new PathError('Expected application/octet-stream body');
    const paths = serverPaths(serversRoot, id, game);
    const path = serverFilePath(paths, file);
    await locks.run(`${id}:files`, async () => {
      await prepareDirs(paths);
      const tmp = `${path}.tp-tmp`;
      await writeFile(tmp, body, { mode: 0o644 });
      if (process.getuid?.() === 0) await chown(tmp, GAME_UID, GAME_UID);
      await rename(tmp, path);
    });
    return { ok: true, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  });

  // ---- backup archives (docs/PHASE-7.md §7.4) ----

  const backupParams = z.object({ id: z.string().regex(SERVER_ID_RE), backupId: z.string().regex(BACKUP_ID_RE) });

  app.get('/v1/servers/:id/backups', async (request) => {
    const { id } = idParams.parse(request.params);
    return { backups: await listBackups(deps.backupsRoot, id) };
  });

  app.put('/v1/servers/:id/backups/:backupId', async (request) => {
    const { id, backupId } = backupParams.parse(request.params);
    const body = request.body;
    if (!Buffer.isBuffer(body)) throw new PathError('Expected application/octet-stream body');
    return locks.run(`${id}:backups`, () => storeBackup(deps.backupsRoot, id, backupId, body));
  });

  app.get('/v1/servers/:id/backups/:backupId', async (request, reply) => {
    const { id, backupId } = backupParams.parse(request.params);
    const buf = await readBackup(deps.backupsRoot, id, backupId);
    if (!buf) return reply.code(404).send({ error: 'not_found' });
    return reply.type('application/gzip').send(buf);
  });

  app.delete('/v1/servers/:id/backups/:backupId', async (request) => {
    const { id, backupId } = backupParams.parse(request.params);
    await locks.run(`${id}:backups`, () => deleteBackup(deps.backupsRoot, id, backupId));
    return { ok: true };
  });

  // ---- server_packages history (docs/PHASE-7.md §7.3) ----

  app.post('/v1/servers/:id/packages/snapshot', async (request) => {
    const { id } = idParams.parse(request.params);
    const { game } = gameQuery.parse(request.query);
    const paths = serverPaths(serversRoot, id, game);
    return { snapshot: await locks.run(`${id}:files`, () => snapshotPackages(paths)) };
  });

  app.get('/v1/servers/:id/packages/history', async (request) => {
    const { id } = idParams.parse(request.params);
    const { game } = gameQuery.parse(request.query);
    return { history: await packageHistory(serverPaths(serversRoot, id, game)) };
  });

  app.post('/v1/servers/:id/packages/restore', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { game } = gameQuery.parse(request.query);
    const { version } = z.object({ version: z.string().regex(PACKAGE_VERSION_RE) }).parse(request.body);
    const paths = serverPaths(serversRoot, id, game);
    try {
      await locks.run(`${id}:files`, () => restorePackages(paths, version));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: 'not_found' });
      throw e;
    }
    return { ok: true };
  });

  // ---- game builds: installed (appmanifest) vs latest (Steam), docs/PHASE-7.md §7.5 ----

  app.get('/v1/servers/:id/build', async (request) => {
    const { id } = idParams.parse(request.params);
    const { game } = gameQuery.parse(request.query);
    const paths = serverPaths(serversRoot, id, game);
    try {
      const acf = await readFile(resolveInside(paths.game, 'steamapps', `appmanifest_${GAMES[game].appId}.acf`), 'utf8');
      return { installed: /"buildid"\s+"(\d+)"/.exec(acf)?.[1] ?? null };
    } catch {
      return { installed: null };
    }
  });

  // ---- install / update via SteamCMD (NDJSON stream) ----

  const installLock = new KeyedLock(); // one SteamCMD run per host: it updates itself in a shared dir

  app.get('/v1/games/:game/latest-build', async (request) => {
    const { game } = z.object({ game: gameIdSchema }).parse(request.params);
    return { latest: await installLock.run('steamcmd', () => runtime.latestBuild(game)) };
  });

  app.post('/v1/servers/:id/install', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { game } = installRequestSchema.parse(request.body);
    const paths = serverPaths(serversRoot, id, game);
    const appId = GAMES[game].appId;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const send = (e: InstallEvent) => raw.write(`${JSON.stringify(e)}\n`);

    let succeeded = false;
    let lastError = '';
    try {
      send({ type: 'progress', stage: 'waiting', percent: 0 });
      const exitCode = await installLock.run('steamcmd', () =>
        locks.run(id, () =>
          runtime.install(id, game, paths, (line) => {
            send({ type: 'log', line });
            const p = parseProgress(line);
            if (p) send({ type: 'progress', stage: p.stage, percent: p.percent });
            if (isSuccessLine(line, appId)) succeeded = true;
            if (isErrorLine(line)) lastError = line;
          }),
        ),
      );
      const ok = exitCode === 0 && succeeded;
      send({
        type: 'done',
        ok,
        exitCode,
        message: ok ? 'installed' : lastError || `SteamCMD exited with code ${exitCode}`,
      });
    } catch (e) {
      send({ type: 'done', ok: false, exitCode: null, message: (e as Error).message });
    } finally {
      raw.end();
    }
  });

  return app;
}
