# Steam profile links → SteamID64 (session moderators)

Date checked: 2026-10-05

## Sources

| What | URL | Status |
|---|---|---|
| Session moderators (`moderator_list`, promoted on join) | https://modding.scssoft.com/wiki/Documentation/Tools/Dedicated_Server | primary |
| Public profile XML | `https://steamcommunity.com/id/<name>/?xml=1` | works, public, no key |
| Official vanity resolution | `ISteamUser/ResolveVanityURL` (Steam Web API) | requires a Web API key |

## Facts

- `https://steamcommunity.com/id/gabelogannewell/?xml=1` returned `<profile>` with
  `<steamID64>76561197960287930</steamID64>` and `<steamID>` (display name). Checked with WebFetch.
- `https://steamcommunity.com/profiles/<17 digits>` already contains the SteamID64; no request needed.
- The Valve Developer wiki page for the Steam Web API answers 403 to automated fetches; the
  ResolveVanityURL details must be checked in a browser before implementing that path.
- `moderator_list` takes SteamID64 values (wiki example; the legacy production config used two IDs).
  Moderators are promoted automatically when they join; there is no runtime command.

## Decisions (phase 4)

- Accept `/profiles/<id64>`, `/id/<name>` (also with trailing slash or query) and bare SteamID64.
  Reject everything else before any network call.
- Resolve `/id/<name>` via the public XML. If an admin sets a Steam Web API key, use ResolveVanityURL
  instead (documented, rate-limited by Valve).
- Fixed host allowlist: `steamcommunity.com`, `api.steampowered.com`. No redirects to other hosts,
  short timeout, response size limit.
- SteamID64 sanity: 17 digits, starts with `7656119` (individual accounts).
- Store `{ steamId64, name, addedBy, addedAt }`. Only the ID is rendered into `moderator_list`;
  names are for the UI. SteamID64 stays a string everywhere: it exceeds 2^53.
- profile XML for an unknown /id/<name>: `<response><error>The specified profile could not be found.</error></response>` (checked 2026-10-06) → reported as not found.
