import { createHash } from 'node:crypto';
import { chown, copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { PACKAGE_HISTORY_KEEP, PACKAGE_VERSION_RE, type PackageVersion } from '@truckpanel/shared';
import { PathError, resolveInside, serverFilePath, type ServerPaths } from './paths.js';
import { GAME_UID } from './runtime.js';

/**
 * History of server_packages.sii/.dat (docs/PHASE-7.md §7.3).
 *
 * `<server>/packages-history/<version>/server_packages.{sii,dat}`, outside the game home, so the
 * game container never sees it. `version` is the UTC time of the snapshot (PACKAGE_VERSION_RE)
 * and is the only user-controlled part of a path here: it is validated and resolved inside the
 * history directory. The newest PACKAGE_HISTORY_KEEP versions are kept.
 */
const FILES = ['server_packages.sii', 'server_packages.dat'] as const;

function historyDir(paths: ServerPaths): string {
  return resolveInside(paths.root, 'packages-history');
}

function versionDir(paths: ServerPaths, version: string): string {
  if (!PACKAGE_VERSION_RE.test(version)) throw new PathError('Invalid package version');
  return resolveInside(historyDir(paths), version);
}

export function newVersion(now = new Date()): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

async function describe(file: string): Promise<{ size: number; sha256: string }> {
  const buf = await readFile(file);
  return { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** Copies the current pair into the history; null when there is no complete pair yet. */
export async function snapshot(paths: ServerPaths, now = new Date()): Promise<PackageVersion | null> {
  const current = FILES.map((f) => serverFilePath(paths, f));
  try {
    await Promise.all(current.map((p) => stat(p)));
  } catch {
    return null;
  }
  // Two snapshots in the same millisecond: take the next free millisecond.
  let at = now.getTime();
  while (await stat(versionDir(paths, newVersion(new Date(at)))).then(() => true, () => false)) at++;
  const created = new Date(at);
  const version = newVersion(created);
  const dir = versionDir(paths, version);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  for (const [i, f] of FILES.entries()) await copyFile(current[i]!, resolveInside(dir, f));
  await prune(paths);
  const [sii, dat] = await Promise.all(FILES.map((f) => describe(resolveInside(dir, f))));
  return { version, createdAt: created.toISOString(), sii: sii!, dat: dat! };
}

export async function history(paths: ServerPaths): Promise<PackageVersion[]> {
  let names: string[];
  try {
    names = await readdir(historyDir(paths));
  } catch {
    return [];
  }
  const out: PackageVersion[] = [];
  for (const version of names.filter((n) => PACKAGE_VERSION_RE.test(n)).sort().reverse()) {
    const dir = versionDir(paths, version);
    try {
      const [sii, dat] = await Promise.all(FILES.map((f) => describe(resolveInside(dir, f))));
      const st = await stat(dir);
      out.push({ version, createdAt: st.mtime.toISOString(), sii: sii!, dat: dat! });
    } catch {
      // incomplete entry: ignore
    }
  }
  return out;
}

/** Puts a stored pair back as the current files (atomic rename per file). */
export async function restore(paths: ServerPaths, version: string): Promise<void> {
  const dir = versionDir(paths, version);
  for (const f of FILES) await stat(resolveInside(dir, f)); // both must exist before touching anything
  await mkdir(paths.dataDir, { recursive: true });
  for (const f of FILES) {
    const target = serverFilePath(paths, f);
    const tmp = `${target}.tp-tmp`;
    await copyFile(resolveInside(dir, f), tmp);
    if (process.getuid?.() === 0) await chown(tmp, GAME_UID, GAME_UID);
    await rename(tmp, target);
  }
}

async function prune(paths: ServerPaths): Promise<void> {
  const names = (await readdir(historyDir(paths))).filter((n) => PACKAGE_VERSION_RE.test(n)).sort();
  for (const old of names.slice(0, Math.max(0, names.length - PACKAGE_HISTORY_KEEP))) {
    await rm(versionDir(paths, old), { recursive: true, force: true });
  }
}
