import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function resolveOpenSslBinary(): string {
  const gitOpenSsl = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  if (process.platform === 'win32' && existsSync(gitOpenSsl)) {
    return gitOpenSsl;
  }
  return 'openssl';
}

export function generateValidSecp256k1TestCert(workDir: string): {
  privateKeyPem: string;
  certPem: string;
} {
  mkdirSync(workDir, { recursive: true });
  const keyPath = join(workDir, 'ec-secp256k1-privkey.pem');
  const certPath = join(workDir, 'cert.pem');
  const cnfPath = join(workDir, 'openssl.cnf');

  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    },
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    }
  });

  writeFileSync(keyPath, privateKey, 'utf8');

  const cnf = [
    '[req]',
    'prompt = no',
    'distinguished_name = dn',
    '[dn]',
    'C = SA',
    'OU = Riyadh Branch',
    'O = Al-Riyadh Trading Co',
    'CN = TS-EGS-001'
  ].join('\n');

  writeFileSync(cnfPath, cnf, 'utf8');

  const opensslBin = resolveOpenSslBinary();
  execFileSync(opensslBin, [
    'req',
    '-new',
    '-x509',
    '-nodes',
    '-days',
    '365',
    '-key',
    keyPath,
    '-out',
    certPath,
    '-config',
    cnfPath
  ]);

  const certPem = readFileSync(certPath, 'utf8');
  return { privateKeyPem: privateKey, certPem };
}

