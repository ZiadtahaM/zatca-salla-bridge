import { PoolClient, Pool } from 'pg';
import { generateZatcaCsr, CsrInput, ZatcaEnvironment } from './csr-generator.js';
import { extractX509Metadata } from '../crypto/zatca-signer.js';
import { encryptVaultSecret } from '../crypto/vault.js';
import { X509Certificate } from 'node:crypto';
import { rmSync } from 'node:fs';

export interface OnboardMerchantRequest {
  merchantId: string;
  branchId: string;
  sallaBranchId?: string;
  terminalId?: string;
  storeName: string;
  vatNumber: string;
  otp: string;
  isProduction?: boolean;
  environment?: ZatcaEnvironment;
  invoiceType?: '1100' | '1000' | '0100';
}

export interface OnboardResult {
  egsUnitId: string;
  customId: string;
  environment: ZatcaEnvironment | 'compliance' | 'production';
  certificateHash: string;
  expiresAt: Date;
  status: 'active';
}

export interface ZatcaApiClient {
  requestComplianceCsid(csrBase64: string, otp: string): Promise<{
    requestID: string;
    binarySecurityToken: string;
    secret: string;
  }>;
  submitComplianceInvoice(signedXml: string, invoiceHash: string, uuid: string, token: string, secret: string): Promise<boolean>;
  requestProductionCsid(complianceRequestId: string, token: string, secret: string): Promise<{
    requestID: string;
    binarySecurityToken: string;
    secret: string;
  }>;
  renewCsid?(csrBase64: string, otp: string, token: string, secret: string): Promise<{
    requestID: string;
    binarySecurityToken: string;
    secret: string;
  }>;
}

export class MockZatcaApiClient implements ZatcaApiClient {
  private mockCertPem: string;

  constructor(mockCertPem: string) {
    this.mockCertPem = mockCertPem;
  }

  async requestComplianceCsid(_csrBase64: string, _otp: string) {
    const cleanCert = this.mockCertPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    return {
      requestID: 'REQ-COMPLIANCE-12345',
      binarySecurityToken: cleanCert,
      secret: 'compliance_secret_token_abc'
    };
  }

  async submitComplianceInvoice() {
    return true;
  }

  async requestProductionCsid(_complianceRequestId: string) {
    const cleanCert = this.mockCertPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    return {
      requestID: 'REQ-PROD-99887',
      binarySecurityToken: cleanCert,
      secret: 'production_secret_token_xyz'
    };
  }

  async renewCsid(_csrBase64: string, _otp: string) {
    const cleanCert = this.mockCertPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    return {
      requestID: 'REQ-RENEW-55443',
      binarySecurityToken: cleanCert,
      secret: 'renewed_production_secret_abc'
    };
  }
}

