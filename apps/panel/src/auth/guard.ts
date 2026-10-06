import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { can, type Permission } from '@truckpanel/shared';
import type { Config } from '../config.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import type { SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const CSRF_COOKIE = 'tp_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requireUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
  return async (request) => {
    const user = requireUser(request);
    if (!can(user.role, permission)) throw forbidden();
  };
}

/** Double-submit cookie: readable by the SPA, echoed back in the X-CSRF-Token header. */
export function ensureCsrfCookie(config: Config, request: FastifyRequest, reply: FastifyReply): void {
  if (request.cookies[CSRF_COOKIE]) return;
  reply.setCookie(CSRF_COOKIE, randomToken(24), {
    path: '/',
    httpOnly: false,
    sameSite: 'strict',
    secure: config.secureCookies,
  });
}

export function checkCsrf(config: Config, request: FastifyRequest): void {
  if (!UNSAFE_METHODS.has(request.method)) return;

  const origin = request.headers.origin;
  if (origin !== undefined && origin !== config.appOrigin) {
    throw new AppError(403, 'csrf_failed', 'Request origin is not allowed.');
  }
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) {
    throw new AppError(403, 'csrf_failed', 'Security token is missing or expired. Reload the page and try again.');
  }
}
