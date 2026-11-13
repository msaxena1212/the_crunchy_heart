"""
THE CRUNCHY HEART - Dry fruits and spices catalogue (single source of truth)

Used by build_catalogue.py to generate:
  - database/migrations/add_dry_fruits_and_spices.sql
  - client/src/assets/products/*.webp and client/src/assets/categories/*.webp

Rates are per kilogram, in INR. Pack prices are pro-rated from the per-kg rate.

  PROVIDED BY THE OWNER:  rate_source = "owner"
  INDICATIVE PLACEHOLDER: rate_source = "indicative"  (reasonable market-style rates added so the
                          catalogue is complete; confirm or change them in Admin > Products)
"""

CATEGORIES = [
    {
        "slug": "dry-fruits",
        "name": "Dry Fruits",
        "description": "Premium almonds, cashews, walnuts, raisins and more, sorted by grade and packed fresh.",
        "sort_order": 5,
    },
    {
        "slug": "spices",
        "name": "Spices",
        "description": "Whole and ground spices, freshly packed to keep their aroma and flavour.",
        "sort_order": 6,
    },
]

SUBCATEGORIES = [
    # dry fruits
    {"category": "dry-fruits", "slug": "almonds", "name": "Almonds", "sort_order": 1},
    {"category": "dry-fruits", "slug": "cashews", "name": "Cashews", "sort_order": 2},
    {"category": "dry-fruits", "slug": "walnuts", "name": "Walnuts", "sort_order": 3},
    {"category": "dry-fruits", "slug": "raisins", "name": "Raisins (Kishmish)", "sort_order": 4},
    {"category": "dry-fruits", "slug": "pistachios", "name": "Pistachios", "sort_order": 5},
    {"category": "dry-fruits", "slug": "dates-and-figs", "name": "Dates & Figs", "sort_order": 6},
    {"category": "dry-fruits", "slug": "dried-fruits-and-seeds", "name": "Dried Fruits & Seeds", "sort_order": 7},
    # spices
    {"category": "spices", "slug": "whole-spices", "name": "Whole Spices", "sort_order": 1},
    {"category": "spices", "slug": "seeds-and-herbs", "name": "Seeds & Herbs", "sort_order": 2},
    {"category": "spices", "slug": "ground-and-blends", "name": "Ground Spices & Blends", "sort_order": 3},
]

DRY_WEIGHTS = [250, 500, 1000]
SPICE_WEIGHTS = [100, 250, 500, 1000]