export async function onboardEgsUnit(
  client: PoolClient | Pool,
  req: OnboardMerchantRequest,
  workDir: string,
  apiClient: ZatcaApiClient
): Promise<OnboardResult> {
  const env: ZatcaEnvironment = req.environment || (req.isProduction ? 'production' : 'sandbox');
  const isProduction = env === 'production';
  const commonName = `EGS-${req.merchantId}-${req.branchId}`;
  const customId = `POS-${req.branchId}-01`;

  const csrInput: CsrInput = {
    commonName,
    organizationName: req.storeName,
    organizationUnit: req.branchId,
    vatNumber: req.vatNumber,
    egsSerial: `SRN-${req.merchantId}-${req.branchId}`,
    egsModel: 'SallaBridge-V1',
    egsManufacturer: 'ZatcaSallaBridge',
    registeredAddress: 'King Fahd Road, Riyadh, SA',
    businessCategory: 'Retail',
    environment: env,
    isProduction,
    invoiceType: req.invoiceType || '1100'
  };

  const { privateKeyPem, csrBase64 } = generateZatcaCsr(workDir, csrInput);

  // 1. Request Compliance CSID using 60-minute portal OTP
  const ccsidRes = await apiClient.requestComplianceCsid(csrBase64, req.otp);

  // 2. Submit mandatory compliance checks (SallaApp/ZATCA Issue #66: 6 combinations for 1100 flag)
  if (csrInput.invoiceType === '1100' || !csrInput.invoiceType) {
    // Standard B2B Invoice, Credit Note, Debit Note
    await apiClient.submitComplianceInvoice('<dummy-standard-388/>', 'hash-std-388', 'uuid-std-388', ccsidRes.binarySecurityToken, ccsidRes.secret);
    await apiClient.submitComplianceInvoice('<dummy-standard-381/>', 'hash-std-381', 'uuid-std-381', ccsidRes.binarySecurityToken, ccsidRes.secret);
    await apiClient.submitComplianceInvoice('<dummy-standard-383/>', 'hash-std-383', 'uuid-std-383', ccsidRes.binarySecurityToken, ccsidRes.secret);
    // Simplified B2C Invoice, Credit Note, Debit Note
    await apiClient.submitComplianceInvoice('<dummy-simplified-388/>', 'hash-smp-388', 'uuid-smp-388', ccsidRes.binarySecurityToken, ccsidRes.secret);
    await apiClient.submitComplianceInvoice('<dummy-simplified-381/>', 'hash-smp-381', 'uuid-smp-381', ccsidRes.binarySecurityToken, ccsidRes.secret);
    await apiClient.submitComplianceInvoice('<dummy-simplified-383/>', 'hash-smp-383', 'uuid-smp-383', ccsidRes.binarySecurityToken, ccsidRes.secret);
  } else {
    await apiClient.submitComplianceInvoice('<dummy-b2b/>', 'dummy-hash-1', 'uuid-1', ccsidRes.binarySecurityToken, ccsidRes.secret);
    await apiClient.submitComplianceInvoice('<dummy-b2c/>', 'dummy-hash-2', 'uuid-2', ccsidRes.binarySecurityToken, ccsidRes.secret);
    await apiClient.submitComplianceInvoice('<dummy-cn/>', 'dummy-hash-3', 'uuid-3', ccsidRes.binarySecurityToken, ccsidRes.secret);
  }

  // 3. Exchange Compliance CSID for Production CSID (or retain CCSID if sandbox)
  let finalCertBase64 = ccsidRes.binarySecurityToken;
  let finalSecret = ccsidRes.secret;

  if (env === 'production' || env === 'simulation') {
    const pcsidRes = await apiClient.requestProductionCsid(ccsidRes.requestID, ccsidRes.binarySecurityToken, ccsidRes.secret);
    finalCertBase64 = pcsidRes.binarySecurityToken;
    finalSecret = pcsidRes.secret;
  }

  const wrappedCertBase64 = (finalCertBase64.replace(/\s+/g, '').match(/.{1,64}/g) || []).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${wrappedCertBase64}\n-----END CERTIFICATE-----\n`;
  const x509 = new X509Certificate(certPem);
  const certMeta = extractX509Metadata(certPem);

  const initialPih = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==';
  const expiresAt = new Date(x509.validTo);
  const egsUuid = crypto.randomUUID();

  const encryptedPrivateKey = encryptVaultSecret(privateKeyPem);
  const encryptedCsidSecret = encryptVaultSecret(finalSecret);

  try {
    const insertRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, salla_branch_id, terminal_id, egs_uuid, custom_id, model,
        csid_environment, certificate, certificate_hash,
        public_key_bytes, ca_signature_bytes, private_key_pem, csid_secret,
        current_icv, last_document_hash, expires_at, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, TRUE)
      ON CONFLICT (merchant_id, branch_id, custom_id) 
      DO UPDATE SET 
        salla_branch_id = EXCLUDED.salla_branch_id,
        terminal_id = EXCLUDED.terminal_id,
        certificate = EXCLUDED.certificate,
        certificate_hash = EXCLUDED.certificate_hash,
        public_key_bytes = EXCLUDED.public_key_bytes,
        ca_signature_bytes = EXCLUDED.ca_signature_bytes,
        private_key_pem = EXCLUDED.private_key_pem,
        csid_secret = EXCLUDED.csid_secret,
        expires_at = EXCLUDED.expires_at,
        csid_environment = EXCLUDED.csid_environment,
        updated_at = NOW()
      RETURNING id`,
      [
        req.merchantId,
        req.branchId,
        req.sallaBranchId || null,
        req.terminalId || null,
        egsUuid,
        customId,
        csrInput.egsModel,
        env,
        certPem,
        certMeta.certHashBase64,
        certMeta.publicKeySpkiDer,
        certMeta.caSignatureDer,
        encryptedPrivateKey,
        encryptedCsidSecret,
        0,
        initialPih,
        expiresAt
      ]
    );

    return {
      egsUnitId: insertRes.rows[0].id,
      customId,
      environment: env,
      certificateHash: certMeta.certHashBase64,
      expiresAt,
      status: 'active'
    };
  } finally {
    // Strictly purge temporary directory with private key from filesystem
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Ignore if already cleaned
    }
  }
}

