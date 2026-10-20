import { PoolClient } from 'pg';

export interface BranchRoutingInput {
  merchantId: string;
  sallaBranchId?: string;
  terminalId?: string;
}

export interface ResolvedEgsUnit {
  id: string;
  merchantId: string;
  branchId: string;
  sallaBranchId?: string;
  terminalId?: string;
  customId: string;
  model: string;
  csidEnvironment: 'compliance' | 'production';
  certificate: string;
  certificateHash: string;
  publicKeyBytes: Buffer;
  caSignatureBytes: Buffer;
  privateKeyPem: string;
  currentIcv: number;
  lastDocumentHash: string;
  expiresAt: Date;
}

/**
 * Resolves the isolated EGS stamp unit for an incoming Salla or POS order.
 * Isolates hash chains and sequence counters per physical terminal or retail branch.
 */
export async function resolveEgsUnitForOrder(
  client: PoolClient,
  input: BranchRoutingInput
): Promise<ResolvedEgsUnit> {
  const { merchantId, sallaBranchId, terminalId } = input;

  // 1. Try terminal-specific EGS unit if terminalId is provided
  if (sallaBranchId && terminalId) {
    const termRes = await client.query(
      `SELECT * FROM egs_units 
       WHERE merchant_id = $1 AND salla_branch_id = $2 AND terminal_id = $3 AND is_active = TRUE 
       LIMIT 1`,
      [merchantId, sallaBranchId, terminalId]
    );
    if (termRes.rows.length > 0) {
      return mapRowToResolvedEgsUnit(termRes.rows[0]);
    }
  }

  // 2. Try branch-specific EGS unit if sallaBranchId is provided
  if (sallaBranchId) {
    const branchRes = await client.query(
      `SELECT * FROM egs_units 
       WHERE merchant_id = $1 AND salla_branch_id = $2 AND is_active = TRUE 
       LIMIT 1`,
      [merchantId, sallaBranchId]
    );
    if (branchRes.rows.length > 0) {
      return mapRowToResolvedEgsUnit(branchRes.rows[0]);
    }
  }

  // 3. Fallback to primary/default merchant EGS unit
  const defaultRes = await client.query(
    `SELECT * FROM egs_units 
     WHERE merchant_id = $1 AND is_active = TRUE 
     ORDER BY created_at ASC 
     LIMIT 1`,
    [merchantId]
  );

  if (defaultRes.rows.length > 0) {
    return mapRowToResolvedEgsUnit(defaultRes.rows[0]);
  }

  throw new Error(`NO_ACTIVE_EGS_UNIT: No active ZATCA EGS cryptographic unit found for merchant "${merchantId}"`);
}

function mapRowToResolvedEgsUnit(row: any): ResolvedEgsUnit {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    branchId: row.branch_id,
    sallaBranchId: row.salla_branch_id || undefined,
    terminalId: row.terminal_id || undefined,
    customId: row.custom_id,
    model: row.model,
    csidEnvironment: row.csid_environment,
    certificate: row.certificate,
    certificateHash: row.certificate_hash,
    publicKeyBytes: row.public_key_bytes,
    caSignatureBytes: row.ca_signature_bytes,
    privateKeyPem: row.private_key_pem,
    currentIcv: parseInt(row.current_icv, 10),
    lastDocumentHash: row.last_document_hash,
    expiresAt: new Date(row.expires_at)
  };
}