# art: (kind, params) - consumed by the image generator
# tag: short label shown on the generated image
PRODUCTS = [
    # ------------------------------------------------------------------ ALMONDS
    {"category": "dry-fruits", "sub": "almonds", "slug": "premium-almond", "name": "Premium Almond", "rate": 1200, "rate_source": "owner",
     "badge": "Bestseller",
     "short": "Crisp, naturally sweet almonds, sorted for size.",
     "long": "Premium almonds with a crisp bite and a naturally sweet, buttery flavour. Sorted for size and packed fresh for snacking, baking and everyday cooking.",
     "art": ("almond", {"size": 1.0, "tone": "light", "count": 34})},
    {"category": "dry-fruits", "sub": "almonds", "slug": "gurbandi-almond", "name": "Gurbandi Almond", "rate": 1500, "rate_source": "owner",
     "short": "Small, dense almonds with an intense nutty flavour.",
     "long": "Gurbandi almonds are small, dense and rich in natural oils, prized for their intense nutty taste. A favourite for sweets, thandai and daily nutrition.",
     "art": ("almond", {"size": 0.72, "tone": "dark", "count": 48})},
    {"category": "dry-fruits", "sub": "almonds", "slug": "mamra-almond", "name": "Mamra Almond", "rate": 4800, "rate_source": "owner",
     "badge": "Premium Pick",
     "short": "Rare, oil-rich Mamra almonds. The finest of the family.",
     "long": "Mamra almonds are rare, oil-rich and deeply flavoured, often called the finest almonds of all. Best enjoyed on their own or soaked overnight.",
     "art": ("almond", {"size": 1.08, "tone": "mamra", "count": 24})},
    # ------------------------------------------------------------------ CASHEWS
    {"category": "dry-fruits", "sub": "cashews", "slug": "cashew-small", "name": "Cashew Small", "rate": 1400, "rate_source": "owner",
     "short": "Small whole cashews. Great for cooking and gravies.",
     "long": "Small, creamy cashews that are ideal for gravies, sweets and everyday cooking. Mildly sweet with a smooth, buttery crunch.",
     "art": ("cashew", {"size": 0.74, "count": 40})},
    {"category": "dry-fruits", "sub": "cashews", "slug": "cashew-medium", "name": "Cashew Medium", "rate": 1600, "rate_source": "owner",
     "short": "Medium whole cashews for snacking and sweets.",
     "long": "Medium-sized whole cashews with a creamy texture. A versatile choice for snacking, sweets and festive cooking.",
     "art": ("cashew", {"size": 0.9, "count": 32})},
    {"category": "dry-fruits", "sub": "cashews", "slug": "cashew-large", "name": "Cashew Large", "rate": 1800, "rate_source": "owner",
     "short": "Large, plump whole cashews.",
     "long": "Large, plump cashews with a rich, buttery flavour. Excellent roasted, in trail mixes or in gifting boxes.",
     "art": ("cashew", {"size": 1.08, "count": 26})},
    {"category": "dry-fruits", "sub": "cashews", "slug": "cashew-jumbo", "name": "Cashew Jumbo", "rate": 1900, "rate_source": "owner",
     "badge": "Jumbo",
     "short": "Our largest whole cashews. Perfect for gifting.",
     "long": "Jumbo cashews, the largest and most impressive grade. Creamy, sweet and beautifully whole, ideal for gifting and special occasions.",
     "art": ("cashew", {"size": 1.28, "count": 20})},
    # ------------------------------------------------------------------ WALNUTS
    {"category": "dry-fruits", "sub": "walnuts", "slug": "walnut-chilean", "name": "Walnut Chilean", "rate": 2400, "rate_source": "owner",
     "short": "Light, mild walnut kernels.",
     "long": "Chilean walnut kernels are light in colour with a mild, slightly sweet flavour. Great for baking, salads, breakfast bowls and desserts.",
     "art": ("walnut_kernel", {"tone": "light", "count": 16})},
    {"category": "dry-fruits", "sub": "walnuts", "slug": "walnut-kashmiri", "name": "Walnut Kashmiri", "rate": 1600, "rate_source": "owner",
     "short": "Rich, earthy Kashmiri walnuts.",
     "long": "Kashmiri walnuts have a rich, earthy flavour and a naturally darker kernel. A traditional favourite for sweets, chutneys and everyday nutrition.",
     "art": ("walnut_kernel", {"tone": "dark", "count": 16})},
    # ------------------------------------------------------------------ RAISINS
    {"category": "dry-fruits", "sub": "raisins", "slug": "kishmish-long", "name": "Kishmish Long", "rate": 950, "rate_source": "owner",
     "short": "Long, green seedless raisins.",
     "long": "Long green seedless raisins with a light, sweet-tart taste. Perfect for kheer, pulao, sweets and snacking.",
     "art": ("raisin", {"tone": "green", "elong": 1.9, "count": 90})},
    {"category": "dry-fruits", "sub": "raisins", "slug": "kishmish-kandhari", "name": "Kishmish Kandhari", "rate": 1800, "rate_source": "owner",
     "badge": "Premium Pick",
     "short": "Plump, juicy Kandhari raisins.",
     "long": "Kandhari raisins are plump, juicy and deeply sweet with a rich amber colour. A premium choice for desserts, festive dishes and gifting.",
     "art": ("raisin", {"tone": "amber", "elong": 1.35, "count": 70})},
    {"category": "dry-fruits", "sub": "raisins", "slug": "kishmish-indian", "name": "Kishmish Indian", "rate": 850, "rate_source": "owner",
     "short": "Everyday golden Indian raisins.",
     "long": "Golden Indian raisins with a soft bite and a honeyed sweetness. An easy everyday choice for cooking, baking and snacking.",
     "art": ("raisin", {"tone": "gold", "elong": 1.25, "count": 100})},
    # ------------------------------------------------------------------ INDICATIVE: PISTACHIOS
    {"category": "dry-fruits", "sub": "pistachios", "slug": "pistachio-roasted-salted", "name": "Pistachio Roasted & Salted", "rate": 2200, "rate_source": "indicative",
     "short": "Lightly roasted, lightly salted pistachios.",
     "long": "Pistachios in the shell, lightly roasted and salted. A crunchy, savoury snack that is easy to share.",
     "art": ("pistachio_shell", {"count": 30})},
    {"category": "dry-fruits", "sub": "pistachios", "slug": "pistachio-kernels", "name": "Pistachio Kernels", "rate": 2800, "rate_source": "indicative",
     "short": "Shelled green pistachio kernels.",
     "long": "Shelled, vibrant green pistachio kernels for desserts, kulfi, baking and garnishing.",
     "art": ("pistachio_kernel", {"count": 70})},
    # ------------------------------------------------------------------ INDICATIVE: DATES & FIGS
    {"category": "dry-fruits", "sub": "dates-and-figs", "slug": "anjeer-dried-fig", "name": "Anjeer (Dried Fig)", "rate": 1800, "rate_source": "indicative",
     "short": "Soft, chewy dried figs.",
     "long": "Soft, chewy dried figs with a honeyed sweetness and a gentle seed crunch. Enjoy them as they are, soaked, or in desserts.",
     "art": ("fig", {"count": 14})},
    {"category": "dry-fruits", "sub": "dates-and-figs", "slug": "medjool-dates", "name": "Medjool Dates", "rate": 1500, "rate_source": "indicative",
     "badge": "Premium Pick",
     "short": "Large, caramel-soft Medjool dates.",
     "long": "Large, soft Medjool dates with a caramel-like sweetness. A natural energy booster and a perfect dessert on their own.",
     "art": ("date", {"size": 1.2, "tone": "medjool", "count": 16})},
    {"category": "dry-fruits", "sub": "dates-and-figs", "slug": "khajur-kimia", "name": "Khajur (Kimia Dates)", "rate": 500, "rate_source": "indicative",
     "short": "Everyday soft dates.",
     "long": "Soft, sweet everyday dates. A wholesome choice for snacking, shakes and sweets.",
     "art": ("date", {"size": 0.85, "tone": "kimia", "count": 34})},
    # ------------------------------------------------------------------ INDICATIVE: DRIED FRUITS & SEEDS
    {"category": "dry-fruits", "sub": "dried-fruits-and-seeds", "slug": "apricot-khubani", "name": "Apricot (Khubani)", "rate": 900, "rate_source": "indicative",
     "short": "Tangy-sweet dried apricots.",
     "long": "Tangy-sweet dried apricots with a soft chew. Great in trail mixes, desserts and the classic khubani ka meetha.",
     "art": ("apricot", {"count": 24})},
    {"category": "dry-fruits", "sub": "dried-fruits-and-seeds", "slug": "prunes-dried-plum", "name": "Prunes (Dried Plum)", "rate": 1100, "rate_source": "indicative",
     "short": "Soft, pitted dried plums.",
     "long": "Soft, dark, naturally sweet dried plums. Rich in fibre and perfect for breakfast bowls and baking.",
     "art": ("prune", {"count": 22})},
    {"category": "dry-fruits", "sub": "dried-fruits-and-seeds", "slug": "dried-cranberry", "name": "Dried Cranberry", "rate": 1100, "rate_source": "indicative",
     "short": "Sweet-tart dried cranberries.",
     "long": "Ruby red cranberries with a sweet-tart taste. Brighten up cereals, salads, cakes and trail mixes.",
     "art": ("cranberry", {"count": 110})},
    {"category": "dry-fruits", "sub": "dried-fruits-and-seeds", "slug": "pumpkin-seeds", "name": "Pumpkin Seeds", "rate": 800, "rate_source": "indicative",
     "short": "Crunchy green pumpkin seeds.",
     "long": "Crunchy, nutrient-dense pumpkin seeds. Sprinkle on salads and smoothie bowls, or snack on them roasted.",
     "art": ("pumpkin_seed", {"count": 80})},
    {"category": "dry-fruits", "sub": "dried-fruits-and-seeds", "slug": "sunflower-seeds", "name": "Sunflower Seeds", "rate": 500, "rate_source": "indicative",
     "short": "Light, nutty sunflower seeds.",
     "long": "Light, nutty sunflower seeds that add crunch to bakes, salads and breakfast bowls.",
     "art": ("sunflower_seed", {"count": 110})},
    # ------------------------------------------------------------------ SPICES (all indicative)
    {"category": "spices", "sub": "ground-and-blends", "slug": "turmeric-powder", "name": "Turmeric Powder (Haldi)", "rate": 320, "rate_source": "indicative",
     "short": "Bright golden turmeric with a warm, earthy aroma.",
     "long": "Finely ground turmeric with a vibrant golden colour and a warm, earthy aroma. An everyday essential for dals, curries and golden milk.",
     "art": ("powder", {"color": (226, 160, 18)})},
    {"category": "spices", "sub": "ground-and-blends", "slug": "kashmiri-chilli-powder", "name": "Kashmiri Red Chilli Powder", "rate": 750, "rate_source": "indicative",
     "badge": "Bestseller",
     "short": "Deep red colour with mild heat.",
     "long": "Kashmiri red chilli powder gives dishes a rich red colour with gentle heat. Perfect for tandoori marinades, gravies and tadka.",
     "art": ("powder", {"color": (178, 28, 24)})},
    {"category": "spices", "sub": "ground-and-blends", "slug": "coriander-powder", "name": "Coriander Powder (Dhania)", "rate": 280, "rate_source": "indicative",
     "short": "Fragrant, citrusy ground coriander.",
     "long": "Freshly ground coriander with a citrusy, slightly sweet fragrance. The backbone of countless curries and spice blends.",
     "art": ("powder", {"color": (168, 148, 78)})},
    {"category": "spices", "sub": "ground-and-blends", "slug": "garam-masala", "name": "Garam Masala", "rate": 950, "rate_source": "indicative",
     "short": "A warm, aromatic finishing blend.",
     "long": "A balanced, aromatic blend of whole spices ground fresh. Add a pinch at the end of cooking for a warm, layered finish.",
     "art": ("powder", {"color": (120, 72, 38)})},
    {"category": "spices", "sub": "whole-spices", "slug": "black-pepper", "name": "Black Pepper (Kali Mirch)", "rate": 950, "rate_source": "indicative",
     "short": "Bold, pungent whole peppercorns.",
     "long": "Bold, pungent whole black peppercorns. Crack them fresh for the best aroma in curries, soups and marinades.",
     "art": ("pepper", {"count": 140})},
    {"category": "spices", "sub": "whole-spices", "slug": "green-cardamom", "name": "Green Cardamom (Elaichi)", "rate": 3200, "rate_source": "indicative",
     "badge": "Premium Pick",
     "short": "Fragrant green cardamom pods.",
     "long": "Aromatic green cardamom pods with a sweet, floral fragrance. A must for chai, kheer, biryani and festive sweets.",
     "art": ("cardamom", {"tone": "green", "count": 50})},
    {"category": "spices", "sub": "whole-spices", "slug": "black-cardamom", "name": "Black Cardamom (Badi Elaichi)", "rate": 2200, "rate_source": "indicative",
     "short": "Smoky, robust black cardamom.",
     "long": "Large, smoky black cardamom pods with a robust, earthy aroma. Ideal for slow-cooked meats, dals and rich gravies.",
     "art": ("cardamom", {"tone": "black", "count": 28})},
    {"category": "spices", "sub": "whole-spices", "slug": "cloves", "name": "Cloves (Laung)", "rate": 1700, "rate_source": "indicative",
     "short": "Intensely aromatic whole cloves.",
     "long": "Intensely aromatic whole cloves with a warm, sweet-pungent flavour. Used in rice, masalas, chai and desserts.",
     "art": ("clove", {"count": 90})},
    {"category": "spices", "sub": "whole-spices", "slug": "cinnamon-sticks", "name": "Cinnamon Sticks (Dalchini)", "rate": 750, "rate_source": "indicative",
     "short": "Sweet, woody cinnamon quills.",
     "long": "Fragrant cinnamon sticks with a sweet, woody warmth. Infuse in chai, biryani, curries and mulled drinks.",
     "art": ("cinnamon", {"count": 9})},
    {"category": "spices", "sub": "whole-spices", "slug": "star-anise", "name": "Star Anise (Chakra Phool)", "rate": 1500, "rate_source": "indicative",
     "short": "Star-shaped pods with a licorice note.",
     "long": "Beautiful star-shaped pods with a sweet licorice aroma. A key flavour in biryani, garam masala and spiced teas.",
     "art": ("star_anise", {"count": 16})},
    {"category": "spices", "sub": "seeds-and-herbs", "slug": "cumin-seeds", "name": "Cumin Seeds (Jeera)", "rate": 520, "rate_source": "indicative",
     "short": "Earthy, warm whole cumin seeds.",
     "long": "Earthy, warm whole cumin seeds for tempering. Bloom them in hot ghee or oil to start almost any Indian dish.",
     "art": ("seed_long", {"color": (146, 108, 58), "count": 160, "size": 1.0})},
    {"category": "spices", "sub": "seeds-and-herbs", "slug": "fennel-seeds", "name": "Fennel Seeds (Saunf)", "rate": 480, "rate_source": "indicative",
     "short": "Sweet, cooling fennel seeds.",
     "long": "Sweet, cooling fennel seeds with a gentle anise flavour. Enjoy as an after-meal freshener or add to curries and pickles.",
     "art": ("seed_long", {"color": (150, 156, 78), "count": 160, "size": 1.1})},
    {"category": "spices", "sub": "seeds-and-herbs", "slug": "mustard-seeds", "name": "Mustard Seeds (Rai)", "rate": 180, "rate_source": "indicative",
     "short": "Sharp, nutty whole mustard seeds.",
     "long": "Small, sharp mustard seeds that pop in hot oil and release a nutty, pungent flavour. Essential for tadka and pickles.",
     "art": ("seed_round", {"color": (98, 62, 34), "count": 420})},
    {"category": "spices", "sub": "seeds-and-herbs", "slug": "fenugreek-seeds", "name": "Fenugreek Seeds (Methi)", "rate": 200, "rate_source": "indicative",
     "short": "Bitter-sweet golden methi seeds.",
     "long": "Golden fenugreek seeds with a pleasant bitter-sweet taste. Used in tempering, pickles and spice blends.",
     "art": ("seed_round", {"color": (200, 150, 52), "count": 300, "square": True})},
    {"category": "spices", "sub": "seeds-and-herbs", "slug": "ajwain", "name": "Carom Seeds (Ajwain)", "rate": 450, "rate_source": "indicative",
     "short": "Pungent, thyme-like carom seeds.",
     "long": "Tiny, pungent carom seeds with a thyme-like aroma. A traditional digestive and a favourite in parathas and snacks.",
     "art": ("seed_long", {"color": (160, 128, 78), "count": 260, "size": 0.7})},
    {"category": "spices", "sub": "seeds-and-herbs", "slug": "bay-leaf", "name": "Bay Leaf (Tej Patta)", "rate": 280, "rate_source": "indicative",
     "short": "Aromatic dried bay leaves.",
     "long": "Aromatic dried bay leaves that add a subtle, savoury depth to rice, dals and slow-cooked dishes.",
     "art": ("bay_leaf", {"count": 14})},
]

# Cross-check helpers (used by build script)
def pack_price(rate_per_kg, grams):
    """Pro-rated pack price, rounded to the nearest rupee (half up)."""
    return int(rate_per_kg * grams / 1000 + 0.5)


def weights_for(product):
    return DRY_WEIGHTS if product["category"] == "dry-fruits" else SPICE_WEIGHTS


def weight_label(grams):
    return f"{grams // 1000}kg" if grams >= 1000 and grams % 1000 == 0 else f"{grams}g"


def sku_for(product, grams):
    code = "DF" if product["category"] == "dry-fruits" else "SP"
    slug_code = product["slug"].replace("-", "").upper()[:14]
    return f"TCH-{code}-{slug_code}-{grams}"
