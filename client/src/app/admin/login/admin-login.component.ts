import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminService } from '../admin.service';

@Component({
  selector: 'app-admin-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './admin-login.component.html',
  styleUrls: ['./admin-login.component.css']
})
export class AdminLoginComponent implements OnInit {
  private adminService = inject(AdminService);
  private router = inject(Router);

  email = '';
  password = '';
  errorMessage = '';
  isSubmitting = false;

  ngOnInit(): void {
    if (this.adminService.isAuthenticated()) {
      this.router.navigate(['/admin/orders']);
    }
  }

  onSubmit(): void {
    this.errorMessage = '';

    if (!this.email || !this.email.includes('@')) {
      this.errorMessage = 'Please enter a valid owner email address.';
      return;
    }

    if (!this.password) {
      this.errorMessage = 'Please enter your password.';
      return;
    }

    this.isSubmitting = true;

    this.adminService.login(this.email, this.password).subscribe({
      next: (res) => {
        this.isSubmitting = false;
        if (res.success) {
          this.router.navigate(['/admin/orders']);
        }
      },
      error: (err) => {
        this.isSubmitting = false;
        if (err.status === 429) {
          this.errorMessage = err.error?.message || 'Too many failed login attempts. Please wait before trying again.';
        } else if (err.status === 401) {
          this.errorMessage = 'Invalid email or password.';
        } else {
          this.errorMessage = err.error?.message || 'Authentication failed. Please check your credentials and try again.';
        }
      }
    });
  }
}
