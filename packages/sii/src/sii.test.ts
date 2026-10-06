import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SiiError, SiiToken, escapeSiiString, parseSii, renderSii } from './index.js';

// Shape of the config the legacy installer ran in production (legacy/install_ets2_server.sh).
const LEGACY = `SiiNunit
{
server_config : _nameless.integra_ets2 {
 lobby_name: "Example Trucking"
 description: ""
 welcome_message: "\\xd0\\x94\\xd0\\xbe\\xd0\\xb1\\xd1\\x80\\xd0\\xbe\\x20\\xd0\\xbf\\xd0\\xbe\\xd0\\xb6\\xd0\\xb0\\xd0\\xbb\\xd0\\xbe\\xd0\\xb2\\xd0\\xb0\\xd1\\x82\\xd1\\x8c!"
 password: ""
 max_players: 128
 connection_virtual_port: 100
 server_logon_token: 6544F7E034119F113526E96474F
 player_damage: true
 hide_in_company: false
 moderator_list: 2
 moderator_list[0]: 76561198000000001
 moderator_list[1]: 76561198000000002
}
}
`;

describe('escapeSiiString', () => {
  it('escapes non-ASCII as UTF-8 bytes like the legacy installer', () => {
    expect(escapeSiiString('Добро')).toBe('"\\xd0\\x94\\xd0\\xbe\\xd0\\xb1\\xd1\\x80\\xd0\\xbe"');
  });

  it('escapes quotes and backslashes so values cannot break out of the string', () => {
    expect(escapeSiiString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(escapeSiiString('x"\n }\n evil: 1')).not.toContain('\n');
  });
});

describe('parseSii', () => {
  it('reads the legacy production config', () => {
    const [unit] = parseSii(LEGACY);
    expect(unit!.type).toBe('server_config');
    expect(unit!.fields.lobby_name).toBe('Example Trucking');
    expect(unit!.fields.welcome_message).toBe('Добро пожаловать!');
    expect(unit!.fields.max_players).toBe(128);
    expect(unit!.fields.player_damage).toBe(true);
    expect(unit!.fields.server_logon_token).toBe('6544F7E034119F113526E96474F');
    expect(unit!.fields.moderator_list).toEqual(['76561198000000001', '76561198000000002']);
  });

  it('rejects array count mismatch and non-SII input', () => {
    expect(() => parseSii(LEGACY.replace('moderator_list: 2', 'moderator_list: 3'))).toThrow(SiiError);
    expect(() => parseSii('hello')).toThrow(SiiError);
  });

  it('ignores comments', () => {
    const [unit] = parseSii('SiiNunit\n{\nx : _nameless.a {\n a: 1 // comment\n}\n}\n');
    expect(unit!.fields.a).toBe(1);
  });
});

describe('renderSii', () => {
  it('round-trips through the parser', () => {
    const text = renderSii([
      {
        type: 'server_config',
        name: '_nameless.truckpanel',
        fields: {
          lobby_name: 'Сервер "ETS2"',
          max_players: 128,
          traffic: true,
          server_logon_token: new SiiToken('6544F7E034119F113526E96474F'),
          moderator_list: [new SiiToken('76561198000000001')],
        },
      },
    ]);
    const [unit] = parseSii(text);
    expect(unit!.fields.lobby_name).toBe('Сервер "ETS2"');
    expect(unit!.fields.max_players).toBe(128);
    expect(unit!.fields.traffic).toBe(true);
    expect(text).toContain(' moderator_list: 1\n moderator_list[0]: 76561198000000001');
    expect(unit!.fields.moderator_list).toEqual(['76561198000000001']);
    expect(text).toContain(' server_logon_token: 6544F7E034119F113526E96474F');
  });

  it('refuses invalid identifiers and tokens instead of writing a broken file', () => {
    expect(() => new SiiToken('abc\n evil: 1')).toThrow(SiiError);
    expect(() => renderSii([{ type: 'server_config', name: 'x y', fields: {} }])).toThrow(SiiError);
    expect(() => renderSii([{ type: 'server_config', name: '_nameless.a', fields: { 'bad key': 1 } }])).toThrow(SiiError);
    expect(() => renderSii([{ type: 'server_config', name: '_nameless.a', fields: { a: Number.NaN } }])).toThrow(SiiError);
  });
});

describe('real DS 1.61 output', () => {
  it('parses the config the dedicated server generates itself', () => {
    // Captured on the test VPS (docs/research/scs-dedicated-server.md): dotted unit name,
    // quoted empty logon token, empty moderator list, blank line before the closing brace.
    const generated = `SiiNunit
{
server_config : _nameless.50a.92e0 {
 lobby_name: "Euro Truck Simulator 2 server"
 max_players: 8
 server_logon_token: ""
 timezones: 0
 moderator_list: 0
}

}
`;
    const [unit] = parseSii(generated, { arrays: ['moderator_list'] });
    expect(unit!.name).toBe('_nameless.50a.92e0');
    expect(unit!.fields.server_logon_token).toBe('');
    expect(unit!.fields.max_players).toBe(8);
    expect(unit!.fields.timezones).toBe(0);
    expect(unit!.fields.moderator_list).toEqual([]);
  });
});

describe('empty arrays need a schema hint', () => {
  it('without the hint an empty list is just a number', () => {
    const [unit] = parseSii('SiiNunit\n{\nx : _nameless.a {\n moderator_list: 0\n}\n}\n');
    expect(unit!.fields.moderator_list).toBe(0);
  });
});

describe('real server_packages.sii exported by the game (owner fixtures, no mods)', () => {
  const load = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const arrays = ['dlc_essential_list', 'dlc_non_essential_list', 'mod_list'];

  it('ETS2: europe map, 10 DLC, no mods; large ids stay exact', () => {
    const [unit] = parseSii(load('ets2_server_packages.sii'), { arrays });
    expect(unit!.type).toBe('server_packages_info');
    expect(unit!.fields.map_name).toBe('/map/europe.mbd');
    expect(unit!.fields.dlc_non_essential_list).toHaveLength(10);
    expect(unit!.fields.mod_list).toEqual([]);
    expect(unit!.fields.map_dimensions).toBe('(-24576000, -31744000, 20480000, 22528000)');
  });

  it('ATS: usa map, 20 DLC; ids above 2^53 are kept as strings', () => {
    const [unit] = parseSii(load('ats_server_packages.sii'), { arrays });
    expect(unit!.fields.map_name).toBe('/map/usa.mbd');
    expect(unit!.fields.dlc_non_essential_list).toHaveLength(20);
    expect((unit!.fields.dlc_non_essential_list as unknown[])[0]).toBe('184014387494829129');
  });
});
