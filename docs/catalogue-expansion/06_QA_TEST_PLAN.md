# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 06: Quality Assurance & End-to-End Test Plan (Phase 0)

**Date**: November 18, 2026  
**Scope**: Regression Testing, Commerce Workflows, Security Audits, and Concurrency Verification

---

### 1. Test Suite Architecture

```
QA Test Matrix
├── 1. Database Integrity & Constraints
├── 2. API Contract & Validation
├── 3. Storefront UI & Responsive Testing
├── 4. End-to-End Purchasing Regression
├── 5. Concurrency & Inventory Lock Tests
└── 6. Security & Data Isolation Tests
```

---

### 2. Detailed Test Cases

#### A. Database & Schema Verification
- [ ] **TC-DB-01 (SKU Uniqueness)**: Attempting to insert a duplicate SKU must fail with unique constraint violation.
- [ ] **TC-DB-02 (Price Integrity)**: Inserting `selling_price > mrp` (where `mrp > 0`) must fail with check constraint violation.
- [ ] **TC-DB-03 (Inventory Safeguard)**: Decrementing `quantity_on_hand` below `quantity_reserved` must trigger rollback.
- [ ] **TC-DB-04 (Referential Integrity)**: Deleting a category with active products must be restricted or safely handled.

#### B. API Contract & Search Verification
- [ ] **TC-API-01 (Storefront Product List)**: `GET /api/products` returns only active products with `publication_status = 'active'`.
- [ ] **TC-API-02 (Supplier Cost Isolation)**: `GET /api/products` and `GET /api/products/:slug` do **not** return `cost_price` or supplier IDs.
- [ ] **TC-API-03 (Admin Auth Guard)**: Unauthenticated requests to `/api/admin/products` return `401 Unauthorized`.
- [ ] **TC-API-04 (Search Synonym Matching)**: Searching "Alsi" returns Flax Seeds; "Haldi" returns Turmeric; "Lal Mirch" returns Red Chilli.

#### C. Storefront & Navigation Verification
- [ ] **TC-UI-01 (PLP Multi-Category Navigation)**: Visiting `/shop` shows all categories; `/category/dry-fruits` filters to dry fruits.
- [ ] **TC-UI-02 (PDP Pack Size Switching)**: Selecting 250g, 500g, or 1kg dynamically updates selling price, strike-through MRP, and per-kg calculation.
- [ ] **TC-UI-03 (Add to Cart Feedback)**: Clicking "Add to Cart" opens the slide-over mini-cart drawer with item details.
- [ ] **TC-UI-04 (Buy Now Direct Flow)**: Clicking "Buy Now" adds the variant to cart and routes directly to `/checkout`.
- [ ] **TC-UI-05 (Free Shipping Progress Bar)**: Mini-cart bar shows exact remaining amount for orders < ₹499 and shows celebration banner for >= ₹499.

#### D. Commerce & Checkout Regression
- [ ] **TC-COM-01 (Existing Makhana Checkout)**: Placing order for 100g Raw Makhana succeeds with 0% GST.
- [ ] **TC-COM-02 (New Dry Fruit Checkout)**: Placing order for 500g Mamra Almond succeeds with 5% GST and exact pro-rated price.
- [ ] **TC-COM-03 (Mixed-Category Cart)**: Cart containing Makhana + Cashews + Turmeric computes accurate itemized GST breakdown.
- [ ] **TC-COM-04 (Shipping Rules)**: Order subtotal ₹450 charges ₹149 delivery; order subtotal ₹550 charges ₹0 (Free Shipping).
- [ ] **TC-COM-05 (Cashfree Payment Initiation)**: Online payment generates Cashfree session ID without exposing client credentials.
- [ ] **TC-COM-06 (COD Checkout)**: COD order records status `confirmed`, payment status `pending`, and deducts inventory cleanly.
- [ ] **TC-COM-07 (Inventory Hold Expiry)**: Abandoned checkout releases reserved inventory hold after 15 minutes.

---

### 3. Acceptance Sign-Off Criteria

The expansion will be certified ready for staging release only when:
1. All 42 existing products and 152 SKUs remain 100% purchasable.
2. New master catalogue products have verified retail prices and active inventory.
3. No customer API exposes internal supplier costs.
4. Client production build (`npm --prefix client run build`) succeeds with zero errors.
5. All automated unit and regression tests pass with 100% success rate.
