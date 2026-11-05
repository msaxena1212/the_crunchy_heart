import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AdminService } from './admin.service';

export const adminAuthGuard: CanActivateFn = () => {
  const adminService = inject(AdminService);
  const router = inject(Router);

  if (adminService.isAuthenticated()) {
    return true;
  }

  // Not authenticated: redirect to owner login
  return router.createUrlTree(['/admin/login']);
};
