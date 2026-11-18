# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 01: Existing Catalogue Audit & Reconciliation Report (Phase 0)

**Date**: November 18, 2026  
**Status**: Completed & Verified Against Neon Database  

---

### 1. Database Catalogue Baseline

The Neon PostgreSQL database currently houses **42 active products** and **152 sellable SKUs**, established through core schema migrations and `database/migrations/add_dry_fruits_and_spices.sql`.

#### Summary of Active Catalogue in Database:
| Category | Subcategories | Active Products | Active SKUs | Pack Sizes Supported |
|---|---|---:|---:|---|
| **Raw Makhana** | Grade 5S, 6S, 7S | 4 | 4 | 100g, 200g, 500g, 1kg |
| **Flavoured Makhana** | Roasted Flavours | 8 | 8 | 80g |
| **Festive & Gift Boxes** | Hampers | 2 | 2 | 4-Pack (320g), 8-Flavour (640g) |
| **Bulk & Wholesale** | Wholesale Makhana | 6 | 6 | 5kg, 10kg Suta bags |
| **Dry Fruits** | 7 subcategories | 22 | 66 | 250g, 500g, 1000g |
| **Spices** | 3 subcategories | 16 | 66 | 100g, 250g, 500g, 1000g |
| **Total** | **15 Subcategories** | **42 Products** | **152 SKUs** | **Multi-tier** |

---

### 2. Category-by-Category Reconciliation

#### Category 01: Makhana (Flagship)
- **Status in DB**: Fully active and operational.
- **Existing Products**:
  - `raw-makhana`: Premium Mithila Makhana (100g, 200g, 500g, 1kg).
  - `flavoured-makhana`: Himalayan Pink Salt, Peri Peri, Mint Pudina, Cream & Onion, Tangy Tomato, Chilli Garlic, Bihari Chat Masala, Cheese & Herbs (80g each).
  - `bulk-makhana`: 5 Suta, 6 Suta, 7 Suta grades in 5kg and 10kg wholesale bags.
- **Master Plan Action**: Preserve all 12 items, SKUs, and pricing exactly as-is.

#### Category 02: Dry Fruits & Nuts
- **Status in DB**: 22 products active across 7 subcategories.
- **Existing vs Proposed Reconciliation**:
  | Subcategory | Existing in DB | Proposed in Brief | Reconciliation Action |
  |---|---|---|---|
  | **Almonds** | Premium Almond (₹1,200/kg), Gurbandi Almond (₹1,500/kg), Mamra Almond (₹4,800/kg) | Premium, Regular, Gurbandi, Mamra | **Keep existing 3**; add `Regular Almond` as draft. **DO NOT DUPLICATE Mamra/Gurbandi.** |
  | **Cashews** | Cashew Small (₹1,400/kg), Cashew Medium (₹1,600/kg), Cashew Large (₹1,800/kg), Cashew Jumbo (₹1,900/kg) | Small, Medium, Large, Jumbo | **100% Match**. Keep all 4 existing cashew grades intact. |
  | **Walnuts** | Walnut Chilean (₹2,400/kg), Walnut Kashmiri (₹1,600/kg) | Whole Walnut, Walnut Kernel, Chilean, Kashmiri | **Keep existing 2 kernels**; add `Whole Walnut (In-shell)` as draft. |
  | **Raisins** | Kishmish Long (₹950/kg), Kishmish Kandhari (₹1,800/kg), Kishmish Indian (₹850/kg) | Long, Kandhari, Indian, Black, Golden | **Keep existing 3**; add `Black Kishmish` and `Golden Raisins` as draft. |
  | **Pistachios** | Roasted & Salted Pista (₹2,200/kg), Pistachio Kernels (₹3,200/kg) | Regular, Roasted & Salted, Kernels, Unsalted | **Keep existing 2**; add `Unsalted Pista` as draft. |
  | **Dates & Figs** | Anjeer (₹2,400/kg), Medjool Dates (₹2,800/kg), Kimia Dates (₹1,400/kg) | Medjool, Kimia, Ajwa, Mabroom, Regular, Chuara 1 & 2, Munakka, Anjeer | **Keep existing 3**; add Ajwa, Mabroom, Chuara (2 variants), and Munakka as draft. |
  | **Dried Fruits** | Dried Apricots (Khubani), Prunes, Dried Cranberries | Apricots, Prunes, Cranberries, Blueberries, Mango, Pineapple, Kiwi | **Keep existing 3**; extend with Blueberries and dried exotic fruits as draft. |
  | **Imported Nuts** | None currently | Pecans, Hazelnuts, Brazil Nuts, Macadamia, Pine Nuts (Chilgoza) | Add to master taxonomy as draft/unverified. |

#### Category 03: Seeds & Superfoods
- **Status in DB**: Pumpkin Seeds (₹1,400/kg) and Sunflower Seeds (₹900/kg) exist under `dry-fruits/dried-fruits-and-seeds`.
- **Master Plan Action**: Reorganize into a dedicated top-level category `Seeds & Superfoods`. Add Flax Seeds (Alsi), Chia Seeds, Watermelon Seeds (Tarbooz Magaz), Muskmelon Seeds (Kharbooja Magaz), Sesame, Sabja, and Quinoa. **DO NOT duplicate Pumpkin or Sunflower Seeds.**

