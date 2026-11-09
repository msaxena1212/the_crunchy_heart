
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
  festiveProducts: Product[] = [];
  bulkProducts: Product[] = [];

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
    'TCH-FLV-BIHARI': 'assets/bihari-chat.png',
    'TCH-FLV-CHEESE': 'assets/cheese-herbs.png',

    'TCH-GIFT-ALL8': 'assets/festive-box.png',
    'TCH-GIFT-4PACK': 'assets/festive-box.png',
    'TCH-BLK-5KG': 'assets/bulk-makhana.png',
    'TCH-BLK-10KG': 'assets/bulk-makhana.png',
    'TCH-BLK-5S-5KG': 'assets/bulk-makhana.png',
    'TCH-BLK-5S-10KG': 'assets/bulk-makhana.png',
    'TCH-BLK-6S-5KG': 'assets/bulk-makhana.png',
    'TCH-BLK-6S-10KG': 'assets/bulk-makhana.png',
    'TCH-BLK-7S-5KG': 'assets/bulk-makhana.png',
    'TCH-BLK-7S-10KG': 'assets/bulk-makhana.png'
  };

  /* =========================================================
     FESTIVE CUSTOM COMBO BUILDER (3x3 FORMAT, MAX 10 ITEMS)
     Milestones:
     - 4 to 6 items: 5% OFF
     - 7 to 9 items: 8% OFF
     - 10 items: 10% OFF (Max limit: 10 items)
     ========================================================= */

  readonly maxComboLimit = 10;
  comboCounts: Record<string, number> = {};
  comboToastMessage = '';
  private comboToastTimer: any = null;

  get totalComboCount(): number {
    return Object.values(this.comboCounts).reduce((sum, count) => sum + count, 0);
  }

  get comboDiscountPercent(): number {
    const count = this.totalComboCount;
    if (count >= 10) return 10;
    if (count >= 7) return 8;
    if (count >= 4) return 5;
    return 0;
  }

  get comboSubtotal(): number {
    let subtotal = 0;
    for (const [sku, count] of Object.entries(this.comboCounts)) {
      if (count <= 0) continue;
      const product = this.flavourProducts.find(p => p.variant?.sku === sku);
      const price = Number(product?.variant?.sellingPrice || 0);
      subtotal += price * count;
    }
    return subtotal;
  }

  get comboDiscountAmount(): number {
    const percent = this.comboDiscountPercent;
    if (percent <= 0) return 0;
    return Math.round(this.comboSubtotal * (percent / 100));
  }

  get comboFinalPrice(): number {
    return Math.max(0, this.comboSubtotal - this.comboDiscountAmount);
  }

  get comboProgressPercent(): number {
    return Math.min(100, Math.round((this.totalComboCount / this.maxComboLimit) * 100));
  }

  get comboNextMilestoneText(): string {
    const count = this.totalComboCount;
    if (count === 0) {
      return 'Add any 4 flavours to unlock 5% Festive Discount!';
    }
    if (count < 4) {
      const remaining = 4 - count;
      return `Add ${remaining} more pack${remaining > 1 ? 's' : ''} to unlock 5% Festive Discount!`;
    }
    if (count < 7) {
      const remaining = 7 - count;
      return `🎉 5% OFF unlocked! Add ${remaining} more to unlock 8% OFF!`;
    }
    if (count < 10) {
      const remaining = 10 - count;
      return `🌟 8% OFF unlocked! Add ${remaining} more to unlock the Grand 10% OFF!`;
    }
    return `👑 Grand 10% Festive Discount Unlocked! Hamper Box is at full capacity (10/10).`;
  }

  getComboItemCount(sku: string): number {
    return this.comboCounts[sku] || 0;
  }

  canAddMoreComboItems(): boolean {
    return this.totalComboCount < this.maxComboLimit;
  }

  addComboItem(product: Product): void {
    const sku = product.variant?.sku;
    if (!sku) return;
    if (this.totalComboCount >= this.maxComboLimit) {
      this.showComboToast('Maximum 10 items allowed in your custom festive gift box!');
      return;
    }
    this.comboCounts[sku] = (this.comboCounts[sku] || 0) + 1;
  }

  removeComboItem(product: Product): void {
    const sku = product.variant?.sku;
    if (!sku || !this.comboCounts[sku]) return;
    this.comboCounts[sku] -= 1;
    if (this.comboCounts[sku] <= 0) {
      delete this.comboCounts[sku];
    }
  }

  resetCombo(): void {
    this.comboCounts = {};
    this.showComboToast('Custom combo box cleared.');
  }

  addCustomComboToCart(): void {
    if (this.totalComboCount === 0) {
      this.showComboToast('Please add at least 1 flavour to your custom box.');
      return;
    }

    for (const [sku, count] of Object.entries(this.comboCounts)) {
      if (count <= 0) continue;
      const product = this.flavourProducts.find(p => p.variant?.sku === sku);
      if (product && product.variant) {
        this.cartService.addToCart({
          product,
          variant: product.variant,
          quantity: count
        });
      }
    }

    const discountMsg = this.comboDiscountPercent > 0
      ? ` with ${this.comboDiscountPercent}% festive discount applied!`
      : '!';
    this.showComboToast(`Added ${this.totalComboCount} custom hamper items to cart${discountMsg}`);
    this.cartOpen = true;
  }

  showComboToast(message: string): void {
    this.comboToastMessage = message;
    if (this.comboToastTimer) clearTimeout(this.comboToastTimer);
    this.comboToastTimer = setTimeout(() => {
      this.comboToastMessage = '';
    }, 4000);
  }

  /* =========================================================
     SUTA GRADE COMPARISON & UNIFIED BULK CONFIGURATOR
     Matching mukejamakhana.in: Single interactive configurator
     rather than dumping multiple repetitive cards upfront.
     ========================================================= */

  selectedBulkSuta: '5' | '6' | '7' = '6';
  selectedBulkWeightKg: 5 | 10 = 5;
  showSutaComparisonModal = false;
  activeSutaTab: string = 'all';

  readonly sutaGuides = [
    {
      grade: '5',
      name: '5 Suta Classic',
      diameter: '13 – 15 mm',
      tag: 'High-Yield Culinary',
      desc: 'Uniform medium-size popped lotus seeds. Highest blossom count per kilogram, making it exceptionally economical for daily roasting, recipes & sweets.',
      bestFor: 'Daily snacks, Kheer, Curries, Namkeen & sweet makers',
      seedsPerKg: '~14,000 – 16,000 seeds',
      popRatio: '95%+',
      badge: 'High-Yield Value',
      accentColor: '#9a6039',
      startingPrice: '₹769/kg'
    },
    {
      grade: '6',
      name: '6 Suta Jumbo Export',
      diameter: '16 – 18 mm',
      tag: '★ Most Popular B2B & Retail',
      desc: 'The gold standard of Mithila makhana. Export-grade jumbo diameter, cloud-like airy puff, snow-white appearance, and zero bitter black kernels.',
      bestFor: 'Gourmet D2C retail, luxury gifting hampers, party snacking',
      seedsPerKg: '~10,000 – 12,000 seeds',
      popRatio: '98%+ Export Grade',
      badge: '★ Best Seller',
      accentColor: '#d4af37',
      startingPrice: '₹949/kg'
    },
    {
      grade: '7',
      name: '7 Suta Royal King',
      diameter: '20 – 24 mm+',
      tag: '👑 Royal Reserve • Top 2% Harvest',
      desc: 'Giant hand-selected king blossoms from deep wetlands of Darbhanga. The largest makhana grade in India with breathtaking visual size and unmatched crispness.',
      bestFor: '5-Star hospitality, Royal wedding hampers, Bespoke export',
      seedsPerKg: '~6,500 – 8,000 seeds',
      popRatio: '99% Supreme Giant',
      badge: '👑 Royal Reserve',
      accentColor: '#b8860b',
      startingPrice: '₹1,179/kg'
    }
  ];

  selectBulkSuta(grade: '5' | '6' | '7'): void {
    this.selectedBulkSuta = grade;
  }

  selectBulkWeight(weight: 5 | 10): void {
    this.selectedBulkWeightKg = weight;
  }

  toggleSutaComparisonModal(): void {
    this.showSutaComparisonModal = !this.showSutaComparisonModal;
  }

  getActiveBulkProduct(): Product | undefined {
    const targetSku = `TCH-BLK-${this.selectedBulkSuta}S-${this.selectedBulkWeightKg}KG`;
    const found = this.bulkProducts.find(p => p.variant?.sku === targetSku);
    if (found) return found;

    // Fallback: match by grade and weight in flavor or sku
    return this.bulkProducts.find(p => {
      const sku = p.variant?.sku ?? '';
      const grams = p.variant?.weightGrams ?? 0;
      return sku.includes(`${this.selectedBulkSuta}S`) && grams === this.selectedBulkWeightKg * 1000;
    }) || this.bulkProducts.find(p => {
      const grams = p.variant?.weightGrams ?? 0;
      return grams === this.selectedBulkWeightKg * 1000;
    }) || this.bulkProducts[0];
  }

  getActiveSutaGuide() {
    return this.sutaGuides.find(g => g.grade === this.selectedBulkSuta) || this.sutaGuides[1];
  }

  getActiveBulkPrice(): number {
    const prod = this.getActiveBulkProduct();
    return Number(prod?.variant?.sellingPrice || 0);
  }

  getActiveBulkMrp(): number {
    const prod = this.getActiveBulkProduct();
    return Number(prod?.variant?.mrp || 0);
  }

  getActiveBulkSavings(): number {
    const mrp = this.getActiveBulkMrp();
    const price = this.getActiveBulkPrice();
    return mrp > price ? mrp - price : 0;
  }

  getActiveBulkPerKg(): number {
    const price = this.getActiveBulkPrice();
    return Math.round(price / this.selectedBulkWeightKg);
  }

  getActiveBulkWhatsAppUrl(): string {
    const guide = this.getActiveSutaGuide();
    const price = this.getActiveBulkPrice();
    const text = encodeURIComponent(
      `Hello The Crunchy Heart Team! I am interested in wholesale/bulk supply for ${guide.name} (${this.selectedBulkWeightKg}kg bag @ ₹${price}). Please share your B2B rate card, bulk GST invoice details, and delivery timelines to my location.`
    );
    return `https://wa.me/919999999999?text=${text}`;
  }

  addActiveBulkToCart(): void {
    const prod = this.getActiveBulkProduct();
    if (prod && this.isAvailable(prod)) {
      this.addToCart(prod);
      this.cartOpen = true;
    }
  }

  filterSuta(grade: string): void {
    this.activeSutaTab = grade;
  }

  getFilteredBulkProducts(): Product[] {
    if (this.activeSutaTab === 'all') {
      return this.bulkProducts;
    }
    return this.bulkProducts.filter(p => {
      const sku = p.variant?.sku ?? '';
      const flavor = p.variant?.flavor ?? '';
      const name = p.variant?.name ?? '';
      return (
        sku.includes(`-${this.activeSutaTab}S-`) ||
        flavor.includes(`${this.activeSutaTab} Suta`) ||
        name.includes(`${this.activeSutaTab} Suta`)
      );
    });
  }

  getBulkWhatsAppInquiry(product: Product): string {
    const name = product.variant?.name || product.name;
    const price = product.variant?.sellingPrice ? `₹${product.variant.sellingPrice}` : '';
    const text = encodeURIComponent(
      `Hello The Crunchy Heart Team! I am interested in wholesale/bulk supply for "${name}" (${price}). Please share your B2B rate card, bulk GST invoice details, and delivery timelines to my location.`
    );
    return `https://wa.me/919999999999?text=${text}`;
  }

  /* =========================================================
     FLAVOUR MOOD SELECTOR
     ========================================================= */

  activeFlavourMood: 'all' | 'spicy' | 'creamy' | 'satvik' = 'all';

  filterMood(mood: 'all' | 'spicy' | 'creamy' | 'satvik'): void {
    this.activeFlavourMood = mood;
  }

  getFilteredFlavourProducts(): Product[] {
    if (this.activeFlavourMood === 'all') {
      return this.flavourProducts;
    }
    if (this.activeFlavourMood === 'spicy') {
      return this.flavourProducts.filter(p => {
        const f = (p.variant?.flavor || p.variant?.name || '').toLowerCase();
        return f.includes('peri') || f.includes('chilli') || f.includes('bihari');
      });
    }
    if (this.activeFlavourMood === 'creamy') {
      return this.flavourProducts.filter(p => {
        const f = (p.variant?.flavor || p.variant?.name || '').toLowerCase();
        return f.includes('cheese') || f.includes('cream');
      });
    }
    if (this.activeFlavourMood === 'satvik') {
      return this.flavourProducts.filter(p => {
        const f = (p.variant?.flavor || p.variant?.name || '').toLowerCase();
        return f.includes('salt') || f.includes('pudina') || f.includes('tomato');
      });
    }
    return this.flavourProducts;
  }

  /* =========================================================
     WHATSAPP & SUPPORT
     ========================================================= */

  readonly whatsappUrl = 'https://wa.me/919999999999?text=' + encodeURIComponent('Hi The Crunchy Heart! I would like to inquire about your premium makhana / bulk & festive gifting options.');

  /* =========================================================
     FAQ ACCORDION
     ========================================================= */

  faqs = [
    {
      q: 'What makes 6+ Suta Jumbo Makhana different from regular lotus seeds?',
      a: 'Suta is the authentic size-grading measurement in Mithilanchal (Bihar). 6+ Suta represents the highest export quality — jumbo in diameter, uniformly popped, and remarkably light and fluffy with almost zero bitter unpopped kernels.',
      open: true
    },
    {
      q: 'Where are The Crunchy Heart makhana seeds sourced from?',
      a: 'Every lotus seed is sourced directly from certified farmer collectives across the wetlands of Darbhanga and Madhubani in Bihar — India\'s GI-tagged capital of authentic Makhana production.',
      open: false
    },
    {
      q: 'Are your flavoured fox nuts fried or roasted?',
      a: '100% slow dry-roasted, never fried! We use zero palm oil, zero artificial colors, and no trans fats. You get full superfood nutrition and guilt-free crunch in every bite.',
      open: false
    },
    {
      q: 'Can I consume your Makhana during religious fasts (Vrat)?',
      a: 'Absolutely! Raw Makhana is a pure, satvik superfood revered for fasting during Navratri, Shivratri, and Ekadashi. For fasting cravings, we recommend our Raw Makhana varieties and Himalayan Pink Salt.',
      open: false
    },
    {
      q: 'How should I store Makhana to maintain peak crunchiness?',
      a: 'Keep the pouches sealed in a cool, dry place. In humid monsoon weather, you can easily revive maximum crispness by lightly tossing the seeds in a dry pan for 60 seconds.',
      open: false
    },
    {
      q: 'How fast is delivery and can I place bulk / corporate gifting orders?',
      a: 'Orders are dispatched within 24 hours and delivered across India in 2–4 business days. All orders above ₹499 enjoy free shipping. For bulk orders (5kg to 500kg+) or bespoke wedding/corporate gifting hampers, contact us directly via our WhatsApp button for custom quotes and packaging.',
      open: false
    }
  ];

  toggleFaq(index: number): void {
    if (this.faqs[index]) {
      this.faqs[index].open = !this.faqs[index].open;
    }
  }

  /* =========================================================
     CUSTOMER REVIEWS & SOCIAL PROOF
     ========================================================= */

  readonly reviews = [
    {
      name: 'Priya Sharma',
      city: 'Mumbai',
      rating: 5,
      tag: 'Verified Buyer',
      text: 'The Himalayan Salt and Cheese & Herbs are unbelievable! So much lighter and crunchier than grocery store brands. My evening chai routine is officially incomplete without it.',
      pack: 'All 8 Flavours Gift Set'
    },
    {
      name: 'Vikramaditya Roy',
      city: 'Bengaluru',
      rating: 5,
      tag: 'Fitness Enthusiast',
      text: 'As someone tracking macros, the jumbo 6+ Suta raw makhana is a game-changer. Almost zero unpopped hard seeds, clean taste, and fills you up with clean plant protein.',
      pack: 'Raw Makhana 1kg Pack'
    },
    {
      name: 'Ananya Deshmukh',
      city: 'Pune',
      rating: 5,
      tag: 'Wedding Gifting',
      text: 'Ordered 60 custom gift hampers for our family celebration. The team was super helpful on WhatsApp, and our guests loved having a healthy, crunchy alternative to traditional sweets!',
      pack: 'Celebration 4-Pack Hampers'
    },
    {
      name: 'Rohit Kulkarni',
      city: 'Delhi NCR',
      rating: 5,
      tag: 'Daily Snacker',
      text: 'The Peri Peri and Bihari Chat have the perfect kick without feeling greasy or overly salty. Love that it uses zero palm oil. You can taste the quality in every bite.',
      pack: 'Peri Peri & Bihari Chat'
    }
  ];

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

          this.festiveProducts = products.filter(
            product => product.category?.slug === 'festive-gifting'
          );

          this.bulkProducts = products.filter(
            product => product.category?.slug === 'bulk-wholesale'
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
    const sku = product.variant?.sku ?? '';
    if (this.productImages[sku]) {
      return this.productImages[sku];
    }
    if (sku.startsWith('TCH-BLK')) {
      return 'assets/bulk-makhana.png';
    }
    if (sku.startsWith('TCH-GIFT')) {
      return 'assets/festive-box.png';
    }
    return 'assets/hero-image.png';
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
