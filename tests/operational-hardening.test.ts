process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptVaultSecret, decryptVaultSecret } from '../src/crypto/vault.js';
import { resolveEgsUnitForOrder } from '../src/services/branch-router.js';
import { checkCsidExpirations, getMerchantCsidStatus } from '../src/services/csid-renewal-worker.js';
import { recordSubmissionFailure, checkStalledDlqInvoices, resolveDlqInvoice } from '../src/services/dlq-monitor.js';

test('Operational Hardening: AES-256-GCM Vault encrypts and decrypts secrets with tag integrity', () => {
  const privateKey = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIEXAMPLEKEY\n-----END EC PRIVATE KEY-----';
  
  const encrypted = encryptVaultSecret(privateKey);
  assert.ok(encrypted.startsWith('v1:'), 'Envelope must start with v1:');
  const segments = encrypted.split(':');
  assert.equal(segments.length, 4, 'Envelope must contain 4 segments (version, iv, tag, ciphertext)');

  const decrypted = decryptVaultSecret(encrypted);
  assert.equal(decrypted, privateKey, 'Decrypted secret must match original plaintext');

  // Verify tampering detection
  const tamperedSegments = [...segments];
  tamperedSegments[3] = 'bad' + tamperedSegments[3].slice(3); // Alter ciphertext
  const tamperedEnvelope = tamperedSegments.join(':');
  assert.throws(() => decryptVaultSecret(tamperedEnvelope), /Unsupported state or unable to authenticate data/);
});

test('Operational Hardening: Multi-Branch & POS router selects correct EGS unit by terminal and branch', async () => {
  // Mock pool client with table rows
  const mockRows = [
    {
      id: 'egs-terminal-olaya-01',
      merchant_id: 'merchant_123',
      branch_id: 'branch_olaya',
      salla_branch_id: 'salla_loc_999',
      terminal_id: 'pos_term_01',
      custom_id: 'OLAYA-TERM-01',
      model: 'AndroidPOS',
      csid_environment: 'production',
      certificate: 'cert_data',
      certificate_hash: 'hash_data',
      public_key_bytes: Buffer.from('pub'),
      ca_signature_bytes: Buffer.from('ca'),
      private_key_pem: 'priv_key',
      current_icv: '42',
      last_document_hash: 'hash_prev',
      expires_at: new Date('2028-01-01')
    },
    {
      id: 'egs-branch-olaya',
      merchant_id: 'merchant_123',
      branch_id: 'branch_olaya',
      salla_branch_id: 'salla_loc_999',
      terminal_id: null,
      custom_id: 'OLAYA-DEFAULT',
      model: 'Server',
      csid_environment: 'production',
      certificate: 'cert_data',
      certificate_hash: 'hash_data',
      public_key_bytes: Buffer.from('pub'),
      ca_signature_bytes: Buffer.from('ca'),
      private_key_pem: 'priv_key',
      current_icv: '100',
      last_document_hash: 'hash_prev',
      expires_at: new Date('2028-01-01')
    },
    {
      id: 'egs-default-online',
      merchant_id: 'merchant_123',
      branch_id: 'main_hq',
      salla_branch_id: null,
      terminal_id: null,
      custom_id: 'ONLINE-STORE',
      model: 'CloudBridge',
      csid_environment: 'production',
      certificate: 'cert_data',
      certificate_hash: 'hash_data',
      public_key_bytes: Buffer.from('pub'),
      ca_signature_bytes: Buffer.from('ca'),
      private_key_pem: 'priv_key',
      current_icv: '500',
      last_document_hash: 'hash_prev',
      expires_at: new Date('2028-01-01')
    }
  ];

  const mockClient: any = {
    query: async (sql: string, params: any[]) => {
      if (params.length === 3 && params[1] === 'salla_loc_999' && params[2] === 'pos_term_01') {
        return { rows: [mockRows[0]] };
      }
      if (params.length === 2 && params[1] === 'salla_loc_999') {
        return { rows: [mockRows[1]] };
      }
      if (params.length === 1 && params[0] === 'merchant_123') {
        return { rows: [mockRows[2]] };
      }
      return { rows: [] };
    }
  };

  // 1. Test terminal-specific routing
  const termUnit = await resolveEgsUnitForOrder(mockClient, {
    merchantId: 'merchant_123',
    sallaBranchId: 'salla_loc_999',
    terminalId: 'pos_term_01'
  });
  assert.equal(termUnit.id, 'egs-terminal-olaya-01');
  assert.equal(termUnit.terminalId, 'pos_term_01');

  // 2. Test branch fallback routing
  const branchUnit = await resolveEgsUnitForOrder(mockClient, {
    merchantId: 'merchant_123',
    sallaBranchId: 'salla_loc_999'
  });
  assert.equal(branchUnit.id, 'egs-branch-olaya');

  // 3. Test primary online store fallback
  const onlineUnit = await resolveEgsUnitForOrder(mockClient, {
    merchantId: 'merchant_123'
  });
  assert.equal(onlineUnit.id, 'egs-default-online');

  // 4. Test error when merchant not found
  await assert.rejects(
    async () => resolveEgsUnitForOrder(mockClient, { merchantId: 'unknown_merchant' }),
    /NO_ACTIVE_EGS_UNIT/
  );
});

