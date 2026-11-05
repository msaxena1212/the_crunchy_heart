import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AdminCustomer, AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-customers',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-customers.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminCustomersComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  customers: AdminCustomer[] = [];
  search = '';
  isLoading = true;
  errorMessage = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.getAdminCustomers({ search: this.search.trim(), limit: 100 }).subscribe({
      next: res => { this.isLoading = false; this.customers = res.customers; },
      error: err => this.onError(err),
    });
  }

  private onError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'Could not load customers. Please retry.';
  }
}
