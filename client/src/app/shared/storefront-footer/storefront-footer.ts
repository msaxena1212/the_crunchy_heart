
import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { StoreInfoService } from '../store-info.service';

@Component({
  selector: 'tch-storefront-footer',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './storefront-footer.html',
  styleUrl: './storefront-footer.css',
})
export class StorefrontFooter {
  private readonly router = inject(Router);

  readonly fssai = inject(StoreInfoService).fssaiLicenseNumber;

  readonly currentYear = new Date().getFullYear();

  goHome(): void {
    void this.router.navigate(['/']);
  }
}
