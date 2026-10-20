import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../storage/db.js';
import { onboardEgsUnit, MockZatcaApiClient } from '../services/onboarding-service.js';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

export const OnboardRequestSchema = z.object({
  merchantId: z.string().min(1),
  branchId: z.string().min(1),
  storeName: z.string().min(1),
  vatNumber: z.string().regex(/^3\d{13}3$/, 'Saudi VAT number must be 15 digits starting and ending with 3'),
  otp: z.string().length(6, 'Fatoora OTP must be exactly 6 digits'),
  isProduction: z.boolean().optional().default(false)
});

export async function onboardingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/egs/onboard', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = OnboardRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed for onboarding request',
        details: parseResult.error.errors
      });
    }

    const client = await pool.connect();
    const workDir = join(process.cwd(), '.zatca-onboard-temp', `${parseResult.data.merchantId}-${Date.now()}`);

    try {
      // In production, real HTTP client is injected. In sandbox/dev, mock client is used with valid cert
      const mockCertPem = process.env.ZATCA_SANDBOX_CERT_PEM || (
        await client.query(`SELECT certificate FROM egs_units WHERE is_active = TRUE LIMIT 1`)
      ).rows[0]?.certificate;

      const apiClient = new MockZatcaApiClient(mockCertPem || '');

      const result = await onboardEgsUnit(client, parseResult.data, workDir, apiClient);

      return reply.status(200).send({
        status: 'onboarded',
        egs_unit_id: result.egsUnitId,
        custom_id: result.customId,
        environment: result.environment,
        expires_at: result.expiresAt.toISOString()
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: 'Failed to complete ZATCA EGS onboarding',
        message: err.message
      });
    } finally {
      client.release();
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Ignored if already cleaned
      }
    }
  });
}
