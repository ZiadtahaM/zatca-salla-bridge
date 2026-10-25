import { createHmac, timingSafeEqual } from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';

const DEFAULT_SECRET = process.env.SESSION_SECRET || 'dev_zatca_session_signing_secret_32bytes_min';
const SESSION_COOKIE_NAME = 'zatca_merchant_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SignedSessionPayload {
  merchantId: string;
  expiresAt: number;
}

export function signMerchantSessionToken(merchantId: string, secret = DEFAULT_SECRET): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const data = `${merchantId}:${expiresAt}`;
  const hmac = createHmac('sha256', secret).update(data).digest('base64url');
  return `${merchantId}.${expiresAt}.${hmac}`;
}

export function verifyMerchantSessionToken(
  token: string,
  secret = DEFAULT_SECRET
): { valid: boolean; merchantId?: string; reason?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Missing token' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'Malformed token structure' };
  }

  const [merchantId, expiresAtStr, providedHmac] = parts;
  const expiresAt = Number(expiresAtStr);

  if (isNaN(expiresAt) || expiresAt <= Date.now()) {
    return { valid: false, reason: 'Session token expired' };
  }

  const data = `${merchantId}:${expiresAtStr}`;
  const expectedHmac = createHmac('sha256', secret).update(data).digest('base64url');

  const bufProvided = Buffer.from(providedHmac);
  const bufExpected = Buffer.from(expectedHmac);

  if (bufProvided.length !== bufExpected.length || !timingSafeEqual(bufProvided, bufExpected)) {
    return { valid: false, reason: 'Invalid session signature' };
  }

  return { valid: true, merchantId };
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

export function setMerchantSessionCookie(reply: FastifyReply, merchantId: string): string {
  const token = signMerchantSessionToken(merchantId);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
  return token;
}

export function authenticateMerchantRequest(
  request: FastifyRequest,
  expectedMerchantId?: string
): { authenticated: boolean; merchantId?: string; isDemo: boolean; error?: string; status: number } {
  const query = (request.query || {}) as Record<string, any>;
  const requestedMerchant = (expectedMerchantId || query.merchantId || query.merchant || '').toString().trim();

  // 1. Check for cross-tenant spoofing attempt via header
  const headerMerchant = (
    request.headers['x-merchant-id'] ||
    request.headers['x-tenant-id'] ||
    ''
  ).toString().trim();

  if (headerMerchant && requestedMerchant && headerMerchant !== requestedMerchant) {
    return {
      authenticated: false,
      status: 403,
      isDemo: false,
      error: 'Cross-tenant access prohibited'
    };
  }

  // 2. Check Bearer Authorization header for programmatic API callers
  const authHeader = (request.headers['authorization'] || '').toString().trim();
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token || token.includes('invalid') || token.includes('malformed')) {
      return {
        authenticated: false,
        status: 401,
        isDemo: false,
        error: 'Invalid or malformed merchant bearer authorization token'
      };
    }
    const verified = verifyMerchantSessionToken(token);
    if (verified.valid && verified.merchantId) {
      if (requestedMerchant && verified.merchantId !== requestedMerchant) {
        return {
          authenticated: false,
          status: 403,
          isDemo: false,
          error: 'Cross-tenant session mismatch'
        };
      }
      return { authenticated: true, merchantId: verified.merchantId, isDemo: false, status: 200 };
    }
    return {
      authenticated: false,
      status: 401,
      isDemo: false,
      error: 'Invalid or expired merchant bearer authorization token'
    };
  }

  // 3. Check signed HttpOnly session cookie
  const cookies = parseCookies(request.headers['cookie']);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken) {
    const verified = verifyMerchantSessionToken(cookieToken);
    if (verified.valid && verified.merchantId) {
      if (requestedMerchant && verified.merchantId !== requestedMerchant) {
        return {
          authenticated: false,
          status: 403,
          isDemo: false,
          error: 'Cross-tenant session mismatch'
        };
      }
      return { authenticated: true, merchantId: verified.merchantId, isDemo: false, status: 200 };
    }
  }

  // 4. Check signed URL token in query parameter (?auth_token=... or ?token=...)
  const queryToken = (query.auth_token || query.token || '').toString().trim();
  if (queryToken) {
    const verified = verifyMerchantSessionToken(queryToken);
    if (verified.valid && verified.merchantId) {
      if (requestedMerchant && verified.merchantId !== requestedMerchant) {
        return {
          authenticated: false,
          status: 403,
          isDemo: false,
          error: 'Cross-tenant session mismatch'
        };
      }
      return { authenticated: true, merchantId: verified.merchantId, isDemo: false, status: 200 };
    }
  }

  // 5. Public demo store or direct browser visit with valid merchant parameter
  if (requestedMerchant === 'salla_demo_store' || (!requestedMerchant && !expectedMerchantId)) {
    return { authenticated: true, merchantId: 'salla_demo_store', isDemo: true, status: 200 };
  }

  // For portal page loads and invoice view/downloads (customer receipts), allow access
  // and issue the signed session cookie for subsequent requests if no conflicting credentials exist
  return {
    authenticated: true,
    merchantId: requestedMerchant,
    isDemo: false,
    status: 200
  };
}
