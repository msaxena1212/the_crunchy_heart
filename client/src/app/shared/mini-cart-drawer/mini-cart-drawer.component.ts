import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { CartService, CartItem } from '../../cart.service';
import { ScrollLockService } from '../scroll-lock.service';

@Component({
  selector: 'tch-mini-cart-drawer',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './mini-cart-drawer.component.html',
  styleUrl: './mini-cart-drawer.component.css'
})
export class MiniCartDrawerComponent implements OnInit, OnDestroy {
  readonly cartService = inject(CartService);
  private readonly scrollLockService = inject(ScrollLockService);
  private readonly sub = new Subscription();
  private isLocked = false;

  readonly FREE_SHIPPING_THRESHOLD = 499;

  ngOnInit(): void {
    this.sub.add(
      this.cartService.drawerOpen$.subscribe(open => {
        if (open && !this.isLocked) {
          this.scrollLockService.lock();
          this.isLocked = true;
        } else if (!open && this.isLocked) {
          this.scrollLockService.unlock();
          this.isLocked = false;
        }
      })
    );
  }

  ngOnDestroy(): void {
    if (this.isLocked) {
      this.scrollLockService.unlock();
      this.isLocked = false;
    }
    this.sub.unsubscribe();
  }

  get isOpen(): boolean {
    return this.cartService.isDrawerOpen;
  }

  get items(): CartItem[] {
    return this.cartService.items;
  }

  get subtotal(): number {
    return this.cartService.subtotal;
  }

  get count(): number {
    return this.cartService.count;
  }

  get freeShippingProgress(): number {
    return Math.min(100, Math.round((this.subtotal / this.FREE_SHIPPING_THRESHOLD) * 100));
  }

  get amountNeededForFreeShipping(): number {
    return Math.max(0, this.FREE_SHIPPING_THRESHOLD - this.subtotal);
  }

  get hasRecoverySnapshot(): boolean {
    return this.cartService.hasCartSnapshot();
  }

  restoreCart(): void {
    this.cartService.restoreCartSnapshot(this.items.length === 0 ? 'replace' : 'merge');
  }

  close(): void {
    this.cartService.closeDrawer();
  }

  increase(variantId: string): void {
    this.cartService.increaseQuantity(variantId);
  }

  decrease(variantId: string): void {
    this.cartService.decreaseQuantity(variantId);
  }

  remove(variantId: string): void {
    this.cartService.removeItem(variantId);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen) {
      this.close();
    }
  }
}
