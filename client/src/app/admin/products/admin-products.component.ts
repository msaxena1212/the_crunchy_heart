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

  /** CSV Import / Export state */
  exportingCsv = false;
  showImportModal = false;
  csvText = '';
  importingCsv = false;
  importMessage = '';
  importError = '';
  importErrorsList: Array<{ row: number; sku?: string; message: string }> = [];

  ngOnInit(): void {
    this.load();
  }

  exportCsv(): void {
    this.exportingCsv = true;
    this.errorMessage = '';
    this.adminService.exportCatalogueCsv().subscribe({
      next: csv => {
        this.exportingCsv = false;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `the-crunchy-heart-catalogue-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      },
      error: err => {
        this.exportingCsv = false;
        this.onError(err);
      }
    });
  }

  toggleImportModal(): void {
    this.showImportModal = !this.showImportModal;
    this.importMessage = '';
    this.importError = '';
    this.importErrorsList = [];
  }

  onCsvFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.csvText = String(reader.result || '');
    };
    reader.readAsText(file);
  }

  runCsvImport(dryRun: boolean): void {
    if (!this.csvText.trim()) {
      this.importError = 'Please select a CSV file or paste CSV content.';
      return;
    }
    this.importingCsv = true;
    this.importMessage = '';
    this.importError = '';
    this.importErrorsList = [];

    this.adminService.importCatalogueCsv(this.csvText, dryRun).subscribe({
      next: res => {
        this.importingCsv = false;
        this.importErrorsList = res.errors || [];
        if (dryRun) {
          this.importMessage = `Dry-run complete: ${res.validRowsCount ?? 0} valid row(s), ${this.importErrorsList.length} warning/error(s).`;
        } else {
          this.importMessage = `Import complete: ${res.updatedCount ?? 0} SKU(s) updated.`;
          this.load();
        }
      },
      error: err => {
        this.importingCsv = false;
        this.importError = err?.error?.message || 'CSV import failed.';
      }
    });
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
