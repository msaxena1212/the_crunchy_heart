# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 09: Frontend Storefront Implementation & UI/UX Architecture

**Date**: November 18, 2026  
**Scope**: Category Landing Pages (PLP), Product Detail Pages (PDP), Cart Drawer, Header Navigation, and Design System

---

### 1. Storefront Design System & Color Tokens

THE CRUNCHY HEART's aesthetic embodies clean, natural luxury for the modern Indian pantry:
- **Canvas & Surfaces**: Warm Ivory Canvas (`#fbf7ef`), Crisp Cream Surface (`#fffdf8`), Card Warmth (`#f8efe1`).
- **Brand Greens**: Deep Forest (`#14563c`), Heritage Forest Green (`#1e392a`), Soft Herb Sage (`#e5efe9`).
- **Earth & Accent Tones**: Warm Terracotta (`#9a6039`), Gold Ochre (`#a17c35`, `#c28a5b`), Terracotta Alert (`#b64232`).
- **Typography**: Clean, readable sans-serif (`DM Sans`) for body copy and pricing; high-contrast editorial serif (`Cormorant Garamond` / `Playfair Display`) for headings and banners.

---

### 2. Category Landing Pages (PLP — `CategoryComponent`)

The PLP is served via `/shop` (Shop All) and `/category/:slug` (Dedicated category view):
1. **Dynamic Header**:
   - High-resolution WebP hero banners (`assets/categories/*.webp`).
   - Category badge, title, tagline, and descriptive blurb.
2. **Subcategory Pill Tabs (`role="tablist"`)**:
   - Filter chips automatically generated from products in the active view (e.g., `All`, `Almonds`, `Cashews`, `Walnuts`, `Raisins`, `Dates & Figs`).
3. **Multilingual Search Filter**:
   - Case-insensitive search matching English and Hindi/vernacular names:
     - `Alsi` → Flax Seeds
     - `Haldi` → Turmeric
     - `Lal Mirch` → Red Chilli
     - `Jeera` → Cumin
     - `Sabja` → Basil Seeds
     - `Badam` → Almonds
     - `Kaju` → Cashews
     - `Kishmish` → Raisins
     - `Akhrot` → Walnuts
4. **Sort Dropdown**:
   - `Featured` (editorial default)
   - `Price: Low to High` (uses per-kg rate for fair comparison)
   - `Price: High to Low`
   - `Name: A to Z`
5. **Interactive Product Cards**:
   - Displays primary image with fallback placeholder.
   - Pack size selector pills (e.g. `250g`, `500g`, `1kg`).
   - Strike-through MRP with calculated savings percentage.
   - Per-kg rate calculation (`₹X/kg`).
   - Low-stock badge ("Only X left in stock").
   - Instant "Add to Cart" button.

---

### 3. Product Detail Pages (PDP — `ProductDetailComponent`)

- **Dynamic Variant Switcher**:
  - Automatically switches between weight selector ("Choose Pack Size") and flavour selector ("Choose Flavour").
- **Canonical & SEO Structured Data**:
  - Dynamically injects `Schema.org/Product` and `Schema.org/Offer` JSON-LD scripts server-side and client-side without hydration flickers.
- **Dual Action CTAs**:
  - **Add to Cart**: Adds item and opens the slide-over Mini-Cart Drawer.
  - **Buy Now**: Adds item, closes drawer, and redirects directly to `/checkout`.

---

### 4. Slide-over Mini-Cart Drawer (`MiniCartDrawerComponent`)

- Global component mounted on `app-root` and accessible from all storefront pages.
- **Dynamic Free Shipping Progress Bar**:
  - Real-time calculation against the ₹499 free delivery threshold.
  - `< ₹499`: "Add ₹X more for FREE Delivery! 🚚" with animated progress bar fill.
  - `>= ₹499`: "🎉 Hooray! Free Delivery Unlocked!" in emerald green.
- Immediate quantity modification (`−` / `+`), item removal, and subtotal recalculation.
- Quick CTAs to proceed directly to Checkout or view full Cart.
