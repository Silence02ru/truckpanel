/**
 * Parses SteamCMD output into progress events. Line formats observed on the test VPS
 * (docs/research/scs-dedicated-server.md):
 *   " Update state (0x61) downloading, progress: 42.17 (566 / 1343127998)"
 *   " Update state (0x81) verifying update, progress: 95.84 (1287317908 / 1343127998)"
 *   "Success! App '1948160' fully installed."
 */
export interface SteamProgress {
  stage: string;
  percent: number;
}

const PROGRESS_RE = /Update state \(0x[0-9a-f]+\) ([a-z ]+), progress: (\d+(?:\.\d+)?)/i;
const SUCCESS_RE = /Success! App '(\d+)' fully installed\./;
const ERROR_RE = /^ERROR!|Error! App '\d+' state is|failed \(No subscription\)|Failed to install app/i;

export function parseProgress(line: string): SteamProgress | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  // SteamCMD ends with "Update state (0x0) unknown, progress: 0.00 (0 / 0)" (seen on the VPS):
  // not real progress, and it would drop the UI bar back to 0%.
  if (m[1]!.trim() === 'unknown') return null;
  const percent = Math.min(100, Math.max(0, Number(m[2])));
  return { stage: m[1]!.trim(), percent };
}

export function isSuccessLine(line: string, appId: number): boolean {
  const m = SUCCESS_RE.exec(line);
  return m !== null && Number(m[1]) === appId;
}

export function isErrorLine(line: string): boolean {
  return ERROR_RE.test(line.trim());
}

/** SteamCMD paints the terminal with ANSI codes and \r; strip them for parsing and logs. */
export function cleanLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trim();
}
