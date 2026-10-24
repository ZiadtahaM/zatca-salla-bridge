import { pool, initializeDatabaseSchema } from '../../src/storage/db.js';
import { processSallaOrderIntoZatcaInvoice, processPartialCreditNote } from '../../src/services/invoice-generator.js';
import { generateValidSecp256k1TestCert } from '../../tests/helpers.js';
import { encryptVaultSecret } from '../../src/crypto/vault.js';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SallaOrderData } from '../../types/salla.js';

interface LatencyMetrics {
  p1: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  totalDurationMs: number;
  opsPerSec: number;
}

function calculatePercentiles(latencies: number[], totalDurationMs: number): LatencyMetrics {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  const p1 = sorted[Math.floor(0.01 * (n - 1))] ?? 0;
  const p50 = sorted[Math.floor(0.50 * (n - 1))] ?? 0;
  const p90 = sorted[Math.floor(0.90 * (n - 1))] ?? 0;
  const p95 = sorted[Math.floor(0.95 * (n - 1))] ?? 0;
  const p99 = sorted[Math.floor(0.99 * (n - 1))] ?? 0;
  const max = sorted[n - 1] ?? 0;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = n > 0 ? sum / n : 0;
  const opsPerSec = totalDurationMs > 0 ? (n / (totalDurationMs / 1000)) : 0;

  return { p1, p50, p90, p95, p99, max, mean, totalDurationMs, opsPerSec };
}

function createSyntheticB2cOrder(orderIndex: number): SallaOrderData {
  const now = new Date().toISOString();
  return {
    id: 100000 + orderIndex,
    reference_id: 100000 + orderIndex,
    date: { date: now, timezone: 'Asia/Riyadh' },
    status: { id: 101, name: 'completed', slug: 'completed' },
    payment_method: 'credit_card',
    currency: 'SAR',
    amounts: {
      sub_total: { amount: 150, currency: 'SAR' },
      shipping_cost: { amount: 0, currency: 'SAR' },
      tax: { amount: { amount: 22.5, currency: 'SAR' }, percent: 15 },
      total: { amount: 172.5, currency: 'SAR' }
    },
    items: [
      {
        id: 1,
        name: `منتج تجزئة B2C #${orderIndex}`,
        sku: `SKU-B2C-${orderIndex}`,
        quantity: 1,
        price: { amount: 150, currency: 'SAR' },
        total: { amount: 150, currency: 'SAR' },
        tax: { amount: { amount: 22.5, currency: 'SAR' }, percent: 15 }
      }
    ],
    customer: {
      id: 5000 + orderIndex,
      first_name: 'سعد',
      last_name: 'القحطاني',
      email: `customer${orderIndex}@example.sa`,
      mobile: '966501112233',
      tax_number: null
    },
    shipping: {
      address: {
        country: 'SA',
        city: 'الرياض',
        street: 'طريق الملك فهد'
      }
    }
  };
}

function createSyntheticB2bOrder(orderIndex: number): SallaOrderData {
  const now = new Date().toISOString();
  return {
    id: 200000 + orderIndex,
    reference_id: 200000 + orderIndex,
    date: { date: now, timezone: 'Asia/Riyadh' },
    status: { id: 101, name: 'completed', slug: 'completed' },
    payment_method: 'credit_card',
    currency: 'SAR',
    amounts: {
      sub_total: { amount: 2000, currency: 'SAR' },
      shipping_cost: { amount: 0, currency: 'SAR' },
      tax: { amount: { amount: 300, currency: 'SAR' }, percent: 15 },
      total: { amount: 2300, currency: 'SAR' }
    },
    items: [
      {
        id: 1,
        name: `توريد شركات B2B #${orderIndex}`,
        sku: `SKU-B2B-${orderIndex}`,
        quantity: 2,
        price: { amount: 1000, currency: 'SAR' },
        total: { amount: 2000, currency: 'SAR' },
        tax: { amount: { amount: 300, currency: 'SAR' }, percent: 15 }
      }
    ],
    customer: {
      id: 9000 + orderIndex,
      first_name: 'شركة',
      last_name: `الريادة للصناعات ${orderIndex}`,
      company_name: `شركة الريادة للصناعات ${orderIndex}`,
      email: `procurement${orderIndex}@alriyada.sa`,
      mobile: '966509998877',
      tax_number: '310987654300003'
    },
    shipping: {
      address: {
        country: 'SA',
        city: 'الرياض',
        district: 'العليا',
        street: 'طريق الملك فهد',
        building_number: '4321',
        postal_code: '12244'
      }
    }
  };
}

