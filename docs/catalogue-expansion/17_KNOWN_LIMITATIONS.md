# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 17: Known Limitations & Technical Constraints

**Date**: November 18, 2026  
**Scope**: Operational Constraints, Pending Commercial Confirmations, and Environment Boundaries

---

### 1. Commercial & Pricing Constraints

1. **Supplier Procurement Benchmarks**:
   - The supplier prices supplied by the business (e.g. Mamra ₹1,100, Cashew ₹275, Makhana ₹320/₹360, Anjeer ₹350) are recorded as pending supplier cost records in `supplier_price_history`.
   - Their exact commercial basis (per 250g, 500g, or wholesale sack) is awaiting formal business confirmation.
   - Consequently, storefront retail selling prices (`selling_price`) are calculated from approved retail per-kg models and cannot be driven automatically from raw procurement entries.
2. **Category 08 Quarantine (Healthy Snacks & Mixes)**:
   - Trail mixes, roasted nut snacks, and energy bite concepts are preserved in the catalogue in `draft` status (`is_active = false`).
   - They will not appear in the storefront until recipe formulations, nutritional testing, FSSAI declarations, and packaging shelf-life are confirmed.

---

### 2. Environment & Network Boundaries

1. **AWS EC2 Staging Security Group**:
   - Port 22 (SSH) on `3.7.248.4` is restricted to authorized public IPs in Security Group `sg-07b96f8f20a6bc09c`.
   - Ports 80 and 443 are publicly accessible (`0.0.0.0/0`).
2. **Postgres TLS Requirement**:
   - Neon PostgreSQL requires TLS connection mode (`sslmode=require` with `{ rejectUnauthorized: false }` for pool connections).
3. **Sandbox Egress Rule**:
   - Antigravity terminal commands attempting direct external outbound network access (DNS / TLS to Neon) must run outside the sandbox (`BypassSandbox: true`) with user approval.
