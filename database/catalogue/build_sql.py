"""
Generates database/migrations/add_dry_fruits_and_spices.sql from catalogue_data.py.

Usage (from the repo root):  python database/catalogue/build_sql.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from catalogue_data import (  # noqa: E402
    CATEGORIES, SUBCATEGORIES, PRODUCTS, pack_price, weights_for, weight_label, sku_for,
)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "database", "migrations", "add_dry_fruits_and_spices.sql")

INITIAL_STOCK = 20
REORDER_LEVEL = 5
TAX_RATE = 5  # GST on dry fruits and packed spices. Confirm with your accountant.


def q(value):
    """SQL string literal."""
    return "'" + str(value).replace("'", "''") + "'"


def main():
    skus = set()
    lines = []
    add = lines.append

    add("""-- ==============================================================================
-- THE CRUNCHY HEART
-- Migration: Dry Fruits and Spices catalogue (categories, products, pack sizes, stock, images)
--
-- GENERATED FILE. Edit database/catalogue/catalogue_data.py and re-run
-- `python database/catalogue/build_sql.py` instead of editing this file by hand.
--
-- Safe to re-run: existing rows are left untouched (ON CONFLICT DO NOTHING), so prices, stock and
-- images edited in Admin > Products are never overwritten.
--
-- Notes
--   * Prices are per-kg rates pro-rated to each pack size. Rates marked "indicative" below were
--     added as placeholders; review every price in Admin > Products before launch.
--   * Opening stock is a placeholder. Set real quantities in Admin > Inventory / Products.
--   * GST is set to 5% on every variant. Confirm with your accountant.
-- ==============================================================================

BEGIN;

-- Tables used below already exist in schema.sql; these guards keep older databases working.
CREATE TABLE IF NOT EXISTS subcategories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name varchar(150) NOT NULL,
  slug varchar(180) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_subcategories_slug ON subcategories(slug);
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory_id uuid REFERENCES subcategories(id) ON DELETE SET NULL;
""")

    add("-- 1. Categories")
    for c in CATEGORIES:
        add(
            "INSERT INTO categories (name, slug, description, sort_order, is_active)\n"
            f"VALUES ({q(c['name'])}, {q(c['slug'])}, {q(c['description'])}, {c['sort_order']}, TRUE)\n"
            "ON CONFLICT (slug) DO NOTHING;"
        )

    add("\n-- 2. Subcategories (product families)")
    for s in SUBCATEGORIES:
        add(
            "INSERT INTO subcategories (category_id, name, slug, sort_order, is_active)\n"
            f"SELECT id, {q(s['name'])}, {q(s['slug'])}, {s['sort_order']}, TRUE FROM categories WHERE slug = {q(s['category'])}\n"
            "ON CONFLICT (slug) DO NOTHING;"
        )

    add("\n-- 3. Products")
    for index, p in enumerate(PRODUCTS, start=1):
        sort_order = 100 + index * 10
        add(
            "INSERT INTO products (category_id, subcategory_id, name, slug, description, short_description, brand, is_featured, is_active, sort_order)\n"
            f"SELECT c.id, sc.id, {q(p['name'])}, {q(p['slug'])}, {q(p['long'])}, {q(p['short'])}, 'The Crunchy Heart', "
            f"{'TRUE' if p.get('badge') else 'FALSE'}, TRUE, {sort_order}\n"
            f"FROM categories c JOIN subcategories sc ON sc.slug = {q(p['sub'])} AND sc.category_id = c.id\n"
            f"WHERE c.slug = {q(p['category'])}\n"
            "ON CONFLICT (slug) DO NOTHING;"
        )

    add("\n-- 4. Pack sizes (variants). Price = per-kg rate x weight, rounded to the nearest rupee.")
    for p in PRODUCTS:
        for order, grams in enumerate(weights_for(p), start=1):
            sku = sku_for(p, grams)
            assert sku not in skus, f"duplicate SKU {sku}"
            skus.add(sku)
            price = pack_price(p["rate"], grams)
            badge = q(p["badge"]) if p.get("badge") else "NULL"
            add(
                "INSERT INTO product_variants (product_id, sku, variant_name, weight_grams, mrp, selling_price, cost_price, tax_rate, badge, tone, is_active, sort_order)\n"
                f"SELECT id, {q(sku)}, {q(weight_label(grams))}, {grams}, 0, {price}, 0, {TAX_RATE}, {badge}, 'sand', TRUE, {order}\n"
                f"FROM products WHERE slug = {q(p['slug'])}\n"
                "ON CONFLICT (sku) DO NOTHING;"
            )

    add(f"\n-- 5. Opening stock ({INITIAL_STOCK} per pack size: placeholder, update in the admin panel)")
    sku_list = ", ".join(q(s) for s in sorted(skus))
    add(
        "INSERT INTO inventory (variant_id, quantity_on_hand, quantity_reserved, reorder_level)\n"
        f"SELECT id, {INITIAL_STOCK}, 0, {REORDER_LEVEL} FROM product_variants WHERE sku IN ({sku_list})\n"
        "ON CONFLICT (variant_id) DO NOTHING;"
    )

    add("\n-- 6. Product images (served from the storefront's assets folder; editable in the admin panel)")
    for p in PRODUCTS:
        add(
            "INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)\n"
            f"SELECT id, {q('assets/products/' + p['slug'] + '.webp')}, {q(p['name'] + ' by The Crunchy Heart')}, 'product', 0, TRUE\n"
            f"FROM products WHERE slug = {q(p['slug'])}\n"
            "AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);"
        )

    add("\n-- Rate card (per kg) for reference")
    for p in PRODUCTS:
        add(f"--   {p['name']:<34} Rs {p['rate']:>5}/kg   [{p['rate_source']}]")

    add("\nCOMMIT;\n")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))

    owner = sum(1 for p in PRODUCTS if p["rate_source"] == "owner")
    print(f"wrote {OUT}")
    print(f"{len(PRODUCTS)} products ({owner} owner rates, {len(PRODUCTS) - owner} indicative), {len(skus)} variants")


if __name__ == "__main__":
    main()
