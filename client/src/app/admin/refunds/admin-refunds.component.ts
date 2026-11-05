import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AdminService, AdminRefundException } from '../admin.service';

@Component({
  selector: 'app-admin-refunds',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './admin-refunds.component.html',
  styleUrls: ['./admin-refunds.component.css']
})
export class AdminRefundsComponent implements OnInit {
  adminService = inject(AdminService);
  private router = inject(Router);

  exceptions: AdminRefundException[] = [];
  isLoading = true;
  errorMessage = '';

  currentPage = 1;
  pageSize = 20;
  totalExceptions = 0;
  totalPages = 1;

  ngOnInit(): void {
    this.loadRefundExceptions();
  }

  loadRefundExceptions(page: number = 1): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.currentPage = page;

    this.adminService.getPendingRefunds({
      page: this.currentPage,
      limit: this.pageSize
    }).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.exceptions = res.exceptions;
          this.totalExceptions = res.pagination.total;
          this.totalPages = res.pagination.totalPages;
        } else {
          this.errorMessage = 'Failed to load pending refund exceptions.';
        }
      },
      error: (err) => {
        this.isLoading = false;
        if (err.status === 401 || err.status === 403) {
          this.router.navigate(['/admin/login']);
        } else {
          this.errorMessage = err.error?.error?.message || 'Error loading refund exceptions. Please retry.';
        }
      }
    });
  }

  goToPage(page: number): void {
    if (page >= 1 && page <= this.totalPages && page !== this.currentPage) {
      this.loadRefundExceptions(page);
    }
  }

  getExceptionBadgeClass(type: string): string {
    switch (type) {
      case 'STOCK_SHORTAGE_HOLD': return 'badge-stock-shortage';
      case 'DUPLICATE_CAPTURE_REVIEW': return 'badge-duplicate';
      case 'RECORDED_REFUND_PENDING': return 'badge-pending';
      default: return 'badge-default';
    }
  }

  getRefundStatusBadgeClass(status: string): string {
    switch (status?.toLowerCase()) {
      case 'refunded': return 'badge-refunded';
      case 'pending': return 'badge-pending';
      case 'processing': return 'badge-processing';
      case 'failed': return 'badge-failed';
      default: return 'badge-default';
    }
  }

  onLogout(): void {
    this.adminService.logout().subscribe({
      next: () => this.router.navigate(['/admin/login']),
      error: () => this.router.navigate(['/admin/login'])
    });
  }
}
