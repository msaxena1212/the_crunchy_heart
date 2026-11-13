import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AdminProductDetail,
  AdminProductDetailResponse,
  AdminService,
  AdminVariant
} from '../admin.service';

/** An editable copy of a pack size, plus what it looked like when loaded (to detect changes). */
interface VariantRow {
  id: string;
  sku: string;
  name: string;
  weightGrams: number | null;
  reserved: number;
  taxRate: number;
  sellingPrice: number;
  mrp: number;
  isActive: boolean;
  badge: string;
  onHand: number;
  reorderLevel: number;
  original: string;
  saving: boolean;
  message: string;
  error: string;
}

@Component({
  selector: 'app-admin-product-edit',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './admin-product-edit.component.html',
  styleUrls: ['../admin-shared.css', './admin-product-edit.component.css']
})
export class AdminProductEditComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  productId = '';
  product: AdminProductDetail | null = null;
  rows: VariantRow[] = [];

  /** Product form (a copy, saved explicitly). */
  form = { name: '', shortDescription: '', description: '', isActive: true, isFeatured: false, imageUrl: '' };

  isLoading = true;
  loadError = '';
  savingProduct = false;
  productMessage = '';
  productError = '';

  /** "Rate per kg" quick-pricing tool. */
  ratePerKg: number | null = null;
  savingRate = false;
  rateMessage = '';
  rateError = '';

  imageBroken = false;

  ngOnInit(): void {
    this.productId = this.route.snapshot.paramMap.get('productId') ?? '';
    this.load();
  }

  /* ---------- Loading ---------- */

  load(): void {
    this.isLoading = true;
    this.loadError = '';
    this.adminService.getAdminProduct(this.productId).subscribe({
      next: res => {
        this.isLoading = false;
        this.apply(res);
      },
      error: err => this.onLoadError(err)
    });
  }

  private apply(res: AdminProductDetailResponse): void {
    this.product = res.product;
    this.form = {
      name: res.product.name,
      shortDescription: res.product.shortDescription ?? '',
      description: res.product.description ?? '',
      isActive: res.product.isActive,
      isFeatured: res.product.isFeatured,
      imageUrl: res.product.imageUrl ?? ''
    };
    this.imageBroken = false;
    this.rows = res.variants.map(v => this.toRow(v));

    // Suggest the current per-kg rate from the largest weight-based pack.
    const weighted = res.variants.filter(v => v.pricePerKg !== null);
    this.ratePerKg = weighted.length ? weighted[weighted.length - 1].pricePerKg : null;
  }

  private toRow(v: AdminVariant): VariantRow {
    const row: VariantRow = {
      id: v.id,
      sku: v.sku,
      name: v.name,
      weightGrams: v.weightGrams,
      reserved: v.reserved,
      taxRate: v.taxRate,
      sellingPrice: v.sellingPrice,
      mrp: v.mrp,
      isActive: v.isActive,
      badge: v.badge ?? '',
      onHand: v.onHand,
      reorderLevel: v.reorderLevel,
      original: '',
      saving: false,
      message: '',
      error: ''
    };
    row.original = this.snapshot(row);
    return row;
  }

  private snapshot(r: VariantRow): string {
    return JSON.stringify([r.sellingPrice, r.mrp, r.isActive, r.badge, r.onHand, r.reorderLevel]);
  }

  private onLoadError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    if (err?.status === 401 || err?.status === 403) {
      void this.router.navigate(['/admin/login']);
      return;
    }
    this.loadError = err?.status === 404 ? 'This product could not be found.' : err?.error?.message || 'Could not load this product. Please retry.';
  }

  /* ---------- Product details ---------- */

  get productDirty(): boolean {
    if (!this.product) {
      return false;
    }
    return (
      this.form.name !== this.product.name ||
      this.form.shortDescription !== (this.product.shortDescription ?? '') ||
      this.form.description !== (this.product.description ?? '') ||
      this.form.isActive !== this.product.isActive ||
      this.form.isFeatured !== this.product.isFeatured ||
      this.form.imageUrl !== (this.product.imageUrl ?? '')
    );
  }

  saveProduct(): void {
    this.productMessage = '';
    this.productError = '';

    if (!this.form.name.trim()) {
      this.productError = 'Name is required.';
      return;
    }

    this.savingProduct = true;
    this.adminService
      .updateAdminProduct(this.productId, {
        name: this.form.name,
        shortDescription: this.form.shortDescription,
        description: this.form.description,
        isActive: this.form.isActive,
        isFeatured: this.form.isFeatured,
        imageUrl: this.form.imageUrl.trim() ? this.form.imageUrl.trim() : null
      })
      .subscribe({
        next: res => {
          this.savingProduct = false;
          this.apply(res);
          this.productMessage = 'Product saved. Changes are live on the storefront.';
        },
        error: err => {
          this.savingProduct = false;
          this.productError = this.messageOf(err, 'Could not save the product.');
        }
      });
  }

  onImageError(): void {
    this.imageBroken = true;
  }

  onImageInput(): void {
    this.imageBroken = false;
  }

  /* ---------- Per-kg pricing ---------- */

  get hasWeightPacks(): boolean {
    return this.rows.some(r => !!r.weightGrams);
  }

  /** What each weight-based pack would cost at the typed rate (same rounding as the server). */
  get ratePreview(): Array<{ name: string; price: number; current: number }> {
    if (this.ratePerKg === null || !(this.ratePerKg >= 0)) {
      return [];
    }
    const rate = this.ratePerKg;
    return this.rows
      .filter(r => !!r.weightGrams)
      .map(r => ({ name: r.name, price: Math.floor((rate * (r.weightGrams as number)) / 1000 + 0.5), current: r.sellingPrice }));
  }

  get rateChanges(): boolean {
    return this.ratePreview.some(p => p.price !== p.current);
  }

  applyRate(): void {
    this.rateMessage = '';
    this.rateError = '';

    if (this.ratePerKg === null || !(this.ratePerKg >= 0)) {
      this.rateError = 'Enter a rate per kg.';
      return;
    }

    this.savingRate = true;
    this.adminService.setProductRatePerKg(this.productId, Number(this.ratePerKg)).subscribe({
      next: res => {
        this.savingRate = false;
        const rate = this.ratePerKg;
        this.apply(res);
        this.ratePerKg = rate;
        this.rateMessage = 'All pack prices updated from the new rate.';
      },
      error: err => {
        this.savingRate = false;
        this.rateError = this.messageOf(err, 'Could not update the rate.');
      }
    });
  }

  /* ---------- Pack sizes ---------- */

  rowDirty(r: VariantRow): boolean {
    return this.snapshot(r) !== r.original;
  }

  rowPerKg(r: VariantRow): number | null {
    return r.weightGrams ? Math.round((Number(r.sellingPrice) * 1000) / r.weightGrams) : null;
  }

  rowAvailable(r: VariantRow): number {
    return Number(r.onHand) - r.reserved;
  }

  saveRow(r: VariantRow): void {
    r.message = '';
    r.error = '';

    if (r.sellingPrice === null || r.sellingPrice === undefined || String(r.sellingPrice) === '' || Number(r.sellingPrice) < 0) {
      r.error = 'Enter a valid price.';
      return;
    }
    if (Number(r.mrp) !== 0 && Number(r.mrp) < Number(r.sellingPrice)) {
      r.error = 'MRP must be 0 (no strike-through) or at least the price.';
      return;
    }
    if (!Number.isInteger(Number(r.onHand)) || Number(r.onHand) < 0) {
      r.error = 'Stock must be a whole number.';
      return;
    }

    r.saving = true;
    this.adminService
      .updateAdminVariant(r.id, {
        sellingPrice: Number(r.sellingPrice),
        mrp: Number(r.mrp) || 0,
        isActive: r.isActive,
        badge: r.badge,
        quantityOnHand: Number(r.onHand),
        reorderLevel: Number(r.reorderLevel) || 0
      })
      .subscribe({
        next: res => {
          const rate = this.ratePerKg;
          this.apply(res);
          this.ratePerKg = rate;
          const saved = this.rows.find(x => x.id === r.id);
          if (saved) {
            saved.message = 'Saved';
          }
        },
        error: err => {
          r.saving = false;
          r.error = this.messageOf(err, 'Could not save this pack size.');
        }
      });
  }

  resetRow(r: VariantRow): void {
    const [price, mrp, active, badge, onHand, reorder] = JSON.parse(r.original);
    r.sellingPrice = price;
    r.mrp = mrp;
    r.isActive = active;
    r.badge = badge;
    r.onHand = onHand;
    r.reorderLevel = reorder;
    r.error = '';
    r.message = '';
  }

  trackRow(_: number, r: VariantRow): string {
    return r.id;
  }

  private messageOf(err: { status?: number; error?: { message?: string } }, fallback: string): string {
    if (err?.status === 401 || err?.status === 403) {
      void this.router.navigate(['/admin/login']);
      return 'Your session has expired. Please sign in again.';
    }
    return err?.error?.message || fallback;
  }
}
