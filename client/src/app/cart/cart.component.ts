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

    get items(): CartItem[] {
        return this.cartService.items;
    }

    get subtotal(): number {
        return this.cartService.subtotal;
    }

    get itemCount(): number {
        return this.cartService.count;
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
}