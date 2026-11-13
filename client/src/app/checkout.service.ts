import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { getApiBaseUrl } from './product.service';

export interface CheckoutPreviewRequest {
  items: Array<{
    variantId: string;
    quantity: number;
  }>;
}

export interface CheckoutPreviewResponse {
  success: boolean;
  currency: string;
  items: Array<{
    variantId: string;
    productId: string;
    productName: string;
    variantName: string;
    sku: string;
    quantity: number;
    unitPrice: number;
    grossAmount: number;
    taxableAmount: number;
    taxRate: number;
    taxAmount: number;
    availableQuantity: number;
  }>;
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  taxableAmount: number;
  taxAmount: number;
  taxRate: number;
  priceIncludesTax: boolean;
  totalAmount: number;
  coupon: any;
}

export interface OrderCustomer {
  name: string;
  phone: string;
  email?: string;
}

export interface OrderAddress {
  name: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export interface CreateOrderRequest {
  customer: OrderCustomer;
  shippingAddress: OrderAddress;
  billingAddress?: OrderAddress;
  items: Array<{
    variantId: string;
    quantity: number;
  }>;
  paymentMethod: 'ONLINE' | 'COD';
  notes?: string;
  idempotencyKey: string;
}

export interface CreateOrderResponse {
  success: boolean;
  existing?: boolean;
  order: {
    id: string;
    order_number: string;
    customer_name: string;
    phone: string;
    email: string | null;
    shipping_address: any;
    billing_address: any;
    subtotal: number;
    discount_amount: number;
    shipping_amount: number;
    tax_amount: number;
    total_amount: number;
    currency: string;
    status: string;
    payment_status: string;
    payment_method: string;
    tax_rate: number;
    price_includes_tax: boolean;
    created_at: string;
  };
  payment: any;
  items: any[];
  guestAccessToken: string;
  cashfree?: {
    orderId: string;
    cfOrderId: string | null;
    paymentSessionId: string;
    orderStatus: string | null;
  };
}

export interface OrderDetailsResponse {
  success: boolean;
  order: {
    id: string;
    orderNumber: string;
    customerName: string;
    phone: string;
    email: string | null;
    shippingAddress: OrderAddress;
    billingAddress?: OrderAddress;
    subtotal: number;
    discountAmount: number;
    shippingAmount: number;
    taxAmount: number;
    totalAmount: number;
    currency: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    notes?: string;
    createdAt: string;
    updatedAt: string;
  };
  items: Array<{
    id: string;
    variantId: string;
    productName: string;
    variantName: string;
    sku: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    taxableValue: number;
    taxRate: number;
    taxAmount: number;
  }>;
  payment: {
    id: string;
    provider: string;
    providerOrderId: string;
    providerPaymentId?: string;
    amount: number;
    currency: string;
    status: string;
    gatewayStatus: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  refund?: {
    id: string;
    amount: number;
    status: string;
    reason: string;
    createdAt: string;
  } | null;
  canRetry: boolean;
}

export interface RecoveryRequestResponse {
  success: boolean;
  message: string;
}

export interface RecoveryVerifyResponse {
  success: boolean;
  order: {
    order_number: string;
    status: string;
    payment_status: string;
    total_amount: number;
    created_at: string;
  };
  guestAccessToken: string;
}

export interface PaymentStatusResponse {
  success: boolean;
  orderId: string;
  orderNumber: string;
  status: string;
  latestAttempt: {
    providerOrderId: string;
    gatewayStatus: string;
    status: string;
    createdAt: string;
  } | null;
  attempts: Array<{
    providerOrderId: string;
    gatewayStatus: string;
    status: string;
    createdAt: string;
  }>;
  payments: any[];
}

@Injectable({
  providedIn: 'root'
})
export class CheckoutService {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly api = getApiBaseUrl();

  private sdkLoadPromise: Promise<any> | null = null;

  /* =======================================================
     STORAGE FOR GUEST TOKENS & IDEMPOTENCY
     ======================================================= */

