import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AdminService } from '../admin.service';

export interface AdminNavItem {
  label: string;
  path: string;
}

export interface AdminNavGroup {
  title: string;
  items: AdminNavItem[];
}

/** The owner console's navigation. Order and grouping are the single source for the sidebar. */
export const ADMIN_NAV: AdminNavGroup[] = [
  { title: 'Overview', items: [{ label: 'Dashboard', path: '/admin/dashboard' }] },
  {
    title: 'Sales',
    items: [
      { label: 'Orders', path: '/admin/orders' },
      { label: 'Payments', path: '/admin/payments' },
      { label: 'Refund reviews', path: '/admin/refunds' },
    ],
  },
  {
    title: 'Catalogue',
    items: [
      { label: 'Products', path: '/admin/products' },
      { label: 'Inventory', path: '/admin/inventory' },
      { label: 'Offers & coupons', path: '/admin/coupons' },
    ],
  },
  { title: 'Customers', items: [{ label: 'Customers', path: '/admin/customers' }] },
  {
    title: 'Marketing',
    items: [
      { label: 'Analytics', path: '/admin/analytics' },
      { label: 'Social media', path: '/admin/social' },
    ],
  },
];

@Component({
  selector: 'app-admin-shell',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './admin-shell.component.html',
  styleUrls: ['./admin-shell.component.css'],
})
export class AdminShellComponent {
  adminService = inject(AdminService);
  private router = inject(Router);

  readonly navGroups = ADMIN_NAV;

  onLogout(): void {
    this.adminService.logout().subscribe({
      next: () => this.router.navigate(['/admin/login']),
      error: () => this.router.navigate(['/admin/login']),
    });
  }
}
