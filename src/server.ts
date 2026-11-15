import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { randomUUID } from 'node:crypto';
import { sallaWebhookRoutes, drainWebhookQueue } from './routes/salla-webhook.js';
import { processPendingDlqRetries } from './services/fatoora-dispatcher.js';
import { recordSubmissionFailure } from './services/dlq-monitor.js';
import { onboardingRoutes } from './routes/onboarding-route.js';
import { validatorRoutes } from './routes/validator-route.js';
import { opsRoutes } from './routes/ops-route.js';
import { invoicePdfRoutes } from './routes/invoice-pdf-route.js';
import { vatReturnExportRoutes } from './routes/vat-return-export-route.js';
import { merchantPortalRoutes } from './routes/merchant-portal-route.js';
import { standaloneApiRoutes } from './routes/standalone-api-route.js';
import { syncControlRoutes } from './routes/sync-control-route.js';
import { pool, initializeDatabaseSchema } from './storage/db.js';
import { checkCsidExpirations } from './services/csid-renewal-worker.js';
import { checkStalledDlqInvoices } from './services/dlq-monitor.js';

export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info'
    },
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const headerVal = req.headers['x-request-id'] || req.headers['x-correlation-id'];
      if (typeof headerVal === 'string' && headerVal.length > 0) {
        return headerVal;
      }
      return `req_${Date.now()}_${randomUUID().slice(0, 8)}`;
    }
  });

  app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
    routes: ['/webhooks/salla', '/webhooks/salla/authorize']
  });

  app.get('/health', async () => {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  });

  app.get('/', async (_, reply) => {
    return reply.redirect('/portal');
  });

  app.get('/ready', async (_, reply) => {
    try {
      const client = await pool.connect();
      client.release();
      return { status: 'ready', database: 'connected' };
    } catch (err: any) {
      return reply.status(503).send({ status: 'unready', error: err.message });
    }
  });

  app.register(sallaWebhookRoutes);
  app.register(onboardingRoutes);
  app.register(validatorRoutes);
  app.register(opsRoutes);
  app.register(invoicePdfRoutes);
  app.register(vatReturnExportRoutes);
  app.register(merchantPortalRoutes);
  app.register(standaloneApiRoutes);
  app.register(syncControlRoutes);

  return app;
}

export function validateProductionEnvironment(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }
  const issues: string[] = [];
  const masterKey = process.env.ENCRYPTION_MASTER_KEY || process.env.VAULT_KEY_HEX;
  if (!masterKey || masterKey.includes('default_zatca') || masterKey.length < 32) {
    issues.push('ENCRYPTION_MASTER_KEY (or VAULT_KEY_HEX) is missing or insecure');
  }
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.includes('dev_zatca') || sessionSecret.length < 32) {
    issues.push('SESSION_SECRET is missing or insecure');
  }
  const webhookSecret = process.env.SALLA_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.includes('dev_salla') || webhookSecret.length < 16) {
    issues.push('SALLA_WEBHOOK_SECRET is missing or insecure');
  }
  if (issues.length > 0) {
    throw new Error(`PRODUCTION_STARTUP_FAILURE: Insecure environment configuration: ${issues.join(', ')}`);
  }
}

export async function recoverOrphanedInvoices(poolInstance = pool): Promise<number> {
  const client = await poolInstance.connect();
  try {
    const orphanedRes = await client.query(
      `SELECT i.id, i.egs_unit_id, e.merchant_id
       FROM invoices i
       JOIN egs_units e ON i.egs_unit_id = e.id
       WHERE i.status = 'signed'
         AND NOT EXISTS (
           SELECT 1 FROM zatca_dlq d WHERE d.invoice_id = i.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM zatca_submissions s WHERE s.invoice_id = i.id
         )
       LIMIT 100`
    );

    let recovered = 0;
    for (const row of orphanedRes.rows) {
      await recordSubmissionFailure(client, {
        invoiceId: row.id,
        merchantId: row.merchant_id,
        egsUnitId: row.egs_unit_id,
        failureReason: 'Orphaned signed invoice recovered on startup before ZATCA transmission',
        httpStatus: 503
      });
      recovered++;
    }
    return recovered;
  } finally {
    client.release();
  }
}

