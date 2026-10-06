import { describe, expect, it } from 'vitest';
import { PERMISSIONS, SERVER_PERMISSIONS, SERVER_ROLES, can, canOnServer, serverPermissionsOf } from './permissions.js';

describe('access model', () => {
  it('administrator has every permission, on every server', () => {
    for (const p of PERMISSIONS) expect(can('administrator', p)).toBe(true);
    for (const p of SERVER_PERMISSIONS) expect(canOnServer('administrator', p)).toBe(true);
  });

  it('users have no global admin rights', () => {
    for (const p of ['users.manage', 'settings.manage', 'diagnostics.run', 'server.create'] as const) expect(can('user', p)).toBe(false);
  });

  it('server roles are strictly nested: viewer ⊂ moderator ⊂ manager ⊂ owner', () => {
    for (let i = SERVER_ROLES.length - 1; i > 0; i--) {
      const lower = serverPermissionsOf(SERVER_ROLES[i]!);
      const higher = serverPermissionsOf(SERVER_ROLES[i - 1]!);
      for (const p of lower) expect(higher).toContain(p);
      expect(higher.length).toBeGreaterThan(lower.length);
    }
  });

  it('only the owner manages members and deletes the server', () => {
    for (const p of ['server.members', 'server.delete'] as const) {
      expect(canOnServer('owner', p)).toBe(true);
      expect(canOnServer('manager', p)).toBe(false);
    }
  });

  it('moderator can power-cycle but not edit config or files; non-members nothing', () => {
    expect(canOnServer('moderator', 'server.power')).toBe(true);
    expect(canOnServer('moderator', 'server.moderators')).toBe(true);
    expect(canOnServer('moderator', 'server.config')).toBe(false);
    expect(canOnServer('moderator', 'server.files')).toBe(false);
    expect(canOnServer(null, 'server.view')).toBe(false);
  });
});
