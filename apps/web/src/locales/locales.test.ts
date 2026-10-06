import { ERROR_CODES, ROLES } from '@truckpanel/shared';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import ru from './ru.json';

type Tree = { [key: string]: string | Tree };

function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
  );
}

function lookup(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree);
}

describe('locales', () => {
  it('ru and en have the same keys', () => {
    expect(keys(ru).sort()).toEqual(keys(en).sort());
  });

  it.each([
    ['ru', ru],
    ['en', en],
  ])('%s translates every API error code and role', (_lang, tree) => {
    for (const code of ERROR_CODES) expect(typeof lookup(tree, `errors.${code}`), code).toBe('string');
    for (const role of ROLES) expect(typeof lookup(tree, `shell.role.${role}`), role).toBe('string');
    expect(typeof lookup(tree, 'errors.network')).toBe('string');
  });
});
