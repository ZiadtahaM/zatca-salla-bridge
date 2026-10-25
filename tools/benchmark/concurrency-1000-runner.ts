import { pool, initializeDatabaseSchema } from '../../src/storage/db.js';
import { processSallaOrderIntoZatcaInvoice, processPartialCreditNote } from '../../src/services/invoice-generator.js';
import { generateValidSecp256k1TestCert } from '../../tests/helpers.js';
import { encryptVaultSecret } from '../../src/crypto/vault.js';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SallaOrderData } from '../../types/salla.js';

export interface LatencyMetrics {
  count: number;
  errorCount: number;
  p1: number;
  p3: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  totalDurationMs: number;
  opsPerSec: number;
}

export interface BenchmarkReport {
  overall: LatencyMetrics;
  b2c: LatencyMetrics;
  b2b: LatencyMetrics;
  credit: LatencyMetrics;
  markdownTable: string;
}

export function calculatePercentiles(latencies: number[], totalDurationMs: number, errorCount = 0): LatencyMetrics {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  // Nearest-rank method: index = ceil(p * n) - 1, bounded to [0, n - 1]
  const nearestRank = (p: number) => (n > 0 ? (sorted[Math.max(0, Math.min(n - 1, Math.ceil(p * n) - 1))] ?? 0) : 0);
  const p1 = nearestRank(0.01);
  const p3 = nearestRank(0.03);
  const p50 = nearestRank(0.50);
  const p90 = nearestRank(0.90);
  const p95 = nearestRank(0.95);
  const p99 = nearestRank(0.99);
  const max = n > 0 ? (sorted[n - 1] ?? 0) : 0;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = n > 0 ? sum / n : 0;
  const opsPerSec = totalDurationMs > 0 ? (n / (totalDurationMs / 1000)) : 0;

  return { count: n, errorCount, p1, p3, p50, p90, p95, p99, max, mean, totalDurationMs, opsPerSec };
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

interface LatencyCollector {
  b2c: number[];
  b2b: number[];
  credit: number[];
  all: number[];
  errors: { b2c: number; b2b: number; credit: number };
}

async function runBenchmarkWorkerQueue(
  egsUnitId: string,
  tasks: Array<{ type: 'b2c' | 'b2b' | 'credit'; index: number; originalInvoiceId?: string }>,
  concurrency: number,
  collector: LatencyCollector,
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
          const elapsed = performance.now() - tStart;
          collector.b2c.push(elapsed);
          collector.all.push(elapsed);
        } else if (item.type === 'b2b') {
          const order = createSyntheticB2bOrder(item.index);
          const res = await processSallaOrderIntoZatcaInvoice(
            client,
            egsUnitId,
            order,
            `bench_b2b_${item.index}_${Date.now()}_${Math.random()}`
          );
          createdInvoicesForRefund.push(res.invoiceId);
          const elapsed = performance.now() - tStart;
          collector.b2b.push(elapsed);
          collector.all.push(elapsed);
        } else {
          const targetInvoiceId = item.originalInvoiceId || createdInvoicesForRefund[0] || '';
          await processPartialCreditNote(client, egsUnitId, {
            originalInvoiceId: targetInvoiceId,
            refundAmount: 50.0,
            returnReason: `Benchmark Partial Return #${item.index}`
          });
          const elapsed = performance.now() - tStart;
          collector.credit.push(elapsed);
          collector.all.push(elapsed);
        }

        // Realistic asynchronous dispatch simulation (5ms)
        await new Promise((resolve) => setTimeout(resolve, 5));
      } catch (err) {
        if (item.type === 'b2c') collector.errors.b2c++;
        else if (item.type === 'b2b') collector.errors.b2b++;
        else collector.errors.credit++;
        throw err;
      } finally {
        client.release();
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
}

