import { PoolClient, Pool } from 'pg';
import { encryptVaultSecret, decryptVaultSecret } from '../crypto/vault.js';

export interface SallaTokenPayload {
  merchantId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  expiresInSeconds?: number;
  scope?: string;
  storeName?: string;
  vatNumber?: string;
  crn?: string;
  city?: string;
}

export interface DecryptedMerchantTokens {
  merchantId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope?: string;
  storeName?: string;
  vatNumber?: string;
  crn?: string;
  city?: string;
}

export interface SallaStoreInfo {
  id: string;
  name: string;
  vatNumber?: string;
  crn?: string;
  city?: string;
  plan?: string;
}

export interface MerchantSubscriptionStatus {
  active: boolean;
  status: string;
  planName: string;
  expiresAt?: Date | null;
  reason?: string;
}

export async function storeSallaMerchantTokens(
  client: PoolClient | Pool,
  payload: SallaTokenPayload
): Promise<void> {
  const encryptedAccessToken = encryptVaultSecret(payload.accessToken);
  const encryptedRefreshToken = encryptVaultSecret(payload.refreshToken);
  const expiresInSec = Number(payload.expiresIn ?? payload.expiresInSeconds ?? 7200);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);

  await client.query(
    `INSERT INTO merchant_tokens (
      merchant_id, access_token_encrypted, refresh_token_encrypted,
      expires_at, token_scope, store_name, vat_number, crn, city, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (merchant_id) DO UPDATE SET
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
      expires_at = EXCLUDED.expires_at,
      token_scope = EXCLUDED.token_scope,
      store_name = COALESCE(EXCLUDED.store_name, merchant_tokens.store_name),
      vat_number = COALESCE(EXCLUDED.vat_number, merchant_tokens.vat_number),
      crn = COALESCE(EXCLUDED.crn, merchant_tokens.crn),
      city = COALESCE(EXCLUDED.city, merchant_tokens.city),
      updated_at = NOW()`,
    [
      payload.merchantId,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiresAt.toISOString(),
      payload.scope || 'offline_access',
      payload.storeName || null,
      payload.vatNumber || null,
      payload.crn || null,
      payload.city || null
    ]
  );
}

export async function updateMerchantStoreProfile(
  client: PoolClient | Pool,
  merchantIdOrProfile: string | { merchantId: string; storeName?: string; vatNumber?: string; crn?: string; city?: string },
  profile?: { storeName?: string; vatNumber?: string; crn?: string; city?: string }
): Promise<void> {
  const merchantId = typeof merchantIdOrProfile === 'string' ? merchantIdOrProfile : merchantIdOrProfile.merchantId;
  const resolvedProfile = typeof merchantIdOrProfile === 'object' ? merchantIdOrProfile : (profile || {});

  await client.query(
    `UPDATE merchant_tokens
     SET store_name = COALESCE($1, store_name),
         vat_number = COALESCE($2, vat_number),
         crn = COALESCE($3, crn),
         city = COALESCE($4, city),
         updated_at = NOW()
     WHERE merchant_id = $5`,
    [resolvedProfile.storeName || null, resolvedProfile.vatNumber || null, resolvedProfile.crn || null, resolvedProfile.city || null, merchantId]
  );
}

export async function getSallaMerchantTokens(
  client: PoolClient | Pool,
  merchantId: string
): Promise<DecryptedMerchantTokens | null> {
  const res = await client.query(
    `SELECT merchant_id, access_token_encrypted, refresh_token_encrypted, expires_at, token_scope,
            store_name, vat_number, crn, city
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
    scope: row.token_scope,
    storeName: row.store_name || undefined,
    vatNumber: row.vat_number || undefined,
    crn: row.crn || undefined,
    city: row.city || undefined
  };
}

export async function fetchSallaStoreInfo(
  accessToken: string,
  apiBaseUrl: string = 'https://api.salla.dev/admin/v2',
  customFetch: typeof fetch = fetch
): Promise<SallaStoreInfo> {
  const url = `${apiBaseUrl}/oauth2/user/info`;
  const response = await customFetch(url, {
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

export async function refreshSallaTokenIfNeeded(
  client: PoolClient | Pool,
  merchantId: string,
  force = false,
  customFetch: typeof fetch = fetch,
  tokenEndpoint: string = process.env.SALLA_OAUTH_URL || 'https://accounts.salla.sa/oauth2/token'
): Promise<DecryptedMerchantTokens | null> {
  // Acquire an advisory lock keyed to the merchantId to serialize refresh requests
  // and prevent single-use token replay invalidations.
  await client.query(`SELECT pg_advisory_lock(hashtext('salla_refresh_' || $1))`, [merchantId]);

  try {
    const tokens = await getSallaMerchantTokens(client, merchantId);
    if (!tokens) {
      return null;
    }

    const now = Date.now();
    const diffMs = tokens.expiresAt.getTime() - now;
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;

    // Return the existing valid token if not expired or forced and more than 24 hours remain
    if (!force && diffMs > twentyFourHoursMs) {
      return tokens;
    }

    const clientId = process.env.SALLA_CLIENT_ID || 'dummy_salla_client_id';
    const clientSecret = process.env.SALLA_CLIENT_SECRET || 'dummy_salla_client_secret';

    const bodyParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken
    });

    const response = await customFetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: bodyParams.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to refresh Salla OAuth token for merchant ${merchantId}: ${response.status} - ${errorText}`);
    }

    const json = (await response.json()) as any;
    const newAccessToken = json.access_token || json.data?.access_token;
    const newRefreshToken = json.refresh_token || json.data?.refresh_token;
    const expiresIn = Number(json.expires_in || json.data?.expires_in || 1209600);

    if (!newAccessToken || !newRefreshToken) {
      throw new Error(`Malformed response from Salla token refresh: missing access_token or refresh_token`);
    }

    const encryptedAccess = encryptVaultSecret(newAccessToken);
    const encryptedRefresh = encryptVaultSecret(newRefreshToken);
    const newExpiresAt = new Date(Date.now() + expiresIn * 1000);

    await client.query(
      `UPDATE merchant_tokens
       SET access_token_encrypted = $1,
           refresh_token_encrypted = $2,
           expires_at = $3,
           updated_at = NOW()
       WHERE merchant_id = $4`,
      [encryptedAccess, encryptedRefresh, newExpiresAt.toISOString(), merchantId]
    );

    return {
      ...tokens,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt
    };
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('salla_refresh_' || $1))`, [merchantId]);
    } catch {}
  }
}

export async function updateMerchantSubscription(
  client: PoolClient | Pool,
  merchantId: string,
  planName: string,
  status: string,
  expiresAt?: Date | null
): Promise<void> {
  await client.query(
    `INSERT INTO merchant_subscriptions (
       merchant_id, plan_name, status, expires_at, updated_at
     ) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (merchant_id) DO UPDATE SET
       plan_name = EXCLUDED.plan_name,
       status = EXCLUDED.status,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [merchantId, planName, status, expiresAt ? expiresAt.toISOString() : null]
  );
}