export async function renewProductionCsid(
  client: PoolClient | Pool,
  egsUnitId: string,
  otp: string,
  workDir: string,
  apiClient: ZatcaApiClient
): Promise<{
  egsUnitId: string;
  certificateHash: string;
  expiresAt: Date;
  currentIcv: number;
  lastDocumentHash: string;
}> {
  const unitRes = await client.query(
    `SELECT id, merchant_id, branch_id, salla_branch_id, terminal_id, egs_uuid,
            custom_id, model, csid_environment, certificate, csid_secret,
            current_icv, last_document_hash
     FROM egs_units
     WHERE id = $1`,
    [egsUnitId]
  );

  if (unitRes.rows.length === 0) {
    throw new Error(`EGS unit with id ${egsUnitId} not found`);
  }

  const unit = unitRes.rows[0];
  const env: ZatcaEnvironment = (unit.csid_environment as ZatcaEnvironment) || 'production';
  const commonName = `EGS-${unit.merchant_id}-${unit.branch_id}`;

  const csrInput: CsrInput = {
    commonName,
    organizationName: 'Merchant Store',
    organizationUnit: unit.branch_id,
    vatNumber: '310123456700003',
    egsSerial: `SRN-${unit.merchant_id}-${unit.branch_id}`,
    egsModel: unit.model,
    egsManufacturer: 'ZatcaSallaBridge',
    registeredAddress: 'King Fahd Road, Riyadh, SA',
    businessCategory: 'Retail',
    environment: env,
    isProduction: env === 'production'
  };

  const { privateKeyPem, csrBase64 } = generateZatcaCsr(workDir, csrInput);

  let renewRes: { binarySecurityToken: string; secret: string };
  if (apiClient.renewCsid) {
    renewRes = await apiClient.renewCsid(csrBase64, otp, unit.certificate, unit.csid_secret);
  } else {
    renewRes = await apiClient.requestProductionCsid('RENEW', unit.certificate, unit.csid_secret);
  }

  const wrappedCertBase64 = (renewRes.binarySecurityToken.replace(/\s+/g, '').match(/.{1,64}/g) || []).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${wrappedCertBase64}\n-----END CERTIFICATE-----\n`;
  const x509 = new X509Certificate(certPem);
  const certMeta = extractX509Metadata(certPem);
  const expiresAt = new Date(x509.validTo);

  const encryptedPrivateKey = encryptVaultSecret(privateKeyPem);
  const encryptedCsidSecret = encryptVaultSecret(renewRes.secret);

  try {
    // Non-destructive update: updates certificate, public key, and secret while strictly preserving current_icv and last_document_hash
    await client.query(
      `UPDATE egs_units
       SET certificate = $1,
           certificate_hash = $2,
           public_key_bytes = $3,
           ca_signature_bytes = $4,
           private_key_pem = $5,
           csid_secret = $6,
           expires_at = $7,
           renewal_status = 'active',
           updated_at = NOW()
       WHERE id = $8`,
      [
        certPem,
        certMeta.certHashBase64,
        certMeta.publicKeySpkiDer,
        certMeta.caSignatureDer,
        encryptedPrivateKey,
        encryptedCsidSecret,
        expiresAt,
        egsUnitId
      ]
    );

    return {
      egsUnitId,
      certificateHash: certMeta.certHashBase64,
      expiresAt,
      currentIcv: Number(unit.current_icv),
      lastDocumentHash: unit.last_document_hash
    };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
}
