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
  spices: {
    name: 'Spices',
    tagline: 'Whole and ground, freshly packed',
    blurb: 'Whole and ground spices packed to keep their aroma and flavour. Choose from 100g to 1kg packs, all priced from a per-kg rate.',
    banner: 'assets/categories/spices.webp',
    icon: '🌶️',
    perKg: true
  }
};

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
    if (this.slug && this.slug !== 'all') {
      options.category = this.slug;
    }

    this.productService
      .getProducts(options)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: rows => {
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
      const sub = item.product.subcategory;
      if (!sub) {
        continue;
      }
      const entry = map.get(sub.slug) ?? { slug: sub.slug, name: sub.name, count: 0 };
      entry.count++;
      map.set(sub.slug, entry);
    }

    return Array.from(map.values());
  }

  get visibleItems(): CatalogItem[] {
    const term = this.search.trim().toLowerCase();

    let list = this.items.filter(item => {
      const familyOk = this.activeFamily === 'all' || item.product.subcategory?.slug === this.activeFamily;
      const searchOk =
        !term ||
        item.product.name.toLowerCase().includes(term) ||
        (item.product.shortDescription ?? '').toLowerCase().includes(term) ||
        (item.product.subcategory?.name ?? '').toLowerCase().includes(term);
      return familyOk && searchOk;
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
