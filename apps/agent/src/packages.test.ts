import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { history, restore, snapshot } from './packages.js';
import { PathError, serverFilePath, serverPaths, type ServerPaths } from './paths.js';

const ID = '11111111-2222-3333-4444-555555555555';

describe('server_packages history', () => {
  let root: string;
  let paths: ServerPaths;

  const put = async (sii: string, dat: string) => {
    await mkdir(paths.dataDir, { recursive: true });
    await writeFile(serverFilePath(paths, 'server_packages.sii'), sii);
    await writeFile(serverFilePath(paths, 'server_packages.dat'), dat);
  };
  const current = async () => (await readFile(serverFilePath(paths, 'server_packages.sii'))).toString();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tp-pkg-'));
    paths = serverPaths(root, ID, 'ets2');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('snapshots nothing until both files exist', async () => {
    expect(await snapshot(paths)).toBeNull();
    expect(await history(paths)).toEqual([]);
  });

  it('snapshots, lists newest first, restores and keeps 5 versions', async () => {
    const versions: string[] = [];
    for (let i = 1; i <= 7; i++) {
      await put(`SiiNunit v${i}`, `dat${i}`);
      const v = await snapshot(paths, new Date(Date.UTC(2026, 9, 6, 12, 0, i)));
      versions.push(v!.version);
      expect(v!.sii.size).toBe(`SiiNunit v${i}`.length);
    }
    const list = await history(paths);
    expect(list.map((v) => v.version)).toEqual(versions.slice(2).reverse());
    expect(await readdir(join(paths.root, 'packages-history'))).toHaveLength(5);

    await put('SiiNunit new', 'datN');
    await restore(paths, versions[3]!);
    expect(await current()).toBe('SiiNunit v4');
    expect((await readFile(serverFilePath(paths, 'server_packages.dat'))).toString()).toBe('dat4');
  });

  it('two snapshots in the same millisecond get different versions', async () => {
    await put('SiiNunit a', 'a');
    const at = new Date(Date.UTC(2026, 9, 6));
    const a = await snapshot(paths, at);
    const b = await snapshot(paths, at);
    expect(a!.version).not.toBe(b!.version);
  });

  it('refuses versions that are not timestamps (no path traversal)', async () => {
    for (const bad of ['../../etc', '..', '20261006T120000000Z/../../x', '']) {
      await expect(restore(paths, bad)).rejects.toBeInstanceOf(PathError);
    }
  });

  it('restoring a missing version changes nothing', async () => {
    await put('SiiNunit keep', 'keep');
    await expect(restore(paths, '20200101T000000000Z')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await current()).toBe('SiiNunit keep');
  });
});
