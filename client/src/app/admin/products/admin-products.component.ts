import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminProduct, AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-products',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-products.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminProductsComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  products: AdminProduct[] = [];
  search = '';
  isLoading = true;
  errorMessage = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.getAdminProducts({ search: this.search.trim(), limit: 100 }).subscribe({
      next: res => { this.isLoading = false; this.products = res.products; },
      error: err => this.onError(err),
    });
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
