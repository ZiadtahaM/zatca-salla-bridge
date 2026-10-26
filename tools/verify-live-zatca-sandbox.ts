import { getZatcaOutboundHeaders, classifyGatewayResponse } from '../src/services/outage-classifier.js';
import { generateZatcaCsr, getZatcaBaseUrl, ZatcaEnvironment } from '../src/services/csr-generator.js';
import { buildUblXmlFromSallaOrder, signZatcaInvoiceExact } from '../src/services/invoice-generator.js';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';

async function main() {
  console.log('================================================================================');
  console.log('🌐 ZATCA LIVE NETWORK PROBE: 2-Step Developer Portal Compliance Verification');
  console.log('================================================================================');

  const otp = process.argv[2] || process.env.ZATCA_PORTAL_OTP || '123345';
  const environment: ZatcaEnvironment = (process.env.ZATCA_ENV as ZatcaEnvironment) || 'sandbox';
  const baseUrl = getZatcaBaseUrl(environment);
  const vatNumber = process.env.ZATCA_TEST_VAT || '399999999900003';
  const storeName = process.env.ZATCA_TEST_STORE || 'متجر الاختبار المعتمد للتقنية';
  const crn = process.env.ZATCA_TEST_CRN || '1010010000';

  console.log(`Target Gateway: ${baseUrl}`);
  console.log(`Environment: ${environment}`);
  console.log(`Taxpayer VAT: ${vatNumber}`);
  console.log(`Provided OTP: ${otp}`);

  const workDir = mkdtempSync(join(tmpdir(), 'zatca-live-probe-'));

  try {
    let binarySecurityToken = process.env.ZATCA_CSID_TOKEN || '';
    let secret = process.env.ZATCA_CSID_SECRET || '';
    let privateKeyPem = process.env.ZATCA_PRIVATE_KEY_PEM || '';

    // Step 1: CSR Generation & Compliance CSID Request
    if (!binarySecurityToken || !secret) {
      console.log('\n--- Step 1: Generating secp256k1 Keypair & Compliant CSR ---');
      const csrResult = generateZatcaCsr(workDir, {
        commonName: `TST-${Date.now()}`,
        organizationName: storeName,
        organizationUnit: 'Riyadh Branch',
        vatNumber,
        egsSerial: `SRN-${Date.now()}`,
        egsModel: 'SallaBridge-V1',
        egsManufacturer: 'ZatcaSallaBridge',
        registeredAddress: 'King Fahd Road, Riyadh, SA',
        businessCategory: 'Retail',
        environment,
        isProduction: false,
        invoiceType: '1100'
      });
      privateKeyPem = csrResult.privateKeyPem;
      console.log(`CSR successfully generated. Length: ${csrResult.csrBase64.length} chars.`);

      const complianceUrl = `${baseUrl}/compliance`;
      console.log(`Requesting Compliance CSID from ${complianceUrl}...`);

      const tStart = performance.now();
      let ccsidResp: Response;
      try {
        ccsidResp = await fetch(complianceUrl, {
          method: 'POST',
          headers: {
            'Accept-Version': 'V2',
            'Accept-Language': 'en',
            'Content-Type': 'application/json',
            'OTP': otp
          },
          body: JSON.stringify({ csr: csrResult.csrBase64 })
        });
      } catch (err: any) {
        console.error(`Network fetch to compliance endpoint failed: ${err.message}`);
        process.exit(1);
      }

      const elapsedMs = Math.round(performance.now() - tStart);
      const rawBody = await ccsidResp.text();

      console.log(`HTTP Status: ${ccsidResp.status} ${ccsidResp.statusText} (${elapsedMs}ms)`);

      if (ccsidResp.status === 200 || ccsidResp.status === 201) {
        try {
          const parsed = JSON.parse(rawBody);
          binarySecurityToken = parsed.binarySecurityToken;
          secret = parsed.secret;
          console.log(`✅ Compliance CSID acquired! RequestID: ${parsed.requestID}`);
        } catch {
          console.error('Failed to parse CSID JSON response:', rawBody);
          process.exit(1);
        }
      } else {
        console.log('\n⚠️ ZATCA Compliance CSID Request Response:');
        console.log(`Status: ${ccsidResp.status}`);
        console.log(`Response: ${rawBody}`);
        console.log('\nDiagnosis:');
        console.log('The ZATCA Developer Portal requires a valid 6-digit OTP generated from the Fatoora ERAD portal.');
        console.log('Each OTP is valid for 60 minutes for a single EGS unit.');
        console.log(`To run with an active OTP: npx tsx tools/verify-live-zatca-sandbox.ts <YOUR_6_DIGIT_OTP>`);
        console.log('Or export ZATCA_CSID_TOKEN and ZATCA_CSID_SECRET to verify Step 2 directly.');
        process.exit(1);
      }
    }

    // Step 2: Sign and Submit Compliance Invoice
    console.log('\n--- Step 2: Sign and Submit Compliance UBL 2.1 Invoice ---');
    const wrappedCert = (binarySecurityToken.replace(/\s+/g, '').match(/.{1,64}/g) || []).join('\n');
    const certPem = `-----BEGIN CERTIFICATE-----\n${wrappedCert}\n-----END CERTIFICATE-----\n`;

    const invoiceUuid = crypto.randomUUID();
    const now = new Date();
    const issueDate = now.toISOString().split('T')[0];
    const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
    const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;

    const orderData: any = {
      id: `ORD-LIVE-${Date.now()}`,
      reference_id: `REF-${Date.now()}`,
      date: { date: `${issueDate} ${issueTime}`, timezone: 'Asia/Riyadh' },
      status: { id: 1, name: 'Delivered', slug: 'delivered' },
      payment_method: 'credit_card',
      currency: 'SAR',
      customer: {
        id: 101,
        first_name: 'Fahad',
        last_name: 'Al-Otaibi',
        tax_number: null
      },
      items: [
        {
          id: 1,
          name: 'باقة العود المروكي الفاخر / Luxury Maroki Oud',
          quantity: 1,
          price: { amount: 100.0, currency: 'SAR' },
          total: { amount: 100.0, currency: 'SAR' }
        }
      ],
      amounts: {
        sub_total: { amount: 100.0, currency: 'SAR' },
        tax: {
          percent: 15,
          amount: { amount: 15.0, currency: 'SAR' }
        },
        total: { amount: 115.0, currency: 'SAR' }
      }
    };

    const initialPih = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==';
    const rawXml = buildUblXmlFromSallaOrder({
      order: orderData,
      uuid: invoiceUuid,
      icv: 1,
      pih: initialPih,
      issueDate,
      issueTime,
      sellerNameArabic: storeName,
      sellerVat: vatNumber,
      sellerCrn: crn,
      isB2C: true
    });

    const signed = signZatcaInvoiceExact({
      rawXml,
      privateKeyPem,
      certPem,
      sellerNameArabic: storeName,
      sellerVatNumber: vatNumber,
      grandTotal: '115.00',
      vatTotal: '15.00',
      issueDateTimeIsoZ,
      isB2C: true
    });

    console.log(`Generated and signed UBL 2.1 XML. Invoice Hash: ${signed.invoiceHashBase64}`);

    const invoiceUrl = `${baseUrl}/compliance/invoices`;
    console.log(`Submitting signed invoice to ${invoiceUrl}...`);

    const basicAuthCredentials = Buffer.from(`${binarySecurityToken}:${secret}`).toString('base64');
    const headers = getZatcaOutboundHeaders(basicAuthCredentials, true);

    const testPayload = {
      invoiceHash: signed.invoiceHashBase64,
      uuid: invoiceUuid,
      invoice: Buffer.from(signed.signedXml, 'utf8').toString('base64')
    };

    const tStartInv = performance.now();
    const invResp = await fetch(invoiceUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(testPayload)
    });
    const invElapsedMs = Math.round(performance.now() - tStartInv);
    const invBody = await invResp.text();

    console.log(`HTTP Status: ${invResp.status} ${invResp.statusText} (${invElapsedMs}ms)`);

    const responseHeaders: Record<string, string> = {};
    invResp.headers.forEach((val, key) => {
      responseHeaders[key.toLowerCase()] = val;
    });

    const verdict = classifyGatewayResponse({
      statusCode: invResp.status,
      headers: responseHeaders,
      rawBody: invBody
    });

    console.log('\n--- ZATCA Live Gateway Response ---');
    console.log(`Verdict Kind: ${verdict.kind}`);
    console.log(`ZATCA Request ID: ${responseHeaders['x-request-id'] || 'N/A'}`);
    console.log(`Cloudflare Ray ID: ${responseHeaders['cf-ray'] || 'N/A'}`);
    console.log('Payload Body:');
    console.log(invBody.slice(0, 800));

    if (invResp.status === 200 || invResp.status === 202) {
      console.log('\n✅ 2-Step Live ZATCA Compliance Verification Succeeded!');
    } else {
      console.log('\n⚠️ Live gateway returned non-200 status.');
      process.exit(1);
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
