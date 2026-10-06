import { GAMES, MAX_PLAYERS, type DiscordLocale, type DiscordSections, type GameId, type ServerState } from '@truckpanel/shared';

/**
 * Status embed. Layout follows the legacy production monitor
 * (legacy/monitor_full_with_mods_instruction.py) without the Yandex Disk link.
 * Limits: https://docs.discord.com/developers/resources/message (embed limits).
 */
export interface DiscordSnapshot {
  name: string;
  game: GameId;
  state: ServerState;
  players: number | null;
  playerNames: string[];
  searchId: string | null;
  gameVersion: string | null;
  /** Container start time, for uptime. */
  startedAt: string | null;
  mods: string[];
  dlc: string[];
}

export interface DiscordField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: DiscordField[];
  footer: { text: string };
  timestamp: string;
}

const LIMIT = { title: 256, fieldValue: 1024, total: 6000 };

const EMOJI: Record<GameId, string> = { ets2: '🚛', ats: '🇺🇸' };

const COLOR = { online: 0x57f287, busy: 0xfee75c, offline: 0xed4245 };

const T = {
  ru: {
    status: {
      ONLINE: '🟢 **СЕРВЕР ОНЛАЙН**',
      STARTING: '🟡 **СЕРВЕР ЗАПУСКАЕТСЯ**',
      STOPPING: '🟡 **СЕРВЕР ОСТАНАВЛИВАЕТСЯ**',
      UPDATING: '🟡 **ИДЁТ ОБНОВЛЕНИЕ**',
      INSTALLING: '🟡 **ИДЁТ УСТАНОВКА**',
      offline: '🔴 **СЕРВЕР ОФФЛАЙН**',
    },
    players: '👥 Игроки',
    game: '🎮 Игра',
    version: '🏷️ Версия',
    uptime: '⏱️ Аптайм',
    searchId: '🔎 Session search id',
    playerList: '👤 Игроки онлайн',
    noPlayers: 'Нет игроков',
    mods: '🧩 Моды',
    noMods: 'Нет активных модов',
    dlc: '📦 DLC',
    noDlc: 'Нет данных о DLC',
    instructions: '📖 Как найти сервер',
    more: (n: number) => `… и ещё ${n}`,
    days: 'д',
    hours: 'ч',
    minutes: 'мин',
    documents: 'Мои документы',
    howto: (cfg: string) =>
      `Отредактируйте **config.cfg**:\n\`${cfg}\`\n\n` +
      'Замените:\n```\nuset g_max_convoy_size "8"\n```\n→ **8** на **128**\n\n' +
      '```\nuset r_buffer_page_size "10"\n```\n→ **10** на **30**\n\n' +
      '⚙️ В «Фильтре сессий» включите **«Сессия с модами»**',
    online: (n: string) => `🟢 **${n}** снова онлайн`,
    offline: (n: string) => `🔴 **${n}** недоступен`,
  },
  en: {
    status: {
      ONLINE: '🟢 **SERVER ONLINE**',
      STARTING: '🟡 **SERVER STARTING**',
      STOPPING: '🟡 **SERVER STOPPING**',
      UPDATING: '🟡 **UPDATING**',
      INSTALLING: '🟡 **INSTALLING**',
      offline: '🔴 **SERVER OFFLINE**',
    },
    players: '👥 Players',
    game: '🎮 Game',
    version: '🏷️ Version',
    uptime: '⏱️ Uptime',
    searchId: '🔎 Session search id',
    playerList: '👤 Players online',
    noPlayers: 'Nobody online',
    mods: '🧩 Mods',
    noMods: 'No active mods',
    dlc: '📦 DLC',
    noDlc: 'No DLC data',
    instructions: '📖 How to find the server',
    more: (n: number) => `… and ${n} more`,
    days: 'd',
    hours: 'h',
    minutes: 'min',
    documents: 'Documents',
    howto: (cfg: string) =>
      `Edit **config.cfg**:\n\`${cfg}\`\n\n` +
      'Change:\n```\nuset g_max_convoy_size "8"\n```\n→ **8** to **128**\n\n' +
      '```\nuset r_buffer_page_size "10"\n```\n→ **10** to **30**\n\n' +
      '⚙️ In the session filter enable **"Session with mods"**',
    online: (n: string) => `🟢 **${n}** is back online`,
    offline: (n: string) => `🔴 **${n}** is unavailable`,
  },
} as const;

