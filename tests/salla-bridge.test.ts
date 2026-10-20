import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { verifySallaWebhookSignature } from '../src/services/webhook-verifier.js';
import { classifyGatewayResponse } from '../src/services/outage-classifier.js';
import { SallaWebhookPayloadSchema } from '../src/types/salla.js';
import { buildCompliantUblTemplate } from './helpers.js';
import { signZatcaInvoiceExact } from '../src/crypto/zatca-signer.js';

test('verifySallaWebhookSignature correctly validates valid and tampered HMAC payloads', () => {
  const secret = 'test_secret_key_12345';
  const payload = Buffer.from(JSON.stringify({ event: 'order.created', merchant: '12345' }), 'utf8');
  const validSignature = createHmac('sha256', secret).update(payload).digest('hex');

  assert.equal(verifySallaWebhookSignature(payload, validSignature, secret), true);
  assert.equal(verifySallaWebhookSignature(payload, 'invalid_signature_hex', secret), false);
  assert.equal(verifySallaWebhookSignature(Buffer.from('tampered', 'utf8'), validSignature, secret), false);
});

test('classifyGatewayResponse correctly detects Cloudflare edge block pages and HTTP 401 revocation', () => {
  const htmlVerdict = classifyGatewayResponse({
    statusCode: 403,
    headers: { 'content-type': 'text/html', 'cf-ray': 'ray-12345' },
    rawBody: '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>'
  });

  assert.equal(htmlVerdict.kind, 'outage_retry');
  if (htmlVerdict.kind === 'outage_retry') {
    assert.equal(htmlVerdict.cloudflareRayId, 'ray-12345');
  }

  const authVerdict = classifyGatewayResponse({
    statusCode: 401,
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify({ error: 'Unauthorized' })
  });
  assert.equal(authVerdict.kind, 'auth_error_401');

  const rateLimitVerdict = classifyGatewayResponse({
    statusCode: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '45' },
    rawBody: JSON.stringify({ error: 'Too Many Requests' })
  });
  assert.equal(rateLimitVerdict.kind, 'outage_retry');
  if (rateLimitVerdict.kind === 'outage_retry') {
    assert.equal(rateLimitVerdict.retryAfterSeconds, 45);
  }

  const fallbackVerdict = classifyGatewayResponse({
    statusCode: 303,
    headers: { location: '/invoices/reporting' },
    rawBody: ''
  });
  assert.equal(fallbackVerdict.kind, 'clearance_fallback_303');
});

test('SallaWebhookPayloadSchema strictly validates incoming Salla order data', () => {
  const validSallaEvent = {
    event: 'order.created',
    merchant: 998877,
    created_at: '2026-10-19 14:30:00',
    data: {
      id: 554433,
      reference_id: 'REF-554433',
      date: {
        date: '2026-10-19 14:30:00',
        timezone: 'Asia/Riyadh'
      },
      status: {
        id: 1,
        name: 'Under Review',
        slug: 'under_review'
      },
      payment_method: 'mada',
      currency: 'SAR',
      amounts: {
        sub_total: { amount: 200, currency: 'SAR' },
        tax: {
          amount: { amount: 30, currency: 'SAR' },
          percent: 15
        },
        total: { amount: 230, currency: 'SAR' }
      },
      customer: {
        id: 1122,
        first_name: 'Ahmed',
        last_name: 'Al-Ghamdi',
        tax_number: '300075588700003'
      },
      items: [
        {
          id: 1,
          name: 'Luxury Silk Abaya',
          quantity: 1,
          price: { amount: 200, currency: 'SAR' },
          total: { amount: 200, currency: 'SAR' }
        }
      ]
    }
  };

  const parsed = SallaWebhookPayloadSchema.safeParse(validSallaEvent);
  assert.equal(parsed.success, true);
});
