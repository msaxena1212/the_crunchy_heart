import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, OnDestroy, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CartService } from '../../cart.service';
import { CustomerAuthService, CustomerUser } from '../customer-auth.service';
import { ScrollLockService } from '../scroll-lock.service';

@Component({
  selector: 'tch-storefront-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './storefront-header.html',
  styleUrl: './storefront-header.css',
})
export class StorefrontHeader implements OnDestroy {
  private readonly router = inject(Router);
  private readonly cartService = inject(CartService);
  private readonly customerAuthService = inject(CustomerAuthService);
  private readonly scrollLockService = inject(ScrollLockService);
  private readonly elementRef = inject(ElementRef);

  mobileMenuOpen = false;
  shopMenuOpen = false;

  get cartCount(): number {
    return this.cartService.count;
  }

  get isLoggedIn(): boolean {
    return this.customerAuthService.isLoggedIn;
  }

  get customer(): CustomerUser | null {
    return this.customerAuthService.currentCustomer;
  }

  openAccountOrLogin(): void {
    this.closeMenus();
    if (this.isLoggedIn) {
      void this.router.navigate(['/account']);
    } else {
      this.customerAuthService.openLoginModal('/account');
    }
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
    if (slug === 'all') {
      void this.router.navigate(['/shop']);
    } else {
      void this.router.navigate(['/category', slug]);
    }
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
    this.setMobileMenuOpen(!this.mobileMenuOpen);
  }

  private setMobileMenuOpen(open: boolean): void {
    if (this.mobileMenuOpen === open) return;
    this.mobileMenuOpen = open;
    this.shopMenuOpen = false;
    if (open) {
      this.scrollLockService.lock();
    } else {
      this.scrollLockService.unlock();
    }
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

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const clickedInside = this.elementRef.nativeElement.contains(target);
    if (!clickedInside) {
      this.closeMenus();
    } else {
      this.shopMenuOpen = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeMenus();
  }

  closeMenus(): void {
    if (this.mobileMenuOpen) {
      this.scrollLockService.unlock();
    }
    this.mobileMenuOpen = false;
    this.shopMenuOpen = false;
  }

  ngOnDestroy(): void {
    if (this.mobileMenuOpen) {
      this.scrollLockService.unlock();
    }
  }
}
