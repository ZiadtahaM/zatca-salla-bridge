import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../storage/db.js';
import { onboardEgsUnit, renewProductionCsid, MockZatcaApiClient } from '../services/onboarding-service.js';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

export const OnboardRequestSchema = z.object({
  merchantId: z.string().min(1),
  branchId: z.string().min(1),
  sallaBranchId: z.string().optional(),
  terminalId: z.string().optional(),
  storeName: z.string().min(1),
  vatNumber: z.string().regex(/^3\d{13}3$/, 'Saudi VAT number must be 15 digits starting and ending with 3'),
  crn: z.string().regex(/^\d{10}$/, 'CRN must be exactly 10 digits').optional(),
  branchName: z.string().optional(),
  otp: z.string().length(6, 'Fatoora OTP must be exactly 6 digits'),
  isProduction: z.boolean().optional().default(false),
  environment: z.enum(['sandbox', 'simulation', 'production']).optional(),
  liabilityAccepted: z.boolean().optional()
});

export const RenewRequestSchema = z.object({
  otp: z.string().length(6, 'Fatoora OTP must be exactly 6 digits')
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

    if (parseResult.data.isProduction && !parseResult.data.liabilityAccepted) {
      return reply.status(400).send({
        error: 'LIABILITY_ACCEPTANCE_REQUIRED',
        message: 'You must review and accept the ZATCA Cutover Guidelines and Platform Liability Terms before enabling production invoicing.'
      });
    }

    const client = await pool.connect();
    const workDir = join(process.cwd(), '.zatca-onboard-temp', `${parseResult.data.merchantId}-${Date.now()}`);

    try {
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

  fastify.post('/api/egs/:id/renew', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parseResult = RenewRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed for CSID renewal request',
        details: parseResult.error.errors
      });
    }

    const client = await pool.connect();
    const workDir = join(process.cwd(), '.zatca-renew-temp', `${id}-${Date.now()}`);

    try {
      const egsCheck = await client.query(`SELECT id, merchant_id, certificate FROM egs_units WHERE id = $1`, [id]);
      if (egsCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'EGS_NOT_FOUND', message: `EGS unit ${id} not found` });
      }
      const egsUnitMerchant = egsCheck.rows[0].merchant_id;
      const callerMerchant = (
        (request.headers['x-merchant-id'] || '') ||
        (request.headers['x-tenant-id'] || '') ||
        ((request.body as any)?.merchantId || '')
      ).toString().trim();

      if (callerMerchant && callerMerchant !== egsUnitMerchant) {
        return reply.status(403).send({
          error: 'FORBIDDEN',
          message: 'Cross-tenant CSID renewal prohibited. You cannot renew an EGS unit belonging to another merchant.'
        });
      }

      const mockCertPem = process.env.ZATCA_SANDBOX_CERT_PEM || egsCheck.rows[0].certificate;

      const apiClient = new MockZatcaApiClient(mockCertPem || '');

      const result = await renewProductionCsid(client, id, parseResult.data.otp, workDir, apiClient);

      return reply.status(200).send({
        status: 'renewed',
        egs_unit_id: result.egsUnitId,
        certificate_hash: result.certificateHash,
        expires_at: result.expiresAt.toISOString(),
        current_icv: result.currentIcv,
        last_document_hash: result.lastDocumentHash
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: 'Failed to renew ZATCA CSID certificate',
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
