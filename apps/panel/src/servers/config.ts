import { renderSii, SiiString, SiiToken } from '@truckpanel/sii';
import { MAX_PLAYERS, SERVER_CONFIG_DEFAULTS, type ServerConfigValues, type ServerPorts } from '@truckpanel/shared';

/**
 * Renders server_config.sii from typed values (CLAUDE.md §13: no blind text replacement).
 * max_players and all four ports are always taken from the panel, never from user values.
 * The DS rewrites this file on every start (keeps values, new unit name), so we render it
 * before each start from the database, which is the source of truth.
 */
export function renderServerConfig(values: ServerConfigValues, ports: ServerPorts): string {
  const v = { ...SERVER_CONFIG_DEFAULTS, ...values };
  return renderSii([
    {
      type: 'server_config',
      name: '_nameless.truckpanel',
      fields: {
        lobby_name: new SiiString(v.lobby_name),
        description: new SiiString(v.description),
        welcome_message: new SiiString(v.welcome_message),
        password: new SiiString(v.password),
        max_players: MAX_PLAYERS,
        max_vehicles_total: v.max_vehicles_total,
        max_ai_vehicles_player: v.max_ai_vehicles_player,
        max_ai_vehicles_player_spawn: v.max_ai_vehicles_player_spawn,
        connection_virtual_port: ports.connectionVirtual,
        query_virtual_port: ports.queryVirtual,
        connection_dedicated_port: ports.connection,
        query_dedicated_port: ports.query,
        // Empty token is written quoted, exactly as the DS generates it; a real token bare (SCS wiki).
        server_logon_token: v.server_logon_token ? new SiiToken(v.server_logon_token) : new SiiString(''),
        player_damage: v.player_damage,
        traffic: v.traffic,
        hide_in_company: v.hide_in_company,
        hide_colliding: v.hide_colliding,
        force_speed_limiter: v.force_speed_limiter,
        mods_optioning: v.mods_optioning,
        timezones: v.timezones,
        service_no_collision: v.service_no_collision,
        in_menu_ghosting: v.in_menu_ghosting,
        name_tags: v.name_tags,
        friends_only: v.friends_only,
        show_server: v.show_server,
        moderator_list: v.moderator_list.map((id) => new SiiToken(id)),
      },
    },
  ]);
}

const CVAR_LINE = /^(\s*uset\s+)([A-Za-z_][A-Za-z0-9_]*)(\s+)"([^"]*)"(.*)$/;

/**
 * Sets one cvar in config_ds.cfg ("uset name \"value\""), keeping every other line as is.
 * The DS writes the full file (≈229 lines) itself; we only own g_max_convoy_size.
 */
export function setCfgVar(text: string | null, name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /["\r\n]/.test(value)) throw new Error('Invalid cvar');
  const lines = (text ?? '').split('\n');
  let found = false;
  const out = lines.map((line) => {
    const m = CVAR_LINE.exec(line);
    if (m && m[2] === name) {
      found = true;
      return `${m[1]}${name}${m[3]}"${value}"${m[5]}`;
    }
    return line;
  });
  if (!found) {
    if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, `uset ${name} "${value}"`);
    else out.push(`uset ${name} "${value}"`);
  }
  let result = out.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return result;
}