export async function run1000InvoiceBenchmark(): Promise<BenchmarkReport> {
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

  const collector: LatencyCollector = {
    b2c: [],
    b2b: [],
    credit: [],
    all: [],
    errors: { b2c: 0, b2b: 0, credit: 0 }
  };

  // Pre-seed 1 invoice to allow immediate credit note references
  const seedClient = await pool.connect();
  let seedInvoiceId = '';
  const benchOverallStart = performance.now();
  try {
    const seedStart = performance.now();
    const seedOrder = createSyntheticB2cOrder(0);
    const seedRes = await processSallaOrderIntoZatcaInvoice(
      seedClient,
      egsUnitId,
      seedOrder,
      `bench_seed_${runTimestamp}`
    );
    seedInvoiceId = seedRes.invoiceId;
    const seedElapsed = performance.now() - seedStart;
    collector.b2c.push(seedElapsed);
    collector.all.push(seedElapsed);
  } finally {
    seedClient.release();
  }

  // Prepare remaining 999 tasks:
  // 699 B2C + 200 B2B + 100 Credit Notes = 999 tasks (Total with seed = 1,000 invoices: 700 B2C, 200 B2B, 100 Credit)
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

  const createdInvoiceIds: string[] = [seedInvoiceId];

  console.log('⚙️ Phase 1: 100 Runs @ Concurrency 1 (Baseline Sequential)');
  await runBenchmarkWorkerQueue(egsUnitId, stage1Tasks, 1, collector, createdInvoiceIds);

  console.log('⚙️ Phase 2: 200 Runs @ Concurrency 5 (Standard Store Load)');
  await runBenchmarkWorkerQueue(egsUnitId, stage2Tasks, 5, collector, createdInvoiceIds);

  console.log('⚙️ Phase 3: 300 Runs @ Concurrency 10 (High Promotion Load)');
  await runBenchmarkWorkerQueue(egsUnitId, stage3Tasks, 10, collector, createdInvoiceIds);

  console.log('⚙️ Phase 4: 400 Runs @ Concurrency 20 (Flash Sale Burst Load)');
  await runBenchmarkWorkerQueue(egsUnitId, stage4Tasks, 20, collector, createdInvoiceIds);

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

  const overall = calculatePercentiles(collector.all, totalDurationMs, collector.errors.b2c + collector.errors.b2b + collector.errors.credit);
  const b2c = calculatePercentiles(collector.b2c, totalDurationMs, collector.errors.b2c);
  const b2b = calculatePercentiles(collector.b2b, totalDurationMs, collector.errors.b2b);
  const credit = calculatePercentiles(collector.credit, totalDurationMs, collector.errors.credit);

  const markdownTable = [
    '| Transaction Class | Count | Error Count | p1 (ms) | p3 (ms) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | max (ms) | Throughput (ops/s) |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    `| Simplified Tax Invoice (B2C) | ${b2c.count} | ${b2c.errorCount} | ${b2c.p1.toFixed(2)} | ${b2c.p3.toFixed(2)} | ${b2c.p50.toFixed(2)} | ${b2c.p90.toFixed(2)} | ${b2c.p95.toFixed(2)} | ${b2c.p99.toFixed(2)} | ${b2c.max.toFixed(2)} | ${b2c.opsPerSec.toFixed(1)} |`,
    `| Standard Tax Invoice (B2B) | ${b2b.count} | ${b2b.errorCount} | ${b2b.p1.toFixed(2)} | ${b2b.p3.toFixed(2)} | ${b2b.p50.toFixed(2)} | ${b2b.p90.toFixed(2)} | ${b2b.p95.toFixed(2)} | ${b2b.p99.toFixed(2)} | ${b2b.max.toFixed(2)} | ${b2b.opsPerSec.toFixed(1)} |`,
    `| Partial Credit Note (381) | ${credit.count} | ${credit.errorCount} | ${credit.p1.toFixed(2)} | ${credit.p3.toFixed(2)} | ${credit.p50.toFixed(2)} | ${credit.p90.toFixed(2)} | ${credit.p95.toFixed(2)} | ${credit.p99.toFixed(2)} | ${credit.max.toFixed(2)} | ${credit.opsPerSec.toFixed(1)} |`,
    `| **Combined Overall Benchmark** | **${overall.count}** | **${overall.errorCount}** | **${overall.p1.toFixed(2)}** | **${overall.p3.toFixed(2)}** | **${overall.p50.toFixed(2)}** | **${overall.p90.toFixed(2)}** | **${overall.p95.toFixed(2)}** | **${overall.p99.toFixed(2)}** | **${overall.max.toFixed(2)}** | **${overall.opsPerSec.toFixed(1)}** |`
  ].join('\n');

  console.log('\n================================================================================');
  console.log('📊 BENCHMARK LATENCY AND THROUGHPUT REPORT (NEAREST-RANK METHOD)');
  console.log('================================================================================');
  console.log(markdownTable);
  console.log('================================================================================\n');

  return { overall, b2c, b2b, credit, markdownTable };
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
