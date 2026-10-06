/**
 * Minimal reader/writer for SCS text SII units (`SiiNunit { type : name { key: value } }`),
 * enough for server_config.sii. Format reference: the SCS dedicated server wiki example and
 * the config our legacy installer ran in production (docs/research/scs-dedicated-server.md).
 *
 * Strings are written as UTF-8 with every non-ASCII byte escaped as \xNN, plus \" and \\,
 * exactly like the legacy installer did for Cyrillic text.
 */

export type SiiScalar = string | number | boolean;
export type SiiValue = SiiScalar | SiiScalar[];

/** Marks a value that must be written as a quoted string even if it looks numeric. */
export class SiiString {
  constructor(readonly value: string) {}
}

/** Unquoted token: Steam IDs, logon tokens (written bare, as in the SCS wiki example). */
export class SiiToken {
  constructor(readonly value: string) {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new SiiError(`Invalid SII token: ${value}`);
  }
}

export type SiiItem = SiiScalar | SiiString | SiiToken;
export type SiiField = SiiItem | SiiItem[];

export interface SiiUnit {
  type: string;
  name: string;
  fields: Record<string, SiiField>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNIT_NAME = /^[A-Za-z0-9_.]+$/;

export class SiiError extends Error {}

export function escapeSiiString(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += '\\\\';
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return `"${out}"`;
}

function renderScalar(value: SiiItem): string {
  if (value instanceof SiiString) return escapeSiiString(value.value);
  if (value instanceof SiiToken) return value.value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SiiError(`Non-finite number: ${value}`);
    return Number.isInteger(value) ? String(value) : value.toString();
  }
  return escapeSiiString(value);
}

export function renderSii(units: SiiUnit[]): string {
  const lines = ['SiiNunit', '{'];
  for (const unit of units) {
    if (!IDENT.test(unit.type)) throw new SiiError(`Invalid unit type: ${unit.type}`);
    if (!UNIT_NAME.test(unit.name)) throw new SiiError(`Invalid unit name: ${unit.name}`);
    lines.push(`${unit.type} : ${unit.name} {`);
    for (const [key, value] of Object.entries(unit.fields)) {
      if (!IDENT.test(key)) throw new SiiError(`Invalid key: ${key}`);
      if (Array.isArray(value)) {
        lines.push(` ${key}: ${value.length}`);
        value.forEach((item, i) => lines.push(` ${key}[${i}]: ${renderScalar(item)}`));
      } else {
        lines.push(` ${key}: ${renderScalar(value)}`);
      }
    }
    lines.push('}');
  }
  lines.push('}', '');
  return lines.join('\n');
}

function unescapeSiiString(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      const next = body[i + 1]!;
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
        bytes.push(parseInt(body.slice(i + 2, i + 4), 16));
        i += 3;
        continue;
      }
      if (next === '"' || next === '\\') {
        bytes.push(next.charCodeAt(0));
        i += 1;
        continue;
      }
    }
    for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseScalar(raw: string): SiiScalar {
  const v = raw.trim();
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new SiiError(`Unterminated string: ${v}`);
    return unescapeSiiString(v.slice(1, -1));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    // Steam IDs exceed 2^53: keep them exact as strings.
    return Number.isSafeInteger(n) ? n : v;
  }
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v; // tokens/ids are kept verbatim (e.g. server_logon_token without quotes)
}

export interface ParseOptions {
  /**
   * Keys that are arrays even when empty. "moderator_list: 0" with no [i] lines is
   * syntactically just a number, so the caller (who knows the schema) must say so.
   */
  arrays?: readonly string[];
}

/** Parses SII text into units. Arrays come back as ordered lists; the count line is validated. */
export function parseSii(text: string, options: ParseOptions = {}): SiiUnit[] {
  const arrayKeys = new Set(options.arrays ?? []);
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s*\/\/.*$/, '').replace(/\s*#.*$/, '').trim())
    .filter(Boolean);
  if (lines[0] !== 'SiiNunit') throw new SiiError('Not a SII text file (missing SiiNunit header).');

  const units: SiiUnit[] = [];
  let current: SiiUnit | null = null;
  const counts = new Map<string, number>();

  for (const line of lines.slice(1)) {
    if (line === '{') continue;
    const header = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_.]+)\s*\{$/.exec(line);
    if (header) {
      current = { type: header[1]!, name: header[2]!, fields: {} };
      counts.clear();
      continue;
    }
    if (line === '}') {
      if (current) {
        for (const [key, n] of counts) {
          const arr = current.fields[key];
          if (!Array.isArray(arr) || arr.length !== n) {
            throw new SiiError(`Array ${key}: declared ${n} items, found ${Array.isArray(arr) ? arr.length : 0}.`);
          }
        }
        units.push(current);
        current = null;
      }
      continue;
    }
    if (!current) throw new SiiError(`Unexpected line outside a unit: ${line}`);
    const field = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d*)\])?\s*:\s*(.*)$/.exec(line);
    if (!field) throw new SiiError(`Cannot parse line: ${line}`);
    const [, key, index, raw] = field as unknown as [string, string, string | undefined, string];
    if (index !== undefined) {
      const arr = (Array.isArray(current.fields[key]) ? current.fields[key] : []) as SiiScalar[];
      const value = parseScalar(raw);
      if (index === '') arr.push(value);
      else arr[Number(index)] = value;
      current.fields[key] = arr;
    } else {
      const value = parseScalar(raw);
      // "key: N" followed by key[i] lines declares an array; remember N and validate at '}'.
      if (typeof value === 'number' && (arrayKeys.has(key) || lines.some((l) => l.startsWith(`${key}[`)))) {
        counts.set(key, value);
        current.fields[key] = (current.fields[key] as SiiScalar[] | undefined) ?? [];
      } else {
        current.fields[key] = value;
      }
    }
  }
  if (current) throw new SiiError(`Unit ${current.name} is not closed.`);
  return units;
}