export async function isMerchantSubscriptionActive(
  client: PoolClient | Pool,
  merchantId: string
): Promise<MerchantSubscriptionStatus> {
  const res = await client.query(
    `SELECT plan_name, status, expires_at
     FROM merchant_subscriptions
     WHERE merchant_id = $1`,
    [merchantId]
  );

  if (res.rows.length === 0) {
    return {
      active: true,
      status: 'trialing',
      planName: 'standard',
      reason: '14-day automatic trial for newly installed merchant'
    };
  }

  const row = res.rows[0];
  const status = row.status;
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const now = new Date();

  if (status === 'uninstalled' || status === 'canceled') {
    return {
      active: false,
      status,
      planName: row.plan_name,
      expiresAt,
      reason: `Merchant subscription is ${status}`
    };
  }

  if (expiresAt && expiresAt < now) {
    return {
      active: false,
      status: 'expired',
      planName: row.plan_name,
      expiresAt,
      reason: 'Merchant subscription period has expired'
    };
  }

  return {
    active: ['active', 'trialing'].includes(status),
    status,
    planName: row.plan_name,
    expiresAt
  };
}

export async function exchangeSallaAuthorizationCode(
  code: string,
  redirectUri: string,
  customFetch: typeof fetch = fetch
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}> {
  const clientId = process.env.SALLA_CLIENT_ID || 'dummy_salla_client_id';
  const clientSecret = process.env.SALLA_CLIENT_SECRET || 'dummy_salla_client_secret';
  const tokenEndpoint = process.env.SALLA_OAUTH_TOKEN_URL || process.env.SALLA_OAUTH_URL || 'https://accounts.salla.sa/oauth2/token';

  const bodyParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  });

  const response = await customFetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: bodyParams.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange Salla authorization code: ${response.status} - ${errorText}`);
  }

  const json = (await response.json()) as any;
  const data = json.data || json;
  const accessToken = data.access_token || json.access_token;
  const refreshToken = data.refresh_token || json.refresh_token;
  const expiresIn = Number(data.expires_in || json.expires_in || 1209600);
  const scope = (data.scope || json.scope || 'offline_access').toString();

  if (!accessToken || !refreshToken) {
    throw new Error('Malformed response from Salla token exchange: missing access_token or refresh_token');
  }

  return {
    accessToken,
    refreshToken,
    expiresIn,
    scope
  };
}

export function generateSallaAuthorizeUrl(
  clientId?: string,
  redirectUri?: string,
  state?: string,
  scope?: string
): string {
  const resolvedClientId = clientId || process.env.SALLA_CLIENT_ID || 'dummy_salla_client_id';
  const resolvedRedirectUri = redirectUri || process.env.SALLA_REDIRECT_URI || 'https://zatca.salla.sa/api/salla/oauth/callback';
  const resolvedScope = scope || 'offline_access';
  const base = process.env.SALLA_AUTH_URL || 'https://accounts.salla.sa/oauth2/auth';

  const params = new URLSearchParams({
    client_id: resolvedClientId,
    response_type: 'code',
    scope: resolvedScope,
    redirect_uri: resolvedRedirectUri
  });

  if (state) {
    params.set('state', state);
  }

  return `${base}?${params.toString()}`;
}

export async function revokeSallaMerchantTokens(
  client: PoolClient | Pool,
  merchantId: string
): Promise<void> {
  await client.query(
    `DELETE FROM merchant_tokens WHERE merchant_id = $1`,
    [merchantId]
  );
}
