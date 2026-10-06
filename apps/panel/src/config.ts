import { z } from 'zod';

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PANEL_HOST: z.string().default('127.0.0.1'),
  PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Public URL users open, e.g. https://panel.example.com. Used for Origin checks and cookie Secure flag. */
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  /** AES-256-GCM key for secrets at rest (webhooks, logon tokens). */
  ENCRYPTION_KEY: base64Key32,
  /** One-time token printed by the installer; enables creating the first administrator. */
  INITIAL_SETUP_TOKEN: z.string().min(32).optional(),
  /** Number of reverse proxies in front of the panel (for client IP). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** Built SPA directory served at /. Optional in development (Vite serves it). */
  WEB_DIST_DIR: z.string().optional(),
  /** unix:<socket> (production) or http://host:port (development). */
  AGENT_URL: z.string().default('unix:/run/truckpanel/agent.sock'),
  /** Shared secret with the agent. Without it, server management reports "agent unavailable". */
  AGENT_TOKEN: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof envSchema> & {
  appOrigin: string;
  secureCookies: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid panel configuration (check .env):\n${lines.join('\n')}`);
  }
  const url = new URL(parsed.data.APP_URL);
  return { ...parsed.data, appOrigin: url.origin, secureCookies: url.protocol === 'https:' };
}
