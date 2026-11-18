import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';

import { CartService } from '../cart.service';
import { Product, ProductVariant } from '../product.model';
import { ProductService } from '../product.service';

interface CategoryInfo {
  name: string;
  tagline: string;
  blurb: string;
  banner: string | null;
  icon: string;
  perKg: boolean;
}

/** Display copy for known categories. Anything else falls back to the name from the API. */
const CATEGORY_INFO: Record<string, CategoryInfo> = {
  'all': {
    name: 'All Products',
    tagline: 'Complete Mithila Makhana, Dry Fruits & Spices Store',
    blurb: 'Explore our entire handcrafted range of Satvik, export-grade raw makhana, 8 slow-roasted gourmet flavours, dry fruits, and aromatic spices.',
    banner: null,
    icon: '🌾',
    perKg: false
  },
  'raw-makhana': {
    name: 'Raw Mithila Makhana',
    tagline: 'Export-grade 6+ Suta popped lotus seeds',
    blurb: 'Sourced directly from the pristine wetlands of Darbhanga, Bihar. 100% natural, unroasted, non-GMO, gluten-free, and rich in natural antioxidants.',
    banner: 'assets/bulk-makhana.webp',
    icon: '🌾',
    perKg: false
  },
  'flavoured-makhana': {
    name: 'Gourmet Flavoured Makhana',
    tagline: 'Slow-roasted in pure olive oil • Never fried',
    blurb: '8 irresistible slow-roasted flavours crafted with zero palm oil, zero trans fat, and 100% Satvik real herbs and spices. Perfect healthy anytime snacking.',
    banner: 'assets/hero-image.webp',
    icon: '✨',
    perKg: false
  },
  'festive-gifting': {
    name: 'Festive & Celebration Hampers',
    tagline: 'Thoughtfully crafted gift boxes for celebrations',
    blurb: 'Curated 3x3 festive combo builder boxes, luxury celebration hampers, and bespoke gift sets made with pure heart and premium crunch.',
    banner: 'assets/festive-box.webp',
    icon: '🎁',
    perKg: false
  },
  'dry-fruits': {
    name: 'Dry Fruits',
    tagline: 'Premium nuts and dried fruits',
    blurb: 'Almonds, cashews, walnuts, raisins and more, sorted by grade and packed fresh. Prices are per kg, and every pack size is priced from the same rate.',
    banner: 'assets/categories/dry-fruits.webp',
    icon: '🥜',
    perKg: true
  },
  'makhana': {
    name: 'Makhana (Fox Nuts)',
    tagline: 'Mithila GI-Tagged Handpicked Fox Nuts',
    blurb: 'Directly sourced from the pristine wetlands of Mithila, Bihar. High protein, zero cholesterol, slow-roasted to perfection in pure cold-pressed oils and natural seasonings.',
    banner: 'assets/hero-image.webp',
    icon: '🌾',
    perKg: false
  },
  'seeds-and-superfoods': {
    name: 'Seeds & Superfoods',
    tagline: 'Nutrient-Dense Natural Superfoods',
    blurb: 'Raw and gently roasted pumpkin seeds, sunflower seeds, chia seeds, golden flax, and basil seeds. Packed with plant protein, omega-3, and dietary fiber.',
    banner: 'assets/categories/dry-fruits.webp',
    icon: '🌱',
    perKg: true
  },
  'seeds-superfoods': {
    name: 'Seeds & Superfoods',
    tagline: 'Nutrient-Dense Natural Superfoods',
    blurb: 'Raw and gently roasted pumpkin seeds, sunflower seeds, chia seeds, golden flax, and basil seeds. Packed with plant protein, omega-3, and dietary fiber.',
    banner: 'assets/categories/dry-fruits.webp',
    icon: '🌱',
    perKg: true
  },
  'spices': {
    name: 'Spices & Seasonings',
    tagline: 'Whole and ground, freshly packed',
    blurb: 'Whole, stone-ground, and culinary blended spices packed to keep their volatile aroma and flavour. Choose from 100g to 1kg packs, all priced from a per-kg rate.',
    banner: 'assets/categories/spices.webp',
    icon: '🌶️',
    perKg: true
  },
  'whole-spices': {
    name: 'Whole Spices',
    tagline: 'Single-Origin Aromatic Whole Spices',
    blurb: 'Sun-dried whole spices sourced directly from heritage origin plantations. Tellicherry black pepper, Alleppey green cardamom, Ceylon cinnamon, and fragrant cloves.',
    banner: 'assets/categories/spices.webp',
    icon: '🌿',
    perKg: true
  },
  'ground-spices': {
    name: 'Ground Spices',
    tagline: 'Pure Stone-Ground Kitchen Staples',
    blurb: 'Low-temperature slow-ground spices preserving volatile essential oils and natural colours. High-curcumin Lakadong turmeric, pungent Guntur chilli, and fragrant coriander.',
    banner: 'assets/categories/spices.webp',
    icon: '🌶️',
    perKg: true
  },
  'blended-masalas': {
    name: 'Blended Masalas',
    tagline: 'Artisanal Hand-Blended Culinary Spice Mixes',
    blurb: 'Traditional Indian culinary masalas blended without fillers, starch, or artificial flavour enhancers. Authentic Garam Masala, Kitchen King, Chaat, and Chole masalas.',
    banner: 'assets/categories/spices.webp',
    icon: '🍲',
    perKg: true
  },
  'grains-and-millets': {
    name: 'Grains & Millets',
    tagline: 'Nutritious Ancient Indian Millets & Heritage Grains',
    blurb: 'Unpolished, gluten-free traditional millets and super grains. High-fibre Bajra, iron-rich Ragi, protein-packed Quinoa, and traditional hand-pounded grains.',
    banner: 'assets/bulk-makhana.webp',
    icon: '🌾',
    perKg: true
  },
  'grains-millets': {
    name: 'Grains & Millets',
    tagline: 'Nutritious Ancient Indian Millets & Heritage Grains',
    blurb: 'Unpolished, gluten-free traditional millets and super grains. High-fibre Bajra, iron-rich Ragi, protein-packed Quinoa, and traditional hand-pounded grains.',
    banner: 'assets/bulk-makhana.webp',
    icon: '🌾',
    perKg: true
  },
  'gifting-and-hampers': {
    name: 'Gifting & Hampers',
    tagline: 'Thoughtfully crafted gift boxes for celebrations',
    blurb: 'Curated 3x3 festive combo builder boxes, luxury celebration hampers, and bespoke gift sets made with pure heart and premium crunch.',
    banner: 'assets/festive-box.webp',
    icon: '🎁',
    perKg: false
  },
  'bulk': {
    name: 'Bulk & Wholesale Pantry',
    tagline: 'Commercial & Institutional B2B Supply',
    blurb: 'Direct farm-gate wholesale supply of export-grade Mithila Makhana (5S, 6S, 7S Suta grades), bulk dry fruits, and commercial spices in 5kg and 10kg bags.',
    banner: 'assets/bulk-makhana.webp',
    icon: '📦',
    perKg: true
  },
  'bulk-and-wholesale': {
    name: 'Bulk & Wholesale Pantry',
    tagline: 'Commercial & Institutional B2B Supply',
    blurb: 'Direct farm-gate wholesale supply of export-grade Mithila Makhana (5S, 6S, 7S Suta grades), bulk dry fruits, and commercial spices in 5kg and 10kg bags.',
    banner: 'assets/bulk-makhana.webp',
    icon: '📦',
    perKg: true
  }
};

