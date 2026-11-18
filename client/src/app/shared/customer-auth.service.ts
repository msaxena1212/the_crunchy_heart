import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Observable, catchError, map, of, tap } from 'rxjs';

export interface CustomerUser {
  id: string;
  phone: string;
  name: string;
  email: string | null;
  authProvider?: string;
}

export interface CustomerOrderItem {
  id: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface CustomerOrder {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  subtotal: number;
  shipping_amount: number;
  discount_amount: number;
  total_amount: number;
  shipping_address: any;
  created_at: string;
  items: CustomerOrderItem[];
}

@Injectable({
  providedIn: 'root'
})
export class CustomerAuthService {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly tokenKey = 'tch_customer_token';

  private readonly customerSubject = new BehaviorSubject<CustomerUser | null>(null);
  readonly currentCustomer$ = this.customerSubject.asObservable();

  private readonly loginModalSubject = new BehaviorSubject<{ isOpen: boolean; redirectUrl?: string }>({ isOpen: false });
  readonly loginModal$ = this.loginModalSubject.asObservable();

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      const token = this.getToken();
      if (token) {
        this.fetchProfile().subscribe();
      }
    }
  }

  get token(): string | null {
    return this.getToken();
  }

  get isLoggedIn(): boolean {
    return !!this.customerSubject.value && !!this.getToken();
  }

  get currentCustomer(): CustomerUser | null {
    return this.customerSubject.value;
  }

  openLoginModal(redirectUrl?: string): void {
    this.loginModalSubject.next({ isOpen: true, redirectUrl });
  }

  closeLoginModal(): void {
    this.loginModalSubject.next({ isOpen: false });
  }

  requestOtp(phone: string, channel: 'sms' | 'whatsapp' = 'sms'): Observable<{ success: boolean; message?: string }> {
    return this.http.post<{ success: boolean; message?: string }>('/api/auth/customer/otp/request', {
      phone,
      channel,
      purpose: 'LOGIN'
    });
  }

  verifyOtp(phone: string, otp: string): Observable<{ success: boolean; customer: CustomerUser; token: string }> {
    return this.http.post<{ success: boolean; customer: CustomerUser; token: string }>('/api/auth/customer/otp/verify', {
      phone,
      otp: String(otp).trim()
    }).pipe(
      tap(res => {
        if (res.success && res.token) {
          this.saveToken(res.token);
          this.customerSubject.next(res.customer);
          this.closeLoginModal();
        }
      })
    );
  }

  fetchProfile(): Observable<CustomerUser | null> {
    const token = this.getToken();
    if (!token) {
      this.customerSubject.next(null);
      return of(null);
    }

    const headers = new HttpHeaders().set('Authorization', `Bearer ${token}`);
    return this.http.get<{ success: boolean; customer: CustomerUser }>('/api/auth/customer/me', { headers }).pipe(
      map(res => {
        if (res.success && res.customer) {
          this.customerSubject.next(res.customer);
          return res.customer;
        }
        return null;
      }),
      catchError(() => {
        this.clearToken();
        this.customerSubject.next(null);
        return of(null);
      })
    );
  }

  updateProfile(name: string, email: string): Observable<CustomerUser> {
    const token = this.getToken();
    const headers = new HttpHeaders().set('Authorization', `Bearer ${token}`);
    return this.http.put<{ success: boolean; customer: CustomerUser }>('/api/auth/customer/profile', { name, email }, { headers }).pipe(
      map(res => {
        this.customerSubject.next(res.customer);
        return res.customer;
      })
    );
  }

  getOrders(): Observable<CustomerOrder[]> {
    const token = this.getToken();
    if (!token) return of([]);

    const headers = new HttpHeaders().set('Authorization', `Bearer ${token}`);
    return this.http.get<{ success: boolean; orders: CustomerOrder[] }>('/api/auth/customer/orders', { headers }).pipe(
      map(res => res.orders || []),
      catchError(() => of([]))
    );
  }

  logout(): void {
    const token = this.getToken();
    if (token) {
      const headers = new HttpHeaders().set('Authorization', `Bearer ${token}`);
      this.http.post('/api/auth/customer/logout', {}, { headers }).subscribe();
    }
    this.clearToken();
    this.customerSubject.next(null);
  }

  private getToken(): string | null {
    if (isPlatformBrowser(this.platformId)) {
      return localStorage.getItem(this.tokenKey);
    }
    return null;
  }

  private saveToken(token: string): void {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem(this.tokenKey, token);
    }
  }

  private clearToken(): void {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.removeItem(this.tokenKey);
    }
  }
}
