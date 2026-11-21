import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

interface PolicyPage { title: string; sections: { heading: string; body: string }[]; }

const CONTACT = 'WhatsApp +91 88005 37383';

// NOTE: draft policy text - have it reviewed by legal counsel before launch.
const POLICIES: Record<string, PolicyPage> = {
  privacy: {
    title: 'Privacy Policy',
    sections: [
      { heading: 'What we collect', body: 'Name, mobile number, email, delivery address and order details that you give us when you sign in or place an order. Payments are processed by Cashfree; we never see or store your card or UPI details.' },
      { heading: 'How we use it', body: 'To process and deliver orders, send order updates, provide support and prevent fraud. We do not sell your personal data.' },
      { heading: 'Sharing', body: 'Only with service providers needed to fulfil your order (payment gateway, courier, SMS/email providers) or when required by law.' },
      { heading: 'Your choices', body: `You can ask us to access, correct or delete your data at any time via ${CONTACT}.` },
    ],
  },
  terms: {
    title: 'Terms of Service',
    sections: [
      { heading: 'Orders', body: 'An order is confirmed once payment succeeds (online) or we confirm it (cash on delivery). We may cancel an order if an item is out of stock or an address is unserviceable, with a full refund.' },
      { heading: 'Prices', body: 'All prices are in INR and include applicable GST. Prices and availability may change without notice.' },
      { heading: 'Product information', body: 'Natural products vary slightly in size and colour. Images are illustrative.' },
      { heading: 'Contact', body: `Questions about these terms: ${CONTACT}.` },
    ],
  },
  shipping: {
    title: 'Shipping & Delivery',
    sections: [
      { heading: 'Charges', body: 'Free delivery on orders of ₹499 and above. Orders below ₹499 have a flat ₹149 shipping charge.' },
      { heading: 'Delivery time', body: 'Orders are dispatched within 1-2 business days. Delivery typically takes 3-7 business days depending on your location.' },
      { heading: 'Tracking', body: 'You can track your order from the Orders page using your order number.' },
    ],
  },
  refunds: {
    title: 'Returns & Refund Policy',
    sections: [
      { heading: 'Food safety', body: 'For hygiene reasons we cannot accept returns of opened or used food products.' },
      { heading: 'Damaged or wrong items', body: `If your order arrives damaged, leaking or incorrect, message us on ${CONTACT} within 48 hours of delivery with photos. We will replace it or refund you.` },
      { heading: 'Refund timing', body: 'Approved refunds go back to the original payment method within 5-7 business days. Cancelled prepaid orders are refunded in full.' },
    ],
  },
};

@Component({
  selector: 'app-policy',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="policy">
      @if (page(); as p) {
        <h1>{{ p.title }}</h1>
        @for (s of p.sections; track s.heading) {
          <h2>{{ s.heading }}</h2>
          <p>{{ s.body }}</p>
        }
      } @else {
        <h1>Page not found</h1>
      }
      <a routerLink="/shop">← Continue shopping</a>
    </main>
  `,
  styles: [`
    .policy { max-width: 760px; margin: 0 auto; padding: 48px 20px 72px; line-height: 1.7; }
    h1 { font-family: 'Playfair Display', serif; margin-bottom: 24px; }
    h2 { font-size: 1.1rem; margin: 24px 0 4px; }
    a { display: inline-block; margin-top: 32px; }
  `],
})
export class PolicyComponent {
  private route = inject(ActivatedRoute);
  private type = toSignal(this.route.paramMap.pipe(map(m => m.get('type') ?? '')), { initialValue: '' });
  page = computed(() => POLICIES[this.type()] ?? null);
}