/** Multilingual Hindi / vernacular synonyms for smart search expansion */
export const MULTILINGUAL_SYNONYMS: Record<string, string[]> = {
  alsi: ['flax', 'flaxseed', 'flax seeds', 'alsi'],
  flax: ['alsi', 'flaxseed', 'flax seeds'],
  haldi: ['turmeric', 'haldi', 'curcumin', 'lakadong'],
  turmeric: ['haldi', 'curcumin', 'lakadong', 'turmeric'],
  'lal mirch': ['red chilli', 'chilli', 'mirch', 'kashmiri', 'byadgi', 'guntur', 'mathania', 'deggi'],
  mirch: ['chilli', 'pepper', 'mirch', 'red chilli'],
  chilli: ['mirch', 'chilli', 'chili', 'kashmiri', 'byadgi'],
  jeera: ['cumin', 'jeera', 'shahi jeera', 'caraway'],
  cumin: ['jeera', 'cumin', 'shahi jeera'],
  sabja: ['basil', 'sabja', 'basil seeds', 'falooda seeds'],
  basil: ['sabja', 'basil seeds', 'basil'],
  methi: ['fenugreek', 'methi'],
  fenugreek: ['methi', 'fenugreek'],
  dhania: ['coriander', 'dhania', 'dhaniya'],
  dhaniya: ['coriander', 'dhania', 'dhaniya'],
  coriander: ['dhania', 'dhaniya', 'coriander'],
  saunf: ['fennel', 'saunf'],
  fennel: ['saunf', 'fennel'],
  elaichi: ['cardamom', 'elaichi', 'elachi'],
  cardamom: ['elaichi', 'cardamom'],
  badam: ['almond', 'badam', 'mamra', 'gurbandi'],
  almond: ['badam', 'almond', 'mamra', 'gurbandi'],
  kaju: ['cashew', 'kaju'],
  cashew: ['kaju', 'cashew'],
  kishmish: ['raisin', 'kishmish', 'kismis', 'sultana', 'munakka'],
  raisin: ['kishmish', 'kismis', 'raisin', 'munakka'],
  akhrot: ['walnut', 'akhrot'],
  walnut: ['akhrot', 'walnut'],
  khajoor: ['date', 'khajoor', 'dates', 'medjool', 'kimia', 'ajwa', 'chuara'],
  dates: ['khajoor', 'date', 'dates', 'medjool', 'kimia', 'ajwa'],
  anjeer: ['fig', 'anjeer', 'figs'],
  figs: ['anjeer', 'fig', 'figs'],
  pista: ['pistachio', 'pista'],
  pistachio: ['pista', 'pistachio'],
  til: ['sesame', 'til'],
  sesame: ['til', 'sesame'],
  'khus khus': ['poppy', 'khus khus', 'poppy seeds'],
  magaz: ['melon seeds', 'watermelon seeds', 'muskmelon seeds', 'magaz', 'tarbooz', 'kharbooja'],
  laung: ['clove', 'cloves', 'laung', 'lavang'],
  clove: ['laung', 'clove', 'cloves'],
  dalchini: ['cinnamon', 'dalchini'],
  cinnamon: ['dalchini', 'cinnamon'],
  'kali mirch': ['black pepper', 'kali mirch', 'peppercorn'],
  'black pepper': ['kali mirch', 'pepper', 'black pepper'],
  'chhoti elaichi': ['green cardamom', 'chhoti elaichi'],
  'badi elaichi': ['black cardamom', 'badi elaichi'],
  hing: ['asafoetida', 'hing'],
  kesar: ['saffron', 'kesar', 'zafran'],
  saffron: ['kesar', 'saffron', 'zafran'],
  tejpatta: ['bay leaf', 'bay leaves', 'tejpatta'],
  sonth: ['dry ginger', 'ginger powder', 'sonth'],
  amchur: ['dry mango', 'mango powder', 'amchur'],
  ragi: ['finger millet', 'ragi', 'nachni'],
  bajra: ['pearl millet', 'bajra'],
  jowar: ['sorghum', 'jowar'],
  makhana: ['fox nuts', 'lotus seeds', 'gorgon nut', 'phool makhana', 'makhana'],
  'fox nut': ['makhana', 'lotus seed'],
  'lotus seeds': ['makhana']
};

