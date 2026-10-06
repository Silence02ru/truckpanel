import { chmod, chown, rm } from 'node:fs/promises';
import Docker from 'dockerode';
import { z } from 'zod';
import { DockerRuntime } from './runtime.js';
import { buildAgent } from './server.js';

const env = z
  .object({
    /** Unix socket path (production) or host:port (development). */
    AGENT_LISTEN: z.string().default('/run/truckpanel/agent.sock'),
    AGENT_TOKEN: z.string().min(32, 'AGENT_TOKEN must be at least 32 characters'),
    SERVERS_ROOT: z.string().default('/var/lib/truckpanel/servers'),
    BACKUPS_ROOT: z.string().default('/var/lib/truckpanel/backups'),
    STEAMCMD_DIR: z.string().default('/var/lib/truckpanel/steamcmd'),
    SCS_IMAGE: z.string().default('truckpanel/scs-server:local'),
    /** Group that may connect to the socket (the panel container runs as gid 1000). */
    AGENT_SOCKET_GID: z.coerce.number().int().min(0).default(1000),
    LOG_LEVEL: z.string().default('info'),
  })
  .parse(process.env);

async function main(): Promise<void> {
  const runtime = new DockerRuntime(new Docker(), env.SCS_IMAGE, env.STEAMCMD_DIR);
  const app = await buildAgent({ runtime, token: env.AGENT_TOKEN, serversRoot: env.SERVERS_ROOT, backupsRoot: env.BACKUPS_ROOT });

  const tcp = /^([\d.]+):(\d+)$/.exec(env.AGENT_LISTEN);
  if (tcp) {
    await app.listen({ host: tcp[1], port: Number(tcp[2]) });
  } else {
    await rm(env.AGENT_LISTEN, { force: true });
    await app.listen({ path: env.AGENT_LISTEN });
    // Group-accessible so the panel container (same gid) can connect; never world-accessible.
    await chmod(env.AGENT_LISTEN, 0o660);
    if (process.getuid?.() === 0) await chown(env.AGENT_LISTEN, 0, env.AGENT_SOCKET_GID);
  }

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
