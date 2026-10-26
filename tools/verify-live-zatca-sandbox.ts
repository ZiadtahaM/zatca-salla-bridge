import { getZatcaOutboundHeaders, classifyGatewayResponse } from '../src/services/outage-classifier.js';
import { generateValidSecp256k1TestCert } from '../tests/helpers.js';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

async function main() {
  console.log('================================================================================');
  console.log('🌐 ZATCA LIVE NETWORK PROBE: Developer Portal Sandbox Gateway');
  console.log('================================================================================');

  const workDir = join(process.cwd(), '.zatca-live-probe-' + Date.now());
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(workDir);

  const sandboxUrl = 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance/invoices';
  console.log(`Target URL: ${sandboxUrl}`);

  // Test certificate credentials encoded as Basic auth
  const basicAuthCredentials = Buffer.from('test_binary_security_token:test_secret').toString('base64');
  const headers = getZatcaOutboundHeaders(basicAuthCredentials, true);

  console.log('Outbound Headers configured:');
  console.log(`  Accept: ${headers['Accept']}`);
  console.log(`  Accept-Version: ${headers['Accept-Version']}`);
  console.log(`  Content-Type: ${headers['Content-Type']}`);

  const testPayload = {
    invoiceHash: 'i93kF0Q3eY25qJ5v1M7y7Y29xJ5v1M7y7Y29xJ5v1M8=',
    uuid: 'c827b594-54c3-4f91-8451-406ecb6d0590',
    invoice: Buffer.from('<Invoice><cbc:ID>TEST-001</cbc:ID></Invoice>').toString('base64')
  };

  const tStart = performance.now();
  let resp: Response;
  try {
    resp = await fetch(sandboxUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(testPayload)
    });
  } catch (err: any) {
    console.error(`Network fetch failed: ${err.message}`);
    process.exit(1);
  }

  const elapsedMs = Math.round(performance.now() - tStart);
  const rawBody = await resp.text();

  const responseHeaders: Record<string, string> = {};
  resp.headers.forEach((val, key) => {
    responseHeaders[key.toLowerCase()] = val;
  });

  console.log('\n--- Real ZATCA Gateway HTTP Response ---');
  console.log(`HTTP Status: ${resp.status} ${resp.statusText}`);
  console.log(`Round-trip Latency: ${elapsedMs}ms`);
  console.log(`Cloudflare Ray ID: ${responseHeaders['cf-ray'] || 'N/A'}`);
  console.log(`ZATCA Request ID: ${responseHeaders['x-request-id'] || 'N/A'}`);
  console.log(`Server: ${responseHeaders['server'] || 'N/A'}`);
  console.log(`Content-Type: ${responseHeaders['content-type'] || 'N/A'}`);
  console.log('\nPayload Preview (First 500 chars):');
  console.log(rawBody.slice(0, 500));

  const verdict = classifyGatewayResponse({
    statusCode: resp.status,
    headers: responseHeaders,
    rawBody
  });

  console.log('\n--- Outage & Gateway Verdict ---');
  console.log(`Verdict Kind: ${verdict.kind}`);

  // Cleanup temp test cert dir
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}

  console.log('\n✅ Real Network Probe Completed Successfully.');
}

main().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
