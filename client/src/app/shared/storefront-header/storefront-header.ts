import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CartService } from '../../cart.service';

@Component({
  selector: 'tch-storefront-header',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './storefront-header.html',
  styleUrl: './storefront-header.css',
})
export class StorefrontHeader {
  private readonly router = inject(Router);
  private readonly cartService = inject(CartService);

  mobileMenuOpen = false;

  get cartCount(): number {
    return this.cartService.count;
  }

  goHome(): void {
    this.mobileMenuOpen = false;
    void this.router.navigate(['/']);
  }

  navigateToSection(section: string): void {
    this.mobileMenuOpen = false;

    if (this.router.url === '/') {
      document.getElementById(section)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      return;
    }

    void this.router.navigate(['/'], {
      fragment: section,
    });
  }

  toggleMobileMenu(): void {
    this.mobileMenuOpen = !this.mobileMenuOpen;
  }
}