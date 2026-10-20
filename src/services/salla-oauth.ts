import { PoolClient } from 'pg';
import { encryptVaultSecret, decryptVaultSecret } from '../crypto/vault.js';

export interface SallaTokenPayload {
  merchantId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope?: string;
}

export interface DecryptedMerchantTokens {
  merchantId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope?: string;
}

export interface SallaStoreInfo {
  id: string;
  name: string;
  vatNumber?: string;
  crn?: string;
  city?: string;
  plan?: string;
}

export async function storeSallaMerchantTokens(
  client: PoolClient,
  payload: SallaTokenPayload
): Promise<void> {
  const encryptedAccessToken = encryptVaultSecret(payload.accessToken);
  const encryptedRefreshToken = encryptVaultSecret(payload.refreshToken);
  const expiresAt = new Date(Date.now() + payload.expiresIn * 1000);

  await client.query(
    `INSERT INTO merchant_tokens (
      merchant_id, access_token_encrypted, refresh_token_encrypted,
      expires_at, token_scope, updated_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (merchant_id) DO UPDATE SET
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
      expires_at = EXCLUDED.expires_at,
      token_scope = EXCLUDED.token_scope,
      updated_at = NOW()`,
    [
      payload.merchantId,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt.toISOString(),
      payload.scope || 'offline_access'
    ]
  );
}

export async function getSallaMerchantTokens(
  client: PoolClient,
  merchantId: string
): Promise<DecryptedMerchantTokens | null> {
  const res = await client.query(
    `SELECT merchant_id, access_token_encrypted, refresh_token_encrypted, expires_at, token_scope
     FROM merchant_tokens
     WHERE merchant_id = $1`,
    [merchantId]
  );

  if (res.rows.length === 0) {
    return null;
  }

  const row = res.rows[0];
  return {
    merchantId: row.merchant_id,
    accessToken: decryptVaultSecret(row.access_token_encrypted),
    refreshToken: decryptVaultSecret(row.refresh_token_encrypted),
    expiresAt: new Date(row.expires_at),
    scope: row.token_scope
  };
}

export async function fetchSallaStoreInfo(
  accessToken: string,
  apiBaseUrl: string = 'https://api.salla.dev/admin/v2'
): Promise<SallaStoreInfo> {
  const url = `${apiBaseUrl}/oauth2/user/info`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'ZATCA-Salla-Bridge/1.0.0 (Saudi E-Invoicing Agent)'
    }
  });

  if (!response.ok) {
    throw new Error(`Salla API request failed with status ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as any;
  const data = json.data || json;
  return {
    id: (data.merchant?.id || data.id || '').toString(),
    name: data.merchant?.name || data.name || '',
    vatNumber: data.merchant?.tax_number || data.tax_number,
    crn: data.merchant?.commercial_number || data.commercial_number,
    city: data.merchant?.city || data.city,
    plan: data.merchant?.plan || data.plan
  };
}
