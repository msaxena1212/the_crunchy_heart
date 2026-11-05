import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { getApiBaseUrl } from '../product.service';

export interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
}

export interface AdminOrderSummary {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  email: string | null;
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  notes: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  canDispatch: boolean;
}

export interface AdminOrderListResponse {
  success: boolean;
  orders: AdminOrderSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AdminOrderDetailResponse {
  success: boolean;
  order: {
    id: string;
    orderNumber: string;
    customerName: string;
    phone: string;
    email: string | null;
    shippingAddress: any;
    billingAddress: any;
    subtotal: number;
    discountAmount: number;
    shippingAmount: number;
    taxAmount: number;
    totalAmount: number;
    currency: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    notes: string | null;
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
  payments: Array<{
    id: string;
    provider: string;
    providerOrderId: string;
    providerPaymentId: string | null;
    amount: number;
    currency: string;
    status: string;
    gatewayStatus: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  refunds: Array<{
    id: string;
    paymentId: string | null;
    amount: number;
    reason: string | null;
    status: string;
    providerRefundId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  statusHistory: Array<{
    id: string;
    status: string;
    note: string | null;
    createdAt: string;
  }>;
  canDispatch: boolean;
}

export interface AdminRefundException {
  refundId: string | null;
  orderNumber: string;
  customerName: string;
  phone: string;
  email: string | null;
  amount: number;
  reason: string;
  refundStatus: string;
  exceptionType: string;
  orderStatus: string;
  orderPaymentStatus: string;
  paymentGatewayStatus: string | null;
  providerPaymentId: string | null;
  orderNotes: string | null;
  createdAt: string;
}

export interface AdminPendingRefundsResponse {
  success: boolean;
  exceptions: AdminRefundException[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface PaymentAttemptReviewItem {
  paymentId: string;
  orderNumber: string;
  providerOrderId: string | null;
  gatewayStatus: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  legacyUnbound: boolean;
}

export interface PaymentAttemptReviewResponse {
  success: boolean;
  attempts: PaymentAttemptReviewItem[];
  conflicts: Array<{ orderNumber: string; liveSessions: number }>;
}

export interface PaymentStateAttempt {
  paymentId: string;
  providerOrderId: string | null;
  gatewayStatus: string;
  status: string;
  hasSession: boolean;
  createdAt: string;
  legacyUnbound: boolean;
}

export type PaymentAttemptState =
  | 'PAID'
  | 'CONFLICT'
  | 'UNRESOLVED'
  | 'RESUMABLE'
  | 'NO_LIVE'
  | 'NO_ATTEMPT';

export interface PaymentStateOrder {
  orderNumber: string;
  orderStatus: string;
  paymentStatus: string;
  totalAmount: number;
  createdAt: string;
  paymentState: PaymentAttemptState;
  reasons: string[];
  attempts: PaymentStateAttempt[];
}

export interface PaymentStateOrdersResponse {
  success: boolean;
  orders: PaymentStateOrder[];
}

export interface AdminDashboardResponse {
  success: boolean;
  orders: { last24Hours: number; last7Days: number; total: number; awaitingOnlinePayment: number };
  revenue: { paidLast30Days: number };
  attention: { paymentsToReview: number; refundExceptions: number; lowStockVariants: number };
  catalogue: { activeProducts: number; activeCoupons: number };
}

export interface AdminProduct {
  id: string;
  name: string;
  slug: string;
  brand: string;
  category: string | null;
  isActive: boolean;
  isFeatured: boolean;
  variantCount: number;
  availableUnits: number;
  updatedAt: string;
}

export interface AdminProductsResponse { success: boolean; products: AdminProduct[]; }

export interface AdminInventoryVariant {
  id: string;
  sku: string;
  productName: string;
  variantName: string;
  isActive: boolean;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number;
  lowStock: boolean;
}

export interface AdminInventoryResponse { success: boolean; variants: AdminInventoryVariant[]; }

export interface AdminCoupon {
  id: string;
  code: string;
  description: string | null;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  minimumOrderValue: number;
  maximumDiscount: number | null;
  usageLimit: number | null;
  usageCount: number;
  perCustomerLimit: number | null;
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
}

export interface AdminCouponsResponse { success: boolean; coupons: AdminCoupon[]; }

export interface AdminCustomer {
  phone: string;
  name: string | null;
  email: string | null;
  orderCount: number;
  paidTotal: number;
  lastOrderAt: string;
}

export interface AdminCustomersResponse { success: boolean; customers: AdminCustomer[]; }

export interface IntegrationStatus { connected: boolean; missingConfig: string[]; }

export interface AdminIntegrationsResponse {
  success: boolean;
  analytics: IntegrationStatus;
  socialAccounts: Record<'instagram' | 'tiktok' | 'youtube' | 'pinterest', IntegrationStatus>;
}

export type SocialPlatform = 'instagram' | 'tiktok' | 'youtube' | 'pinterest';

export interface SocialDraft {
  id: string;
  platform: SocialPlatform;
  title: string;
  body: string;
  mediaUrl: string | null;
  status: 'draft' | 'scheduled' | 'published' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface AdminSocialDraftsResponse { success: boolean; drafts: SocialDraft[]; }

export interface SocialDraftInput {
  platform: SocialPlatform;
  title: string;
  body: string;
  mediaUrl?: string | null;
}

export interface PaymentAttemptActionResult {
  success: boolean;
  paymentId: string;
  outcome?: string;
  reason?: string | null;
  changed?: boolean;
  action?: string | null;
  reconciled?: boolean;
  gatewayStatus?: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  private http = inject(HttpClient);
  private api = `${getApiBaseUrl()}/admin`;

  // Reactive state
  currentAdmin = signal<AdminUser | null>(this.getStoredAdminUser());
  csrfToken = signal<string | null>(this.getStoredCsrfToken());

  private getStoredAdminUser(): AdminUser | null {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    try {
      const data = sessionStorage.getItem('tch_admin_user');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  private getStoredCsrfToken(): string | null {
    if (typeof window === 'undefined') return null;
    // Try cookie first
    if (document.cookie) {
      const match = document.cookie.match(/tch_csrf_token=([^;]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    if (window.sessionStorage) {
      return sessionStorage.getItem('tch_csrf_token');
    }
    return null;
  }

  isAuthenticated(): boolean {
    return this.currentAdmin() !== null;
  }

  login(email: string, password: string):Observable<any> {
    return this.http.post<any>(
      `${this.api}/auth/login`,
      { email, password },
      { withCredentials: true }
    ).pipe(
      tap((res) => {
        if (res.success && res.admin) {
          this.currentAdmin.set(res.admin);
          if (res.csrfToken) {
            this.csrfToken.set(res.csrfToken);
            if (typeof window !== 'undefined' && window.sessionStorage) {
              sessionStorage.setItem('tch_csrf_token', res.csrfToken);
            }
          }
          if (typeof window !== 'undefined' && window.sessionStorage) {
            sessionStorage.setItem('tch_admin_user', JSON.stringify(res.admin));
          }
        }
      })
    );
  }

  logout(): Observable<any> {
    const headers = this.getCsrfHeaders();
    return this.http.post<any>(
      `${this.api}/auth/logout`,
      {},
      { withCredentials: true, headers }
    ).pipe(
      tap(() => {
        this.clearSession();
      })
    );
  }

  clearSession(): void {
    this.currentAdmin.set(null);
    this.csrfToken.set(null);
    if (typeof window !== 'undefined' && window.sessionStorage) {
      sessionStorage.removeItem('tch_admin_user');
      sessionStorage.removeItem('tch_csrf_token');
    }
  }

  getMe(): Observable<any> {
    return this.http.get<any>(
      `${this.api}/auth/me`,
      { withCredentials: true }
    ).pipe(
      tap({
        next: (res) => {
          if (res.success && res.admin) {
            this.currentAdmin.set(res.admin);
          }
        },
        error: () => {
          this.clearSession();
        }
      })
    );
  }

  getOrders(params: {
    page?: number;
    limit?: number;
    status?: string;
    paymentMethod?: string;
    paymentStatus?: string;
    search?: string;
  } = {}): Observable<AdminOrderListResponse> {
    let httpParams = new HttpParams();
    if (params.page) httpParams = httpParams.set('page', params.page.toString());
    if (params.limit) httpParams = httpParams.set('limit', params.limit.toString());
    if (params.status) httpParams = httpParams.set('status', params.status);
    if (params.paymentMethod) httpParams = httpParams.set('paymentMethod', params.paymentMethod);
    if (params.paymentStatus) httpParams = httpParams.set('paymentStatus', params.paymentStatus);
    if (params.search) httpParams = httpParams.set('search', params.search);

    return this.http.get<AdminOrderListResponse>(
      `${this.api}/orders`,
      { withCredentials: true, params: httpParams }
    );
  }

  getOrderDetails(orderNumber: string): Observable<AdminOrderDetailResponse> {
    return this.http.get<AdminOrderDetailResponse>(
      `${this.api}/orders/${encodeURIComponent(orderNumber)}`,
      { withCredentials: true }
    );
  }

  dispatchCodOrder(orderNumber: string): Observable<any> {
    const headers = this.getCsrfHeaders();
    return this.http.post<any>(
      `${this.api}/orders/${encodeURIComponent(orderNumber)}/dispatch`,
      {},
      { withCredentials: true, headers }
    );
  }

  getPendingRefunds(params: { page?: number; limit?: number } = {}): Observable<AdminPendingRefundsResponse> {
    let httpParams = new HttpParams();
    if (params.page) httpParams = httpParams.set('page', params.page.toString());
    if (params.limit) httpParams = httpParams.set('limit', params.limit.toString());

    return this.http.get<AdminPendingRefundsResponse>(
      `${this.api}/refunds/pending`,
      { withCredentials: true, params: httpParams }
    );
  }

  /* ---------- Dashboard, catalogue, inventory, coupons, customers, integrations, social ---------- */

  getDashboard(): Observable<AdminDashboardResponse> {
    return this.http.get<AdminDashboardResponse>(`${this.api}/dashboard`, { withCredentials: true });
  }

  getAdminProducts(params: { search?: string; limit?: number } = {}): Observable<AdminProductsResponse> {
    let httpParams = new HttpParams().set('limit', String(params.limit ?? 100));
    if (params.search) httpParams = httpParams.set('search', params.search);
    return this.http.get<AdminProductsResponse>(`${this.api}/catalogue/products`, { withCredentials: true, params: httpParams });
  }

  getAdminInventory(params: { lowStock?: boolean } = {}): Observable<AdminInventoryResponse> {
    let httpParams = new HttpParams();
    if (params.lowStock) httpParams = httpParams.set('lowStock', 'true');
    return this.http.get<AdminInventoryResponse>(`${this.api}/catalogue/inventory`, { withCredentials: true, params: httpParams });
  }

  getAdminCoupons(): Observable<AdminCouponsResponse> {
    return this.http.get<AdminCouponsResponse>(`${this.api}/catalogue/coupons`, { withCredentials: true });
  }

  getAdminCustomers(params: { search?: string; limit?: number } = {}): Observable<AdminCustomersResponse> {
    let httpParams = new HttpParams().set('limit', String(params.limit ?? 100));
    if (params.search) httpParams = httpParams.set('search', params.search);
    return this.http.get<AdminCustomersResponse>(`${this.api}/customers`, { withCredentials: true, params: httpParams });
  }

  getIntegrations(): Observable<AdminIntegrationsResponse> {
    return this.http.get<AdminIntegrationsResponse>(`${this.api}/integrations`, { withCredentials: true });
  }

  getSocialDrafts(platform?: string): Observable<AdminSocialDraftsResponse> {
    let httpParams = new HttpParams();
    if (platform) httpParams = httpParams.set('platform', platform);
    return this.http.get<AdminSocialDraftsResponse>(`${this.api}/social/drafts`, { withCredentials: true, params: httpParams });
  }

  createSocialDraft(input: SocialDraftInput): Observable<{ success: boolean; draft: SocialDraft }> {
    return this.http.post<{ success: boolean; draft: SocialDraft }>(
      `${this.api}/social/drafts`, input, { withCredentials: true, headers: this.getCsrfHeaders() }
    );
  }

  updateSocialDraft(draftId: string, input: SocialDraftInput): Observable<{ success: boolean; draft: SocialDraft }> {
    return this.http.put<{ success: boolean; draft: SocialDraft }>(
      `${this.api}/social/drafts/${encodeURIComponent(draftId)}`, input, { withCredentials: true, headers: this.getCsrfHeaders() }
    );
  }

  publishSocialDraft(draftId: string): Observable<any> {
    return this.http.post<any>(
      `${this.api}/social/drafts/${encodeURIComponent(draftId)}/publish`, {}, { withCredentials: true, headers: this.getCsrfHeaders() }
    );
  }

  /* ---------- Payment attempt operations ---------- */

  getPaymentReview(limit = 50): Observable<PaymentAttemptReviewResponse> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http.get<PaymentAttemptReviewResponse>(
      `${this.api}/payment-attempts/review`,
      { withCredentials: true, params }
    );
  }

  getPaymentOrders(params: { state?: PaymentAttemptState | ''; limit?: number } = {}): Observable<PaymentStateOrdersResponse> {
    let httpParams = new HttpParams().set('limit', String(params.limit ?? 50));
    if (params.state) httpParams = httpParams.set('state', params.state);
    return this.http.get<PaymentStateOrdersResponse>(
      `${this.api}/payment-attempts/orders`,
      { withCredentials: true, params: httpParams }
    );
  }

  lookupPaymentAttempt(paymentId: string): Observable<PaymentAttemptActionResult> {
    return this.http.post<PaymentAttemptActionResult>(
      `${this.api}/payment-attempts/${encodeURIComponent(paymentId)}/lookup`,
      {},
      { withCredentials: true, headers: this.getCsrfHeaders() }
    );
  }

  reconcilePaymentAttempt(paymentId: string): Observable<PaymentAttemptActionResult> {
    return this.http.post<PaymentAttemptActionResult>(
      `${this.api}/payment-attempts/${encodeURIComponent(paymentId)}/reconcile`,
      {},
      { withCredentials: true, headers: this.getCsrfHeaders() }
    );
  }

  /** Closes an attempt as not submitted. Requires the exact attestation value and a note. */
  closePaymentAttempt(paymentId: string, note: string): Observable<PaymentAttemptActionResult> {
    return this.http.post<PaymentAttemptActionResult>(
      `${this.api}/payment-attempts/${encodeURIComponent(paymentId)}/close-not-submitted`,
      { confirmation: 'ABSENT_IN_PROVIDER_DASHBOARD', note },
      { withCredentials: true, headers: this.getCsrfHeaders() }
    );
  }

  private getCsrfHeaders(): HttpHeaders {
    let headers = new HttpHeaders();
    const token = this.csrfToken() || this.getStoredCsrfToken();
    if (token) {
      headers = headers.set('x-csrf-token', token);
    }
    return headers;
  }
}
