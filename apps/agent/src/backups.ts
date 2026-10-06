import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { PathError, SERVER_ID_RE, resolveInside } from './paths.js';

/**
 * Backup archive storage (docs/PHASE-7.md §7.4): `<backupsRoot>/<serverId>/<backupId>.tar.gz`.
 * The panel builds and checks the archives; the agent only stores bytes. Both ids are UUIDs,
 * validated here and resolved inside the root.
 */
export const BACKUP_ID_RE = SERVER_ID_RE;

function backupPath(root: string, serverId: string, backupId: string): string {
  if (!SERVER_ID_RE.test(serverId) || !BACKUP_ID_RE.test(backupId)) throw new PathError('Invalid backup id');
  return resolveInside(root, serverId, `${backupId}.tar.gz`);
}

export async function storeBackup(root: string, serverId: string, backupId: string, data: Buffer): Promise<{ size: number; sha256: string }> {
  const path = backupPath(root, serverId, backupId);
  await mkdir(resolveInside(root, serverId), { recursive: true, mode: 0o750 });
  const tmp = `${path}.tp-tmp`;
  await writeFile(tmp, data, { mode: 0o640 });
  await rename(tmp, path);
  return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

export async function readBackup(root: string, serverId: string, backupId: string): Promise<Buffer | null> {
  try {
    return await readFile(backupPath(root, serverId, backupId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function deleteBackup(root: string, serverId: string, backupId: string): Promise<void> {
  await rm(backupPath(root, serverId, backupId), { force: true });
}

/** All archives of a server (id → size), for reconciling with the panel database. */
export async function listBackups(root: string, serverId: string): Promise<Record<string, number>> {
  if (!SERVER_ID_RE.test(serverId)) throw new PathError('Invalid server id');
  let names: string[];
  try {
    names = await readdir(resolveInside(root, serverId));
  } catch {
    return {};
  }
  const out: Record<string, number> = {};
  for (const n of names) {
    const m = /^([0-9a-f-]{36})\.tar\.gz$/.exec(n);
    if (!m || !BACKUP_ID_RE.test(m[1]!)) continue;
    out[m[1]!] = (await stat(resolveInside(root, serverId, n))).size;
  }
  return out;
}

/** Removes every archive of a deleted server. */
export async function purgeBackups(root: string, serverId: string): Promise<void> {
  if (!SERVER_ID_RE.test(serverId)) throw new PathError('Invalid server id');
  await rm(resolveInside(root, serverId), { recursive: true, force: true });
}
