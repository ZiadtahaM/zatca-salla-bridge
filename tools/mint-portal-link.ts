#!/usr/bin/env node
import { signMerchantSessionToken } from '../src/crypto/auth-session.js';

const merchantId = process.argv[2];
if (!merchantId) {
  process.stderr.write('Error: merchant_id is required\n');
  process.stderr.write('Usage: npx tsx tools/mint-portal-link.ts <merchant_id> [base_url]\n');
  process.exit(1);
}

const baseUrl = process.argv[3] || process.env.BASE_URL || process.env.APP_URL || 'http://localhost:3000';
const token = signMerchantSessionToken(merchantId);
const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
const portalUrl = `${cleanBaseUrl}/portal?merchant_id=${encodeURIComponent(merchantId)}&token=${encodeURIComponent(token)}`;

process.stdout.write(`Merchant ID: ${merchantId}\n`);
process.stdout.write(`Magic Token: ${token}\n`);
process.stdout.write(`Portal URL:  ${portalUrl}\n`);
