import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet: argon2id, m=19 MiB, t=2, p=1 (minimum recommended).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Used for unknown users so response timing does not reveal whether an account exists.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('truckpanel-dummy-password');
  await verifyPassword(await dummyHash, password);
}
