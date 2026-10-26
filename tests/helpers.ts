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

    if (normalized.includes('INSERT INTO merchant_tokens')) {
      const [merchant_id, access_token_encrypted, refresh_token_encrypted, expires_at, token_scope, store_name, vat_number, crn, city] = params;
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
      const [
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
          seller_crn: u.crn || m?.crn || '1010010000',
          seller_vat: u.vat_number || m?.vat_number || '300075588700003',
          seller_name_arabic: u.branch_name || m?.store_name || 'شركة رواء للملابس الفاخرة'
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

    if (normalized.includes('FROM egs_units WHERE merchant_id = $1 AND is_active = TRUE')) {
      const rows = egsUnits.filter((u) => u.merchant_id === params[0] && u.is_active).slice(0, 1);
      return { rows, rowCount: rows.length };
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

    if (normalized.includes('FROM invoices WHERE idempotency_key = $1')) {
      const rows = invoices.filter((i) => i.idempotency_key === params[0]);
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
          grand_total
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
          status: 'signed',
          supply_date,
          issue_timestamp,
          replaces_invoice_id,
          subtotal,
          tax_total,
          grand_total,
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
          status: 'signed',
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
          invoice_type: 'simplified_tax_invoice',
          uuid,
          icv: Number(icv),
          pih,
          invoice_hash,
          qr_code_payload,
          signed_xml,
          cleared_xml: null,
          status: 'signed',
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
      } else {
        const [
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
          status: 'signed',
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
      }
      return { rows: [{ id }], rowCount: 1 };
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
      const rows = invoices
        .filter((inv) => matchingUnits.includes(inv.egs_unit_id))
        .map((inv) => ({
          ...inv,
          merchant_id: params[0]
        }));
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
        if (normalized.includes('invoice_type = $1') && normalized.includes('status = $2')) {
          inv.invoice_type = params[0];
          inv.status = params[1];
        } else if (normalized.includes("invoice_type = 'tax_invoice'")) {
          inv.invoice_type = 'tax_invoice';
          if (normalized.includes("status = 'signed'")) {
            inv.status = 'signed';
          }
        } else if (params && params.length >= 1) {
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

    return { rows: [], rowCount: 0 };
  };

  pool.query = executeQuery;
  pool.connect = async () => ({
    query: executeQuery,
    release: () => {}
  });
  pool.end = async () => {};
}