#### Category 04: Whole Spices
- **Status in DB**: 10 products active: Black Pepper Whole, Cumin Seeds, Black Cardamom, Cloves, Cinnamon Sticks, Star Anise, Green Cardamom, Fennel Seeds, Mustard Seeds, Fenugreek Seeds, Ajwain, Bay Leaves.
- **Master Plan Action**: Preserve existing items. Structure specific geographical varieties (Kashmiri Chilli, Byadgi, Guntur S4, Tellicherry Pepper) under structured variants/SKUs.

#### Category 05: Ground Spices
- **Status in DB**: Turmeric Powder (₹450/kg), Kashmiri Red Chilli Powder (₹900/kg), Coriander Powder (₹450/kg).
- **Master Plan Action**: Preserve existing 3 powders. Introduce regional single-origin options (Lakadong Turmeric, Salem Turmeric, Mathania Chilli Powder) as distinct verified products.

#### Category 06: Blended Masalas
- **Status in DB**: Garam Masala (₹1,200/kg).
- **Master Plan Action**: Preserve Garam Masala. Define Kitchen King, Chaat, Pav Bhaji, Chole, Biryani, Sambhar, Tea Masala in draft status.

#### Categories 07–10:
- **Category 07 (Grains & Millets)**: Traditional Millets (Bajra, Ragi, Jowar) & Premium Grains. Add to taxonomy in draft status.
- **Category 08 (Healthy Snacks & Mixes)**: Trail mixes, roasted nut snacks. Strictly quarantined in draft status until recipes, packaging, and shelf-life are approved.
- **Category 09 (Gifting & Hampers)**: 2 existing gift boxes preserved; expandable with corporate hampers.
- **Category 10 (Bulk & Wholesale)**: Existing Suta bulk makhana preserved; expand with dry fruit and spice bulk inquiry specifications.

---

### 3. Supplier Rates vs. Retail Prices Reconciliation

The prompt supplied a table of supplier procurement rates:
| Product | Supplier Rate Provided | Active Storefront Retail Rate | Reconciliation Rule |
|---|---:|---:|---|
| **Almond Mamra** | ₹1,100 | ₹4,800/kg (₹1,200 / 250g) | Record ₹1,100 as pending supplier procurement cost. **DO NOT touch retail price.** |
| **Almond** | ₹350 | ₹1,200/kg (₹300 / 250g) | Record ₹350 as pending supplier procurement cost. Storefront retail remains ₹1,200/kg. |
| **Cashew** | ₹275 | ₹1,400–₹1,900/kg | Record ₹275 as pending supplier cost for small grade. |
| **Kishmish** | ₹175 | ₹850–₹1,800/kg | Record ₹175 as pending supplier cost for Indian grade. |
| **Makhana** | ₹320 / ₹360 | ₹1,490/kg retail | Represents supplier raw grade wholesale cost (Grade B ₹320, Grade A ₹360). |
| **Walnut Whole** | ₹250 | N/A (Chilean kernel ₹2,400/kg) | Valid supplier cost for in-shell whole walnut. |
| **Walnut Kernel** | ₹450 | ₹1,600/kg (Kashmiri) | Valid supplier cost for bulk kernel. |
| **Munakka** | ₹200 | N/A (New product) | Set supplier cost to ₹200; retail price to be configured before activation. |
| **Chuara** | ₹200 / ₹300 | N/A (New product) | Preserve 2 distinct variants (Standard ₹200, Premium ₹300). |
| **Anjeer** | ₹350 | ₹2,400/kg retail | Record ₹350 as supplier cost for 250g or wholesale grade. |
| **Mixed Seeds** | ₹125 | N/A (New product) | Supplier cost ₹125. |
| **Pumpkin Seeds** | ₹250 | ₹1,400/kg retail | Record ₹250 as supplier cost. |
| **Sunflower Seeds**| ₹100 | ₹900/kg retail | Record ₹100 as supplier cost. |
| **Flax Seeds** | ₹50 | N/A (New product) | Supplier cost ₹50. |
| **Chia Seeds** | ₹125 | N/A (New product) | Supplier cost ₹125. |

**Strict Isolation Enforced**:
1. Supplier rates are internal cost benchmarks (`product_variants.cost_price`).
2. They will never be returned to customers via `/api/products` or exposed in the storefront bundle.
3. No active retail price will be overwritten with an unconfirmed wholesale rate.

---

### 4. Duplicate Prevention Safeguards

To prevent catalogue corruption, duplicate prevention rules will be enforced via:
- Unique composite index: `(category_id, LOWER(TRIM(name)))`
- Unique slug index: `LOWER(slug)`
- Normalized SKU index: `UPPER(sku)`
Existing products (e.g., `mamra-almond`, `pumpkin-seeds`, `kashmiri-red-chilli-powder`) will be updated or extended with pack sizes, never duplicated as second entries.
