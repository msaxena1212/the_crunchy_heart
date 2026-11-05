import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AdminIntegrationsResponse, AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-analytics',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './admin-analytics.component.html',
  styleUrls: ['../admin-shared.css'],
})
export class AdminAnalyticsComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  integrations: AdminIntegrationsResponse | null = null;
  isLoading = true;
  errorMessage = '';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.getIntegrations().subscribe({
      next: res => { this.isLoading = false; this.integrations = res; },
      error: err => {
        this.isLoading = false;
        if (err?.status === 401 || err?.status === 403) {
          this.router.navigate(['/admin/login']);
          return;
        }
        this.errorMessage = err?.error?.message || 'Could not check the analytics connection. Please retry.';
      },
    });
  }
}
