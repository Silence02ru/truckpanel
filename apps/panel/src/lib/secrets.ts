import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Secrets at rest (logon tokens now, Discord webhooks later): AES-256-GCM with ENCRYPTION_KEY.
 * Format: "v1:<iv>:<tag>:<ciphertext>" (base64url). GCM authenticates, so tampering is detected.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes');
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
  }

  open(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split(':');
    if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unknown secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** Keyed so equal tokens collide for the uniqueness index, but the hash alone reveals nothing usable. */
export function secretFingerprint(base64Key: string, value: string): string {
  return createHash('sha256').update(Buffer.from(base64Key, 'base64')).update(value).digest('hex');
}
