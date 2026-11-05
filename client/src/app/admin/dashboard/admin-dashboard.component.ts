import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AdminDashboardResponse, AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './admin-dashboard.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminDashboardComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  data: AdminDashboardResponse | null = null;
  isLoading = true;
  errorMessage = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.getDashboard().subscribe({
      next: res => { this.isLoading = false; this.data = res; },
      error: err => this.onError(err),
    });
  }

  private onError(err: { status?: number; error?: { message?: string } }): void {
    this.isLoading = false;
    if (err?.status === 401 || err?.status === 403) {
      this.router.navigate(['/admin/login']);
      return;
    }
    this.errorMessage = err?.error?.message || 'Could not load the dashboard. Please retry.';
  }
}
