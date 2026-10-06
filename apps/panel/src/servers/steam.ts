import { STEAM_ID64_RE } from '@truckpanel/shared';

/**
 * Turns a Steam profile link or SteamID64 into a SteamID64 (docs/research/steam-profiles.md).
 *   https://steamcommunity.com/profiles/7656119XXXXXXXXXX  → taken from the URL, no request
 *   https://steamcommunity.com/id/<name>                    → public profile XML (?xml=1)
 *   7656119XXXXXXXXXX                                        → as is
 * Requests go only to steamcommunity.com (SSRF): the URL is rebuilt from the parsed name, never
 * fetched as given, redirects are not followed, the body is size-limited and time-limited.
 */
export interface ResolvedProfile {
  steamId64: string;
  name: string | null;
  profileUrl: string;
}

export class SteamLinkError extends Error {
  constructor(
    readonly reason: 'invalid_link' | 'not_found' | 'lookup_failed',
    message: string,
  ) {
    super(message);
  }
}

export type FetchFn = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

const VANITY_RE = /^[A-Za-z0-9_-]{2,64}$/;
const MAX_XML_BYTES = 256 * 1024;

export type ParsedInput = { kind: 'id64'; steamId64: string } | { kind: 'vanity'; name: string };

export function parseSteamInput(raw: string): ParsedInput {
  const input = raw.trim();
  if (STEAM_ID64_RE.test(input)) return { kind: 'id64', steamId64: input };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new SteamLinkError('invalid_link', 'Paste a Steam profile link or a SteamID64.');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'steamcommunity.com' && host !== 'www.steamcommunity.com') {
    throw new SteamLinkError('invalid_link', 'Only steamcommunity.com profile links are accepted.');
  }
  const [kind, value] = url.pathname.split('/').filter(Boolean);
  if (kind === 'profiles' && value && STEAM_ID64_RE.test(value)) return { kind: 'id64', steamId64: value };
  if (kind === 'id' && value && VANITY_RE.test(value)) return { kind: 'vanity', name: value };
  throw new SteamLinkError('invalid_link', 'Use a link like steamcommunity.com/profiles/7656… or steamcommunity.com/id/name.');
}

function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`).exec(xml);
  return m ? m[1]!.trim() : null;
}

async function fetchProfileXml(fetchFn: FetchFn, path: string, timeoutMs: number): Promise<string> {
  const url = `https://steamcommunity.com/${path}/?xml=1`;
  let res;
  try {
    res = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new SteamLinkError('lookup_failed', 'Steam did not answer. Try again later or paste the SteamID64.');
  }
  if (res.status !== 200) throw new SteamLinkError('lookup_failed', `Steam answered with HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > MAX_XML_BYTES) throw new SteamLinkError('lookup_failed', 'Unexpected answer from Steam.');
  return text;
}

export async function resolveSteamProfile(raw: string, fetchFn: FetchFn, timeoutMs = 5000): Promise<ResolvedProfile> {
  const parsed = parseSteamInput(raw);
  if (parsed.kind === 'id64') {
    // The name is a convenience; a failed lookup must not block adding a valid id.
    let name: string | null = null;
    try {
      name = xmlTag(await fetchProfileXml(fetchFn, `profiles/${parsed.steamId64}`, timeoutMs), 'steamID');
    } catch {
      name = null;
    }
    return { steamId64: parsed.steamId64, name, profileUrl: `https://steamcommunity.com/profiles/${parsed.steamId64}` };
  }
  const xml = await fetchProfileXml(fetchFn, `id/${encodeURIComponent(parsed.name)}`, timeoutMs);
  const id = xmlTag(xml, 'steamID64');
  if (!id || !STEAM_ID64_RE.test(id)) {
    throw new SteamLinkError('not_found', `No Steam profile found for "${parsed.name}".`);
  }
  return { steamId64: id, name: xmlTag(xml, 'steamID'), profileUrl: `https://steamcommunity.com/profiles/${id}` };
}
