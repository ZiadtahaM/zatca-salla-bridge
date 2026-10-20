import { Pool } from 'pg';

export interface CsidExpiryAlert {
  egsUnitId: string;
  merchantId: string;
  branchId: string;
  customId: string;
  expiresAt: Date;
  daysRemaining: number;
  urgency: 'CRITICAL_EXPIRED' | 'HIGH_RENEWAL_DUE' | 'HEALTHY';
  messageEn: string;
  messageAr: string;
}

export interface ExpiryCheckResult {
  totalChecked: number;
  healthyCount: number;
  renewalDueCount: number;
  expiredCount: number;
  alerts: CsidExpiryAlert[];
}

/**
 * Checks all active EGS units across merchants for upcoming CSID certificate expirations.
 * Flags units within the 7-day statutory renewal window to prevent sudden invoicing halts.
 */
export async function checkCsidExpirations(pool: Pool, warningThresholdDays = 7): Promise<ExpiryCheckResult> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id, merchant_id, branch_id, custom_id, expires_at, renewal_status, last_renewal_alert_at
       FROM egs_units
       WHERE is_active = TRUE
       ORDER BY expires_at ASC`
    );

    const now = new Date();
    const alerts: CsidExpiryAlert[] = [];
    let healthyCount = 0;
    let renewalDueCount = 0;
    let expiredCount = 0;

    for (const row of res.rows) {
      const expiresAt = new Date(row.expires_at);
      const diffMs = expiresAt.getTime() - now.getTime();
      const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      let urgency: 'CRITICAL_EXPIRED' | 'HIGH_RENEWAL_DUE' | 'HEALTHY';
      let renewalStatus = 'active';

      if (daysRemaining <= 0) {
        urgency = 'CRITICAL_EXPIRED';
        renewalStatus = 'expired';
        expiredCount++;
      } else if (daysRemaining <= warningThresholdDays) {
        urgency = 'HIGH_RENEWAL_DUE';
        renewalStatus = 'renewal_due';
        renewalDueCount++;
      } else {
        urgency = 'HEALTHY';
        healthyCount++;
        continue;
      }

      // Update unit status in DB
      await client.query(
        `UPDATE egs_units 
         SET renewal_status = $1, last_renewal_alert_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [renewalStatus, row.id]
      );

      const alert: CsidExpiryAlert = {
        egsUnitId: row.id,
        merchantId: row.merchant_id,
        branchId: row.branch_id,
        customId: row.custom_id,
        expiresAt,
        daysRemaining: Math.max(0, daysRemaining),
        urgency,
        messageEn: urgency === 'CRITICAL_EXPIRED'
          ? `CSID certificate for merchant "${row.merchant_id}" branch "${row.branch_id}" has EXPIRED! Invoicing is blocked.`
          : `CSID certificate for merchant "${row.merchant_id}" branch "${row.branch_id}" expires in ${daysRemaining} days. Renewal required.`,
        messageAr: urgency === 'CRITICAL_EXPIRED'
          ? `شهادة الختم الرقمي CSID للمتجر "${row.merchant_id}" فرع "${row.branch_id}" انتهت صلاحيتها وتوقف إصدار الفواتير فوراً.`
          : `شهادة الختم الرقمي CSID للمتجر "${row.merchant_id}" فرع "${row.branch_id}" تنتهي خلال ${daysRemaining} أيام. يجب التجديد فوراً.`
      };

      alerts.push(alert);
    }

    return {
      totalChecked: res.rows.length,
      healthyCount,
      renewalDueCount,
      expiredCount,
      alerts
    };
  } finally {
    client.release();
  }
}

/**
 * Returns the CSID certificate status and renewal health for a specific merchant.
 */
export async function getMerchantCsidStatus(pool: Pool, merchantId: string) {
  const res = await pool.query(
    `SELECT id, branch_id, salla_branch_id, terminal_id, custom_id, csid_environment, expires_at, renewal_status, last_renewal_alert_at
     FROM egs_units
     WHERE merchant_id = $1 AND is_active = TRUE
     ORDER BY expires_at ASC`,
    [merchantId]
  );

  const now = new Date();
  return res.rows.map(row => {
    const expiresAt = new Date(row.expires_at);
    const daysRemaining = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    return {
      egsUnitId: row.id,
      branchId: row.branch_id,
      sallaBranchId: row.salla_branch_id,
      terminalId: row.terminal_id,
      customId: row.custom_id,
      environment: row.csid_environment,
      expiresAt: row.expires_at,
      daysRemaining,
      renewalStatus: row.renewal_status,
      isExpired: daysRemaining <= 0,
      isRenewalDue: daysRemaining <= 7
    };
  });
}
