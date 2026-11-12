process.env.NODE_ENV = 'test';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { initializeDatabaseSchema, pool } from '../src/storage/db.js';
import {
  processSallaOrderIntoZatcaInvoice,
  remedyRejectedSimplifiedInvoice
} from '../src/services/invoice-generator.js';
import { generateValidSecp256k1TestCert } from './helpers.js';
import { encryptVaultSecret } from '../src/crypto/vault.js';
import { SallaOrderData } from '../src/types/salla.js';

const realPgPool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://zatca_admin:secret_zatca_password@127.0.0.1:5432/zatca_ledger',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

let isDbReachable = false;
let testMerchantId = '';
let certCleanDir = '';
let encKey = '';
let certPem = '';
let encSec = '';

async function createIsolatedEgsUnit(client: any, tag: string): Promise<string> {
  const egsUuid = randomUUID();
  const res = await client.query(
    `INSERT INTO egs_units (
      merchant_id, branch_id, custom_id, private_key_pem, certificate,
      csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
      public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
    ) VALUES (
      $1, 'branch_pg_01', $2, $3, $4,
      $5, 'simulation', NOW() + INTERVAL '365 days', TRUE, 0, 'INITIAL_HASH_REAL_PG',
      'pub_bytes', 'sig_bytes', 'cert_hash', $6, 'POS-PG'
    ) RETURNING id`,
    [testMerchantId, `EGS-REAL-PG-${tag}-${Date.now()}`, encKey, certPem, encSec, egsUuid]
  );
  return res.rows[0].id;
}

function createSyntheticTestOrder(orderId: number, amount: number = 100): SallaOrderData {
  const taxAmount = Number((amount * 0.15).toFixed(2));
  const grandTotal = Number((amount + taxAmount).toFixed(2));
  return {
    id: orderId,
    reference_id: `REF-PG-${orderId}`,
    date: {
      date: new Date().toISOString().replace('T', ' ').substring(0, 19),
      timezone: 'Asia/Riyadh'
    },
    status: {
      id: 1,
      name: 'مكتمل',
      slug: 'completed'
    },
    payment_method: 'credit_card',
    currency: 'SAR',
    customer: {
      id: 99000 + orderId,
      first_name: 'عبدالله',
      last_name: 'الغامدي',
      mobile: '+966500000001',
      email: `customer_${orderId}@example.sa`
    },
    items: [
      {
        id: 1,
        name: `منتج اختباري #${orderId}`,
        sku: `SKU-PG-${orderId}`,
        quantity: 1,
        price: { amount, currency: 'SAR' },
        total: { amount, currency: 'SAR' },
        tax: { amount: { amount: taxAmount, currency: 'SAR' }, percent: 15 }
      }
    ],
    amounts: {
      sub_total: { amount, currency: 'SAR' },
      shipping_cost: { amount: 0, currency: 'SAR' },
      tax: { amount: { amount: taxAmount, currency: 'SAR' }, percent: 15 },
      total: { amount: grandTotal, currency: 'SAR' }
    }
  };
}

