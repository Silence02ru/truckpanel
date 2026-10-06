import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { APP_VERSION, type ApiError } from '@truckpanel/shared';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { checkCsrf } from './auth/guard.js';
import { SESSION_COOKIE, resolveSession } from './auth/sessions.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { serverRoutes } from './routes/servers.js';
import type { ServerManager } from './servers/manager.js';
import type { LiveBus } from './live/bus.js';
import type { LiveService } from './live/live-service.js';
import { liveRestRoutes } from './live/rest.js';
import { liveRoutes } from './live/ws.js';
import { discordRoutes } from './discord/routes.js';
import { profileRoutes } from './routes/profile.js';
import { Access } from './auth/access.js';
import { userRoutes } from './routes/users.js';
import { backupRoutes } from './backups/routes.js';
import { BackupService } from './backups/service.js';
import { scheduleRoutes } from './schedule/routes.js';
import { ScheduleService } from './schedule/service.js';
import { UserService } from './users/service.js';
import type { DiscordService } from './discord/service.js';

declare module 'fastify' {
  interface FastifyInstance {
    servers: ServerManager | null;
    live: LiveService | null;
    discord: DiscordService | null;
    schedules: ScheduleService | null;
  }
}

export const VERSION = APP_VERSION;

export interface AppDeps {
  config: Config;
  db: Db;
  logger?: FastifyServerOptions['logger'];
  /** Builds the server manager with the app logger; omitted in auth-only tests. */
  managerFactory?: (log: FastifyInstance['log']) => ServerManager;
  /** Live layer (WebSocket, console, players, metrics); built with the app logger. */
  liveFactory?: (log: FastifyInstance['log']) => { bus: LiveBus; service: LiveService };
  /** Discord status messages; needs the manager (and the live layer for players/mods). */
  discordFactory?: (log: FastifyInstance['log'], manager: ServerManager, live: LiveService | null) => DiscordService;
}

const errorBody = (code: ApiError['error']['code'], message: string): ApiError => ({ error: { code, message } });

export async function buildApp({ config, db, logger, managerFactory, liveFactory, discordFactory }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
    // Trust the last N hops (host reverse proxy → Docker bridge) for request.ip.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(errorBody('validation_failed', 'Some fields are invalid. Check the form and try again.'));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send(errorBody('rate_limited', 'Too many attempts. Wait a minute and try again.'));
    }
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send(errorBody('validation_failed', 'The request could not be processed.'));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(errorBody('internal', 'Something went wrong on the panel. Check the panel logs.'));
  });

  // Security headers (phase 8). The UI loads nothing from other origins (fonts and icons are
  // bundled); Mantine injects <style> tags, hence 'unsafe-inline' for styles only.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (config.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    // Swagger UI (/api/docs) ships its own inline bootstrap script.
    if (!request.url.startsWith('/api/docs')) reply.header('content-security-policy', CSP);
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new AppError(429, 'rate_limited', 'Too many attempts.'),
  });

  await app.register(swagger, {
    openapi: { info: { title: 'TruckPanel API', version: VERSION } },
    transform: jsonSchemaTransform,
  });
  // API docs only for signed-in users: they list every route (phase 8 hardening).
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiHooks: {
      onRequest: async (request, reply) => {
        const token = request.cookies[SESSION_COOKIE];
        if (!token || !(await resolveSession(db, token))) {
          return reply.code(401).send(errorBody('unauthorized', 'Sign in to the panel to read the API documentation.'));
        }
      },
    },
  });

  app.decorateRequest('user', null);
  app.decorate('access', new Access(db));
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    checkCsrf(config, request);
    const token = request.cookies[SESSION_COOKIE];
    if (token) request.user = await resolveSession(db, token);
  });

  healthRoutes(app, { db, version: VERSION });
  authRoutes(app, { config, db });

  const manager = managerFactory ? managerFactory(app.log) : null;
  app.decorate('servers', manager);
  if (manager) await serverRoutes(app, { manager });
  profileRoutes(app, { db, manager });
  let schedules: ScheduleService | null = null;
  if (manager) {
    const backups = new BackupService(db, manager.agentClient, manager);
    backupRoutes(app, backups);
    schedules = new ScheduleService(db, manager, backups, manager.agentClient, app.log);
    scheduleRoutes(app, { schedules, manager });
  }
  app.decorate('schedules', schedules);
  userRoutes(app, { config, db, users: new UserService(db, app.access, config.APP_URL) });

  const live = liveFactory ? liveFactory(app.log) : null;
  app.decorate('live', live?.service ?? null);
  if (live) {
    await liveRoutes(app, { config, db, bus: live.bus, live: live.service, access: app.access });
    await liveRestRoutes(app, live.service);
  }

  const discord = manager && discordFactory ? discordFactory(app.log, manager, live?.service ?? null) : null;
  app.decorate('discord', discord);
  if (discord) await discordRoutes(app, discord);

  if (config.WEB_DIST_DIR) {
    await app.register(fastifyStatic, { root: config.WEB_DIST_DIR, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    // SPA fallback: client-side routes get index.html, unknown API paths get JSON 404.
    if (config.WEB_DIST_DIR && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send(errorBody('not_found', 'Not found.'));
  });

  return app;
}
