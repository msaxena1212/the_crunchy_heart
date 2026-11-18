# THE CRUNCHY HEART — Complete Product Catalogue Expansion
## Document 11: Bulk Catalogue Import & Export Technical Guide

**Date**: November 18, 2026  
**Scope**: CSV Import/Export Formats, Validation Rules, SKU Conflicts, and Error Handling

---

### 1. CSV Schema Specification

Bulk product imports are processed idempotently. If a product slug or variant SKU already exists, the row is updated or skipped per configuration, preventing duplicate records.

#### Mandatory CSV Headers:
```csv
category_slug,subcategory_slug,product_name,product_slug,brand,short_description,variety,grade,origin,product_form,sku,pack_name,weight_grams,mrp,selling_price,cost_price,tax_rate,hsn_code,initial_stock,reorder_level,publication_status
```

#### Field Data Dictionary:
| Column Header | Type | Required | Allowed Values / Examples |
|---|---|---|---|
| `category_slug` | String | Yes | `dry-fruits`, `whole-spices`, `ground-spices`, `blended-masalas`, `seeds-and-superfoods`, `grains-and-millets` |
| `subcategory_slug` | String | Yes | `almonds`, `cashews`, `whole-chillies`, `peppercorns-cardamom`, `single-seeds` |
| `product_name` | String | Yes | `Kashmiri Mamra Almond`, `Lakadong Turmeric Powder` |
| `product_slug` | String | Yes | `kashmiri-mamra-almond` (lowercase kebab-case, unique) |
| `brand` | String | Yes | `The Crunchy Heart` |
| `product_form` | String | No | `whole`, `powder`, `flakes`, `kernel`, `raw`, `roasted` |
| `sku` | String | Yes | `TCH-ALM-MAMRA-250G` (UPPERCASE, unique) |
| `pack_name` | String | Yes | `250g`, `500g`, `1kg`, `5kg` |
| `weight_grams` | Integer | Yes | `100`, `250`, `500`, `1000`, `5000` |
| `mrp` | Integer | Yes | `1400` (must be >= `selling_price`) |
| `selling_price` | Integer | Yes | `1200` (retail price including GST) |
| `cost_price` | Integer | No | `1100` (internal procurement cost) |
| `tax_rate` | Numeric | Yes | `5.00` (food items) or `0.00` (raw unbranded) |
| `hsn_code` | String | Yes | `19041090`, `08021200`, `09103030` |
| `initial_stock` | Integer | Yes | Default: `20` |
| `publication_status` | String | Yes | `active`, `draft`, `pending_verification` |

---

### 2. Validation & Duplicate Detection Rules

1. **SKU Uniqueness**: If an imported SKU matches an existing SKU in `product_variants`, the price and stock will update without creating a new record.
2. **Slug Uniqueness**: If `product_slug` already exists, metadata (`description`, `brand`, `origin`) is updated; existing order linkages remain intact.
3. **Price Validation**:
   - `selling_price` must be greater than zero.
   - `mrp` must be `>= selling_price` (or `0`).
   - `cost_price` must never exceed `selling_price` without an admin override flag.
4. **Publication Safeguard**:
   - Items with missing prices or unverified supplier data must have `publication_status = 'draft'`.

---

### 3. Import Execution Command

The import script is executed from the server CLI:
```bash
node server/src/scripts/seed-master-catalogue.mjs --csv=docs/catalogue-expansion/master_product_import_template.csv
```
The script outputs an audit summary:
- **Created**: Count of new products and variants added.
- **Updated**: Count of existing records modified.
- **Skipped**: Duplicate or unchanged rows.
- **Errors**: List of invalid rows with line numbers and reasons.
