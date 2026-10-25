import { createCipheriv, createDecipheriv, randomBytes, createHash, createPrivateKey, KeyObject } from 'node:crypto';

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
export function encryptVaultSecret(plaintext: string | Buffer): string {
  if (!plaintext || (typeof plaintext === 'string' && plaintext.length === 0)) {
    throw new Error('Cannot encrypt empty plaintext');
  }

  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const inputBuffer = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([
    cipher.update(inputBuffer),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts AES-256-GCM vault secrets and returns the raw decrypted Buffer.
 * Does NOT allocate an immutable JavaScript string, enabling memory wiping with .fill(0).
 */
export function decryptVaultSecretBuffer(payload: string): Buffer {
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

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
}

/**
 * Scoped callback decryption that guarantees the plaintext Buffer is zero-filled in a finally block.
 */
export function withDecryptedVaultSecretBuffer<T>(
  payload: string,
  consumer: (secretBuffer: Buffer) => T
): T {
  const buf = decryptVaultSecretBuffer(payload);
  try {
    return consumer(buf);
  } finally {
    buf.fill(0);
  }
}

/**
 * Decrypts a PEM-formatted private key directly into a native Node.js KeyObject.
 * OpenSSL manages the key in native memory, and the intermediate plaintext Buffer
 * is zeroed out immediately in a finally block without leaving an immutable string on the V8 heap.
 */
export function decryptVaultPrivateKey(payload: string): KeyObject {
  return withDecryptedVaultSecretBuffer(payload, (buf) => {
    return createPrivateKey({
      key: buf,
      format: 'pem'
    });
  });
}

/**
 * Decrypts AES-256-GCM vault secrets to string for non-key metadata (OAuth tokens, JSON backups).
 */
export function decryptVaultSecret(payload: string): string {
  return withDecryptedVaultSecretBuffer(payload, (buf) => {
    return buf.toString('utf8');
  });
}

/**
 * Scoped string decryption callback.
 */
export function withDecryptedVaultSecret<T>(payload: string, consumer: (secret: string) => T): T {
  const secret = decryptVaultSecret(payload);
  return consumer(secret);
}
