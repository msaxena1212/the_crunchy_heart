import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminInventoryVariant, AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-inventory',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-inventory.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminInventoryComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  variants: AdminInventoryVariant[] = [];
  lowStockOnly = false;
  search = '';
  isLoading = true;
  errorMessage = '';

  ngOnInit(): void {
    this.load();
  }

  /** Variants matching the search box (SKU or product / pack name). */
  get filtered(): AdminInventoryVariant[] {
    const term = this.search.trim().toLowerCase();
    if (!term) return this.variants;
    return this.variants.filter(v =>
      `${v.sku} ${v.productName} ${v.variantName}`.toLowerCase().includes(term));
  }

  load(): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.getAdminInventory({ lowStock: this.lowStockOnly }).subscribe({
      next: res => { this.isLoading = false; this.variants = res.variants; },
      error: err => this.onError(err),
    });
  }

  private onError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'Could not load inventory. Please retry.';
  }
}
