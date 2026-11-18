# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 12: Food Product Regulatory Compliance & FSSAI Guidelines

**Date**: November 18, 2026  
**Scope**: FSSAI Labelling, Mandatory Declarations, Allergen Management, and Claim Restrictions

---

### 1. Mandatory Statutory Declarations (FSSAI Regulations 2020)

As a packager and distributor of food items (Makhana, Dry Fruits, Seeds, and Spices), every product record and packaged SKU must carry valid compliance metadata:

| Field Name | DB Attribute | Storefront PDP Placement | Sample Required Value |
|---|---|---|---|
| **FSSAI License** | `fssai_license_number` | Trust strip, Specifications, Footer | `10424000000001` (Brand central license) |
| **Net Quantity** | `product_variants.weight_grams` | Title, variant picker, pack badge | `100g`, `250g`, `500g`, `1kg` |
| **MRP (Inclusive of Taxes)** | `product_variants.mrp` | Product price block (strike-through) | `₹1,400 (Incl. of all taxes)` |
| **Best Before / Shelf Life** | `products.shelf_life_days` | Product details table | `6 Months (180 days) from packing` |
| **Storage Instructions** | `products.storage_instructions` | Product specifications | `Store in a cool, dry place in an airtight container.` |
| **Country of Origin** | `products.origin` | Product specifications | `India` (or `Chile` for Chilean walnuts, `USA` for California almonds) |
| **Veg / Non-Veg Logo** | Standard Green Dot icon | Adjacent to product title | Green dot in square border (100% Vegetarian) |

---

### 2. Sourcing & Origin Claim Verification Rules

1. **Strict Prohibition on Fabricated Claims**:
   - Products must **not** be tagged as `Organic`, `Chemical-Free`, `Pesticide-Free`, or `Zero Preservatives` unless formal NPOP/Jaivik Bharat certification is on file.
   - Products must **not** claim `GI Certified` (Geographical Indication) unless sourced through verified farmer producer organizations in the designated GI territory (e.g. Mithila Makhana GI No. 696).
2. **Verified Declarations**:
   - "Naturally dried", "Sun-dried", "Graded for size", and "Hand-sorted" are verified process terms permitted for dry fruits and spices.

---

### 3. Allergen Declarations & Advisory

Under the Food Safety and Standards (Packaging and Labelling) Regulations:
- **Tree Nuts**: Almonds, Cashews, Walnuts, Pistachios, and Pecans must state:  
  *Allergen Advice: Contains Tree Nuts.*
- **Cross-Contamination Advisory**:  
  *Manufactured in a facility that also processes tree nuts, seeds, and spices.*
