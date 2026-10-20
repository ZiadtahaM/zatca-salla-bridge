export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export type GatewayVerdict =
  | { kind: 'success_clean'; data: any }
  | { kind: 'success_with_warnings'; data: any; warnings: any[] }
  | { kind: 'business_rejection'; data: any; errors: any[] }
  | { kind: 'auth_error_401'; reason: string }
  | { kind: 'clearance_fallback_303'; redirectLocation?: string }
  | { kind: 'outage_retry'; reason: string; retryAfterSeconds: number; cloudflareRayId?: string };

export function classifyGatewayResponse(res: HttpResponse): GatewayVerdict {
  const contentType = (res.headers['content-type'] as string) || '';
  const rayId = res.headers['cf-ray'] as string | undefined;

  if (res.statusCode === 401) {
    return {
      kind: 'auth_error_401',
      reason: 'PCSID certificate unauthorized, expired, or revoked by ZATCA'
    };
  }

  if (
    contentType.includes('text/html') ||
    res.rawBody.trim().startsWith('<!DOCTYPE html>') ||
    res.rawBody.includes('<html')
  ) {
    return {
      kind: 'outage_retry',
      reason: `Cloudflare or edge HTML intercept (Status ${res.statusCode})`,
      retryAfterSeconds: 30,
      cloudflareRayId: rayId
    };
  }

  if (res.statusCode === 429) {
    const retryHeader = res.headers['retry-after'];
    const retrySeconds = retryHeader ? parseInt(retryHeader.toString(), 10) || 60 : 60;
    return {
      kind: 'outage_retry',
      reason: 'Rate limit encountered (HTTP 429)',
      retryAfterSeconds: retrySeconds
    };
  }

  if ([500, 502, 503, 504].includes(res.statusCode)) {
    return {
      kind: 'outage_retry',
      reason: `ZATCA gateway failure (HTTP ${res.statusCode})`,
      retryAfterSeconds: 15,
      cloudflareRayId: rayId
    };
  }

  if (res.statusCode === 303) {
    return {
      kind: 'clearance_fallback_303',
      redirectLocation: res.headers['location'] as string | undefined
    };
  }

  let json: any;
  try {
    json = JSON.parse(res.rawBody);
  } catch {
    return {
      kind: 'outage_retry',
      reason: `Unparseable response body with status ${res.statusCode}`,
      retryAfterSeconds: 20
    };
  }

  if (res.statusCode === 200) {
    return { kind: 'success_clean', data: json };
  }

  if (res.statusCode === 202) {
    const warnings = json.validationResults?.warningMessages || [];
    return { kind: 'success_with_warnings', data: json, warnings };
  }

  if (res.statusCode === 400 || res.statusCode === 422) {
    const errors = json.validationResults?.errorMessages || [];
    return { kind: 'business_rejection', data: json, errors };
  }

  return {
    kind: 'business_rejection',
    data: json,
    errors: [{ code: `HTTP_${res.statusCode}`, message: 'Unexpected status code returned' }]
  };
}
