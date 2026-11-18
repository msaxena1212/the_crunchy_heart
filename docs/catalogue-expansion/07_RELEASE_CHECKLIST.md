# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 07: Staging Release Checklist & Production Gate (Phase 0)

**Date**: November 18, 2026  
**Scope**: Pre-Flight Gates, Staging Deployment Checklist, Verification Protocols, and Rollback Procedures

---

### 1. Pre-Deployment Engineering Gates

Before any deployment to Staging:
- [x] **Repository Discovery Complete**: Documented in `00_REPOSITORY_DISCOVERY.md`.
- [x] **Catalogue Reconciliation Locked**: Documented in `01_EXISTING_CATALOGUE_AUDIT.md`.
- [x] **Product Taxonomy Finalized**: Documented in `02_PRODUCT_TAXONOMY.md`.
- [x] **Database Schema Additive & Safe**: Documented in `03_DATABASE_DESIGN.md`.
- [x] **Implementation & Migration Plans Approved**: Documented in `04_IMPLEMENTATION_PLAN.md` and `05_DATA_MIGRATION_PLAN.md`.
- [x] **QA & Regression Suite Specified**: Documented in `06_QA_TEST_PLAN.md`.
- [x] **TypeScript Client Compilation Verified**: `npx tsc --noEmit -p tsconfig.app.json` exited with code 0 (zero errors).
- [ ] **Neon Database Backup / Checkpoint Created**: Verified on branch `staging`.

---

### 2. Staging Deployment Execution Sequence

1. **Database Migration Step**:
   - Run safe additive migration scripts on Neon Postgres staging branch (`br-icy-glade-b5g747q0`).
   - Verify zero dropped columns and zero modified production credentials.
2. **Backend API Deployment**:
   - Deploy Node.js server updates to `/var/www/the-crunchy-heart-staging/server`.
   - Restart service via PM2 / Systemd: `sudo systemctl restart crunchy-heart-staging`.
3. **Frontend Storefront Deployment**:
   - Execute production Angular build: `npm --prefix client run build`.
   - Sync compiled bundle to `/var/www/the-crunchy-heart-staging/client/dist`.
4. **Live Cache & CDN Invalidation**:
   - Reload Nginx reverse proxy: `sudo systemctl reload nginx`.

---

### 3. Post-Deployment Smoke Test Protocol

- [ ] Verify `https://staging.thecrunchyheart.com/` loads with 200 OK.
- [ ] Verify `https://staging.thecrunchyheart.com/shop` renders all 10 categories and product cards.
- [ ] Verify `https://staging.thecrunchyheart.com/category/dry-fruits` and `/category/spices` display proper banners and pack selectors.
- [ ] Verify `/product/premium-almond` displays accurate rate per kg and pack size options.
- [ ] Verify Add to Cart triggers slide-over Mini-Cart Drawer with free delivery progress calculation.
- [ ] Verify Customer Login modal operates with test OTP `111111` and loads `/account` dashboard.
- [ ] Verify Checkout processes Cashfree payment test and COD order creation without errors.
- [ ] Verify `/admin/products` displays full product catalogue with stock indicators and pricing edit controls.

---

### 4. Rollback & Contingency Plan

If critical regressions are detected on Staging:
1. Revert Nginx symlink or static files to previous release timestamp.
2. Rollback git commit via `git revert`.
3. Database changes are strictly non-breaking (additive), requiring no destructive schema rollback.
