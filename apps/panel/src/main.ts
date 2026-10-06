import { HttpAgentClient } from './agent/client.js';
import { unavailableAgent } from './agent/unavailable.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { LiveBus } from './live/bus.js';
import { LiveService } from './live/live-service.js';
import { DiscordService } from './discord/service.js';
import { ServerManager } from './servers/manager.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = await openDb(config.DATABASE_URL);
  try {
    await database.migrate();
  } catch (error) {
    throw new Error(describeDbError(error, config.DATABASE_URL));
  }

  const agent = config.AGENT_TOKEN ? new HttpAgentClient(config.AGENT_URL, config.AGENT_TOKEN) : unavailableAgent();
  const bus = new LiveBus();
  const app = await buildApp({
    config,
    db: database.db,
    managerFactory: (log) => new ServerManager(database.db, agent, log, { encryptionKey: config.ENCRYPTION_KEY, bus }),
    liveFactory: (log) => ({ bus, service: new LiveService(database.db, agent, bus, log) }),
    discordFactory: (log, manager, live) => new DiscordService(database.db, manager, live, bus, log, { encryptionKey: config.ENCRYPTION_KEY }),
  });
  if (!config.AGENT_TOKEN) app.log.warn('AGENT_TOKEN is not set: game server management is disabled');

  const manager = app.servers!;
  await manager.recover().catch((e: unknown) => app.log.warn({ err: e }, 'initial reconcile failed'));
  manager.startReconciler();
  app.live!.start();
  app.discord!.start();
  app.schedules?.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    manager.stopReconciler();
    app.live!.stop();
    app.discord!.stop();
    app.schedules?.stop();
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.PANEL_HOST, port: config.PANEL_PORT });
}

function describeDbError(error: unknown, databaseUrl: string): string {
  let where = 'the database';
  try {
    const url = new URL(databaseUrl);
    where = `PostgreSQL at ${url.hostname}:${url.port || 5432}`;
  } catch {
    // keep generic wording; never print the URL (it contains the password)
  }
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  switch (cause?.code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return `TruckPanel cannot connect to ${where}. Check that the database container is running (docker compose ps).`;
    case '28P01':
      return `TruckPanel could not sign in to ${where}: wrong password. Check POSTGRES_PASSWORD in .env.`;
    case '3D000':
      return `${where}: database does not exist. Check DATABASE_URL in .env.`;
    default:
      return `Database migration failed on ${where}: ${cause?.message ?? (error instanceof Error ? error.message : String(error))}`;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
