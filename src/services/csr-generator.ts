import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface CsrInput {
  commonName: string;
  organizationName: string;
  organizationUnit: string;
  vatNumber: string;
  egsSerial: string;
  egsModel: string;
  egsManufacturer: string;
  registeredAddress: string;
  businessCategory: string;
  isProduction: boolean;
}

export function resolveOpenSslPath(): string {
  const gitOpenSsl = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  if (process.platform === 'win32' && existsSync(gitOpenSsl)) {
    return gitOpenSsl;
  }
  return 'openssl';
}

export function generateZatcaCsr(
  workDir: string,
  input: CsrInput
): { privateKeyPem: string; csrPem: string; csrBase64: string } {
  mkdirSync(workDir, { recursive: true });

  const keyPath = join(workDir, 'private_key.pem');
  const csrPath = join(workDir, 'egs.csr');
  const cnfPath = join(workDir, 'csr.cnf');

  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  writeFileSync(keyPath, privateKey, 'utf8');

  const templateOidValue = input.isProduction
    ? 'ZATCA-Code-Signing'
    : 'PREPSIT-Solution';

  // 1100: Standard B2B and Simplified B2C capability flag
  const invoiceTypeFlag = '1100';

  const cnfContent = `
[req]
prompt = no
distinguished_name = req_dn
req_extensions = v3_req

[req_dn]
C = SA
OU = ${input.organizationUnit}
O = ${input.organizationName.normalize('NFC')}
CN = ${input.commonName}

[v3_req]
basicConstraints = critical, CA:FALSE
keyUsage = digitalSignature, nonRepudiation
subjectAltName = dirName:dir_sect
1.3.6.1.4.1.311.20.2 = ASN1:PRINTABLESTRING:${templateOidValue}

[dir_sect]
SN = 1-${input.egsManufacturer}|2-${input.egsModel}|3-${input.egsSerial}
UID = ${input.vatNumber}
title = ${invoiceTypeFlag}
registeredAddress = ${input.registeredAddress}
businessCategory = ${input.businessCategory}
`;

  writeFileSync(cnfPath, cnfContent, 'utf8');

  const openssl = resolveOpenSslPath();
  execFileSync(openssl, [
    'req',
    '-new',
    '-key',
    keyPath,
    '-out',
    csrPath,
    '-config',
    cnfPath
  ]);

  const csrPem = readFileSync(csrPath, 'utf8');
  const csrBase64 = csrPem
    .replace(/-----BEGIN CERTIFICATE REQUEST-----/g, '')
    .replace(/-----END CERTIFICATE REQUEST-----/g, '')
    .replace(/\s+/g, '');

  return {
    privateKeyPem: privateKey,
    csrPem,
    csrBase64
  };
}