  /**
   * Save guest access token for an order.
   *
   * Security architecture:
   * 1. Primary storage: sessionStorage (cleared on browser/tab close).
   * 2. Bounded recovery storage: localStorage (under tch_recovery_token_<orderNumber>).
   *    Extracts the actual cryptographic server-signed `exp` timestamp directly
   *    from the token payload, enforcing strict server-side expiry rather than
   *    assuming any client-side duration.
   *
   * Note on security model:
   * localStorage stores a bearer credential accessible to same-origin JavaScript.
   * It is a practical launch recovery mechanism and NOT an HttpOnly cookie.
   * It is never exposed in URLs, history, or logs.
   */
  saveGuestToken(orderNumber: string, token: string): void {
    if (!isPlatformBrowser(this.platformId) || typeof window === 'undefined') return;

    const trimmedOrder = String(orderNumber || '').trim();
    const trimmedToken = String(token || '').trim();
    if (!trimmedOrder || !trimmedToken) return;

    // 1. Session storage
    if (window.sessionStorage) {
      sessionStorage.setItem(`tch_token_${trimmedOrder}`, trimmedToken);
    }

    // 2. Local storage recovery record with server-side expiry
    if (window.localStorage) {
      try {
        const exp = this.extractTokenExpiry(trimmedToken);
        if (exp && exp > Math.floor(Date.now() / 1000)) {
          const record = {
            token: trimmedToken,
            exp,
          };
          localStorage.setItem(`tch_recovery_token_${trimmedOrder}`, JSON.stringify(record));
        }
      } catch (e) {
        console.warn('Unable to persist guest recovery token:', e);
      }
    }
  }

  /**
   * Retrieve guest access token for an order, enforcing expiration on every lookup.
   */
  getGuestToken(orderNumber: string): string | null {
    if (!isPlatformBrowser(this.platformId) || typeof window === 'undefined') return null;

    const trimmedOrder = String(orderNumber || '').trim();
    if (!trimmedOrder) return null;

    const now = Math.floor(Date.now() / 1000);

    // 1. Try sessionStorage
    if (window.sessionStorage) {
      const sessionToken = sessionStorage.getItem(`tch_token_${trimmedOrder}`);
      if (sessionToken) {
        const exp = this.extractTokenExpiry(sessionToken);
        if (!exp || exp > now) {
          return sessionToken;
        }
        sessionStorage.removeItem(`tch_token_${trimmedOrder}`);
      }
    }

    // 2. Fall back to localStorage recovery record
    if (window.localStorage) {
      try {
        const stored = localStorage.getItem(`tch_recovery_token_${trimmedOrder}`);
        if (!stored) return null;

        const parsed = JSON.parse(stored);
        if (!parsed?.token || typeof parsed?.exp !== 'number' || now >= parsed.exp) {
          localStorage.removeItem(`tch_recovery_token_${trimmedOrder}`);
          return null;
        }

        // Re-populate sessionStorage for active tab
        if (window.sessionStorage) {
          sessionStorage.setItem(`tch_token_${trimmedOrder}`, parsed.token);
        }

        return parsed.token;
      } catch {
        localStorage.removeItem(`tch_recovery_token_${trimmedOrder}`);
        return null;
      }
    }

    return null;
  }

  /**
   * Clear guest token from both session and recovery storage.
   */
  clearGuestToken(orderNumber: string): void {
    if (!isPlatformBrowser(this.platformId) || typeof window === 'undefined') return;
    const trimmedOrder = String(orderNumber || '').trim();
    if (!trimmedOrder) return;

    if (window.sessionStorage) {
      sessionStorage.removeItem(`tch_token_${trimmedOrder}`);
    }
    if (window.localStorage) {
      localStorage.removeItem(`tch_recovery_token_${trimmedOrder}`);
    }
  }

  /**
   * Extract expiration timestamp from the signed token payload (v1.<payload>.<sig>).
   */
  private extractTokenExpiry(token: string): number | null {
    try {
      const parts = token.trim().split('.');
      if (parts.length !== 3) return null;
      // Decode base64url payload
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = atob(base64);
      const payload = JSON.parse(json);
      return typeof payload?.exp === 'number' ? payload.exp : null;
    } catch {
      return null;
    }
  }

  generateIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback UUID v4 generator
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* =======================================================
     API CALLS
     ======================================================= */

  previewCheckout(items: Array<{ variantId: string; quantity: number }>): Observable<CheckoutPreviewResponse> {
    return this.http.post<CheckoutPreviewResponse>(`${this.api}/checkout/preview`, { items });
  }

