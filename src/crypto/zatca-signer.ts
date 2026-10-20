import { createHash, createSign, X509Certificate } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export interface TlvInput {
  sellerName: string;
  vatNumber: string;
  issueDateTimeIsoZ: string;
  grandTotal: string;
  vatTotal: string;
  invoiceHashBase64: string;
  ecdsaSignatureBase64: string;
  publicKeySpkiDer: Buffer;
  caSignatureDer: Buffer;
}

export function extractCaSignatureFromDer(certDer: Buffer): Buffer {
  const searchStart = Math.max(0, certDer.length - 80);
  for (let i = searchStart; i < certDer.length - 4; i++) {
    const bitStringTag = certDer[i];
    const bitStringLen = certDer[i + 1];
    const unusedBits = certDer[i + 2];
    const seqTag = certDer[i + 3];

    if (
      bitStringTag === 0x03 &&
      unusedBits === 0x00 &&
      seqTag === 0x30 &&
      i + 2 + bitStringLen === certDer.length
    ) {
      return certDer.subarray(i + 3);
    }
  }
  throw new Error('Failed to locate ASN.1 CA signature BIT STRING in X.509 DER certificate');
}

export function extractX509Metadata(certPem: string): {
  certHashBase64: string;
  issuerName: string;
  serialNumber: string;
  publicKeySpkiDer: Buffer;
  caSignatureDer: Buffer;
} {
  const cleanCertBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const x509 = new X509Certificate(certPem);

  const certSha256Hex = createHash('sha256').update(cleanCertBase64, 'utf8').digest('hex');
  const certHashBase64 = Buffer.from(certSha256Hex, 'utf8').toString('base64');

  const issuerName = x509.issuer.split('\n').reverse().join(', ');
  const serialNumber = BigInt('0x' + x509.serialNumber).toString(10);
  const publicKeySpkiDer = x509.publicKey.export({ type: 'spki', format: 'der' });
  const caSignatureDer = extractCaSignatureFromDer(x509.raw);

  return {
    certHashBase64,
    issuerName,
    serialNumber,
    publicKeySpkiDer,
    caSignatureDer
  };
}

export function buildTlvQrBuffer(input: TlvInput): string {
  const tags: Array<{ tag: number; value: Buffer }> = [
    { tag: 1, value: Buffer.from(input.sellerName.normalize('NFC'), 'utf8') },
    { tag: 2, value: Buffer.from(input.vatNumber, 'utf8') },
    { tag: 3, value: Buffer.from(input.issueDateTimeIsoZ, 'utf8') },
    { tag: 4, value: Buffer.from(input.grandTotal, 'utf8') },
    { tag: 5, value: Buffer.from(input.vatTotal, 'utf8') },
    { tag: 6, value: Buffer.from(input.invoiceHashBase64, 'utf8') },
    { tag: 7, value: Buffer.from(input.ecdsaSignatureBase64, 'utf8') },
    { tag: 8, value: input.publicKeySpkiDer },
    { tag: 9, value: input.caSignatureDer }
  ];

  const chunks: Buffer[] = [];

  for (const item of tags) {
    if (item.value.length > 127) {
      throw new Error(`TLV Tag ${item.tag} length (${item.value.length}) exceeds 127-byte single-byte BER limit`);
    }
    chunks.push(Buffer.from([item.tag]));
    chunks.push(Buffer.from([item.value.length]));
    chunks.push(item.value);
  }

  const qrBase64 = Buffer.concat(chunks).toString('base64');

  if (qrBase64.length > 700) {
    throw new Error(`Generated Base64 QR code length (${qrBase64.length}) exceeds ZATCA 700-character ceiling`);
  }

  return qrBase64;
}

export function buildAndHashSignedProperties(params: {
  signingTimeIsoZ: string;
  certHashBase64: string;
  issuerName: string;
  serialNumber: string;
}): { signedPropertiesXml: string; signedPropertiesHashBase64: string } {
  const signedPropertiesXml =
    `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">` +
    `<xades:SignedSignatureProperties>` +
    `<xades:SigningTime>${params.signingTimeIsoZ}</xades:SigningTime>` +
    `<xades:SigningCertificate>` +
    `<xades:Cert>` +
    `<xades:CertDigest>` +
    `<ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${params.certHashBase64}</ds:DigestValue>` +
    `</xades:CertDigest>` +
    `<xades:IssuerSerial>` +
    `<ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${params.issuerName}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${params.serialNumber}</ds:X509SerialNumber>` +
    `</xades:IssuerSerial>` +
    `</xades:Cert>` +
    `</xades:SigningCertificate>` +
    `</xades:SignedSignatureProperties>` +
    `</xades:SignedProperties>`;

  const hexDigest = createHash('sha256').update(signedPropertiesXml, 'utf8').digest('hex');
  const signedPropertiesHashBase64 = Buffer.from(hexDigest, 'utf8').toString('base64');

  return { signedPropertiesXml, signedPropertiesHashBase64 };
}

export interface SignParams {
  rawXml: string;
  privateKeyPem: string;
  certPem: string;
  sellerNameArabic: string;
  sellerVatNumber: string;
  grandTotal: string;
  vatTotal: string;
  issueDateTimeIsoZ: string;
  isB2C: boolean;
}

