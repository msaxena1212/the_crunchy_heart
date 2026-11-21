"""
Generates illustrated images for catalogue products that have no image yet, and writes a migration
that attaches an image to every one of them.

These are procedurally drawn illustrations (no photography), in the same style as build_images.py.
Replace any of them with a real photo from Admin > Products when you have one.

Three products reuse the existing pack photographs in client/src/assets/ instead of a drawing.

Usage (from the repo root):  python database/catalogue/build_missing_images.py
Output: client/src/assets/products/<slug>.webp and database/migrations/add_missing_product_images.sql
"""
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_images as bi  # noqa: E402
from build_images import (  # noqa: E402
    Scene, make_sprite, combine, jitter, lighten, darken, sil_ellipse, sil_teardrop,
    tex_wrinkles, tex_dots, tex_lines, almond_maker, cashew_maker, raisin_maker,
    pumpkin_seed_maker, sunflower_seed_maker, seed_round_maker, seed_long_maker, draw_label,
)

ROOT = bi.ROOT
OUT = bi.OUT_PRODUCTS
MIGRATION = os.path.join(ROOT, "database", "migrations", "add_missing_product_images.sql")


# --------------------------------------------------------------------------- extra sprite makers
def walnut_shell_maker():
    base = (176, 132, 86)

    def make(rng):
        tex = combine(tex_wrinkles(darken(base, 0.38), n=16, rng=rng), tex_dots(darken(base, 0.25), n=30, r=1.4, rng=rng))
        return make_sprite(86, 74, sil_ellipse, jitter(base, rng, 0.07), tex, light=0.34, dark=0.34)
    return make


def chilli_maker():
    base = (158, 26, 22)

    def make(rng):
        tex = tex_lines(lighten(base, 0.28), n=4, vertical=False, wobble=0.12, rng=rng)
        return make_sprite(118, 30, sil_teardrop, jitter(base, rng, 0.1), tex, light=0.4, dark=0.3)
    return make


# --------------------------------------------------------------------------- scenes
def labelled(sc, name, category):
    caption = "Premium dry fruits" if category == "dry-fruits" else "Freshly packed spices"
    draw_label(sc.img, name, caption)
    return sc.img.convert("RGB")


def pile_scene(name, category, parts):
    """parts: list of (maker, count, rx, ry, mound, sizes) drawn onto one shared pile."""
    sc = Scene(palette="dry" if category == "dry-fruits" else "spice", seed=sum(map(ord, name)))
    cx, cy = 500, 575
    sc.ground_shadow(cx, cy + 30, 320, 110)
    for make, count, rx, ry, mound, sizes in parts:
        sc.pile(make, count, cx, cy, rx * 1.12, ry * 1.12, mound=mound * 1.1, size_range=sizes)
    return labelled(sc, name, category)


def gift_box_scene(name, category, contents):
    sc = Scene(palette="dry" if category == "dry-fruits" else "spice", seed=sum(map(ord, name)))
    d = ImageDraw.Draw(sc.img)
    green, gold, cream = (20, 86, 60), (196, 161, 90), (244, 232, 205)
    sc.ground_shadow(500, 640, 360, 70)
    d.rounded_rectangle([170, 360, 830, 700], radius=34, fill=darken(green, 0.2))        # back wall
    d.rounded_rectangle([196, 392, 804, 640], radius=22, fill=cream)                       # inside
    d = None
    xs = [330, 500, 670]
    for x, (make, count) in zip(xs, contents):
        sc.pile(make, count, x, 540, 105, 42, mound=62, size_range=(0.85, 1.0), scale=1.0)
    d = ImageDraw.Draw(sc.img)
    d.rounded_rectangle([170, 560, 830, 720], radius=30, fill=green, outline=gold, width=5)  # front wall
    d.rounded_rectangle([190, 578, 810, 702], radius=22, outline=lighten(gold, 0.3), width=2)
    d.rectangle([470, 560, 530, 720], fill=gold)                                              # ribbon
    d.polygon([(500, 560), (430, 505), (455, 560)], fill=gold)                                # bow
    d.polygon([(500, 560), (570, 505), (545, 560)], fill=gold)
    d.ellipse([478, 538, 522, 580], fill=darken(gold, 0.12))
    return labelled(sc, name, category)


