import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AdminCoupon, AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-coupons',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './admin-coupons.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminCouponsComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  coupons: AdminCoupon[] = [];
  isLoading = true;
  errorMessage = '';

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

  private onError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'Could not load coupons. Please retry.';
  }
}