export function buildCompliantUblTemplate(options: {
  uuid: string;
  sellerNameArabic: string;
  sellerVat: string;
  issueDate: string;
  issueTime: string;
  pih: string;
  icv: number;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-${options.icv}</cbc:ID>
  <cbc:UUID>${options.uuid}</cbc:UUID>
  <cbc:IssueDate>${options.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${options.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${options.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cac:EmbeddedDocumentBinaryObject mimeCode="text/plain">${options.pih}</cac:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">1010010000</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>King Fahd Road</cbc:StreetName>
        <cbc:BuildingNumber>1234</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>Al-Olaya</cbc:CitySubdivisionName>
        <cbc:CityName>Riyadh</cbc:CityName>
        <cbc:PostalZone>12211</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${options.sellerVat}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${options.sellerNameArabic.normalize('NFC')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">100.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">115.00</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">0.00</cbc:AllowanceTotalAmount>
    <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="SAR">115.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="SAR">115.00</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>Standard Item</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">100.00</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
}

export function attachStatefulRelationalTestDb(pool: any): void {
  const merchantTokens: any[] = [];
  const egsUnits: any[] = [];
  const invoices: any[] = [];
  const pendingB2bOrders: any[] = [];
  const merchantSubscriptions: any[] = [];
  const zatcaDlq: any[] = [];
  const auditLogs: any[] = [];
  const orderSyncRecords: any[] = [];
  const orderSyncTransitions: any[] = [];
  const reconciliationJobs: any[] = [];
  const reconciliationDiscrepancies: any[] = [];
  const webhookQueue: any[] = [];

  const executeQuery = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.includes('INSERT INTO audit_logs')) {
      const [entity_type, entity_id, action, actor, payload] = params;
      const log = {
        id: randomUUID(),
        entity_type,
        entity_id,
        action,
        actor,
        payload,
        created_at: new Date()
      };
      auditLogs.push(log);
      return { rows: [log], rowCount: 1 };
    }

    if (normalized.includes('UPDATE audit_logs') || normalized.includes('DELETE FROM audit_logs')) {
      throw new Error('TAMPER_EVIDENT_PROTECTION: UPDATE and DELETE operations are forbidden on audit_logs');
    }

    if (normalized.includes('UPDATE order_sync_transitions') || normalized.includes('DELETE FROM order_sync_transitions')) {
      throw new Error('TAMPER_EVIDENT_PROTECTION: UPDATE and DELETE operations are strictly forbidden on order_sync_transitions');
    }

    if (normalized.includes('INSERT INTO merchant_tokens')) {
      let merchant_id: any;
      let access_token_encrypted: any;
      let refresh_token_encrypted: any;
      let expires_at: any = new Date(Date.now() + 30 * 86400 * 1000);
      let token_scope: any = 'offline_access';
      let store_name: any = null;
      let vat_number: any = null;
      let crn: any = null;
      let city: any = null;

      let cod_fulfillment_statuses: any = null;
      const codMatch = sql.match(/'(\[[^']+\])'::jsonb/);
      if (codMatch) {
        try {
          cod_fulfillment_statuses = JSON.parse(codMatch[1]);
        } catch {
          cod_fulfillment_statuses = codMatch[1];
        }
      }

      if (params.length === 2) {
        const idMatch = sql.match(/VALUES\s*\(\s*'([^']+)'/i);
        merchant_id = idMatch ? idMatch[1] : 'salla_demo_store';
        const storeMatch = sql.match(/'([^']*(?:مؤسسة|شركة|متجر)[^']*)'/i);
        store_name = storeMatch ? storeMatch[1] : 'متجر سلة التجريبي';
        const vatMatch = sql.match(/'(3\d{13}3)'/);
        vat_number = vatMatch ? vatMatch[1] : '300075588700003';
        const crnMatch = sql.match(/'(1010\d{6})'/);
        crn = crnMatch ? crnMatch[1] : '1010010000';
        access_token_encrypted = params[0];
        refresh_token_encrypted = params[1];
      } else if (params.length === 3) {
        merchant_id = params[0];
        access_token_encrypted = params[1];
        refresh_token_encrypted = params[2];
        const storeMatch = sql.match(/'([^']*(?:مؤسسة|شركة|متجر)[^']*)'/i);
        if (storeMatch) store_name = storeMatch[1];
        const vatMatch = sql.match(/'(3\d{13}3)'/);
        if (vatMatch) vat_number = vatMatch[1];
        const crnMatch = sql.match(/'(1010\d{6})'/);
        if (crnMatch) crn = crnMatch[1];
      } else {
        [merchant_id, access_token_encrypted, refresh_token_encrypted, expires_at, token_scope, store_name, vat_number, crn, city] = params;
      }

      if (!String(access_token_encrypted).startsWith('v1:') || !String(refresh_token_encrypted).startsWith('v1:')) {
        throw new Error('new row for relation "merchant_tokens" violates check constraint "chk_merchant_access_token"');
      }
      const existing = merchantTokens.find((t) => t.merchant_id === merchant_id);
      if (existing) {
        existing.access_token_encrypted = access_token_encrypted;
        existing.refresh_token_encrypted = refresh_token_encrypted;
        existing.expires_at = expires_at;
        existing.token_scope = token_scope;
        if (store_name !== undefined) existing.store_name = store_name;
        if (vat_number !== undefined) existing.vat_number = vat_number;
        if (crn !== undefined) existing.crn = crn;
        if (city !== undefined) existing.city = city;
        if (cod_fulfillment_statuses !== null) existing.cod_fulfillment_statuses = cod_fulfillment_statuses;
        existing.updated_at = new Date();
      } else {
        merchantTokens.push({
          id: randomUUID(),
          merchant_id,
          access_token_encrypted,
          refresh_token_encrypted,
          expires_at,
          token_scope,
          store_name: store_name || null,
          vat_number: vat_number || null,
          crn: crn || null,
          city: city || null,
          cod_fulfillment_statuses: cod_fulfillment_statuses || null,
          created_at: new Date(),
          updated_at: new Date()
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes('UPDATE merchant_tokens SET store_name =')) {
      const existing = merchantTokens.find((t) => t.merchant_id === params[4]);
      if (existing) {
        existing.store_name = params[0];
        existing.vat_number = params[1];
        existing.crn = params[2];
        existing.city = params[3];
        existing.updated_at = new Date();
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }

    if (normalized.includes('UPDATE merchant_tokens SET access_token_encrypted =')) {
      const existing = merchantTokens.find((t) => t.merchant_id === params[3]);
      if (existing) {
        existing.access_token_encrypted = params[0];
        existing.refresh_token_encrypted = params[1];
        existing.expires_at = params[2];
        existing.updated_at = new Date();
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }

    if (normalized.includes('UPDATE merchant_tokens SET expires_at =')) {
      const existing = merchantTokens.find((t) => t.merchant_id === params[1]);
      if (existing) {
        existing.expires_at = new Date(params[0]);
        existing.updated_at = new Date();
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }

    if (normalized.includes('FROM merchant_tokens')) {
      const rows = normalized.includes('WHERE merchant_id = $1')
        ? merchantTokens.filter((t) => t.merchant_id === params[0])
        : merchantTokens;
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('INSERT INTO merchant_subscriptions')) {
      const [merchant_id, plan_name, status, expires_at, trial_ends_at] = params;
      const existing = merchantSubscriptions.find((s) => s.merchant_id === merchant_id);
      if (existing) {
        existing.plan_name = plan_name;
        existing.status = status;
        existing.expires_at = expires_at;
        existing.trial_ends_at = trial_ends_at;
        existing.updated_at = new Date();
      } else {
        merchantSubscriptions.push({
          id: randomUUID(),
          merchant_id,
          plan_name: plan_name || 'standard',
          status: status || 'active',
          expires_at: expires_at || null,
          trial_ends_at: trial_ends_at || null,
          created_at: new Date(),
          updated_at: new Date()
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes('UPDATE merchant_subscriptions SET status =')) {
      const existing = merchantSubscriptions.find((s) => s.merchant_id === params[params.length - 1]);
      if (existing) {
        existing.status = params[0];
        if (params.length > 2) {
          existing.expires_at = params[1];
        }
        existing.updated_at = new Date();
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }

    if (normalized.includes('FROM merchant_subscriptions WHERE merchant_id = $1')) {
      const rows = merchantSubscriptions.filter((s) => s.merchant_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('INSERT INTO egs_units')) {
      let merchant_id: any;
      let branch_id: any;
      let salla_branch_id: any = null;
      let terminal_id: any = null;
      let egs_uuid: any = '11111111-2222-3333-4444-555555555555';
      let custom_id: any;
      let model: any = 'SallaBridge-V1';
      let csid_environment: any = 'sandbox';
      let certificate: any;
      let certificate_hash: any = 'dummy_hash';
      let public_key_bytes: any = null;
      let ca_signature_bytes: any = null;
      let private_key_pem: any;
      let csid_secret: any;
      let current_icv: any = 1;
      let last_document_hash: any = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==';
      let expires_at: any = new Date(Date.now() + 365 * 86400 * 1000);
      let crn_param: any = null;
      let vat_param: any = null;
      let branch_name_param: any = null;

      if (params.length === 3) {
        const mMatch = sql.match(/VALUES\s*\(\s*'([^']+)'/i);
        merchant_id = mMatch ? mMatch[1] : 'salla_demo_store';
        const bMatch = sql.match(/VALUES\s*\([^,]+,\s*'([^']+)',\s*'([^']+)'/i);
        branch_id = bMatch ? bMatch[1] : 'riyadh_hq';
        custom_id = bMatch ? bMatch[2] : 'live_prod_test_unit';
        const icvMatch = sql.match(/TRUE,\s*(\d+)/i);
        if (icvMatch) {
          current_icv = Number(icvMatch[1]);
        }
        private_key_pem = params[0];
        certificate = params[1];
        csid_secret = params[2];
      } else if (params.length === 5) {
        merchant_id = params[0];
        const bMatch = sql.match(/VALUES\s*\([^,]+,\s*'([^']+)',\s*'([^']+)'/i);
        if (bMatch) {
          branch_id = bMatch[1];
          custom_id = bMatch[2];
        } else {
          branch_id = normalized.includes("'main'") ? 'main' : (normalized.includes("'bare_branch'") ? 'bare_branch' : 'branch_east');
          custom_id = normalized.includes("'egs_cod_01'") ? 'egs_cod_01' : (normalized.includes("'egs_incomplete_01'") ? 'egs_incomplete_01' : 'egs_dyn_01');
        }
        private_key_pem = params[1];
        certificate = params[2];
        csid_secret = params[3];
        egs_uuid = params[4];
      } else if (params.length === 7) {
        merchant_id = params[0];
        branch_id = 'riyadh_branch';
        custom_id = 'EGS-DEMO-01';
        private_key_pem = params[1];
        certificate = params[2];
        csid_secret = params[3];
        crn_param = params[4];
        vat_param = params[5];
        branch_name_param = params[6];
      } else {
        [
          merchant_id,
          branch_id,
          salla_branch_id,
          terminal_id,
          egs_uuid,
          custom_id,
          model,
          csid_environment,
          certificate,
          certificate_hash,
          public_key_bytes,
          ca_signature_bytes,
          private_key_pem,
          csid_secret,
          current_icv,
          last_document_hash,
          expires_at,
          crn_param,
          vat_param,
          branch_name_param
        ] = params;
      }

      if (!String(private_key_pem).startsWith('v1:') || !String(csid_secret).startsWith('v1:')) {
        throw new Error('new row for relation "egs_units" violates check constraint "chk_egs_encrypted_key"');
      }

      let unit = egsUnits.find(
        (u) => u.merchant_id === merchant_id && u.branch_id === branch_id && u.custom_id === custom_id
      );
      if (unit) {
        Object.assign(unit, {
          salla_branch_id,
          terminal_id,
          certificate,
          certificate_hash,
          public_key_bytes,
          ca_signature_bytes,
          private_key_pem,
          csid_secret,
          expires_at,
          csid_environment,
          crn: crn_param || unit.crn,
          vat_number: vat_param || unit.vat_number,
          branch_name: branch_name_param || unit.branch_name,
          updated_at: new Date()
        });
      } else {
        unit = {
          id: randomUUID(),
          merchant_id,
          branch_id,
          salla_branch_id,
          terminal_id,
          egs_uuid,
          custom_id,
          model,
          csid_environment,
          certificate,
          certificate_hash,
          public_key_bytes,
          ca_signature_bytes,
          private_key_pem,
          csid_secret,
          current_icv: Number(current_icv),
          last_document_hash,
          expires_at,
          is_active: true,
          crn: crn_param || null,
          vat_number: vat_param || null,
          branch_name: branch_name_param || null,
          created_at: new Date(),
          updated_at: new Date()
        };
        egsUnits.push(unit);
      }
      return { rows: [{ id: unit.id }], rowCount: 1 };
    }

    if (normalized.includes('FROM egs_units') && (normalized.includes('WHERE id = $1') || normalized.includes('WHERE e.id = $1'))) {
      const rows = egsUnits.filter((u) => u.id === params[0]).map((u) => {
        const m = merchantTokens.find((t) => t.merchant_id === u.merchant_id);
        return {
          ...u,
          seller_crn: u.crn || m?.crn || null,
          seller_vat: u.vat_number || m?.vat_number || null,
          seller_name_arabic: u.branch_name || m?.store_name || null
        };
      });
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('SELECT certificate FROM egs_units WHERE is_active = TRUE')) {
      const rows = egsUnits.filter((u) => u.is_active).slice(0, 1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM egs_units WHERE merchant_id = $1 AND salla_branch_id = $2 AND terminal_id = $3')) {
      const rows = egsUnits
        .filter(
          (u) =>
            u.merchant_id === params[0] &&
            u.salla_branch_id === params[1] &&
            u.terminal_id === params[2] &&
            u.is_active
        )
        .slice(0, 1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM egs_units WHERE merchant_id = $1 AND salla_branch_id = $2')) {
      const rows = egsUnits
        .filter((u) => u.merchant_id === params[0] && u.salla_branch_id === params[1] && u.is_active)
        .slice(0, 1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM egs_units') && (normalized.includes('(e.branch_id = $2 OR e.custom_id = $2)') || normalized.includes('(branch_id = $2 OR custom_id = $2)'))) {
      const rows = egsUnits
        .filter((u) => u.merchant_id === params[0] && (u.branch_id === params[1] || u.custom_id === params[1]) && u.is_active)
        .map((u) => {
          const m = merchantTokens.find((t) => t.merchant_id === u.merchant_id);
          return {
            ...u,
            seller_crn: u.crn || m?.crn || null,
            seller_vat: u.vat_number || m?.vat_number || null,
            seller_name_arabic: u.branch_name || m?.store_name || null
          };
        })
        .slice(0, 1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM egs_units') && (normalized.includes('e.merchant_id = $1 AND e.is_active = TRUE') || normalized.includes('merchant_id = $1 AND is_active = TRUE'))) {
      const rows = egsUnits
        .filter((u) => u.merchant_id === params[0] && u.is_active)
        .map((u) => {
          const m = merchantTokens.find((t) => t.merchant_id === u.merchant_id);
          return {
            ...u,
            seller_crn: u.crn || m?.crn || null,
            seller_vat: u.vat_number || m?.vat_number || null,
            seller_name_arabic: u.branch_name || m?.store_name || null
          };
        })
        .slice(0, 1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('UPDATE egs_units') && (normalized.includes('SET crn =') || normalized.includes('SET branch_name =') || normalized.includes('SET vat_number ='))) {
      const idParam = params && params.length > 0 ? params[params.length - 1] : null;
      const unit = egsUnits.find((u) => u.id === idParam);
      if (unit) {
        const crnMatch = sql.match(/crn\s*=\s*'([^']+)'/i);
        if (crnMatch) unit.crn = crnMatch[1];
        const branchMatch = sql.match(/branch_name\s*=\s*'([^']+)'/i);
        if (branchMatch) unit.branch_name = branchMatch[1];
        const vatMatch = sql.match(/vat_number\s*=\s*'([^']+)'/i);
        if (vatMatch) unit.vat_number = vatMatch[1];
        unit.updated_at = new Date();
      }
      return { rows: [], rowCount: unit ? 1 : 0 };
    }

    if (normalized.includes('UPDATE egs_units SET current_icv =')) {
      const unit = egsUnits.find((u) => u.id === params[params.length - 1]);
      if (unit) {
        if (normalized.includes('SET current_icv = $1')) {
          unit.current_icv = Number(params[0]);
          if (params.length > 2) {
            unit.last_document_hash = params[1];
          }
        } else {
          const match = normalized.match(/current_icv\s*=\s*(\d+)/);
          if (match) {
            unit.current_icv = Number(match[1]);
          }
          const hashMatch = normalized.match(/last_document_hash\s*=\s*'([^']+)'/);
          if (hashMatch) {
            unit.last_document_hash = hashMatch[1];
          }
        }
        unit.updated_at = new Date();
      }
      return { rows: [], rowCount: unit ? 1 : 0 };
    }

    if (normalized.includes('MAX(icv)') && normalized.includes('FROM invoices')) {
      const egsId = params[0];
      const matching = egsId ? invoices.filter((i) => i.egs_unit_id === egsId) : invoices;
      const maxIcv = matching.reduce((max, i) => Math.max(max, Number(i.icv) || 0), 0);
      return { rows: [{ max_icv: maxIcv }], rowCount: 1 };
    }

    if (normalized.includes('FROM invoices') && normalized.includes('WHERE idempotency_key = $1') && normalized.includes('replaces_invoice_id = $2')) {
      const idem = params[0];
      const repId = params[1];
      const rows = invoices.filter((i) => i.idempotency_key === idem || (i.replaces_invoice_id === repId && i.invoice_type !== 'credit_note' && i.idempotency_key === idem));
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM invoices WHERE replaces_invoice_id = $1')) {
      const rows = invoices.filter((i) => i.replaces_invoice_id === params[0] && i.invoice_type !== 'credit_note');
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM invoices WHERE idempotency_key = $1')) {
      const rows = invoices.filter((i) => i.idempotency_key === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM invoices') && (normalized.includes('replaces_invoice_id = $1 OR idempotency_key = $2') || normalized.includes('replaces_invoice_id = $1'))) {
      const repId = params[0];
      const idem = params.length > 1 ? params[1] : null;
      const rows = invoices.filter((i) => (i.replaces_invoice_id === repId && i.invoice_type !== 'credit_note') || (idem && i.idempotency_key === idem));
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM invoices WHERE order_id = $1 AND egs_unit_id = $2')) {
      const rows = invoices
        .filter(
          (i) =>
            String(i.order_id) === String(params[0]) &&
            i.egs_unit_id === params[1] &&
            ['simplified_tax_invoice', 'tax_invoice'].includes(i.invoice_type)
        )
        .slice(-1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM invoices WHERE order_id = $1 AND invoice_type IN')) {
      const rows = invoices
        .filter(
          (i) =>
            String(i.order_id) === String(params[0]) &&
            ['simplified_tax_invoice', 'tax_invoice'].includes(i.invoice_type)
        )
        .slice(-1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('INSERT INTO invoices')) {
      const id = randomUUID();
      if (normalized.includes("'credit_note'")) {
        const [
          egs_unit_id,
          order_id,
          idempotency_key,
          uuid,
          icv,
          pih,
          invoice_hash,
          qr_code_payload,
          signed_xml,
          supply_date,
          issue_timestamp,
          replaces_invoice_id,
          subtotal,
          tax_total,
          grand_total,
          raw_order_payload
        ] = params;
        invoices.push({
          id,
          egs_unit_id,
          order_id: String(order_id),
          idempotency_key,
          invoice_type: 'credit_note',
          uuid,
          icv: Number(icv),
          pih,
          invoice_hash,
          qr_code_payload,
          signed_xml,
          cleared_xml: null,
          status: normalized.includes("'rejected'") ? 'rejected' : (normalized.includes("'reported'") ? 'reported' : (normalized.includes("'cleared'") ? 'cleared' : 'signed')),
          supply_date,
          issue_timestamp,
          replaces_invoice_id,
          subtotal,
          tax_total,
          grand_total,
          raw_order_payload: raw_order_payload || null,
          currency: 'SAR',
          created_at: new Date(),
          updated_at: new Date()
        });
      } else if (normalized.includes("'tax_invoice'")) {
        const [
          egs_unit_id,
          order_id,
          idempotency_key,
          uuid,
          icv,
          pih,
          invoice_hash,
          qr_code_payload,
          signed_xml,
          supply_date,
          issue_timestamp,
          subtotal,
          tax_total,
          grand_total
        ] = params;
        invoices.push({
          id,
          egs_unit_id,
          order_id: String(order_id),
          idempotency_key,
          invoice_type: 'tax_invoice',
          uuid,
          icv: Number(icv),
          pih,
          invoice_hash,
          qr_code_payload,
          signed_xml,
          cleared_xml: null,
          status: normalized.includes("'rejected'") ? 'rejected' : (normalized.includes("'reported'") ? 'reported' : (normalized.includes("'cleared'") ? 'cleared' : 'signed')),
          supply_date,
          issue_timestamp,
          replaces_invoice_id: null,
          subtotal,
          tax_total,
          grand_total,
          currency: 'SAR',
          created_at: new Date(),
          updated_at: new Date()
        });
      } else if (normalized.includes("'simplified_tax_invoice'")) {
        let egs_unit_id: any;
        let order_id: any;
        let idempotency_key: any;
        let uuid: any;
        let icv: any;
        let pih: any;
        let invoice_hash: any;
        let qr_code_payload: any = 'qr_live_001';
        let signed_xml: any = '<Invoice/>';
        let supply_date: any = '2026-10-26';
        let issue_timestamp: any = '2026-10-26T12:00:00Z';
        let subtotal: any = 100.0;
        let tax_total: any = 15.0;
        let grand_total: any = 115.0;

        let replaces_invoice_id: any = null;
        let raw_order_payload: any = null;
        if (params.length === 5) {
          egs_unit_id = params[0];
          order_id = params[1];
          idempotency_key = params[2];
          uuid = randomUUID();
          icv = Number(params[3]);
          pih = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==';
          invoice_hash = params[4];
        } else if (params.length >= 16) {
          [
            egs_unit_id,
            order_id,
            idempotency_key,
            uuid,
            icv,
            pih,
            invoice_hash,
            qr_code_payload,
            signed_xml,
            supply_date,
            issue_timestamp,
            replaces_invoice_id,
            subtotal,
            tax_total,
            grand_total,
            raw_order_payload
          ] = params;
        } else if (params.length >= 15) {
          [
            egs_unit_id,
            order_id,
            idempotency_key,
            uuid,
            icv,
            pih,
            invoice_hash,
            qr_code_payload,
            signed_xml,
            supply_date,
            issue_timestamp,
            replaces_invoice_id,
            subtotal,
            tax_total,
            grand_total
          ] = params;
        } else {
          [
            egs_unit_id,
            order_id,
            idempotency_key,
            uuid,
            icv,
            pih,
            invoice_hash,
            qr_code_payload,
            signed_xml,
            supply_date,
            issue_timestamp,
            subtotal,
            tax_total,
            grand_total
          ] = params;
        }
        const icvMatch = normalized.match(/,\s*(\d+)\s*,\s*'(?:pih|hash)/i);
        const resolvedIcv = (icv !== undefined && !isNaN(Number(icv))) ? Number(icv) : (icvMatch ? Number(icvMatch[1]) : 1);
        invoices.push({
          id,
          egs_unit_id,
          order_id: String(order_id),
          idempotency_key,
          invoice_type: 'simplified_tax_invoice',
          uuid,
          icv: resolvedIcv,
          pih,
          invoice_hash,
          qr_code_payload,
          signed_xml,
          cleared_xml: null,
          status: normalized.includes("'rejected'") ? 'rejected' : (normalized.includes("'reported'") ? 'reported' : (normalized.includes("'cleared'") ? 'cleared' : 'signed')),
          supply_date,
          issue_timestamp,
          replaces_invoice_id: replaces_invoice_id || null,
          subtotal,
          tax_total,
          grand_total,
          raw_order_payload: raw_order_payload ? (typeof raw_order_payload === 'string' ? (() => { try { return JSON.parse(raw_order_payload); } catch { return raw_order_payload; } })() : raw_order_payload) : null,
          currency: 'SAR',
          created_at: new Date(),
          updated_at: new Date()
        });
      } else {
        let egs_unit_id: any;
        let order_id: any;
        let idempotency_key: any;
        let invoice_type: any;
        let uuid: any;
        let icv: any;
        let pih: any;
        let invoice_hash: any;
        let qr_code_payload: any;
        let signed_xml: any;
        let supply_date: any;
        let issue_timestamp: any;
        let replaces_invoice_id: any = null;
        let subtotal: any;
        let tax_total: any;
        let grand_total: any;

        let raw_order_payload: any = null;
        if (params.length >= 17) {
          [
            egs_unit_id,
            order_id,
            idempotency_key,
            invoice_type,
            uuid,
            icv,
            pih,
            invoice_hash,
            qr_code_payload,
            signed_xml,
            supply_date,
            issue_timestamp,
            replaces_invoice_id,
            subtotal,
            tax_total,
            grand_total,
            raw_order_payload
          ] = params;
        } else if (params.length >= 16) {
          [
            egs_unit_id,
            order_id,
            idempotency_key,
            invoice_type,
            uuid,
            icv,
            pih,
            invoice_hash,
            qr_code_payload,
            signed_xml,
            supply_date,
            issue_timestamp,
            replaces_invoice_id,
            subtotal,
            tax_total,
            grand_total
          ] = params;
        } else {
          [
            egs_unit_id,
            order_id,
            idempotency_key,
            invoice_type,
            uuid,
            icv,
            pih,
            invoice_hash,
            qr_code_payload,
            signed_xml,
            supply_date,
            issue_timestamp,
            subtotal,
            tax_total,
            grand_total
          ] = params;
        }
        invoices.push({
          id,
          egs_unit_id,
          order_id: String(order_id),
          idempotency_key,
          invoice_type,
          uuid,
          icv: Number(icv),
          pih,
          invoice_hash,
          qr_code_payload,
          signed_xml,
          cleared_xml: null,
          status: normalized.includes("'rejected'") ? 'rejected' : (normalized.includes("'reported'") ? 'reported' : (normalized.includes("'cleared'") ? 'cleared' : 'signed')),
          supply_date,
          issue_timestamp,
          replaces_invoice_id: replaces_invoice_id || null,
          subtotal,
          tax_total,
          grand_total,
          raw_order_payload: raw_order_payload ? (typeof raw_order_payload === 'string' ? (() => { try { return JSON.parse(raw_order_payload); } catch { return raw_order_payload; } })() : raw_order_payload) : null,
          currency: 'SAR',
          created_at: new Date(),
          updated_at: new Date()
        });
      }
      return { rows: [{ id }], rowCount: 1 };
    }

    if (normalized.includes('DELETE FROM invoices')) {
      throw new Error('TAMPER_EVIDENT_PROTECTION: DELETE operations are strictly forbidden on invoices');
    }

    if (normalized.includes('UPDATE invoices SET status') && normalized.includes('RETURNING status')) {
      const invId = params[0];
      const inv = invoices.find((i) => i.id === invId);
      if (inv) inv.status = 'cleared';
      return { rows: [{ status: 'cleared' }], rowCount: 1 };
    }

    if (normalized.includes('UPDATE invoices SET') && normalized.includes('grand_total')) {
      throw new Error('TAMPER_EVIDENT_PROTECTION: Core financial and cryptographic invoice fields are immutable');
    }

    if (normalized.includes('FROM invoices WHERE order_id = $1')) {
      const rows = invoices.filter((i) => String(i.order_id) === String(params[0]));
      return { rows, rowCount: rows.length };
    }

    if (
      normalized.includes('FROM invoices') &&
      (normalized.includes('WHERE id = $1') ||
        normalized.includes('WHERE i.id = $1') ||
        normalized.includes('WHERE id = $1 OR uuid = $1') ||
        normalized.includes('WHERE (id = $1 OR uuid = $1)'))
    ) {
      const inv = invoices.find((i) => i.id === params[0] || i.uuid === params[0]);
      if (!inv) {
        return { rows: [], rowCount: 0 };
      }
      const unit = egsUnits.find((u) => u.id === inv.egs_unit_id);
      return {
        rows: [
          {
            ...inv,
            merchant_id: unit?.merchant_id,
            branch_id: unit?.branch_id,
            certificate: unit?.certificate,
            csid_secret: unit?.csid_secret,
            csid_environment: unit?.csid_environment
          }
        ],
        rowCount: 1
      };
    }

    if (normalized.includes('FROM invoices WHERE egs_unit_id = $1')) {
      const filtered = invoices.filter((i) => i.egs_unit_id === params[0]);
      if (normalized.includes('COUNT(*)') && normalized.includes('SUM(')) {
        const totalNet = filtered.reduce((acc, i) => acc + (Number(i.subtotal) || 0), 0);
        const totalVat = filtered.reduce((acc, i) => acc + (Number(i.tax_total) || 0), 0);
        const pendingOrRejected = filtered.filter(i => !['cleared', 'reported', 'cleared_with_warnings', 'reported_with_warnings'].includes(i.status)).length;
        return {
          rows: [
            {
              total_invoices: filtered.length,
              total_net: totalNet,
              total_vat: totalVat,
              pending_or_rejected_count: pendingOrRejected
            }
          ],
          rowCount: 1
        };
      }
      return { rows: filtered, rowCount: filtered.length };
    }

    if (normalized.includes('SELECT * FROM invoices ORDER BY created_at ASC') || normalized.includes('SELECT * FROM invoices')) {
      return { rows: invoices, rowCount: invoices.length };
    }

    if (normalized.includes('SELECT * FROM egs_units ORDER BY created_at ASC') || normalized.includes('SELECT * FROM egs_units')) {
      return { rows: egsUnits, rowCount: egsUnits.length };
    }

    if (normalized.includes('INSERT INTO pending_b2b_orders')) {
      const [
        merchant_id,
        order_id,
        idempotency_key,
        egs_unit_id,
        buyer_vat,
        buyer_name,
        order_payload_str,
        missing_fields_str
      ] = params;
      const order_payload = typeof order_payload_str === 'string' ? JSON.parse(order_payload_str) : order_payload_str;
      const missing_fields = typeof missing_fields_str === 'string' ? JSON.parse(missing_fields_str) : missing_fields_str;

      let row = pendingB2bOrders.find((p) => p.idempotency_key === idempotency_key);
      if (row) {
        row.order_payload = order_payload;
        row.missing_fields = missing_fields;
        row.updated_at = new Date();
      } else {
        row = {
          id: randomUUID(),
          merchant_id,
          order_id: String(order_id),
          idempotency_key,
          egs_unit_id,
          buyer_vat,
          buyer_name,
          order_payload,
          missing_fields,
          status: 'pending_enrichment',
          created_at: new Date(),
          updated_at: new Date()
        };
        pendingB2bOrders.push(row);
      }
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (normalized.includes('FROM pending_b2b_orders WHERE order_id = $1')) {
      const rows = pendingB2bOrders
        .filter((p) => String(p.order_id) === String(params[0]) && p.status === 'pending_enrichment')
        .slice(-1);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes("UPDATE pending_b2b_orders SET status = 'enriched_and_signed'")) {
      const row = pendingB2bOrders.find((p) => p.id === params[0]);
      if (row) {
        row.status = 'enriched_and_signed';
        row.updated_at = new Date();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.includes('FROM pending_b2b_orders WHERE merchant_id = $1')) {
      const rows = pendingB2bOrders.filter((p) => p.merchant_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('UPDATE egs_units SET certificate = $1')) {
      const unit = egsUnits.find((u) => u.id === params[7]);
      if (unit) {
        unit.certificate = params[0];
        unit.certificate_hash = params[1];
        unit.public_key_bytes = params[2];
        unit.ca_signature_bytes = params[3];
        unit.private_key_pem = params[4];
        unit.csid_secret = params[5];
        unit.expires_at = params[6];
        unit.renewal_status = 'active';
        unit.updated_at = new Date();
      }
      return { rows: [], rowCount: unit ? 1 : 0 };
    }

    if (normalized.includes('FROM egs_units WHERE merchant_id = $1')) {
      const rows = egsUnits.filter((u) => u.merchant_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM invoices i JOIN egs_units u ON i.egs_unit_id = u.id WHERE u.merchant_id = $1') ||
        (normalized.includes('FROM invoices') && normalized.includes('merchant_id = $1'))) {
      const matchingUnits = egsUnits.filter((u) => u.merchant_id === params[0]).map((u) => u.id);
      let rows = invoices
        .filter((inv) => matchingUnits.includes(inv.egs_unit_id))
        .map((inv) => ({
          ...inv,
          merchant_id: params[0]
        }));
      if (normalized.includes('i.order_id = $2') || normalized.includes('order_id = $2')) {
        rows = rows.filter((r) => r.order_id === params[1]);
      }
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('UPDATE invoices SET status = $1, cleared_xml = $2')) {
      const inv = invoices.find((i) => i.id === params[3]);
      if (inv) {
        inv.status = params[0];
        inv.cleared_xml = params[1];
        inv.qr_code_payload = params[2];
        inv.updated_at = new Date();
      }
      return { rows: [], rowCount: inv ? 1 : 0 };
    }

    if (normalized.includes('UPDATE invoices SET') && (normalized.includes('WHERE id = $') || normalized.includes("WHERE id = '"))) {
      const invId = params && params.length > 0 ? params[params.length - 1] : null;
      const inv = invoices.find((i) => i.id === invId || (typeof normalized === 'string' && normalized.includes(i.id)));
      if (inv) {
        const literalTypeMatch = sql.match(/invoice_type\s*=\s*'([^']+)'/i);
        if (literalTypeMatch) {
          inv.invoice_type = literalTypeMatch[1];
        }
        const literalStatusMatch = sql.match(/status\s*=\s*'([^']+)'/i);
        if (literalStatusMatch) {
          inv.status = literalStatusMatch[1];
        } else if (normalized.includes('invoice_type = $1') && normalized.includes('status = $2')) {
          inv.invoice_type = params[0];
          inv.status = params[1];
        } else if (params && params.length >= 2 && normalized.includes('status = $1')) {
          inv.status = params[0];
        }
        inv.updated_at = new Date();
      }
      return { rows: [], rowCount: inv ? 1 : 0 };
    }

    if (normalized.includes('INSERT INTO zatca_dlq')) {
      const [invoice_id, merchant_id, egs_unit_id, failure_reason, http_status] = params;
      const id = randomUUID();
      const row = {
        id,
        invoice_id,
        merchant_id,
        egs_unit_id,
        failure_reason,
        http_status: http_status || null,
        attempt_count: 1,
        first_failed_at: new Date(),
        last_failed_at: new Date(),
        is_stalled: false,
        next_retry_at: null,
        resolved_at: null
      };
      zatcaDlq.push(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (normalized.includes('FROM zatca_dlq WHERE invoice_id = $1 AND resolved_at IS NULL')) {
      const rows = zatcaDlq.filter((d) => d.invoice_id === params[0] && !d.resolved_at);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM zatca_dlq WHERE merchant_id = $1')) {
      const rows = zatcaDlq.filter((d) => d.merchant_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('FROM zatca_dlq WHERE resolved_at IS NULL')) {
      const rows = zatcaDlq.filter((d) => !d.resolved_at);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('UPDATE zatca_dlq SET resolved_at = NOW()')) {
      const row = zatcaDlq.find((d) => d.id === params[0]);
      if (row) {
        row.resolved_at = new Date();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.includes('UPDATE zatca_dlq SET attempt_count =')) {
      const row = zatcaDlq.find((d) => d.id === params[params.length - 1]);
      if (row) {
        row.attempt_count += 1;
        row.last_failed_at = new Date();
        row.failure_reason = params[0];
        row.http_status = params[1];
        if (params[2] !== undefined) row.is_stalled = params[2];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (normalized.includes('INSERT INTO order_sync_records')) {
      if (normalized.includes('VALUES ($1, \'salla_demo_store\'')) {
        // Multi-row demo seed
        return { rows: [], rowCount: 5 };
      }
      let merchant_id: any;
      let order_id: any;
      let internal_order_id: any = null;
      let salla_refund_id: any = null;
      let sync_state: any;
      let source_event: any = null;
      let invoice_id: any = null;
      let invoice_uuid: any = null;
      let invoice_type: any = null;
      let correlation_id: any = null;
      let error_code: any = null;
      let error_category: any = null;
      let reason: any = null;
      let is_recoverable: any = false;
      let order_amount: any = null;
      let order_currency: any = 'SAR';
      let customer_summary: any = null;
      let eligibility_details: any = null;
      let next_action: any = null;

      if (params.length >= 19) {
        [
          merchant_id,
          order_id,
          internal_order_id,
          salla_refund_id,
          sync_state,
          source_event,
          invoice_id,
          invoice_uuid,
          invoice_type,
          correlation_id,
          error_code,
          error_category,
          reason,
          is_recoverable,
          order_amount,
          order_currency,
          customer_summary,
          eligibility_details,
          next_action
        ] = params;
      } else {
        [
          merchant_id,
          order_id,
          sync_state,
          source_event,
          invoice_id,
          invoice_uuid,
          invoice_type,
          correlation_id,
          error_code,
          error_category,
          reason,
          is_recoverable,
          order_amount,
          order_currency,
          customer_summary,
          eligibility_details,
          next_action
        ] = params;
      }
      const id = randomUUID();
      const row = {
        id,
        merchant_id,
        order_id: String(order_id),
        internal_order_id: internal_order_id || null,
        salla_refund_id: salla_refund_id || null,
        sync_state,
        source_event: source_event || null,
        invoice_id: invoice_id || null,
        invoice_uuid: invoice_uuid || null,
        invoice_type: invoice_type || null,
        attempt_count: 1,
        correlation_id: correlation_id || null,
        error_code: error_code || null,
        error_category: error_category || null,
        reason: reason || null,
        is_recoverable: Boolean(is_recoverable),
        order_amount: order_amount !== undefined ? order_amount : null,
        order_currency: order_currency || 'SAR',
        customer_summary: customer_summary ? (typeof customer_summary === 'string' ? JSON.parse(customer_summary) : customer_summary) : null,
        eligibility_details: eligibility_details ? (typeof eligibility_details === 'string' ? JSON.parse(eligibility_details) : eligibility_details) : null,
        next_action: next_action || null,
        last_event_at: new Date(),
        created_at: new Date(),
        updated_at: new Date()
      };
      orderSyncRecords.push(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (normalized.includes('UPDATE order_sync_records')) {
      const id = params[16];
      const existing = orderSyncRecords.find((r) => r.id === id);
      if (existing) {
        existing.sync_state = params[0];
        if (params[1]) existing.source_event = params[1];
        existing.invoice_id = params[2];
        existing.invoice_uuid = params[3];
        if (params[4]) existing.invoice_type = params[4];
        existing.attempt_count = params[5];
        existing.correlation_id = params[6];
        existing.error_code = params[7];
        existing.error_category = params[8];
        existing.reason = params[9];
        existing.is_recoverable = Boolean(params[10]);
        if (params[11] !== null && params[11] !== undefined) existing.order_amount = params[11];
        if (params[12]) existing.order_currency = params[12];
        if (params[13]) existing.customer_summary = typeof params[13] === 'string' ? JSON.parse(params[13]) : params[13];
        if (params[14]) existing.eligibility_details = typeof params[14] === 'string' ? JSON.parse(params[14]) : params[14];
        existing.next_action = params[15];
        if (params[17]) (existing as any).internal_order_id = params[17];
        if (params[18]) (existing as any).salla_refund_id = params[18];
        existing.last_event_at = new Date();
        existing.updated_at = new Date();
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }

    if (normalized.includes('FROM order_sync_records')) {
      if (normalized.includes('COUNT(*)')) {
        const merchantRows = orderSyncRecords.filter((r) => r.merchant_id === params[0]);
        if (normalized.includes('FILTER')) {
          return {
            rows: [
              {
                total: merchantRows.length,
                successful: merchantRows.filter((r) => ['successfully_cleared', 'successfully_reported', 'successfully_processed'].includes(r.sync_state)).length,
                review: merchantRows.filter((r) => ['requires_human_review', 'awaiting_processing'].includes(r.sync_state)).length,
                recoverable: merchantRows.filter((r) => r.is_recoverable).length,
                failed: merchantRows.filter((r) => ['temporarily_failed', 'permanently_failed'].includes(r.sync_state)).length,
                ineligible: merchantRows.filter((r) => r.sync_state === 'not_eligible').length
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [{ total: merchantRows.length }], rowCount: 1 };
      }

      if (normalized.includes('WHERE merchant_id = $1 AND order_id = $2')) {
        const rows = orderSyncRecords.filter((r) => r.merchant_id === params[0] && String(r.order_id) === String(params[1]));
        return { rows, rowCount: rows.length };
      }

      const rows = orderSyncRecords.filter((r) => r.merchant_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('INSERT INTO order_sync_transitions')) {
      if (params.length <= 2) {
        return { rows: [], rowCount: 1 };
      }
      let sync_record_id: any;
      let merchant_id: any;
      let order_id: any;
      let internal_order_id: any = null;
      let salla_refund_id: any = null;
      let from_state: any = null;
      let to_state: any;
      let source_event: any = null;
      let invoice_id: any = null;
      let invoice_uuid: any = null;
      let correlation_id: any = null;
      let attempt_number: any = 1;
      let recovery_permitted: any = false;
      let reason: any = null;
      let error_code: any = null;
      let error_category: any = null;
      let metadata: any = null;

      if (params.length >= 17) {
        [
          sync_record_id,
          merchant_id,
          order_id,
          internal_order_id,
          salla_refund_id,
          from_state,
          to_state,
          source_event,
          invoice_id,
          invoice_uuid,
          correlation_id,
          attempt_number,
          recovery_permitted,
          reason,
          error_code,
          error_category,
          metadata
        ] = params;
      } else {
        [
          sync_record_id,
          merchant_id,
          order_id,
          from_state,
          to_state,
          source_event,
          invoice_id,
          invoice_uuid,
          correlation_id,
          attempt_number,
          reason,
          error_code,
          error_category,
          metadata
        ] = params;
      }
      const row = {
        id: randomUUID(),
        sync_record_id,
        merchant_id,
        order_id: String(order_id),
        internal_order_id: internal_order_id || null,
        salla_refund_id: salla_refund_id || null,
        from_state: from_state || null,
        to_state,
        source_event: source_event || null,
        invoice_id: invoice_id || null,
        invoice_uuid: invoice_uuid || null,
        correlation_id: correlation_id || null,
        attempt_number: attempt_number || 1,
        recovery_permitted: Boolean(recovery_permitted),
        reason: reason || null,
        error_code: error_code || null,
        error_category: error_category || null,
        metadata: metadata ? (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) : null,
        created_at: new Date()
      };
      orderSyncTransitions.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (normalized.includes('FROM order_sync_transitions')) {
      const rows = orderSyncTransitions.filter((t) => t.sync_record_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('INSERT INTO salla_reconciliation_jobs')) {
      const id = randomUUID();
      const row = {
        id,
        merchant_id: params[0] || 'salla_demo_store',
        status: 'running',
        from_date: params[1] || null,
        to_date: params[2] || null,
        current_page: 1,
        total_orders_scanned: 0,
        discrepancies_found: 0,
        orders_recovered: 0,
        started_at: new Date(),
        completed_at: null,
        error_message: null
      };
      reconciliationJobs.push(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (normalized.includes('UPDATE salla_reconciliation_jobs')) {
      const id = params[params.length - 1];
      const job = reconciliationJobs.find((j) => j.id === id);
      if (job) {
        if (normalized.includes("status = 'completed'")) {
          job.status = 'completed';
          job.total_orders_scanned = params[0];
          job.discrepancies_found = params[1];
          job.completed_at = new Date();
        } else if (normalized.includes("status = 'failed'")) {
          job.status = 'failed';
          job.error_message = params[0];
          job.completed_at = new Date();
        } else {
          job.current_page = params[0];
          job.total_orders_scanned = params[1];
          job.discrepancies_found = params[2];
        }
      }
      return { rows: [], rowCount: job ? 1 : 0 };
    }

    if (normalized.includes('FROM salla_reconciliation_jobs')) {
      const rows = reconciliationJobs.filter((j) => j.merchant_id === params[0]);
      if (normalized.includes("status = 'running'")) {
        const running = rows.filter((j) => j.status === 'running');
        return { rows: running, rowCount: running.length };
      }
      return { rows: rows.slice(-1), rowCount: rows.length ? 1 : 0 };
    }

    if (normalized.includes('INSERT INTO salla_reconciliation_discrepancies')) {
      const [job_id, merchant_id, order_id, details, resolution_action] = params;
      const id = randomUUID();
      const row = {
        id,
        job_id,
        merchant_id,
        order_id: String(order_id),
        discrepancy_type: 'MISSED_INGESTION',
        details: typeof details === 'string' ? JSON.parse(details) : details,
        resolution_action,
        resolved_at: null,
        created_at: new Date()
      };
      reconciliationDiscrepancies.push(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (normalized.includes('FROM salla_reconciliation_discrepancies')) {
      const rows = reconciliationDiscrepancies.filter((d) => d.merchant_id === params[0] || d.job_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('INSERT INTO webhook_queue')) {
      const id = randomUUID();
      let merchant_id = 'salla_demo_store';
      let event_name = 'order.created';
      let idempotency_key = params[0];
      let payload = params[1];

      if (params.length === 4) {
        [merchant_id, event_name, idempotency_key, payload] = params;
      }

      const row = {
        id,
        merchant_id,
        event_name,
        idempotency_key,
        payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
        status: 'pending',
        attempts: 0,
        processed_at: null,
        error_message: null,
        created_at: new Date()
      };
      webhookQueue.push(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    if (normalized.includes('FROM webhook_queue')) {
      if (normalized.includes("WHERE status = 'pending'")) {
        const rows = webhookQueue.filter((w) => w.status === 'pending');
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('WHERE id = $1')) {
        const row = webhookQueue.find((w) => w.id === params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: webhookQueue, rowCount: webhookQueue.length };
    }

    if (normalized.includes('UPDATE webhook_queue SET')) {
      const id = params[params.length - 1];
      const row = webhookQueue.find((w) => w.id === id);
      if (row) {
        if (normalized.includes("status = 'processing'")) {
          row.status = 'processing';
          row.attempts = (row.attempts || 0) + 1;
        } else if (normalized.includes("status = 'completed'")) {
          row.status = 'completed';
          row.processed_at = new Date();
          row.error_message = null;
        } else if (params.length >= 2) {
          row.status = params[0];
          row.error_message = params[1];
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  pool.query = executeQuery;
  pool.connect = async () => ({
    query: executeQuery,
    release: () => {}
  });
  pool.end = async () => {};
}