async function runBenchmarkWorkerQueue(
  egsUnitId: string,
  tasks: Array<{ type: 'b2c' | 'b2b' | 'credit'; index: number; originalInvoiceId?: string }>,
  concurrency: number,
  latenciesOut: number[],
  createdInvoicesForRefund: string[]
): Promise<void> {
  let taskIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = taskIndex++;
      if (currentIndex >= tasks.length) break;

      const item = tasks[currentIndex];
      const client = await pool.connect();
      const tStart = performance.now();

      try {
        if (item.type === 'b2c') {
          const order = createSyntheticB2cOrder(item.index);
          const res = await processSallaOrderIntoZatcaInvoice(
            client,
            egsUnitId,
            order,
            `bench_b2c_${item.index}_${Date.now()}_${Math.random()}`
          );
          createdInvoicesForRefund.push(res.invoiceId);
        } else if (item.type === 'b2b') {
          const order = createSyntheticB2bOrder(item.index);
          const res = await processSallaOrderIntoZatcaInvoice(
            client,
            egsUnitId,
            order,
            `bench_b2b_${item.index}_${Date.now()}_${Math.random()}`
          );
          createdInvoicesForRefund.push(res.invoiceId);
        } else {
          const targetInvoiceId = item.originalInvoiceId || createdInvoicesForRefund[0] || '';
          await processPartialCreditNote(client, egsUnitId, {
            originalInvoiceId: targetInvoiceId,
            refundAmount: 50.0,
            returnReason: `Benchmark Partial Return #${item.index}`
          });
        }

        // Realistic asynchronous dispatch simulation (5ms)
        await new Promise((resolve) => setTimeout(resolve, 5));
      } finally {
        const tEnd = performance.now();
        latenciesOut.push(tEnd - tStart);
        client.release();
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
}

export async function run1000InvoiceBenchmark(): Promise<LatencyMetrics> {
  console.log('--------------------------------------------------------------------------------');
  console.log('🚀 ZATCA Track 1: 1,000-Run Concurrent Invoice Benchmark & Invariant Audit');
  console.log('--------------------------------------------------------------------------------');

  await initializeDatabaseSchema();

  const runTimestamp = Date.now();
  const merchantId = `bench_merchant_${runTimestamp}`;
  const certDir = join(process.cwd(), `.zatca-bench-keys-${runTimestamp}`);
  const { privateKeyPem, certPem } = generateValidSecp256k1TestCert(certDir);

  const client = await pool.connect();
  let egsUnitId = '';
  try {
    const certHash = createHash('sha256').update(certPem).digest('base64');
    const initPih = createHash('sha256').update('pih_zero_origin').digest('base64');
    const egsUuid = randomUUID();

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, access_token_encrypted, refresh_token_encrypted, expires_at,
        token_scope, store_name, vat_number, crn, city
      ) VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', 'offline_access', $4, $5, $6, $7)`,
      [
        merchantId,
        encryptVaultSecret('bench_access_token'),
        encryptVaultSecret('bench_refresh_token'),
        'متجر الاختبار المعياري للفوترة',
        '310123456700003',
        '1010123456',
        'الرياض'
      ]
    );

    const unitRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, egs_uuid, custom_id, model,
        csid_environment, certificate, certificate_hash,
        public_key_bytes, ca_signature_bytes, private_key_pem, csid_secret,
        current_icv, last_document_hash, expires_at, is_active
      ) VALUES ($1, 'bench_main', $2, 'EGS-BENCH-01', 'Zatca-Bench-1.0',
        'simulation', $3, $4, $5, $6, $7, $8, 0, $9, NOW() + INTERVAL '365 days', TRUE)
      RETURNING id`,
      [
        merchantId,
        egsUuid,
        certPem,
        certHash,
        Buffer.from('bench_pub_key'),
        Buffer.from('bench_sig'),
        encryptVaultSecret(privateKeyPem),
        encryptVaultSecret('bench_secret'),
        initPih
      ]
    );
    egsUnitId = unitRes.rows[0].id;
  } finally {
    client.release();
    rmSync(certDir, { recursive: true, force: true });
  }

  // Pre-seed 1 invoice to allow immediate credit note references
  const seedClient = await pool.connect();
  let seedInvoiceId = '';
  try {
    const seedOrder = createSyntheticB2cOrder(0);
    const seedRes = await processSallaOrderIntoZatcaInvoice(
      seedClient,
      egsUnitId,
      seedOrder,
      `bench_seed_${runTimestamp}`
    );
    seedInvoiceId = seedRes.invoiceId;
  } finally {
    seedClient.release();
  }

  // Prepare remaining 999 tasks:
  // 699 B2C + 200 B2B + 100 Credit Notes = 999 tasks (Total with seed = 1,000 invoices)
  const taskList: Array<{ type: 'b2c' | 'b2b' | 'credit'; index: number; originalInvoiceId?: string }> = [];
  for (let i = 1; i <= 699; i++) {
    taskList.push({ type: 'b2c', index: i });
  }
  for (let i = 1; i <= 200; i++) {
    taskList.push({ type: 'b2b', index: i });
  }
  for (let i = 1; i <= 100; i++) {
    taskList.push({ type: 'credit', index: i, originalInvoiceId: seedInvoiceId });
  }

  // Concurrency stepping across 4 stages
  const stage1Tasks = taskList.slice(0, 99); // Stage 1: 99 tasks @ Concurrency 1
  const stage2Tasks = taskList.slice(99, 299); // Stage 2: 200 tasks @ Concurrency 5
  const stage3Tasks = taskList.slice(299, 599); // Stage 3: 300 tasks @ Concurrency 10
  const stage4Tasks = taskList.slice(599, 999); // Stage 4: 400 tasks @ Concurrency 20

  const latencies: number[] = [];
  const createdInvoiceIds: string[] = [seedInvoiceId];
  const benchOverallStart = performance.now();

  console.log('⚙️ Phase 1: 100 Runs @ Concurrency 1 (Baseline Sequential)');
  await runBenchmarkWorkerQueue(egsUnitId, stage1Tasks, 1, latencies, createdInvoiceIds);

  console.log('⚙️ Phase 2: 200 Runs @ Concurrency 5 (Standard Store Load)');
  await runBenchmarkWorkerQueue(egsUnitId, stage2Tasks, 5, latencies, createdInvoiceIds);

  console.log('⚙️ Phase 3: 300 Runs @ Concurrency 10 (High Promotion Load)');
  await runBenchmarkWorkerQueue(egsUnitId, stage3Tasks, 10, latencies, createdInvoiceIds);

  console.log('⚙️ Phase 4: 400 Runs @ Concurrency 20 (Flash Sale Burst Load)');
  await runBenchmarkWorkerQueue(egsUnitId, stage4Tasks, 20, latencies, createdInvoiceIds);

  const benchOverallEnd = performance.now();
  const totalDurationMs = benchOverallEnd - benchOverallStart;

  // Post-Execution Invariant Verification
  console.log('\n🔍 Verifying Database Invariants and Cryptographic Hash Chains...');
  const verifyClient = await pool.connect();
  try {
    const countRes = await verifyClient.query(
      `SELECT COUNT(*)::int AS total_count,
              COUNT(DISTINCT icv)::int AS distinct_icv,
              MIN(icv)::int AS min_icv,
              MAX(icv)::int AS max_icv
       FROM invoices
       WHERE egs_unit_id = $1`,
      [egsUnitId]
    );

    const stats = countRes.rows[0];
    if (stats.total_count !== 1000) {
      throw new Error(`INVARIANT_VIOLATION: Expected 1000 invoices, found ${stats.total_count}`);
    }
    if (stats.distinct_icv !== 1000) {
      throw new Error(`INVARIANT_VIOLATION: Duplicate ICV detected! Expected 1000 distinct ICVs, found ${stats.distinct_icv}`);
    }
    if (stats.min_icv !== 1 || stats.max_icv !== 1000) {
      throw new Error(`INVARIANT_VIOLATION: ICV range mismatch: min=${stats.min_icv}, max=${stats.max_icv}`);
    }

    const rowsRes = await verifyClient.query(
      `SELECT icv, pih, invoice_hash
       FROM invoices
       WHERE egs_unit_id = $1
       ORDER BY icv ASC`,
      [egsUnitId]
    );

    const rows = rowsRes.rows;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      if (curr.pih !== prev.invoice_hash) {
        throw new Error(
          `HASH_CHAIN_BROKEN at ICV ${curr.icv}: curr.pih (${curr.pih.slice(0, 16)}...) !== prev.invoice_hash (${prev.invoice_hash.slice(0, 16)}...)`
        );
      }
    }

    console.log('✅ Invariant 1: Total Invoices = 1,000 (Exact match)');
    console.log('✅ Invariant 2: 0 Duplicate ICVs (100% Unique monotonic sequence 1..1000)');
    console.log('✅ Invariant 3: Unbroken PIH Chaining across all 1,000 records');
  } finally {
    verifyClient.release();
  }

  const metrics = calculatePercentiles(latencies, totalDurationMs);

  console.log('\n================================================================================');
  console.log('📊 BENCHMARK LATENCY AND THROUGHPUT REPORT');
  console.log('================================================================================');
  console.log(`Total Invoices:      1,000 (700 B2C Simplified, 200 B2B Standard, 100 381 Credit Notes)`);
  console.log(`Total Duration:      ${(metrics.totalDurationMs / 1000).toFixed(2)}s`);
  console.log(`Throughput:          ${metrics.opsPerSec.toFixed(1)} ops/sec`);
  console.log(`Mean Latency:        ${metrics.mean.toFixed(2)}ms`);
  console.log(`p1 Latency:          ${metrics.p1.toFixed(2)}ms`);
  console.log(`p50 (Median):        ${metrics.p50.toFixed(2)}ms`);
  console.log(`p90 Latency:         ${metrics.p90.toFixed(2)}ms`);
  console.log(`p95 Latency:         ${metrics.p95.toFixed(2)}ms`);
  console.log(`p99 Latency:         ${metrics.p99.toFixed(2)}ms`);
  console.log(`Max Latency:         ${metrics.max.toFixed(2)}ms`);
  console.log('================================================================================\n');

  return metrics;
}

if (process.argv[1]?.includes('concurrency-1000-runner')) {
  run1000InvoiceBenchmark()
    .then(() => {
      console.log('🎉 Benchmark completed successfully with exit code 0.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Benchmark failed:', err);
      process.exit(1);
    });
}