export function expandSearchTerms(query: string): string[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return [];

  const terms = new Set<string>([clean]);
  clean.split(/\s+/).forEach(token => {
    if (token.length > 1) terms.add(token);
  });

  for (const [key, synonyms] of Object.entries(MULTILINGUAL_SYNONYMS)) {
    if (clean.includes(key) || key.includes(clean)) {
      synonyms.forEach(syn => terms.add(syn.toLowerCase()));
    }
    for (const syn of synonyms) {
      if (clean.includes(syn.toLowerCase())) {
        terms.add(key.toLowerCase());
        synonyms.forEach(s => terms.add(s.toLowerCase()));
      }
    }
  }

  return Array.from(terms);
}

export interface CatalogItem {
  product: Product;
  variants: ProductVariant[];
  selected: ProductVariant;
}

type SortKey = 'featured' | 'price-asc' | 'price-desc' | 'name';

@Component({
  selector: 'app-category',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './category.component.html',
  styleUrl: './category.component.css'
})
export class CategoryComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly productService = inject(ProductService);
  private readonly cartService = inject(CartService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);

  slug = '';
  info: CategoryInfo = { name: '', tagline: '', blurb: '', banner: null, icon: '🛍️', perKg: false };

  loading = true;
  error = '';
  items: CatalogItem[] = [];

  activeFamily = 'all';
  search = '';
  sort: SortKey = 'featured';

  /** Product id -> briefly true after it is added, to show feedback on the button. */
  added: Record<string, boolean> = {};

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      this.slug = params.get('slug') ?? (this.route.snapshot.data['slug'] || 'all');
      this.activeFamily = 'all';
      this.search = '';
      this.sort = 'featured';
      this.load();
    });
  }

  private load(): void {
    this.loading = true;
    this.error = '';
    this.items = [];
    this.info = CATEGORY_INFO[this.slug] ?? {
      name: this.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      tagline: '',
      blurb: '',
      banner: null,
      icon: '🛍️',
      perKg: false
    };

    const options: { category?: string } = {};
    if (this.slug && this.slug !== 'all' && this.slug !== 'shop') {
      options.category = this.slug;
    }

    this.productService
      .getProducts(options)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: rows => {
          if (!rows.length && (this.slug === 'makhana' || this.slug === 'spices')) {
            // Umbrella fallback: if specific category query returned 0 rows, check across all products
            this.productService.getProducts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
              next: allRows => {
                const filtered = allRows.filter(r =>
                  this.slug === 'makhana'
                    ? (r.category.slug.includes('makhana') || r.name.toLowerCase().includes('makhana'))
                    : (r.category.slug.includes('spice') || r.category.slug.includes('masala'))
                );
                this.items = this.group(filtered);
                this.loading = false;
                this.setMetadata();
              },
              error: () => {
                this.items = [];
                this.loading = false;
                this.setMetadata();
              }
            });
            return;
          }

          this.items = this.group(rows);
          if (this.items.length && !CATEGORY_INFO[this.slug]) {
            this.info = { ...this.info, name: this.items[0].product.category.name };
          }
          this.loading = false;
          this.setMetadata();
        },
        error: () => {
          this.error = 'We could not load these products right now. Please try again.';
          this.loading = false;
        }
      });
  }

  /** The API returns one row per pack size; this folds them into one card per product. */
  private group(rows: Product[]): CatalogItem[] {
    const byId = new Map<string, CatalogItem>();

    for (const row of rows) {
      if (!row.variant) {
        continue;
      }
      const existing = byId.get(row.id);
      if (existing) {
        existing.variants.push(row.variant);
      } else {
        byId.set(row.id, { product: row, variants: [row.variant], selected: row.variant });
      }
    }

    for (const item of byId.values()) {
      item.variants.sort((a, b) => (a.weightGrams ?? 0) - (b.weightGrams ?? 0));
      // Preselect the smallest pack that is in stock, so the card opens on something buyable.
      item.selected = item.variants.find(v => this.inStock(v)) ?? item.variants[0];
    }

    return Array.from(byId.values());
  }

  private setMetadata(): void {
    this.title.setTitle(`${this.info.name} | The Crunchy Heart`);
    if (this.info.blurb) {
      this.meta.updateTag({ name: 'description', content: this.info.blurb });
    }
  }

  /* ---------- Derived lists ---------- */

  get families(): Array<{ slug: string; name: string; count: number }> {
    const map = new Map<string, { slug: string; name: string; count: number }>();

    for (const item of this.items) {
      // In 'all' (Shop All) or umbrella views, group by category so customer can filter broad collections.
      // In specific category views, group by subcategory!
      const group = (this.slug === 'all' || this.slug === 'shop' || this.slug === 'spices' || this.slug === 'makhana')
        ? (item.product.category ? { slug: item.product.category.slug, name: item.product.category.name } : null)
        : (item.product.subcategory ? { slug: item.product.subcategory.slug, name: item.product.subcategory.name } : null);

      if (!group) {
        continue;
      }
      const entry = map.get(group.slug) ?? { slug: group.slug, name: group.name, count: 0 };
      entry.count++;
      map.set(group.slug, entry);
    }

    return Array.from(map.values());
  }

  get visibleItems(): CatalogItem[] {
    const rawTerm = this.search.trim().toLowerCase();
    const searchTokens = expandSearchTerms(rawTerm);

    let list = this.items.filter(item => {
      const familyOk = this.activeFamily === 'all' ||
        item.product.subcategory?.slug === this.activeFamily ||
        item.product.category?.slug === this.activeFamily;

      if (!familyOk) {
        return false;
      }
      if (!rawTerm) {
        return true;
      }

      const searchableText = [
        item.product.name,
        item.product.shortDescription ?? '',
        item.product.description ?? '',
        item.product.subcategory?.name ?? '',
        item.product.category?.name ?? '',
        ...item.variants.map(v => `${v.name} ${v.flavor ?? ''} ${v.sku}`)
      ].join(' ').toLowerCase();

      return searchTokens.some(token => searchableText.includes(token));
    });

    const price = (i: CatalogItem): number => this.ratePerKg(i.variants[i.variants.length - 1]) ?? i.selected.sellingPrice;

    switch (this.sort) {
      case 'price-asc':
        list = [...list].sort((a, b) => price(a) - price(b));
        break;
      case 'price-desc':
        list = [...list].sort((a, b) => price(b) - price(a));
        break;
      case 'name':
        list = [...list].sort((a, b) => a.product.name.localeCompare(b.product.name));
        break;
    }

    return list;
  }

  /* ---------- Helpers used by the template ---------- */

  inStock(variant: ProductVariant): boolean {
    return Number(variant.inventory?.availableQuantity ?? 0) > 0;
  }

  weightLabel(variant: ProductVariant): string {
    return variant.name || (variant.weightGrams && variant.weightGrams >= 1000 ? `${variant.weightGrams / 1000}kg` : `${variant.weightGrams}g`);
  }

  /** Whole-rupee price per kilogram for a pack, or null for packs without a weight. */
  ratePerKg(variant: ProductVariant | undefined): number | null {
    const grams = Number(variant?.weightGrams ?? 0);
    return variant && grams > 0 ? Math.round((variant.sellingPrice * 1000) / grams) : null;
  }

  /** The per-kg rate shown on the card: that of the largest pack, which is the rate the owner sets. */
  headlineRate(item: CatalogItem): number | null {
    return this.ratePerKg(item.variants[item.variants.length - 1]);
  }

  stockNote(variant: ProductVariant): string {
    const available = Number(variant.inventory?.availableQuantity ?? 0);
    return available > 0 && available <= 5 ? `Only ${available} left` : '';
  }

  imageFor(item: CatalogItem): string {
    return item.product.imageUrl || 'assets/hero-image.webp';
  }

  select(item: CatalogItem, variant: ProductVariant): void {
    item.selected = variant;
  }

  add(item: CatalogItem): void {
    if (!this.inStock(item.selected)) {
      return;
    }

    this.cartService.addToCart({ product: item.product, variant: item.selected, quantity: 1 });

    this.added[item.product.id] = true;
    setTimeout(() => (this.added[item.product.id] = false), 1600);
  }

  trackItem(_: number, item: CatalogItem): string {
    return item.product.id;
  }

  clearFilters(): void {
    this.activeFamily = 'all';
    this.search = '';
  }
}
