# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 00: Repository and Application Discovery Report (Phase 0)

**Date**: November 18, 2026  
**Auditor**: Antigravity Principal E-commerce Architect & Swarm Intelligence  
**Scope**: End-to-end audit of existing repository architecture, database, domain models, pricing, inventory holds, storefront, checkout, and admin consoles.

---

### 1. Executive Summary & Technology Stack

THE CRUNCHY HEART is a production-oriented e-commerce application serving a curated pantry marketplace (Premium Makhana, Dry Fruits, Nuts, Seeds, and Spices) under the brand ethos *"A little crunch. A lot of heart."*

| Layer | Technology | Details |
|---|---|---|
| **Frontend Framework** | Angular 20.3.0 | Standalone component architecture with lazy-loaded route components |
| **Rendering & Hydration** | Angular SSR + Client Hydration | `provideClientHydration(withEventReplay())` in `main.ts` |
| **Backend Framework** | Node.js ESM + Express 4.x | Clean modular service-controller-route pattern |
| **Database Engine** | PostgreSQL 16+ | Managed Serverless Neon Postgres with branch isolation (`staging`, `production`) |
| **Database Driver** | `pg` Pool (v8.x) | Direct transactional connection pool with savepoint/deadlock recovery in `db/pool.js` |
| **Authentication** | Dual Model | Admin: HMAC SHA-256 session token; Customer: Mobile OTP auth (`/api/auth/customer/*`) |
| **Payment Gateway** | Cashfree PG Web SDK v3 + COD | Hosted session drop-in checkout (`cashfree.service.js`) with idempotency keys |
| **Deployment** | AWS EC2 (Ubuntu 24.04) | Nginx reverse proxy + Node systemd/pm2 (`/var/www/the-crunchy-heart-staging`) |

---

### 2. Database Schema & Data Models

The database strictly separates product families, sellable variants, inventory ledgers, and transactions.

#### A. Master Catalogue Tables
- `categories`: `id (UUID PK)`, `name`, `slug (UNIQUE)`, `description`, `image_url`, `is_active`, `sort_order`.
- `subcategories`: `id (UUID PK)`, `category_id (FK)`, `name`, `slug (UNIQUE)`, `description`, `is_active`, `sort_order`.
- `products`: `id (UUID PK)`, `category_id (FK)`, `subcategory_id (FK)`, `name`, `slug (UNIQUE)`, `description`, `short_description`, `product_type`, `brand`, `is_active`, `is_featured`, `sort_order`.
- `product_variants`: `id (UUID PK)`, `product_id (FK)`, `sku (UNIQUE)`, `variant_name`, `weight_grams`, `flavor`, `mrp`, `selling_price`, `cost_price`, `tax_rate`, `badge`, `tone`, `is_active`, `sort_order`.
  - Constraint `chk_variant_price`: `selling_price <= mrp OR mrp = 0`.
- `product_images`: `id (UUID PK)`, `product_id (FK)`, `image_url`, `alt_text`, `is_primary`, `sort_order`.

#### B. Inventory & Checkout Hold Models
- `inventory`: `variant_id (UNIQUE FK)`, `quantity_on_hand >= 0`, `quantity_reserved >= 0`. Constraint `chk_reserved_le_on_hand`: `quantity_reserved <= quantity_on_hand`. Available stock formula: `quantity_on_hand - quantity_reserved`.
- `inventory_transactions`: Immutable audit log recording transaction type (`RESERVATION`, `RESERVATION_RELEASE`, `SALE_DEDUCTION`, `RESTOCK`, `ADJUSTMENT`), quantities, order number, reference, and timestamps.
- `inventory_holds`: 15-minute temporary holds placed during checkout initiation, with automated background cleanup sweep via `inventory-hold.service.js`.

---

### 3. Pricing, GST & Commercial Cost Isolation

- **Customer-Facing Retail Prices**: Inclusive of GST. Displayed per pack size with automatic per-kg rates (`(sellingPrice * 1000) / weightGrams`).
- **GST Rate Logic (`server/src/utils/gst.js`)**:
  - HSN `19041090`: 5% GST for roasted/flavoured/processed items.
  - Raw unbranded food items: 0% GST.
  - Intra-State Supply (Origin: Bihar): 2.5% CGST + 2.5% SGST.
  - Inter-State Supply: 5.0% IGST.
- **Supplier Procurement Rates (Cost Price)**:
  - Stored in `product_variants.cost_price`.
  - **Strict Security Rule**: `cost_price` is restricted to authenticated Admin API (`/api/admin/products`). Customer APIs (`/api/products`, `/api/categories`, `/api/checkout`) never expose procurement rates.
  - Rates provided in the prompt (e.g. Almond Mamra ₹1,100, Cashew ₹275, Kishmish ₹175) are stored as pending supplier cost records; they must never overwrite public retail prices.

---

### 4. Frontend & Storefront Architecture

- **Customer Experience & Design System**:
  - Color Palette: Heritage Forest Green (`#1e392a`, `#14563c`), Warm Ivory Surface (`#fffdf8`), Parchment Canvas (`#fbf7ef`), Deep Earth & Warm Terracotta (`#9a6039`), Gold Accents (`#a17c35`).
  - Typography: Clean `DM Sans` with serif editorial headers (Cormorant Garamond / Playfair Display).
  - Routes:
    - `/`: Homepage with hero, brand story, quality guarantees, and FAQs.
    - `/shop`: All-pantry listing with multi-category tabs, search, and sorting.
    - `/category/:slug`: Dedicated category landing pages (`raw-makhana`, `flavoured-makhana`, `dry-fruits`, `spices`, `festive-gifting`).
    - `/product/:slug`: PDP with dynamic pack size selectors, rate per kg, instant Add to Cart and Buy Now.
    - `/cart`: Full cart with quantity steppers and cart snapshot recovery.
    - Slide-over Mini-Cart Drawer: Accessible from any page, includes ₹499 free delivery threshold progress tracker.
    - `/checkout`: Single-page checkout with Cashfree PG integration, COD toggle, and delivery form.
    - `/account`: Customer portal with mobile OTP login, order history, tracking links, and profile settings.
    - `/bulk`: Dedicated B2B & wholesale enquiry form with Suta grade specifications.
  - Admin Console:
    - `/admin/products`: Product and variant editor with built-in per-kg pricing calculator.
    - `/admin/inventory`: Live stock-on-hand, reservations, and low-stock indicators.
    - `/admin/orders`: Order lifecycle management, tracking numbers, and manual dispatch workflows.

---

### 5. Architectural Compatibility & Guarantees

1. **One Central Catalogue**: The storefront, admin console, inventory ledger, and checkout consume the exact same PostgreSQL product and SKU tables.
2. **Zero Regressions**: Existing Makhana products, pack sizes, inventory holds, and order histories remain untouched.
3. **Controlled Publication**: New master catalogue items are created with clear publication and inventory statuses, preventing unverified products from going live prematurely.