  createOrder(data: CreateOrderRequest, existingGuestToken?: string | null): Observable<CreateOrderResponse> {
    let headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': data.idempotencyKey
    });

    if (existingGuestToken) {
      headers = headers.set('x-guest-access-token', existingGuestToken);
    }

    return this.http.post<CreateOrderResponse>(`${this.api}/orders/create`, data, { headers });
  }

  getOrderDetails(orderNumber: string, guestToken: string): Observable<OrderDetailsResponse> {
    const headers = new HttpHeaders({
      'x-guest-access-token': guestToken
    });
    return this.http.get<OrderDetailsResponse>(`${this.api}/orders/${encodeURIComponent(orderNumber)}`, { headers });
  }

  getPaymentStatus(orderId: string, guestToken: string): Observable<PaymentStatusResponse> {
    const headers = new HttpHeaders({
      'x-guest-access-token': guestToken
    });
    return this.http.get<PaymentStatusResponse>(`${this.api}/payments/status/${encodeURIComponent(orderId)}`, { headers });
  }

  /**
   * Starts order recovery for an email address. The reply is generic whether or
   * not an order matched, so the caller must not infer anything from it.
   */
  requestOrderRecovery(email: string): Observable<RecoveryRequestResponse> {
    return this.http.post<RecoveryRequestResponse>(`${this.api}/orders/recovery/request`, { email });
  }

  /** Verifies the emailed code. The contact and code travel in the body, never the URL. */
  verifyOrderRecovery(email: string, code: string): Observable<RecoveryVerifyResponse> {
    return this.http.post<RecoveryVerifyResponse>(`${this.api}/orders/recovery/verify`, { email, code });
  }

  retryPayment(orderNumber: string, guestToken: string, idempotencyKey?: string): Observable<any> {
    let headers = new HttpHeaders({
      'x-guest-access-token': guestToken
    });
    if (idempotencyKey) {
      headers = headers.set('Idempotency-Key', idempotencyKey);
    }
    return this.http.post<any>(`${this.api}/orders/${encodeURIComponent(orderNumber)}/retry-payment`, {}, { headers });
  }

  /* =======================================================
     CASHFREE WEB SDK INTEGRATION
     ======================================================= */

  loadCashfreeSdk(): Promise<any> {
    if (this.sdkLoadPromise) {
      return this.sdkLoadPromise;
    }

    this.sdkLoadPromise = new Promise((resolve, reject) => {
      if (!isPlatformBrowser(this.platformId) || typeof window === 'undefined') {
        return reject(new Error('Window is not defined.'));
      }

      if ((window as any).Cashfree) {
        return resolve((window as any).Cashfree);
      }

      const existingScript = typeof document !== 'undefined'
        ? document.querySelector('script[src*="cashfree.com/js/v3/cashfree.js"]')
        : null;

      if (existingScript) {
        existingScript.addEventListener('load', () => resolve((window as any).Cashfree));
        existingScript.addEventListener('error', () => reject(new Error('Failed to load Cashfree SDK script.')));
        return;
      }

      if (typeof document === 'undefined') {
        return reject(new Error('Document is not defined.'));
      }

      const script = document.createElement('script');
      script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
      script.async = true;
      script.onload = () => resolve((window as any).Cashfree);
      script.onerror = () => reject(new Error('Failed to load Cashfree SDK script.'));
      document.head.appendChild(script);
    });

    return this.sdkLoadPromise;
  }

  async launchCashfreePayment(paymentSessionId: string): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error('Cashfree payment cannot be launched outside the browser.');
    }

    const CashfreeFactory = await this.loadCashfreeSdk();
    if (!CashfreeFactory) {
      throw new Error('Cashfree SDK is not available.');
    }

    const isProduction = typeof window !== 'undefined' && (
      (window as any).__CASHFREE_MODE__ === 'production' ||
      window.location.hostname === 'thecrunchyheart.com' ||
      window.location.hostname === 'www.thecrunchyheart.com'
    );
    const mode = isProduction ? 'production' : 'sandbox';
    const cashfree = CashfreeFactory({ mode });
    cashfree.checkout({
      paymentSessionId,
      redirectTarget: '_self'
    });
  }
}
