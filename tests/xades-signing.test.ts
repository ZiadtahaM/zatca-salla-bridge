import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { signZatcaInvoiceExact, buildTlvQrBuffer } from '../src/crypto/zatca-signer.js';
import { buildCompliantUblTemplate, generateValidSecp256k1TestCert } from './helpers.js';

test('ZATCA XAdES-BES single-pass signing produces exact, byte-for-byte matching invoice hash', () => {
  const workDir = join(process.cwd(), '.zatca-test-keys');
  const { privateKeyPem, certPem } = generateValidSecp256k1TestCert(workDir);

  const issueDate = '2026-10-20';
  const issueTime = '14:30:00Z';
  const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
  const initialPih = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==';

  const rawXml = buildCompliantUblTemplate({
    uuid: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    sellerNameArabic: 'شركة رواء للتجارة الفاخرة',
    sellerVat: '300075588700003',
    issueDate,
    issueTime,
    pih: initialPih,
    icv: 1
  });

  const signed = signZatcaInvoiceExact({
    rawXml,
    privateKeyPem,
    certPem,
    sellerNameArabic: 'شركة رواء للتجارة الفاخرة',
    sellerVatNumber: '300075588700003',
    grandTotal: '115.00',
    vatTotal: '15.00',
    issueDateTimeIsoZ,
    isB2C: true
  });

  assert.equal(signed.invoiceHashBase64.length, 44, 'Invoice hash must be a 44-character Base64 string');
  assert.ok(signed.signatureValueBase64.length > 50, 'SignatureValue must be non-empty Base64');
  assert.ok(signed.qrCodeBase64.length > 100, 'QR code payload must be non-empty Base64');
  assert.ok(signed.qrCodeBase64.length <= 700, 'QR code Base64 length must not exceed 700 characters');

  // Verify that removing UBLExtensions, QR, and Signature from the output reproduces the exact same invoice hash
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
  assert.equal(
    recalculatedHash,
    signed.invoiceHashBase64,
    'Recalculated post-XPath hash must match signed invoiceHashBase64 byte-for-byte'
  );
});

test('buildTlvQrBuffer strictly enforces the 127-byte BER boundary on all tags', () => {
  const validPayload = {
    sellerName: 'مؤسسة الرياض',
    vatNumber: '300075588700003',
    issueDateTimeIsoZ: '2026-10-20T14:30:00Z',
    grandTotal: '115.00',
    vatTotal: '15.00',
    invoiceHashBase64: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    ecdsaSignatureBase64: Buffer.alloc(70, 0x11).toString('base64'),
    publicKeySpkiDer: Buffer.alloc(88, 0x22),
    caSignatureDer: Buffer.alloc(72, 0x33)
  };

  const qr = buildTlvQrBuffer(validPayload);
  assert.ok(qr.length > 50);
  assert.ok(qr.length <= 700);

  // Assert overflow throws
  assert.throws(
    () => {
      buildTlvQrBuffer({
        ...validPayload,
        sellerName: 'A'.repeat(128)
      });
    },
    /exceeds 127-byte single-byte BER limit/
  );
});
