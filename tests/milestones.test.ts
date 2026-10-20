import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { generateZatcaCsr } from '../src/services/csr-generator.js';
import {
  buildUblCreditNoteXmlFromSallaRefund
} from '../src/services/invoice-generator.js';
import { signZatcaInvoiceExact } from '../src/crypto/zatca-signer.js';
import { generateValidSecp256k1TestCert } from './helpers.js';

test('Milestone 1: generateZatcaCsr produces valid secp256k1 key and compliant ZATCA CSR with OIDs', () => {
  const workDir = join(process.cwd(), '.zatca-test-csr');
  const result = generateZatcaCsr(workDir, {
    commonName: 'EGS-12345-BR01',
    organizationName: 'شركة رواء للملابس',
    organizationUnit: 'Main Branch',
    vatNumber: '300075588700003',
    egsSerial: 'SRN-12345-BR01',
    egsModel: 'SallaBridge-V1',
    egsManufacturer: 'ZatcaSallaBridge',
    registeredAddress: 'King Fahd Road, Riyadh, SA',
    businessCategory: 'Retail',
    isProduction: false
  });

  assert.ok(result.privateKeyPem.includes('BEGIN PRIVATE KEY'));
  assert.ok(result.csrPem.includes('BEGIN CERTIFICATE REQUEST'));
  assert.ok(result.csrBase64.length > 100);
});

test('Milestone 2: buildUblCreditNoteXmlFromSallaRefund generates compliant 381 Credit Note with BillingReference', () => {
  const workDir = join(process.cwd(), '.zatca-test-keys-cn');
  const { privateKeyPem, certPem } = generateValidSecp256k1TestCert(workDir);

  const originalUuid = 'c1234567-89ab-cdef-0123-456789abcdef';
  const originalIcv = 42;
  const returnReason = 'Customer returned damaged goods';

  const mockSallaOrder = {
    id: 991122,
    date: { date: '2026-10-20 15:00:00', timezone: 'Asia/Riyadh' },
    status: { id: 1, name: 'Refunded', slug: 'refunded' },
    payment_method: 'mada',
    currency: 'SAR',
    amounts: {
      sub_total: { amount: 100, currency: 'SAR' },
      tax: { amount: { amount: 15, currency: 'SAR' }, percent: 15 },
      total: { amount: 115, currency: 'SAR' }
    },
    customer: {
      id: 5544,
      first_name: 'Fahad',
      last_name: 'Al-Otaibi',
      tax_number: null
    },
    items: [
      {
        id: 1,
        name: 'Cotton Shirt',
        quantity: 1,
        price: { amount: 100, currency: 'SAR' },
        total: { amount: 100, currency: 'SAR' }
      }
    ]
  };

  const rawCreditNoteXml = buildUblCreditNoteXmlFromSallaRefund({
    order: mockSallaOrder as any,
    originalInvoiceUuid: originalUuid,
    originalIcv,
    returnReason,
    uuid: 'e2222222-3333-4444-5555-666666666666',
    icv: 43,
    pih: 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==',
    issueDate: '2026-10-20',
    issueTime: '15:00:00Z',
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: true
  });

  // Verify InvoiceTypeCode is 381 (Credit Note)
  assert.ok(rawCreditNoteXml.includes('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>'));

  // Verify BillingReference points to original invoice UUID
  assert.ok(rawCreditNoteXml.includes(`<cbc:ID>${originalUuid}</cbc:ID>`));
  assert.ok(rawCreditNoteXml.includes('<cac:BillingReference>'));

  // Verify InstructionNote contains return reason
  assert.ok(rawCreditNoteXml.includes(`<cbc:InstructionNote>${returnReason}</cbc:InstructionNote>`));

  // Sign Credit Note
  const signed = signZatcaInvoiceExact({
    rawXml: rawCreditNoteXml,
    privateKeyPem,
    certPem,
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVatNumber: '300075588700003',
    grandTotal: '115.00',
    vatTotal: '15.00',
    issueDateTimeIsoZ: '2026-10-20T15:00:00Z',
    isB2C: true
  });

  assert.equal(signed.invoiceHashBase64.length, 44);
  assert.ok(signed.qrCodeBase64.length <= 700);
  assert.ok(signed.signedXml.includes('<ext:UBLExtensions>'));
  assert.ok(signed.signedXml.includes('CN-43'));

  // Verify post-XPath hash integrity
  const doc = new DOMParser().parseFromString(signed.signedXml, 'text/xml');
  const removeTags = (tagName: string, predicate?: (el: any) => boolean) => {
    const list = doc.getElementsByTagName(tagName);
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i];
      if (!predicate || predicate(node)) {
        node.parentNode?.removeChild(node);
      }
    }
  };

  removeTags('ext:UBLExtensions');
  removeTags('cac:Signature');
  removeTags('cac:AdditionalDocumentReference', (el) => {
    const id = el.getElementsByTagName('cbc:ID')[0]?.textContent?.trim();
    return id === 'QR';
  });

  const strippedBody = new XMLSerializer()
    .serializeToString(doc)
    .replace(/<\?xml[\s\S]*?\?>\s*/, '')
    .replace(/\r\n/g, '\n')
    .trim();

  const recalculatedHash = createHash('sha256').update(strippedBody, 'utf8').digest('base64');
  assert.equal(recalculatedHash, signed.invoiceHashBase64);
});
