import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { sallaWebhookRoutes, drainWebhookQueue } from './routes/salla-webhook.js';
import { processPendingDlqRetries } from './services/fatoora-dispatcher.js';
import { onboardingRoutes } from './routes/onboarding-route.js';
import { validatorRoutes } from './routes/validator-route.js';
import { opsRoutes } from './routes/ops-route.js';
import { invoicePdfRoutes } from './routes/invoice-pdf-route.js';
import { vatReturnExportRoutes } from './routes/vat-return-export-route.js';
import { merchantPortalRoutes } from './routes/merchant-portal-route.js';
import { standaloneApiRoutes } from './routes/standalone-api-route.js';
import { syncControlRoutes } from './routes/sync-control-route.js';
import { pool, initializeDatabaseSchema } from './storage/db.js';

export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info'
    }
  });

  app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
    routes: ['/webhooks/salla']
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
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey || masterKey.includes('default_zatca') || masterKey.length < 32) {
    issues.push('ENCRYPTION_MASTER_KEY is missing or insecure');
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

    // Process pending ZATCA DLQ retries on startup
    try {
      const dlqRes = await processPendingDlqRetries(pool);
      if (dlqRes.retriedCount > 0) {
        process.stdout.write(`Processed ${dlqRes.retriedCount} pending ZATCA DLQ retry(ies) on startup (${dlqRes.failedCount} errors)\n`);
      }
    } catch (dlqErr: any) {
      server.log.warn(`ZATCA DLQ retry warning on startup: ${dlqErr.message}`);
    }

    // Start background webhook queue drainer and ZATCA DLQ retry worker (runs every 5 seconds)
    if (process.env.NODE_ENV !== 'test') {
      const queueTimer = setInterval(async () => {
        try {
          await drainWebhookQueue();
        } catch {
          // Quiet background polling
        }
        try {
          await processPendingDlqRetries(pool);
        } catch {
          // Quiet background DLQ retry
        }
      }, 5000);
      queueTimer.unref();
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
