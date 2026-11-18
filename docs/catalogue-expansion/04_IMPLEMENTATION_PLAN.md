# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 04: Implementation Strategy, Risk Assessment & Phased Execution Plan (Phase 0)

**Date**: November 18, 2026  
**Scope**: Phased Roadmap, Risk Management, Non-Negotiable Rules, and Verification Criteria

---

### 1. Phased Execution Roadmap

```mermaid
flowchart LR
    P0["Phase 0: Discovery & Audit"] --> P1["Phase 1: Reconciliation"]
    P1 --> P2["Phase 2: Database Extensions"]
    P2 --> P3["Phase 3: Backend Services"]
    P3 --> P4["Phase 4: Admin Enhancements"]
    P4 --> P5["Phase 5: Storefront UI"]
    P5 --> P6["Phase 6: Search & SEO"]
    P6 --> P7["Phase 7: End-to-End QA"]
    P7 --> P8["Phase 8: Staging Release"]
```

#### Detailed Phase Breakdown:
- **Phase 0 (Discovery & Audit)**: Deep-dive inspection of codebase, database, schema constraints, checkout idempotency, and design tokens. *(Completed)*
- **Phase 1 (Reconciliation & Alignment)**: Cross-reference active database records against the 10-category master taxonomy. Lock duplicate prevention rules. Store supplier rates as internal cost benchmarks.
- **Phase 2 (Database Extensions)**: Apply additive migrations (`subcategories`, `variety`, `origin`, `product_form`, `publication_status`, `suppliers`, `supplier_price_history`).
- **Phase 3 (Backend Services & Bulk Import)**: Implement idempotent catalogue loader, validation routines, supplier price privacy guards, and search synonym mappings.
- **Phase 4 (Admin Panel Enhancements)**: Enable category management, subcategory mapping, per-kg price calculator, image manager, and publication workflow (Draft → Active).
- **Phase 5 (Storefront UI & PLP/PDP)**: Update `/shop` and `/category/:slug` with category banners, subcategory tabs, pack size pickers, and responsive product cards.
- **Phase 6 (Search, Synonyms & SEO)**: Connect search input to multilingual synonyms (Alsi → Flax, Haldi → Turmeric, Lal Mirch → Red Chilli). Update dynamic sitemap and structured JSON-LD.
- **Phase 7 (Cart, Checkout & Inventory Regression)**: Execute rigorous regression tests on mixed-category carts, ₹499 shipping threshold, 5% food GST calculations, and Cashfree payments.
- **Phase 8 (Staging Verification & Release)**: Validate on `staging.thecrunchyheart.com` and prepare final production release sign-off.

---

### 2. Risk Assessment & Mitigation Matrix

| # | Identified Risk | Impact | Likelihood | Concrete Mitigation Strategy |
|---|---|---|---|---|
| **R1** | Overwriting customer retail prices with supplier procurement rates | **Critical** | Low | Hard isolation: Supplier rates are stored strictly in `cost_price` / `supplier_price_history`. Customer-facing `selling_price` is calculated from approved retail per-kg models. |
| **R2** | Duplicate product entries for existing items (e.g. Mamra Almond, Pumpkin Seeds) | **High** | Medium | Migration scripts use `ON CONFLICT (slug) DO NOTHING`. Database indexes enforce unique lowercase names per subcategory. |
| **R3** | Breaking Cashfree checkout, inventory holds, or order history | **Critical** | Low | Zero breaking changes to `orders`, `order_items`, `checkout.service.js`, or `inventory_holds`. All new variants adhere to existing UUID and integer cent/rupee pricing schemas. |
| **R4** | Accidental publication of unverified products (Snack mixes, Millets) | **Medium** | Low | Products default to `publication_status = 'draft'`. Storefront queries strictly filter `WHERE publication_status = 'active' AND is_active = true`. |
| **R5** | Performance degradation on large catalogue queries | **Medium** | Low | Subcategory and category foreign keys are indexed. Product queries utilize existing connection pooling and pagination limits. |

---

### 3. Non-Negotiable Engineering Rules

1. **No Greenfield Rebuilds**: Work exclusively within the existing Node.js + Express backend and Angular 20 storefront architecture.
2. **Preserve All Existing Records**: Never drop tables, reset database branches, or truncate order/customer tables.
3. **Additive Schema Migrations Only**: All SQL scripts must use `IF NOT EXISTS` and `ON CONFLICT DO NOTHING`.
4. **Supplier Cost Privacy**: Sourcing costs, supplier identities, and gross margin figures must never be returned across public `/api/products` or exposed in client bundles.
5. **No Client-Calculated Prices**: Authoritative order subtotals, GST, and totals are computed strictly on the backend.
6. **No Imagined Certifications**: Geographical origin claims (Mithila GI, Kashmiri) and organic claims must not be asserted without verified supplier documentation.
7. **Strict Staging Gate**: All changes must be verified and smoke-tested on Staging before any production deployment discussion.
