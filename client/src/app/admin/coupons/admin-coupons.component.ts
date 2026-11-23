import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminCoupon, AdminService, CouponInput } from '../admin.service';

interface CouponForm {
  code: string;
  description: string;
  discountType: 'percentage' | 'fixed';
  discountValue: string;
  minimumOrderValue: string;
  maximumDiscount: string;
  usageLimit: string;
  perCustomerLimit: string;
  startsAt: string;
  expiresAt: string;
  firstOrderOnly: boolean;
  isActive: boolean;
}

const emptyForm = (): CouponForm => ({
  code: '',
  description: '',
  discountType: 'percentage',
  discountValue: '',
  minimumOrderValue: '',
  maximumDiscount: '',
  usageLimit: '',
  perCustomerLimit: '',
  startsAt: '',
  expiresAt: '',
  firstOrderOnly: false,
  isActive: true,
});

/** yyyy-mm-dd in the browser's local time, for <input type="date">. */
const toDateInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

@Component({
  selector: 'app-admin-coupons',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-coupons.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminCouponsComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  coupons: AdminCoupon[] = [];
  isLoading = true;
  errorMessage = '';

  showForm = false;
  editingId: string | null = null;
  form: CouponForm = emptyForm();
  isSaving = false;
  formError = '';
  message = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.getAdminCoupons().subscribe({
      next: res => { this.isLoading = false; this.coupons = res.coupons; },
      error: err => this.onError(err),
    });
  }

  discountLabel(c: AdminCoupon): string {
    return c.discountType === 'percentage' ? `${c.discountValue}% off` : `₹${c.discountValue} off`;
  }

  startNew(): void {
    this.editingId = null;
    this.form = emptyForm();
    this.formError = '';
    this.message = '';
    this.showForm = true;
  }

  startEdit(c: AdminCoupon): void {
    this.editingId = c.id;
    this.form = {
      code: c.code,
      description: c.description || '',
      discountType: c.discountType,
      discountValue: String(c.discountValue),
      minimumOrderValue: c.minimumOrderValue ? String(c.minimumOrderValue) : '',
      maximumDiscount: c.maximumDiscount !== null ? String(c.maximumDiscount) : '',
      usageLimit: c.usageLimit !== null ? String(c.usageLimit) : '',
      perCustomerLimit: c.perCustomerLimit !== null ? String(c.perCustomerLimit) : '',
      startsAt: toDateInput(c.startsAt),
      expiresAt: toDateInput(c.expiresAt),
      firstOrderOnly: !!c.firstOrderOnly,
      isActive: c.isActive,
    };
    this.formError = '';
    this.message = '';
    this.showForm = true;
  }

  cancelForm(): void {
    this.showForm = false;
    this.editingId = null;
    this.formError = '';
  }

  private payload(): CouponInput {
    const f = this.form;
    // A coupon is valid through the whole of its expiry day, so the expiry is end of that day.
    const startsAt = f.startsAt ? new Date(`${f.startsAt}T00:00:00`).toISOString() : null;
    const expiresAt = f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null;
    return {
      code: f.code.trim().toUpperCase(),
      description: f.description.trim() || null,
      discountType: f.discountType,
      discountValue: f.discountValue === '' ? null : Number(f.discountValue),
      minimumOrderValue: f.minimumOrderValue === '' ? 0 : Number(f.minimumOrderValue),
      maximumDiscount: f.maximumDiscount === '' ? null : Number(f.maximumDiscount),
      usageLimit: f.usageLimit === '' ? null : Number(f.usageLimit),
      perCustomerLimit: f.perCustomerLimit === '' ? null : Number(f.perCustomerLimit),
      startsAt,
      expiresAt,
      firstOrderOnly: f.firstOrderOnly,
      isActive: f.isActive,
    };
  }

  save(): void {
    if (this.isSaving) return;
    this.formError = '';
    this.message = '';
    this.isSaving = true;

    const body = this.payload();
    const request = this.editingId
      ? this.adminService.updateCoupon(this.editingId, body)
      : this.adminService.createCoupon(body);

    request.subscribe({
      next: () => {
        this.isSaving = false;
        this.message = this.editingId ? `Coupon ${body.code} updated.` : `Coupon ${body.code} created.`;
        this.cancelForm();
        this.load();
      },
      error: err => {
        this.isSaving = false;
        if (err?.status === 401 || err?.status === 403) {
          this.router.navigate(['/admin/login']);
          return;
        }
        this.formError = err?.error?.message || err?.error?.error?.message || 'Could not save the coupon.';
      },
    });
  }

  toggleActive(c: AdminCoupon): void {
    this.message = '';
    this.adminService.updateCoupon(c.id, { isActive: !c.isActive }).subscribe({
      next: () => {
        this.message = `Coupon ${c.code} ${c.isActive ? 'deactivated' : 'activated'}.`;
        this.load();
      },
      error: err => {
        this.errorMessage = err?.error?.message || 'Could not change the coupon.';
      },
    });
  }

  private onError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'Could not load coupons. Please retry.';
  }
}
