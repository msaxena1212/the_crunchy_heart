import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartItem, CartService } from '../cart.service';

@Component({
    selector: 'app-cart',
    standalone: true,
    imports: [CommonModule, RouterLink],
    templateUrl: './cart.component.html',
    styleUrl: './cart.component.css'
})
export class CartComponent {

    readonly cartService = inject(CartService);

    readonly FREE_SHIPPING_THRESHOLD = 499;

    get items(): CartItem[] {
        return this.cartService.items;
    }

    get subtotal(): number {
        return this.cartService.subtotal;
    }

    get itemCount(): number {
        return this.cartService.count;
    }

    get freeShippingProgress(): number {
        return Math.min(100, Math.round((this.subtotal / this.FREE_SHIPPING_THRESHOLD) * 100));
    }

    get amountNeededForFreeShipping(): number {
        return Math.max(0, this.FREE_SHIPPING_THRESHOLD - this.subtotal);
    }

    get totalSavings(): number {
        return this.items.reduce((acc, item) => {
            const mrp = Number(item.mrp || 0);
            const unitPrice = Number(item.unitPrice || 0);
            return acc + (mrp > unitPrice ? (mrp - unitPrice) * item.quantity : 0);
        }, 0);
    }

    increase(item: CartItem): void {
        this.cartService.increaseQuantity(item.variantId);
    }

    decrease(item: CartItem): void {
        this.cartService.decreaseQuantity(item.variantId);
    }

    remove(item: CartItem): void {
        this.cartService.removeItem(item.variantId);
    }

    clearCart(): void {
        this.cartService.clearCart();
    }

    get hasRecoverySnapshot(): boolean {
        return this.cartService.hasCartSnapshot();
    }

    restorePreviousCart(): void {
        this.cartService.restoreCartSnapshot(this.items.length === 0 ? 'replace' : 'merge');
    }

  /** "500g" / "1kg" for a cart line. */
  weightLabel(item: CartItem): string {
    const grams = Number(item.weightGrams ?? 0);

    if (!grams) {
      return '';
    }

    return grams >= 1000 ? `${grams / 1000}kg` : `${grams}g`;
  }

  /** True when the variant name already states the weight, so it is not repeated. */
  variantHasWeight(item: CartItem): boolean {
    const label = this.weightLabel(item).toLowerCase();

    return !!label && (item.variantName || '').toLowerCase().includes(label);
  }
}