import { readFile, statfs } from 'node:fs/promises';
import type { HostMetrics, ServerMetrics } from '@truckpanel/shared';

/**
 * Host metrics from /proc (proc(5)). /proc/stat and /proc/meminfo are host-wide even inside the
 * agent container; disk is measured on the servers root (where game files live).
 */
export function parseCpuLine(stat: string): { idle: number; total: number } {
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return { idle: 0, total: 0 };
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal ...
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
  const total = nums.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}

export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } {
  const get = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? 0) * 1024;
  return { totalBytes: get('MemTotal'), availableBytes: get('MemAvailable') };
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function hostMetrics(diskPath: string, procRoot = '/proc', sampleMs = 250): Promise<HostMetrics> {
  const a = parseCpuLine(await read(`${procRoot}/stat`));
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = parseCpuLine(await read(`${procRoot}/stat`));
  const dTotal = b.total - a.total;
  const cpuPercent = dTotal > 0 ? Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / dTotal) * 100)) : 0;

  const mem = parseMeminfo(await read(`${procRoot}/meminfo`));
  let diskTotal = 0;
  let diskFree = 0;
  try {
    const fs = await statfs(diskPath);
    diskTotal = fs.blocks * fs.bsize;
    diskFree = fs.bavail * fs.bsize;
  } catch {
    // path missing in development
  }
  const uptime = Number((await read(`${procRoot}/uptime`)).split(' ')[0] ?? 0);
  const cores = (await read(`${procRoot}/stat`)).split('\n').filter((l) => /^cpu\d+ /.test(l)).length;
  return {
    cpuPercent: round(cpuPercent),
    cpuCores: cores,
    memTotalBytes: mem.totalBytes,
    memUsedBytes: Math.max(0, mem.totalBytes - mem.availableBytes),
    diskTotalBytes: diskTotal,
    diskFreeBytes: diskFree,
    uptimeSec: Math.round(uptime),
  };
}

/** Docker stats (API "stats?stream=false"): CPU % as `docker stats` computes it. */
export interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

export function containerMetrics(s: DockerStats): ServerMetrics {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus ?? 1;
  const cpuPercent = cpuDelta > 0 && sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  // Same as the docker CLI: usage minus page cache (inactive_file on cgroup v2, cache on v1).
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  const memUsed = Math.max(0, (s.memory_stats?.usage ?? 0) - cache);
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }
  return {
    cpuPercent: round(cpuPercent),
    memUsedBytes: memUsed,
    memLimitBytes: s.memory_stats?.limit ?? 0,
    netRxBytes: rx,
    netTxBytes: tx,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
