# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 06: SKU & Product Variant Architectural Strategy

**Date**: November 18, 2026  
**Scope**: Taxonomy Code Generators, Weight Normalization, Multi-Pack Generation, and Collision Detection

---

### 1. Deterministic SKU Architecture

Every sellable unit in THE CRUNCHY HEART system is assigned a structured SKU following a 5-token uppercase alphanumeric convention:

```
TCH-[CATEGORY]-[PRODUCT_CODE]-[GRADE/FORM]-[WEIGHT/UNIT]
```

#### Token Definitions:
1. **Brand Prefix**: `TCH` (The Crunchy Heart).
2. **Category Code (3-4 Letters)**:
   - `MAK`: Makhana
   - `ALM`: Almonds
   - `CSH`: Cashews
   - `WAL`: Walnuts
   - `KSH`: Raisins (Kishmish)
   - `PST`: Pistachios
   - `DAT`: Dates & Figs
   - `SED`: Seeds & Superfoods
   - `WHL`: Whole Spices
   - `GND`: Ground Spices
   - `MSL`: Blended Masalas
   - `GRN`: Grains & Millets
   - `SNK`: Healthy Snacks
   - `GFT`: Gifting & Hampers
   - `BLK`: Bulk & Wholesale
3. **Product Identifier (3-6 Letters)**:
   - E.g. `MAMRA`, `GURB`, `JUMBO`, `CHIL`, `KASH`, `BYD`, `LAK`, `CHIA`, `FLAX`, `KKING`, `FOX`.
4. **Form / Processing Indicator (3 Letters)**:
   - `WHL`: Whole
   - `PWD`: Powder
   - `FLK`: Flakes
   - `KRN`: Kernel
   - `RAW`: Raw unroasted
   - `RST`: Roasted
5. **Pack Size & Weight**:
   - `100G`: 100 grams
   - `200G`: 200 grams
   - `250G`: 250 grams
   - `500G`: 500 grams
   - `1KG`: 1 kilogram (1000g)
   - `5KG`: 5 kilogram wholesale bag
   - `10KG`: 10 kilogram wholesale bag

---

### 2. Standardized Pack Weight Matrix by Category

| Category Family | Supported Pack Sizes | Rationale |
|---|---|---|
| **Raw Makhana** | 100g, 200g, 500g, 1kg | High volume density; 1kg is a large catering bag. |
| **Flavoured Makhana** | 80g | Optimal single-serve snacking freshness. |
| **Dry Fruits & Nuts** | 250g, 500g, 1kg | Standard Indian household pantry purchase units. |
| **Seeds & Superfoods** | 250g, 500g | Daily usage spooning size. |
| **Whole Spices** | 100g, 250g, 500g | Preserves aroma; prevents oxidation in home kitchens. |
| **Ground Spices** | 100g, 250g, 500g | Frequent purchase items with 90-day aroma freshness. |
| **Blended Masalas** | 100g, 250g | Specialty usage; smaller packs ensure peak flavour. |
| **Grains & Millets** | 500g, 1kg | Staple meal preparation weights. |
| **Bulk Wholesale** | 5kg, 10kg | Heavy-duty stitched multi-wall bags for B2B supply. |

---

### 3. Collision Detection & Enforcement

1. **Database Constraint**:
   `CREATE UNIQUE INDEX ux_product_variants_sku ON product_variants(UPPER(sku));`
2. **Application Validator**:
   The SKU generator validates uniqueness prior to executing insert queries, throwing `DUPLICATE_SKU_CONFLICT` (HTTP 409) if a match is found.
