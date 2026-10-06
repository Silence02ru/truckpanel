import { sql } from 'drizzle-orm';
import type { HostPorts, ServerPorts } from '@truckpanel/shared';
import { schema, type Db } from '../db/client.js';

/** Dedicated ports start at the conventional Steam range; virtual ports are SCS-specific 100–200. */
export const HOST_PORT_START = 27015;
export const HOST_PORT_END = 28999;
export const VIRTUAL_PORT_START = 100;
export const VIRTUAL_PORT_END = 200; // inclusive (SCS wiki: allowed range <100,200>)
const ALLOC_LOCK_ID = 7_301_002;

export class NoFreePortsError extends Error {}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function isFreeOnHost(host: HostPorts, port: number): boolean {
  return !host.tcp.includes(port) && !host.udp.includes(port);
}

/**
 * Allocates connection/query (host) and their virtual ports for one server inside the caller's
 * transaction. Checks BOTH the panel's reservations and real host usage (CLAUDE.md §5); an
 * advisory lock serializes concurrent allocations and the UNIQUE index is the final guard.
 */
export async function allocatePorts(tx: Tx, serverId: string, host: HostPorts): Promise<ServerPorts> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ALLOC_LOCK_ID})`);
  const rows = await tx.select({ space: schema.serverPorts.space, port: schema.serverPorts.port }).from(schema.serverPorts);
  const taken = { host: new Set<number>(), virtual: new Set<number>() };
  for (const r of rows) taken[r.space].add(r.port);

  let connection: number | null = null;
  for (let p = HOST_PORT_START; p + 1 <= HOST_PORT_END; p += 2) {
    const free = (x: number) => !taken.host.has(x) && isFreeOnHost(host, x);
    if (free(p) && free(p + 1)) {
      connection = p;
      break;
    }
  }
  let connectionVirtual: number | null = null;
  for (let p = VIRTUAL_PORT_START; p + 1 <= VIRTUAL_PORT_END; p += 2) {
    if (!taken.virtual.has(p) && !taken.virtual.has(p + 1)) {
      connectionVirtual = p;
      break;
    }
  }
  if (connection === null || connectionVirtual === null) throw new NoFreePortsError();

  const ports: ServerPorts = {
    connection,
    query: connection + 1,
    connectionVirtual,
    queryVirtual: connectionVirtual + 1,
  };
  await tx.insert(schema.serverPorts).values([
    { serverId, kind: 'connection', space: 'host', port: ports.connection },
    { serverId, kind: 'query', space: 'host', port: ports.query },
    { serverId, kind: 'connection_virtual', space: 'virtual', port: ports.connectionVirtual },
    { serverId, kind: 'query_virtual', space: 'virtual', port: ports.queryVirtual },
  ]);
  return ports;
}

export function portsFromRows(rows: { kind: string; port: number }[]): ServerPorts {
  const get = (k: string) => rows.find((r) => r.kind === k)?.port ?? 0;
  return {
    connection: get('connection'),
    query: get('query'),
    connectionVirtual: get('connection_virtual'),
    queryVirtual: get('query_virtual'),
  };
}