/** Text from the game log or users: no markdown, no mentions. */
export function escapeText(s: string): string {
  return s
    .replace(/[\\*_~`|>#[\]()-]/g, (c) => `\\${c}`)
    .replace(/@/g, '@​')
    .replace(/[\r\n]+/g, ' ');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function bulletList(items: string[], empty: string, more: (n: number) => string): string {
  if (items.length === 0) return empty;
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const line = `• ${escapeText(items[i]!)}`;
    if (used + line.length + 1 > LIMIT.fieldValue - 40) {
      lines.push(`• ${more(items.length - i)}`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export function formatUptime(ms: number, locale: DiscordLocale): string {
  const t = T[locale];
  const min = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}${t.days} ${h}${t.hours}`;
  if (h > 0) return `${h}${t.hours} ${m}${t.minutes}`;
  return `${m} ${t.minutes}`;
}

function statusOf(state: ServerState): { text: keyof (typeof T)['ru']['status']; color: number } {
  if (state === 'ONLINE') return { text: 'ONLINE', color: COLOR.online };
  if (state === 'STARTING' || state === 'STOPPING' || state === 'UPDATING' || state === 'INSTALLING') return { text: state, color: COLOR.busy };
  return { text: 'offline', color: COLOR.offline };
}

export function buildEmbed(s: DiscordSnapshot, sections: DiscordSections, locale: DiscordLocale, now = new Date()): DiscordEmbed {
  const t = T[locale];
  const game = GAMES[s.game].label;
  const online = s.state === 'ONLINE';
  const status = statusOf(s.state);
  const players = online ? (s.players ?? s.playerNames.length) : 0;

  const fields: DiscordField[] = [
    { name: t.players, value: `**${players} / ${MAX_PLAYERS}**`, inline: true },
    { name: t.game, value: game, inline: true },
  ];
  if (sections.version && s.gameVersion) fields.push({ name: t.version, value: escapeText(s.gameVersion), inline: true });
  if (sections.uptime && online && s.startedAt) {
    fields.push({ name: t.uptime, value: formatUptime(now.getTime() - Date.parse(s.startedAt), locale), inline: true });
  }
  if (sections.searchId && online && s.searchId) fields.push({ name: t.searchId, value: `\`${s.searchId.replace(/`/g, '')}\``, inline: false });

  const optional: { key: keyof DiscordSections; field: DiscordField }[] = [];
  if (sections.playerList && online) {
    optional.push({ key: 'playerList', field: { name: t.playerList, value: bulletList(s.playerNames, t.noPlayers, t.more), inline: false } });
  }
  if (sections.mods) optional.push({ key: 'mods', field: { name: t.mods, value: bulletList(s.mods, t.noMods, t.more), inline: false } });
  if (sections.dlc) optional.push({ key: 'dlc', field: { name: t.dlc, value: bulletList(s.dlc, t.noDlc, t.more), inline: false } });
  if (sections.instructions) {
    const cfg = `${t.documents}/${game}/config.cfg`;
    optional.push({ key: 'instructions', field: { name: t.instructions, value: t.howto(cfg), inline: false } });
  }

  const embed: DiscordEmbed = {
    title: truncate(`${EMOJI[s.game]} ${s.name} — ${game}`, LIMIT.title),
    description: t.status[status.text],
    color: status.color,
    fields: [...fields, ...optional.map((o) => o.field)].map((f) => ({ ...f, value: truncate(f.value, LIMIT.fieldValue) })),
    footer: { text: `TruckPanel · ${s.game.toUpperCase()}` },
    timestamp: now.toISOString(),
  };
  // Total size limit: drop the longest optional lists first.
  for (const drop of ['dlc', 'mods', 'playerList'] as const) {
    if (embedSize(embed) <= LIMIT.total) break;
    const idx = optional.find((o) => o.key === drop);
    if (idx) embed.fields = embed.fields.filter((f) => f.name !== idx.field.name);
  }
  return embed;
}

export function embedSize(e: DiscordEmbed): number {
  return e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

export function statusNotice(name: string, online: boolean, locale: DiscordLocale): string {
  return online ? T[locale].online(escapeText(name)) : T[locale].offline(escapeText(name));
}