before(async () => {
  try {
    const probe = await realPgPool.connect();
    probe.release();
    isDbReachable = true;
  } catch (err: any) {
    process.stdout.write(`PostgreSQL not reachable at ${realPgPool.options.connectionString}: ${err.message}. Skipping live DB suite.\n`);
    return;
  }

  await initializeDatabaseSchema();

  const timestamp = Date.now();
  testMerchantId = `pg_merch_${timestamp}`;
  certCleanDir = join(process.cwd(), `.zatca-real-pg-keys-${timestamp}`);
  const generated = generateValidSecp256k1TestCert(certCleanDir);
  certPem = generated.certPem;
  encKey = encryptVaultSecret(generated.privateKeyPem);
  encSec = encryptVaultSecret(`sec_pg_${timestamp}`);

  const client = await realPgPool.connect();
  try {
    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        $1, 'متجر نجد لاختبارات قاعدة البيانات الحية', '310123456700003', '1010123456', $2, $3, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO NOTHING`,
      [testMerchantId, encryptVaultSecret('access_token_pg'), encryptVaultSecret('refresh_token_pg')]
    );
  } finally {
    client.release();
  }
});

after(async () => {
  if (certCleanDir) {
    try {
      rmSync(certCleanDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
  if (isDbReachable) {
    await realPgPool.end();
  }
  try {
    await pool.end();
  } catch {
    // Ignore pool teardown error
  }
});

test('Real PostgreSQL Gate 1: Partial unique index uq_invoices_order_original blocks duplicate original invoices', async () => {
  if (!isDbReachable) return;

  const client = await realPgPool.connect();
  try {
    const egsId = await createIsolatedEgsUnit(client, 'gate1');
    const runTimestamp = Date.now();
    const orderId = 610000 + (runTimestamp % 10000);
    const order = createSyntheticTestOrder(orderId, 150);
    const inv1 = await processSallaOrderIntoZatcaInvoice(
      client,
      egsId,
      order,
      `pg_uniq_idemp_${runTimestamp}_01`
    );
    assert.ok(inv1.invoiceId, 'Original invoice inserted successfully');

    let duplicateRejected = false;
    let errorCode = '';

    await client.query('BEGIN');
    try {
      // Directly attempt inserting a duplicate original invoice for the same order and EGS unit with replaces_invoice_id IS NULL
      await client.query(
        `INSERT INTO invoices (
          egs_unit_id, order_id, idempotency_key, invoice_type, uuid,
          icv, pih, invoice_hash, qr_code_payload, signed_xml,
          status, supply_date, issue_timestamp, replaces_invoice_id, subtotal, tax_total, grand_total
        ) VALUES (
          $1, $2, $3, 'simplified_tax_invoice', gen_random_uuid(),
          999, 'pih_dummy', 'hash_dummy_01', 'qr_dummy', '<xml/>',
          'signed', CURRENT_DATE, NOW(), NULL, 150.00, 22.50, 172.50
        )`,
        [egsId, String(order.id), `raw_dup_${runTimestamp}`]
      );
      await client.query('COMMIT');
    } catch (dbErr: any) {
      await client.query('ROLLBACK');
      duplicateRejected = true;
      errorCode = dbErr.code;
    }

    assert.equal(duplicateRejected, true, 'Real PostgreSQL engine must reject duplicate original invoice');
    assert.equal(errorCode, '23505', 'PostgreSQL error code must be 23505 (unique_violation)');
  } finally {
    client.release();
  }
});

test('Real PostgreSQL Gate 2: Scoped replacement insertion succeeds for the same (egs_unit_id, order_id) when replaces_invoice_id is set', async () => {
  if (!isDbReachable) return;

  const client = await realPgPool.connect();
  try {
    const egsId = await createIsolatedEgsUnit(client, 'gate2');
    const runTimestamp = Date.now();
    const orderId = 620000 + (runTimestamp % 10000);
    const order = createSyntheticTestOrder(orderId, 200);
    const original = await processSallaOrderIntoZatcaInvoice(
      client,
      egsId,
      order,
      `pg_replacement_idemp_${runTimestamp}_orig`
    );

    // Mark original as rejected
    await client.query(`UPDATE invoices SET status = 'rejected' WHERE id = $1`, [original.invoiceId]);

    // Insert replacement referencing the original
    const replacement = await processSallaOrderIntoZatcaInvoice(
      client,
      egsId,
      order,
      `pg_replacement_idemp_${runTimestamp}_orig:replacement`,
      { replacesInvoiceId: original.invoiceId }
    );

    assert.ok(replacement.invoiceId, 'Replacement invoice created successfully');
    assert.notEqual(replacement.invoiceId, original.invoiceId, 'Replacement has distinct invoice ID');
    assert.ok(replacement.icv > original.icv, 'Replacement advances monotonic ICV');

    // Confirm both records exist in PostgreSQL
    const checkRes = await client.query(
      `SELECT id, status, replaces_invoice_id FROM invoices WHERE order_id = $1 ORDER BY icv ASC`,
      [String(order.id)]
    );
    assert.equal(checkRes.rows.length, 2, 'Exactly 2 records exist: original rejected + scoped replacement');
    assert.equal(checkRes.rows[0].id, original.invoiceId);
    assert.equal(checkRes.rows[1].replaces_invoice_id, original.invoiceId);
  } finally {
    client.release();
  }
});

test('Real PostgreSQL Gate 3: Remedy retry idempotency returns identical IDs and creates exactly 1 Credit Note and 1 Replacement Invoice', async () => {
  if (!isDbReachable) return;

  const client = await realPgPool.connect();
  try {
    const egsId = await createIsolatedEgsUnit(client, 'gate3');
    const runTimestamp = Date.now();
    const orderId = 630000 + (runTimestamp % 10000);
    const order = createSyntheticTestOrder(orderId, 300);
    const rejectedIdemp = `pg_remedy_idemp_${runTimestamp}_orig`;
    const rejected = await processSallaOrderIntoZatcaInvoice(
      client,
      egsId,
      order,
      rejectedIdemp
    );

    await client.query(`UPDATE invoices SET status = 'rejected_reporting' WHERE id = $1`, [rejected.invoiceId]);

    // First remedy execution
    const remedy1 = await remedyRejectedSimplifiedInvoice(client, rejected.invoiceId);
    assert.ok(remedy1.creditNote.invoiceId, 'Remedy 1 must produce credit note');
    assert.ok(remedy1.replacementInvoice.invoiceId, 'Remedy 1 must produce replacement invoice');

    // Second remedy execution (retry replay)
    const remedy2 = await remedyRejectedSimplifiedInvoice(client, rejected.invoiceId);
    assert.equal(remedy2.creditNote.invoiceId, remedy1.creditNote.invoiceId, 'Must return identical credit note ID on retry');
    assert.equal(remedy2.creditNote.icv, remedy1.creditNote.icv, 'Credit note ICV must not burn on retry');
    assert.equal(remedy2.replacementInvoice.invoiceId, remedy1.replacementInvoice.invoiceId, 'Must return identical replacement invoice ID on retry');
    assert.equal(remedy2.replacementInvoice.icv, remedy1.replacementInvoice.icv, 'Replacement invoice ICV must not burn on retry');

    // Query live PostgreSQL table to assert exact count of rows
    const repCountRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM invoices WHERE replaces_invoice_id = $1`,
      [rejected.invoiceId]
    );
    assert.equal(repCountRes.rows[0].count, 1, 'PostgreSQL must contain exactly 1 replacement invoice');

    const cnCountRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM invoices WHERE invoice_type = 'credit_note' AND idempotency_key = $1`,
      [`${rejectedIdemp}:cancel_remedy`]
    );
    assert.equal(cnCountRes.rows[0].count, 1, 'PostgreSQL must contain exactly 1 remedy credit note');
  } finally {
    client.release();
  }
});

test('Real PostgreSQL Gate 4: 10 concurrent database connections with pg_advisory_xact_lock produce monotonic ICVs and unbroken hash chain', async () => {
  if (!isDbReachable) return;

  const concurrency = 10;
  const runTimestamp = Date.now();
  const startOrderIndex = 700000 + (runTimestamp % 100000);

  const setupClient = await realPgPool.connect();
  let egsId: string;
  try {
    egsId = await createIsolatedEgsUnit(setupClient, 'gate4');
  } finally {
    setupClient.release();
  }

  // Run 10 parallel tasks on separate pool connections
  const tasks = Array.from({ length: concurrency }, async (_, idx) => {
    const orderId = startOrderIndex + idx;
    const order = createSyntheticTestOrder(orderId, 50 + idx * 10);
    const client = await realPgPool.connect();
    try {
      return await processSallaOrderIntoZatcaInvoice(
        client,
        egsId,
        order,
        `pg_concurrent_${runTimestamp}_${idx}`
      );
    } finally {
      client.release();
    }
  });

  const results = await Promise.all(tasks);
  assert.equal(results.length, concurrency, 'All 10 concurrent invoice operations must resolve');

  // Query PostgreSQL for all invoices belonging to this EGS unit
  const verifyClient = await realPgPool.connect();
  try {
    const rowsRes = await verifyClient.query(
      `SELECT id, icv, pih, invoice_hash
       FROM invoices
       WHERE egs_unit_id = $1
       ORDER BY icv ASC`,
      [egsId]
    );

    const rows = rowsRes.rows;
    assert.equal(rows.length, concurrency, `Must find exactly ${concurrency} invoices for isolated EGS unit`);

    // Verify monotonic ICVs starting at 1 with 0 gaps or duplicates
    for (let i = 0; i < rows.length; i++) {
      assert.equal(Number(rows[i].icv), i + 1, `ICV at position ${i} must equal ${i + 1}`);
    }

    // Verify unbroken cryptographic PIH chaining across all records
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      assert.equal(
        curr.pih,
        prev.invoice_hash,
        `Hash chain broken at ICV ${curr.icv}: curr.pih must match prev.invoice_hash`
      );
    }
  } finally {
    verifyClient.release();
  }
});
