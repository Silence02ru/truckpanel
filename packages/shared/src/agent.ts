import { z } from 'zod';

/**
 * Contract between the panel and the agent (the only component with docker.sock).
 * The agent exposes a CLOSED list of operations keyed by server id; there is no
 * generic "run container" or "exec" call. See docs/ARCHITECTURE.md §2.2.
 */

export const GAMES = {
  ets2: {
    appId: 1948160,
    dataDir: 'Euro Truck Simulator 2',
    binary: 'eurotrucks2_server',
    label: 'Euro Truck Simulator 2',
  },
  ats: {
    appId: 2239530,
    dataDir: 'American Truck Simulator',
    binary: 'amtrucks_server',
    label: 'American Truck Simulator',
  },
} as const;
export const GAME_IDS = ['ets2', 'ats'] as const;
export type GameId = (typeof GAME_IDS)[number];
export const gameIdSchema = z.enum(GAME_IDS);

/** Files the panel may write/read in the server home directory. Nothing else. */
export const SERVER_FILES = ['server_config.sii', 'config_ds.cfg', 'server_packages.sii', 'server_packages.dat'] as const;
export type ServerFile = (typeof SERVER_FILES)[number];
export const serverFileSchema = z.enum(SERVER_FILES);

/** Archived server_packages pair (docs/PHASE-7.md §7.3): UTC time, e.g. 20261006T170102345Z. */
export const PACKAGE_VERSION_RE = /^\d{8}T\d{9}Z$/;
export const PACKAGE_HISTORY_KEEP = 5;
const storedFileSchema = z.object({ size: z.number().int(), sha256: z.string() });
export const packageVersionSchema = z.object({
  version: z.string().regex(PACKAGE_VERSION_RE),
  createdAt: z.string(),
  sii: storedFileSchema,
  dat: storedFileSchema,
});
export type PackageVersion = z.infer<typeof packageVersionSchema>;

export const portSchema = z.number().int().min(1024).max(65535);

export const startSpecSchema = z.object({
  game: gameIdSchema,
  /** Published TCP+UDP with the same number on the host (connection_dedicated_port / query_dedicated_port). */
  ports: z.object({ connection: portSchema, query: portSchema }),
  memoryMb: z.number().int().min(512).max(65536),
  cpus: z.number().min(0.25).max(64),
});
export type StartSpec = z.infer<typeof startSpecSchema>;

export const installRequestSchema = z.object({ game: gameIdSchema });

export const containerStatusSchema = z.enum(['missing', 'created', 'running', 'restarting', 'paused', 'exited', 'dead']);
export type ContainerStatus = z.infer<typeof containerStatusSchema>;

export const containerStateSchema = z.object({
  status: containerStatusSchema,
  exitCode: z.number().int().nullable(),
  oomKilled: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type ContainerState = z.infer<typeof containerStateSchema>;

export const fileStatSchema = z.object({
  exists: z.boolean(),
  size: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  modifiedAt: z.string().nullable(),
});
export type FileStat = z.infer<typeof fileStatSchema>;

/** NDJSON events streamed by POST /v1/servers/:id/install. */
export const installEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), stage: z.string(), percent: z.number().min(0).max(100) }),
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({ type: z.literal('done'), ok: z.boolean(), exitCode: z.number().int().nullable(), message: z.string() }),
]);
export type InstallEvent = z.infer<typeof installEventSchema>;

export const queryInfoSchema = z.object({
  name: z.string(),
  map: z.string(),
  players: z.number().int(),
  maxPlayers: z.number().int(),
  version: z.string().nullable(),
});
export type QueryInfo = z.infer<typeof queryInfoSchema>;

export const hostPortsSchema = z.object({
  tcp: z.array(z.number().int()),
  udp: z.array(z.number().int()),
});
export type HostPorts = z.infer<typeof hostPortsSchema>;

export const hostMetricsSchema = z.object({
  cpuPercent: z.number(),
  cpuCores: z.number().int(),
  memTotalBytes: z.number(),
  memUsedBytes: z.number(),
  diskTotalBytes: z.number(),
  diskFreeBytes: z.number(),
  uptimeSec: z.number(),
});
export type HostMetrics = z.infer<typeof hostMetricsSchema>;

export const serverMetricsSchema = z.object({
  cpuPercent: z.number(),
  memUsedBytes: z.number(),
  memLimitBytes: z.number(),
  netRxBytes: z.number(),
  netTxBytes: z.number(),
});
export type ServerMetrics = z.infer<typeof serverMetricsSchema>;

/** GET /v1/stats: host metrics plus metrics of every running game server container. */
export const statsSchema = z.object({
  host: hostMetricsSchema,
  servers: z.record(z.string(), serverMetricsSchema),
});
export type Stats = z.infer<typeof statsSchema>;
