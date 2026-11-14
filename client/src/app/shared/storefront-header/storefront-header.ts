import { CommonModule } from '@angular/common';
import { Component, HostListener, inject } from '@angular/core';
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
  shopMenuOpen = false;

  get cartCount(): number {
    return this.cartService.count;
  }

  openCartDrawer(event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.closeMenus();
    this.cartService.openDrawer();
  }

  goHome(): void {
    this.closeMenus();
    void this.router.navigate(['/']);
  }

  goToCategory(slug: string): void {
    this.closeMenus();
    void this.router.navigate(['/category', slug]);
  }

  goToBulk(): void {
    this.closeMenus();
    void this.router.navigate(['/bulk']);
  }

  navigateToSection(section: string): void {
    this.closeMenus();

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
    this.shopMenuOpen = false;
  }

  toggleShopMenu(event: Event): void {
    // Hover already opens the menu on desktop, so a click must not toggle it shut again.
    event.stopPropagation();
    this.shopMenuOpen = true;
  }

  openShopMenu(): void {
    this.shopMenuOpen = true;
  }

  closeShopMenu(): void {
    this.shopMenuOpen = false;
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.shopMenuOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeMenus();
  }

  private closeMenus(): void {
    this.mobileMenuOpen = false;
    this.shopMenuOpen = false;
  }
}
