import { resolve, sep } from 'node:path';
import { GAMES, type GameId, type ServerFile } from '@truckpanel/shared';

export const SERVER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PathError extends Error {}

/** Resolves `rel` under `root` and refuses anything that escapes it (../, absolute paths). */
export function resolveInside(root: string, ...rel: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...rel);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new PathError(`Path escapes the server directory: ${rel.join('/')}`);
  }
  return target;
}

export interface ServerPaths {
  root: string;
  game: string;
  home: string;
  dataDir: string;
}

export function serverPaths(serversRoot: string, id: string, game: GameId): ServerPaths {
  if (!SERVER_ID_RE.test(id)) throw new PathError('Invalid server id');
  const root = resolveInside(serversRoot, id);
  const home = resolveInside(root, 'home');
  return {
    root,
    game: resolveInside(root, 'game'),
    home,
    // XDG_DATA_HOME=/srv/home → "<home>/Euro Truck Simulator 2"
    dataDir: resolveInside(home, GAMES[game].dataDir),
  };
}

export function serverFilePath(paths: ServerPaths, file: ServerFile): string {
  return resolveInside(paths.dataDir, file);
}
