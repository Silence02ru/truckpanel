import { SiiString, parseSii, type SiiField } from '@truckpanel/sii';
import type { PackagesInfo } from '@truckpanel/shared';
import { AppError } from '../lib/errors.js';

/**
 * Reads what a server_packages.sii export contains. The structure (unit `server_packages_info`
 * with `map_name`, `dlc_essential_list`, `dlc_non_essential_list`, `mod_list`) comes from the
 * real ETS2/ATS exports in packages/sii/src/fixtures (DS 1.61). Anything else is rejected:
 * the DS would refuse to start with it anyway.
 */
const ARRAYS = ['dlc_essential_list', 'dlc_non_essential_list', 'mod_list'];

function count(v: SiiField | undefined): number {
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' ? v : 0;
}

export function describePackages(buf: Buffer): PackagesInfo {
  const invalid = (why: string) => new AppError(400, 'server.packages_invalid', `server_packages.sii is not a server packages export: ${why}`);
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (!text.startsWith('SiiNunit')) throw invalid('it does not start with SiiNunit (export it from the game console with export_server_packages).');
  let units;
  try {
    units = parseSii(text, { arrays: ARRAYS });
  } catch {
    throw invalid('the file could not be parsed.');
  }
  const unit = units.find((u) => u.type === 'server_packages_info');
  if (!unit) throw invalid('the server_packages_info unit is missing.');
  const map = unit.fields.map_name;
  const mapName = map instanceof SiiString ? map.value : typeof map === 'string' ? map : null;
  return {
    map: mapName,
    dlc: count(unit.fields.dlc_essential_list) + count(unit.fields.dlc_non_essential_list),
    mods: count(unit.fields.mod_list),
  };
}
