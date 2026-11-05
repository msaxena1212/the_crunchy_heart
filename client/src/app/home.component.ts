
import {
  AfterViewInit,
  Component,
  OnDestroy,
  OnInit,
  inject
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

import {
  CartItem,
  CartService
} from './cart.service';

import { Product } from './product.model';
import { ProductService } from './product.service';

import { Subject, takeUntil } from 'rxjs';

interface SocialItem {
  image: string;
  alt: string;
  title: string;
}

interface InstagramItem {
  image: string;
  alt: string;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink
  ],
  templateUrl: './app.component.html'
})
export class HomeComponent
  implements OnInit, AfterViewInit, OnDestroy {

  /* =========================================================
     SERVICES
     ========================================================= */

  private readonly productService = inject(ProductService);
  private readonly cartService = inject(CartService);
  private readonly destroy$ = new Subject<void>();

  /* =========================================================
     GENERAL
     ========================================================= */

  currentYear = new Date().getFullYear();

  /* =========================================================
     PRODUCT STATE
     ========================================================= */

  products: Product[] = [];
  rawProducts: Product[] = [];
  flavourProducts: Product[] = [];

  loading = true;
  error = '';

  /* =========================================================
     CART AND NAVIGATION STATE
     ========================================================= */

  cartItems: CartItem[] = [];
  cartCount = 0;
  cartOpen = false;
  mobileMenuOpen = false;

  /* =========================================================
     IMAGES
     ========================================================= */

  readonly heroImage = 'assets/hero-image.png';
  readonly everydayImage = 'assets/everyday-crunch.png';
  readonly storyImage = 'assets/our-story.png';

  /* =========================================================
     PRODUCT IMAGES
     ========================================================= */

  readonly productImages: Record<string, string> = {
    'TCH-RAW-100': 'assets/raw-makhana-100g.png',
    'TCH-RAW-200': 'assets/raw-makhana-200g.png',
    'TCH-RAW-500': 'assets/raw-makhana-500g.png',
    'TCH-RAW-1KG': 'assets/raw-makhana-1kg.png',

    'TCH-FLV-HIMALAYAN': 'assets/himalayan-salt.png',
    'TCH-FLV-PERI': 'assets/peri-peri.png',
    'TCH-FLV-ONION': 'assets/cream-onion.png',
    'TCH-FLV-TOMATO': 'assets/tomato-tangy.png',
    'TCH-FLV-CHILLI': 'assets/chilli-garlic.png',
    'TCH-FLV-PUDINA': 'assets/pudina.png',
    'TCH-FLV-BIHARI': 'assets/bihari-chat.png'
  };

  /* =========================================================
     SOCIAL CONTENT
     ========================================================= */

  readonly socialImages: SocialItem[] = [
    {
      image: 'assets/social-weekend-morning.png',
      alt: 'The Crunchy Heart weekend morning',
      title: 'Weekend crunch'
    },
    {
      image: 'assets/social-evening-chai.png',
      alt: 'The Crunchy Heart evening chai',
      title: 'That perfect crunch'
    },
    {
      image: 'assets/social-reading.png',
      alt: 'The Crunchy Heart reading snack',
      title: 'Snack smarter'
    },
    {
      image: 'assets/social-movie-night.png',
      alt: 'The Crunchy Heart movie night',
      title: 'Movie night crunch'
    },
    {
      image: 'assets/social-friends-sharing.png',
      alt: 'Friends sharing The Crunchy Heart makhana',
      title: 'Better together'
    },
    {
      image: 'assets/social-work-break.png',
      alt: 'The Crunchy Heart work break',
      title: 'Crunch on the go'
    }
  ];

  /* =========================================================
     INSTAGRAM CONTENT
     ========================================================= */

  readonly instagramImages: InstagramItem[] = [
    {
      image: 'assets/instagram-product.png',
      alt: 'The Crunchy Heart product'
    },
    {
      image: 'assets/instagram-macro.png',
      alt: 'The Crunchy Heart makhana close-up'
    },
    {
      image: 'assets/instagram-ingredient.png',
      alt: 'The Crunchy Heart ingredients'
    },
    {
      image: 'assets/instagram-flavours.png',
      alt: 'The Crunchy Heart flavours'
    },
    {
      image: 'assets/instagram-packaging.png',
      alt: 'The Crunchy Heart packaging'
    },
    {
      image: 'assets/instagram-brand-mood.png',
      alt: 'The Crunchy Heart brand mood'
    }
  ];

  /* =========================================================
     CAROUSEL
     ========================================================= */

  private readonly carouselAmount = 330;

  /* =========================================================
     SECTION OBSERVER
     ========================================================= */

  private sectionObserver: IntersectionObserver | null = null;

  /* =========================================================
     CONSTRUCTOR
     ========================================================= */

  constructor() {
    this.cartService.cart$
      .pipe(takeUntil(this.destroy$))
      .subscribe((items: CartItem[]) => {
        this.cartItems = items;

        this.cartCount = items.reduce(
          (total, item) => total + item.quantity,
          0
        );
      });
  }

  /* =========================================================
     INIT
     ========================================================= */

  ngOnInit(): void {
    this.loadProducts();
  }

  /* =========================================================
     DESTROY / CLEANUP
     ========================================================= */

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();

    this.sectionObserver?.disconnect();
    this.sectionObserver = null;
  }

  /* =========================================================
     LOAD PRODUCTS
     ========================================================= */

  private loadProducts(): void {
    this.loading = true;
    this.error = '';

    this.productService
      .getProducts()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (products: Product[]) => {
          this.products = products;

          this.rawProducts = products.filter(
            product => product.category?.slug === 'raw-makhana'
          );

          this.flavourProducts = products.filter(
            product => product.category?.slug === 'flavoured-makhana'
          );

          this.loading = false;

          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              this.setupSectionReveal();
            });
          });
        },

        error: (err) => {
          console.error('Failed to load products:', err);

          this.products = [];
          this.rawProducts = [];
          this.flavourProducts = [];

          this.error =
            'We could not load our products right now. Please try again.';

          this.loading = false;

          requestAnimationFrame(() => {
            this.setupSectionReveal();
          });
        }
      });
  }

  /* =========================================================
     NAVIGATION
     ========================================================= */

  scrollTo(id: string): void {
    this.closeMobileMenu();

    const element = document.getElementById(id);

    if (!element) {
      return;
    }

    element.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  toggleMobileMenu(): void {
    this.mobileMenuOpen = !this.mobileMenuOpen;
  }

  closeMobileMenu(): void {
    this.mobileMenuOpen = false;
  }

  onNavigationKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.mobileMenuOpen) {
      this.closeMobileMenu();
    }
  }

  /* =========================================================
     PRODUCT TRACKING
     ========================================================= */

  trackByProduct(index: number, product: Product): string {
    return product.variant?.sku || product.id || String(index);
  }

  /* =========================================================
     PRODUCT IMAGE
     ========================================================= */

  productImage(product: Product): string {
    return (
      this.productImages[product.variant?.sku ?? ''] ||
      'assets/hero-image.png'
    );
  }

  rawProductImage(product: Product): string {
    return this.productImage(product);
  }

  /* =========================================================
     FLAVOUR NAME
     ========================================================= */

  getFlavorName(product: Product): string {
    return (
      product.variant?.flavor ||
      product.variant?.name ||
      'Makhana'
    );
  }

  /* =========================================================
     WEIGHT
     ========================================================= */

  formatWeight(product: Product): string {
    const grams = product.variant?.weightGrams;

    if (!grams) {
      return '';
    }

    if (grams >= 1000) {
      return `${grams / 1000}kg`;
    }

    return `${grams}g`;
  }

  /* =========================================================
     PRICE
     ========================================================= */

  getPrice(product: Product): number | null {
    const price = Number(product.variant?.sellingPrice ?? 0);

    return price > 0 ? price : null;
  }

  /* =========================================================
     AVAILABILITY
     ========================================================= */

  isAvailable(product: Product): boolean {
    return (
      Number(
        product.variant?.inventory?.availableQuantity ?? 0
      ) > 0
    );
  }

  /* =========================================================
     ADD TO CART
     ========================================================= */

  addToCart(product?: Product): void {
    if (!product || !this.isAvailable(product)) {
      return;
    }

    this.cartService.addProduct(product);
  }

  /* =========================================================
     CART ACTIONS
     ========================================================= */

  increaseQuantity(item: CartItem): void {
    this.cartService.increaseQuantity(item.variantId);
  }

  decreaseQuantity(item: CartItem): void {
    this.cartService.decreaseQuantity(item.variantId);
  }

  removeFromCart(item: CartItem): void {
    this.cartService.removeItem(item.variantId);
  }

  clearCart(): void {
    this.cartService.clearCart();
  }

  toggleCart(): void {
    this.cartOpen = !this.cartOpen;
  }

  closeCart(): void {
    this.cartOpen = false;
  }

  getCartSubtotal(): number {
    return this.cartItems.reduce(
      (total, item) => total + item.unitPrice * item.quantity,
      0
    );
  }

  /* =========================================================
     CART TRACKING
     ========================================================= */

  trackByCartItem(index: number, item: CartItem): string {
    return item.variantId || item.sku || String(index);
  }

  /* =========================================================
     SOCIAL TRACKING
     ========================================================= */

  trackBySocial(index: number, social: SocialItem): string {
    return social.image || String(index);
  }

  /* =========================================================
     INSTAGRAM TRACKING
     ========================================================= */

  trackByInstagram(index: number, item: InstagramItem): string {
    return item.image || String(index);
  }

  /* =========================================================
     IMAGE ERROR HANDLING
     ========================================================= */

  handleImageError(event: Event): void {
    const image = event.target as HTMLImageElement | null;

    if (!image || image.dataset['fallbackApplied']) {
      return;
    }

    image.dataset['fallbackApplied'] = 'true';
    image.src = 'assets/hero-image.png';
  }

  /* =========================================================
     CAROUSEL
     ========================================================= */

  scrollCarousel(
    target: string | HTMLElement,
    direction: 'left' | 'right'
  ): void {
    let element: HTMLElement | null = null;

    if (typeof target === 'string') {
      element = document.getElementById(target);

      if (!element) {
        element = document.querySelector<HTMLElement>(`.${target}`);
      }
    } else {
      element = target;
    }

    if (!element) {
      return;
    }

    element.scrollBy({
      left: direction === 'left'
        ? -this.carouselAmount
        : this.carouselAmount,
      behavior: 'smooth'
    });
  }

  /* =========================================================
     SECTION ANIMATION
     ========================================================= */

  ngAfterViewInit(): void {
    requestAnimationFrame(() => {
      this.setupSectionReveal();
    });
  }

  /* =========================================================
     SECTION REVEAL SETUP
     ========================================================= */

  private setupSectionReveal(): void {
    this.sectionObserver?.disconnect();
    this.sectionObserver = null;

    const sections = Array.from(
      document.querySelectorAll<HTMLElement>('main > section')
    );

    if (!sections.length) {
      return;
    }

    sections.forEach((section, index) => {
      section.classList.add('reveal-section');

      section.style.setProperty(
        '--reveal-delay',
        `${Math.min(index * 35, 180)}ms`
      );
    });

    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      sections.forEach(section => {
        section.classList.add('is-visible');
      });

      return;
    }

    this.sectionObserver = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            this.sectionObserver?.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.10,
        rootMargin: '0px 0px -50px 0px'
      }
    );

    sections.forEach(section => {
      this.sectionObserver?.observe(section);
    });
  }
}