export interface SignOutput {
  invoiceHashBase64: string;
  signatureValueBase64: string;
  qrCodeBase64: string;
  signedXml: string;
}

export function signZatcaInvoiceExact(params: SignParams): SignOutput {
  const step1Doc = new DOMParser().parseFromString(params.rawXml, 'text/xml');

  const removeElement = (el: any) => {
    el.parentNode?.removeChild(el);
  };

  const stripByTagName = (tagName: string, predicate?: (el: any) => boolean) => {
    const list = step1Doc.getElementsByTagName(tagName);
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i];
      if (!predicate || predicate(node)) {
        removeElement(node);
      }
    }
  };

  stripByTagName('ext:UBLExtensions');
  stripByTagName('cac:Signature');
  stripByTagName('cac:AdditionalDocumentReference', (el) => {
    const id = el.getElementsByTagName('cbc:ID')[0]?.textContent?.trim();
    return id === 'QR';
  });

  const canonicalInvoiceBody = new XMLSerializer()
    .serializeToString(step1Doc)
    .replace(/<\?xml[\s\S]*?\?>\s*/, '')
    .replace(/\r\n/g, '\n')
    .trim();

  const rawSha256Bytes = createHash('sha256').update(canonicalInvoiceBody, 'utf8').digest();
  const invoiceHashBase64 = rawSha256Bytes.toString('base64');

  const signer = createSign('SHA256');
  signer.update(canonicalInvoiceBody, 'utf8');
  const signatureDer = signer.sign(params.privateKeyPem);
  const signatureValueBase64 = signatureDer.toString('base64');

  const certMeta = extractX509Metadata(params.certPem);

  const { signedPropertiesXml, signedPropertiesHashBase64 } = buildAndHashSignedProperties({
    signingTimeIsoZ: params.issueDateTimeIsoZ,
    certHashBase64: certMeta.certHashBase64,
    issuerName: certMeta.issuerName,
    serialNumber: certMeta.serialNumber
  });

  let qrCodeBase64 = '';
  if (params.isB2C) {
    qrCodeBase64 = buildTlvQrBuffer({
      sellerName: params.sellerNameArabic,
      vatNumber: params.sellerVatNumber,
      issueDateTimeIsoZ: params.issueDateTimeIsoZ,
      grandTotal: params.grandTotal,
      vatTotal: params.vatTotal,
      invoiceHashBase64,
      ecdsaSignatureBase64: signatureValueBase64,
      publicKeySpkiDer: certMeta.publicKeySpkiDer,
      caSignatureDer: certMeta.caSignatureDer
    });
  }

  const cleanCert = params.certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const ublExtensionsLinear =
    `<ext:UBLExtensions>` +
    `<ext:UBLExtension>` +
    `<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
    `<ext:ExtensionContent>` +
    `<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">` +
    `<sac:SignatureInformation>` +
    `<cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>` +
    `<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>` +
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">` +
    `<ds:SignedInfo>` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>` +
    `<ds:Reference Id="invoiceSignedData" URI="">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath></ds:Transform>` +
    `<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${invoiceHashBase64}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignedProperties" URI="#xadesSignedProperties">` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${signedPropertiesHashBase64}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>` +
    `<ds:SignatureValue>${signatureValueBase64}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${cleanCert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    `<ds:Object><xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">${signedPropertiesXml}</xades:QualifyingProperties></ds:Object>` +
    `</ds:Signature>` +
    `</sac:SignatureInformation>` +
    `</sig:UBLDocumentSignatures>` +
    `</ext:ExtensionContent>` +
    `</ext:UBLExtension>` +
    `</ext:UBLExtensions>`;

  const qrAndSignatureLinear =
    (qrCodeBase64
      ? `<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cac:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qrCodeBase64}</cac:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`
      : '') +
    `<cac:Signature><cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID><cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod></cac:Signature>`;

  let signedXml = canonicalInvoiceBody
    .replace(/(<Invoice[^>]*>)/, `$1${ublExtensionsLinear}`)
    .replace(/(<cac:AccountingSupplierParty>)/, `${qrAndSignatureLinear}$1`);

  signedXml = `<?xml version="1.0" encoding="UTF-8"?>\n${signedXml}`;

  return {
    invoiceHashBase64,
    signatureValueBase64,
    qrCodeBase64,
    signedXml
  };
}

export interface TlvEntry {
  tag: number;
  value: Buffer;
}

export function parseTlvQrBuffer(buf: Buffer): TlvEntry[] {
  const result: TlvEntry[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 2 > buf.length) {
      throw new Error(`Unexpected end of TLV buffer at offset ${offset}`);
    }
    const tag = buf[offset];
    const length = buf[offset + 1];
    offset += 2;
    if (offset + length > buf.length) {
      throw new Error(`TLV tag ${tag} length ${length} exceeds remaining buffer size`);
    }
    const value = buf.subarray(offset, offset + length);
    result.push({ tag, value });
    offset += length;
  }
  return result;
}
