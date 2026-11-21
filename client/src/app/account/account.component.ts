import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CustomerAuthService, CustomerOrder, CustomerUser } from '../shared/customer-auth.service';

@Component({
  selector: 'tch-account',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <section class="account-page">
      <div class="account-shell">

        <!-- BREADCRUMB / TOP LINK -->
        <div class="top-nav">
          <a routerLink="/shop" class="back-link">← Continue Shopping</a>
          <span class="brand-tag">The Crunchy Heart Pantry</span>
        </div>

        <!-- NOT LOGGED IN STATE -->
        <div *ngIf="!isLoggedIn" class="guest-card">
          <span class="guest-icon">♡</span>
          <h1>My Account</h1>
          <p class="guest-desc">
            Sign in with your mobile number to view your order history, track deliveries, and manage your account details.
          </p>
          <button type="button" class="primary-btn" (click)="openLogin()">
            Sign In with OTP →
          </button>
        </div>

        <!-- LOGGED IN DASHBOARD -->
        <div *ngIf="isLoggedIn" class="dashboard-layout">

          <!-- USER HEADER BANNER -->
          <header class="profile-header">
            <div class="avatar-circle">
              {{ (customer?.name ? customer!.name[0] : 'U') | uppercase }}
            </div>
            <div class="profile-meta">
              <h2>{{ customer?.name || 'Valued Customer' }}</h2>
              <p class="phone-tag">+91 {{ customer?.phone }}</p>
              <p *ngIf="customer?.email" class="email-tag">{{ customer?.email }}</p>
            </div>
            <button type="button" class="logout-btn" (click)="logout()">
              Sign Out
            </button>
          </header>

          <!-- TABS NAVIGATION -->
          <nav class="tabs-nav">
            <button
              type="button"
              class="tab-btn"
              [class.active]="activeTab === 'orders'"
              (click)="activeTab = 'orders'">
              📦 My Orders ({{ orders.length }})
            </button>
            <button
              type="button"
              class="tab-btn"
              [class.active]="activeTab === 'profile'"
              (click)="activeTab = 'profile'">
              ⚙️ Profile Details
            </button>
          </nav>

          <!-- TAB 1: ORDERS LIST -->
          <div *ngIf="activeTab === 'orders'" class="tab-content">
            <div *ngIf="isLoadingOrders" class="loading-state">
              <span class="spinner"></span>
              <p>Loading your orders...</p>
            </div>

            <!-- EMPTY ORDERS -->
            <div *ngIf="!isLoadingOrders && orders.length === 0" class="empty-orders-card">
              <span class="empty-icon">♡</span>
              <h3>No orders found</h3>
              <p>You haven't placed any orders with this number yet.</p>
              <a routerLink="/shop" class="primary-btn">Explore Products</a>
            </div>

            <!-- ORDERS GRID / LIST -->
            <p *ngIf="orderActionError" class="order-action-error" role="alert">{{ orderActionError }}</p>

            <div *ngIf="!isLoadingOrders && orders.length > 0" class="orders-list">
              <article *ngFor="let order of orders" class="order-card">
                <div class="order-card-header">
                  <div>
                    <span class="order-num">Order #{{ order.order_number }}</span>
                    <span class="order-date">{{ order.created_at | date:'mediumDate' }}</span>
                  </div>
                  <div class="order-badges">
                    <span class="status-badge" [ngClass]="'status-' + (order.status || 'pending').toLowerCase()">
                      {{ order.status | titlecase }}
                    </span>
                    <span class="pay-badge" [ngClass]="'pay-' + (order.payment_status || 'unpaid').toLowerCase()">
                      {{ order.payment_status | titlecase }}
                    </span>
                  </div>
                </div>

                <!-- ITEMS LIST -->
                <div class="order-items-table">
                  <div *ngFor="let item of order.items" class="order-item-row">
                    <div class="item-name-cell">
                      <strong>{{ item.productName }}</strong>
                      <span class="variant-label">{{ item.variantName }}</span>
                    </div>
                    <div class="item-qty-cell">
                      Qty: {{ item.quantity }}
                    </div>
                    <div class="item-price-cell">
                      ₹{{ item.totalPrice || (item.unitPrice * item.quantity) }}
                    </div>
                  </div>
                </div>

                <!-- FOOTER TOTAL & TRACK LINK -->
                <div class="order-card-footer">
                  <div class="order-total-block">
                    <span>Total Amount:</span>
                    <strong>₹{{ order.total_amount }}</strong>
                  </div>
                  <button *ngIf="canCancel(order)" type="button" class="cancel-link"
                          [disabled]="cancellingOrder === order.order_number"
                          (click)="cancelOrder(order)">
                    {{ cancellingOrder === order.order_number ? 'Cancelling...' : 'Cancel order' }}
                  </button>
                  <a [routerLink]="['/orders', order.order_number]" class="track-link">
                    View Details & Tracking →
                  </a>
                </div>
              </article>
            </div>
          </div>

          <!-- TAB 2: PROFILE SETTINGS -->
          <div *ngIf="activeTab === 'profile'" class="tab-content">
            <div class="profile-card">
              <h3>Update Personal Information</h3>

              <div *ngIf="profileSuccessMessage" class="success-banner">
                {{ profileSuccessMessage }}
              </div>
              <div *ngIf="profileErrorMessage" class="error-banner">
                {{ profileErrorMessage }}
              </div>

              <form (ngSubmit)="saveProfile()" class="profile-form">
                <div class="form-group">
                  <label for="prof-phone">Mobile Number (Registered)</label>
                  <input
                    id="prof-phone"
                    type="text"
                    [value]="'+91 ' + (customer?.phone || '')"
                    disabled />
                  <span class="hint">Phone number is verified via OTP and cannot be edited directly.</span>
                </div>

                <div class="form-group">
                  <label for="prof-name">Full Name</label>
                  <input
                    id="prof-name"
                    type="text"
                    [(ngModel)]="editName"
                    name="name"
                    placeholder="Enter your full name"
                    required />
                </div>

                <div class="form-group">
                  <label for="prof-email">Email Address</label>
                  <input
                    id="prof-email"
                    type="email"
                    [(ngModel)]="editEmail"
                    name="email"
                    placeholder="name@example.com" />
                </div>

                <button
                  type="submit"
                  class="save-btn"
                  [disabled]="isSavingProfile">
                  {{ isSavingProfile ? 'Saving...' : 'Save Profile Changes' }}
                </button>
              </form>
            </div>
          </div>

        </div>

      </div>
    </section>
  `,
  styles: [`
    .account-page {
      background: #faf6ee;
      min-height: 80vh;
      padding: 36px 18px 60px;
    }

    .account-shell {
      max-width: 860px;
      margin: 0 auto;
    }

    .top-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      font-size: 13.5px;
    }

    .back-link {
      color: #1e392a;
      text-decoration: none;
      font-weight: 600;
      transition: color 150ms;
    }

    .back-link:hover {
      color: #a17c35;
    }

    .brand-tag {
      color: #8c8477;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .guest-card {
      background: #fffdf8;
      border: 1px solid #e8e0d2;
      border-radius: 20px;
      padding: 48px 32px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(30, 57, 42, 0.06);
    }

    .guest-icon {
      font-size: 40px;
      color: #a17c35;
      display: inline-block;
      margin-bottom: 12px;
    }

    .guest-card h1 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 32px;
      color: #1e392a;
      margin: 0 0 12px;
    }

    .guest-desc {
      color: #6d665b;
      font-size: 15px;
      max-width: 440px;
      margin: 0 auto 28px;
      line-height: 1.6;
    }

    .primary-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #1e392a;
      color: #fff9ec;
      border: none;
      padding: 14px 30px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
      text-decoration: none;
      transition: background 160ms, transform 160ms;
    }

    .primary-btn:hover {
      background: #274b37;
      transform: translateY(-1px);
    }

    .profile-header {
      background: #fffdf8;
      border: 1px solid #e8e0d2;
      border-radius: 18px;
      padding: 24px 28px;
      display: flex;
      align-items: center;
      gap: 20px;
      margin-bottom: 24px;
      box-shadow: 0 4px 16px rgba(30, 57, 42, 0.04);
    }

    .avatar-circle {
      width: 58px;
      height: 58px;
      border-radius: 50%;
      background: #1e392a;
      color: #fff9ec;
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 24px;
      font-weight: 700;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }

    .profile-meta {
      flex: 1;
    }

    .profile-meta h2 {
      margin: 0 0 4px;
      font-size: 20px;
      color: #1e392a;
    }

    .phone-tag {
      margin: 0;
      font-size: 13.5px;
      font-weight: 600;
      color: #a17c35;
    }

    .email-tag {
      margin: 2px 0 0;
      font-size: 13px;
      color: #7b7468;
    }

    .logout-btn {
      background: transparent;
      border: 1px solid #dcd1c2;
      color: #7b7468;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 160ms;
    }

    .logout-btn:hover {
      background: #fdf2f0;
      color: #b64232;
      border-color: #f6cfc7;
    }

    .tabs-nav {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      border-bottom: 1.5px solid #e8e0d2;
      padding-bottom: 12px;
    }

    .tab-btn {
      background: none;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      color: #7b7468;
      cursor: pointer;
      transition: all 160ms;
    }

    .tab-btn:hover {
      color: #1e392a;
      background: #f1ebd8;
    }

    .tab-btn.active {
      background: #1e392a;
      color: #fff9ec;
    }

    .loading-state {
      text-align: center;
      padding: 40px;
      color: #7b7468;
    }

    .spinner {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 3px solid #e8e0d2;
      border-top-color: #1e392a;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .empty-orders-card {
      background: #fffdf8;
      border: 1px solid #e8e0d2;
      border-radius: 16px;
      padding: 40px;
      text-align: center;
    }

    .empty-orders-card h3 {
      font-size: 18px;
      color: #1e392a;
      margin: 8px 0;
    }

    .empty-orders-card p {
      color: #7b7468;
      font-size: 14px;
      margin: 0 0 20px;
    }

    .orders-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .order-card {
      background: #fffdf8;
      border: 1px solid #e8e0d2;
      border-radius: 16px;
      padding: 20px 24px;
      box-shadow: 0 2px 8px rgba(30, 57, 42, 0.03);
    }

    .order-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
      border-bottom: 1px solid #f1ebd8;
      padding-bottom: 12px;
    }

    .order-num {
      display: block;
      font-weight: 700;
      color: #1e392a;
      font-size: 15px;
    }

    .order-date {
      font-size: 12.5px;
      color: #8c8477;
    }

    .order-badges {
      display: flex;
      gap: 8px;
    }

    .status-badge, .pay-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .status-confirmed, .status-delivered {
      background: #e6f4ea;
      color: #137333;
    }

    .status-shipped {
      background: #e8f0fe;
      color: #1a73e8;
    }

    .status-pending {
      background: #fef7e0;
      color: #b06000;
    }

    .status-cancelled, .status-failed {
      background: #fce8e6;
      color: #c5221f;
    }

    .pay-paid {
      background: #e6f4ea;
      color: #137333;
    }

    .pay-unpaid, .pay-pending {
      background: #fef7e0;
      color: #b06000;
    }

    .order-items-table {
      margin-bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .order-item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13.5px;
    }

    .item-name-cell {
      flex: 2;
    }

    .item-name-cell strong {
      color: #1e392a;
      display: block;
    }

    .variant-label {
      font-size: 12px;
      color: #8c8477;
    }

    .item-qty-cell {
      flex: 1;
      text-align: center;
      color: #6d665b;
      font-size: 13px;
    }

    .item-price-cell {
      flex: 1;
      text-align: right;
      font-weight: 600;
      color: #1e392a;
    }

    .order-card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid #f1ebd8;
      padding-top: 14px;
      flex-wrap: wrap;
      gap: 10px;
    }

    .order-total-block span {
      font-size: 13px;
      color: #7b7468;
      margin-right: 6px;
    }

    .order-total-block strong {
      font-size: 17px;
      color: #1e392a;
    }

    .order-action-error { color: #b42318; background: #fdecea; border-radius: 10px; padding: 10px 14px; }

    .cancel-link {
      background: none;
      border: 1.5px solid #b42318;
      color: #b42318;
      border-radius: 8px;
      padding: 6px 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .cancel-link:disabled { opacity: .6; cursor: not-allowed; }

    .track-link {
      font-size: 13.5px;
      font-weight: 600;
      color: #a17c35;
      text-decoration: none;
      transition: color 150ms;
    }

    .track-link:hover {
      color: #1e392a;
      text-decoration: underline;
    }

    .profile-card {
      background: #fffdf8;
      border: 1px solid #e8e0d2;
      border-radius: 16px;
      padding: 32px;
    }

    .profile-card h3 {
      font-size: 18px;
      color: #1e392a;
      margin: 0 0 20px;
    }

    .profile-form {
      display: flex;
      flex-direction: column;
      gap: 18px;
      max-width: 480px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .form-group label {
      font-size: 12.5px;
      font-weight: 600;
      color: #1e392a;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .form-group input {
      padding: 12px 14px;
      border: 1.5px solid #dcd1c2;
      border-radius: 8px;
      font-size: 14.5px;
      color: #1e392a;
      background: #ffffff;
      outline: none;
      transition: border-color 160ms;
    }

    .form-group input:focus {
      border-color: #1e392a;
    }

    .form-group input:disabled {
      background: #f4efe4;
      color: #7b7468;
      cursor: not-allowed;
    }

    .form-group .hint {
      font-size: 11.5px;
      color: #8c8477;
    }

    .save-btn {
      background: #1e392a;
      color: #fff9ec;
      border: none;
      border-radius: 8px;
      padding: 13px;
      font-weight: 600;
      font-size: 14.5px;
      cursor: pointer;
      margin-top: 8px;
      transition: background 160ms;
    }

    .save-btn:hover:not(:disabled) {
      background: #274b37;
    }

    .save-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .success-banner {
      background: #f0f7f2;
      color: #1e5934;
      border: 1px solid #c2e2cc;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 18px;
    }

    .error-banner {
      background: #fdf2f0;
      color: #b64232;
      border: 1px solid #f6cfc7;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 18px;
    }

    @media (max-width: 600px) {
      .profile-header {
        flex-direction: column;
        text-align: center;
      }
      .order-card-header, .order-card-footer {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  `]
})
export class AccountComponent implements OnInit {
  private readonly customerAuthService = inject(CustomerAuthService);
  private readonly router = inject(Router);

  activeTab: 'orders' | 'profile' = 'orders';

  customer: CustomerUser | null = null;
  orders: CustomerOrder[] = [];

  isLoadingOrders = false;
  isSavingProfile = false;

  editName = '';
  editEmail = '';

  profileSuccessMessage = '';
  profileErrorMessage = '';

  get isLoggedIn(): boolean {
    return this.customerAuthService.isLoggedIn;
  }

  ngOnInit(): void {
    this.customerAuthService.currentCustomer$.subscribe(cust => {
      this.customer = cust;
      if (cust) {
        this.editName = cust.name || '';
        this.editEmail = cust.email || '';
        this.loadOrders();
      }
    });

    if (this.isLoggedIn) {
      this.loadOrders();
    }
  }

  openLogin(): void {
    this.customerAuthService.openLoginModal('/account');
  }

  cancellingOrder: string | null = null;
  orderActionError = '';

  canCancel(order: CustomerOrder): boolean {
    return order.payment_method === 'COD' && ['pending', 'confirmed', 'processing'].includes((order.status || '').toLowerCase());
  }

  cancelOrder(order: CustomerOrder): void {
    if (this.cancellingOrder) return;
    if (!confirm(`Cancel order ${order.order_number}? This cannot be undone.`)) return;
    this.cancellingOrder = order.order_number;
    this.customerAuthService.cancelOrder(order.order_number).subscribe({
      next: () => { this.cancellingOrder = null; this.loadOrders(); },
      error: (err) => {
        this.cancellingOrder = null;
        this.orderActionError = err.error?.message || 'Could not cancel this order.';
        this.loadOrders();
      },
    });
  }

  loadOrders(): void {
    this.isLoadingOrders = true;
    this.customerAuthService.getOrders().subscribe({
      next: (orders) => {
        this.orders = orders || [];
        this.isLoadingOrders = false;
      },
      error: () => {
        this.isLoadingOrders = false;
      }
    });
  }

  saveProfile(): void {
    if (this.isSavingProfile) return;

    this.isSavingProfile = true;
    this.profileSuccessMessage = '';
    this.profileErrorMessage = '';

    this.customerAuthService.updateProfile(this.editName.trim(), this.editEmail.trim()).subscribe({
      next: (updated) => {
        this.isSavingProfile = false;
        this.customer = updated;
        this.profileSuccessMessage = 'Your profile details have been saved successfully.';
      },
      error: (err) => {
        this.isSavingProfile = false;
        this.profileErrorMessage = err.error?.message || 'Failed to update profile. Please try again.';
      }
    });
  }

  logout(): void {
    this.customerAuthService.logout();
    this.orders = [];
    void this.router.navigate(['/']);
  }
}
