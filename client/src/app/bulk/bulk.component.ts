import { CommonModule } from '@angular/common';
import { isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  inject
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';

import {
  BULK_MOQ_KG,
  BULK_WHATSAPP_NUMBER,
  BulkQuality,
  QUALITY_OPTIONS,
  SUTA_GUIDES,
  SutaGrade,
  SutaGuide,
  handpickedPremium
} from './bulk.data';
import type { MakhanaScene } from './makhana-scene';

interface BulkFaq {
  q: string;
  a: string;
}

@Component({
  selector: 'app-bulk',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './bulk.component.html',
  styleUrl: './bulk.component.css'
})
export class BulkComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly zone = inject(NgZone);
  private readonly platformId = inject(PLATFORM_ID);

  @ViewChild('heroCanvas') private heroCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('viewerCanvas') private viewerCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('viewerEl') private viewerEl?: ElementRef<HTMLElement>;
  @ViewChild('hostAside') private hostAside?: ElementRef<HTMLElement>;
  @ViewChild('hostSteps') private hostSteps?: ElementRef<HTMLElement>;

  /** 3D state. Both scenes fall back to the static image when WebGL is unavailable. */
  heroReady = false;
  viewerReady = false;
  viewerFailed = false;

  private heroScene?: MakhanaScene;
  private viewerScene?: MakhanaScene;
  private mediaQuery?: MediaQueryList;
  private revealObserver?: IntersectionObserver;
  private lastScrollY = 0;
  private readonly onMediaChange = (): void => this.placeViewer();
  private readonly onScroll = (): void => {
    const y = window.scrollY;
    this.heroScene?.nudge((y - this.lastScrollY) * 0.0012);
    this.lastScrollY = y;
  };

  readonly moqKg = BULK_MOQ_KG;
  readonly guides = SUTA_GUIDES;
  readonly qualities = QUALITY_OPTIONS;
  readonly quantityPresets = [100, 250, 500, 1000, 2500];

  /** Step 1 - nut size. */
  selectedGrade: SutaGrade = '6';
  /** Step 2 - quality, chosen after the size so it can show size-specific detail. */
  selectedQuality: BulkQuality = 'normal';
  /** Step 3 - quantity. */
  quantityKg = BULK_MOQ_KG;

  openFaq: number | null = 0;

  readonly stats = [
    { value: '100 kg', label: 'Minimum order' },
    { value: '4 sizes', label: '4 to 7 Suta' },
    { value: 'PAN-India', label: 'Freight & delivery' },
    { value: 'COA + GST', label: 'Lab report & invoice' }
  ];

  readonly audiences = [
    {
      icon: '🥨',
      title: 'Namkeen & snack makers',
      text: 'Consistent micro blossoms for mixtures, premixes and roasted snack lines.',
      grade: '4' as SutaGrade
    },
    {
      icon: '🍮',
      title: 'Sweet shops & caterers',
      text: 'Economical, high-count makhana for kheer, laddoos and festive menus.',
      grade: '5' as SutaGrade
    },
    {
      icon: '🛍️',
      title: 'Retailers & D2C brands',
      text: 'Export-grade jumbo makhana that looks great in your own branded packs.',
      grade: '6' as SutaGrade
    },
    {
      icon: '🏨',
      title: 'Hotels & gifting',
      text: 'Giant king blossoms for hospitality, wedding hampers and bespoke export.',
      grade: '7' as SutaGrade
    }
  ];

  readonly steps = [
    { title: 'Share your need', text: 'Pick size, quality and quantity and send it on WhatsApp.' },
    { title: 'Get your quote', text: 'We reply with a GST proforma invoice and freight to your pincode.' },
    { title: 'Approve a sample', text: 'Optional lab COA report and a sample pack before you commit.' },
    { title: 'We dispatch', text: 'Packed in barrier bags inside export cartons, shipped across India.' }
  ];

  readonly faqs: BulkFaq[] = [
    {
      q: 'What is a "Suta" and how do I choose?',
      a: 'Suta is the traditional Mithila grading of popped makhana by size. A higher number means a bigger, rarer blossom. Pick 4 or 5 Suta for processing and value, 6 Suta for retail and gifting, and 7 Suta for premium hospitality.'
    },
    {
      q: 'What is the difference between Normal and Handpicked?',
      a: 'Normal is machine sieved and graded. Handpicked is double hand-sorted after grading, which removes every black kernel and hard unpopped shell and keeps only the whitest blossoms.'
    },
    {
      q: 'What is the minimum order quantity?',
      a: 'The minimum order is 100 kg across all sizes and qualities. Prices improve for larger lots, so mention your monthly volume when you send the enquiry.'
    },
    {
      q: 'Are the rates final?',
      a: 'The rates shown are indicative per kg, excluding GST and freight. A formal proforma invoice with GST and freight to your delivery pincode is shared on WhatsApp before you pay.'
    },
    {
      q: 'Can I get a sample or a lab report?',
      a: 'Yes. Ask for a sample pack and the laboratory COA report when you send your enquiry, and we will share both.'
    },
    {
      q: 'How is bulk makhana packed and shipped?',
      a: 'Food-grade, moisture-barrier bags inside master export cartons, shipped with PAN-India transport.'
    }
  ];

  ngOnInit(): void {
    this.title.setTitle('Bulk & Wholesale Makhana (4, 5, 6 & 7 Suta) | The Crunchy Heart');
    this.meta.updateTag({
      name: 'description',
      content:
        'Buy phool makhana in bulk direct from Mithila. Choose 4, 5, 6 or 7 Suta, Normal or Handpicked quality, from 100 kg. Instant WhatsApp quote with GST invoice and COA.'
    });
  }

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.setupReveal();

    this.mediaQuery = window.matchMedia('(max-width: 1100px)');
    this.mediaQuery.addEventListener('change', this.onMediaChange);
    this.placeViewer();

    // Let the page paint and become interactive before loading Three.js.
    setTimeout(() => void this.init3d(), 60);
  }

  ngOnDestroy(): void {
    this.title.setTitle('The Crunchy Heart | Premium Makhana');

    this.mediaQuery?.removeEventListener('change', this.onMediaChange);
    window.removeEventListener('scroll', this.onScroll);
    this.revealObserver?.disconnect();
    this.heroScene?.dispose();
    this.viewerScene?.dispose();
  }

  /* ---------- 3D ---------- */

  private async init3d(): Promise<void> {
    let mod: typeof import('./makhana-scene');

    try {
      mod = await import('./makhana-scene');
    } catch {
      this.zone.run(() => (this.viewerFailed = true));
      return;
    }

    const lowPower = mod.isLowPowerDevice();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The render loops run outside Angular so they do not trigger change detection every frame.
    this.zone.runOutsideAngular(() => {
      const viewer = this.viewerCanvas?.nativeElement;
      if (viewer) {
        try {
          this.viewerScene = new mod.MakhanaScene(viewer, { mode: 'pile', interactive: true, lowPower, reducedMotion });
          this.viewerScene.setGrade(this.selectedGrade);
          this.viewerScene.setQuality(this.selectedQuality);
          this.zone.run(() => (this.viewerReady = true));
        } catch {
          this.zone.run(() => (this.viewerFailed = true));
        }
      }

      const hero = this.heroCanvas?.nativeElement;
      if (hero) {
        try {
          this.heroScene = new mod.MakhanaScene(hero, { mode: 'lineup', interactive: true, lowPower, reducedMotion });
          this.zone.run(() => (this.heroReady = true));
          this.lastScrollY = window.scrollY;
          window.addEventListener('scroll', this.onScroll, { passive: true });
        } catch {
          // keep the static hero image
        }
      }
    });
  }

  /** One viewer, two homes: beside the summary on desktop, pinned above the steps on small screens. */
  private placeViewer(): void {
    const viewer = this.viewerEl?.nativeElement;
    const target = this.mediaQuery?.matches ? this.hostSteps?.nativeElement : this.hostAside?.nativeElement;

    if (viewer && target && viewer.parentElement !== target) {
      target.appendChild(viewer);
      this.viewerScene?.reattach();
    }
  }

  /** Fade sections in as they scroll into view; never leave them hidden if the observer misfires. */
  private setupReveal(): void {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('.bulk-reveal'));

    if (!targets.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    document.documentElement.classList.add('bulk-js-reveal');

    this.revealObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            this.revealObserver?.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );

    targets.forEach(el => this.revealObserver?.observe(el));

    setTimeout(() => targets.forEach(el => el.classList.add('in-view')), 4000);
  }

  /* ---------- Derived values ---------- */

  get guide(): SutaGuide {
    return this.guides.find(g => g.grade === this.selectedGrade) ?? this.guides[2];
  }

  get ratePerKg(): number {
    return this.guide.rates[this.selectedQuality];
  }

  get estimatedTotal(): number {
    return this.ratePerKg * this.quantityKg;
  }

  get qualityLabel(): string {
    return this.selectedQuality === 'handpicked' ? 'Handpicked' : 'Normal';
  }

  get premium(): number {
    return handpickedPremium(this.guide);
  }

  get whatsAppQuoteUrl(): string {
    const qualityLabel =
      this.selectedQuality === 'handpicked'
        ? 'Handpicked (double-sorted, zero black spots)'
        : 'Normal (standard machine-graded)';

    const message =
      `Hello The Crunchy Heart B2B Desk!\n\n` +
      `I would like to request an official wholesale/bulk quote for:\n` +
      `• Nut Size: ${this.guide.name} (${this.guide.diameter})\n` +
      `• Quality: ${qualityLabel}\n` +
      `• Order Quantity: ${this.quantityKg} kg (MOQ: ${this.moqKg} kg)\n` +
      `• Indicated Price: ₹${this.ratePerKg}/kg\n` +
      `• Estimated Order Value: ₹${this.estimatedTotal.toLocaleString('en-IN')}\n\n` +
      `Please share a GST proforma invoice, lab COA report, dispatch lead time and freight to my delivery pincode.`;

    return `https://wa.me/${BULK_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  }

  get generalEnquiryUrl(): string {
    const message =
      'Hello The Crunchy Heart B2B Desk! I would like to discuss a bulk / wholesale makhana requirement.';
    return `https://wa.me/${BULK_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  }

  /* ---------- Actions ---------- */

  selectGrade(grade: SutaGrade, scrollToQuality = false): void {
    this.selectedGrade = grade;
    this.viewerScene?.setGrade(grade);

    if (scrollToQuality) {
      document.getElementById('bulk-configurator')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  selectQuality(quality: BulkQuality): void {
    this.selectedQuality = quality;
    this.viewerScene?.setQuality(quality);
  }

  setQuantity(qty: number): void {
    const value = Number(qty);
    this.quantityKg = Number.isFinite(value) ? Math.max(this.moqKg, Math.round(value)) : this.moqKg;
  }

  step(delta: number): void {
    this.setQuantity(this.quantityKg + delta);
  }

  toggleFaq(index: number): void {
    this.openFaq = this.openFaq === index ? null : index;
  }

  rateFor(guide: SutaGuide, quality: BulkQuality): number {
    return guide.rates[quality];
  }

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
