import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminProduct, AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-products',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './admin-products.component.html',
  styleUrls: ['../admin-shared.css', './admin-products.component.css'],
})
export class AdminProductsComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  products: AdminProduct[] = [];
  /** Categories seen in the unfiltered list, used to build the filter. */
  categories: Array<{ slug: string; name: string }> = [];
  search = '';
  category = '';
  isLoading = true;
  errorMessage = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService
      .getAdminProducts({ search: this.search.trim(), category: this.category, limit: 200 })
      .subscribe({
        next: res => {
          this.isLoading = false;
          this.products = res.products;

          if (!this.category && !this.search.trim()) {
            const seen = new Map<string, string>();
            for (const p of res.products) {
              if (p.categorySlug && p.category) {
                seen.set(p.categorySlug, p.category);
              }
            }
            this.categories = Array.from(seen, ([slug, name]) => ({ slug, name }));
          }
        },
        error: err => this.onError(err),
      });
  }

  pickCategory(slug: string): void {
    this.category = slug;
    this.load();
  }

  edit(p: AdminProduct): void {
    void this.router.navigate(['/admin/products', p.id]);
  }

  private onError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'Could not load products. Please retry.';
  }
}