export async function startServer() {
  validateProductionEnvironment();
  const server = buildServer();
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await initializeDatabaseSchema();

    // Drain pending webhooks left from before reboot or container restart
    try {
      const { processed, errors } = await drainWebhookQueue();
      if (processed > 0) {
        process.stdout.write(`Drained ${processed} pending webhook(s) on startup (${errors} errors)\n`);
      }
    } catch (queueErr: any) {
      server.log.warn(`Webhook queue drain warning on startup: ${queueErr.message}`);
    }

    // Recover orphaned signed invoices that were not yet submitted or enqueued to DLQ
    try {
      const recoveredCount = await recoverOrphanedInvoices(pool);
      if (recoveredCount > 0) {
        process.stdout.write(`Recovered ${recoveredCount} orphaned signed invoice(s) on startup\n`);
      }
    } catch (orphanErr: any) {
      server.log.warn(`Orphaned invoice recovery warning on startup: ${orphanErr.message}`);
    }

    // Process pending ZATCA DLQ retries on startup
    try {
      const dlqRes = await processPendingDlqRetries(pool);
      if (dlqRes.retriedCount > 0) {
        process.stdout.write(`Processed ${dlqRes.retriedCount} pending ZATCA DLQ retry(ies) on startup (${dlqRes.failedCount} errors)\n`);
      }
    } catch (dlqErr: any) {
      server.log.warn(`ZATCA DLQ retry warning on startup: ${dlqErr.message}`);
    }

    // Check CSID certificate expirations on startup
    try {
      const csidStatus = await checkCsidExpirations(pool);
      if (csidStatus.expiredCount > 0 || csidStatus.renewalDueCount > 0) {
        process.stdout.write(`CSID check on startup: ${csidStatus.expiredCount} expired, ${csidStatus.renewalDueCount} renewal due\n`);
      }
    } catch (csidErr: any) {
      server.log.warn(`CSID expiration check warning on startup: ${csidErr.message}`);
    }

    // Check stalled DLQ invoices on startup
    try {
      const stalledAlerts = await checkStalledDlqInvoices(pool);
      if (stalledAlerts.length > 0) {
        process.stdout.write(`DLQ monitor on startup: ${stalledAlerts.length} stalled invoice(s) detected\n`);
      }
    } catch (stalledErr: any) {
      server.log.warn(`Stalled DLQ check warning on startup: ${stalledErr.message}`);
    }

    // Start background webhook queue drainer and ZATCA DLQ retry worker (runs every 5 seconds)
    let queueTimer: NodeJS.Timeout | null = null;
    let maintenanceTimer: NodeJS.Timeout | null = null;
    let isQueueWorkerBusy = false;
    if (process.env.NODE_ENV !== 'test') {
      queueTimer = setInterval(async () => {
        if (isQueueWorkerBusy) {
          return;
        }
        isQueueWorkerBusy = true;
        try {
          await drainWebhookQueue();
        } catch {
          // Quiet background polling
        }
        try {
          await processPendingDlqRetries(pool);
        } catch {
          // Quiet background DLQ retry
        } finally {
          isQueueWorkerBusy = false;
        }
      }, 5000);
      queueTimer.unref();

      maintenanceTimer = setInterval(async () => {
        try {
          await checkCsidExpirations(pool);
        } catch {
          // Quiet background maintenance
        }
        try {
          await checkStalledDlqInvoices(pool);
        } catch {
          // Quiet background DLQ monitoring
        }
      }, 15 * 60 * 1000);
      maintenanceTimer.unref();

      // Graceful drain and shutdown handler (Domain I: GRACEFUL_DRAIN_SHUTDOWN)
      const shutdown = async (signal: string) => {
        server.log.info(`Received ${signal}, initiating graceful shutdown...`);
        if (queueTimer) {
          clearInterval(queueTimer);
          queueTimer = null;
        }
        if (maintenanceTimer) {
          clearInterval(maintenanceTimer);
          maintenanceTimer = null;
        }
        try {
          await server.close();
          await pool.end();
          server.log.info('Graceful shutdown completed cleanly.');
          process.exit(0);
        } catch (err: any) {
          server.log.error(err, 'Error during graceful shutdown');
          process.exit(1);
        }
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    }

    await server.listen({ port, host });
    process.stdout.write(`ZATCA-Salla Bridge listening on ${host}:${port}\n`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('server.ts') || 
  process.argv[1].endsWith('server.js')
) && !process.argv[1].includes('test');

if (isDirectExecution && process.env.NODE_ENV !== 'test') {
  startServer();
}