# --------------------------------------------------------------------------- specs
RAW = lambda c: (c,)  # noqa: E731

GENERATED = [
    # slug, display name, category, builder
    ("regular-almond", "Regular California Almond", "dry-fruits",
     lambda n, c: bi.build_product({"slug": "regular-almond", "name": n, "category": c, "art": ("almond", {"size": 0.84, "tone": "light", "count": 72})})),
    ("royal-medjool-dates", "Royal Medjool Dates", "dry-fruits",
     lambda n, c: bi.build_product({"slug": "royal-medjool-dates", "name": n, "category": c, "art": ("date", {"size": 1.3, "tone": "medjool", "count": 17})})),
    ("whole-in-shell-walnut", "Whole In-Shell Kashmiri Walnut", "dry-fruits",
     lambda n, c: pile_scene(n, c, [(walnut_shell_maker(), 40, 260, 105, 130, (0.9, 1.1))])),
    ("daily-nutrition-seven-seed-mix", "Daily 7-Seed Superfood Mix", "dry-fruits",
     lambda n, c: pile_scene(n, c, [
         (seed_round_maker((98, 62, 34), False), 120, 270, 105, 130, (0.9, 1.2)),
         (seed_long_maker((146, 108, 58), 0.9), 90, 270, 105, 130, (0.9, 1.1)),
         (sunflower_seed_maker(), 50, 270, 105, 130, (0.9, 1.1)),
         (pumpkin_seed_maker(), 36, 270, 105, 130, (0.9, 1.1)),
         (seed_round_maker((200, 150, 52), True), 90, 270, 105, 130, (0.9, 1.2)),
     ])),
    ("chia-seeds-raw", "Raw Black Chia Seeds", "dry-fruits",
     lambda n, c: bi.build_product({"slug": "chia-seeds-raw", "name": n, "category": c, "art": ("seed_round", {"color": (66, 58, 56), "count": 560})})),
    ("flax-seeds-raw", "Raw Brown Flax Seeds (Alsi)", "dry-fruits",
     lambda n, c: bi.build_product({"slug": "flax-seeds-raw", "name": n, "category": c, "art": ("seed_long", {"color": (122, 72, 36), "count": 230, "size": 0.8})})),
    ("sweet-basil-seeds-sabja", "Sweet Basil Seeds (Sabja)", "dry-fruits",
     lambda n, c: bi.build_product({"slug": "sweet-basil-seeds-sabja", "name": n, "category": c, "art": ("seed_round", {"color": (30, 26, 24), "count": 520})})),
    ("royal-white-quinoa", "Royal Indian White Quinoa (Saponin-Free)", "dry-fruits",
     lambda n, c: bi.build_product({"slug": "royal-white-quinoa", "name": n, "category": c, "art": ("seed_round", {"color": (232, 218, 176), "count": 440})})),
    ("foxtail-millet-unpolished", "Unpolished Foxtail Millet (Kangni)", "dry-fruits",
     lambda n, c: bi.build_product({"slug": "foxtail-millet-unpolished", "name": n, "category": c, "art": ("seed_round", {"color": (214, 168, 60), "count": 600})})),
    ("byadgi-chilli-whole", "Byadgi Red Chilli (Dabbi)", "spices",
     lambda n, c: pile_scene(n, c, [(chilli_maker(), 60, 260, 95, 100, (0.9, 1.1))])),
    ("green-cardamom-bold-8mm", "Idukki Bold Green Cardamom (8mm+)", "spices",
     lambda n, c: bi.build_product({"slug": "green-cardamom-bold-8mm", "name": n, "category": c, "art": ("cardamom", {"tone": "green", "count": 38})})),
    ("malabar-black-peppercorns-bold", "Malabar Bold Black Peppercorns", "spices",
     lambda n, c: bi.build_product({"slug": "malabar-black-peppercorns-bold", "name": n, "category": c, "art": ("pepper", {"count": 120})})),
    ("lakadong-turmeric-powder", "Meghalaya Lakadong Turmeric Powder (7%+ Curcumin)", "spices",
     lambda n, c: bi.build_product({"slug": "lakadong-turmeric-powder", "name": n, "category": c, "art": ("powder", {"color": (214, 122, 10)})})),
    ("mumbai-pav-bhaji-masala", "Artisanal Mumbai Pav Bhaji Masala", "spices",
     lambda n, c: bi.build_product({"slug": "mumbai-pav-bhaji-masala", "name": n, "category": c, "art": ("powder", {"color": (172, 54, 30)})})),
    ("royal-kitchen-king-masala", "Royal Kitchen King Masala", "spices",
     lambda n, c: bi.build_product({"slug": "royal-kitchen-king-masala", "name": n, "category": c, "art": ("powder", {"color": (152, 94, 42)})})),
    ("royal-superfood-trail-mix", "Royal Superfood Trail Mix", "dry-fruits",
     lambda n, c: pile_scene(n, c, [
         (almond_maker(0.8, "light"), 30, 260, 105, 130, (0.9, 1.1)),
         (cashew_maker(0.8), 26, 260, 105, 130, (0.9, 1.1)),
         (raisin_maker("amber", 1.3), 50, 260, 105, 130, (0.9, 1.1)),
         (pumpkin_seed_maker(), 34, 260, 105, 130, (0.9, 1.1)),
     ])),
    ("festive-discovery-box", "The Crunch Box — Festive Gift Set", "dry-fruits",
     lambda n, c: gift_box_scene(n, c, [(almond_maker(0.7, "light"), 22), (cashew_maker(0.7), 20), (raisin_maker("gold", 1.25), 36)])),
    ("heritage-mithila-royal-pantry-box", "Heritage Mithila Royal Pantry Box", "dry-fruits",
     lambda n, c: gift_box_scene(n, c, [(almond_maker(0.7, "mamra"), 20), (bi.date_maker(0.7, "medjool"), 14), (bi.pistachio_kernel_maker(), 34)])),
]

