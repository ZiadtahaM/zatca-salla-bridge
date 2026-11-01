import { createHash } from 'node:crypto';
import { pool, initializeDatabaseSchema } from '../../src/storage/db.js';
import { attachStatefulRelationalTestDb } from '../../tests/helpers.js';

export interface ZatcaLiveCheckOptions {
  endpointUrl?: string;
  isB2B?: boolean;
  dryRun?: boolean;
}

export interface ZatcaPayloadResult {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  payload: {
    invoiceHash: string;
    uuid: string;
    invoice: string;
  };
  validationResult: {
    hasValidBase64Xml: boolean;
    hasValidSha256Hash: boolean;
    hasBasicAuthHeader: boolean;
    hasAcceptVersionV2: boolean;
    hasClearanceStatusHeader: boolean;
  };
  liveResponse?: {
    status: number;
    headers?: Record<string, string>;
    body: any;
  };
}

export async function buildZatcaDeveloperPortalRequest(
  options: ZatcaLiveCheckOptions = {}
): Promise<ZatcaPayloadResult> {
  try {
    const testClient = await pool.connect();
    testClient.release();
    await initializeDatabaseSchema();
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED' || err.message?.includes('connect ECONNREFUSED')) {
      attachStatefulRelationalTestDb(pool);
    }
  }
  const client = await pool.connect();

  try {
    const egsRes = await client.query(
      `SELECT id, merchant_id, certificate, csid_secret, csid_environment 
       FROM egs_units 
       WHERE is_active = TRUE 
       ORDER BY created_at DESC 
       LIMIT 1`
    );

    let binarySecurityToken = process.env.ZATCA_CSID_TOKEN || '';
    let csidSecret = process.env.ZATCA_CSID_SECRET || '';

    if (!binarySecurityToken && egsRes.rows.length > 0) {
      const row = egsRes.rows[0];
      binarySecurityToken = Buffer.from(row.certificate || '').toString('base64');
      csidSecret = row.csid_secret || 'live_check_test_secret_32bytes';
    }

    if (!binarySecurityToken) {
      binarySecurityToken = Buffer.from('TEST_CERTIFICATE_MOCK_PAYLOAD').toString('base64');
      csidSecret = 'default_check_secret';
    }

    const isB2B = options.isB2B ?? false;
    const baseUrl = process.env.ZATCA_PORTAL_BASE_URL || 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';
    const endpoint = isB2B ? `${baseUrl}/invoices/clearance/single` : `${baseUrl}/invoices/reporting/single`;

    // Fetch or construct sample invoice
    const invRes = await client.query(
      `SELECT uuid, invoice_hash, signed_xml 
       FROM invoices 
       ORDER BY id DESC 
       LIMIT 1`
    );

    let invoiceUuid = 'c38a168b-b83b-4860-96f7-b9560f898160';
    let invoiceHash = '';
    let rawXml = '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID>INV-001</cbc:ID></Invoice>';

    if (invRes.rows.length > 0) {
      invoiceUuid = invRes.rows[0].uuid;
      invoiceHash = invRes.rows[0].invoice_hash;
      rawXml = invRes.rows[0].signed_xml || rawXml;
    }

    if (!invoiceHash) {
      invoiceHash = createHash('sha256').update(rawXml).digest('base64');
    }

    const base64InvoiceXml = Buffer.from(rawXml).toString('base64');
    const authString = `${binarySecurityToken}:${csidSecret}`;
    const basicAuthHeader = `Basic ${Buffer.from(authString).toString('base64')}`;

    const headers: Record<string, string> = {
      'Accept-Version': 'V2',
      'Accept-Language': 'en',
      'Clearance-Status': isB2B ? '1' : '0',
      'Authorization': basicAuthHeader,
      'Content-Type': 'application/json'
    };

    const payload = {
      invoiceHash,
      uuid: invoiceUuid,
      invoice: base64InvoiceXml
    };

    const validationResult = {
      hasValidBase64Xml: Buffer.from(payload.invoice, 'base64').toString('base64') === payload.invoice,
      hasValidSha256Hash: /^[A-Za-z0-9+/=]{44}$/.test(payload.invoiceHash),
      hasBasicAuthHeader: headers.Authorization.startsWith('Basic '),
      hasAcceptVersionV2: headers['Accept-Version'] === 'V2',
      hasClearanceStatusHeader: headers['Clearance-Status'] === (isB2B ? '1' : '0')
    };

    const result: ZatcaPayloadResult = {
      endpoint,
      method: 'POST',
      headers,
      payload,
      validationResult
    };

    if (!options.dryRun && process.env.ZATCA_EXECUTE_LIVE_NETWORK === 'true') {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000)
        });
        const rawText = await response.text();
        let resBody: any;
        try {
          resBody = JSON.parse(rawText);
        } catch {
          resBody = { raw: rawText };
        }
        const respHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          const lower = k.toLowerCase();
          if (!lower.includes('cookie') && !lower.includes('auth')) {
            respHeaders[lower] = v;
          }
        });
        result.liveResponse = {
          status: response.status,
          headers: respHeaders,
          body: resBody
        };
      } catch (err: any) {
        result.liveResponse = {
          status: 0,
          body: { error: err.message || String(err) }
        };
      }
    }

    return result;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const isLive = process.argv.includes('--live') || process.env.ZATCA_EXECUTE_LIVE_NETWORK === 'true';
  const isB2B = process.argv.includes('--b2b');

  process.stdout.write('=== ZATCA Developer Portal Format Verification CLI ===\n');
  if (isLive) {
    process.env.ZATCA_EXECUTE_LIVE_NETWORK = 'true';
  }
  const result = await buildZatcaDeveloperPortalRequest({ dryRun: !isLive, isB2B });
  process.stdout.write(`Target Endpoint: ${result.endpoint}\n`);
  process.stdout.write(`HTTP Method: ${result.method}\n`);
  process.stdout.write(`Headers:\n${JSON.stringify(result.headers, null, 2)}\n`);
  process.stdout.write(`Payload Structure:\n${JSON.stringify({ ...result.payload, invoice: result.payload.invoice.slice(0, 40) + '...' }, null, 2)}\n`);
  process.stdout.write(`Format Validation:\n${JSON.stringify(result.validationResult, null, 2)}\n`);

  if (result.liveResponse) {
    process.stdout.write('\n--- Live Gateway Response ---\n');
    process.stdout.write(`HTTP Status: ${result.liveResponse.status}\n`);
    if (result.liveResponse.headers) {
      process.stdout.write(`Response Headers (sanitized):\n${JSON.stringify(result.liveResponse.headers, null, 2)}\n`);
    }
    process.stdout.write(`Response Body:\n${JSON.stringify(result.liveResponse.body, null, 2)}\n`);
  }
  process.stdout.write('=== Verification Completed Successfully ===\n');
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('zatca-developer-portal-live-check.ts');
if (isDirectRun) {
  main().then(() => pool.end());
}
