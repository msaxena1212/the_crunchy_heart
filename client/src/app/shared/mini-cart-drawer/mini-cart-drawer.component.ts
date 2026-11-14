import { CommonModule } from '@angular/common';
import { Component, HostListener, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartService, CartItem } from '../../cart.service';

@Component({
  selector: 'tch-mini-cart-drawer',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './mini-cart-drawer.component.html',
  styleUrl: './mini-cart-drawer.component.css'
})
export class MiniCartDrawerComponent {
  readonly cartService = inject(CartService);

  readonly FREE_SHIPPING_THRESHOLD = 499;

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
