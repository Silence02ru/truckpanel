import { readFile } from 'node:fs/promises';

/**
 * Ports in use on the host, read from /proc/net (the agent runs with network_mode: host).
 * Format (proc(5)): "sl local_address rem_address st ..." with local_address = HEXIP:HEXPORT.
 *   TCP: state 0A = LISTEN.  UDP: every bound socket counts (state 07 = unconnected).
 */
const TCP_LISTEN = '0A';

export function parseProcNet(text: string, proto: 'tcp' | 'udp'): number[] {
  const ports = new Set<number>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1]!;
    const state = cols[3]!;
    if (proto === 'tcp' && state !== TCP_LISTEN) continue;
    const hexPort = local.split(':')[1];
    if (!hexPort) continue;
    const port = parseInt(hexPort, 16);
    if (port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function hostPorts(procRoot = '/proc'): Promise<{ tcp: number[]; udp: number[] }> {
  const [tcp4, tcp6, udp4, udp6] = await Promise.all([
    readOptional(`${procRoot}/net/tcp`),
    readOptional(`${procRoot}/net/tcp6`),
    readOptional(`${procRoot}/net/udp`),
    readOptional(`${procRoot}/net/udp6`),
  ]);
  const merge = (a: number[], b: number[]) => [...new Set([...a, ...b])].sort((x, y) => x - y);
  return {
    tcp: merge(parseProcNet(tcp4, 'tcp'), parseProcNet(tcp6, 'tcp')),
    udp: merge(parseProcNet(udp4, 'udp'), parseProcNet(udp6, 'udp')),
  };
}