test('Operational Hardening: CSID renewal worker detects expiring and expired certificates', async () => {
  const now = new Date();
  const expiredDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Yesterday
  const expiringSoonDate = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000); // In 4 days
  const healthyDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000); // In 6 months

  const mockRows = [
    {
      id: 'unit-expired',
      merchant_id: 'merchant_expired',
      branch_id: 'branch_1',
      custom_id: 'EXP-01',
      expires_at: expiredDate,
      renewal_status: 'active'
    },
    {
      id: 'unit-due-soon',
      merchant_id: 'merchant_due',
      branch_id: 'branch_2',
      custom_id: 'DUE-01',
      expires_at: expiringSoonDate,
      renewal_status: 'active'
    },
    {
      id: 'unit-healthy',
      merchant_id: 'merchant_ok',
      branch_id: 'branch_3',
      custom_id: 'OK-01',
      expires_at: healthyDate,
      renewal_status: 'active'
    }
  ];

  const updateCalls: any[] = [];
  const mockPool: any = {
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('SELECT')) {
          return { rows: mockRows };
        }
        if (sql.includes('UPDATE')) {
          updateCalls.push(params);
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
      release: () => {}
    }),
    query: async (_sql: string, _params?: any[]) => {
      return { rows: mockRows };
    }
  };

  const report = await checkCsidExpirations(mockPool, 7);
  assert.equal(report.totalChecked, 3);
  assert.equal(report.expiredCount, 1);
  assert.equal(report.renewalDueCount, 1);
  assert.equal(report.healthyCount, 1);
  assert.equal(report.alerts.length, 2);

  const expiredAlert = report.alerts.find(a => a.urgency === 'CRITICAL_EXPIRED');
  assert.ok(expiredAlert);
  assert.equal(expiredAlert?.daysRemaining, 0);

  const renewalAlert = report.alerts.find(a => a.urgency === 'HIGH_RENEWAL_DUE');
  assert.ok(renewalAlert);
  assert.equal(renewalAlert?.daysRemaining, 4);

  // Status query check
  const merchantStatus = await getMerchantCsidStatus(mockPool, 'merchant_due');
  assert.equal(merchantStatus.length, 3);
});

test('Operational Hardening: Dead Letter Queue (DLQ) records failures and flags 30-minute stalls', async () => {
  const dlqStore: any[] = [];

  const mockPool: any = {
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('SELECT id, first_failed_at')) {
          const item = dlqStore.find(d => d.invoice_id === params?.[0] && !d.resolved_at);
          return { rows: item ? [item] : [] };
        }
        if (sql.includes('INSERT INTO zatca_dlq')) {
          const newItem = {
            id: 'dlq-1',
            invoice_id: params?.[0],
            merchant_id: params?.[1],
            egs_unit_id: params?.[2],
            failure_reason: params?.[3],
            http_status: params?.[4],
            attempt_count: 1,
            first_failed_at: new Date(Date.now() - 35 * 60 * 1000), // Stalled 35 minutes ago
            last_failed_at: new Date(),
            is_stalled: false,
            resolved_at: null
          };
          dlqStore.push(newItem);
          return { rows: [{ id: newItem.id }] };
        }
        if (sql.includes('SELECT id, invoice_id, merchant_id')) {
          return { rows: dlqStore.filter(d => !d.resolved_at) };
        }
        if (sql.includes('UPDATE zatca_dlq SET is_stalled')) {
          return { rowCount: 1 };
        }
        if (sql.includes('resolved_at = NOW()')) {
          const item = dlqStore.find(d => d.id === params?.[0]);
          if (item) item.resolved_at = new Date();
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
      release: () => {}
    }),
    query: async (sql: string, params?: any[]) => {
      const client = await mockPool.connect();
      return client.query(sql, params);
    }
  };

  // 1. Record failure
  const dlqId = await recordSubmissionFailure(mockPool, {
    invoiceId: 'inv-failed-001',
    merchantId: 'merch-888',
    egsUnitId: 'egs-unit-999',
    failureReason: 'Cloudflare HTML 503 Gateway Timeout',
    httpStatus: 503
  });
  assert.equal(dlqId, 'dlq-1');

  // 2. Check for stalls > 30 mins
  const stallAlerts = await checkStalledDlqInvoices(mockPool, 30);
  assert.equal(stallAlerts.length, 1);
  assert.equal(stallAlerts[0].urgency, 'HIGH_STALLED_30M');
  assert.ok(stallAlerts[0].minutesStalled >= 35);
  assert.ok(stallAlerts[0].messageAr.includes('عالقة'));

  // 3. Resolve DLQ item
  const resolved = await resolveDlqInvoice(mockPool, dlqId);
  assert.equal(resolved, true);
});
