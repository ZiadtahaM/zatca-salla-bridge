import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // Standard GCM 96-bit nonce
const AUTH_TAG_LENGTH_BYTES = 16; // Standard GCM 128-bit authentication tag

function getMasterKey(): Buffer {
  const envKey = process.env.ENCRYPTION_MASTER_KEY || 'default_zatca_vault_master_key_32_bytes_len!';
  if (Buffer.from(envKey, 'hex').length === 32) {
    return Buffer.from(envKey, 'hex');
  }
  // Deterministic 32-byte SHA-256 derivation if passphrase or utf8 string provided
  return createHash('sha256').update(envKey, 'utf8').digest();
}

/**
 * Encrypts sensitive secrets (private keys, CSID secrets, merchant OAuth tokens) using AES-256-GCM.
 * Output format: v1:iv_hex:auth_tag_hex:ciphertext_hex
 */
export function encryptVaultSecret(plaintext: string): string {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty plaintext');
  }

  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts AES-256-GCM vault secrets and verifies authentication tag integrity.
 */
export function decryptVaultSecret(payload: string): string {
  if (!payload || !payload.startsWith('v1:')) {
    throw new Error('Invalid vault envelope: Expected v1 prefix');
  }

  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid vault payload format: Expected 4 segments');
  }

  const [, ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_LENGTH_BYTES || authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error('Cryptographic integrity failure: Invalid IV or Auth Tag length');
  }

  const key = getMasterKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}
