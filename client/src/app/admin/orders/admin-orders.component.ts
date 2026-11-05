import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminService, AdminOrderSummary } from '../admin.service';

@Component({
  selector: 'app-admin-orders',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './admin-orders.component.html',
  styleUrls: ['./admin-orders.component.css']
})
export class AdminOrdersComponent implements OnInit {
  adminService = inject(AdminService);
  private router = inject(Router);

  orders: AdminOrderSummary[] = [];
  isLoading = false;
  errorMessage = '';
  actionMessage = '';

  // Filters
  searchQuery = '';
  selectedStatus = '';
  selectedPaymentMethod = '';
  currentPage = 1;
  totalPages = 1;
  totalOrders = 0;
  pageSize = 20;

  // Dispatch state
  dispatchingOrderNumber: string | null = null;

  ngOnInit(): void {
    this.loadOrders();
  }

  loadOrders(page: number = 1): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.actionMessage = '';
    this.currentPage = page;

    this.adminService.getOrders({
      page: this.currentPage,
      limit: this.pageSize,
      status: this.selectedStatus || undefined,
      paymentMethod: this.selectedPaymentMethod || undefined,
      search: this.searchQuery || undefined,
    }).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.orders = res.orders;
          this.totalOrders = res.pagination.total;
          this.totalPages = res.pagination.totalPages;
        }
      },
      error: (err) => {
        this.isLoading = false;
        if (err.status === 401) {
          this.adminService.clearSession();
          this.router.navigate(['/admin/login']);
          return;
        }
        this.errorMessage = err.error?.message || 'Failed to load orders. Please try again.';
      }
    });
  }

  onFilterChange(): void {
    this.loadOrders(1);
  }

  onSearchSubmit(): void {
    this.loadOrders(1);
  }

  clearFilters(): void {
    this.searchQuery = '';
    this.selectedStatus = '';
    this.selectedPaymentMethod = '';
    this.loadOrders(1);
  }

  confirmDispatch(order: AdminOrderSummary): void {
    if (this.dispatchingOrderNumber) return;

    const confirmed = window.confirm(
      `Are you sure you want to dispatch COD order ${order.orderNumber}?\n\nThis will atomically deduct inventory and mark the order as dispatched.`
    );

    if (!confirmed) return;

    this.dispatchingOrderNumber = order.orderNumber;
    this.errorMessage = '';
    this.actionMessage = '';

    this.adminService.dispatchCodOrder(order.orderNumber).subscribe({
      next: (res) => {
        this.dispatchingOrderNumber = null;
        if (res.success) {
          this.actionMessage = `Order ${order.orderNumber} dispatched successfully! Inventory deducted.`;
          // Update order status in place
          order.status = 'dispatched';
          order.canDispatch = false;
        }
      },
      error: (err) => {
        this.dispatchingOrderNumber = null;
        if (err.status === 409 && err.error?.code === 'INSUFFICIENT_STOCK') {
          this.errorMessage = `Dispatch failed: Insufficient inventory to fulfill order ${order.orderNumber}.`;
        } else if (err.status === 409 && err.error?.code === 'ALREADY_DISPATCHED') {
          this.errorMessage = `Order ${order.orderNumber} has already been dispatched.`;
          order.status = 'dispatched';
          order.canDispatch = false;
        } else {
          this.errorMessage = err.error?.message || `Failed to dispatch order ${order.orderNumber}.`;
        }
      }
    });
  }

  onLogout(): void {
    this.adminService.logout().subscribe({
      next: () => {
        this.router.navigate(['/admin/login']);
      },
      error: () => {
        this.adminService.clearSession();
        this.router.navigate(['/admin/login']);
      }
    });
  }

  getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'dispatched': return 'badge-dispatched';
      case 'confirmed': return 'badge-confirmed';
      case 'paid': return 'badge-paid';
      case 'pending': return 'badge-pending';
      case 'cancelled': return 'badge-cancelled';
      default: return 'badge-default';
    }
  }

  getPaymentBadgeClass(status: string): string {
    switch (status) {
      case 'paid':
      case 'captured': return 'badge-paid';
      case 'pending': return 'badge-pending';
      case 'failed': return 'badge-cancelled';
      default: return 'badge-default';
    }
  }
}
