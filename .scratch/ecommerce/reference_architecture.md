# E-Commerce COD Fraud & Delivery Reliability Reference Architecture
Generated: 2026-10-21T22:27:40.205965
Scope: Canonical Production Benchmark Pattern

## 1. Production Reference Benchmarks
- MedusaJS
- Saleor
- Shopify Plus
- Geenora

## 2. Core Relational Schema Entities
- Order (id, store_id, customer_phone_hash, total_amount, payment_mode, status)
- NDRAttempt (id, order_id, carrier_code, rejection_reason, customer_statement, verdict)
- BlacklistProfile (id, phone_hash, address_hash, previous_rejections_count, risk_level)
- CourierSLA (id, carrier_code, promised_delivery_days, actual_delivery_days, delivery_success_rate)

## 3. Non-Negotiable Operational Invariants
- Cash-on-delivery fake order heuristic evaluation before courier dispatch
- Carrier SLA monitoring against local delivery partners (Bosta, Mylerz, Aramex)
- Automated WhatsApp address verification deep link before packaging

## 4. Verification and Hardening Plan
- [ ] Schema and Type Boundary: Strict TypeScript and Zod `.strict()`
- [ ] Persistence Isolation: Live PostgreSQL or Testcontainers with migrations
- [ ] Mutation Testing: Stryker test assertion verification
- [ ] End-to-End Invariants: Playwright journey assertions
- [ ] Dead-Code Cleanliness: Knip unused dependency check
- [ ] Physical Exit Gate: All verification checks return exit code 0
