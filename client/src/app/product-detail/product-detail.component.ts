
import { DOCUMENT, CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  OnInit,
  inject,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ProductService } from '../product.service';
import { Product, ProductVariant } from '../product.model';
import { CartService } from '../cart.service';

@Component({
  selector: 'app-product-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './product-detail.component.html',
  styleUrl: './product-detail.component.css',
})
export class ProductDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly productService = inject(ProductService);
  private readonly cartService = inject(CartService);
  private readonly titleService = inject(Title);
  private readonly metaService = inject(Meta);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  product: Product | null = null;
  selectedVariant: ProductVariant | null = null;

  loading = true;
  error = '';
  quantity = 1;
  addedToCart = false;

  private jsonLdScript: HTMLScriptElement | null = null;
  private canonicalLink: HTMLLinkElement | null = null;

  private readonly defaultTitle =
    'Premium Makhana | The Crunchy Heart';

  private readonly defaultDescription =
    'Discover premium raw and flavoured makhana from The Crunchy Heart. Thoughtfully packed for your everyday snacking moments.';

  ngOnInit(): void {
    this.setBasicMetadata();

    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(params => {
        const slug = params.get('slug');

        this.product = null;
        this.selectedVariant = null;
        this.addedToCart = false;
        this.quantity = 1;

        if (!slug) {
          this.loading = false;
          this.error = 'Product not found.';
          this.setBasicMetadata();
          this.removeProductStructuredData();
          return;
        }

        this.loadProduct(slug);
      });
  }

  private loadProduct(slug: string): void {
    this.loading = true;
    this.error = '';

    this.productService
      .getProductBySlug(slug)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: product => {
          this.product = product;
          this.selectedVariant =
            product.variant ?? product.variants?.[0] ?? null;

          this.loading = false;

          this.updateProductMetadata();
        },
        error: (error: HttpErrorResponse) => {
          console.error('Product detail error:', error);

          this.product = null;
          this.selectedVariant = null;
          this.loading = false;

          this.error =
            error.status === 404
              ? 'This product could not be found.'
              : 'We could not load this product right now. Please try again.';

          this.setBasicMetadata();
          this.removeProductStructuredData();
        },
      });
  }

  selectVariant(variant: ProductVariant): void {
    this.selectedVariant = variant;
    this.quantity = 1;
    this.addedToCart = false;

    this.updateProductMetadata();
  }

  increaseQuantity(): void {
    const available =
      this.selectedVariant?.inventory?.availableQuantity ?? 0;

    if (this.quantity < available) {
      this.quantity++;
    }
  }

  decreaseQuantity(): void {
    if (this.quantity > 1) {
      this.quantity--;
    }
  }

  get availableQuantity(): number {
    return this.selectedVariant?.inventory?.availableQuantity ?? 0;
  }

  get isAvailable(): boolean {
    return this.availableQuantity > 0;
  }

  get selectedPrice(): number {
    return Number(this.selectedVariant?.sellingPrice ?? 0);
  }

  get discountPercent(): number {
    const mrp = Number(this.selectedVariant?.mrp ?? 0);
    const price = this.selectedPrice;

    return mrp > price && price > 0
      ? Math.round(((mrp - price) / mrp) * 100)
      : 0;
  }

  get lowStockNote(): string {
    const available = this.availableQuantity;

    return available > 0 && available <= 10
      ? `Only ${available} left in stock`
      : '';
  }

  /** Rate per kilogram for weight-priced items (dry fruits, spices); null otherwise. */
  get pricePerKg(): number | null {
    const grams = Number(this.selectedVariant?.weightGrams ?? 0);
    const category = this.product?.category?.slug;

    if (!grams || (category !== 'dry-fruits' && category !== 'spices')) {
      return null;
    }

    return Math.round((this.selectedPrice * 1000) / grams);
  }

  get selectedImage(): string {
    // A product image set in the owner console always wins over the built-in SKU mapping.
    if (this.product?.imageUrl) {
      return this.product.imageUrl;
    }

    const sku = this.selectedVariant?.sku ?? '';

    const imageMap: Record<string, string> = {
      'TCH-RAW-100': 'assets/raw-makhana-100g.webp',
      'TCH-RAW-200': 'assets/raw-makhana-200g.webp',
      'TCH-RAW-500': 'assets/raw-makhana-500g.webp',
      'TCH-RAW-1KG': 'assets/raw-makhana-1kg.webp',

      'TCH-FLV-HIMALAYAN': 'assets/himalayan-salt.webp',
      'TCH-FLV-PERI': 'assets/peri-peri.webp',
      'TCH-FLV-PUDINA': 'assets/pudina.webp',
      'TCH-FLV-ONION': 'assets/cream-onion.webp',
      'TCH-FLV-TOMATO': 'assets/tomato-tangy.webp',
      'TCH-FLV-CHILLI': 'assets/chilli-garlic.webp',
      'TCH-FLV-BIHARI': 'assets/bihari-chat.webp',
      'TCH-FLV-CHEESE': 'assets/cheese-herbs.webp',
      'TCH-GIFT-ALL8': 'assets/festive-box.webp',
      'TCH-GIFT-4PACK': 'assets/festive-box.webp',
      'TCH-BLK-5KG': 'assets/bulk-makhana.webp',
      'TCH-BLK-10KG': 'assets/bulk-makhana.webp',
      'TCH-BLK-5S-5KG': 'assets/bulk-makhana.webp',
      'TCH-BLK-5S-10KG': 'assets/bulk-makhana.webp',
      'TCH-BLK-6S-5KG': 'assets/bulk-makhana.webp',
      'TCH-BLK-6S-10KG': 'assets/bulk-makhana.webp',
      'TCH-BLK-7S-5KG': 'assets/bulk-makhana.webp',
      'TCH-BLK-7S-10KG': 'assets/bulk-makhana.webp',
    };

    if (imageMap[sku]) {
      return imageMap[sku];
    }
    if (sku.startsWith('TCH-BLK')) {
      return 'assets/bulk-makhana.webp';
    }
    if (sku.startsWith('TCH-GIFT')) {
      return 'assets/festive-box.webp';
    }

    return 'assets/raw-makhana-100g.webp';
  }

  get variantLabel(): string {
    if (!this.selectedVariant) {
      return '';
    }

    if (this.selectedVariant.name) {
      return this.selectedVariant.name;
    }

    if (this.selectedVariant.flavor) {
      return this.selectedVariant.flavor;
    }

    if (this.selectedVariant.weightGrams) {
      if (this.selectedVariant.weightGrams >= 1000) {
        return `${this.selectedVariant.weightGrams / 1000}kg`;
      }
      return `${this.selectedVariant.weightGrams}g`;
    }

    return '';
  }

  addToCart(): void {
    if (!this.product || !this.selectedVariant || !this.isAvailable) {
      return;
    }

    this.cartService.addToCart({
      product: this.product,
      variant: this.selectedVariant,
      quantity: this.quantity,
    });

    this.addedToCart = true;
  }

  buyNow(): void {
    this.addToCart();

    if (this.addedToCart) {
      void this.router.navigate(['/cart']);
    }
  }

  private setBasicMetadata(): void {
    this.titleService.setTitle(this.defaultTitle);

    this.metaService.updateTag({
      name: 'description',
      content: this.defaultDescription,
    });

    this.metaService.updateTag({
      name: 'robots',
      content: 'index, follow',
    });

    this.metaService.updateTag({
      property: 'og:type',
      content: 'website',
    });

    this.metaService.updateTag({
      property: 'og:site_name',
      content: 'The Crunchy Heart',
    });

    this.metaService.updateTag({
      property: 'og:title',
      content: this.defaultTitle,
    });

    this.metaService.updateTag({
      property: 'og:description',
      content: this.defaultDescription,
    });
  }

  private updateProductMetadata(): void {
    const product = this.product;

    if (!product) {
      return;
    }

    const variant = this.selectedVariant;
    const label = variant ? this.getVariantLabel(variant) : '';
    const productTitle = label
      ? `${product.name} ${label} | The Crunchy Heart`
      : `${product.name} | The Crunchy Heart`;

    const description = this.cleanText(
      product.shortDescription ||
      product.description ||
      `${product.name} from The Crunchy Heart. Discover thoughtfully packed makhana for everyday snacking.`,
    ).slice(0, 300);

    const canonicalUrl = this.getCanonicalUrl();

    this.titleService.setTitle(productTitle);

    this.metaService.updateTag({
      name: 'description',
      content: description,
    });

    this.metaService.updateTag({
      name: 'robots',
      content: 'index, follow',
    });

    this.metaService.updateTag({
      property: 'og:type',
      content: 'product',
    });

    this.metaService.updateTag({
      property: 'og:site_name',
      content: 'The Crunchy Heart',
    });

    this.metaService.updateTag({
      property: 'og:title',
      content: productTitle,
    });

    this.metaService.updateTag({
      property: 'og:description',
      content: description,
    });

    this.metaService.updateTag({
      property: 'og:url',
      content: canonicalUrl,
    });

    this.metaService.updateTag({
      property: 'og:image',
      content: this.getAbsoluteImageUrl(),
    });

    this.metaService.updateTag({
      name: 'twitter:card',
      content: 'summary_large_image',
    });

    this.metaService.updateTag({
      name: 'twitter:title',
      content: productTitle,
    });

    this.metaService.updateTag({
      name: 'twitter:description',
      content: description,
    });

    this.updateCanonicalLink(canonicalUrl);
    this.updateProductStructuredData(product, variant, description, canonicalUrl);
  }

  private updateProductStructuredData(
    product: Product,
    variant: ProductVariant | null,
    description: string,
    canonicalUrl: string,
  ): void {
    const productUrl = canonicalUrl;
    const imageUrl = this.getAbsoluteImageUrl();
    const available =
      (variant?.inventory?.availableQuantity ?? 0) > 0;

    const data: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      description,
      image: [imageUrl],
      url: productUrl,
      brand: {
        '@type': 'Brand',
        name: product.brand || 'The Crunchy Heart',
      },
      category: product.category?.name,
    };

    if (variant) {
      data['sku'] = variant.sku;

      data['offers'] = {
        '@type': 'Offer',
        url: productUrl,
        priceCurrency: 'INR',
        price: Number(variant.sellingPrice).toFixed(2),
        availability: available
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock',
        itemCondition: 'https://schema.org/NewCondition',
      };
    }

    this.upsertProductJsonLd(data);
  }

  private upsertProductJsonLd(data: Record<string, unknown>): void {
    if (!this.document?.head) {
      return;
    }

    if (!this.jsonLdScript) {
      const existing = this.document.head.querySelector(
        'script[data-tch-product-jsonld]',
      ) as HTMLScriptElement | null;

      this.jsonLdScript = existing ?? this.document.createElement('script');

      this.jsonLdScript.type = 'application/ld+json';
      this.jsonLdScript.setAttribute('data-tch-product-jsonld', 'true');

      if (!existing) {
        this.document.head.appendChild(this.jsonLdScript);
      }
    }

    this.jsonLdScript.textContent = JSON.stringify(data);
  }

  private removeProductStructuredData(): void {
    if (!this.document?.head) {
      return;
    }

    const existing =
      this.jsonLdScript ??
      (this.document.head.querySelector(
        'script[data-tch-product-jsonld]',
      ) as HTMLScriptElement | null);

    existing?.remove();
    this.jsonLdScript = null;
  }

  private updateCanonicalLink(url: string): void {
    if (!this.document?.head) {
      return;
    }

    this.canonicalLink =
      this.document.head.querySelector(
        'link[rel="canonical"]',
      ) as HTMLLinkElement | null;

    if (!this.canonicalLink) {
      this.canonicalLink = this.document.createElement('link');
      this.canonicalLink.rel = 'canonical';
      this.document.head.appendChild(this.canonicalLink);
    }

    this.canonicalLink.href = url;
  }

  private getCanonicalUrl(): string {
    const base = this.document?.baseURI || 'https://thecrunchyheart.com';

    try {
      const baseUrl = new URL(base);
      const path = `/product/${encodeURIComponent(
        this.product?.slug ?? '',
      )}`;

      return new URL(path, baseUrl.origin).toString();
    } catch {
      return `https://thecrunchyheart.com/product/${encodeURIComponent(this.product?.slug ?? '')}`;
    }
  }

  private getAbsoluteImageUrl(): string {
    const imagePath = this.selectedImage;
    const base = this.document?.baseURI || 'https://thecrunchyheart.com';

    try {
      return new URL(imagePath, base).toString();
    } catch {
      return imagePath;
    }
  }

  private getVariantLabel(variant: ProductVariant): string {
    if (variant.weightGrams) {
      return `${variant.weightGrams}g`;
    }

    return variant.flavor ?? variant.name;
  }

  private cleanText(value: string): string {
    return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
