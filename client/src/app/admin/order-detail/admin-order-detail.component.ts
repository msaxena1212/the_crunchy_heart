import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AdminService, AdminOrderDetailResponse } from '../admin.service';

@Component({
  selector: 'app-admin-order-detail',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './admin-order-detail.component.html',
  styleUrls: ['./admin-order-detail.component.css']
})
export class AdminOrderDetailComponent implements OnInit {
  adminService = inject(AdminService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  orderNumber: string = '';
  detail: AdminOrderDetailResponse | null = null;
  isLoading = true;
  errorMessage = '';
  isDispatching = false;
  actionMessage = '';
  actionError = '';
  showDispatchConfirm = false;

  ngOnInit(): void {
    this.route.paramMap.subscribe(params => {
      const num = params.get('orderNumber');
      if (num) {
        this.orderNumber = num;
        this.loadOrderDetail(num);
      } else {
        this.errorMessage = 'No order number provided.';
        this.isLoading = false;
      }
    });
  }

  loadOrderDetail(orderNumber: string): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.actionMessage = '';
    this.actionError = '';

    this.adminService.getOrderDetails(orderNumber).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.detail = res;
        } else {
          this.errorMessage = 'Failed to load order details.';
        }
      },
      error: (err) => {
        this.isLoading = false;
        if (err.status === 401 || err.status === 403) {
          this.router.navigate(['/admin/login']);
        } else if (err.status === 404) {
          this.errorMessage = `Order ${orderNumber} was not found.`;
        } else {
          this.errorMessage = err.error?.error?.message || 'Error loading order details. Please retry.';
        }
      }
    });
  }

  promptDispatch(): void {
    this.actionError = '';
    this.actionMessage = '';
    this.showDispatchConfirm = true;
  }

  cancelDispatch(): void {
    this.showDispatchConfirm = false;
  }

  confirmDispatch(): void {
    if (this.isDispatching || !this.detail?.canDispatch) return;
    this.isDispatching = true;
    this.actionError = '';
    this.actionMessage = '';
    this.showDispatchConfirm = false;

    this.adminService.dispatchCodOrder(this.orderNumber).subscribe({
      next: (res) => {
        this.isDispatching = false;
        if (res.success) {
          this.actionMessage = `Order ${this.orderNumber} successfully dispatched. Inventory has been permanently deducted.`;
          // Reload detail to reflect updated status and lock state
          this.loadOrderDetail(this.orderNumber);
        } else {
          this.actionError = res.error?.message || 'Failed to dispatch order.';
        }
      },
      error: (err) => {
        this.isDispatching = false;
        if (err.status === 409) {
          this.actionError = 'Order has already been dispatched or is currently in an ineligible state.';
          this.loadOrderDetail(this.orderNumber);
        } else if (err.status === 400 && err.error?.error?.code === 'INSUFFICIENT_STOCK') {
          this.actionError = `Stock shortage: ${err.error.error.message || 'One or more items do not have sufficient inventory.'}`;
        } else {
          this.actionError = err.error?.error?.message || 'Failed to dispatch order. Stock deduction was safely rolled back.';
        }
      }
    });
  }

  getStatusBadgeClass(status: string): string {
    switch (status?.toLowerCase()) {
      case 'confirmed': return 'badge-confirmed';
      case 'dispatched': return 'badge-dispatched';
      case 'delivered': return 'badge-delivered';
      case 'cancelled': return 'badge-cancelled';
      case 'exception_stock_shortage': return 'badge-stock-shortage';
      case 'pending': return 'badge-pending';
      default: return 'badge-default';
    }
  }

  getPaymentBadgeClass(status: string): string {
    switch (status?.toLowerCase()) {
      case 'captured': return 'badge-captured';
      case 'paid_stock_unavailable': return 'badge-stock-shortage';
      case 'paid_duplicate_order_settled': return 'badge-duplicate';
      case 'pending': return 'badge-pending';
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