# Existing pack photographs reused as-is (slug -> (image path stored in DB, product name))
REUSED = {
    "raw-makhana": ("assets/raw-makhana-500g.webp", "Raw Makhana"),
    "bulk-raw-makhana": ("assets/bulk-makhana.webp", "Direct-from-Origin Bulk Raw Makhana"),
    "flavoured-makhana": ("assets/himalayan-salt.webp", "Flavoured Makhana"),
}


# Shorter names for the picture label only (alt text and the catalogue keep the full name)
LABELS = {
    "whole-in-shell-walnut": "In-Shell Kashmiri Walnut",
    "royal-white-quinoa": "Royal White Quinoa",
    "foxtail-millet-unpolished": "Foxtail Millet (Kangni)",
    "green-cardamom-bold-8mm": "Idukki Bold Green Cardamom",
    "lakadong-turmeric-powder": "Lakadong Turmeric Powder",
    "mumbai-pav-bhaji-masala": "Mumbai Pav Bhaji Masala",
}


def q(s):
    return "'" + s.replace("'", "''") + "'"


def main():
    os.makedirs(OUT, exist_ok=True)
    wanted = set(sys.argv[1:])
    rows = []
    for slug, name, category, build in GENERATED:
        if not wanted or slug in wanted:
            img = build(LABELS.get(slug, name), category).resize((900, 900), Image.LANCZOS)
            path = os.path.join(OUT, slug + ".webp")
            img.save(path, "WEBP", quality=82, method=6)
            print(f"{slug:<36} {os.path.getsize(path) // 1024:>4} KB", flush=True)
        rows.append((slug, f"assets/products/{slug}.webp", name))
    for slug, (url, name) in REUSED.items():
        rows.append((slug, url, name))

    lines = [
        "-- Attach an image to every product that has none. Idempotent: skips products that already have a primary image.",
        "-- Illustrated images are drawn by database/catalogue/build_missing_images.py; replace any from Admin > Products.",
        "BEGIN;",
    ]
    for slug, url, name in rows:
        lines.append(
            "INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order, is_primary)\n"
            f"SELECT id, {q(url)}, {q(name + ' by The Crunchy Heart')}, 'product', 0, TRUE\n"
            f"FROM products WHERE slug = {q(slug)}\n"
            "AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id AND pi.is_primary);"
        )
    lines.append("COMMIT;\n")
    with open(MIGRATION, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {MIGRATION} ({len(rows)} products)")


if __name__ == "__main__":
    main()
