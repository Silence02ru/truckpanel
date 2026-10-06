import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Minimal tar.gz writer/reader for backup archives (docs/PHASE-7.md §7.4). POSIX ustar,
 * regular files only.
 *
 * The reader is deliberately strict because users can upload archives:
 * - only names from the caller's allowlist (exact match, so no "..", no absolute paths);
 * - only regular files (typeflag '0'/NUL): symlinks, hardlinks, devices, directories, PAX and
 *   GNU long-name headers are rejected;
 * - header checksums are verified, duplicates refused, sizes and the unpacked total are capped
 *   (gzip bombs stop at `maxBytes`).
 */
export class ArchiveError extends Error {}

const BLOCK = 512;

function octal(value: number, length: number): Buffer {
  const s = value.toString(8).padStart(length - 1, '0');
  if (s.length > length - 1) throw new ArchiveError('Value too large for a tar header');
  return Buffer.from(`${s}\0`, 'ascii');
}

function header(name: string, size: number, mtime: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new ArchiveError(`Name too long: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  octal(0o640, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(Math.floor(mtime / 1000), 12).copy(h, 136);
  h.fill(' ', 148, 156); // checksum placeholder
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(h, 148);
  return h;
}

export function buildArchive(entries: { name: string; data: Buffer }[], now = Date.now()): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e.name, e.data.length, now), e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts));
}

function readOctal(buf: Buffer, start: number, length: number): number {
  const s = buf.toString('ascii', start, start + length).replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(s)) throw new ArchiveError('Corrupted tar header');
  return s === '' ? 0 : parseInt(s, 8);
}

export function readArchive(gz: Buffer, opts: { allowed: ReadonlySet<string>; maxBytes: number }): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: opts.maxBytes });
  } catch {
    throw new ArchiveError('Not a gzip archive or larger than allowed.');
  }
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break; // end of archive
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (readOctal(h, 148, 8) !== sum) throw new ArchiveError('Corrupted tar header (checksum).');
    const type = String.fromCharCode(h[156]!);
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const base = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const name = prefix ? `${prefix}/${base}` : base;
    if (type !== '0' && type !== '\0') throw new ArchiveError(`Only regular files are allowed (entry "${name}").`);
    if (!opts.allowed.has(name)) throw new ArchiveError(`Unexpected file in the archive: "${name}".`);
    if (out.has(name)) throw new ArchiveError(`Duplicate file in the archive: "${name}".`);
    const size = readOctal(h, 124, 12);
    const start = off + BLOCK;
    if (start + size > tar.length) throw new ArchiveError('Truncated archive.');
    out.set(name, Buffer.from(tar.subarray(start, start + size)));
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
