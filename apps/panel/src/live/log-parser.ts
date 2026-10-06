/**
 * Parses DS console lines into events. Patterns:
 *  - connected/disconnected: the legacy production monitor (legacy/monitor_full_with_mods_instruction.py)
 *  - session start, search id, pack set version: DS 1.61 output captured on the test VPS
 *    (docs/research/scs-dedicated-server.md)
 */
export type LogEvent =
  | { type: 'player_connected'; name: string; clientId: number }
  | { type: 'player_disconnected'; name: string; clientId: number }
  | { type: 'session_started' }
  | { type: 'search_id'; searchId: string }
  | { type: 'game_version'; version: string }
  | { type: 'mod'; name: string }
  | { type: 'dlc'; name: string };

const CONNECTED_RE = /\[MP\]\s+([^\r\n]+?)\s+connected,\s+client_id\s*=\s*(\d+)/;
const DISCONNECTED_RE = /\[MP\]\s+([^\r\n]+?)\s+disconnected,\s+client_id\s*=\s*(\d+)/;
// Legacy monitor reset its player list on "Session automated start"; DS 1.61 also prints "Session started.".
const SESSION_START_RE = /\[MP\]\s+Session (?:automated start|started\.)/;
const SEARCH_ID_RE = /\[MP\] Session search id:\s*(\S+)/;
// Mod/DLC lines: legacy production monitor (printed while the session starts).
const MOD_RE = /\[MP\]\s+MOD\s+-\s*(.*?)\s*$/;
const DLC_RE = /\[MP\]\s+DLC\s+-\s*(.*?)\s*$/;
const VERSION_RE = /\[ufs\] Loaded pack set version (\d+(?:\.\d+){1,3})/;

export function parseLogLine(line: string): LogEvent | null {
  let m = DISCONNECTED_RE.exec(line); // check first: "disconnected" also contains "connected"
  if (m) return { type: 'player_disconnected', name: m[1]!.trim(), clientId: Number(m[2]) };
  m = CONNECTED_RE.exec(line);
  if (m) return { type: 'player_connected', name: m[1]!.trim(), clientId: Number(m[2]) };
  if (SESSION_START_RE.test(line)) return { type: 'session_started' };
  m = SEARCH_ID_RE.exec(line);
  if (m) return { type: 'search_id', searchId: m[1]! };
  m = VERSION_RE.exec(line);
  if (m) return { type: 'game_version', version: m[1]! };
  m = MOD_RE.exec(line);
  if (m && m[1]) return { type: 'mod', name: m[1] };
  m = DLC_RE.exec(line);
  if (m && m[1]) return { type: 'dlc', name: m[1] };
  return null;
}

/** Splits a text stream into complete lines; keeps the trailing partial line for the next chunk. */
export class LineSplitter {
  private pending = '';
  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split(/\r?\n/);
    this.pending = parts.pop() ?? '';
    return parts;
  }
}
